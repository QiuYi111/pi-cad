import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PartOpError, runPartCommand, shutdownPartWorkers } from "../src/shared/freecad-worker.ts";

const fakeWorker = new URL("./fixtures/freecad-fake-worker/worker.mjs", import.meta.url).pathname;

async function withFakeRuntime(run: (cwd: string) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-cad-fake-freecad-"));
  const python = join(root, "bin", "python");
  const saved = new Map<string, string | undefined>();
  const set = (key: string, value: string | undefined) => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  try {
    await import("node:fs/promises").then((fs) => fs.mkdir(join(root, "bin"), { recursive: true }));
    await writeFile(python, `#!/bin/sh\nexec "${process.execPath}" "${fakeWorker}"\n`);
    await chmod(python, 0o755);
    set("PI_CAD_FREECAD_PYTHON", python);
    set("PI_CAD_PART_KILL_GRACE_S", "0.1");
    for (const [key, value] of Object.entries(env)) set(key, value);
    await run(root);
  } finally {
    shutdownPartWorkers();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("requests to one worker run one at a time, in order", async () => {
  await withFakeRuntime(async (cwd) => {
    const doc = join(cwd, "a.FCStd");
    const results = await Promise.all([
      runPartCommand(cwd, { op: "echo", doc, args: { tag: "first", ms: 120 } }),
      runPartCommand(cwd, { op: "echo", doc, args: { tag: "second", ms: 10 } }),
      runPartCommand(cwd, { op: "echo", doc, args: { tag: "third", ms: 10 } }),
    ]) as Array<{ pid: number; started: number; finished: number; tag: string }>;
    assert.deepEqual(results.map((item) => item.tag), ["first", "second", "third"]);
    assert.equal(new Set(results.map((item) => item.pid)).size, 1, "one worker serves the project");
    assert.ok(results[1]!.started >= results[0]!.finished, "second waits for first");
    assert.ok(results[2]!.started >= results[1]!.finished, "third waits for second");
  });
});

test("worker errors keep their code, target, detail, hints and rollback flag", async () => {
  await withFakeRuntime(async (cwd) => {
    const doc = join(cwd, "a.FCStd");
    await assert.rejects(runPartCommand(cwd, { op: "fail", doc, args: {} }), (error: unknown) => {
      assert.ok(error instanceof PartOpError);
      assert.equal(error.code, "FILLET_FAILED");
      assert.equal(error.target, "bracket/edge");
      assert.deepEqual(error.detail, { failedOpIndex: 1 });
      assert.deepEqual(error.hints, ["reduce radius"]);
      assert.equal(error.rolledBack, true);
      return true;
    });
    // The worker is still alive after an error response.
    const alive = await runPartCommand(cwd, { op: "echo", doc, args: { tag: "after" } }) as { tag: string };
    assert.equal(alive.tag, "after");
  });
});

test("a request over budget kills the worker; the next request restarts it and reopens the document", async () => {
  await withFakeRuntime(async (cwd) => {
    const doc = join(cwd, "a.FCStd");
    const opened = await runPartCommand(cwd, { op: "open", doc, args: { output: "x.step", create: true } }) as { pid: number };
    await assert.rejects(runPartCommand(cwd, { op: "echo", doc, args: { ms: 5000 }, budgetS: 0.1 }), (error: unknown) => {
      assert.ok(error instanceof PartOpError);
      assert.equal(error.code, "BUDGET_EXCEEDED");
      assert.equal((error.detail as { budgetS: number }).budgetS, 0.1);
      assert.ok(error.hints?.includes("increase budget_s"));
      return true;
    });
    const next = await runPartCommand(cwd, { op: "echo", doc, args: { tag: "again" } }) as { pid: number; reopened: boolean };
    assert.notEqual(next.pid, opened.pid, "a new worker process");
    assert.equal(next.reopened, true, "the document was reopened from disk before the request");
  });
});

test("an unexpected worker exit rejects the request with FREECAD_WORKER_RESTARTED and the next one works", async () => {
  await withFakeRuntime(async (cwd) => {
    const doc = join(cwd, "a.FCStd");
    await assert.rejects(runPartCommand(cwd, { op: "crash", doc }), (error: unknown) => {
      assert.ok(error instanceof PartOpError);
      assert.equal(error.code, "FREECAD_WORKER_RESTARTED");
      assert.match(String((error.detail as { stderrTail: string }).stderrTail), /about to crash/);
      return true;
    });
    const next = await runPartCommand(cwd, { op: "echo", doc, args: { tag: "ok" } }) as { tag: string };
    assert.equal(next.tag, "ok");
  });
});

test("an aborted request stops the worker and reports CANCELLED", async () => {
  await withFakeRuntime(async (cwd) => {
    const doc = join(cwd, "a.FCStd");
    const controller = new AbortController();
    const pending = runPartCommand(cwd, { op: "echo", doc, args: { ms: 5000 }, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, (error: unknown) => error instanceof PartOpError && error.code === "CANCELLED");
    const next = await runPartCommand(cwd, { op: "echo", doc, args: { tag: "after-cancel" } }) as { tag: string };
    assert.equal(next.tag, "after-cancel");
  });
});

test("a budget over the configured limit is refused before the worker sees it", async () => {
  await withFakeRuntime(async (cwd) => {
    await assert.rejects(runPartCommand(cwd, { op: "echo", doc: join(cwd, "a.FCStd"), budgetS: 60 }), (error: unknown) => {
      assert.ok(error instanceof PartOpError);
      assert.equal(error.code, "BUDGET_EXCEEDS_LIMIT");
      assert.deepEqual({ budgetS: (error.detail as any).budgetS, limitS: (error.detail as any).limitS }, { budgetS: 60, limitS: 10 });
      return true;
    });
  }, { PI_CAD_PART_MAX_BUDGET_S: "10" });
});

test("without FreeCAD installed the error says how to install it", async () => {
  const previous = { python: process.env.PI_CAD_FREECAD_PYTHON, home: process.env.PI_CAD_FREECAD_HOME };
  delete process.env.PI_CAD_FREECAD_PYTHON;
  process.env.PI_CAD_FREECAD_HOME = join(tmpdir(), "pi-cad-no-such-freecad-home");
  try {
    await assert.rejects(runPartCommand(tmpdir(), { op: "tree", doc: "/tmp/x.FCStd" }), (error: unknown) => {
      assert.ok(error instanceof PartOpError);
      assert.equal(error.code, "FREECAD_NOT_INSTALLED");
      assert.deepEqual(error.hints, ["run: npm run setup:freecad"]);
      assert.ok(Array.isArray((error.detail as { searched: unknown[] }).searched));
      return true;
    });
  } finally {
    if (previous.python === undefined) delete process.env.PI_CAD_FREECAD_PYTHON; else process.env.PI_CAD_FREECAD_PYTHON = previous.python;
    if (previous.home === undefined) delete process.env.PI_CAD_FREECAD_HOME; else process.env.PI_CAD_FREECAD_HOME = previous.home;
  }
});

test("a bridge with no memory of a document opens an existing file on first use", async () => {
  await withFakeRuntime(async (cwd) => {
    const doc = join(cwd, "existing.FCStd");
    await writeFile(doc, "not a real document; the fake worker does not read it");
    // No `open` was ever sent: this is a fresh sidecar process after a restart.
    const result = await runPartCommand(cwd, {
      op: "echo", doc, args: { tag: "first" }, ensureOpen: { output: join(cwd, "x.step"), historyDir: join(cwd, "h"), create: false },
    }) as { reopened: boolean };
    assert.equal(result.reopened, true, "the document was opened before the request ran");
    // A document that does not exist is not opened for the caller: the worker's own error stands.
    const missing = await runPartCommand(cwd, {
      op: "echo", doc: join(cwd, "missing.FCStd"), args: {}, ensureOpen: { output: join(cwd, "x.step"), historyDir: join(cwd, "h"), create: false },
    }) as { reopened: boolean };
    assert.equal(missing.reopened, false);
  });
});
