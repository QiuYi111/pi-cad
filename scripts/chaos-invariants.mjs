#!/usr/bin/env node
// Run Reify system invariants against real run-store state and write the
// evidence as an artifact. Exit code follows the usual chaos convention:
// clean = 0, violation = 1, so a caller can gate on it.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const options = { cwd: process.env.PI_CAD_PROJECT_CWD || process.cwd(), storageRoot: null, json: false, artifact: null, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") options.cwd = argv[++index];
    else if (argument === "--storage-root") options.storageRoot = argv[++index];
    else if (argument === "--json") options.json = true;
    else if (argument === "--artifact") options.artifact = argv[++index];
    else if (argument === "--list") options.list = true;
    else if (!argument.startsWith("--")) options.cwd = argument;
  }
  return options;
}

const jiti = createJiti(import.meta.url, { moduleCache: false });
const invariants = await jiti.import("../src/chaos/invariants/index.ts");

const options = parseArguments(process.argv.slice(2));
const cwd = resolve(options.cwd);

if (options.list) {
  for (const invariant of invariants.reifySystemInvariants) {
    process.stdout.write(`${invariant.severity}\t${invariant.name}\t${invariant.scope}\t${invariant.title}\n`);
  }
  process.exit(0);
}

const report = await invariants.checkReifyInvariants({ cwd, ...(options.storageRoot ? { storageRoot: options.storageRoot } : {}) });

if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(invariants.summariseReport(report));

if (options.artifact) {
  const path = resolve(options.artifact);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.json) process.stdout.write(`artifact: ${path}\n`);
}

process.exit(report.violations.length ? 1 : 0);
