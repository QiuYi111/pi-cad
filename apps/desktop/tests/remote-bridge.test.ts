import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGateway, type Gateway } from "../../../cloud/workspace-gateway/src/server";
import { RemoteBridge, overlapLength, type RemoteConnectionState } from "../electron/main/remote-bridge";
import { RemoteProjectIO } from "../electron/main/remote-project-io";
import { withCanonicalProjectEnvironment } from "../electron/main/runtime-bridge";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let base: string;
let root: string;
let gateway: Gateway;
let url: string;
let sockets: WebSocket[];
let states: RemoteConnectionState[];
let projectId: string | undefined;
let bridge: RemoteBridge;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "reify-remote-"));
  root = join(base, "workspace");
  await mkdir(root, { recursive: true });
  gateway = await startGateway({ port: 0, workspaceRoot: root, verifyToken: async () => true, exit: () => {} });
  url = `ws://127.0.0.1:${gateway.port}/`;
  sockets = [];
  states = [];
  projectId = "p1";
  bridge = new RemoteBridge({
    workspaceRoot: root,
    projectId: () => projectId,
    onState: (state) => states.push(state),
    connect: async () => {
      const ws = await openSocket(url);
      sockets.push(ws);
      return ws;
    },
  });
});

afterEach(async () => {
  bridge.close();
  await gateway.close();
  await rm(base, { recursive: true, force: true });
});

describe("remote bridge commands", () => {
  it("runs exec and returns stdout and stderr", async () => {
    await expect(bridge.exec(["echo", "hello"])).resolves.toEqual({ stdout: "hello\n", stderr: "" });
  });

  it("rejects a failing exec with the NativeBridge message and the captured output", async () => {
    const failure = bridge.exec(["sh", "-c", "echo partial; echo oops >&2; exit 3"]);
    await expect(failure).rejects.toThrow("sh exited with 3: oops\n");
    await expect(failure).rejects.toMatchObject({ stdout: "partial\n", stderr: "oops\n", code: 3 });
  });

  it("times out an exec with the gateway's message", async () => {
    await expect(bridge.exec(["sleep", "5"], { timeout: 200 })).rejects.toThrow("sleep timed out after 200ms");
  });

  it("adds the canonical project directory to exec and spawn environments", async () => {
    const expected = `${root}/state/p1`;
    await expect(bridge.exec(["sh", "-c", "printf %s \"$PI_CAD_CANONICAL_PROJECT_DIR\""])).resolves.toEqual({ stdout: expected, stderr: "" });
    const child = bridge.spawn(["sh", "-c", "printf %s \"$PI_CAD_CANONICAL_PROJECT_DIR\""]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    await new Promise((resolve) => child.once("close", resolve));
    expect(out).toBe(expected);
  });

  it("round-trips stdin through a spawned process and reports exit", async () => {
    const child = bridge.spawn(["cat"]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    const exited = new Promise<[number | null, string | null]>((resolve) => child.once("exit", (code, signal) => resolve([code, signal])));
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stdin.write("round ");
    child.stdin.end("trip\n");
    await expect(exited).resolves.toEqual([0, null]);
    await closed;
    expect(out).toBe("round trip\n");
    expect(child.exitCode).toBe(0);
  });

  it("delivers stderr of a spawn on its own stream", async () => {
    const child = bridge.spawn(["sh", "-c", "echo out; echo err >&2"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    await new Promise((resolve) => child.once("close", resolve));
    expect(out).toBe("out\n");
    expect(err).toBe("err\n");
  });

  it("reattaches a running spawn after a forced disconnect and delivers its output exactly once", async () => {
    const child = bridge.spawn(["sh", "-c", "echo early; sleep 1; echo late"]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    await waitFor(() => out.includes("early\n"));
    sockets[sockets.length - 1]!.terminate();
    await expect(closed).resolves.toBe(0);
    expect(out).toBe("early\nlate\n");
    expect(states).toContain("reconnecting");
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  });

  it("replays output written while disconnected, and the exit, without repeating what was delivered", async () => {
    const child = bridge.spawn(["sh", "-c", "echo early; sleep 0.3; echo late"]);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    await waitFor(() => out.includes("early\n"));
    sockets[sockets.length - 1]!.terminate();
    await expect(closed).resolves.toBe(0);
    expect(out).toBe("early\nlate\n");
  });

  it("fails calls when the first connection cannot be made", async () => {
    const offline = new RemoteBridge({ projectId: () => undefined, connect: async () => { throw new Error("gateway refused"); } });
    await expect(offline.exec(["true"])).rejects.toThrow("gateway refused");
    offline.close();
  });

  it("reports the runtime checks it probes", async () => {
    const status = await bridge.check({} as never);
    expect(status.checks.map((check) => check.id)).toEqual(["host", "bwrap", "prime", "picad"]);
  });
});

describe("remote bridge paths and fixed facts", () => {
  it("keeps host paths out and workspace and runtime paths in", async () => {
    const remote = new RemoteBridge({ projectId: () => undefined, connect: async () => { throw new Error("unused"); } });
    await expect(remote.toRuntimePath("/Users/me/model.step")).rejects.toThrow("云端模式请先上传文件");
    await expect(remote.toRuntimePath("/workspace/projects/a.step")).resolves.toBe("/workspace/projects/a.step");
    await expect(remote.toRuntimePath("/opt/reify/pi-cad")).resolves.toBe("/opt/reify/pi-cad");
    await expect(remote.homeDirectory()).resolves.toBe("/workspace/home");
    await expect(remote.commandPath("node")).resolves.toBe("/opt/reify/node/bin/node");
    await expect(remote.commandPath("uv")).resolves.toBe("/opt/reify/bin/uv");
    await expect(remote.resolveRuntimePaths({} as never)).resolves.toEqual({
      piCadRepo: "/opt/reify/pi-cad",
      primeAgentRepo: "/opt/reify/prime-agent",
      projectPath: "",
    });
    await expect(remote.checkSimulationComponent({} as never)).resolves.toMatchObject({ state: "missing", detail: "阶段 1 不可用" });
    await expect(remote.revealPath("/workspace/a.txt")).resolves.toBe("/workspace/a.txt");
    remote.close();
  });

  it("leaves argv alone for the remote bridge, which sets the canonical directory in the environment itself", async () => {
    await expect(withCanonicalProjectEnvironment(bridge, "/unused", ["node", "worker.mjs"])).resolves.toEqual(["node", "worker.mjs"]);
    await expect(bridge.exec(["sh", "-c", "printf %s \"$PI_CAD_CANONICAL_PROJECT_DIR\""])).resolves.toEqual({ stdout: `${root}/state/p1`, stderr: "" });
  });

  it("keeps the canonical directory per project, so a project switch changes it", async () => {
    projectId = "p2";
    await expect(bridge.exec(["sh", "-c", "printf %s \"$PI_CAD_CANONICAL_PROJECT_DIR\""])).resolves.toEqual({ stdout: `${root}/state/p2`, stderr: "" });
  });

  it("matches a replayed prefix against the tail of what was delivered", () => {
    expect(overlapLength(Buffer.from("early\nlate\n"), Buffer.from("early\n"))).toBe(6);
    expect(overlapLength(Buffer.from("late\n"), Buffer.from("early\n"))).toBe(0);
    expect(overlapLength(Buffer.from("x"), Buffer.alloc(0))).toBe(0);
  });
});

describe("remote bridge file transfer", () => {
  // The test gateway runs on this host and executes POSIX commands; the real gateway runs only in the Linux workspace pod.
  it.skipIf(process.platform === "win32")("uploads a file and downloads it back with matching checksums", async () => {
    const data = randomBytes(300_000);
    const local = join(base, "upload.bin");
    await writeFile(local, data);
    const remote = join(root, "projects", "p1", "models", "part.bin");

    await expect(bridge.upload(local, remote)).resolves.toEqual({ size: data.length, sha256: sha256(data) });
    expect((await readFile(remote)).equals(data)).toBe(true);

    const back = join(base, "download", "part.bin");
    await expect(bridge.download(remote, back)).resolves.toEqual({ size: data.length, sha256: sha256(data) });
    expect((await readFile(back)).equals(data)).toBe(true);
  });
});

describe("RemoteProjectIO", () => {
  it("polls the transfer spool at most every two seconds", () => {
    const io = new RemoteProjectIO(bridge, join(root, "projects", "p1"), { projectId: "p1", cacheRoot: join(base, "cache") });
    expect(io.spoolPollMs).toBeGreaterThanOrEqual(2_000);
  });

  it("reads, writes, lists and removes project files through the bridge", async () => {
    const io = new RemoteProjectIO(bridge, join(root, "projects", "p1"), { projectId: "p1", cacheRoot: join(base, "cache") });
    await expect(io.readText("notes/a.txt")).resolves.toBeNull();
    await io.writeTextAtomic("notes/a.txt", "hello\n");
    await expect(io.readText("notes/a.txt")).resolves.toBe("hello\n");
    await expect(io.exists("notes/a.txt")).resolves.toBe(true);
    await expect(io.readdir("notes")).resolves.toEqual(["a.txt"]);
    await io.remove("notes/a.txt");
    await expect(io.exists("notes/a.txt")).resolves.toBe(false);
    await expect(io.readText("notes/a.txt")).resolves.toBeNull();
  });

  // The test gateway runs on this host and executes POSIX commands; the real gateway runs only in the Linux workspace pod.
  it.skipIf(process.platform === "win32")("caches host copies and downloads again only when the remote checksum changes", async () => {
    const io = new RemoteProjectIO(bridge, join(root, "projects", "p1"), { projectId: "p1", cacheRoot: join(base, "cache") });
    const first = join(base, "first.step");
    await writeFile(first, "solid one");
    await io.copyIn(first, "models/m.step");

    const download = vi.spyOn(bridge, "download");
    const hostPath = await io.toHostPath("models/m.step");
    expect(hostPath).toBe(join(base, "cache", "p1", "models", "m.step"));
    expect(await readFile(hostPath, "utf8")).toBe("solid one");
    expect(download).toHaveBeenCalledTimes(1);

    await expect(io.toHostPath("models/m.step")).resolves.toBe(hostPath);
    expect(download).toHaveBeenCalledTimes(1);

    const second = join(base, "second.step");
    await writeFile(second, "solid two");
    await io.copyIn(second, "models/m.step");
    await io.toHostPath("models/m.step");
    expect(download).toHaveBeenCalledTimes(2);
    expect(await readFile(hostPath, "utf8")).toBe("solid two");
  });
});
