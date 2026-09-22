#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export async function assertContainedLinks(root, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(path);
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) throw new Error(`Runtime link escapes its bundle: ${path}`);
    } else if (entry.isDirectory()) await assertContainedLinks(root, path);
  }
}

export async function installRuntimeBundle(source, destination) {
  source = resolve(source);
  destination = resolve(destination);
  if (destination === dirname(destination) || source === destination) throw new Error("Invalid runtime installation directory");
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  const archive = join(source, "runtime-bundle.tar.gz");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== manifest.runtimeId) throw new Error("Runtime archive checksum mismatch");
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim().split("\n");
  if (entries.some((entry) => !/^(pi-cad|prime-agent)\//.test(entry) || entry.split("/").includes(".."))) throw new Error("Invalid runtime archive paths");
  await mkdir(destination, { recursive: true });
  const lock = join(destination, ".install-lock");
  await mkdir(lock); // Refuse overlapping installs rather than mixing two bundles.
  const stage = join(destination, `.install-${randomUUID()}`);
  const backup = join(stage, "previous");
  const moved = [];
  const preserved = [];
  const installed = [];
  try {
    await mkdir(backup, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", stage]);
    await assertContainedLinks(stage);
    for (const name of ["agent", "ai", "coding-agent", "tui"]) {
      const pkg = JSON.parse(await readFile(join(stage, "prime-agent/packages", name, "package.json"), "utf8"));
      if (pkg.version !== manifest.primeVersion) throw new Error(`Mismatched Prime ${name} version`);
    }
    await chmod(join(stage, "prime-agent/prime-agent.sh"), 0o755);
    for (const file of ["pi-cad/scripts/desktop-prime-config.mjs", "prime-agent/packages/coding-agent/dist/core/kernel/bootstrap.js"]) {
      if (!(await lstat(join(stage, file))).isFile()) throw new Error(`Missing runtime file: ${file}`);
    }
    // Preserve downloaded runtimes and the CAD environment, never old code or node_modules.
    for (const path of ["python/.venv", ".runtime", ".pi-cad", ".pi-cad-runtime.json"]) {
      const from = join(destination, "pi-cad", path);
      const to = join(stage, "pi-cad", path);
      if (existsSync(from)) {
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
        preserved.push(path);
      }
    }
    for (const name of ["prime-agent", "pi-cad"]) {
      if (existsSync(join(destination, name))) {
        await rename(join(destination, name), join(backup, name));
        moved.push(name);
      }
      await rename(join(stage, name), join(destination, name));
      installed.push(name);
    }
    // The caller publishes manifest.json only after Python and the SDK links are ready.
    await cp(join(source, "manifest.json"), join(destination, "manifest.pending.json"));
  } catch (error) {
    for (const name of installed.reverse()) await rename(join(destination, name), join(stage, name));
    for (const name of moved.reverse()) await rename(join(backup, name), join(destination, name));
    for (const path of preserved.reverse()) await rename(join(stage, "pi-cad", path), join(destination, "pi-cad", path));
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error("usage: install-runtime-bundle.mjs <bundle> <destination>");
  await installRuntimeBundle(source, destination);
}
