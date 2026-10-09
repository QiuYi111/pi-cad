import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isProcessAlive, REPO_ROOT } from "../sut/proc.ts";
import { resolvePrimeAgentRepo } from "./inspect.ts";

export interface PrimeProcess {
  pid: number;
  role: "prime-runtime" | "prime-agent" | "authority-sidecar";
  provider: string | null;
  model: string | null;
  sessionPath: string | null;
}

function procCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function optionValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

/** Every live real Prime / authority process on the machine, read from `/proc`. */
export function inspectPrimeProcesses(): PrimeProcess[] {
  const found: PrimeProcess[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const argv = procCmdline(pid);
    if (!argv.length) continue;
    const joined = argv.join(" ");
    if (joined.includes("prime-cad-sidecar.mjs")) {
      found.push({
        pid,
        role: "prime-runtime",
        provider: optionValue(argv, "--provider"),
        model: optionValue(argv, "--model"),
        sessionPath: optionValue(argv, "--resume"),
      });
    } else if (joined.includes("prime-agent.sh")) {
      found.push({
        pid,
        role: "prime-agent",
        provider: optionValue(argv, "--provider"),
        model: optionValue(argv, "--model"),
        sessionPath: optionValue(argv, "--resume"),
      });
    }
  }
  return found;
}

export interface PrimeRuntimeInfo {
  pid: number;
  provider: string;
  model: string;
  thinking: string;
  sessionId: string | null;
  thinkingLevel: string | null;
  startedAt: number;
  restarts: number;
}

export interface PrimeRuntimeOptions {
  project: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  model: string;
  thinking: string;
}

/**
 * The real Prime runtime process, driven the way the Desktop drives it:
 * `prime-cad-sidecar.mjs --mode rpc` with a real JSON-RPC handshake. Starting
 * it is a real lifecycle event; `get_state` is a real runtime read that never
 * calls a provider.
 */
export class ReifyPrimeRuntime {
  readonly restarts: number[] = [];
  private child?: ChildProcess;
  private info?: PrimeRuntimeInfo;
  private buffer = "";
  private pending = new Map<string, (value: Record<string, unknown>) => void>();
  private sequence = 0;
  private log = "";

  private constructor(private readonly options: PrimeRuntimeOptions) {}

  static available(): boolean {
    return resolvePrimeAgentRepo() !== null;
  }

  static async start(options: PrimeRuntimeOptions): Promise<ReifyPrimeRuntime> {
    const runtime = new ReifyPrimeRuntime(options);
    await runtime.start();
    return runtime;
  }

  get current(): PrimeRuntimeInfo | undefined {
    return this.info;
  }

  get pid(): number {
    return this.info?.pid ?? 0;
  }

  get alive(): boolean {
    return this.pid > 0 && isProcessAlive(this.pid);
  }

  get logTail(): string {
    return this.log.slice(-4096);
  }

  async start(): Promise<PrimeRuntimeInfo> {
    const primeAgentRepo = resolvePrimeAgentRepo();
    if (!primeAgentRepo) throw new Error("Prime runtime unavailable: no prime-agent checkout resolvable");
    const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR ?? `${process.env.HOME}/.prime/agent`;
    const child = spawn(
      process.execPath,
      [
        join(REPO_ROOT, "scripts", "prime-cad-sidecar.mjs"),
        "--mode", "rpc",
        "--provider", this.options.provider,
        "--model", this.options.model,
        "--thinking", this.options.thinking,
        "--reviewer-inherit-author",
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...this.options.env,
          PI_CAD_REPO: REPO_ROOT,
          PRIME_AGENT_REPO: primeAgentRepo,
          PRIME_AGENT_CODING_AGENT_DIR: agentDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.log = `${this.log}${chunk.toString("utf8")}`;
    });
    child.once("exit", () => {
      this.child = undefined;
    });
    const state = await this.request("get_state", 60_000);
    this.info = {
      pid: child.pid ?? 0,
      provider: this.options.provider,
      model: this.options.model,
      thinking: this.options.thinking,
      sessionId: typeof state.sessionId === "string" ? state.sessionId : null,
      thinkingLevel: typeof state.thinkingLevel === "string" ? state.thinkingLevel : null,
      startedAt: Date.now(),
      restarts: this.restarts.length,
    };
    return this.info;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim().startsWith("{")) continue;
      let record: { type?: string; id?: string; success?: boolean; data?: Record<string, unknown> };
      try {
        record = JSON.parse(line) as typeof record;
      } catch {
        continue;
      }
      if (record.type === "response" && record.id && this.pending.has(record.id)) {
        const accept = this.pending.get(record.id)!;
        this.pending.delete(record.id);
        accept(record.data ?? {});
      }
    }
  }

  /** One real RPC request; used for the `get_state` handshake. */
  async request(type: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (!this.child?.stdin?.writable) throw new Error("Prime runtime is not running");
    const id = `chaos-${++this.sequence}`;
    return new Promise<Record<string, unknown>>((accept, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Prime RPC ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, (data) => {
        clearTimeout(timer);
        accept(data);
      });
      this.child!.stdin!.write(`${JSON.stringify({ id, type })}\n`);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.info = undefined;
    this.pending.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((accept) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        accept();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        accept();
      });
      child.stdin?.end();
      child.kill();
    });
  }

  async restart(): Promise<PrimeRuntimeInfo> {
    await this.stop();
    const info = await this.start();
    this.restarts.push(info.startedAt);
    this.info = { ...info, restarts: this.restarts.length };
    return this.info;
  }

  async close(): Promise<void> {
    await this.stop();
  }
}
