import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const primePin = JSON.parse(await readFile(new URL("../prime-runtime.lock.json", import.meta.url), "utf8"));

export async function preparePrimeRuntime() {
  const explicit = process.env.PRIME_AGENT_REPO;
  const root = resolve(explicit || join(homedir(), ".cache/reify/prime", primePin.revision));
  const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
  if (!existsSync(root)) {
    if (explicit) throw new Error(`PRIME_AGENT_REPO does not exist: ${root}`);
    await mkdir(dirname(root), { recursive: true });
    execFileSync("git", ["clone", "--depth", "1", "--branch", `v${primePin.version}`, primePin.repository, root], { stdio: "inherit" });
  }
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (revision !== primePin.revision) throw new Error(`Prime release must use ${primePin.revision}; got ${revision} at ${root}`);
  if (execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) {
    throw new Error("Prime release checkout has uncommitted changes");
  }
  for (const name of ["agent", "ai", "coding-agent", "tui"]) {
    const pkg = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
    if (pkg.version !== primePin.version) throw new Error(`Prime ${name} must be ${primePin.version}, got ${pkg.version}`);
  }
  // Build from the pinned sources on every release, never from a live patched installation.
  run("npm", ["ci", "--ignore-scripts"]);
  run("npm", ["run", "build"]);
  return root;
}
