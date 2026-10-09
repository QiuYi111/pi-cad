import http from "node:http";
import type { ChildProcess } from "node:child_process";
import { spawnEntry, type SpawnedEntry } from "./proc.ts";

export type RunState =
  | "PENDING"
  | "STARTING"
  | "RUNNING"
  | "STOPPING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED";

export const TERMINAL_STATES: RunState[] = ["COMPLETED", "FAILED", "CANCELED"];
export const TRANSITION_STATES: RunState[] = ["STARTING", "STOPPING"];
export const isTerminal = (state: RunState) => TERMINAL_STATES.includes(state);

export type WorkerStatus = "starting" | "running" | "stopping" | "exited";
export const ACTIVE_WORKER_STATUSES: WorkerStatus[] = ["starting", "running", "stopping"];

export type BugName =
  | "double-worker"
  | "stuck-recovery"
  | "terminal-revert"
  | "duplicate-effect"
  | "stale-ui";

export const BUG_NAMES: BugName[] = [
  "double-worker",
  "stuck-recovery",
  "terminal-revert",
  "duplicate-effect",
  "stale-ui",
];

export interface RunView {
  id: string;
  projectId: string;
  state: RunState;
  stateSince: number;
  workerId: string | null;
  createdAt: number;
  updatedAt: number;
  activeWorkers: string[];
  effectTokens: string[];
  crashedWorkers: number;
  generations: number;
  ui: { status: string; workerActive: boolean; activeWorkerCount: number };
}

export interface WorkerView {
  id: string;
  runId: string;
  sessionId: string;
  pid: number;
  status: WorkerStatus;
  startedAt: number;
  exitedAt: number | null;
  exitReason: string | null;
}

export interface Snapshot {
  bugs: BugName | null;
  projects: { id: string; name: string; createdAt: number }[];
  runs: RunView[];
  workers: WorkerView[];
}

interface WorkerRecord extends WorkerView {
  graceful: boolean;
  child: ChildProcess | null;
}

interface RunRecord {
  id: string;
  projectId: string;
  state: RunState;
  stateSince: number;
  workerId: string | null;
  createdAt: number;
  updatedAt: number;
  effectTokens: string[];
  crashedWorkers: number;
  generations: number;
  stopRequested: boolean;
  stopTimer: NodeJS.Timeout | null;
}

interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
}

const RECOVERY_DELAY_MS = Number(process.env.CHAOS_RECOVERY_DELAY_MS ?? 120);
const STOP_GRACE_MS = Number(process.env.CHAOS_STOP_GRACE_MS ?? 300);
const WORKER_STEPS = Number(process.env.CHAOS_WORKER_STEPS ?? 8);
const WORKER_STEP_MS = Number(process.env.CHAOS_WORKER_STEP_MS ?? 250);

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(payload.length) });
  res.end(payload);
}

/**
 * A deliberately small, real control plane for a Reify-shaped run/worker
 * system. Workers are separate OS processes; the control plane owns their
 * lifecycle, crash detection, recovery, and the run state machine. Known bugs
 * can be injected with CHAOS_BUG so the chaos runner can prove it detects them.
 */
export class ControlPlane {
  readonly projects = new Map<string, ProjectRecord>();
  readonly runs = new Map<string, RunRecord>();
  readonly workers = new Map<string, WorkerRecord>();
  readonly bug: BugName | null;

  private sequence = 0;
  private readonly uiCache = new Map<string, string>();
  private readonly recoveryTimers = new Set<NodeJS.Timeout>();
  private readonly spawnWorkerEntry: typeof spawnEntry;

  constructor(
    private readonly options: {
      controlUrl: () => string;
      externalUrl: string;
      bug?: BugName | null;
      spawn?: typeof spawnEntry;
    },
  ) {
    this.bug = options.bug ?? null;
    this.spawnWorkerEntry = options.spawn ?? spawnEntry;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  private sampleUi(run: RunRecord): string {
    if (this.bug !== "stale-ui") this.uiCache.set(run.id, run.state);
    return this.uiCache.get(run.id) ?? run.state;
  }

  private transition(run: RunRecord, state: RunState) {
    if (run.state === state) return;
    run.state = state;
    run.stateSince = Date.now();
    run.updatedAt = run.stateSince;
    this.sampleUi(run);
  }

  activeWorkersFor(runId: string): WorkerRecord[] {
    return [...this.workers.values()].filter(
      (worker) => worker.runId === runId && ACTIVE_WORKER_STATUSES.includes(worker.status),
    );
  }

  createProject(name: string): ProjectRecord {
    const project: ProjectRecord = { id: this.nextId("p"), name, createdAt: Date.now() };
    this.projects.set(project.id, project);
    return project;
  }

  createRun(projectId: string): RunRecord {
    if (!this.projects.has(projectId)) throw new HttpError(404, `unknown project ${projectId}`);
    const now = Date.now();
    const run: RunRecord = {
      id: this.nextId("r"),
      projectId,
      state: "PENDING",
      stateSince: now,
      workerId: null,
      createdAt: now,
      updatedAt: now,
      effectTokens: [],
      crashedWorkers: 0,
      generations: 0,
      stopRequested: false,
      stopTimer: null,
    };
    this.runs.set(run.id, run);
    this.uiCache.set(run.id, run.state);
    return run;
  }

  startWorker(run: RunRecord): WorkerRecord {
    if (this.runs.get(run.id) !== run) throw new HttpError(409, `run ${run.id} is no longer registered`);
    if (isTerminal(run.state)) throw new HttpError(409, `run ${run.id} is ${run.state}`);
    if (run.workerId) {
      const existing = this.workers.get(run.workerId);
      if (existing && ACTIVE_WORKER_STATUSES.includes(existing.status)) return existing;
    }
    run.generations += 1;
    run.stopRequested = false;
    const worker: WorkerRecord = {
      id: this.nextId("w"),
      runId: run.id,
      sessionId: this.nextId("s"),
      pid: 0,
      status: "starting",
      startedAt: Date.now(),
      exitedAt: null,
      exitReason: null,
      graceful: false,
      child: null,
    };
    this.workers.set(worker.id, worker);
    run.workerId = worker.id;
    this.transition(run, "STARTING");

    const entry: SpawnedEntry = this.spawnWorkerEntry(
      "__worker",
      [
        "--worker",
        worker.id,
        "--run",
        run.id,
        "--session",
        worker.sessionId,
        "--control",
        this.options.controlUrl(),
        "--external",
        this.options.externalUrl,
        "--steps",
        String(WORKER_STEPS),
        "--step-ms",
        String(WORKER_STEP_MS),
      ],
      {},
    );
    worker.child = entry.child;
    worker.pid = entry.child.pid ?? 0;
    entry.child.once("exit", (code, signal) => this.onWorkerProcessExit(worker.id, code, signal));
    return worker;
  }

  private scheduleRecovery(run: RunRecord) {
    const runId = run.id;
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(timer);
      // The run must still be the live record for this id; a reset or a
      // completed transition must not be resurrected by a stale timer.
      const current = this.runs.get(runId);
      if (!current || current !== run) return;
      if (isTerminal(current.state)) return;
      if (this.activeWorkersFor(runId).length > 0) return;
      try {
        this.startWorker(current);
      } catch {
        /* run became terminal in the meantime */
      }
    }, RECOVERY_DELAY_MS);
    timer.unref?.();
    this.recoveryTimers.add(timer);
  }

  private onWorkerProcessExit(workerId: string, code: number | null, signal: NodeJS.Signals | null) {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const run = this.runs.get(worker.runId);
    const graceful = worker.graceful || worker.status === "stopping";
    const abnormal = !graceful;

    if (worker.status !== "exited") {
      if (this.bug === "double-worker" && abnormal) {
        // BUG: the crashed worker is never retired; a replacement is started
        // on top of a record that still claims to be running.
      } else {
        worker.status = "exited";
        worker.exitedAt = Date.now();
        worker.exitReason = worker.exitReason ?? `${signal ?? code ?? "unknown"}`;
      }
    }

    if (!run) return;
    if (run.workerId === worker.id) run.workerId = null;
    if (isTerminal(run.state)) return;

    if (graceful || run.stopRequested) {
      if (run.stopTimer) {
        clearTimeout(run.stopTimer);
        run.stopTimer = null;
      }
      run.stopRequested = false;
      this.transition(run, "CANCELED");
      return;
    }

    run.crashedWorkers += 1;
    if (this.bug === "stuck-recovery") return;
    this.scheduleRecovery(run);
  }

  stopRun(run: RunRecord, mode: "graceful" | "force") {
    if (isTerminal(run.state)) throw new HttpError(409, `run ${run.id} is ${run.state}`);
    if (run.state === "PENDING" && !run.workerId) {
      this.transition(run, "CANCELED");
      return;
    }
    this.transition(run, "STOPPING");
    run.stopRequested = true;
    const worker = run.workerId ? this.workers.get(run.workerId) : undefined;
    if (!worker) {
      this.transition(run, "CANCELED");
      run.stopRequested = false;
      return;
    }
    worker.status = "stopping";
    this.killWorker(worker, mode === "force" ? "SIGKILL" : "SIGTERM");
    if (mode === "graceful") {
      run.stopTimer = setTimeout(() => {
        const current = this.workers.get(worker.id);
        if (current && current.status !== "exited") this.killWorker(current, "SIGKILL");
      }, STOP_GRACE_MS);
      run.stopTimer.unref?.();
    }
  }

  private killWorker(worker: WorkerRecord, signal: NodeJS.Signals) {
    const pid = worker.pid || worker.child?.pid || 0;
    if (!pid) return;
    // A stopped (SIGSTOP) worker still receives SIGKILL.
    try {
      if (signal === "SIGKILL") process.kill(pid, "SIGCONT");
    } catch {
      /* ignore */
    }
    try {
      process.kill(pid, signal);
    } catch {
      worker.child?.kill(signal);
    }
  }

  continueRun(run: RunRecord): { runId: string; created: boolean } {
    if (isTerminal(run.state)) {
      const successor = this.createRun(run.projectId);
      this.startWorker(successor);
      return { runId: successor.id, created: true };
    }
    const active = this.activeWorkersFor(run.id);
    if (active.length === 0) this.startWorker(run);
    return { runId: run.id, created: false };
  }

  registerWorkerReady(workerId: string) {
    const worker = this.workers.get(workerId);
    if (!worker) throw new HttpError(404, `unknown worker ${workerId}`);
    worker.status = "running";
    const run = this.runs.get(worker.runId);
    if (run && run.workerId === worker.id && !run.stopRequested) this.transition(run, "RUNNING");
  }

  commitEffect(workerId: string, token: string) {
    const worker = this.workers.get(workerId);
    if (!worker) throw new HttpError(404, `unknown worker ${workerId}`);
    const run = this.runs.get(worker.runId);
    if (!run) throw new HttpError(404, `unknown run ${worker.runId}`);
    if (this.bug !== "duplicate-effect" && run.effectTokens.includes(token)) return;
    run.effectTokens.push(token);
    run.updatedAt = Date.now();
  }

  completeWorker(workerId: string, reason: string) {
    const worker = this.workers.get(workerId);
    if (!worker) throw new HttpError(404, `unknown worker ${workerId}`);
    worker.exitReason = reason;
    const run = this.runs.get(worker.runId);
    if (!run) return;
    if (run.stopRequested || run.state === "STOPPING") return;
    if (!isTerminal(run.state)) this.transition(run, "COMPLETED");
  }

  markGracefulExit(workerId: string, reason: string) {
    const worker = this.workers.get(workerId);
    if (!worker) throw new HttpError(404, `unknown worker ${workerId}`);
    worker.graceful = true;
    worker.exitReason = reason;
  }

  refreshRun(run: RunRecord) {
    if (this.bug === "terminal-revert" && isTerminal(run.state)) {
      this.transition(run, "RUNNING");
    }
    return run;
  }

  reset() {
    for (const worker of this.workers.values()) {
      if (worker.child && worker.status !== "exited") this.killWorker(worker, "SIGKILL");
      if (worker.child) worker.child.removeAllListeners("exit");
    }
    for (const run of this.runs.values()) if (run.stopTimer) clearTimeout(run.stopTimer);
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.recoveryTimers.clear();
    this.projects.clear();
    this.runs.clear();
    this.workers.clear();
    this.uiCache.clear();
    this.sequence = 0;
  }

  shutdown() {
    for (const worker of this.workers.values()) {
      if (worker.child && worker.status !== "exited") this.killWorker(worker, "SIGKILL");
    }
  }

  runView(run: RunRecord): RunView {
    const active = this.activeWorkersFor(run.id);
    return {
      id: run.id,
      projectId: run.projectId,
      state: run.state,
      stateSince: run.stateSince,
      workerId: run.workerId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      activeWorkers: active.map((worker) => worker.id),
      effectTokens: [...run.effectTokens],
      crashedWorkers: run.crashedWorkers,
      generations: run.generations,
      ui: {
        status: this.uiCache.get(run.id) ?? run.state,
        workerActive: active.length > 0,
        activeWorkerCount: active.length,
      },
    };
  }

  snapshot(): Snapshot {
    return {
      bugs: this.bug,
      projects: [...this.projects.values()].map((project) => ({ ...project })),
      runs: [...this.runs.values()].map((run) => this.runView(run)),
      workers: [...this.workers.values()].map((worker) => ({
        id: worker.id,
        runId: worker.runId,
        sessionId: worker.sessionId,
        pid: worker.pid,
        status: worker.status,
        startedAt: worker.startedAt,
        exitedAt: worker.exitedAt,
        exitReason: worker.exitReason,
      })),
    };
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ControlPlaneServerOptions {
  port?: number;
  bug?: BugName | null;
  externalUrl: string;
}

export async function startControlPlane(options: ControlPlaneServerOptions) {
  let baseUrl = "";
  const plane = new ControlPlane({
    bug: options.bug ?? null,
    controlUrl: () => baseUrl,
    externalUrl: options.externalUrl,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const segments = url.pathname.split("/").filter(Boolean);
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      const result = route(plane, req.method ?? "GET", segments, body);
      send(res, 200, result ?? { ok: true });
    } catch (error) {
      if (error instanceof HttpError) send(res, error.status, { error: error.message });
      else send(res, 500, { error: (error as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : Number(options.port ?? 0);
  baseUrl = `http://127.0.0.1:${port}`;

  const close = async () => {
    plane.shutdown();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  };

  return { plane, server, port, baseUrl, close };
}

function route(plane: ControlPlane, method: string, segments: string[], body: any): unknown {
  const [root, resource, id, action] = segments;
  if (root === "health") return { ok: true };
  if (root !== "api") throw new HttpError(404, "not found");

  if (resource === "snapshot" && method === "GET") return plane.snapshot();
  if (resource === "reset" && method === "POST") {
    plane.reset();
    return { ok: true };
  }
  if (resource === "projects") {
    if (method === "POST") return { projectId: plane.createProject(String(body.name ?? "project")).id };
    if (method === "GET") return plane.snapshot().projects;
  }
  if (resource === "runs") {
    if (!id) {
      if (method === "POST") return { runId: plane.createRun(String(body.projectId)).id };
      if (method === "GET") return plane.snapshot().runs;
      throw new HttpError(404, `no route for ${method} /${segments.join("/")}`);
    }
    if (method === "GET" && !action) {
      const run = plane.runs.get(id);
      if (!run) throw new HttpError(404, `unknown run ${id}`);
      return plane.runView(run);
    }
    if (action === "ui" && method === "GET") {
      const run = plane.runs.get(id);
      if (!run) throw new HttpError(404, `unknown run ${id}`);
      const view = plane.runView(run);
      return { status: view.ui.status, workerActive: view.ui.workerActive, activeWorkerCount: view.ui.activeWorkerCount };
    }
    if (method === "POST") {
      const run = plane.runs.get(id);
      if (!run) throw new HttpError(404, `unknown run ${id}`);
      if (action === "start") {
        plane.startWorker(run);
        return plane.runView(run);
      }
      if (action === "stop") {
        plane.stopRun(run, "graceful");
        return plane.runView(run);
      }
      if (action === "cancel") {
        plane.stopRun(run, "force");
        return plane.runView(run);
      }
      if (action === "refresh") return plane.runView(plane.refreshRun(run));
      if (action === "continue") return plane.continueRun(run);
    }
  }
  if (resource === "workers") {
    if (method === "GET") return plane.snapshot().workers;
    if (id && action && method === "POST") {
      if (action === "ready") {
        plane.registerWorkerReady(id);
        return { ok: true };
      }
      if (action === "heartbeat") return { ok: true };
      if (action === "effect") {
        plane.commitEffect(id, String(body.token));
        return { ok: true };
      }
      if (action === "complete") {
        plane.completeWorker(id, String(body.reason ?? "done"));
        return { ok: true };
      }
      if (action === "exited") {
        plane.markGracefulExit(id, String(body.reason ?? "graceful"));
        return { ok: true };
      }
    }
  }
  throw new HttpError(404, `no route for ${method} /${segments.join("/")}`);
}

/** Child-process entry point (`__serve`). */
export async function runServerEntry(argv: string[]): Promise<void> {
  const flag = (name: string, fallback?: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const externalUrl = flag("--external");
  if (!externalUrl) throw new Error("__serve requires --external <url>");
  const bug = (flag("--bug") ?? process.env.CHAOS_BUG ?? "") as BugName | "";
  const handle = await startControlPlane({
    port: Number(flag("--port", "0")),
    externalUrl,
    bug: bug && BUG_NAMES.includes(bug as BugName) ? (bug as BugName) : null,
  });
  process.stdout.write(`CHAOS_CONTROL_READY ${handle.baseUrl}\n`);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
