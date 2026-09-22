#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [primeArg, mode] = process.argv.slice(2);
if (!primeArg) throw new Error("usage: prepare-prime-kernel.mjs <prime-root> [--check]");
const root = resolve(primeArg);
// This prepares Reify's managed venv, not an inherited external interpreter.
delete process.env.PRIME_AGENT_KERNEL_PYTHON;
const bootstrap = await import(pathToFileURL(join(root, "packages/coding-agent/dist/core/kernel/bootstrap.js")));
const skillApi = await import(pathToFileURL(join(root, "packages/coding-agent/dist/core/skills.js")));
const { skills } = skillApi.loadSkillsFromDir({ dir: join(root, "packages/coding-agent/dist/skills"), source: "bundled" });
const pythonSkills = skillApi.getPythonSkillRuntimeInfo(skills);
if (mode === "--check") {
  try {
    const venv = bootstrap.getKernelVenvDir();
    const stamp = JSON.parse(await readFile(join(venv, ".bootstrap-version"), "utf8"));
    if (stamp.runtime !== await bootstrap.resolveRuntimeIdentity()) throw new Error("Prime Python version differs from the bundled source");
    const check = spawnSync(bootstrap.kernelVenvPython(venv), ["-c", "import rlm, attach_image; assert callable(rlm.spawn); assert callable(rlm.host_request)"], { stdio: "ignore", timeout: 15_000 });
    if (check.status !== 0) throw new Error("Prime Python imports failed");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  await bootstrap.ensureKernelPython({ pythonSkills, onProgress: (message) => console.error(message) });
}
