import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  decodeFrame,
  encodeFrame,
  execCollect,
  ExecExitError,
  resolveWorkspacePath,
  WorkspacePathError,
  type ClientMessage,
  type GatewayMessage,
} from "@reify/cloud-protocol";
import { ActivityMonitor } from "./activity.js";
import { GATEWAY_TOKEN_HEADER, type TokenVerifier } from "./auth.js";
import { errorMessage, ProtocolError } from "./errors.js";
import { streamFile, Upload } from "./files.js";
import { RingBuffer } from "./ring.js";

const RING_BYTES = 1024 * 1024;
const RETENTION_MS = 10 * 60_000;

export type GatewayOptions = {
  port?: number;
  workspaceRoot: string;
  readOnlyRoots?: string[];
  verifyToken: TokenVerifier;
  ignoredCommands?: string[];
  now?: () => number;
  exit?: (code: number) => void;
  shutdownTimeoutMs?: number;
};

export type Gateway = { port: number; monitor: ActivityMonitor; close(): Promise<void> };

type Subscriber = { conn: Connection; ch: number };
type Spawned = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  running: boolean;
  rings: [RingBuffer, RingBuffer];
  subscriber?: Subscriber;
  exit?: { code: number | null; signal: string | null };
};
// Uploads are stored as promises so bytes sent right behind file_put_begin can be queued in order.
type Connection = { ws: WebSocket; spawns: Map<number, Spawned>; uploads: Map<number, Promise<Upload>> };

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const monitor = new ActivityMonitor({ now: options.now, ignoredCommands: options.ignoredCommands });
  const spawns = new Map<string, Spawned>();
  const connections = new Set<Connection>();
  const roots = { workspaceRoot: options.workspaceRoot, readOnlyRoots: options.readOnlyRoots ?? [] };
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const wss = new WebSocketServer({ noServer: true });
  const http: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });

  http.on("upgrade", (req, socket, head) => {
    const token = req.headers[GATEWAY_TOKEN_HEADER];
    options.verifyToken(typeof token === "string" ? token : "").then((ok) => {
      if (!ok) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      wss.handleUpgrade(req, socket, head, (ws) => serve(ws));
    }, () => socket.destroy());
  });

  function serve(ws: WebSocket) {
    const conn: Connection = { ws, spawns: new Map(), uploads: new Map() };
    connections.add(conn);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return onFrame(conn, Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
      void onText(conn, data.toString());
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      connections.delete(conn);
      for (const record of spawns.values()) if (record.subscriber?.conn === conn) record.subscriber = undefined;
      for (const upload of conn.uploads.values()) void upload.then((opened) => opened.discard(), () => {});
    });
  }

  async function onText(conn: Connection, text: string) {
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(text);
    } catch (error) {
      return send(conn, errorMessage(undefined, error));
    }
    if (msg.type !== "ping") monitor.noteMessage();
    try {
      await handle(conn, msg);
    } catch (error) {
      send(conn, errorMessage("ch" in msg ? msg.ch : undefined, error));
    }
  }

  async function handle(conn: Connection, msg: ClientMessage) {
    switch (msg.type) {
      case "ping":
        return send(conn, { type: "pong" });
      case "exec":
        return exec(conn, msg.ch, msg.args, msg.input, msg.timeoutMs);
      case "spawn":
        return start(conn, msg.ch, msg.args, msg.env, msg.cwd);
      case "stdin_end":
        return must(conn, msg.ch).child.stdin.end();
      case "kill":
        return must(conn, msg.ch).child.kill((msg.signal ?? "SIGTERM") as NodeJS.Signals);
      case "attach":
        return attach(conn, msg.ch, msg.spawnId);
      case "file_get":
        return fileGet(conn, msg.ch, msg.path);
      case "file_put_begin":
        return putBegin(conn, msg);
      case "file_put_end":
        return putEnd(conn, msg.ch);
      case "shutdown":
        return shutdown();
    }
  }

  async function exec(conn: Connection, ch: number, args: string[], input: string | undefined, timeoutMs: number | undefined) {
    try {
      const { stdout, stderr } = await execCollect(args, { input, timeout: timeoutMs, cwd: options.workspaceRoot, env: childEnv() });
      send(conn, { type: "exec_result", ch, stdout, stderr, code: 0 });
    } catch (error) {
      if (!(error instanceof ExecExitError)) throw error;
      send(conn, { type: "exec_result", ch, stdout: error.stdout, stderr: error.stderr, code: error.code });
    }
  }

  async function start(conn: Connection, ch: number, args: string[], env: Record<string, string> | undefined, cwd: string | undefined) {
    const workdir = cwd ? (await resolveWorkspacePath(cwd, roots)).abs : options.workspaceRoot;
    if (conn.spawns.has(ch)) throw new ProtocolError("channel_busy", `channel ${ch} is in use`);
    const [command, ...rest] = args;
    const child = spawn(command!, rest, { stdio: "pipe", cwd: workdir, env: childEnv(env) });
    const record: Spawned = { id: randomUUID(), child, running: true, rings: [new RingBuffer(RING_BYTES), new RingBuffer(RING_BYTES)] };
    spawns.set(record.id, record);
    monitor.processStarted(record.id, args);
    bind(record, conn, ch);
    child.stdin.on("error", () => {});
    send(conn, { type: "spawned", ch, spawnId: record.id, pid: child.pid });
    child.stdout.on("data", (chunk: Buffer) => output(record, 0, chunk));
    child.stderr.on("data", (chunk: Buffer) => output(record, 1, chunk));
    child.on("error", (error) => {
      if (record.subscriber) send(record.subscriber.conn, { type: "error", ch: record.subscriber.ch, code: "failed", message: error.message });
      if (child.pid === undefined) finish(record, null, null);
    });
    child.on("close", (code, signal) => finish(record, code, signal));
  }

  function output(record: Spawned, stream: 0 | 1, chunk: Buffer) {
    record.rings[stream].push(chunk);
    if (stream === 0) monitor.stdout(record.id, chunk);
    if (record.subscriber) sendBytes(record.subscriber.conn, record.subscriber.ch + stream, chunk);
  }

  function finish(record: Spawned, code: number | null, signal: string | null) {
    if (!record.running) return;
    record.running = false;
    record.exit = { code, signal };
    monitor.processStopped(record.id);
    if (record.subscriber) send(record.subscriber.conn, { type: "exit", ch: record.subscriber.ch, code, signal });
    setTimeout(() => spawns.delete(record.id), RETENTION_MS).unref();
  }

  function attach(conn: Connection, ch: number, spawnId: string) {
    const record = spawns.get(spawnId);
    if (!record) throw new ProtocolError("no_such_spawn", `no spawn ${spawnId}`);
    bind(record, conn, ch);
    record.rings.forEach((ring, stream) => ring.snapshot().forEach((chunk) => sendBytes(conn, ch + stream, chunk)));
    if (record.exit) send(conn, { type: "exit", ch, ...record.exit });
  }

  // Points the spawn's live output at this connection and channel.
  function bind(record: Spawned, conn: Connection, ch: number) {
    const previous = conn.spawns.get(ch);
    if (previous && previous !== record && previous.subscriber?.conn === conn) previous.subscriber = undefined;
    conn.spawns.set(ch, record);
    record.subscriber = { conn, ch };
  }

  function must(conn: Connection, ch: number): Spawned {
    const record = conn.spawns.get(ch);
    if (!record) throw new ProtocolError("no_such_spawn", `no spawn on channel ${ch}`);
    return record;
  }

  async function fileGet(conn: Connection, ch: number, path: string) {
    const { abs } = await resolveWorkspacePath(path, roots);
    const { size, sha256 } = await streamFile(abs, (chunk) => {
      if (conn.ws.readyState !== WebSocket.OPEN) return false;
      sendBytes(conn, ch, chunk);
      return true;
    });
    send(conn, { type: "file_end", ch, size, sha256 });
  }

  async function putBegin(conn: Connection, msg: Extract<ClientMessage, { type: "file_put_begin" }>) {
    if (conn.uploads.has(msg.ch)) throw new ProtocolError("channel_busy", `channel ${msg.ch} is in use`);
    const opening = openUpload(msg.path, msg.size, msg.sha256);
    conn.uploads.set(msg.ch, opening);
    try {
      await opening;
    } catch (error) {
      if (conn.uploads.get(msg.ch) === opening) conn.uploads.delete(msg.ch);
      throw error;
    }
  }

  async function openUpload(path: string, size: number, sha256: string): Promise<Upload> {
    const { abs, readOnly } = await resolveWorkspacePath(path, roots);
    if (readOnly) throw new ProtocolError("read_only", `${path} is read-only`);
    return new Upload(path, abs, size, sha256);
  }

  async function putEnd(conn: Connection, ch: number) {
    const opening = conn.uploads.get(ch);
    if (!opening) throw new ProtocolError("not_found", `no upload on channel ${ch}`);
    conn.uploads.delete(ch);
    const upload = await opening;
    await upload.commit();
    send(conn, { type: "file_put_done", ch, path: upload.path, size: upload.size, sha256: upload.sha256 });
  }

  function onFrame(conn: Connection, bytes: Buffer) {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      return send(conn, errorMessage(undefined, new ProtocolError("bad_request", (error as Error).message)));
    }
    const opening = conn.uploads.get(frame.ch);
    if (opening) {
      void opening.then((upload) => upload.write(frame.data), () => {});
      return;
    }
    const record = conn.spawns.get(frame.ch);
    if (record?.running) return void record.child.stdin.write(frame.data);
    send(conn, { type: "error", ch: frame.ch, code: "no_such_spawn", message: `nothing accepts data on channel ${frame.ch}` });
  }

  async function shutdown() {
    const running = () => [...spawns.values()].filter((record) => record.running);
    running().forEach((record) => record.child.kill("SIGTERM"));
    const deadline = Date.now() + (options.shutdownTimeoutMs ?? 30_000);
    while (running().length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    running().forEach((record) => record.child.kill("SIGKILL"));
    exit(0);
  }

  async function close() {
    for (const record of spawns.values()) if (record.running) record.child.kill("SIGKILL");
    for (const conn of connections) conn.ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, resolve));
  return { port: (http.address() as AddressInfo).port, monitor, close };
}

function parseClientMessage(text: string): ClientMessage {
  const msg = JSON.parse(text) as Partial<ClientMessage> & { type?: unknown };
  if (!msg || typeof msg.type !== "string") throw new ProtocolError("bad_request", "message needs a type");
  if ("ch" in msg && !Number.isInteger(msg.ch)) throw new ProtocolError("bad_request", "ch must be an integer");
  if ("args" in msg && (!Array.isArray(msg.args) || msg.args.length === 0 || !msg.args.every((arg) => typeof arg === "string"))) {
    throw new ProtocolError("bad_request", "args must be a non-empty string array");
  }
  return msg as ClientMessage;
}

function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.REIFY_ACTIVITY_TOKEN;
  return env;
}

function send(conn: Connection, message: GatewayMessage) {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(message));
}

function sendBytes(conn: Connection, ch: number, data: Uint8Array) {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(encodeFrame(ch, data));
}
