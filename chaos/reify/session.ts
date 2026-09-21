import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { isProcessAlive, REPO_ROOT } from "../sut/proc.ts";

/**
 * The real Reify system under test.
 *
 * Every call in this file goes through production Reify code:
 *   - `scripts/pi-cad-agent-api.mjs` boots the real Agent API in its own
 *     process, so a run/phase/artifact decision is a real one;
 *   - `model-build` makes the Agent API spawn its own warm `cadctl.worker`
 *     (build123d) process, which is the CAD kernel this slice faults;
 *   - state comes from the real run store on disk (`.pi-cad` canonical root),
 *     never from a re-implementation.
 */

export const AGENT_API = join(REPO_ROOT, "scripts", "pi-cad-agent-api.mjs");
/** Run statuses Reify treats as final; a terminal run may never go back. */
export const TERMINAL_RUN_STATUSES = ["done", "aborted", "blocked_user", "blocked_external", "budget_exhausted"] as const;

const DEFAULT_CALL_TIMEOUT_MS = 180_000;

export interface ApiLogEntry {
  at: number;
  op: string;
  ok: boolean;
  ms: number;
  conversation?: string;
  error?: string;
}

export interface KernelProcess {
  pid: number;
  ppid: number;
  /** The live `.pi-cad` authority process this kernel belongs to, when it has one. */
  ownerPid: number | null;
  /** True when the kernel outlived the authority process that spawned it. */
  orphan: boolean;
}

export interface ReifySnapshot {
  at: number;
  conversations: { id: string; runId: string | null; runPresent: boolean; runStatus: string | null }[];
  runs: {
    id: string;
    phase: string;
    status: string;
    updatedAt: string;
    dir: string;
    artifacts: { id: string; path: string; sha256: string; sha256OnDisk: string | null }[];
  }[];
  project: { id: string; currentRunId: string | null; runIds: string[] };
  kernels: KernelProcess[];
  liveAuthorities: number[];
  activeFaults: string[];
}

interface LiveCall {
  child: ChildProcess;
  pid: number;
  conversation: string;
  op: string;
  startedAt: number;
  done: Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>;
}

const sleep = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

/** Read one `/proc/<pid>/stat` line without tripping over `comm` parentheses. */
function procStat(pid: number): { ppid: number; state: string } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", ppid: Number(fields[1]) };
  } catch {
    return null;
  }
}

/**
 * Every live CAD kernel process on the machine: the `uv run … cadctl.worker`
 * wrapper and the forked worker/build children underneath it.
 */
export function listKernelProcesses(): { pid: number; ppid: number }[] {
  const found: { pid: number; ppid: number }[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const argv = cmdline.split("\0").filter(Boolean);
    if (!argv.includes("cadctl.worker") || !argv.includes("-m")) continue;
    const stat = procStat(pid);
    if (!stat) continue;
    found.push({ pid, ppid: stat.ppid });
  }
  return found;
}

/**
 * Every pid in the process tree rooted at `pid`, children before the root.
 * The warm kernel is `uv run … cadctl.worker` with a forked python child, and
 * that child calls `setsid()`, so a single-pid kill can leave it stranded.
 */
export function processTree(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const childPid = Number(entry);
    const stat = procStat(childPid);
    if (!stat) continue;
    children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), childPid]);
  }
  const ordered: number[] = [];
  const walk = (root: number): void => {
    for (const child of children.get(root) ?? []) walk(child);
    ordered.push(root);
  };
  walk(pid);
  return ordered;
}

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export interface ReifySessionOptions {
  /** Keep the temp project after the run (used when debugging a failure). */
  keepProject?: boolean;
}

export class ReifySession {
  readonly root: string;
  readonly project: string;
  readonly workflowHome: string;
  readonly canonical: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requests: ApiLogEntry[] = [];
  readonly history = {
    /** Run statuses already seen, so a terminal run cannot silently go back. */
    runStatus: new Map<string, string>(),
    /** Runs each conversation ever started, newest last. */
    runsByConversation: new Map<string, string[]>(),
    /** Kernel pid -> authority pid that spawned it, observed while both live. */
    kernelOwners: new Map<number, number>(),
    /** Every pid we ever saw inside one of our live kernel trees. */
    ownedKernelPids: new Set<number>(),
    /** Orphaned kernel pid -> first time we saw the authority gone. */
    orphanSince: new Map<number, number>(),
    /** Real evidence that a faulted kernel was replaced by a working one. */
    recoveries: [] as { at: number; after: string; buildMs: number }[],
    /** Fault name -> injection time, cleared when its recovery is proven. */
    armedSince: new Map<string, number>(),
  };
  readonly conversations: string[] = ["conv-a"];
  /** Faults currently injected, plus whatever each one needs to recover. */
  readonly armedFaults = new Map<string, unknown>();
  activeFaults: string[] = [];

  private authorityPids = new Map<number, string>();
  private readonly keepProject: boolean;
  private readonly initialConversations: string[];

  private constructor(options: ReifySessionOptions) {
    this.keepProject = options.keepProject ?? false;
    this.initialConversations = [...this.conversations];
    this.root = mkdtempSync(join(tmpdir(), "reify-chaos-"));
    this.project = join(this.root, "project");
    this.workflowHome = join(this.root, "workflow-home");
    this.canonical = join(this.root, "canonical");
    this.env = {
      ...process.env,
      PI_CAD_PROJECT_CWD: this.project,
      PI_CAD_CANONICAL_PROJECT_DIR: this.canonical,
      PI_CAD_WORKFLOW_HOME: this.workflowHome,
    };
    this.writeFixture();
  }

  static async start(options: ReifySessionOptions = {}): Promise<ReifySession> {
    return new ReifySession(options);
  }

  /** A real Reify project: installed workflow package plus one Prime conversation. */
  private writeFixture(): void {
    mkdirSync(join(this.workflowHome, ".pi-cad", "workflows"), { recursive: true });
    mkdirSync(this.canonical, { recursive: true });
    mkdirSync(join(this.project, ".prime-sessions"), { recursive: true });
    // The installed default mechanical workflow is the one the product ships.
    cpSync(
      join(REPO_ROOT, "workflow-packages/mechanical/default.yaml"),
      join(this.workflowHome, ".pi-cad", "workflows", "mechanical-default.yaml"),
    );
    for (const conversation of this.conversations) this.writeTranscript(conversation);
    // A fast model for the normal path and a slow one that stays inside the
    // warm kernel long enough to be killed mid-build.
    writeFileSync(join(this.project, "part.py"), [
      "import build123d as bd",
      "plate = bd.Box(100, 80, 5)",
      "holes = [bd.Pos(dx, dy, 0) * bd.Cylinder(3, 30) for dx in (-40, 40) for dy in (-30, 30)]",
      "result = plate - holes[0].fuse(*holes[1:])",
      "",
    ].join("\n"));
    writeFileSync(join(this.project, "slow_part.py"), [
      "import time",
      "import build123d as bd",
      "time.sleep(10.0)",
      "result = bd.Box(42, 24, 12)",
      "",
    ].join("\n"));
  }

  private writeTranscript(conversation: string): void {
    writeFileSync(
      join(this.project, ".prime-sessions", `${conversation}.jsonl`),
      `${JSON.stringify({ type: "session_info", name: conversation })}\n`,
    );
  }

  conversation(index = 0): string {
    return this.conversations[((index % this.conversations.length) + this.conversations.length) % this.conversations.length]!;
  }

  /** Add a real second Prime conversation with no run of its own yet. */
  addConversation(): string {
    const id = `conv-${String.fromCharCode(97 + this.conversations.length)}`;
    this.conversations.push(id);
    this.writeTranscript(id);
    return id;
  }

  /** One real Agent API request in its own authority process. */
  async call(op: string, extra: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<any> {
    const live = this.spawnCall(op, extra);
    const timer = setTimeout(() => {
      live.child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    try {
      const settled = await live.done;
      if (settled.code !== 0 && !settled.stdout.trim()) {
        throw new Error(`${op}: authority exited with ${settled.signal ?? settled.code}${settled.stderr ? `: ${settled.stderr.slice(-300)}` : ""}`);
      }
      const response = JSON.parse(settled.stdout) as { ok: boolean; result?: unknown; error?: { message?: string } };
      if (!response.ok) throw new Error(response.error?.message ?? `${op} failed`);
      return response.result;
    } finally {
      clearTimeout(timer);
      this.authorityPids.delete(live.pid);
    }
  }

  /**
   * Start a real request without waiting. Long calls (`model-build`) are the
   * ones a fault kills mid-flight, so the caller needs the live process.
   */
  spawnCall(op: string, extra: Record<string, unknown>): LiveCall {
    const conversation = typeof extra.sessionId === "string" ? extra.sessionId : "(none)";
    const child = spawn(process.execPath, [AGENT_API, "agent-api", this.project], {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin?.end(JSON.stringify({ schema: 1, op, ...extra }));
    const startedAt = Date.now();
    const pid = child.pid ?? 0;
    this.authorityPids.set(pid, op);
    const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((accept) => {
      child.once("close", (code, signal) => {
        this.requests.push({
          at: startedAt,
          op,
          ok: code === 0,
          ms: Date.now() - startedAt,
          ...(conversation === "(none)" ? {} : { conversation }),
          ...(code === 0 ? {} : { error: signal ?? `exit ${code}` }),
        });
        accept({ code, signal, stdout, stderr });
      });
    });
    return { child, pid, conversation, op, startedAt, done };
  }

  liveAuthorityPids(): number[] {
    return [...this.authorityPids.keys()].filter((pid) => isProcessAlive(pid));
  }

  /**
   * Live CAD kernels with ownership resolved against the authority processes
   * this session started. A kernel whose recorded owner is gone is an orphan.
   */
  kernels(now = Date.now()): KernelProcess[] {
    const live = listKernelProcesses();
    const kernelPids = new Set(live.map((process) => process.pid));
    const byPid = new Map(live.map((process) => [process.pid, process]));
    return live
      .filter((process) => !kernelPids.has(byPid.get(process.pid)!.ppid))
      .map((root) => {
        const owner = root.ppid;
        const owned = this.authorityPids.has(owner) && isProcessAlive(owner);
        if (owned) {
          this.history.kernelOwners.set(root.pid, owner);
          for (const pid of processTree(root.pid)) this.history.ownedKernelPids.add(pid);
        }
        const recorded = this.history.kernelOwners.get(root.pid) ?? null;
        const authorityAlive = recorded !== null && this.liveAuthorityPids().includes(recorded);
        const orphan = !owned && recorded !== null && !authorityAlive;
        if (orphan) {
          if (!this.history.orphanSince.has(root.pid)) this.history.orphanSince.set(root.pid, now);
        } else {
          this.history.orphanSince.delete(root.pid);
        }
        return { pid: root.pid, ppid: owner, ownerPid: owned ? owner : recorded, orphan };
      });
  }

  /** Kill a kernel and everything it forked, the way a real crash does. */
  killKernel(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
    // Try the process group first, then walk the tree so a `setsid()` child
    // cannot outlive its wrapper.
    try {
      process.kill(-pid, signal);
    } catch {
      /* not a group leader */
    }
    for (const target of processTree(pid)) {
      try {
        process.kill(target, signal);
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Kernels that outlived their authority for longer than the shutdown grace.
   * A healthy authority kills its warm kernel on exit, so this stays empty.
   */
  orphanKernels(now = Date.now()): KernelProcess[] {
    const grace = Number(process.env.CHAOS_REIFY_ORPHAN_GRACE_MS ?? 2_000);
    return this.kernels(now).filter(
      (kernel) => kernel.orphan && now - (this.history.orphanSince.get(kernel.pid) ?? now) >= grace,
    );
  }

  /** Wait until a request started by this session owns a live CAD kernel. */
  async waitForOwnedKernel(authorityPid: number, timeoutMs = 30_000): Promise<KernelProcess | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const kernel = this.kernels().find((process) => process.ownerPid === authorityPid && !process.orphan);
      if (kernel) return kernel;
      if (Date.now() > deadline) return null;
      await sleep(50);
    }
  }

  private readProjectState(): {
    projectId: string;
    currentRunId: string | null;
    runs: string[];
    conversations: Record<string, { runId: string }>;
  } {
    let raw: {
      projectId?: string;
      currentRunId?: string | null;
      runs?: { runId: string }[];
      conversations?: Record<string, { runId: string }>;
    };
    try {
      raw = JSON.parse(readFileSync(join(this.canonical, "v7-project", "state.json"), "utf8"));
    } catch {
      // Nothing has started a run in this project yet: Reify itself has no state.
      return { projectId: "none", currentRunId: null, runs: [], conversations: {} };
    }
    return {
      projectId: raw.projectId ?? "unknown",
      currentRunId: raw.currentRunId ?? null,
      runs: (raw.runs ?? []).map((run) => run.runId),
      conversations: raw.conversations ?? {},
    };
  }

  private readRunState(runId: string): ReifySnapshot["runs"][number] | null {
    const dir = join(this.canonical, "runs", runId);
    let raw: {
      phase?: string;
      status?: string;
      updatedAt?: string;
      artifacts?: Record<string, { id: string; path: string; sha256: string }>;
    };
    try {
      raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    } catch {
      return null;
    }
    const artifacts = Object.values(raw.artifacts ?? {}).map((artifact) => {
      const absolute = resolve(this.project, artifact.path);
      // Always hash the file on disk. Caching the digest would hide a file
      // that is tampered with after its first (clean) read, which is exactly
      // what `artifact-integrity` exists to catch.
      const digest = sha256File(absolute);
      return { id: artifact.id, path: artifact.path, sha256: artifact.sha256, sha256OnDisk: digest };
    });
    return {
      id: runId,
      phase: raw.phase ?? "unknown",
      status: raw.status ?? "unknown",
      updatedAt: raw.updatedAt ?? "",
      dir,
      artifacts,
    };
  }

  /** The real state of the system, read from the run store on disk. */
  async snapshot(): Promise<ReifySnapshot> {
    const now = Date.now();
    const project = this.readProjectState();
    const runs = project.runs.map((runId) => this.readRunState(runId)).filter((run) => run !== null);
    const runById = new Map(runs.map((run) => [run.id, run]));
    const conversations = this.conversations.map((id) => {
      const runId = project.conversations[id]?.runId ?? null;
      return {
        id,
        runId,
        runPresent: runId !== null && runById.has(runId),
        runStatus: runId !== null ? runById.get(runId)?.status ?? null : null,
      };
    });
    return {
      at: now,
      conversations,
      runs,
      project: { id: project.projectId, currentRunId: project.currentRunId, runIds: project.runs },
      kernels: this.kernels(now),
      liveAuthorities: this.liveAuthorityPids(),
      activeFaults: this.activeFaults,
    };
  }

  armFault(name: string): void {
    if (!this.activeFaults.includes(name)) this.activeFaults.push(name);
    this.history.armedSince.set(name, Date.now());
  }

  disarmFault(name: string): void {
    this.activeFaults = this.activeFaults.filter((fault) => fault !== name);
    this.armedFaults.delete(name);
    this.history.armedSince.delete(name);
  }

  /** Record a real successful build after a fault; this is the recovery proof. */
  recordRecovery(after: string, buildMs: number): void {
    this.history.recoveries.push({ at: Date.now(), after, buildMs });
  }

  /** Drop stale authority/kernel bookkeeping and rebuild the project. */
  async reset(): Promise<void> {
    // Our own kernel trees first: a child that reparented to init is no longer
    // discoverable from its old wrapper pid.
    for (const pid of this.history.ownedKernelPids) this.killKernel(pid);
    for (const kernel of listKernelProcesses()) {
      if (this.history.kernelOwners.has(kernel.pid) || this.authorityPids.has(kernel.ppid)) this.killKernel(kernel.pid);
    }
    for (const pid of this.authorityPids.keys()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await sleep(150);
    this.authorityPids.clear();
    this.activeFaults = [];
    this.requests.length = 0;
    this.history.runStatus.clear();
    this.history.runsByConversation.clear();
    this.history.kernelOwners.clear();
    this.history.ownedKernelPids.clear();
    this.history.orphanSince.clear();
    this.history.recoveries.length = 0;
    this.history.armedSince.clear();
    rmSync(this.project, { recursive: true, force: true });
    rmSync(this.canonical, { recursive: true, force: true });
    this.conversations.length = 0;
    this.conversations.push(...this.initialConversations);
    this.writeFixture();
  }

  async close(): Promise<void> {
    await this.reset().catch(() => undefined);
    if (!this.keepProject) rmSync(this.root, { recursive: true, force: true });
  }
}
