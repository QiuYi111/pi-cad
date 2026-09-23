import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const project = resolve(import.meta.dirname, "..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent"));
const fixture = mkdtempSync(join(tmpdir(), "pi-cad-desktop-kernel-smoke-"));
const dataHome = join(fixture, "authority-data");
const projectKey = createHash("sha256").update(realpathSync(fixture)).digest("hex");
const canonicalProject = join(dataHome, "pi-cad", projectKey);
copyFileSync(join(project, "tests/fixtures/prime-faux-kernel-env-extension.ts"), join(fixture, "prime-faux-kernel-env-extension.ts"));

const child = spawn(process.execPath, [
  join(project, "scripts/prime-cad-sidecar.mjs"),
  "--extension", "/workspace/prime-faux-kernel-env-extension.ts",
  "--provider", "faux", "--model", "faux", "--mode", "rpc",
], {
  cwd: project,
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
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let stderr = "";
let sequence = 0;
const pending = new Map();
let exited = false;
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      const entry = pending.get(record.id);
      if (record.type === "response" && entry) {
        clearTimeout(entry.timer);
        pending.delete(record.id);
        record.success ? entry.resolve(record.data) : entry.reject(new Error(record.error || "Prime RPC request failed"));
      }
    } catch (error) {
      stderr = `${stderr}\n${error}\n${line}`.slice(-12000);
    }
  }
});
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
child.once("exit", () => { exited = true; });

function request(type, payload = {}, timeoutMs = 60_000) {
  if (exited || !child.stdin.writable) return Promise.reject(new Error(`Prime RPC exited early\n${stderr}`));
  const id = `kernel-env-${++sequence}`;
  return new Promise((resolveResponse, rejectResponse) => {
    const timer = setTimeout(() => { pending.delete(id); rejectResponse(new Error(`Prime RPC ${type} timed out\n${stderr}`)); }, timeoutMs);
    pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  });
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
let success = false;
try {
  const state = await request("get_state");
  assert.ok(state?.sessionId, "Desktop RPC must open a Prime conversation");
  await request("prompt", { message: "Run the Prime kernel environment smoke." }, 180_000);
  const resultPath = join(fixture, "kernel-preflight-result.json");
  const deadline = Date.now() + 90_000;
  while (!existsSync(resultPath) && Date.now() < deadline) await delay(100);
  assert.ok(existsSync(resultPath), `Desktop RPC did not finish a real kernel/CAD call\n${stderr}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(result.prefix, "/opt/prime-kernel-venv");
  assert.match(result.executable, /\/opt\/prime-kernel-venv\/bin\/python/);
  for (const module of ["pydantic", "rlm", "ipykernel"]) {
    assert.match(result.modules[module], new RegExp(`/opt/prime-kernel-venv/lib/.*/site-packages/${module}`));
  }
  assert.ok(result.sys_path.some((path) => /^\/opt\/prime-kernel-venv\/lib\/python\d+\.\d+\/site-packages$/.test(path)));
  assert.ok(result.workflow?.runId, "Desktop RPC CAD call must create a canonical workflow run");
  assert.ok(existsSync(join(canonicalProject, "runs", result.workflow.runId, "state.json")));
  assert.ok((stderr.match(/PRIME_KERNEL_PROVENANCE/g) ?? []).length >= 2, "host and sandbox Python provenance must be logged");
  assert.match(stderr, /"primeSha": "[a-f0-9]{40}"/);
  assert.match(stderr, /"piCadSha": "[a-f0-9]{40}"/);
  assert.match(stderr, /"venv": "\/opt\/prime-kernel-venv"/);
  assert.match(stderr, /"prefix": "\/opt\/prime-kernel-venv"/);
  assert.match(stderr, /PRIME_KERNEL_IMPORTS .*"pydantic": "[^"]+"/);
  success = true;
  console.log("Desktop RPC kernel imported pydantic from its declared venv and created a canonical CAD run.");
} finally {
  child.stdin.end();
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(10_000)]);
  if (!exited) child.kill("SIGTERM");
  if (success) rmSync(fixture, { recursive: true, force: true });
  else console.error(`Desktop RPC smoke artifacts kept at ${fixture}\n${stderr}`);
}
