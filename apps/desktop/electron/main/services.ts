import { app, safeStorage, type BrowserWindow } from "electron";
import { is } from "@electron-toolkit/utils";
import { join } from "node:path";
import type { AppSettings, CloudEvent, ReleaseResult, RuntimeStatus } from "../../src/shared/contracts.js";
import { DEFAULT_CLOUD_BASE_URL, IPC } from "../../src/shared/contracts.js";
import { SettingsStore } from "./settings-store.js";
import { CloudSession } from "./cloud-session.js";
import { EncryptedCloudSessionStore, type SecretCipher } from "./cloud-token-store.js";
import { createRuntimeBridge, isCloudMode, runtimeBridgeKey as bridgeKeyFor } from "./cloud-mode.js";
import { RemoteBridge } from "./remote-bridge.js";
import { WslBridge } from "./wsl.js";
import { NativeBridge } from "./native.js";
import type { RuntimeBridge } from "./runtime-bridge.js";
import { PrimeRpc } from "./prime-rpc.js";
import { ViewerBackend } from "./viewer.js";
import { DemoRuntime } from "./demo-runtime.js";
import { AuthController } from "./auth.js";
import { PrimeConfigService } from "./prime-config.js";
import { ParaViewBackend } from "./paraview.js";
import { BlenderBackend } from "./blender.js";
import { HumanApprovalStore } from "./approvals.js";
import type { CadTransferService } from "./cad-transfer.js";
import { NO_CONVERSATION, projectedConversationScope, type ConversationSelection } from "./conversation-selection.js";
import * as e2e from "./desktop-e2e.js";

const electronSecretCipher: SecretCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
};

/**
 * Shared main-process state. index.ts creates one instance after the userData
 * path is settled and hands it to each IPC module. Backends are built on first
 * use and rebuilt when the runtime bridge they depend on changes.
 */
export class MainServices {
  mainWindow: BrowserWindow | null = null;
  readonly settingsStore = new SettingsStore();
  readonly approvalStore: HumanApprovalStore;
  /** Formal releases this window created or verified, so publishing can read the workspace copy. */
  readonly trustedReleases = new Map<string, ReleaseResult>();
  runtime: PrimeRpc | DemoRuntime | null = null;
  /**
   * The Prime conversation the Desktop projects workflow and artifact state for.
   * It follows Prime's live session, except while a new conversation is selected
   * and Prime has not opened it yet — that selection is unbound on purpose.
   */
  conversation: ConversationSelection = NO_CONVERSATION;
  authController: AuthController | null = null;
  primeConfig: PrimeConfigService | null = null;
  primeConfigBridge: RuntimeBridge | null = null;
  runtimeBridge: RuntimeBridge | null = null;
  runtimeBridgeKey = "";
  paraView: ParaViewBackend | null = null;
  paraViewBridge: RuntimeBridge | null = null;
  viewer: ViewerBackend | null = null;
  viewerBridge: RuntimeBridge | null = null;
  blender: BlenderBackend | null = null;
  blenderBridge: RuntimeBridge | null = null;
  transfer: CadTransferService | null = null;
  transferBridge: RuntimeBridge | null = null;
  managedRuntimeBootstrap: Promise<void> = Promise.resolve();
  /** The hosted-service session for one server address. Rebuilt when the address changes. */
  cloud: { baseUrl: string; ready: Promise<CloudSession> } | null = null;
  /** Cloud project in use. The remote bridge reads it on every call, so it follows settings. */
  cloudProjectId: string | undefined;

  constructor(userDataPath: string) {
    this.approvalStore = new HumanApprovalStore(join(userDataPath, "human-approvals"));
  }

  send(channel: string, value: unknown) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.send(channel, value);
  }

  cacheRoot(): string {
    return join(app.getPath("userData"), "cache");
  }

  /**
   * Conversation whose workflow and artifact state the renderer shows. The
   * Desktop window always has a scope: `null` while its conversation has no
   * Prime session yet, which the authority answers as unbound.
   */
  projectedConversation(): string | null {
    return projectedConversationScope(this.conversation, this.runtime?.status.sessionId);
  }

  /** Stops the runtime and its transfer dispatcher, and drops the conversation selection. */
  async stopRuntime(): Promise<void> {
    void this.transfer?.stop();
    await this.runtime?.stop();
    this.runtime = null;
    this.conversation = NO_CONVERSATION;
    this.publishConversation();
  }

  /** Announce the selected conversation so every projection is read again. */
  publishConversation() {
    this.send(IPC.runtimeConversation, { sessionId: this.projectedConversation() });
  }

  /** Follow Prime's live session once it is not the conversation being replaced. */
  followLiveSession(status: RuntimeStatus) {
    if (this.conversation.pendingNew && status.sessionId && status.sessionId !== this.conversation.replacedSessionId) {
      this.conversation = NO_CONVERSATION;
      this.publishConversation();
    }
  }

  /**
   * The runtime bridge for the current settings. The factory in cloud-mode.ts
   * picks cloud or local; this only rebuilds it when the key changes.
   */
  async bridge(): Promise<RuntimeBridge> {
    const settings = await this.settingsStore.get();
    this.cloudProjectId = settings.cloud?.projectId;
    const bundledRuntime = is.dev ? join(app.getAppPath(), "resources/runtime") : join(process.resourcesPath, "runtime");
    const key = bridgeKeyFor(settings, process.platform);
    if (!this.runtimeBridge || this.runtimeBridgeKey !== key) {
      if (this.runtimeBridge instanceof RemoteBridge) this.runtimeBridge.close();
      const created = createRuntimeBridge(settings, process.platform, {
        local: () => process.platform === "win32"
          ? new WslBridge(settings.distro, bundledRuntime)
          : new NativeBridge(bundledRuntime, process.execPath),
        remote: () => new RemoteBridge({
          projectId: () => this.cloudProjectId,
          connect: async () => (await this.ensureCloud(await this.settingsStore.get())).connectBridge(),
          onState: (state) => this.send(IPC.cloudEvent, { type: "bridge_state", state }),
        }),
      });
      this.runtimeBridge = created.bridge;
      this.runtimeBridgeKey = created.key;
    }
    return this.runtimeBridge;
  }

  /** The session for the configured server. Restoring a saved sign-in finishes before it is returned. */
  ensureCloud(settings: AppSettings): Promise<CloudSession> {
    const baseUrl = settings.cloud?.baseUrl || DEFAULT_CLOUD_BASE_URL;
    if (this.cloud?.baseUrl === baseUrl) return this.cloud.ready;
    this.cloud?.ready.then((session) => session.close(), () => undefined);
    const ready = (async () => {
      const session = new CloudSession({
        baseUrl,
        store: new EncryptedCloudSessionStore(join(app.getPath("userData"), "cloud-session.bin"), electronSecretCipher),
        deviceLabel: `Reify desktop (${process.platform})`,
      });
      session.on((event: CloudEvent) => this.send(IPC.cloudEvent, event));
      await session.restore();
      return session;
    })();
    this.cloud = { baseUrl, ready };
    return ready;
  }

  /** Starts the managed Prime and Reify runtime files when a Windows runtime is ready but stale. */
  async syncManagedRuntime() {
    if (e2e.desktopE2E) return;
    const settings = await this.settingsStore.get();
    if (isCloudMode(settings)) return;
    const currentBridge = await this.bridge();
    const status = await currentBridge.check(settings);
    const wslReady = status.checks.find((item) => item.id === "wsl")?.status === "ready";
    const managedRuntimeStale = status.checks.some((item) => (item.id === "prime" || item.id === "picad") && item.status !== "ready");
    if (wslReady && managedRuntimeStale && currentBridge.bundledRuntimePath) {
      await new Promise<void>((resolve, reject) => {
        let filesReady = false;
        void currentBridge.install(settings, (value) => {
          this.send(IPC.runtimeStatus, value);
          if (!filesReady && (value.progress ?? 0) >= 0.78) {
            filesReady = true;
            resolve();
          }
        }).then(() => resolve(), (error) => {
          if (filesReady) this.send(IPC.runtimeEvent, { type: "runtime_diagnostic", message: `Managed dependency update failed: ${String(error)}` });
          else reject(error);
        });
      });
    }
  }

  async ensureRuntime(): Promise<PrimeRpc | DemoRuntime> {
    if (this.runtime) return this.runtime;
    this.runtime = e2e.desktopE2E
      ? new DemoRuntime({
        rejectThinkingAttempts: Number.isFinite(e2e.desktopE2ERejectThinking) ? e2e.desktopE2ERejectThinking : 0,
        slowThinkingMs: Number.isFinite(e2e.desktopE2ESlowThinking) ? e2e.desktopE2ESlowThinking : 0,
        revertThinkingLevel: e2e.desktopE2ERevertThinking,
      })
      : new PrimeRpc(await this.bridge());
    const runtime = this.runtime;
    runtime.on("event", (event) => this.send(IPC.runtimeEvent, event));
    runtime.on("status", (status: RuntimeStatus) => { this.followLiveSession(status); this.send(IPC.runtimeStatus, status); });
    runtime.on("ui-request", (request) => this.send(IPC.runtimeUiRequest, request));
    runtime.on("diagnostic", (message) => this.send(IPC.runtimeEvent, { type: "runtime_diagnostic", message }));
    return runtime;
  }

  async ensureAuth(): Promise<AuthController> {
    if (this.authController) return this.authController;
    this.authController = new AuthController(await this.bridge(), async () => {
      const current = this.runtime;
      this.runtime = null;
      await current?.stop();
    });
    this.authController.on("status", (status) => this.send(IPC.authStatus, status));
    return this.authController;
  }

  async ensurePrimeConfig(): Promise<PrimeConfigService> {
    const current = await this.bridge();
    if (!this.primeConfig || this.primeConfigBridge !== current) {
      this.primeConfig = new PrimeConfigService(current);
      this.primeConfigBridge = current;
    }
    return this.primeConfig;
  }

  async ensureParaView(): Promise<ParaViewBackend> {
    const current = await this.bridge();
    if (!this.paraView || this.paraViewBridge !== current) {
      await this.paraView?.stop();
      this.paraView = new ParaViewBackend(current);
      this.paraViewBridge = current;
    }
    return this.paraView;
  }

  async ensureViewer(): Promise<ViewerBackend> {
    const current = await this.bridge();
    if (!this.viewer || this.viewerBridge !== current) {
      this.viewer?.stop();
      this.viewer = new ViewerBackend(current, () => this.projectedConversation());
      this.viewerBridge = current;
    }
    return this.viewer;
  }

  async ensureBlender(): Promise<BlenderBackend> {
    const current = await this.bridge();
    if (!this.blender || this.blenderBridge !== current) {
      this.blender?.stop();
      this.blender = new BlenderBackend(current);
      this.blenderBridge = current;
    }
    return this.blender;
  }
}
