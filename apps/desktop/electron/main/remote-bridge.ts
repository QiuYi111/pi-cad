import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { PassThrough } from "node:stream";
import { dirname, posix } from "node:path";
import type { WebSocket } from "ws";
import type { AppSettings, DependencyCheck, RuntimeStatus, SimulationComponentStatus } from "../../src/shared/contracts.js";
import { engineeringKnowledgeProbe, managedPythonProbe, runtimeChecksReady, type RuntimeBridge, type RuntimePaths } from "./runtime-bridge.js";

/**
 * Bridge to the workspace gateway in a cloud workspace (plan §9.3). The wire
 * protocol is the one in cloud/protocol: JSON control frames, and binary frames
 * `[uint32 BE channel][payload]`. Spawn output uses `ch` for stdout and `ch + 1`
 * for stderr. Channels are allocated in steps of two so that a spawn's stderr
 * never collides with the next operation.
 */

/** Paths and commands fixed by the cloud image. Change them here only. */
export const REMOTE_RUNTIME = {
  workspaceRoot: "/workspace",
  optRoot: "/opt/reify",
  piCadRepo: "/opt/reify/pi-cad",
  primeAgentRepo: "/opt/reify/prime-agent",
  node: "/opt/reify/node/bin/node",
  uv: "/opt/reify/bin/uv",
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;
/** Client-side guard beyond the gateway timeout, so the gateway's own message wins when connected. */
const EXEC_GRACE_MS = 2_000;
const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** Bytes of recent output kept per stream to recognise what a reattached ring replays. Equals the gateway ring size. */
const OUTPUT_TAIL_BYTES = 1024 * 1024;
const UPLOAD_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const CHANNEL_HEADER_BYTES = 4;
const WS_OPEN = 1;
const SERVER_MANAGED = "由服务器管理";
const NOT_AVAILABLE_IN_STAGE_1 = "阶段 1 不可用";
const SIMULATION_COMPONENT = "torch-fem-0.9" as const;
const SIMULATION_SIZE = "about 6 GB";

export type RemoteConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

/** The part of a `ws` WebSocket the bridge uses. */
export type WebSocketLike = Pick<WebSocket, "send" | "close" | "terminate" | "on" | "readyState" | "bufferedAmount">;

export interface RemoteBridgeOptions {
  /** Resolves with an open socket to the gateway. The caller adds the URL and auth headers. */
  connect: () => Promise<WebSocketLike>;
  /** Project in use; undefined when no project is open. Read on every call. */
  projectId: () => string | undefined;
  onState?: (state: RemoteConnectionState) => void;
  /** Gateway workspace root. Defaults to /workspace; tests point it at a temporary directory. */
  workspaceRoot?: string;
}

type ServerMessage =
  | { type: "pong" }
  | { type: "spawned"; ch: number; spawnId: string; pid: number | undefined }
  | { type: "exit"; ch: number; code: number | null; signal: string | null }
  | { type: "exec_result"; ch: number; stdout: string; stderr: string; code: number | null }
  | { type: "file_end"; ch: number; size: number; sha256: string }
  | { type: "file_put_done"; ch: number; path: string; size: number; sha256: string }
  | { type: "error"; ch?: number; code: string; message: string }
  | { type: "activity"; active: boolean; reason: string };

/** An exec, download or upload waiting for its answer on one channel. */
interface Operation {
  kind: "exec" | "get" | "put";
  ch: number;
  /** True once the request left on the current socket. Unsent requests survive a reconnect. */
  sent: boolean;
  timer?: ReturnType<typeof setTimeout>;
  message(msg: ServerMessage): void;
  serverError(message: string): void;
  fail(error: Error): void;
  data?(chunk: Buffer): void;
}

interface SpawnOwner {
  kind: "spawn";
  rec: SpawnRecord;
  stream: 0 | 1;
}

interface SpawnRecord {
  ch: number;
  child: RemoteChildProcess;
  state: "queued" | "starting" | "running" | "exited";
  spawnId?: string;
  tails: [OutputTail, OutputTail];
  /** Output replayed by a reattach, held until the replay has ended (see onPong). */
  replay?: [Buffer[], Buffer[]];
  pendingExit?: { code: number | null; signal: string | null };
}

interface Outgoing {
  data: string | Uint8Array;
  skip?: () => boolean;
  onSent?: () => void;
}

/** Stand-in for ChildProcessWithoutNullStreams. Only the members the runtime callers use are real. */
class RemoteChildProcess extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(private readonly sendKill: (signal: NodeJS.Signals) => boolean) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!this.sendKill(signal)) return false;
    this.killed = true;
    return true;
  }

  ref(): this { return this; }
  unref(): this { return this; }
}

/** The last OUTPUT_TAIL_BYTES bytes delivered on one stream. */
class OutputTail {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    const kept = chunk.length > OUTPUT_TAIL_BYTES ? chunk.subarray(chunk.length - OUTPUT_TAIL_BYTES) : chunk;
    this.chunks.push(kept);
    this.size += kept.length;
    while (this.size > OUTPUT_TAIL_BYTES) {
      const excess = this.size - OUTPUT_TAIL_BYTES;
      const head = this.chunks[0]!;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export class RemoteBridge implements RuntimeBridge {
  readonly kind = "remote" as const;
  private readonly root: string;
  private socket?: WebSocketLike;
  private link: "idle" | "connecting" | "open" | "backoff" = "idle";
  private everConnected = false;
  private closed = false;
  private replaying = false;
  private backoffMs = RECONNECT_INITIAL_MS;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private nextChannel = 1;
  private readonly channels = new Map<number, Operation | SpawnOwner>();
  private readonly spawns = new Set<SpawnRecord>();
  private readonly outbox: Outgoing[] = [];
  private readonly waiters: Array<{ resolve: (ws: WebSocketLike) => void; reject: (error: Error) => void }> = [];

  constructor(private readonly options: RemoteBridgeOptions) {
    this.root = options.workspaceRoot ?? REMOTE_RUNTIME.workspaceRoot;
  }

  // ---- RuntimeBridge: commands -------------------------------------------------

  async exec(args: string[], options: { input?: string; timeout?: number; user?: string } = {}): Promise<{ stdout: string; stderr: string }> {
    if (options.user) throw new Error("Remote runtime cannot change users.");
    const [command] = args;
    if (!command) throw new Error("Runtime command is empty.");
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const ch = this.allocateChannel();
    return new Promise((resolve, reject) => {
      const op: Operation = {
        kind: "exec",
        ch,
        sent: false,
        message: (msg) => {
          if (msg.type !== "exec_result") return;
          this.release(op);
          if (msg.code === 0) resolve({ stdout: msg.stdout, stderr: msg.stderr });
          else reject(execFailure(command, msg.stdout, msg.stderr, msg.code));
        },
        serverError: (message) => {
          this.release(op);
          reject(new Error(message));
        },
        fail: (error) => {
          this.release(op);
          reject(error);
        },
      };
      const timer = setTimeout(() => op.fail(new Error(`${command} timed out after ${timeout}ms`)), timeout + EXEC_GRACE_MS);
      timer.unref();
      op.timer = timer;
      this.register(op);
      this.transmit({
        data: JSON.stringify({ type: "exec", ch, args, input: options.input, timeoutMs: timeout, env: this.projectEnvironment() }),
        skip: () => !this.channels.has(ch),
        onSent: () => { op.sent = true; },
      });
    });
  }

  spawn(args: string[]): ChildProcessWithoutNullStreams {
    const [command] = args;
    if (!command) throw new Error("Runtime command is empty.");
    const ch = this.allocateChannel();
    const child = new RemoteChildProcess((signal) => this.signalSpawn(rec, signal));
    const rec: SpawnRecord = { ch, child, state: "queued", tails: [new OutputTail(), new OutputTail()] };
    this.spawns.add(rec);
    this.channels.set(ch, { kind: "spawn", rec, stream: 0 });
    this.channels.set(ch + 1, { kind: "spawn", rec, stream: 1 });
    child.stdin.on("data", (chunk: Buffer) => {
      if (rec.state !== "exited") this.transmit({ data: encodeFrame(ch, chunk), skip: () => rec.state === "exited" });
    });
    child.stdin.on("end", () => {
      this.transmit({ data: JSON.stringify({ type: "stdin_end", ch }), skip: () => rec.state === "exited" });
    });
    this.transmit({
      data: JSON.stringify({ type: "spawn", ch, args, env: this.projectEnvironment() }),
      skip: () => rec.state === "exited",
      onSent: () => { if (rec.state === "queued") rec.state = "starting"; },
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }

  async pipe(args: string[], input: string, timeout = DEFAULT_TIMEOUT_MS) {
    return this.exec(args, { input, timeout });
  }

  // ---- RuntimeBridge: paths and environment ------------------------------------

  async toRuntimePath(value: string): Promise<string> {
    const normalized = posix.normalize(value);
    if (isInside(normalized, this.root) || isInside(normalized, REMOTE_RUNTIME.optRoot)) return value;
    throw new Error("云端模式请先上传文件");
  }

  async homeDirectory(): Promise<string> {
    return `${this.root}/home`;
  }

  async commandPath(name: "node" | "uv"): Promise<string> {
    return name === "node" ? REMOTE_RUNTIME.node : REMOTE_RUNTIME.uv;
  }

  async resolveRuntimePaths(_settings: AppSettings): Promise<RuntimePaths> {
    const projectId = this.options.projectId();
    return {
      piCadRepo: REMOTE_RUNTIME.piCadRepo,
      primeAgentRepo: REMOTE_RUNTIME.primeAgentRepo,
      projectPath: projectId ? `${this.root}/projects/${projectId}` : "",
    };
  }

  canonicalProjectDir(): string | undefined {
    const projectId = this.options.projectId();
    return projectId ? `${this.root}/state/${projectId}` : undefined;
  }

  // ---- RuntimeBridge: runtime status and installation --------------------------

  async check(settings: AppSettings): Promise<RuntimeStatus> {
    const checks: DependencyCheck[] = [];
    const add = (id: DependencyCheck["id"], ready: boolean, detail: string) => checks.push({ id, label: LABELS[id], status: ready ? "ready" : "missing", detail, installable: false });
    add("host", true, "Workspace gateway");
    const paths = await this.resolveRuntimePaths(settings);
    const knowledge = engineeringKnowledgeProbe(paths.piCadRepo);
    const script = [
      "export PATH=\"$HOME/.local/bin:$PATH\"",
      "printf 'bwrap=%s\\n' \"$(command -v bwrap || true)\"",
      `test -f ${JSON.stringify(paths.primeAgentRepo)}/prime-agent.sh && printf 'prime=ready\\n' || printf 'prime=missing\\n'`,
      `test -f ${JSON.stringify(paths.piCadRepo)}/package.json && printf 'picad=ready\\n' || printf 'picad=missing\\n'`,
      knowledge.command,
      managedPythonProbe(paths.piCadRepo),
    ].join("; ");
    const values = await this.pipe(["bash", "-s"], `${script}\n`, 120_000).then(
      ({ stdout }) => Object.fromEntries(stdout.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2))) as Record<string, string>,
      () => ({} as Record<string, string>),
    );
    const knowledgeReady = values.knowledge === String(knowledge.count);
    add("bwrap", Boolean(values.bwrap), values.bwrap || "Not installed");
    add("prime", values.prime === "ready", paths.primeAgentRepo);
    add("picad", values.picad === "ready" && knowledgeReady && values.cadpython === "ready",
      values.picad !== "ready" ? "Reify runtime is missing" : !knowledgeReady ? "Required engineering skills are missing" : values.cadpython !== "ready" ? "Managed CAD Python needs repair" : `${paths.piCadRepo} · ${knowledge.count} engineering skills`);
    const ready = runtimeChecksReady(checks);
    return { state: ready ? "idle" : "error", checks, message: ready ? undefined : "The cloud workspace runtime is not ready." };
  }

  async install(_settings: AppSettings, _onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus> {
    return serverManagedStatus();
  }

  async installWsl(_onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus> {
    return serverManagedStatus();
  }

  async checkSimulationComponent(_settings: AppSettings): Promise<SimulationComponentStatus> {
    return { state: "missing", component: SIMULATION_COMPONENT, detail: NOT_AVAILABLE_IN_STAGE_1, estimatedSize: SIMULATION_SIZE };
  }

  async installSimulationComponent(_settings: AppSettings): Promise<SimulationComponentStatus> {
    return { state: "ready", component: SIMULATION_COMPONENT, detail: SERVER_MANAGED, estimatedSize: SIMULATION_SIZE };
  }

  async revealPath(path: string): Promise<string> {
    return path;
  }

  // ---- File transfer (not part of RuntimeBridge) -------------------------------

  /** Downloads a workspace file and verifies the received bytes against the gateway's sha256. */
  async download(remotePath: string, localPath: string): Promise<{ size: number; sha256: string }> {
    await mkdir(dirname(localPath), { recursive: true });
    const temporary = `${localPath}.download`;
    const out = createWriteStream(temporary);
    const writing = finished(out);
    writing.catch(() => {});
    const hash = createHash("sha256");
    let size = 0;
    const ch = this.allocateChannel();
    try {
      const end = await new Promise<{ size: number; sha256: string }>((resolve, reject) => {
        const op: Operation = {
          kind: "get",
          ch,
          sent: false,
          data: (chunk) => {
            hash.update(chunk);
            size += chunk.length;
            out.write(chunk);
          },
          message: (msg) => {
            if (msg.type !== "file_end") return;
            this.release(op);
            resolve({ size: msg.size, sha256: msg.sha256 });
          },
          serverError: (message) => op.fail(new Error(message)),
          fail: (error) => {
            this.release(op);
            reject(error);
          },
        };
        this.register(op);
        this.transmit({
          data: JSON.stringify({ type: "file_get", ch, path: remotePath }),
          skip: () => !this.channels.has(ch),
          onSent: () => { op.sent = true; },
        });
      });
      out.end();
      await writing;
      const sha256 = hash.digest("hex");
      if (size !== end.size || sha256 !== end.sha256) throw new Error(`${remotePath} failed checksum verification`);
      await rename(temporary, localPath);
      return { size, sha256 };
    } catch (error) {
      out.destroy();
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Uploads a local file through file_put_begin, binary frames and file_put_end. The gateway verifies size and sha256. */
  async upload(localPath: string, remotePath: string): Promise<{ size: number; sha256: string }> {
    const { size, sha256 } = await hashFile(localPath);
    await this.exec(["mkdir", "-p", "--", posix.dirname(remotePath)]);
    const ch = this.allocateChannel();
    let op!: Operation;
    const done = new Promise<void>((resolve, reject) => {
      op = {
        kind: "put",
        ch,
        sent: false,
        message: (msg) => {
          if (msg.type !== "file_put_done") return;
          this.release(op);
          if (msg.size === size && msg.sha256 === sha256) resolve();
          else reject(new Error(`${remotePath} was not stored intact`));
        },
        serverError: (message) => op.fail(new Error(message)),
        fail: (error) => {
          this.release(op);
          reject(error);
        },
      };
      this.register(op);
      this.transmit({
        data: JSON.stringify({ type: "file_put_begin", ch, path: remotePath, size, sha256 }),
        skip: () => !this.channels.has(ch),
        onSent: () => { op.sent = true; },
      });
    });
    done.catch(() => {});
    try {
      for await (const chunk of createReadStream(localPath, { highWaterMark: CHUNK_BYTES }) as AsyncIterable<Buffer>) {
        const ws = await this.ready();
        if (this.channels.get(ch) !== op) break;
        while (ws.bufferedAmount > UPLOAD_HIGH_WATER_BYTES && this.socket === ws) await new Promise((resolve) => setTimeout(resolve, 10));
        ws.send(encodeFrame(ch, chunk));
      }
      if (this.channels.get(ch) === op) {
        const ws = await this.ready();
        if (this.channels.get(ch) === op) ws.send(JSON.stringify({ type: "file_put_end", ch }));
      }
      await done;
      return { size, sha256 };
    } catch (error) {
      this.release(op);
      throw error;
    }
  }

  /** Closes the socket and fails every pending call. Running spawns are left to the gateway's own lifetime rules. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.link = "idle";
    clearTimeout(this.retryTimer);
    const error = new Error("Remote workspace connection closed.");
    this.outbox.length = 0;
    for (const owner of new Set(this.channels.values())) if (owner.kind !== "spawn") owner.fail(error);
    for (const rec of [...this.spawns]) this.finish(rec, null, null);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.options.onState?.("closed");
  }

  // ---- Connection lifecycle ----------------------------------------------------

  private kick(): void {
    if (this.closed || this.link !== "idle") return;
    void this.tryConnect();
  }

  private async tryConnect(): Promise<void> {
    if (this.closed) return;
    this.link = "connecting";
    this.options.onState?.(this.everConnected ? "reconnecting" : "connecting");
    let socket: WebSocketLike;
    try {
      socket = await this.options.connect();
      if (socket.readyState !== WS_OPEN) throw new Error("Remote workspace socket is not open.");
    } catch (error) {
      if (this.closed) return;
      if (this.everConnected) {
        this.scheduleRetry();
        return;
      }
      // The first connection attempt is not retried: the calls waiting on it fail with its error.
      this.link = "idle";
      this.options.onState?.("closed");
      this.failQueued(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (this.closed) {
      socket.close();
      return;
    }
    this.everConnected = true;
    this.link = "open";
    this.backoffMs = RECONNECT_INITIAL_MS;
    this.adopt(socket);
  }

  private scheduleRetry(): void {
    this.link = "backoff";
    const delay = this.backoffMs;
    this.backoffMs = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.tryConnect();
    }, delay);
  }

  private adopt(socket: WebSocketLike): void {
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (this.socket === socket) this.onMessage(data, isBinary);
    });
    socket.on("close", () => this.onLost(socket));
    socket.on("error", () => {});
    this.options.onState?.("connected");
    // Reattach live spawns first. Their replay is held until the ping that follows is answered.
    for (const rec of this.spawns) {
      if (rec.state !== "running" || rec.spawnId === undefined) continue;
      rec.replay = [[], []];
      socket.send(JSON.stringify({ type: "attach", ch: rec.ch, spawnId: rec.spawnId }));
      this.replaying = true;
    }
    if (this.replaying) socket.send(JSON.stringify({ type: "ping" }));
    this.drain();
  }

  private onLost(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.replaying = false;
    const lost = new Error("Remote workspace connection lost.");
    for (const owner of new Set(this.channels.values())) if (owner.kind !== "spawn" && owner.sent) owner.fail(lost);
    for (const rec of [...this.spawns]) {
      if (rec.state === "starting") {
        emitError(rec.child, lost);
        this.finish(rec, null, null);
      } else {
        rec.replay = undefined;
      }
    }
    if (!this.closed) this.scheduleRetry();
  }

  private failQueued(error: Error): void {
    this.outbox.length = 0;
    for (const owner of new Set(this.channels.values())) if (owner.kind !== "spawn") owner.fail(error);
    for (const rec of [...this.spawns]) {
      if (rec.state !== "queued") continue;
      emitError(rec.child, error);
      this.finish(rec, null, null);
    }
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private canSendDirect(): boolean {
    return this.socket !== undefined && this.socket.readyState === WS_OPEN && !this.replaying;
  }

  private transmit(item: Outgoing): void {
    if (this.outbox.length === 0 && this.canSendDirect()) {
      this.sendItem(this.socket!, item);
      return;
    }
    this.outbox.push(item);
    this.kick();
  }

  private sendItem(socket: WebSocketLike, item: Outgoing): void {
    if (item.skip?.()) return;
    item.onSent?.();
    socket.send(item.data);
  }

  /** Sends queued items in order, then releases callers waiting for a usable socket. */
  private drain(): void {
    if (!this.canSendDirect()) return;
    while (this.outbox.length > 0 && this.canSendDirect()) this.sendItem(this.socket!, this.outbox.shift()!);
    if (!this.canSendDirect()) return;
    for (const waiter of this.waiters.splice(0)) waiter.resolve(this.socket!);
  }

  private ready(): Promise<WebSocketLike> {
    if (this.canSendDirect() && this.outbox.length === 0) return Promise.resolve(this.socket!);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.kick();
    });
  }

  // ---- Incoming messages -------------------------------------------------------

  private onMessage(data: unknown, isBinary: boolean): void {
    const bytes = toBuffer(data);
    if (isBinary) {
      if (bytes.length < CHANNEL_HEADER_BYTES) return;
      this.onBytes(bytes.readUInt32BE(0), bytes.subarray(CHANNEL_HEADER_BYTES));
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(bytes.toString("utf8")) as ServerMessage;
    } catch {
      return;
    }
    this.onControl(msg);
  }

  private onBytes(ch: number, payload: Buffer): void {
    const owner = this.channels.get(ch);
    if (!owner) return;
    if (owner.kind === "spawn") {
      if (owner.rec.replay) owner.rec.replay[owner.stream].push(payload);
      else this.deliver(owner.rec, owner.stream, payload);
    } else {
      owner.data?.(payload);
    }
  }

  private onControl(msg: ServerMessage): void {
    switch (msg.type) {
      case "pong":
        this.onPong();
        return;
      case "spawned": {
        const owner = this.channels.get(msg.ch);
        if (owner?.kind !== "spawn") return;
        owner.rec.spawnId = msg.spawnId;
        owner.rec.child.pid = msg.pid;
        owner.rec.state = "running";
        owner.rec.child.emit("spawn");
        return;
      }
      case "exit": {
        const owner = this.channels.get(msg.ch);
        if (owner?.kind !== "spawn") return;
        if (owner.rec.replay) owner.rec.pendingExit = { code: msg.code, signal: msg.signal };
        else this.finish(owner.rec, msg.code, msg.signal);
        return;
      }
      case "exec_result":
      case "file_end":
      case "file_put_done": {
        const owner = this.channels.get(msg.ch);
        if (owner && owner.kind !== "spawn") owner.message(msg);
        return;
      }
      case "error": {
        if (msg.ch === undefined) return;
        const owner = this.channels.get(msg.ch);
        if (!owner) return;
        if (owner.kind === "spawn") this.spawnError(owner.rec, msg);
        else owner.serverError(msg.message);
        return;
      }
      case "activity":
        return;
    }
  }

  private spawnError(rec: SpawnRecord, msg: { code: string; message: string }): void {
    if (rec.replay || rec.state === "starting") {
      rec.replay = undefined;
      emitError(rec.child, new Error(msg.message));
      this.finish(rec, null, null);
      return;
    }
    if (msg.code === "failed") emitError(rec.child, new Error(msg.message));
  }

  /**
   * The replay after an attach is complete once the ping is answered. The
   * gateway replays its ring from the start of what it still holds, so the
   * replayed bytes that were already delivered are dropped by matching them
   * against the tail of what this stream delivered before the disconnect.
   */
  private onPong(): void {
    if (!this.replaying) return;
    this.replaying = false;
    for (const rec of [...this.spawns]) {
      if (!rec.replay) continue;
      const replay = rec.replay;
      rec.replay = undefined;
      for (const stream of [0, 1] as const) {
        const bytes = Buffer.concat(replay[stream]);
        const skip = overlapLength(bytes, rec.tails[stream].bytes());
        if (skip < bytes.length) this.deliver(rec, stream, bytes.subarray(skip));
      }
      if (rec.pendingExit) this.finish(rec, rec.pendingExit.code, rec.pendingExit.signal);
    }
    this.drain();
  }

  private deliver(rec: SpawnRecord, stream: 0 | 1, chunk: Buffer): void {
    if (rec.state === "exited" || chunk.length === 0) return;
    rec.tails[stream].push(chunk);
    (stream === 0 ? rec.child.stdout : rec.child.stderr).write(chunk);
  }

  private finish(rec: SpawnRecord, code: number | null, signal: string | null): void {
    if (rec.state === "exited") return;
    rec.state = "exited";
    rec.replay = undefined;
    rec.pendingExit = undefined;
    this.spawns.delete(rec);
    this.channels.delete(rec.ch);
    this.channels.delete(rec.ch + 1);
    const child = rec.child;
    child.exitCode = code;
    child.signalCode = signal as NodeJS.Signals | null;
    child.stdout.end();
    child.stderr.end();
    // A stream nobody reads would never emit 'end'; drain it so 'close' still follows.
    for (const stream of [child.stdout, child.stderr]) if (stream.readableFlowing === null) stream.resume();
    child.emit("exit", code, signal);
    // As in Node, 'close' follows once both output streams have ended.
    Promise.all([endOf(child.stdout), endOf(child.stderr)]).then(() => child.emit("close", code, signal));
  }

  private signalSpawn(rec: SpawnRecord, signal: NodeJS.Signals): boolean {
    if (rec.state === "exited") return false;
    this.transmit({ data: JSON.stringify({ type: "kill", ch: rec.ch, signal }), skip: () => rec.state === "exited" });
    return true;
  }

  // ---- Channels and project environment ----------------------------------------

  private allocateChannel(): number {
    const ch = this.nextChannel;
    this.nextChannel += 2;
    return ch;
  }

  private register(op: Operation): void {
    this.channels.set(op.ch, op);
  }

  private release(op: Operation): void {
    clearTimeout(op.timer);
    if (this.channels.get(op.ch) === op) this.channels.delete(op.ch);
  }

  private projectEnvironment(): Record<string, string> | undefined {
    const dir = this.canonicalProjectDir();
    return dir ? { PI_CAD_CANONICAL_PROJECT_DIR: dir } : undefined;
  }
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function serverManagedStatus(): RuntimeStatus {
  const ids: DependencyCheck["id"][] = ["host", "bwrap", "prime", "picad"];
  return {
    state: "idle",
    checks: ids.map((id) => ({ id, label: LABELS[id], status: "ready", detail: SERVER_MANAGED, installable: false })),
  };
}

const LABELS: Record<DependencyCheck["id"], string> = {
  host: "Cloud workspace",
  wsl: "WSL 2 and Ubuntu",
  node: "Node.js",
  python: "Python",
  uv: "uv",
  sandbox: "Sandbox",
  bwrap: "Bubblewrap",
  prime: "Prime Agent",
  picad: "Reify runtime",
  paraview: "ParaView",
};

function execFailure(command: string, stdout: string, stderr: string, code: number | null): Error {
  return Object.assign(new Error(`${command} exited with ${code ?? "unknown status"}${stderr ? `: ${stderr}` : ""}`), { stdout, stderr, code });
}

function emitError(child: RemoteChildProcess, error: Error): void {
  if (child.listenerCount("error") > 0) child.emit("error", error);
}

function endOf(stream: PassThrough): Promise<void> {
  return new Promise((resolve) => {
    if (stream.readableEnded) resolve();
    else stream.once("end", () => resolve());
  });
}

/**
 * Length of the longest prefix of `replay` that equals the end of `seen`.
 * Zero when nothing overlaps (the gateway ring dropped bytes this stream never saw).
 */
export function overlapLength(replay: Buffer, seen: Buffer): number {
  const max = Math.min(replay.length, seen.length);
  for (let length = max; length > 0; length--) {
    const start = seen.length - length;
    if (seen[start] === replay[0] && seen.subarray(start).equals(replay.subarray(0, length))) return length;
  }
  return 0;
}

/** Binary frame encoding, the same layout as cloud/protocol encodeFrame. */
export function encodeFrame(ch: number, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(CHANNEL_HEADER_BYTES + data.length);
  new DataView(frame.buffer).setUint32(0, ch, false);
  frame.set(data, CHANNEL_HEADER_BYTES);
  return frame;
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(data as ArrayBuffer);
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}
