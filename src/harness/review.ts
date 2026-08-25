import { randomUUID } from "node:crypto";

import { canonicalDigest, jsonValue, type JsonValue } from "./canonical.ts";
import type { RegistrySet } from "./registry.ts";
import { HarnessRunStoreV7, type LoadedHarnessRunV7 } from "./run-store.ts";
import { readObservationPayloadV7, readObservationV7, type ObservationIndexV1 } from "./observations.ts";

export interface ProgrammableObservationV1 {
  observationId: string;
  subjectHash: string;
  purpose: string;
  code: string;
  scriptHash: string;
  expectedResult: JsonValue;
  expectedResultDigest: string;
}

export interface ReviewVerdictV1 {
  schema: 1;
  verdict: "pass" | "fail" | "unresolved";
  summary: string;
  findings: Array<{ id: string; severity: "info" | "warning" | "error"; finding: string; evidenceRefs: string[] }>;
}

export interface ReviewProfileImplementationV1 {
  id: string;
  version: string;
  allowedActions: string[];
  preflight(loaded: LoadedHarnessRunV7): string[];
  prompt(loaded: LoadedHarnessRunV7, cwd: string): string | Promise<string>;
}

export interface FreshReviewExecutorV1 {
  execute(input: {
    reviewId: string;
    profileId: string;
    prompt: string;
    allowedActions: string[];
    artifacts: Record<string, { id: string; path: string; sha256: string; role: string }>;
    programmableObservations: ProgrammableObservationV1[];
  }): Promise<ReviewVerdictV1>;
}

function subject(loaded: LoadedHarnessRunV7): JsonValue {
  return jsonValue({
    workflowHash: loaded.workflow.hash,
    registryContractHash: loaded.registryContract.hash,
    phase: loaded.state.phase,
    records: loaded.state.records,
    artifacts: loaded.state.artifacts,
    evidence: loaded.state.evidence,
    latestObservation: loaded.state.contextRefs?.latestObservation ?? null,
  });
}

async function programmableObservations(
  cwd: string,
  loaded: LoadedHarnessRunV7,
  store: HarnessRunStoreV7,
): Promise<ProgrammableObservationV1[]> {
  const candidateHashes = new Set(Object.values(loaded.state.artifacts).map((item) => item.sha256));
  const index = await store.transactions.readJson<ObservationIndexV1>("indexes/observations.json");
  if (!index || index.schema !== 1) return [];
  const result: ProgrammableObservationV1[] = [];
  for (const ref of index.entries) {
    if (result.length >= 32 || (ref.preset && ref.preset !== "python") || !ref.subjectHash || !candidateHashes.has(ref.subjectHash)) continue;
    const snapshot = await readObservationV7({ cwd, workflowRunId: loaded.state.runId, id: ref.id });
    if (snapshot.preset !== "python") continue;
    const provenance = snapshot.provenance && typeof snapshot.provenance === "object" && !Array.isArray(snapshot.provenance)
      ? (snapshot.provenance as Record<string, JsonValue>).programmableProbe
      : undefined;
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) continue;
    const contract = provenance as Record<string, JsonValue>;
    if (contract.protocol !== "pi-cad/programmable-probe/v1" || typeof contract.code !== "string" || typeof contract.purpose !== "string" || typeof contract.scriptHash !== "string") continue;
    const payload = await readObservationPayloadV7({ cwd, workflowRunId: loaded.state.runId, id: ref.id });
    const expectedResult = payload && typeof payload === "object" && !Array.isArray(payload) && "result" in payload
      ? (payload as Record<string, JsonValue>).result ?? null
      : payload;
    result.push({ observationId: ref.id, subjectHash: ref.subjectHash, purpose: contract.purpose, code: contract.code, scriptHash: contract.scriptHash, expectedResult, expectedResultDigest: canonicalDigest(expectedResult) });
  }
  return result;
}

function validateVerdict(value: ReviewVerdictV1): void {
  if (value.schema !== 1 || !["pass", "fail", "unresolved"].includes(value.verdict) || typeof value.summary !== "string" || !Array.isArray(value.findings)) throw new Error("fresh reviewer returned an invalid verdict");
  for (const finding of value.findings) {
    if (!finding || typeof finding.id !== "string" || !["info", "warning", "error"].includes(finding.severity) || typeof finding.finding !== "string" || !Array.isArray(finding.evidenceRefs) || finding.evidenceRefs.some((item) => typeof item !== "string")) throw new Error("fresh reviewer returned an invalid finding");
  }
}

export async function runFreshReviewV7(input: {
  cwd: string;
  workflowRunId: string;
  registries: RegistrySet;
  profile: ReviewProfileImplementationV1;
  executor: FreshReviewExecutorV1;
}) {
  const store = new HarnessRunStoreV7(input.cwd, input.workflowRunId);
  const loaded = await store.load(input.registries);
  if (!loaded) throw new Error(`v7 run does not exist: ${input.workflowRunId}`);
  const phase = loaded.workflow.phases[loaded.state.phase]!;
  if (phase.reviewProfile !== input.profile.id) throw new Error(`review profile is not current: ${input.profile.id}`);
  const registration = input.registries.reviewProfiles.require(input.profile.id);
  if (registration.contract.version !== input.profile.version) throw new Error(`review profile version mismatch: ${input.profile.id}`);
  for (const action of input.profile.allowedActions) input.registries.actions.require(action);
  const issues = input.profile.preflight(loaded);
  if (issues.length) throw new Error(`review preflight failed: ${issues.join("; ")}`);
  const observations = await programmableObservations(input.cwd, loaded, store);
  const subjectHash = canonicalDigest(subject(loaded));
  if (loaded.state.latestReview?.subjectHash === subjectHash) return loaded;
  const reviewId = `review-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const result = await input.executor.execute({
    reviewId,
    profileId: input.profile.id,
    prompt: await input.profile.prompt(loaded, input.cwd),
    allowedActions: [...input.profile.allowedActions],
    artifacts: structuredClone(loaded.state.artifacts),
    programmableObservations: observations,
  });
  validateVerdict(result);
  const path = `reviews/${reviewId}.json`;
  return store.mutate(input.registries, async (current) => {
    if (canonicalDigest(subject(current)) !== subjectHash) throw new Error("review subject changed while fresh reviewer was running");
    return {
      state: {
        ...current.state,
        latestReview: { id: reviewId, verdict: result.verdict, path, profileId: input.profile.id, subjectHash, workflowHash: current.workflow.hash, registryContractHash: current.registryContract.hash },
        updatedAt: new Date().toISOString(),
      },
      event: { type: "FreshReviewCompleted", data: { reviewId, profileId: input.profile.id, verdict: result.verdict, subjectHash } },
      payloads: { [path]: jsonValue({ schema: 1, reviewId, profileId: input.profile.id, subjectHash, workflowHash: current.workflow.hash, registryContractHash: current.registryContract.hash, result }) },
    };
  });
}
