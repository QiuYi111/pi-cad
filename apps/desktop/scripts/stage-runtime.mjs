#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(desktopRoot, "../..");
const destination = resolve(desktopRoot, "resources/runtime");
if (dirname(destination) !== resolve(desktopRoot, "resources")) throw new Error("Refusing to stage outside desktop resources.");

function wslPath(value) {
  const text = execFileSync("wsl.exe", ["-d", process.env.PI_CAD_WSL_DISTRO || "Ubuntu", "--", "wslpath", "-w", value], { encoding: "utf8", windowsHide: true }).trim();
  if (!text) throw new Error(`Cannot map WSL path: ${value}`);
  return text;
}
const primeLinux = process.env.PRIME_AGENT_REPO || execFileSync("wsl.exe", ["-d", process.env.PI_CAD_WSL_DISTRO || "Ubuntu", "--", "sh", "-lc", "printf %s \"${PRIME_AGENT_REPO:-$HOME/prime-agent-plan-c-upstream}\""], { encoding: "utf8", windowsHide: true }).trim();
const prime = process.platform === "linux" ? primeLinux : wslPath(primeLinux);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const copy = async (from, to) => cp(from, to, { recursive: true, force: true, filter: (path) => !/(^|[\\/])(?:node_modules|\.git|__pycache__|\.venv|tests?|benchmarks?|apps)([\\/]|$)/.test(path) });

const piCadDestination = join(destination, "pi-cad");
await mkdir(piCadDestination, { recursive: true });
for (const name of ["src", "scripts", "skills", "packages", "python", "workflow-packages", "assets", "recipes"]) {
  await copy(join(repository, name), join(piCadDestination, name));
}
for (const name of ["package.json", "package-lock.json", "README.md", "README.zh-CN.md", "LICENSE"]) {
  await cp(join(repository, name), join(piCadDestination, name));
}

const primeDestination = join(destination, "prime-agent");
await mkdir(primeDestination, { recursive: true });
await cp(join(prime, "prime-agent.sh"), join(primeDestination, "prime-agent.sh"));
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

const manifest = {
  schema: 1,
  stagedAt: new Date().toISOString(),
  piCadVersion: JSON.parse(await readFile(join(repository, "package.json"), "utf8")).version,
  primeVersion: JSON.parse(await readFile(join(prime, "packages/coding-agent/package.json"), "utf8")).version,
  licenses: ["Pi-CAD: MIT", "Prime Agent: MIT", "zeromq: MIT AND MPL-2.0", "photon-node: Apache-2.0"],
};
await writeFile(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Staged desktop runtime at ${destination}`);
