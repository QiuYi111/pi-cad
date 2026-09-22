#!/usr/bin/env node

import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preparePrimeRuntime, primePin } from "./prepare-prime-runtime.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(desktopRoot, "../..");
const destination = resolve(desktopRoot, "resources/runtime");
if (dirname(destination) !== resolve(desktopRoot, "resources")) throw new Error("Refusing to stage outside desktop resources.");

const prime = await preparePrimeRuntime();

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const copy = async (from, to) => cp(from, to, { recursive: true, force: true, filter: (path) => !/(^|[\\/])(?:node_modules|\.git|__pycache__|\.venv|tests?|benchmarks?|apps)([\\/]|$)/.test(path) });

const piCadDestination = join(destination, "pi-cad");
await mkdir(piCadDestination, { recursive: true });
for (const name of ["src", "scripts", "skills", "packages", "python", "workflow-packages", "assets", "recipes", "third_party"]) {
  await copy(join(repository, name), join(piCadDestination, name));
}
for (const name of ["package.json", "package-lock.json", "README.md", "README.zh-CN.md", "LICENSE"]) {
  await cp(join(repository, name), join(piCadDestination, name));
}
await mkdir(join(piCadDestination, "node_modules"), { recursive: true });
for (const name of ["jiti", "typebox", "undici", "yaml"]) {
  await cp(join(repository, "node_modules", name), join(piCadDestination, "node_modules", name), { recursive: true });
}

const primeDestination = join(destination, "prime-agent");
await mkdir(primeDestination, { recursive: true });
await writeFile(join(primeDestination, "prime-agent.sh"), `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
export PRIME_AGENT_LAUNCHER_PATH="$ROOT/prime-agent.sh"
export PRIME_AGENT_BUILD_ID="${primePin.revision}"
if [[ "\${1:-}" == "--dist" ]]; then shift; fi
exec node "$ROOT/packages/coding-agent/dist/bundle/cli.js" "$@"
`);
await chmod(join(primeDestination, "prime-agent.sh"), 0o755);
await cp(join(prime, "package.json"), join(primeDestination, "package.json"));
await cp(join(prime, "package-lock.json"), join(primeDestination, "package-lock.json"));
await cp(join(prime, "LICENSE"), join(primeDestination, "LICENSE"));
for (const name of ["agent", "ai", "coding-agent", "tui"]) {
  await mkdir(join(primeDestination, "packages", name), { recursive: true });
  await cp(join(prime, "packages", name, "package.json"), join(primeDestination, "packages", name, "package.json"));
  await cp(join(prime, "packages", name, "dist"), join(primeDestination, "packages", name, "dist"), { recursive: true });
}
await cp(join(prime, "node_modules"), join(primeDestination, "node_modules"), {
  recursive: true,
  dereference: true,
  filter: (path) =>
    !/(^|[\\/])\.bin([\\/]|$)/.test(path) &&
    !/(^|[\\/])@earendil-works([\\/]|$)/.test(path) &&
    !/(^|[\\/])pi-extension-[^\\/]+$/.test(path),
});
for (const [packageName, directory] of [["pi-agent-core", "agent"], ["pi-ai", "ai"], ["pi-coding-agent", "coding-agent"], ["pi-tui", "tui"]]) {
  const target = join(primeDestination, "node_modules/@earendil-works", packageName);
  await mkdir(target, { recursive: true });
  await cp(join(primeDestination, "packages", directory, "package.json"), join(target, "package.json"));
  await cp(join(primeDestination, "packages", directory, "dist"), join(target, "dist"), { recursive: true });
}

// The host configuration APIs and the CLI must come from the same release.
const versionResult = spawnSync("bash", [join(primeDestination, "prime-agent.sh"), "--version"], { encoding: "utf8" });
const versionLines = `${versionResult.stdout}\n${versionResult.stderr}`.trim().split(/\r?\n/);
if (versionResult.status !== 0 || !versionLines.includes(primePin.version)) throw new Error(`Staged Prime version check failed: ${versionLines.join("\n")}`);
await cp(join(repository, "scripts/install-runtime-bundle.mjs"), join(destination, "install-runtime-bundle.mjs"));

const archivePath = join(destination, "runtime-bundle.tar.gz");
execFileSync("tar", ["-czf", archivePath, "-C", destination, "pi-cad", "prime-agent"], { stdio: "inherit" });
const runtimeId = createHash("sha256").update(await readFile(archivePath)).digest("hex");
const manifest = {
  schema: 1,
  runtimeId,
  stagedAt: new Date().toISOString(),
  piCadVersion: JSON.parse(await readFile(join(repository, "package.json"), "utf8")).version,
  piCadRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  primeVersion: primePin.version,
  primeRevision: primePin.revision,
  licenses: ["Reify (pi-cad runtime): MIT", "Prime Agent: MIT", "Blender MCP: GPL-3.0-or-later", "zeromq: MIT AND MPL-2.0", "photon-node: Apache-2.0"],
};
await writeFile(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await rm(piCadDestination, { recursive: true, force: true });
await rm(primeDestination, { recursive: true, force: true });
console.log(`Staged desktop runtime at ${destination}`);
