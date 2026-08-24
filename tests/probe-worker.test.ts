import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { inspectGeometry, persistentProbeWorkerStatus, stopPersistentProbeWorker } from "../src/shared/capability.ts";

test("persistent probe worker reuses one Python interpreter for read-only cadctl calls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-probe-worker-"));
  const previous = process.env.PI_CAD_PROBE_WORKER;
  try {
    process.env.PI_CAD_PROBE_WORKER = "1";
    stopPersistentProbeWorker();
    const artifact = resolve("tests/fixtures/interference_single.step");
    const first = await inspectGeometry(cwd, artifact, join(cwd, ".pi-cad", "test", "first.json"), 60_000);
    const firstStatus = persistentProbeWorkerStatus();
    const second = await inspectGeometry(cwd, artifact, join(cwd, ".pi-cad", "test", "second.json"), 60_000);
    const secondStatus = persistentProbeWorkerStatus();
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(firstStatus.running, true);
    assert.equal(secondStatus.pid, firstStatus.pid);
    assert.equal(secondStatus.requests, 2);
  } finally {
    stopPersistentProbeWorker();
    if (previous === undefined) delete process.env.PI_CAD_PROBE_WORKER;
    else process.env.PI_CAD_PROBE_WORKER = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
