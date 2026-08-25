import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const project = realpathSync(resolve(import.meta.dirname, ".."));
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent-plan-c-upstream"));
const tsx = resolve(primeRoot, "node_modules/.bin/tsx");
if (!existsSync(tsx)) {
  console.error(`Actual Prime dependencies are missing: ${tsx}`);
  process.exit(1);
}

const result = spawnSync(tsx, ["--test", resolve(project, "tests/prime-boundary.test.ts")], {
  cwd: project,
  stdio: "inherit",
  env: { ...process.env, PRIME_AGENT_REPO: primeRoot, PI_CAD_REPO: project },
});
if (result.status !== 0) process.exit(result.status ?? 1);
const smoke = spawnSync(process.execPath, [resolve(project, "tests/prime-cli-smoke.mjs")], {
  cwd: project,
  stdio: "inherit",
  env: { ...process.env, PRIME_AGENT_REPO: primeRoot, PI_CAD_REPO: project },
});
process.exitCode = smoke.status ?? 1;
