import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTokenVerifier, startGateway, type Gateway } from "../src/index.js";
import { TestClient } from "./client.js";

const WORKSPACE = "ws-test";
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

let base: string;
let root: string;
let readOnly: string;
let gateway: Gateway;
let url: string;
let privateKey: CryptoKey;
let token: string;
let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
const clients: TestClient[] = [];

function sign(workspace: string, key: CryptoKey = privateKey): Promise<string> {
  return new SignJWT({ ws: workspace })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject("user-1")
    .setAudience("ws-gateway")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(key);
}

async function connect(tokenValue = token) {
  const client = await TestClient.connect(url, tokenValue);
  clients.push(client);
  return client;
}

async function exists(path: string) {
  return access(path).then(() => true, () => false);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "reify-gw-"));
  root = join(base, "workspace");
  readOnly = join(base, "opt-reify");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(readOnly, { recursive: true });
  await writeFile(join(readOnly, "lib.txt"), "library");
  await writeFile(join(base, "outside.txt"), "outside");

  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  token = await sign(WORKSPACE);
  exit = vi.fn();
  gateway = await startGateway({
    port: 0,
    workspaceRoot: root,
    readOnlyRoots: [readOnly],
    verifyToken: await createTokenVerifier({ publicKeyPem: await exportSPKI(pair.publicKey), workspaceName: WORKSPACE }),
    exit,
    shutdownTimeoutMs: 2000,
  });
  url = `ws://127.0.0.1:${gateway.port}/`;
});

afterAll(async () => {
  for (const client of clients) client.close();
  await gateway?.close();
  await rm(base, { recursive: true, force: true });
});

describe("workspace gateway", () => {
  it("serves /healthz", async () => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects missing, foreign-workspace and foreign-key tokens with 401", async () => {
    await expect(connect("not-a-jwt")).rejects.toThrow("HTTP 401");
    await expect(connect(await sign("other-workspace"))).rejects.toThrow("HTTP 401");
    const stranger = await generateKeyPair("ES256");
    await expect(connect(await sign(WORKSPACE, stranger.privateKey))).rejects.toThrow("HTTP 401");
  });

  it("answers ping", async () => {
    const client = await connect();
    client.send({ type: "ping" });
    await client.waitFor("pong");
  });

  it("passes exec env to the command", async () => {
    const client = await connect();
    client.send({ type: "exec", ch: 5, args: ["sh", "-c", "printf %s \"$REIFY_TEST_VALUE\""], env: { REIFY_TEST_VALUE: "from-exec-env" } });
    expect(await client.waitFor("exec_result", 5)).toMatchObject({ stdout: "from-exec-env", code: 0 });
  });

  it("reports non-zero exec exit codes in exec_result", async () => {
    const client = await connect();
    client.send({ type: "exec", ch: 2, args: ["sh", "-c", "echo oops >&2; exit 3"] });
    expect(await client.waitFor("exec_result", 2)).toMatchObject({ stderr: "oops\n", code: 3 });
  });

  it("spawns cat, writes stdin, reads stdout, then ends stdin", async () => {
    const client = await connect();
    client.send({ type: "spawn", ch: 1, args: ["cat"] });
    await client.waitFor("spawned", 1);
    client.sendBytes(1, "hello bridge\n");
    await client.waitForBytes(1, "hello bridge\n");
    client.send({ type: "stdin_end", ch: 1 });
    expect(await client.waitForExit(1)).toMatchObject({ code: 0, signal: null });
  });

  it("reports a missing executable as an error and then an exit", async () => {
    const client = await connect();
    client.send({ type: "spawn", ch: 30, args: ["reify-no-such-binary"] });
    expect(await client.waitFor("error", 30)).toMatchObject({ code: "failed" });
    expect(await client.waitForExit(30)).toMatchObject({ code: null });
  });

  it("keeps a spawn alive across disconnect and replays output on attach", async () => {
    const first = await connect();
    first.send({ type: "spawn", ch: 3, args: ["sh", "-c", "sleep 1; echo late"] });
    const spawned = await first.waitFor("spawned", 3);
    first.close();

    const second = await connect();
    second.send({ type: "attach", ch: 9, spawnId: spawned.spawnId });
    await second.waitForBytes(9, "late\n");
    expect(await second.waitForExit(9)).toMatchObject({ code: 0 });
  });

  it("replays an exited spawn on attach, stdout and stderr on their channels", async () => {
    const client = await connect();
    client.send({ type: "spawn", ch: 4, args: ["sh", "-c", "echo done; echo warn >&2"] });
    const spawned = await client.waitFor("spawned", 4);
    await client.waitForExit(4);
    client.send({ type: "attach", ch: 14, spawnId: spawned.spawnId });
    await client.waitForBytes(14, "done\n");
    await client.waitForBytes(15, "warn\n");
    expect(await client.waitForExit(14)).toMatchObject({ code: 0 });
  });

  it("reports a running spawn to the activity monitor", async () => {
    const client = await connect();
    client.send({ type: "spawn", ch: 5, args: ["sleep", "30"] });
    await client.waitFor("spawned", 5);
    expect(gateway.monitor.snapshot()).toEqual({ active: true, reason: "process" });
    client.send({ type: "kill", ch: 5, signal: "SIGKILL" });
    expect(await client.waitForExit(5)).toMatchObject({ signal: "SIGKILL" });
  });

  it("uploads a file, verifies it, and reads the same bytes back", async () => {
    const client = await connect();
    const data = Buffer.from("payload bytes\n");
    client.send({ type: "file_put_begin", ch: 6, path: "sub/good.bin", size: data.length, sha256: sha256(data) });
    client.sendBytes(6, data);
    client.send({ type: "file_put_end", ch: 6 });
    await client.waitFor("file_put_done", 6);
    expect(await readFile(join(root, "sub", "good.bin"))).toEqual(data);
    expect(await exists(join(root, "sub", "good.bin.tmp"))).toBe(false);

    client.send({ type: "file_get", ch: 7, path: "sub/good.bin" });
    expect(await client.waitFor("file_end", 7)).toMatchObject({ size: data.length, sha256: sha256(data) });
    expect(client.bytes(7)).toBe(data.toString());
  });

  it("leaves no file behind when the upload sha256 is wrong", async () => {
    const client = await connect();
    const data = Buffer.from("tampered");
    client.send({ type: "file_put_begin", ch: 8, path: "sub/bad.bin", size: data.length, sha256: sha256("original") });
    client.sendBytes(8, data);
    client.send({ type: "file_put_end", ch: 8 });
    expect(await client.waitFor("error", 8)).toMatchObject({ code: "checksum_mismatch" });
    expect(await exists(join(root, "sub", "bad.bin"))).toBe(false);
    expect(await exists(join(root, "sub", "bad.bin.tmp"))).toBe(false);
  });

  it("rejects paths that escape the workspace", async () => {
    const client = await connect();
    client.send({ type: "file_get", ch: 10, path: "../outside.txt" });
    expect(await client.waitFor("error", 10)).toMatchObject({ code: "outside_workspace" });
  });

  it("rejects writes into read-only roots but allows reads", async () => {
    const client = await connect();
    client.send({ type: "file_put_begin", ch: 11, path: join(readOnly, "lib.txt"), size: 1, sha256: sha256("x") });
    expect(await client.waitFor("error", 11)).toMatchObject({ code: "read_only" });
    expect(await readFile(join(readOnly, "lib.txt"), "utf8")).toBe("library");

    client.send({ type: "file_get", ch: 12, path: join(readOnly, "lib.txt") });
    await client.waitFor("file_end", 12);
    expect(client.bytes(12)).toBe("library");
  });

  it("shutdown terminates running spawns and then calls exit", async () => {
    const client = await connect();
    client.send({ type: "spawn", ch: 20, args: ["sleep", "30"] });
    await client.waitFor("spawned", 20);
    client.send({ type: "shutdown" });
    expect(await client.waitForExit(20)).toMatchObject({ signal: "SIGTERM" });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 5000 });
  });
});
