import assert from "node:assert/strict";
import { test } from "node:test";

import { runWarmCadctl, shutdownWarmCadctlWorkers, type WarmCadctlLaunch, type WarmCadctlRequest } from "../src/shared/cadctl-worker.ts";

const fakeWorker = new URL("./fixtures/cadctl-fake-worker/worker.mjs", import.meta.url).pathname;

const launch: WarmCadctlLaunch = {
  key: `cadctl-restart-test\0${fakeWorker}`,
  command: process.execPath,
  args: [fakeWorker],
  cwd: process.cwd(),
  env: { ...process.env },
};

function request(args: string[], timeoutMs = 10_000): WarmCadctlRequest {
  return { args, cwd: process.cwd(), timeoutMs, maxStdoutBytes: 1 << 20, maxStderrBytes: 1 << 20 };
}

async function pidOf(args: string[]): Promise<number> {
  const result = await runWarmCadctl(launch, request(args));
  return (JSON.parse(result.stdout) as { pid: number }).pid;
}

test("a cadctl worker killed mid-request rejects that request, and the next request starts a new worker", async () => {
  try {
    const before = await pidOf(["inspect"]);
    const pending = runWarmCadctl(launch, request(["hang"]));
    // Let the request reach the child before killing it.
    await new Promise((done) => setTimeout(done, 100));
    process.kill(before, "SIGKILL");
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cadctl worker exited with SIGKILL/);
      return true;
    });
    const after = await pidOf(["inspect"]);
    assert.notEqual(after, before, "a new worker process serves the next request");
  } finally {
    shutdownWarmCadctlWorkers();
  }
});

test("a cadctl request over its timeout stops the worker, and the next request restarts it", async () => {
  try {
    const before = await pidOf(["inspect"]);
    await assert.rejects(runWarmCadctl(launch, request(["hang"], 100)), /cadctl worker timed out after 100ms/);
    const after = await pidOf(["inspect"]);
    assert.notEqual(after, before, "a new worker process serves the next request");
  } finally {
    shutdownWarmCadctlWorkers();
  }
});
