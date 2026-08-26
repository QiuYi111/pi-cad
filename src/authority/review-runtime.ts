import { EventEmitter } from "node:events";
import { canonicalDigest, jsonValue, type JsonValue } from "../harness/canonical.ts";
import { loadWorkspaceCommit } from "../harness/commit.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../harness/run-store.ts";
import { loadMandatoryImages, type PhaseCardImage } from "../harness/card.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";

export interface ReviewHandleV1 { reviewId: string; subjectCommit: string; status: "running" | "pass" | "fail" | "unresolved"; }
export interface ReviewCompletionV1 { verdict: "pass" | "fail" | "unresolved"; summary: string; findings: Array<{ id: string; severity: "info" | "warning" | "error"; finding: string; evidenceRefs: string[] }>; }
export interface ReviewEvidenceV1 {
  reviewId: string;
  subjectCommit: string;
  workflow: { id: string; version: string; hash: string };
  phase: string;
  originalRequest: string;
  records: Array<{ obligationRef: string; phase: string; variables: Record<string, JsonValue>; artifacts: Array<{ path: string; sha256: string; role: string }> }>;
  candidate: { path: string; sha256: string; role: string };
  images: Array<PhaseCardImage & { evidenceRef: string }>;
}
interface StoredReview extends ReviewHandleV1 { key: string; artifactHash: string; workflowHash: string; contractHash: string; profileId: string; createdAt: string; updatedAt: string; result?: ReviewCompletionV1; }
export type ReviewerExecutor = (input: { reviewId: string; subjectCommit: string; prompt: string }) => Promise<void>;

function requests(state: any): Record<string, StoredReview> {
  const value = state.domainMetadata?.reviewRequests;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, StoredReview> : {};
}

function reviewSubject(loaded: any): JsonValue {
  return jsonValue({ workflowHash: loaded.workflow.hash, registryContractHash: loaded.registryContract.hash, phase: loaded.state.phase, records: loaded.state.records, artifacts: loaded.state.artifacts, evidence: loaded.state.evidence });
}

function validateResult(value: ReviewCompletionV1): void {
  if (!value || !["pass", "fail", "unresolved"].includes(value.verdict) || !value.summary?.trim() || !Array.isArray(value.findings)) throw new Error("invalid reviewer result");
  for (const finding of value.findings) if (!finding?.id || !["info", "warning", "error"].includes(finding.severity) || !finding.finding || !Array.isArray(finding.evidenceRefs)) throw new Error("invalid reviewer finding");
  if (value.verdict === "pass" && !value.findings.some((item) => item.evidenceRefs.length > 0)) throw new Error("PASS without affirmative evidence is invalid");
}

export class ReviewRuntime {
  private readonly events = new EventEmitter();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly probeCounts = new Map<string, number>();
  private readonly visualEvidenceRefs = new Map<string, Set<string>>();
  private closed = false;
  constructor(private readonly cwd: string, private readonly executor: ReviewerExecutor) {}

  async submit(subjectCommit: string): Promise<ReviewHandleV1> {
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    if (!active) throw new Error("review.submit requires an active workflow");
    const profileId = active.workflow.phases[active.state.phase]?.reviewProfile;
    if (!profileId) throw new Error(`review.submit is unavailable in phase ${active.state.phase}`);
    const { manifest } = await loadWorkspaceCommit(this.cwd, mechanicalRegistries, subjectCommit);
    if (manifest.workflowHash !== active.workflow.hash) throw new Error("review subject commit belongs to another workflow snapshot");
    if (!manifest.artifacts.length) throw new Error("review subject commit has no immutable artifacts");
    const canonicalCandidate = active.state.artifacts["candidate:authoritative"];
    if (canonicalCandidate && !manifest.artifacts.some((item) => item.path === canonicalCandidate.path && item.sha256 === canonicalCandidate.sha256)) {
      throw new Error("review subject commit does not contain the canonical candidate artifact");
    }
    const artifactHash = canonicalDigest(manifest.artifacts.map(({ path, sha256, role }) => ({ path, sha256, role })));
    const contractHash = canonicalDigest({
      registryContractHash: active.registryContract.hash,
      workflowHash: active.workflow.hash,
      acceptanceRecords: active.state.records,
    });
    const key = canonicalDigest({ workflowHash: active.workflow.hash, contractHash, artifactHash });
    const existing = Object.values(requests(active.state)).find((item) => item.key === key);
    if (existing) return { reviewId: existing.reviewId, subjectCommit: existing.subjectCommit, status: existing.status };
    const reviewId = `review-${key.slice(0, 24)}`;
    const now = new Date().toISOString();
    const stored: StoredReview = { reviewId, subjectCommit, status: "running", key, artifactHash, workflowHash: active.workflow.hash, contractHash, profileId, createdAt: now, updatedAt: now };
    await new HarnessRunStoreV7(this.cwd, active.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, domainMetadata: { ...(state.domainMetadata ?? {}), reviewRequests: jsonValue({ ...requests(state), [reviewId]: stored }) }, updatedAt: now },
      event: { type: "ReviewSubmitted", data: { reviewId, subjectCommit, key, artifactHash } },
    }));
    const prompt = [
      "You are a fresh, rigorous, independent engineering design reviewer running as an ordinary Prime template.",
      "Do not read skills or source files, inspect APIs, inspect signatures, inspect docstrings, or access author transcripts/source-generation history.",
      `In IPython run import cad; subject = await cad.load(${JSON.stringify(subjectCommit)}).`,
      "Immediately run context = await cad.review.inspect(). It attaches canonical views and returns the immutable record of the original user request and the design case submitted by the author.",
      "Evaluate whether the actual immutable candidate faithfully and credibly solves the original user's request and whether the author's submitted design decisions hold up as engineering. The submission describes intent and claims; it is not proof of its own correctness.",
      "Form your own review plan from the task and submission. Use professional judgment to identify the most consequential uncertainties, defects, and unsupported claims, then choose independent probes that can confirm or falsify them. Do not rely on a harness-prescribed checklist or merely repeat the author's checks.",
      "Select the authoritative STEP ArtifactRef from subject.artifacts and call await cad.probe.run(subject=artifact, purpose=..., code=...) for the investigations you decide are material. The fenced probe already binds shape and artifact_path; assign only the requested output to result.",
      "Be demanding but evidence-led. PASS only when the candidate is affirmatively supported as a faithful and engineering-sound response to the request; FAIL when evidence contradicts a material requirement or design claim; UNRESOLVED when the available evidence cannot support a responsible decision.",
      `Finish exactly once with await cad.review.resolve(${JSON.stringify(reviewId)}, verdict="pass" | "fail" | "unresolved", summary="...", findings=[{"id":"geometry","severity":"info" | "warning" | "error","finding":"...","evidenceRefs":["..."]}]).`,
      "For evidenceRefs cite the visual evidenceRef returned by cad.review.inspect() and successful ProbeResult observation_id values. A PASS must be grounded in both direct visual review and at least one independent probe; missing evidence, timeout, crash, or material uncertainty is UNRESOLVED.",
      "Budgets: maxProbeCalls=12, maxTurns=16, wallTimeout=120s, noCompaction=true.",
    ].join("\n");
    const task = this.executor({ reviewId, subjectCommit, prompt }).then(async () => {
      const current = await this.current(reviewId);
      if (current?.status === "running") await this.complete(reviewId, { verdict: "unresolved", summary: "reviewer exited without an authoritative result", findings: [{ id: "empty-review", severity: "error", finding: "reviewer exited without an authoritative result", evidenceRefs: [] }] });
    }).catch(async (error) => {
      try { await this.complete(reviewId, { verdict: "unresolved", summary: `reviewer failed safely: ${error instanceof Error ? error.message : String(error)}`, findings: [{ id: "reviewer-crash", severity: "error", finding: "reviewer crashed", evidenceRefs: [] }] }); }
      catch { /* the run may have been explicitly removed while the reviewer exited */ }
    }).finally(() => { this.inflight.delete(reviewId); });
    this.inflight.set(reviewId, task);
    return { reviewId, subjectCommit, status: "running" };
  }

  async current(reviewId?: string): Promise<ReviewHandleV1 | null> {
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    if (!active) return null;
    const values = Object.values(requests(active.state));
    const item = reviewId ? values.find((value) => value.reviewId === reviewId) : values.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return item ? { reviewId: item.reviewId, subjectCommit: item.subjectCommit, status: item.status } : null;
  }

  async evidence(reviewId: string): Promise<ReviewEvidenceV1> {
    const subjectCommit = await this.reviewerSubject(reviewId);
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    if (!active) throw new Error("review run no longer exists");
    const stored = requests(active.state)[reviewId];
    if (!stored || stored.subjectCommit !== subjectCommit) throw new Error("review evidence authority is stale");
    const { manifest: subjectManifest } = await loadWorkspaceCommit(this.cwd, mechanicalRegistries, subjectCommit);
    const frame = await new HarnessRunStoreV7(this.cwd, active.state.runId).transactions.readJson<{ mission?: unknown }>("context/frame.json");
    const originalRequest = typeof frame?.mission === "string" ? frame.mission.trim() : "";
    if (!originalRequest) throw new Error("canonical original user request is unavailable");
    const candidate = active.state.artifacts["candidate:authoritative"]
      ?? subjectManifest.artifacts.find((item) => /candidate/i.test(item.role))
      ?? subjectManifest.artifacts[0];
    if (!candidate || !subjectManifest.artifacts.some((item) => item.path === candidate.path && item.sha256 === candidate.sha256)) {
      throw new Error("review evidence has no authoritative candidate");
    }
    const records: ReviewEvidenceV1["records"] = [];
    for (const [obligationRef, record] of Object.entries(active.state.records)) {
      const match = /workspace\/commits\/(commit-[a-f0-9]{32})\.json$/.exec(record.path);
      if (!match) continue;
      const { manifest, variables } = await loadWorkspaceCommit(this.cwd, mechanicalRegistries, match[1]!);
      records.push({
        obligationRef,
        phase: manifest.phase,
        variables: Object.fromEntries(Object.entries(variables).map(([name, snapshot]) => [name, (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) && "value" in snapshot) ? (snapshot as { value: JsonValue }).value : snapshot])),
        artifacts: manifest.artifacts,
      });
    }
    const images = (await loadMandatoryImages(this.cwd, active.state.contextRefs, 2)).map((image) => ({ ...image, evidenceRef: `visual:${image.sha256}` }));
    if (!images.length) throw new Error("canonical review images are unavailable");
    this.visualEvidenceRefs.set(reviewId, new Set(images.map((image) => image.evidenceRef)));
    return {
      reviewId,
      subjectCommit,
      workflow: { id: active.workflow.id, version: active.workflow.version, hash: active.workflow.hash },
      phase: active.state.phase,
      originalRequest,
      records,
      candidate,
      images,
    };
  }

  async complete(reviewId: string, result: ReviewCompletionV1): Promise<ReviewHandleV1> {
    validateResult(result);
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    if (!active) throw new Error("review run no longer exists");
    const existing = requests(active.state)[reviewId];
    if (!existing) throw new Error(`unknown review: ${reviewId}`);
    if (existing.status !== "running") return { reviewId, subjectCommit: existing.subjectCommit, status: existing.status };
    const currentContractHash = canonicalDigest({
      registryContractHash: active.registryContract.hash,
      workflowHash: active.workflow.hash,
      acceptanceRecords: active.state.records,
    });
    if (existing.workflowHash !== active.workflow.hash || existing.contractHash !== currentContractHash) throw new Error("review subject is stale");
    const { manifest } = await loadWorkspaceCommit(this.cwd, mechanicalRegistries, existing.subjectCommit);
    const artifactHash = canonicalDigest(manifest.artifacts.map(({ path, sha256, role }) => ({ path, sha256, role })));
    if (artifactHash !== existing.artifactHash) throw new Error("review artifact identity is stale");
    if (result.verdict === "pass") {
      if ((this.probeCounts.get(reviewId) ?? 0) < 1) throw new Error("PASS requires at least one independent probe");
      const allowedVisualRefs = this.visualEvidenceRefs.get(reviewId);
      const citedRefs = new Set(result.findings.flatMap((finding) => finding.evidenceRefs));
      if (!allowedVisualRefs?.size || ![...allowedVisualRefs].some((ref) => citedRefs.has(ref))) {
        throw new Error("PASS requires a canonical visual evidence reference from cad.review.inspect()");
      }
    }
    const status = result.verdict;
    const updated: StoredReview = { ...existing, status, result, updatedAt: new Date().toISOString() };
    const path = `reviews/${reviewId}.json`;
    await new HarnessRunStoreV7(this.cwd, active.state.runId).mutate(mechanicalRegistries, (loaded) => ({
      state: {
        ...loaded.state,
        domainMetadata: { ...(loaded.state.domainMetadata ?? {}), reviewRequests: jsonValue({ ...requests(loaded.state), [reviewId]: updated }) },
        latestReview: { id: reviewId, verdict: status, path, profileId: existing.profileId, subjectHash: canonicalDigest(reviewSubject(loaded)), workflowHash: loaded.workflow.hash, registryContractHash: loaded.registryContract.hash, subjectCommit: existing.subjectCommit, artifactHash: existing.artifactHash },
        updatedAt: updated.updatedAt,
      },
      event: { type: "ReviewCompleted", data: { reviewId, verdict: status, subjectCommit: existing.subjectCommit, artifactHash } },
      payloads: { [path]: jsonValue({ schema: 1, ...updated }) },
    }));
    const handle = { reviewId, subjectCommit: existing.subjectCommit, status } as ReviewHandleV1;
    this.probeCounts.delete(reviewId);
    this.visualEvidenceRefs.delete(reviewId);
    this.events.emit("completed", handle);
    return handle;
  }

  async reviewerSubject(reviewId: string): Promise<string> {
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    const item = active ? requests(active.state)[reviewId] : undefined;
    if (!item || item.status !== "running") throw new Error("reviewer request is unknown or no longer running");
    return item.subjectCommit;
  }

  async admitProbe(reviewId: string): Promise<void> {
    await this.reviewerSubject(reviewId);
    const count = (this.probeCounts.get(reviewId) ?? 0) + 1;
    if (count > 12) throw new Error("reviewer probe budget exceeded: maxProbeCalls=12");
    this.probeCounts.set(reviewId, count);
  }

  async watch(after?: string): Promise<ReviewHandleV1 | null> {
    if (this.closed) return Promise.resolve(null);
    const latest = await this.current();
    if (latest && latest.status !== "running" && latest.reviewId !== after) return latest;
    return new Promise((accept) => {
      const listener = (handle: ReviewHandleV1) => { if (handle.reviewId !== after) { this.events.off("completed", listener); accept(handle); } };
      this.events.on("completed", listener);
      this.events.once("closed", () => { this.events.off("completed", listener); accept(null); });
    });
  }

  async waitForIdle(reviewId: string): Promise<void> { await this.inflight.get(reviewId); }

  shutdown(): void { this.closed = true; this.probeCounts.clear(); this.visualEvidenceRefs.clear(); this.events.emit("closed"); }
}
