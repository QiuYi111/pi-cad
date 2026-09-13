import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { WorkerError } from "./errors.mjs";

export class PrimeRpc extends EventEmitter {
  #child;
  #buffer = "";
  #sequence = 0;
  #pending = new Map();
  #closed = false;
  state = { state: "starting", sessionId: undefined };

  constructor(command, args = [], env = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
  }

  start() {
    if (this.#child) return this;
    this.#child = spawn(this.command, this.args, {
      cwd: this.env.PI_CAD_PROJECT_CWD,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8").on("data", (chunk) => this.#consume(chunk));
    this.#child.stderr.setEncoding("utf8").on("data", (chunk) => {
      const line = chunk.trim();
      if (line) this.emit("diagnostic", line.slice(-1200));
    });
    this.#child.once("error", (error) => this.#failAll(new WorkerError(`Prime runtime failed to start: ${error.message}`, "prime_unavailable")));
    this.#child.once("exit", (code, signal) => {
      this.#closed = true;
      this.#failAll(new WorkerError(`Prime runtime exited (${signal || code || 0})`, "prime_exited"));
      this.emit("exit", { code, signal });
      this.state = { ...this.state, state: "stopped" };
    });
    return this;
  }

  get running() { return Boolean(this.#child && !this.#child.killed && this.#child.exitCode === null); }

  #consume(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.#buffer.slice(0, end).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(end + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch {
        this.emit("diagnostic", `non-JSON Prime output: ${line.slice(-240)}`);
        continue;
      }
      if (record.type === "response" && record.id && this.#pending.has(record.id)) {
        const pending = this.#pending.get(record.id);
        clearTimeout(pending.timer);
        this.#pending.delete(record.id);
        if (record.success) pending.accept(record.data);
        else pending.reject(new WorkerError(record.error || `${record.command || "Prime"} failed`, "prime_request_failed"));
      } else {
        this.emit("event", record);
      }
    }
  }

  request(type, payload = {}, timeout = 45_000) {
    if (!this.running) return Promise.reject(new WorkerError("Prime runtime is not running", "prime_unavailable"));
    const id = `worker-${++this.#sequence}`;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WorkerError(`Prime RPC ${type} timed out`, "prime_timeout"));
      }, timeout);
      timer.unref?.();
      this.#pending.set(id, { accept, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
    });
  }

  async steer(message, images) {
    const payload = { message, ...(images?.length ? { images } : {}) };
    try { await this.request("steer", payload, 5_000); }
    catch (error) {
      if (error?.code !== "prime_request_failed" || !String(error.message).includes("suspended")) throw error;
      await this.request("prompt", payload, 5_000);
    }
  }

  async abort() { await this.request("abort", {}, 5_000); }

  #failAll(error) {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }

  async stop() {
    if (!this.#child) return;
    this.#closed = true;
    this.#child.stdin.end();
    const child = this.#child;
    await new Promise((accept) => {
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_500);
      child.once("exit", () => { clearTimeout(timer); accept(); });
    });
  }
}
