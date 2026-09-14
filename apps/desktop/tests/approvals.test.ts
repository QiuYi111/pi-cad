import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanApprovalStore } from "../electron/main/approvals";
import { ViewerBackend } from "../electron/main/viewer";
import type { ViewerCatalog } from "../src/shared/contracts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const catalog = (artifactSha = "artifact-a"): ViewerCatalog => ({
  projectId: "bracket", projectHead: { updatedAt: "now", artifacts: [] }, currentRun: null, parameterManifests: [], simulationRuns: [],
  commits: [{ id: "candidate", name: "Candidate", parent: null, phase: "review", createdAt: "now", workflowHash: "workflow-a", sourceRevision: "a".repeat(40), artifacts: [{ id: "part", path: "part.step", sha256: artifactSha, role: "authoritative-design" }], acceptanceSummary: { assumptions: [], requirements: [{ id: "review", category: "machine", status: "verified", method: "independent reviewer", evidence: { path: "evidence/review.json", sha256: "e".repeat(64) } }] } }],
});

describe("trusted local human approvals", () => {
  it("binds approval to OS identity and exact version, supports revocation, and expires on artifact change", async () => {
    const root = await mkdtemp(join(tmpdir(), "reify-approvals-")); roots.push(root);
    const alice = new HumanApprovalStore(root, "alice");
    const approved = await alice.approve(catalog(), "candidate", "manufacturing release", "dimensions and review evidence checked");
    expect(approved.approver).toEqual({ type: "local-os-user", id: "alice" });
    expect((await alice.list(catalog()))[0]).toMatchObject({ valid: true, scope: "manufacturing release" });
    expect((await alice.list(catalog("artifact-b")))[0]?.valid).toBe(false);
    await expect(new HumanApprovalStore(root, "bob").revoke(catalog(), approved.id, "not mine")).rejects.toThrow(/approving OS user/);
    expect(await alice.revoke(catalog(), approved.id, "superseded by a new design")).toMatchObject({ valid: false, revocationReason: "superseded by a new design" });
  });

  it("rejects approval without a machine-reviewed immutable version", async () => {
    const root = await mkdtemp(join(tmpdir(), "reify-approvals-")); roots.push(root);
    const unreviewed = catalog(); unreviewed.commits[0]!.acceptanceSummary!.requirements[0]!.status = "unverified";
    await expect(new HumanApprovalStore(root, "alice").approve(unreviewed, "candidate", "release", "looks good")).rejects.toThrow(/machine review/);
  });
});

describe("formal local release package", () => {
  it("publishes atomically, verifies hashes in another directory, and reuses the same release", async () => {
    const project = await mkdtemp(join(tmpdir(), "reify-release-project-")); const destination = await mkdtemp(join(tmpdir(), "reify-release-destination-")); roots.push(project, destination);
    await writeFile(join(project, "part.step"), "trusted model\n");
    const sha = createHash("sha256").update("trusted model\n").digest("hex");
    const releaseCatalog = catalog(sha); releaseCatalog.commits[0]!.artifacts[0]!.path = "part.step";
    const approvalsRoot = await mkdtemp(join(tmpdir(), "reify-release-approval-")); roots.push(approvalsRoot);
    const store = new HumanApprovalStore(approvalsRoot, "alice"); const approval = await store.approve(releaseCatalog, "candidate", "manufacturing", "checked");
    const execute = (args: string[], input?: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => { const child = spawn(args[0]!, args.slice(1), { stdio: ["pipe", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `exit ${code}`))); child.stdin.end(input); });
    const bridge = { kind: "native", spawn: (args: string[]) => spawn(args[0]!, args.slice(1), { stdio: ["pipe", "pipe", "pipe"] }), exec: (args: string[], options?: { input?: string }) => execute(args, options?.input), toRuntimePath: async (path: string) => path, resolveRuntimePaths: async () => ({ piCadRepo: "/runtime", primeAgentRepo: "", projectPath: project }) };
    const viewer = new ViewerBackend(bridge as never); viewer.catalog = async () => releaseCatalog;
    const first = await viewer.releaseCommit({} as never, "candidate", approval, destination, async () => true);
    expect(first.reused).toBe(false);
    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
    expect(manifest).toMatchObject({ releaseId: first.releaseId, sourceRevision: "a".repeat(40), approvalId: approval.id });
    expect(createHash("sha256").update(await readFile(join(first.path, "files/part.step"))).digest("hex")).toBe(sha);
    expect((await viewer.releaseCommit({} as never, "candidate", approval, destination, async () => true)).reused).toBe(true);
    await writeFile(join(project, "part.step"), "replaced model\n");
    await expect(viewer.releaseCommit({} as never, "candidate", { ...approval, id: "second" }, destination, async () => true)).rejects.toThrow(/changed before packaging/);
    await writeFile(join(project, "part.step"), "trusted model\n");
    let checks = 0;
    await expect(viewer.releaseCommit({} as never, "candidate", { ...approval, id: "revoked-during-copy" }, destination, async () => ++checks === 1)).rejects.toThrow(/revoked while/);
  });
});
