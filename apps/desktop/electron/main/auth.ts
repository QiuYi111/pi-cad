import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { shell } from "electron";
import type { AppSettings, AuthStatus } from "../../src/shared/contracts.js";
import type { RuntimeBridge } from "./runtime-bridge.js";

export class AuthController extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  constructor(
    private readonly bridge: RuntimeBridge,
    private readonly onAuthenticated: () => Promise<void> = async () => {},
  ) { super(); }

  async status(settings: AppSettings): Promise<AuthStatus> {
    const { piCadRepo } = await this.bridge.resolveRuntimePaths(settings);
    const home = await this.bridge.homeDirectory();
    const node = await this.bridge.commandPath("node");
    const authPath = `${home}/.prime/agent/auth.json`;
    const script = "const fs=require('fs'),p=process.argv[1];try{const x=JSON.parse(fs.readFileSync(p,'utf8'))['openai-codex'];process.stdout.write(JSON.stringify(x?{ok:true,expires:x.expires||0}:{ok:false}))}catch{process.stdout.write(JSON.stringify({ok:false}))}";
    const { stdout } = await this.bridge.exec([node, "-e", script, authPath]);
    const value = JSON.parse(stdout || "{}");
    const expires = Number(value.expires || 0);
    const active = Boolean(value.ok) && (!expires || expires > Date.now() + 60_000);
    return active
      ? { provider: "openai-codex", state: "signed-in", message: "ChatGPT connected", expiresAt: value.expires }
      : { provider: "openai-codex", state: "signed-out", message: value.ok ? "ChatGPT login expired. Sign in again." : `Sign in to use OpenAI Codex with ${piCadRepo}.` };
  }

  async login(settings: AppSettings): Promise<AuthStatus> {
    if (this.child && !this.child.killed) return { provider: "openai-codex", state: "waiting", message: "Waiting for browser sign-in…" };
    const { piCadRepo, primeAgentRepo } = await this.bridge.resolveRuntimePaths(settings);
    const home = await this.bridge.homeDirectory();
    const node = await this.bridge.commandPath("node");
    const agentDir = `${home}/.prime/agent`;
    this.child = this.bridge.spawn([node, "--use-env-proxy", `${piCadRepo}/scripts/desktop-openai-oauth.mjs`, primeAgentRepo, agentDir]);
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk: Buffer) => this.update({ provider: "openai-codex", state: "waiting", message: chunk.toString("utf8").trim() }));
    this.child.once("error", (error) => this.update({ provider: "openai-codex", state: "error", message: error.message }));
    this.child.once("exit", (code) => {
      if (code && code !== 0) this.update({ provider: "openai-codex", state: "error", message: `Sign-in process exited with code ${code}.` });
      this.child = undefined;
    });
    const next = { provider: "openai-codex", state: "waiting", message: "Opening ChatGPT sign-in…" } satisfies AuthStatus;
    this.update(next);
    return next;
  }

  submitManualCode(value: string) {
    if (!this.child?.stdin.writable) throw new Error("No sign-in is waiting for a code.");
    this.child.stdin.write(`${JSON.stringify({ value })}\n`);
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "auth_url") {
        void shell.openExternal(event.url);
        this.update({ provider: "openai-codex", state: "waiting", message: event.instructions || "Complete sign-in in your browser." });
      } else if (event.type === "auth_complete") {
        void this.finishLogin();
      } else if (event.type === "auth_error") {
        this.update({ provider: "openai-codex", state: "error", message: event.message });
      } else if (event.type === "auth_input" || event.type === "auth_select") {
        this.update({
          provider: "openai-codex", state: "waiting", message: event.message || "Paste the redirect URL from your browser.",
          input: event.type === "auth_select"
            ? { kind: "select", options: (event.options || []).map((option: any) => ({ id: String(option.id), label: String(option.label || option.name || option.id) })) }
            : { kind: "text", placeholder: event.placeholder },
        });
      } else if (event.type === "auth_progress") {
        this.update({ provider: "openai-codex", state: "waiting", message: event.message });
      }
    }
  }

  private async finishLogin() {
    try {
      await this.onAuthenticated();
      this.update({ provider: "openai-codex", state: "signed-in", message: "ChatGPT connected" });
    } catch (error) {
      this.update({ provider: "openai-codex", state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private update(status: AuthStatus) { this.emit("status", status); }
}
