import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const project = resolve(import.meta.dirname, "..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent"));
const piCadSha = spawnSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const primeSha = spawnSync("git", ["-C", primeRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

const run = spawnSync(process.execPath, [
  resolve(project, "scripts/prime-cad-sidecar.mjs"),
  "--provider", "faux", "--model", "faux", "--mode", "json", "--print", "Do not start a kernel.",
], {
  cwd: project,
  encoding: "utf8",
  timeout: 30_000,
  env: {
    ...process.env,
    PRIME_AGENT_REPO: primeRoot,
    PRIME_AGENT_CODING_AGENT_DIR: resolve(project, ".scratch/res420/failure-agent"),
    PRIME_AGENT_KERNEL_VENV: "/proc/pi-cad-res420-kernel-venv",
    // Prime must ignore an unrelated Python override and report failure for
    // the explicitly declared venv instead of silently switching interpreters.
    PRIME_AGENT_KERNEL_PYTHON: "/usr/local/bin/python",
    PI_CAD_REPO: project,
  },
});

const diagnostic = `${run.stderr}\n${run.stdout}`;
assert.notEqual(run.status, 0, diagnostic);
assert.match(diagnostic, /PRIME_KERNEL_PROVENANCE_FAILURE/);
assert.match(diagnostic, new RegExp(`"primeSha"\\s*:\\s*"${primeSha}"`));
assert.match(diagnostic, new RegExp(`"piCadSha"\\s*:\\s*"${piCadSha}"`));
assert.match(diagnostic, /"venv"\s*:\s*"\/proc\/pi-cad-res420-kernel-venv"/);
assert.match(diagnostic, /"executable"\s*:\s*"\/proc\/pi-cad-res420-kernel-venv\/bin\/python"/);
assert.match(diagnostic, /"prefix"\s*:\s*"unavailable"/);
assert.match(diagnostic, /"stage"\s*:\s*"bootstrap"/);
assert.doesNotMatch(diagnostic, /PRIME_KERNEL_IMPORTS/);
console.log("Invalid declared kernel venv failed with provenance; no Python fallback was used.");
