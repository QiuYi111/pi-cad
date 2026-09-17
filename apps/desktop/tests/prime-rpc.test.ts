import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ensureRuntimeReady, PrimeRpc, sandboxSessionPath } from "../electron/main/prime-rpc";
import type { AppSettings, RuntimeStatus } from "../src/shared/contracts";

const settings: AppSettings = {
  distro: "Ubuntu", projectPath: "/workspace", piCadRepo: "", primeAgentRepo: "",
  provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal", permission: "workspace",
  reviewer: { mode: "inherit" },
};

const ready: RuntimeStatus = { state: "idle", checks: [
  { id: "prime", label: "Prime Agent", status: "ready", detail: "ready", installable: true },
] };

/** Minimal Prime RPC stand-in: reads JSONL commands and writes JSONL records. */
function createFakePrime(onRequest?: (record: any, context: { reply: (value: any) => void; emit: (event: any) => void }) => void) {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit("exit", null, "SIGTERM"); return true; };
  const emit = (event: any) => { child.stdout.write(`${JSON.stringify(event)}\n`); };
  const reply = (value: any) => { child.stdout.write(`${JSON.stringify(value)}\n`); };
  const records: any[] = [];
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      records.push(record);
      onRequest?.(record, { reply, emit });
    }
  });
  return { child, records, emit, reply };
}

function runtimeFrom(fake: { child: any }, options: { abortConfirmTimeoutMs?: number; processStopGraceMs?: number } = {}) {
  const pipe = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const bridge = {
    check: vi.fn().mockResolvedValue(ready),
    install: vi.fn(),
    resolveRuntimePaths: vi.fn().mockResolvedValue({ piCadRepo: "/runtime/pi-cad", primeAgentRepo: "/runtime/prime-agent", projectPath: "/workspace/demo" }),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    homeDirectory: vi.fn().mockResolvedValue("/home/tester"),
    commandPath: vi.fn().mockResolvedValue("/usr/bin/node"),
    spawn: vi.fn(() => fake.child),
    pipe,
  };
  return { runtime: new PrimeRpc(bridge as any, options), pipe };
}

const delay = (ms: number) => new Promise((accept) => setTimeout(accept, ms));

describe("Prime runtime setup", () => {
  it("maps host session files into the sandbox workspace", () => {
    expect(sandboxSessionPath("C:\\project\\.prime-sessions\\abc-123.jsonl"))
      .toBe("/workspace/.prime-sessions/abc-123.jsonl");
    expect(() => sandboxSessionPath("../escape.txt")).toThrow("Invalid session path");
  });
  it("recovers the first prompt after abort through Prime steering", async () => {
    const runtime = new PrimeRpc({} as never);
    const request = vi.spyOn(runtime, "request")
      .mockRejectedValueOnce(new Error("Cannot admit a session action while queued session input is suspended."))
      .mockResolvedValueOnce(undefined);
    await expect(runtime.prompt("continue")).resolves.toBeUndefined();
    expect(request.mock.calls.map(([type]) => type)).toEqual(["prompt", "steer"]);
  });
  it("sets a bounded normalized automatic session name", async () => {
    const runtime = new PrimeRpc({} as never);
    const request = vi.spyOn(runtime, "request").mockResolvedValue(undefined);
    await runtime.setSessionName(`  折叠   手机支架 ${"长".repeat(100)}  `);
    const [, payload] = request.mock.calls[0]!;
    expect(request.mock.calls[0]![0]).toBe("set_session_name");
    expect(payload.name).toHaveLength(80);
    expect(payload.name.startsWith("折叠 手机支架 ")).toBe(true);
  });
  it("restores a saved session directly when Prime is stopped", async () => {
    const runtime = new PrimeRpc({} as never);
    const start = vi.spyOn(runtime, "start").mockResolvedValue({ state: "ready", checks: [], sessionId: "saved" });
    const messages = vi.spyOn(runtime, "getMessages").mockResolvedValue([{ role: "user", text: "saved" }]);
    const request = vi.spyOn(runtime, "request");
    const path = "C:\\project\\.prime-sessions\\saved.jsonl";
    await expect(runtime.switchSession(path, settings)).resolves.toEqual([{ role: "user", text: "saved" }]);
    expect(start).toHaveBeenCalledWith(settings, path);
    expect(messages).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalledWith("switch_session", expect.anything());
  });
  it("uses an existing runtime without reinstalling", async () => {
    const bridge = { check: vi.fn().mockResolvedValue(ready), install: vi.fn() };
    await expect(ensureRuntimeReady(bridge as any, settings)).resolves.toEqual(ready);
    expect(bridge.install).not.toHaveBeenCalled();
  });

  it("installs a missing bundled runtime before Prime starts", async () => {
    const missing: RuntimeStatus = { state: "error", checks: [
      { id: "prime", label: "Prime Agent", status: "missing", detail: "missing", installable: true },
    ] };
    const bridge = { check: vi.fn().mockResolvedValue(missing), install: vi.fn().mockResolvedValue(ready) };
    await expect(ensureRuntimeReady(bridge as any, settings)).resolves.toEqual(ready);
    expect(bridge.install).toHaveBeenCalledOnce();
  });

  it("rejects a missing saved project before spawning Prime", async () => {
    const spawn = vi.fn(() => { throw new Error("spawned missing project"); });
    const bridge = {
      check: vi.fn().mockResolvedValue(ready),
      install: vi.fn(),
      resolveRuntimePaths: vi.fn().mockResolvedValue({
        piCadRepo: "/runtime/pi-cad",
        primeAgentRepo: "/runtime/prime-agent",
        projectPath: "/tmp/deleted-project",
      }),
      exec: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      homeDirectory: vi.fn().mockResolvedValue("/home/tester"),
      commandPath: vi.fn().mockResolvedValue("/usr/bin/node"),
      spawn,
    };

    await expect(new PrimeRpc(bridge as any).start(settings))
      .rejects.toThrow("Project folder no longer exists");
    expect(bridge.exec).toHaveBeenCalledWith(["test", "-d", "/tmp/deleted-project"]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("Prime runtime turn state", () => {
  it("stays stopping until Prime really aborts, then reports aborted", async () => {
    const fake = createFakePrime((record, { reply, emit }) => {
      if (record.type === "get_state") reply({ type: "response", id: record.id, command: "get_state", success: true, data: { sessionId: "session-1" } });
      if (record.type === "abort") {
        reply({ type: "response", id: record.id, command: "abort", success: true });
        setTimeout(() => {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
          emit({ type: "agent_end", messages: [] });
        }, 20);
      }
    });
    const { runtime } = runtimeFrom(fake, { abortConfirmTimeoutMs: 500 });
    const statuses: string[] = [];
    runtime.on("status", (status: RuntimeStatus) => statuses.push(status.state));
    await runtime.start(settings);
    fake.emit({ type: "agent_start" });
    fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "weighing options" } });
    await delay(5);
    expect(runtime.status.state).toBe("running");

    const abort = runtime.abort();
    expect(runtime.status.state).toBe("stopping");
    expect(fake.records.map((record) => record.type)).toContain("abort");
    await abort;

    expect(runtime.status.state).toBe("aborted");
    expect(statuses.slice(statuses.lastIndexOf("stopping"))).toEqual(["stopping", "aborted"]);
    expect(runtime.status.turn).toMatchObject({ terminalReason: "aborted" });
    expect(runtime.status.turn?.abortRequestedAt).toBeDefined();
    expect(runtime.status.turn?.abortConfirmedAt).toBeDefined();
    expect(fake.child.killed).toBe(false);
  });

  it("escalates to a process stop when the runtime never confirms", async () => {
    const fake = createFakePrime((record, { reply }) => {
      if (record.type === "get_state") reply({ type: "response", id: record.id, command: "get_state", success: true, data: { sessionId: "session-1" } });
      if (record.type === "abort") reply({ type: "response", id: record.id, command: "abort", success: true });
    });
    const { runtime } = runtimeFrom(fake, { abortConfirmTimeoutMs: 30, processStopGraceMs: 30 });
    await runtime.start(settings);
    fake.emit({ type: "agent_start" });
    await delay(5);

    await runtime.abort();

    expect(fake.child.killed).toBe(true);
    expect(runtime.status.state).toBe("error");
  });

  it("journals turn states and retries into the project", async () => {
    const fake = createFakePrime((record, { reply }) => {
      if (record.type === "get_state") reply({ type: "response", id: record.id, command: "get_state", success: true, data: { sessionId: "session-1" } });
    });
    const { runtime, pipe } = runtimeFrom(fake, { abortConfirmTimeoutMs: 500 });
    await runtime.start(settings);
    fake.emit({ type: "agent_start" });
    fake.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "weighing options" } });
    fake.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: "529 overloaded_error" });
    await vi.waitFor(() => expect(pipe).toHaveBeenCalled());

    expect(pipe.mock.calls[0]![0].join(" ")).toContain(".pi-cad/desktop-runtime.jsonl");
    const entries = pipe.mock.calls.map((call) => JSON.parse(call[1] as string));
    expect(entries.map((entry) => entry.event)).toEqual([
      "lifecycle:starting",
      "lifecycle:ready",
      "turn_started",
      "agent_start",
      "first_provider_event",
      "message_update",
      "auto_retry_start",
    ]);
    expect(entries.at(-1)?.phase).toBe("retrying");
    expect(entries.at(-1)?.detail).toContain("attempt 1 of 3 in 2000ms");
  });
});
