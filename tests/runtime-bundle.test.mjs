import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installRuntimeBundle } from "../scripts/install-runtime-bundle.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reify-bundle-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "bundle");
  const content = join(root, "content");
  const target = join(root, "installed");
  await mkdir(source);
  const put = async (path, text) => { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text); };
  await put(join(content, "pi-cad/scripts/desktop-prime-config.mjs"), "new config");
  await put(join(content, "prime-agent/prime-agent.sh"), "#!/bin/sh\necho 0.9.5\n");
  await put(join(content, "prime-agent/packages/coding-agent/dist/core/kernel/bootstrap.js"), "new kernel");
  for (const name of ["agent", "ai", "coding-agent", "tui"]) await put(join(content, "prime-agent/packages", name, "package.json"), '{"version":"0.9.5"}');
  const pack = async () => {
    const archive = join(source, "runtime-bundle.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", content, "pi-cad", "prime-agent"]);
    await put(join(source, "manifest.json"), JSON.stringify({ primeVersion: "0.9.5", runtimeId: createHash("sha256").update(await readFile(archive)).digest("hex") }));
  };
  await pack();
  return { root, source, content, target, put, pack };
}

test("new installation contains the new code and remains pending until dependencies finish", async (t) => {
  const f = await fixture(t);
  await installRuntimeBundle(f.source, f.target);
  assert.equal(await readFile(join(f.target, "pi-cad/scripts/desktop-prime-config.mjs"), "utf8"), "new config");
  await assert.rejects(readFile(join(f.target, "manifest.json")), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(join(f.target, "manifest.pending.json"))).primeVersion, "0.9.5");
});

test("upgrade replaces legacy links without touching their targets and keeps downloaded runtimes", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "old-backup");
  await f.put(join(outside, "sentinel"), "keep");
  await mkdir(join(f.target, "prime-agent"), { recursive: true });
  await symlink(outside, join(f.target, "prime-agent/node_modules"));
  await f.put(join(f.target, "prime-agent/stale.js"), "old");
  await f.put(join(f.target, "pi-cad/python/.venv/sentinel"), "cad environment");
  await f.put(join(f.target, "pi-cad/.runtime/blender/sentinel"), "blender");
  await f.put(join(f.target, "manifest.json"), "old manifest");
  await installRuntimeBundle(f.source, f.target);
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "keep");
  await assert.rejects(readFile(join(f.target, "prime-agent/stale.js")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.target, "pi-cad/python/.venv/sentinel"), "utf8"), "cad environment");
  assert.equal(await readFile(join(f.target, "pi-cad/.runtime/blender/sentinel"), "utf8"), "blender");
  assert.equal(await readFile(join(f.target, "manifest.json"), "utf8"), "old manifest");
});

test("corrupt archive leaves the existing installation untouched", async (t) => {
  const f = await fixture(t);
  await f.put(join(f.target, "prime-agent/old"), "keep");
  await writeFile(join(f.source, "runtime-bundle.tar.gz"), "corrupt");
  await assert.rejects(installRuntimeBundle(f.source, f.target), /checksum mismatch/);
  assert.equal(await readFile(join(f.target, "prime-agent/old"), "utf8"), "keep");
});

test("external build-machine links are rejected before replacing the old installation", async (t) => {
  const f = await fixture(t);
  await symlink(f.root, join(f.content, "prime-agent/external"));
  await f.pack();
  await f.put(join(f.target, "prime-agent/old"), "keep");
  await assert.rejects(installRuntimeBundle(f.source, f.target), /escapes its bundle/);
  assert.equal(await readFile(join(f.target, "prime-agent/old"), "utf8"), "keep");
});
