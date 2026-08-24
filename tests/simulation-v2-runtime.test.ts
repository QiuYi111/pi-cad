import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { boundedFailure, classifyResourceFailure, managedLimitProperties, simulationRuntimeProjection, spawnLogged, validateRuntimeRegistry } from "../src/modules/simulate-v2/runtime.ts";

test("runtime registry exposes exact production backends and an explicit development CPU runtime", async () => {
  const projection = await simulationRuntimeProjection();
  assert.deepEqual(projection.map(({ backend, runtime, developmentOnly }) => ({ backend, runtime, ...(developmentOnly ? { developmentOnly } : {}) })), [
    { backend: "openfoam", runtime: "openfoam-14" },
    { backend: "su2", runtime: "su2-8.5.0" },
    { backend: "torch-fem", runtime: "torch-fem-0.9-cu126" },
    { backend: "torch-fem", runtime: "torch-fem-0.9-cpu", developmentOnly: true },
  ]);
  for (const item of projection) {
    assert.equal(item.agentCapabilities.pythonCommand, 'uv run --offline --frozen --project "$PI_CAD_PYTHON_PROJECT" python');
    assert.equal(item.agentCapabilities.network, "none");
    assert.ok(item.agentCapabilities.cookbookTemplateId);
  }
  const registry = validateRuntimeRegistry(JSON.parse(await readFile(join(process.cwd(), "assets", "simulation-runtimes.json"), "utf8")));
  const su2 = registry.find((item) => item.backend === "su2");
  assert.equal(su2?.kind, "archive");
  if (su2?.kind === "archive") {
    assert.equal(su2.archiveUrl, "https://github.com/su2code/SU2/releases/download/v8.5.0/SU2-v8.5.0-linux64-omp.zip");
    assert.equal(su2.sha256, "aadc800cd9df34deff99d4725f5897f620c9f2979f62ab235313311bf501f09b");
  }
});

test("runtime registry fails closed on unknown fields and duplicate identities", () => {
  const base = {
    schema: 2,
    runtimes: [{
      backend: "x", runtime: "r", kind: "uv", launcher: "bubblewrap", bootstrap: "setup.sh", network: "none",
      immutableRoots: ["/opt/x"], pythonProject: "/opt/x/project", expectedVersion: "1", environment: {}, accelerator: "cpu",
      probe: { script: "scripts/example-runtime-probe.py", args: ["--require", "cpu"], expected: { actualDevice: "cpu" } },
      limits: { cpu: 1, memoryGiB: 1, tasks: 1, wallHours: 1, workspaceGiB: 1 },
      agentCapabilities: { pythonCommand: 'uv run --offline --frozen --project "$PI_CAD_PYTHON_PROJECT" python', executables: ["python"], pythonModules: ["torch"], sandbox: "bubblewrap", network: "none", accelerator: "cpu", cookbookTemplateId: "test" },
    }],
  };
  assert.throws(() => validateRuntimeRegistry({ ...base, runtimes: [{ ...base.runtimes[0], typo: true }] }), /unknown runtime registration fields/);
  assert.throws(() => validateRuntimeRegistry({ ...base, runtimes: [base.runtimes[0], { ...base.runtimes[0] }] }), /duplicate simulation runtime/);
  assert.throws(() => validateRuntimeRegistry({ ...base, runtimes: [{ ...base.runtimes[0], probe: { ...base.runtimes[0].probe, typo: true } }] }), /strict probe declaration/);
});

test("uv runtime qualification is declared by the registry rather than solver code in the runner", async () => {
  const source = await readFile(join(process.cwd(), "src", "modules", "simulate-v2", "runtime.ts"), "utf8");
  assert.doesNotMatch(source, /import torch|import cupy|torch-fem=/);
  const registry = validateRuntimeRegistry(JSON.parse(await readFile(join(process.cwd(), "assets", "simulation-runtimes.json"), "utf8")));
  for (const runtime of registry) {
    if (runtime.kind !== "uv") continue;
    assert.ok(runtime.probe.script);
    assert.ok(Object.keys(runtime.probe.expected).length > 0);
  }
});

async function fixture(): Promise<{ cwd: string; stdoutPath: string; stderrPath: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-sim-runtime-"));
  const logs = join(cwd, "logs");
  await mkdir(logs, { recursive: true });
  return { cwd, stdoutPath: join(logs, "stdout.log"), stderrPath: join(logs, "stderr.log") };
}

test("managed runtime declares CPU, memory, task, and wall limits", () => {
  assert.deepEqual(managedLimitProperties({ cpu: 8, memoryGiB: 24, tasks: 1024, wallHours: 12, workspaceGiB: 100 }), [
    "CPUQuota=800%",
    "MemoryMax=24G",
    "TasksMax=1024",
    "RuntimeMaxSec=12h",
  ]);
});

test("timeout and disk quota terminate with bounded failure context", async () => {
  const timed = await fixture();
  try {
    const result = await spawnLogged({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: timed.cwd,
      stdoutPath: timed.stdoutPath,
      stderrPath: timed.stderrPath,
      timeoutMs: 40,
      env: process.env,
    });
    assert.equal(result.exitCode, 124);
    assert.match(result.diagnostics.join("\n"), /timeout after 40ms/);
    assert.ok(result.diagnostics.length <= 40);
    assert.ok(result.diagnostics.join("\n").length <= 8192);
  } finally {
    await rm(timed.cwd, { recursive: true, force: true });
  }

  const quota = await fixture();
  try {
    const result = await spawnLogged({
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('large.bin', Buffer.alloc(1024 * 1024)); setTimeout(() => {}, 10000)"],
      cwd: quota.cwd,
      stdoutPath: quota.stdoutPath,
      stderrPath: quota.stderrPath,
      timeoutMs: 5000,
      env: process.env,
      workspaceLimit: { path: quota.cwd, maxBytes: 1024 },
      quotaPollMs: 20,
    });
    assert.equal(result.exitCode, 122);
    assert.match(result.diagnostics.join("\n"), /workspace quota exceeded/);
    assert.ok(result.diagnostics.join("\n").length <= 8192);
  } finally {
    await rm(quota.cwd, { recursive: true, force: true });
  }
});

test("OOM, PID exhaustion, and large logs expose only bounded diagnostics", async () => {
  assert.equal(classifyResourceFailure("systemd: oom-kill: MemoryMax exceeded"), "memory limit exceeded");
  assert.equal(classifyResourceFailure("fork: Resource temporarily unavailable (TasksMax)"), "task/PID limit exceeded");
  for (const message of ["oom-kill: out of memory", "cannot fork: TasksMax exceeded"]) {
    const diagnostics = boundedFailure(`${"noise\n".repeat(10000)}${message}`, "");
    assert.ok(diagnostics.length <= 40);
    assert.ok(diagnostics.join("\n").length <= 8192);
  }

  const large = await fixture();
  try {
    const result = await spawnLogged({
      command: process.execPath,
      args: ["-e", "process.stdout.write('o'.repeat(2 * 1024 * 1024)); process.stderr.write('fatal: bounded-tail\\n' + 'e'.repeat(2 * 1024 * 1024)); process.exitCode=1"],
      cwd: large.cwd,
      stdoutPath: large.stdoutPath,
      stderrPath: large.stderrPath,
      timeoutMs: 5000,
      env: process.env,
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.length <= 8192);
    assert.ok(result.stderr.length <= 8192);
    assert.ok(result.diagnostics.length <= 40);
    assert.ok(result.diagnostics.join("\n").length <= 8192);
    assert.ok((await readFile(large.stdoutPath)).length >= 2 * 1024 * 1024, "full stdout must remain on disk");
    assert.ok((await readFile(large.stderrPath)).length >= 2 * 1024 * 1024, "full stderr must remain on disk");
  } finally {
    await rm(large.cwd, { recursive: true, force: true });
  }
});
