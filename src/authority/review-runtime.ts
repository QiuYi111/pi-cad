import { EventEmitter } from "node:events";
import { canonicalDigest, jsonValue, type JsonValue } from "../harness/canonical.ts";
import { loadWorkspaceCommit } from "../harness/commit.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../harness/run-store.ts";
import { loadCommittedImages, loadMandatoryImages, type PhaseCardImage } from "../harness/card.ts";
import { mechanicalRegistries } from "../domains/mechanical/registries.ts";
import { transitionRun } from "../harness/reducer.ts";
import type { WorkflowSnapshotV1 } from "../harness/workflow/types.ts";
import type { HarnessRunStateV7 } from "../harness/state.ts";

export type AuthoritativeReviewVerdictV1 = "pass" | "fail" | "clarification_required";
export interface ReviewHandleV1 { reviewId: string; subjectCommit: string; status: "running" | AuthoritativeReviewVerdictV1 | "unresolved"; }
export interface ReviewFindingV1 { id: string; severity: "info" | "warning" | "error"; finding: string; evidenceRefs: string[]; }
export interface ReviewCompletionV1 { verdict: AuthoritativeReviewVerdictV1; target: string; summary: string; findings: ReviewFindingV1[]; }
export interface ReviewRuntimeFailureV1 { verdict: "unresolved"; summary: string; findings: ReviewFindingV1[]; }
export type ReviewResultV1 = ReviewCompletionV1 | ReviewRuntimeFailureV1;
export interface ReviewDispositionV1 { verdict: AuthoritativeReviewVerdictV1; target: string; purpose: string; }
export interface ReviewStatusV1 extends ReviewHandleV1 { result?: ReviewResultV1; }
export interface ReviewEvidenceV1 {
  reviewId: string;
  subjectCommit: string;
  workflow: { id: string; version: string; hash: string };
  phase: string;
  originalRequest: string;
  records: Array<{ obligationRef: string; phase: string; variables: Record<string, JsonValue>; artifacts: Array<{ path: string; sha256: string; role: string }> }>;
  candidate: { path: string; sha256: string; role: string };
  images: Array<PhaseCardImage & { evidenceRef: string; source: "committed-design-intent" | "candidate-view"; obligationRef?: string }>;
  dispositions: ReviewDispositionV1[];
}
interface StoredReview extends ReviewHandleV1 { key: string; artifactHash: string; workflowHash: string; contractHash: string; profileId: string; createdAt: string; updatedAt: string; result?: ReviewResultV1; }
export type ReviewerExecutor = (input: { reviewId: string; subjectCommit: string; prompt: string; signal: AbortSignal }) => Promise<void>;

function requests(state: any): Record<string, StoredReview> {
  const value = state.domainMetadata?.reviewRequests;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, StoredReview> : {};
}

function reviewSubject(loaded: any): JsonValue {
  return jsonValue({ workflowHash: loaded.workflow.hash, registryContractHash: loaded.registryContract.hash, phase: loaded.state.phase, records: loaded.state.records, artifacts: loaded.state.artifacts, evidence: loaded.state.evidence });
}

function contractRecords(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1): HarnessRunStateV7["records"] {
  // Geometry/assembly authoring records are candidate implementation state, not
  // the design contract. Including them lets an author turn the same STEP into
  // a "new" review merely by recommitting prose or an extra report attachment.
  const implementationRefs = new Set(Object.values(workflow.phases)
    .filter((phase) => phase.actions.includes("cad_build_step"))
    .flatMap((phase) => phase.recordObligations.map((obligation) => obligation.ref)));
  return Object.fromEntries(Object.entries(state.records).filter(([ref]) => !implementationRefs.has(ref)));
}

function reviewContractHash(active: { registryContract: { hash: string }; workflow: WorkflowSnapshotV1; state: HarnessRunStateV7 }): string {
  return canonicalDigest({
    registryContractHash: active.registryContract.hash,
    workflowHash: active.workflow.hash,
    acceptanceRecords: contractRecords(active.state, active.workflow),
  });
}

function validateResult(value: ReviewCompletionV1): void {
  if (!value || !["pass", "fail", "clarification_required"].includes(value.verdict) || typeof value.target !== "string" || !value.target.trim() || !value.summary?.trim() || !Array.isArray(value.findings)) throw new Error("invalid reviewer result");
  for (const finding of value.findings) if (!finding?.id || !["info", "warning", "error"].includes(finding.severity) || !finding.finding || !Array.isArray(finding.evidenceRefs)) throw new Error("invalid reviewer finding");
}

function dispositionChoices(state: HarnessRunStateV7, workflow: WorkflowSnapshotV1): Array<ReviewDispositionV1 & { event: string }> {
  const phase = workflow.phases[state.phase];
  if (!phase?.reviewProfile) return [];
  const visited = new Set(state.phaseHistory ?? [state.phase]);
  return Object.entries(phase.transitions).flatMap(([event, transition]) => {
    if ((transition.requiresVisited ?? []).some((phaseId) => !visited.has(phaseId))) return [];
    if ((transition.forbidsVisited ?? []).some((phaseId) => visited.has(phaseId))) return [];
    const verdicts = transition.reviewVerdicts ?? (event === "accepted" ? ["pass" as const] : []);
    return verdicts.filter((verdict): verdict is AuthoritativeReviewVerdictV1 => verdict === "pass" || verdict === "fail" || verdict === "clarification_required").map((verdict) => ({
      verdict, target: transition.target, purpose: workflow.phases[transition.target]?.purpose ?? transition.target, event,
    }));
  });
}

export class ReviewRuntime {
  private readonly events = new EventEmitter();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly reviewerControllers = new Map<string, AbortController>();
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
    const candidate = canonicalCandidate
      ?? manifest.artifacts.find((item) => /candidate/i.test(item.role))
      ?? manifest.artifacts.find((item) => /\.(step|stp)$/i.test(item.path))
      ?? manifest.artifacts[0]!;
    // Review identity follows the authoritative design, not source/report
    // attachments bundled into the handoff commit.
    const artifactHash = candidate.sha256;
    const contractHash = reviewContractHash(active);
    const key = canonicalDigest({ workflowHash: active.workflow.hash, contractHash, artifactHash });
    const attempts = Object.values(requests(active.state)).filter((item) => item.key === key).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const completed = attempts.find((item) => item.status === "pass" || item.status === "fail" || item.status === "clarification_required");
    if (completed) {
      await this.reapplyCompletedDisposition(completed);
      return { reviewId: completed.reviewId, subjectCommit: completed.subjectCommit, status: completed.status };
    }
    const running = attempts.find((item) => item.status === "running");
    if (running) {
      if (this.inflight.has(running.reviewId)) return { reviewId: running.reviewId, subjectCommit: running.subjectCommit, status: running.status };
      await this.failRuntime(running.reviewId, "reviewer runtime was interrupted before completion", "reviewer-interrupted");
      return this.submit(subjectCommit);
    }
    const attempt = attempts.length;
    const reviewId = `review-${(attempt === 0 ? key : canonicalDigest({ key, attempt })).slice(0, 24)}`;
    const now = new Date().toISOString();
    const stored: StoredReview = { reviewId, subjectCommit, status: "running", key, artifactHash, workflowHash: active.workflow.hash, contractHash, profileId, createdAt: now, updatedAt: now };
    await new HarnessRunStoreV7(this.cwd, active.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, domainMetadata: { ...(state.domainMetadata ?? {}), reviewRequests: jsonValue({ ...requests(state), [reviewId]: stored }) }, updatedAt: now },
      event: { type: "ReviewSubmitted", data: { reviewId, subjectCommit, key, artifactHash } },
    }));
    const requirementsReview = profileId === "mechanical.requirements-review";
    const prompt = requirementsReview ? [
      "You are a fresh, rigorous, independent requirements reviewer running as an ordinary Prime template.",
      "Do not read skills, implementation source, author transcripts, or benchmark ground truth. Do not design or build the requested object.",
      `In IPython run import cad; subject = await cad.load(${JSON.stringify(subjectCommit)}).`,
      "Immediately run context = await cad.review.inspect(). It returns the immutable original request, the author's committed interpretation, and the legal PASS/FAIL dispositions.",
      "Adversarially compare the committed interpretation with the original request before any CAD work begins. Look especially for changed units or scale, wrong numeric referents, diameter/radius/side-length confusion, center-versus-edge offsets, mirrored or reversed spatial relations, wrong boolean direction, contact-versus-overlap-versus-fusion mistakes, omitted constraints, and invented requirements.",
      "Judge semantic fidelity, completeness, and testability—not whether you personally prefer a different design. Preserve legitimate design freedom where the user did not constrain the solution.",
      "Do not resolve a material ambiguity by preference or ordinary convention when two or more reasonable readings would produce materially different geometry, topology, dimensions, or acceptance checks.",
      "PASS only when the request uniquely determines a faithful and sufficiently testable contract. FAIL only when the committed interpretation is definitely contradicted by information already present in the request and can be corrected without new user authority.",
      "Return CLARIFICATION_REQUIRED when missing or ambiguous user intent prevents a unique contract. State the competing interpretations, the geometric impact, and the smallest precise question the user must answer. This is a successful requirements-review outcome, not reviewer failure.",
      "Choose exactly one target from context.dispositions whose verdict matches PASS, FAIL, or CLARIFICATION_REQUIRED. The State Engine applies the transition atomically.",
      `Finish exactly once with await cad.review.resolve(${JSON.stringify(reviewId)}, verdict="pass" | "fail" | "clarification_required", target="<target from context.dispositions>", summary="...", findings=[{"id":"requirements","severity":"info" | "warning" | "error","finding":"...","evidenceRefs":[]}]).`,
      "Only runtime failure may produce UNRESOLVED; it is not a reviewer verdict.",
    ].join("\n") : [
      "You are a fresh, rigorous, independent engineering design reviewer running as an ordinary Prime template.",
      "Do not read skills or source files, inspect APIs, inspect signatures, inspect docstrings, or access author transcripts/source-generation history.",
      `In IPython run import cad; subject = await cad.load(${JSON.stringify(subjectCommit)}).`,
      "Immediately run context = await cad.review.inspect(). It attaches the complete canonical seven-view render set and returns the immutable original request, design case, legal dispositions, and context['candidate'] as the authoritative ArtifactRef ready for cad.probe.run.",
      "Evaluate whether the actual immutable candidate faithfully and credibly solves the original user's request and whether the author's submitted design decisions hold up as engineering. The submission describes intent and claims; it is not proof of its own correctness.",
      "Compare the final candidate against the original request and the author's own committed design intent and artifacts, including concept images attached in context.images. Treat those records as the author's declared intent, not geometry authority; identify material discrepancies without prescribing a particular architecture unless the requirements demand one.",
      "Form and execute your own review plan. Use any available observations and as many or as few independent probes as your professional judgment requires; the harness prescribes no checklist, tool minimum, rollout limit, or evidence quota.",
      "You own the review decision. Investigate enough to make it professionally defensible instead of transferring the burden back to the author. A claim that you can inspect, measure, or reason about from the immutable candidate is yours to evaluate.",
      "When a material claim is measurable from context['candidate'], measure it yourself with await cad.probe.run(subject=context['candidate'], purpose=..., code=...). Missing or weak author-supplied proof is not itself a design defect and must not be used as a shortcut to FAIL; it transfers the inspection work to you. Retry and correct your own probe code if necessary.",
      "Inspect every relevant canonical view yourself. When another direction would resolve a visual question, run the visual preset yourself with await cad.probe.run(subject=context['candidate'], preset='visual', args={'views': ['right']}). You may call it again with other views.",
      "Never FAIL because the author did not provide another screenshot, photograph, render, annotation, or written proof. Base FAIL on a defect or contradiction you personally establish from the immutable candidate, canonical views, or your own probes.",
      "PASS is an affirmative engineering judgment, not the absence of an obvious visual defect. Do not infer material quantitative, kinematic, assembly, strength, manufacturability, or fit claims from appearance alone. If a material accepted claim is neither established by canonical evidence nor independently verified by your review, FAIL and select the phase where it must be repaired or properly established.",
      "The original request, accepted assumptions, and design contract are already pinned. Do not request more external input and do not return an inconclusive verdict. If the candidate is not credibly supportable against that contract, FAIL it.",
      "Choose exactly one target from context.dispositions whose verdict matches your PASS or FAIL. On FAIL choose the phase where the defect should actually be repaired; the State Engine will perform the legal transition and downstream invalidation atomically.",
      `Finish exactly once with await cad.review.resolve(${JSON.stringify(reviewId)}, verdict="pass" | "fail", target="<target from context.dispositions>", summary="...", findings=[{"id":"geometry","severity":"info" | "warning" | "error","finding":"...","evidenceRefs":["..."]}]).`,
      "Only runtime failure may produce UNRESOLVED; it is not a reviewer verdict.",
    ].join("\n");
    const controller = new AbortController();
    this.reviewerControllers.set(reviewId, controller);
    const task = this.executor({ reviewId, subjectCommit, prompt, signal: controller.signal }).then(async () => {
      const current = await this.current(reviewId);
      if (current?.status === "running") await this.failRuntime(reviewId, "reviewer exited without an authoritative result", "empty-review");
    }).catch(async (error) => {
      try { await this.failRuntime(reviewId, `reviewer failed safely: ${error instanceof Error ? error.message : String(error)}`, "reviewer-crash"); }
      catch { /* the run may have been explicitly removed while the reviewer exited */ }
    }).finally(() => { this.inflight.delete(reviewId); this.reviewerControllers.delete(reviewId); });
    this.inflight.set(reviewId, task);
    return { reviewId, subjectCommit, status: "running" };
  }

  async current(reviewId?: string): Promise<ReviewStatusV1 | null> {
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    if (!active) return null;
    const values = Object.values(requests(active.state));
    const item = reviewId ? values.find((value) => value.reviewId === reviewId) : values.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return item ? {
      reviewId: item.reviewId,
      subjectCommit: item.subjectCommit,
      status: item.status,
      ...(item.result ? { result: item.result } : {}),
    } : null;
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
    const conceptRecord = records.find((record) => record.obligationRef === "concept");
    const conceptImages = conceptRecord
      ? (await loadCommittedImages(this.cwd, conceptRecord.artifacts, 1)).map((image) => ({
          ...image,
          evidenceRef: `design-intent:concept:${image.sha256}`,
          source: "committed-design-intent" as const,
          obligationRef: conceptRecord.obligationRef,
        }))
      : [];
    const candidateImages = (await loadMandatoryImages(this.cwd, active.state.contextRefs, 7)).map((image) => ({
      ...image,
      evidenceRef: `visual:${image.sha256}`,
      source: "candidate-view" as const,
    }));
    const images = [...conceptImages, ...candidateImages];
    if (stored.profileId !== "mechanical.requirements-review" && !images.length) throw new Error("canonical review images are unavailable");
    return {
      reviewId,
      subjectCommit,
      workflow: { id: active.workflow.id, version: active.workflow.version, hash: active.workflow.hash },
      phase: active.state.phase,
      originalRequest,
      records,
      candidate,
      images,
      dispositions: dispositionChoices(active.state, active.workflow).map(({ event: _event, ...choice }) => choice),
    };
  }

  async complete(reviewId: string, result: ReviewCompletionV1): Promise<ReviewStatusV1> {
    validateResult(result);
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    if (!active) throw new Error("review run no longer exists");
    const existing = requests(active.state)[reviewId];
    if (!existing) throw new Error(`unknown review: ${reviewId}`);
    if (existing.status !== "running") return {
      reviewId,
      subjectCommit: existing.subjectCommit,
      status: existing.status,
      ...(existing.result ? { result: existing.result } : {}),
    };
    const currentContractHash = reviewContractHash(active);
    if (existing.workflowHash !== active.workflow.hash || existing.contractHash !== currentContractHash) throw new Error("review subject is stale");
    const { manifest } = await loadWorkspaceCommit(this.cwd, mechanicalRegistries, existing.subjectCommit);
    const canonicalCandidate = active.state.artifacts["candidate:authoritative"];
    const artifactHash = (canonicalCandidate
      ?? manifest.artifacts.find((item) => /candidate/i.test(item.role))
      ?? manifest.artifacts.find((item) => /\.(step|stp)$/i.test(item.path))
      ?? manifest.artifacts[0])?.sha256;
    if (artifactHash !== existing.artifactHash) throw new Error("review artifact identity is stale");
    const choice = dispositionChoices(active.state, active.workflow).find((item) => item.verdict === result.verdict && item.target === result.target);
    if (!choice) throw new Error(`review target ${result.target} is not legal for verdict ${result.verdict}`);
    const status = result.verdict;
    const updated: StoredReview = { ...existing, status, result, updatedAt: new Date().toISOString() };
    const path = `reviews/${reviewId}.json`;
    await new HarnessRunStoreV7(this.cwd, active.state.runId).mutate(mechanicalRegistries, (loaded) => {
      const reviewedState = {
        ...loaded.state,
        domainMetadata: { ...(loaded.state.domainMetadata ?? {}), reviewRequests: jsonValue({ ...requests(loaded.state), [reviewId]: updated }) },
        latestReview: { id: reviewId, verdict: status, path, profileId: existing.profileId, subjectHash: canonicalDigest(reviewSubject(loaded)), workflowHash: loaded.workflow.hash, registryContractHash: loaded.registryContract.hash, subjectCommit: existing.subjectCommit, artifactHash: existing.artifactHash },
        updatedAt: updated.updatedAt,
      } satisfies HarnessRunStateV7;
      const next = transitionRun(reviewedState, loaded.workflow, choice.event);
      return {
        state: next,
        event: { type: "ReviewCompletedAndWorkflowTransitioned", data: { reviewId, verdict: status, subjectCommit: existing.subjectCommit, artifactHash, event: choice.event, from: loaded.state.phase, to: choice.target } },
        payloads: { [path]: jsonValue({ schema: 1, ...updated }) },
      };
    });
    const handle: ReviewStatusV1 = { reviewId, subjectCommit: existing.subjectCommit, status, result };
    this.reviewerControllers.get(reviewId)?.abort();
    this.events.emit("completed", handle);
    return handle;
  }

  private async reapplyCompletedDisposition(existing: StoredReview): Promise<void> {
    if (!existing.result || existing.result.verdict === "unresolved") return;
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    if (!active || !active.workflow.phases[active.state.phase]?.reviewProfile) return;
    const choice = dispositionChoices(active.state, active.workflow)
      .find((item) => item.verdict === existing.result!.verdict && item.target === existing.result!.target);
    if (!choice) throw new Error(`cached review target ${existing.result.target} is no longer legal for verdict ${existing.result.verdict}`);
    const path = `reviews/${existing.reviewId}.json`;
    await new HarnessRunStoreV7(this.cwd, active.state.runId).mutate(mechanicalRegistries, (loaded) => {
      const reviewedState = {
        ...loaded.state,
        latestReview: { id: existing.reviewId, verdict: existing.result!.verdict, path, profileId: existing.profileId, subjectHash: canonicalDigest(reviewSubject(loaded)), workflowHash: loaded.workflow.hash, registryContractHash: loaded.registryContract.hash, subjectCommit: existing.subjectCommit, artifactHash: existing.artifactHash },
        updatedAt: new Date().toISOString(),
      } satisfies HarnessRunStateV7;
      return {
        state: transitionRun(reviewedState, loaded.workflow, choice.event),
        event: { type: "ReviewDispositionReused", data: { reviewId: existing.reviewId, verdict: existing.result!.verdict, artifactHash: existing.artifactHash, event: choice.event, from: loaded.state.phase, to: choice.target } },
      };
    });
  }

  private async failRuntime(reviewId: string, summary: string, findingId: string): Promise<ReviewStatusV1> {
    const active = await new HarnessProjectStoreV7(this.cwd).currentRun(mechanicalRegistries);
    if (!active) throw new Error("review run no longer exists");
    const existing = requests(active.state)[reviewId];
    if (!existing) throw new Error(`unknown review: ${reviewId}`);
    if (existing.status !== "running") return { reviewId, subjectCommit: existing.subjectCommit, status: existing.status, ...(existing.result ? { result: existing.result } : {}) };
    const result: ReviewRuntimeFailureV1 = { verdict: "unresolved", summary, findings: [{ id: findingId, severity: "error", finding: summary, evidenceRefs: [] }] };
    const updated: StoredReview = { ...existing, status: "unresolved", result, updatedAt: new Date().toISOString() };
    const path = `reviews/${reviewId}.json`;
    await new HarnessRunStoreV7(this.cwd, active.state.runId).mutate(mechanicalRegistries, ({ state }) => ({
      state: { ...state, domainMetadata: { ...(state.domainMetadata ?? {}), reviewRequests: jsonValue({ ...requests(state), [reviewId]: updated }) }, updatedAt: updated.updatedAt },
      event: { type: "ReviewRuntimeFailed", data: { reviewId, subjectCommit: existing.subjectCommit, summary } },
      payloads: { [path]: jsonValue({ schema: 1, ...updated }) },
    }));
    const handle: ReviewStatusV1 = { reviewId, subjectCommit: existing.subjectCommit, status: "unresolved", result };
    this.reviewerControllers.get(reviewId)?.abort();
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
  }

  async watch(after?: string): Promise<ReviewStatusV1 | null> {
    if (this.closed) return Promise.resolve(null);
    const latest = await this.current();
    if (latest && latest.status !== "running" && latest.reviewId !== after) return latest;
    return new Promise((accept) => {
      const listener = (handle: ReviewStatusV1) => { if (handle.reviewId !== after) { this.events.off("completed", listener); accept(handle); } };
      this.events.on("completed", listener);
      this.events.once("closed", () => { this.events.off("completed", listener); accept(null); });
    });
  }

  async waitForIdle(reviewId: string): Promise<void> { await this.inflight.get(reviewId); }

  shutdown(): void {
    this.closed = true;
    for (const controller of this.reviewerControllers.values()) controller.abort();
    this.events.emit("closed");
  }
}
