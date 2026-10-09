import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspacePath, WorkspacePathError } from "../src/index.js";

let base: string;
let root: string;
let readOnly: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "reify-paths-"));
  root = join(base, "workspace");
  readOnly = join(base, "opt-reify");
  outside = join(base, "outside");
  for (const dir of [root, readOnly, outside]) await mkdir(dir, { recursive: true });
  await writeFile(join(root, "a.txt"), "a");
  await writeFile(join(readOnly, "lib.txt"), "lib");
  await writeFile(join(outside, "secret.txt"), "secret");
  await mkdir(join(root, "sub"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const options = () => ({ workspaceRoot: root, readOnlyRoots: [readOnly] });

async function expectCode(path: string, code: string) {
  const error = await resolveWorkspacePath(path, options()).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(WorkspacePathError);
  expect((error as WorkspacePathError).code).toBe(code);
}

describe("resolveWorkspacePath", () => {
  it("resolves relative and absolute paths inside the workspace", async () => {
    expect(await resolveWorkspacePath("a.txt", options())).toEqual({ abs: join(root, "a.txt"), readOnly: false });
    expect(await resolveWorkspacePath(join(root, "sub", "new.txt"), options())).toEqual({ abs: join(root, "sub", "new.txt"), readOnly: false });
  });

  it("allows files in read-only roots and flags them", async () => {
    expect(await resolveWorkspacePath(join(readOnly, "lib.txt"), options())).toEqual({ abs: join(readOnly, "lib.txt"), readOnly: true });
  });

  it("rejects .. escapes, including through a missing file", async () => {
    await expectCode("../outside/secret.txt", "outside_workspace");
    await expectCode("sub/../../outside/secret.txt", "outside_workspace");
    await expectCode("../outside/new.txt", "outside_workspace");
  });

  it("rejects absolute paths outside the roots", async () => {
    await expectCode(join(outside, "secret.txt"), "outside_workspace");
  });

  it("rejects symlinks that point outside the workspace", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
    await expectCode("leak.txt", "outside_workspace");
    await symlink(outside, join(root, "leakdir"));
    await expectCode("leakdir/new.txt", "outside_workspace");
  });

  it("follows symlinks that stay inside the workspace", async () => {
    await symlink(join(root, "sub"), join(root, "alias"));
    expect((await resolveWorkspacePath("alias/x.txt", options())).abs).toBe(join(root, "sub", "x.txt"));
  });

  it("flags symlinks into read-only roots as read-only", async () => {
    await symlink(join(readOnly, "lib.txt"), join(root, "lib-link.txt"));
    expect((await resolveWorkspacePath("lib-link.txt", options())).readOnly).toBe(true);
  });

  it("reports a missing parent directory as not_found", async () => {
    await expectCode("missing/dir/file.txt", "not_found");
  });
});
