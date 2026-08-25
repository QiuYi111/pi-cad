import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { assertLinuxRuntime } from "../src/shared/platform.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|mjs|sh)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("runtime has one Linux process boundary and no Windows-host bridge", async () => {
  assert.doesNotThrow(() => assertLinuxRuntime("test runtime"));
  const files = [
    ...await sourceFiles(join(root, "src")),
    ...await sourceFiles(join(root, "scripts")),
    ...await sourceFiles(join(root, "benchmarks")),
  ];
  for (const path of files) {
    const text = await readFile(path, "utf-8");
    assert.doesNotMatch(text, /wsl\.exe|PI_CAD_WSL_DISTRO|process\.platform\s*===\s*["']win32["']/, relative(root, path));
    if (text.includes('from "node:child_process"')) {
      const allowed = new Set([
        "src/shared/process-runner.ts",
        "scripts/postinstall.mjs",
        "scripts/install-blender.mjs",
        "scripts/prime-plan-c.mjs",
      ]);
      const repositoryPath = relative(root, path).replaceAll("\\", "/");
      assert.ok(repositoryPath.startsWith("benchmarks/") || allowed.has(repositoryPath), `uncontrolled process API import: ${relative(root, path)}`);
    }
  }
});

test("default test command checks the generated agent contract", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
  assert.match(pkg.scripts?.test ?? "", /check:agent-contract/);
});
