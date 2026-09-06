import { createHash, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HumanApproval, ViewerCatalog, ViewerCommit } from "../../src/shared/contracts.js";

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export class HumanApprovalStore {
  private mutation: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly identity = userInfo().username) {}
  private path(projectId: string) { return join(this.root, `${digest(projectId)}.json`); }
  private async read(projectId: string): Promise<HumanApproval[]> { try { return JSON.parse(await readFile(this.path(projectId), "utf8")); } catch { return []; } }
  private async write(projectId: string, approvals: HumanApproval[]) { await mkdir(this.root, { recursive: true }); const target = this.path(projectId); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(approvals, null, 2)}\n`, { mode: 0o600 }); await rename(temp, target); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
  private commit(catalog: ViewerCatalog, commitId: string): ViewerCommit {
    const commit = catalog.commits.find((item) => item.id === commitId);
    if (!commit) throw new Error("Only a preserved named version can be approved.");
    if (!commit.sourceRevision || !commit.workflowHash || !commit.artifacts.length) throw new Error("Version lacks source, workflow, or artifact identity.");
    if (!commit.acceptanceSummary?.requirements.some((item) => item.category === "machine" && item.status === "verified")) throw new Error("Independent machine review must pass before human approval.");
    return commit;
  }
  async list(catalog: ViewerCatalog): Promise<HumanApproval[]> {
    const records = await this.read(catalog.projectId);
    return records.map((record) => ({ ...record, valid: !record.revokedAt && catalog.commits.some((commit) => commit.id === record.commitId && commit.workflowHash === record.workflowHash && commit.sourceRevision === record.sourceRevision && digest(commit.artifacts) === record.artifactSetHash) }));
  }
  async approve(catalog: ViewerCatalog, commitId: string, scope: string, rationale: string): Promise<HumanApproval> {
    if (!this.identity.trim()) throw new Error("No verified local OS identity is available.");
    if (!scope.trim() || !rationale.trim()) throw new Error("Approval scope and rationale are required.");
    return this.serial(async () => {
      const commit = this.commit(catalog, commitId);
      const record: HumanApproval = { id: randomUUID(), projectId: catalog.projectId, commitId, workflowHash: commit.workflowHash!, sourceRevision: commit.sourceRevision!, artifactSetHash: digest(commit.artifacts), scope: scope.trim(), rationale: rationale.trim(), decision: "approved", approver: { type: "local-os-user", id: this.identity }, decidedAt: new Date().toISOString(), valid: true };
      await this.write(catalog.projectId, [...await this.read(catalog.projectId), record]);
      return record;
    });
  }
  async revoke(catalog: ViewerCatalog, id: string, reason: string): Promise<HumanApproval> {
    if (!reason.trim()) throw new Error("Revocation reason is required.");
    return this.serial(async () => {
      const records = await this.read(catalog.projectId); const index = records.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Approval record not found.");
      const record = records[index]!;
      if (record.approver.id !== this.identity) throw new Error("Only the verified approving OS user can revoke this approval.");
      records[index] = { ...record, revokedAt: new Date().toISOString(), revocationReason: reason.trim(), valid: false };
      await this.write(catalog.projectId, records); return records[index]!;
    });
  }
}
