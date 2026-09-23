import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const project = resolve(import.meta.dirname, "..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent"));
const fixture = mkdtempSync(join(tmpdir(), "pi-cad-prime-kernel-smoke-"));
const dataHome = join(fixture, "authority-data");
const projectKey = createHash("sha256").update(realpathSync(fixture)).digest("hex");
const canonicalProject = join(dataHome, "pi-cad", projectKey);
copyFileSync(join(project, "tests/fixtures/prime-faux-kernel-env-extension.ts"), join(fixture, "prime-faux-kernel-env-extension.ts"));

const run = spawnSync(process.execPath, [
  join(project, "scripts/prime-cad-sidecar.mjs"),
  "--extension", "/workspace/prime-faux-kernel-env-extension.ts",
  "--provider", "faux", "--model", "faux", "--mode", "json",
  "--print", "Run the Prime kernel environment smoke.",
], {
  cwd: project,
  encoding: "utf8",
  timeout: 180_000,
  maxBuffer: 16 * 1024 * 1024,
  env: {
    ...process.env,
    PRIME_AGENT_REPO: primeRoot,
    PRIME_AGENT_CODING_AGENT_DIR: join(fixture, "prime-agent"),
    PRIME_AGENT_KERNEL_VENV: process.env.PRIME_AGENT_KERNEL_VENV ?? join(fixture, "kernel-venv"),
    PRIME_AGENT_SESSION_DIR: join(fixture, "sessions"),
    PI_OFFLINE: "0",
    PI_CAD_PROJECT_CWD: fixture,
    PI_CAD_REPO: project,
    XDG_DATA_HOME: dataHome,
  },
});

try {
  const diagnostic = `${run.stderr}\n${run.stdout}`;
  assert.notEqual(run.signal, "SIGTERM", `Prime kernel smoke timed out\n${diagnostic.slice(-10000)}`);
  assert.equal(run.status, 42, `workflow should stay incomplete after the smoke call\n${diagnostic.slice(-10000)}`);
  const resultPath = join(fixture, "kernel-preflight-result.json");
  assert.ok(existsSync(resultPath), `Prime did not finish a real kernel/CAD call\n${diagnostic.slice(-10000)}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(result.prefix, "/opt/prime-kernel-venv");
  assert.match(result.executable, /\/opt\/prime-kernel-venv\/bin\/python/);
  for (const module of ["pydantic", "rlm", "ipykernel"]) {
    assert.match(result.modules[module], new RegExp(`/opt/prime-kernel-venv/lib/.*/site-packages/${module}`));
  }
  assert.ok(result.sys_path.some((path) => /^\/opt\/prime-kernel-venv\/lib\/python\d+\.\d+\/site-packages$/.test(path)));
  assert.ok(result.workflow?.runId, "CAD call must create a canonical workflow run");
  const canonicalRun = join(canonicalProject, "runs", result.workflow.runId, "state.json");
  assert.ok(existsSync(canonicalRun), `canonical run state missing: ${canonicalRun}`);
  assert.ok((diagnostic.match(/PRIME_KERNEL_PROVENANCE/g) ?? []).length >= 2, "host and sandbox Python provenance must be logged");
  assert.match(diagnostic, /"primeSha": "[a-f0-9]{40}"/);
  assert.match(diagnostic, /"piCadSha": "[a-f0-9]{40}"/);
  assert.match(diagnostic, /"venv": "\/opt\/prime-kernel-venv"/);
  assert.match(diagnostic, /"prefix": "\/opt\/prime-kernel-venv"/);
  assert.match(diagnostic, /PRIME_KERNEL_IMPORTS .*"pydantic": "[^\"]+"/);
  console.log("Prime inline kernel imported pydantic from its declared venv and created a canonical CAD run.");
} finally {
  if (run.status === 42 && existsSync(join(fixture, "kernel-preflight-result.json"))) rmSync(fixture, { recursive: true, force: true });
  else console.error(`Prime kernel smoke artifacts kept at ${fixture}`);
}
