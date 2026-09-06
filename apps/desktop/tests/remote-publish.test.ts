import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ViewerBackend } from "../electron/main/viewer";
import type { AppSettings, ReleaseResult } from "../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const execute = (args: string[], input?: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => { const child = spawn(args[0]!, args.slice(1), { stdio: ["pipe", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `exit ${code}`))); child.stdin.end(input); });

describe("explicit Git remote publishing", () => {
  it("publishes the approved commit, retries safely, and refuses conflicting tags without touching staged work", async () => {
    const project = await mkdtemp(join(tmpdir(), "reify-publish-project-")); const remote = await mkdtemp(join(tmpdir(), "reify-publish-remote-")); const releasePath = await mkdtemp(join(tmpdir(), "reify-publish-release-")); roots.push(project, remote, releasePath);
    await execute(["git", "init", "--bare", remote]); await execute(["git", "init", project]); await execute(["git", "-C", project, "config", "user.email", "test@reify.local"]); await execute(["git", "-C", project, "config", "user.name", "Reify Test"]); await execute(["git", "-C", project, "remote", "add", "origin", remote]);
    await writeFile(join(project, "part.txt"), "first\n"); await execute(["git", "-C", project, "add", "part.txt"]); await execute(["git", "-C", project, "commit", "-m", "first"]); const firstRevision = (await execute(["git", "-C", project, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(project, "part.txt"), "second\n"); await execute(["git", "-C", project, "commit", "-am", "second"]); const sourceRevision = (await execute(["git", "-C", project, "rev-parse", "HEAD"])).stdout.trim();
    await writeFile(join(project, "staged.txt"), "must remain staged\n"); await execute(["git", "-C", project, "add", "staged.txt"]); const statusBefore = (await execute(["git", "-C", project, "status", "--porcelain=v1"])).stdout;
    const manifestPath = join(releasePath, "release-manifest.json"); await writeFile(manifestPath, `${JSON.stringify({ releaseId: "release-a", sourceRevision })}\n`);
    const release: ReleaseResult = { releaseId: "release-a", path: releasePath, manifestPath, reused: false, files: [] };
    const settings = { projectPath: project, remotePublish: { enabled: false, allowedRemotes: ["origin"] } } as AppSettings;
    const bridge = { kind: "native", spawn: (args: string[]) => spawn(args[0]!, args.slice(1), { stdio: ["pipe", "pipe", "pipe"] }), exec: (args: string[], options?: { input?: string }) => execute(args, options?.input), toRuntimePath: async (path: string) => path, resolveRuntimePaths: async () => ({ piCadRepo: "/runtime", primeAgentRepo: "", projectPath: project }) };
    const viewer = new ViewerBackend(bridge as never);
    await expect(viewer.publishRemoteRelease(settings, release, "origin", "reify/candidate")).rejects.toThrow(/disabled/);
    settings.remotePublish.enabled = true;
    const published = await viewer.publishRemoteRelease(settings, release, "origin", "reify/candidate");
    expect(published).toMatchObject({ sourceRevision, tag: "reify/candidate", reused: false, packageUploaded: false });
    expect((await execute(["git", "--git-dir", remote, "rev-parse", "refs/tags/reify/candidate"])).stdout.trim()).toBe(sourceRevision);
    expect((await execute(["git", "-C", project, "status", "--porcelain=v1"])).stdout).toBe(statusBefore);
    await expect(viewer.publishRemoteRelease(settings, release, "origin", "reify/candidate")).resolves.toMatchObject({ reused: true });
    await execute(["git", "-C", project, "tag", "reify/conflict", firstRevision]); await execute(["git", "-C", project, "push", "origin", "refs/tags/reify/conflict"]);
    await expect(viewer.publishRemoteRelease(settings, release, "origin", "reify/conflict")).rejects.toThrow(/already exists/);
    expect((await execute(["git", "--git-dir", remote, "rev-parse", "refs/tags/reify/conflict"])).stdout.trim()).toBe(firstRevision);
    expect(await readFile(manifestPath, "utf8")).toContain("release-a");
  });
});
