import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppSettings, ModelChoice, RuntimeStatus, ThinkingLevel } from "../../src/shared/contracts.js";
import { runtimeChecksReady, type RuntimeBridge } from "./runtime-bridge.js";
import { MODEL_WAIT_PHASES, PrimeRuntimeState, type RuntimeTraceEntry } from "./runtime-state.js";

interface PendingRequest {
  accept: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** A watchdog timer together with the deadline it is anchored to. */
interface TimerSlot {
  timer?: NodeJS.Timeout;
  deadline?: number;
}

export interface PrimeRpcOptions {
  /** No provider-side event for this long marks the turn `stalled`. 0 disables it. */
  providerTimeoutMs?: number;
  /** How long the abort handshake waits for `message_end(aborted)` / `agent_end`. */
  abortTimeoutMs?: number;
  /** RPC response timeout for the abort command itself. */
  abortRpcTimeoutMs?: number;
  /** Provider errors are held this long in case Prime auto-retries. */
  failureGraceMs?: number;
  now?: () => number;
}

export class PrimeRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  private readonly runtime: PrimeRuntimeState;
  private readonly providerTimeoutMs: number;
  private readonly abortTimeoutMs: number;
  private readonly abortRpcTimeoutMs: number;
  private readonly now: () => number;
  private readonly retryClock: TimerSlot = {};
  private readonly stallClock: TimerSlot = {};
  private readonly failureClock: TimerSlot = {};
  private turnWaiters = new Set<() => void>();
  private journal?: (entries: RuntimeTraceEntry[]) => Promise<void>;

  constructor(private readonly bridge: RuntimeBridge, options: PrimeRpcOptions = {}) {
    super();
    this.runtime = new PrimeRuntimeState(
      { state: "idle", checks: [] },
      { now: options.now, failureGraceMs: options.failureGraceMs },
    );
    this.providerTimeoutMs = options.providerTimeoutMs ?? 600_000;
    this.abortTimeoutMs = options.abortTimeoutMs ?? 8_000;
    this.abortRpcTimeoutMs = options.abortRpcTimeoutMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  /** Authoritative runtime status, including turn phase and terminal reason. */
  get status(): RuntimeStatus { return this.runtime.status; }

  async start(settings: AppSettings, resumePath?: string): Promise<RuntimeStatus> {
    if (this.child && !this.child.killed) return this.status;
    await ensureRuntimeReady(this.bridge, settings, (status) => this.merge(status));
    const paths = await this.bridge.resolveRuntimePaths(settings);
    if (!paths.projectPath) throw new Error("Choose a project folder before starting Prime.");
    this.journal = projectRuntimeJournal(this.bridge, paths.projectPath);
    try {
      await this.bridge.exec(["test", "-d", paths.projectPath]);
    } catch {
      const error = new Error("Project folder no longer exists. Choose another project.");
      this.merge({ state: "error", checks: [], message: error.message });
      throw error;
    }
    const home = await this.bridge.homeDirectory();
    const node = await this.bridge.commandPath("node");
    const reviewer = settings.reviewer.mode === "fixed"
      ? ["--reviewer-provider", settings.reviewer.provider!, "--reviewer-model", settings.reviewer.model!, "--reviewer-thinking", settings.reviewer.thinking || "medium"]
      : ["--reviewer-inherit-author"];
    const args = [
      "env",
      `PI_CAD_REPO=${paths.piCadRepo}`,
      `PI_CAD_PROJECT_CWD=${paths.projectPath}`,
      `PRIME_AGENT_REPO=${paths.primeAgentRepo}`,
      `PRIME_AGENT_CODING_AGENT_DIR=${home}/.prime/agent`,
      `PI_CAD_NODE_WRAPPER=${node}`,
      `PI_CAD_DESKTOP_PERMISSION=${settings.permission}`,
      node, `${paths.piCadRepo}/scripts/prime-cad-sidecar.mjs`,
      "--mode", "rpc",
      "--provider", settings.provider,
      "--model", settings.model,
      "--thinking", settings.thinking,
      ...reviewer,
      ...(resumePath ? ["--resume", sandboxSessionPath(resumePath)] : []),
    ];
    this.merge({ state: "starting", checks: [], message: "Starting Prime and the Reify engineering runtime…" });
    this.child = this.bridge.spawn(args);
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("diagnostic", chunk.toString("utf8")));
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      const error = new Error(`Prime exited (${signal || code || 0})`);
      this.failAll(error);
      this.child = undefined;
      this.mutate(() => this.runtime.processExited(code, signal));
    });
    const state = await this.request("get_state", {}, 45_000);
    this.mutate(() => this.runtime.sessionReady(state?.sessionId));
    return this.status;
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let record: any;
      try { record = JSON.parse(line); }
      catch { this.emit("diagnostic", `Non-JSON Prime output: ${line}\n`); continue; }
      if (record.type === "response" && record.id && this.pending.has(record.id)) {
        const pending = this.pending.get(record.id)!;
        clearTimeout(pending.timer);
        this.pending.delete(record.id);
        if (record.success) pending.accept(record.data);
        else pending.reject(new Error(record.error || `${record.command} failed`));
        continue;
      }
      if (record.type === "extension_ui_request") this.emit("ui-request", record);
      else this.emit("event", record);
      this.mutate(() => this.runtime.applyEvent(record));
    }
  }

  request(type: string, payload: Record<string, unknown> = {}, timeout = 30_000): Promise<any> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Prime is not running"));
    const id = `desktop-${++this.sequence}`;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Prime RPC ${type} timed out`));
      }, timeout);
      this.pending.set(id, { accept, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
    });
  }

  async prompt(message: string, images?: Array<{ data: string; mimeType: string }>) {
    const payload = { message, ...(images?.length ? { images: images.map((image) => ({ type: "image", ...image })) } : {}) };
    this.mutate(() => this.runtime.beginTurn("prompt"));
    try {
      await this.request("prompt", payload);
    } catch (error) {
      if (error instanceof Error && error.message.includes("queued session input is suspended")) {
        await this.request("steer", payload);
        return;
      }
      this.noteRpcFailure(error);
      throw error;
    }
  }

  async steer(message: string, images?: Array<{ data: string; mimeType: string }>) {
    this.mutate(() => this.runtime.beginTurn("steer"));
    try {
      await this.request("steer", { message, ...(images?.length ? { images: images.map((image) => ({ type: "image", ...image })) } : {}) });
    } catch (error) {
      this.noteRpcFailure(error);
      throw error;
    }
  }

  async newSession(): Promise<unknown[]> {
    await this.request("new_session");
    const state = await this.request("get_state");
    this.mutate(() => this.runtime.sessionReady(state?.sessionId));
    return (await this.request("get_messages"))?.messages || [];
  }
  async getMessages(): Promise<unknown[]> {
    return (await this.request("get_messages"))?.messages || [];
  }

  async switchSession(path: string, settings?: AppSettings): Promise<unknown[]> {
    if (!this.child || this.child.killed) {
      if (!settings) throw new Error("Settings are required to restore a session before Prime starts.");
      await this.start(settings, path);
      return this.getMessages();
    }
    const result = await this.request("switch_session", { sessionPath: sandboxSessionPath(path) });
    if (result?.cancelled) throw new Error("Session switch was cancelled.");
    const [state, messages] = await Promise.all([this.request("get_state"), this.request("get_messages")]);
    this.mutate(() => this.runtime.sessionReady(state?.sessionId));
    return messages?.messages || [];
  }

  async setSessionName(name: string): Promise<void> {
    const title = name.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!title) return;
    await this.request("set_session_name", { name: title });
  }

  async getModels(): Promise<ModelChoice[]> {
    const data = await this.request("get_available_models");
    return (data?.models || []).map((model: any) => ({
      provider: model.provider,
      id: model.id,
      name: model.name || model.id,
      reasoning: Boolean(model.reasoning),
    }));
  }

  async setModel(provider: string, model: string) { await this.request("set_model", { provider, modelId: model }); }
  async setThinking(level: ThinkingLevel) { await this.request("set_thinking_level", { level }); }

  /**
   * Stop the current turn and wait for Prime to confirm it.
   *
   * Sending `abort` only means the command was accepted. The turn is terminal
   * once Prime reports `message_end(aborted)` / `auto_retry_end` / `agent_end`;
   * if that does not happen inside the deadline the sidecar is killed so the
   * runtime can never stay stuck in `streaming`.
   */
  async abort(): Promise<void> {
    if (!this.child || !this.runtime.activeTurn()) return;
    this.mutate(() => this.runtime.beginStopping());
    const settled = this.waitForTurnEnd(this.abortTimeoutMs);
    try {
      await this.request("abort", {}, this.abortRpcTimeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.mutate(() => this.runtime.rpcFailure("rpc_timeout", `Prime abort failed: ${message}`));
    }
    if (await settled) return;
    await this.forceStop();
  }

  async respondToUi(requestId: string, response: Record<string, unknown>) {
    if (!this.child?.stdin.writable) throw new Error("Prime is not running");
    this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: requestId, ...response })}\n`);
  }

  async stop() {
    if (!this.child) return;
    this.child.stdin.end();
    await new Promise<void>((accept) => {
      const timer = setTimeout(() => { this.child?.kill(); accept(); }, 2_500);
      this.child!.once("exit", () => { clearTimeout(timer); accept(); });
    });
  }

  /** Abort the sidecar after the stop handshake missed its deadline. */
  private async forceStop() {
    const child = this.child;
    this.mutate(() => this.runtime.processExited(null, null, true));
    if (!child) return;
    await new Promise<void>((accept) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); accept(); }, 1_500);
      child.once("exit", () => { clearTimeout(timer); accept(); });
      child.stdin.end();
      child.kill();
    });
    this.child = undefined;
  }

  private waitForTurnEnd(timeoutMs: number): Promise<boolean> {
    if (!this.runtime.activeTurn()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = () => { clearTimeout(timer); this.turnWaiters.delete(waiter); resolve(true); };
      const timer = setTimeout(() => { this.turnWaiters.delete(waiter); resolve(false); }, timeoutMs);
      timer.unref?.();
      this.turnWaiters.add(waiter);
    });
  }

  private noteRpcFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.mutate(() => this.runtime.rpcFailure(/timed out/.test(message) ? "rpc_timeout" : "rpc_rejected", message));
  }

  /** Merge lifecycle fields from runtime setup/install/start into the status. */
  private merge(patch: Partial<RuntimeStatus>) {
    this.mutate(() => this.runtime.base(patch));
  }

  /** Run a state mutation, reschedule watchdogs, and publish real changes once. */
  private mutate(action: () => void) {
    const before = this.runtime.status;
    try {
      action();
    } finally {
      this.syncTimers();
      this.flushTrace();
      if (this.runtime.status !== before) this.emit("status", this.runtime.status);
      if (!this.runtime.activeTurn()) {
        for (const waiter of [...this.turnWaiters]) waiter();
      }
    }
  }

  /** Append the journal lines the state machine produced since the last flush. */
  private flushTrace() {
    const entries = this.runtime.drain();
    if (!this.journal || !entries.length) return;
    void this.journal(entries).catch(() => undefined);
  }

  /**
   * Keep one timer per deadline instead of re-arming on every mutation.
   *
   * `mutate()` runs after every Prime event, so restarting a timer from the
   * full `delayMs` / `failureGraceMs` let `agent_status` / `session_action_update`
   * chatter hold a retry — or a pending failure — open forever. Every deadline
   * now comes from the state machine (or from the provider clock) and only a
   * new deadline replaces the timer.
   */
  private syncTimers() {
    const status = this.runtime.status;
    const turn = this.runtime.activeTurn();

    this.syncTimer(this.retryClock, this.runtime.retryDeadline, () => {
      const attempt = Number(this.runtime.status.retry?.attempt);
      this.mutate(() => this.runtime.retryDelayElapsed(attempt));
    }, 25);

    // Anchor the stall watchdog on provider events only: `lastEventAt` also
    // moves for `agent_status` and other chatter, which would hide a silent
    // provider.
    const silentFor = () => this.now() - (this.runtime.lastProviderEventAt ?? this.now());
    const stallDeadline = turn && this.providerTimeoutMs > 0 && MODEL_WAIT_PHASES.includes(status.phase ?? "ready")
      ? (this.runtime.lastProviderEventAt ?? this.now()) + this.providerTimeoutMs
      : undefined;
    this.syncTimer(this.stallClock, stallDeadline, () => {
      const idle = silentFor();
      this.mutate(() => this.runtime.providerStall(idle));
    });

    this.syncTimer(this.failureClock, this.runtime.failureDeadline, () => {
      this.mutate(() => this.runtime.settleFailure());
    });
  }

  /** Arm `slot` for `deadline`; an unchanged deadline keeps the running timer. */
  private syncTimer(slot: TimerSlot, deadline: number | undefined, fire: () => void, slackMs = 0) {
    if (slot.deadline === deadline) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.deadline = deadline;
    if (deadline === undefined) return;
    const timer = setTimeout(() => {
      slot.timer = undefined;
      slot.deadline = undefined;
      fire();
    }, Math.max(0, deadline - this.now()) + slackMs);
    timer.unref?.();
    slot.timer = timer;
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

export function sandboxSessionPath(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1) || "";
  if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) throw new Error("Invalid session path.");
  return `/workspace/.prime-sessions/${name}`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The runtime journal is the replayable record of Prime turn states: it lives
 * beside the project so a stalled, retried or aborted run can be reconstructed
 * later instead of only being visible in the moment.
 */
export function projectRuntimeJournal(
  bridge: Pick<RuntimeBridge, "pipe">,
  projectPath: string,
  relative = ".pi-cad/desktop-runtime.jsonl",
): ((entries: RuntimeTraceEntry[]) => Promise<void>) | undefined {
  if (!projectPath) return undefined;
  const target = `${projectPath.replace(/\/+$/, "")}/${relative}`;
  const directory = target.slice(0, target.lastIndexOf("/"));
  const command = `mkdir -p ${shellQuote(directory)} && cat >> ${shellQuote(target)}`;
  return async (entries) => {
    if (!entries.length) return;
    const lines = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await bridge.pipe(["sh", "-c", command], lines, 10_000);
  };
}

export async function ensureRuntimeReady(
  bridge: Pick<RuntimeBridge, "check" | "install">,
  settings: AppSettings,
  onStatus?: (status: RuntimeStatus) => void,
): Promise<RuntimeStatus> {
  const current = await bridge.check(settings);
  if (runtimeChecksReady(current.checks)) return current;
  const installed = await bridge.install(settings, onStatus);
  const missing = installed.checks.filter((check) => check.id !== "paraview" && check.status !== "ready");
  if (missing.length) throw new Error(`Runtime setup incomplete: ${missing.map((check) => check.label).join(", ")}`);
  return installed;
}
