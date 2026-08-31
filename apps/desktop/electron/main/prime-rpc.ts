import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppSettings, ModelChoice, RuntimeStatus, ThinkingLevel } from "../../src/shared/contracts.js";
import { WslBridge } from "./wsl.js";

interface PendingRequest {
  accept: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PrimeRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  status: RuntimeStatus = { state: "idle", checks: [] };

  constructor(private readonly bridge: WslBridge) { super(); }

  async start(settings: AppSettings): Promise<RuntimeStatus> {
    if (this.child && !this.child.killed) return this.status;
    const paths = await this.bridge.resolveRuntimePaths(settings);
    const home = await this.bridge.homeDirectory();
    const node = await this.bridge.commandPath("node");
    if (!paths.projectPath) throw new Error("Choose a project folder before starting Prime.");
    const reviewer = settings.reviewer.mode === "fixed"
      ? ["--reviewer-provider", settings.reviewer.provider!, "--reviewer-model", settings.reviewer.model!, "--reviewer-thinking", settings.reviewer.thinking || "medium"]
      : ["--reviewer-inherit-author"];
    const args = [
      "env",
      `PI_CAD_REPO=${paths.piCadRepo}`,
      `PI_CAD_PROJECT_CWD=${paths.projectPath}`,
      `PRIME_AGENT_REPO=${paths.primeAgentRepo}`,
      `PRIME_AGENT_CODING_AGENT_DIR=${home}/.prime/agent`,
      `PI_CAD_DESKTOP_PERMISSION=${settings.permission}`,
      node, `${paths.piCadRepo}/scripts/prime-cad-sidecar.mjs`,
      "--mode", "rpc",
      "--provider", settings.provider,
      "--model", settings.model,
      "--thinking", settings.thinking,
      ...reviewer,
    ];
    this.setStatus({ state: "starting", checks: [], message: "Starting Prime and the Pi-CAD authority runtime…" });
    this.child = this.bridge.spawn(args);
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => this.emit("diagnostic", chunk.toString("utf8")));
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      const error = new Error(`Prime exited (${signal || code || 0})`);
      this.failAll(error);
      this.child = undefined;
      this.setStatus({ state: code === 0 ? "idle" : "error", checks: [], message: code === 0 ? undefined : error.message });
    });
    const state = await this.request("get_state", {}, 45_000);
    this.setStatus({ state: "ready", checks: [], sessionId: state?.sessionId });
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
      if (record.type === "agent_start") this.setStatus({ ...this.status, state: "streaming" });
      if (record.type === "agent_end") this.setStatus({ ...this.status, state: "ready" });
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
    await this.request("prompt", { message, ...(images?.length ? { images: images.map((image) => ({ type: "image", ...image })) } : {}) });
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
  async abort() { await this.request("abort"); }

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

  private setStatus(status: RuntimeStatus) { this.status = status; this.emit("status", status); }
  private failAll(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
