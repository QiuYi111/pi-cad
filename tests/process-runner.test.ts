import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ProcessConcurrencyGate, runProcess } from "../src/shared/process-runner.ts";

test("process runner bounds captured output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-process-output-"));
  try {
    const result = await runProcess({
      command: "/bin/bash",
      args: ["-lc", "printf %05000d 0; printf %05000d 0 >&2"],
      cwd,
      timeoutMs: 2_000,
      maxStdoutBytes: 128,
      maxStderrBytes: 96,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.byteLength(result.stdout), 128);
    assert.equal(Buffer.byteLength(result.stderr), 96);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("process runner terminates a process group on timeout and abort", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-process-stop-"));
  try {
    const timed = await runProcess({ command: "/bin/bash", args: ["-lc", "sleep 30 & wait"], cwd, timeoutMs: 40 });
    assert.equal(timed.terminationReason, "timeout");
    assert.ok(timed.durationMs < 2_000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const aborted = await runProcess({ command: "/bin/bash", args: ["-lc", "sleep 30 & wait"], cwd, timeoutMs: 5_000, signal: controller.signal });
    assert.equal(aborted.terminationReason, "aborted");
    assert.ok(aborted.durationMs < 2_000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("process runner enforces bounded concurrency", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-process-gate-"));
  const gate = new ProcessConcurrencyGate(2);
  try {
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 4 }, () => runProcess({
      command: "/bin/bash",
      args: ["-lc", "sleep 0.08"],
      cwd,
      timeoutMs: 2_000,
      gate,
    })));
    assert.ok(results.every((result) => result.exitCode === 0));
    assert.equal(gate.snapshot.peak, 2);
    assert.equal(gate.snapshot.active, 0);
    assert.ok(Date.now() - started >= 130, "four jobs must execute in two bounded waves");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
