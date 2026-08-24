import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { canonicalDigest, jsonValue, type JsonValue } from "../../harness/canonical.ts";
import { commitEvidenceRef, transitionRun, unmetPhaseObligations } from "../../harness/reducer.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../../harness/run-store.ts";
import type { EvidenceRefV7, HarnessRunStateV7 } from "../../harness/state.ts";
import type { WorkflowObligationDefinition, WorkflowSnapshotV1 } from "../../harness/workflow/types.ts";
import { buildProposal, convertProposal, type CandidateProposal } from "../../modules/model/finalizer.ts";
import {
  assemblyTree,
  compareGeometry,
  inspectGeometry,
  inspectInterference,
  inspectVisual,
  readImageContents,
  runAssemblyEvidencePath,
  runCompareEvidencePath,
  runGeometryEvidencePath,
  runInterferenceEvidencePath,
  runVisualEvidenceDir,
} from "../../shared/capability.ts";
import type { CadEventEnvelope } from "../../shared/protocol.ts";
import { mechanicalRegistries } from "./registries.ts";

interface ProducedEvidence {
  obligation: WorkflowObligationDefinition;
  envelope: CadEventEnvelope;
}

function projectPath(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const result = relative(resolve(cwd), absolute).replaceAll("\\", "/");
  if (!result || result === ".." || result.startsWith("../") || isAbsolute(result)) throw new Error(`candidate path escapes project: ${path}`);
  return result;
}

async function baselinePath(cwd: string, run: HarnessRunStateV7): Promise<string | null> {
  const project = await new HarnessProjectStoreV7(cwd).load();
  const head = Object.values(project.state.head.artifacts).find((item) => /authoritative|design|candidate/i.test(item.role)) ?? Object.values(project.state.head.artifacts)[0];
  if (head?.path && existsSync(resolve(cwd, head.path))) return head.path;
  const requirements = run.records["record:requirements"];
  if (!requirements) return null;
  const record = await new HarnessRunStoreV7(cwd, run.runId).transactions.readJson<{ inputs?: string[] }>(requirements.path);
  return record?.inputs?.find((item) => /\.(?:step|stp)$/i.test(item) && existsSync(resolve(cwd, item))) ?? null;
}

async function produceEvidence(input: {
  cwd: string;
  runId: string;
  label: string;
  proposal: CandidateProposal;
  obligations: WorkflowObligationDefinition[];
  state: HarnessRunStateV7;
}): Promise<{ evidence: ProducedEvidence[]; visualPaths: string[] }> {
  const artifact = input.proposal.artifactPath;
  const evidence: ProducedEvidence[] = [];
  const visualPaths: string[] = [];
  for (const obligation of input.obligations) {
    let envelope: CadEventEnvelope;
    if (obligation.type === "visual") {
      envelope = await inspectVisual(input.cwd, artifact, runVisualEvidenceDir(input.cwd, input.runId, artifact));
      if (envelope.ok) visualPaths.push(...envelope.artifacts.filter((item) => item.kind === "image").map((item) => item.path));
    } else if (obligation.type === "geometry") {
      envelope = await inspectGeometry(input.cwd, artifact, runGeometryEvidencePath(input.cwd, input.runId, artifact));
    } else if (obligation.type === "assembly") {
      envelope = await assemblyTree(input.cwd, artifact, runAssemblyEvidencePath(input.cwd, input.runId, artifact));
    } else if (obligation.type === "interference") {
      envelope = await inspectInterference(input.cwd, artifact, runInterferenceEvidencePath(input.cwd, input.runId, artifact));
    } else if (obligation.type === "compare") {
      const baseline = await baselinePath(input.cwd, input.state);
      if (!baseline) throw new Error("candidate compare evidence requires a bound baseline STEP");
      envelope = await compareGeometry(input.cwd, baseline, artifact, runCompareEvidencePath(input.cwd, input.runId, input.label));
    } else {
      throw new Error(`cad_commit_candidate has no primitive producer for evidence type ${obligation.type}`);
    }
    if (!envelope.ok) throw new Error(`candidate ${obligation.type} observation failed: ${String(envelope.payload.error ?? "unknown error")}`);
    evidence.push({ obligation, envelope });
  }
  return { evidence, visualPaths };
}

function evidenceRef(workflow: WorkflowSnapshotV1, registryContractHash: string, item: ProducedEvidence): EvidenceRefV7 {
  const sha256 = canonicalDigest(item.envelope);
  const id = `evidence-${item.obligation.type}-${sha256.slice(0, 20)}`;
  return {
    id,
    obligationRef: item.obligation.ref,
    type: item.obligation.type,
    path: `evidence/${item.obligation.type}/${id}.json`,
    sha256,
    workflowHash: workflow.hash,
    registryContractHash,
    computeIdentity: canonicalDigest({ tool: item.envelope.tool, toolVersion: item.envelope.toolVersion, inputHashes: item.envelope.inputHashes, outputHashes: item.envelope.outputHashes }),
    createdAt: new Date().toISOString(),
  };
}

export async function commitMechanicalCandidateV7(input: {
  cwd: string;
  sources: string[];
  label: string;
  format?: string;
  output?: string;
}) {
  const loaded = await new HarnessProjectStoreV7(input.cwd).currentRun(mechanicalRegistries);
  if (!loaded) throw new Error("cad_commit_candidate requires an active v7 run");
  const phase = loaded.workflow.phases[loaded.state.phase]!;
  if (!phase.actions.includes("cad_commit_candidate")) throw new Error(`cad_commit_candidate is not enabled in phase ${loaded.state.phase}`);
  const source = input.sources[0];
  if (!source) throw new Error("cad_commit_candidate requires at least one source");
  let proposalResult;
  if (loaded.state.phase === "convert" && /\.(?:step|stp)$/i.test(source)) {
    if (!input.format) throw new Error("convert candidate requires format");
    const output = input.output ?? `${source.replace(/\.(?:step|stp)$/i, "")}.${input.format}`;
    proposalResult = await convertProposal(input.cwd, source, input.label, input.format, output);
  } else {
    proposalResult = await buildProposal(input.cwd, source, input.label);
  }
  if (!proposalResult.ok) throw new Error("buildFailed" in proposalResult ? `candidate build failed: ${proposalResult.error}\n${proposalResult.stderr}` : proposalResult.text);
  const proposal = proposalResult.proposal;
  const obligations = phase.evidenceObligations.filter((item) => item.closeWith === "cad_commit_candidate");
  const produced = await produceEvidence({ cwd: input.cwd, runId: loaded.state.runId, label: input.label, proposal, obligations, state: loaded.state });
  const sourcePath = projectPath(input.cwd, proposal.source);
  const artifactPath = projectPath(input.cwd, proposal.artifactPath);
  const record = {
    schema: 1, label: input.label, kind: proposal.kind, sources: input.sources, sourcePath, sourceHash: proposal.sourceHash,
    artifactPath, artifactHash: proposal.artifactHash, createdAt: new Date().toISOString(),
  };
  const committed = await new HarnessRunStoreV7(input.cwd, loaded.state.runId).mutate(mechanicalRegistries, ({ state, workflow, registryContract }) => {
    const staleEvidence = [...state.staleEvidence, ...state.evidence];
    let next: HarnessRunStateV7 = {
      ...state,
      artifacts: {
        ...state.artifacts,
        "candidate:source": { id: "candidate:source", path: sourcePath, sha256: proposal.sourceHash, role: "candidate-source" },
        "candidate:authoritative": { id: "candidate:authoritative", path: artifactPath, sha256: proposal.artifactHash, role: "authoritative-candidate-design" },
      },
      evidence: [], staleEvidence, latestReview: undefined,
      domainMetadata: { ...(state.domainMetadata ?? {}), candidate: jsonValue(record) },
      updatedAt: new Date().toISOString(),
    };
    const payloads: Record<string, JsonValue> = { [`records/candidates/${proposal.artifactHash}.json`]: jsonValue(record) };
    for (const item of produced.evidence) {
      const ref = evidenceRef(workflow, registryContract.hash, item);
      next = commitEvidenceRef(next, workflow, registryContract, ref);
      payloads[ref.path] = jsonValue({ schema: 1, evidence: ref, envelope: item.envelope });
    }
    const transition = workflow.phases[next.phase]!.transitions.candidate_committed;
    if (transition && unmetPhaseObligations(next, workflow).length === 0) next = transitionRun(next, workflow, "candidate_committed");
    return {
      state: next,
      event: { type: "MechanicalCandidateCommitted", data: { label: input.label, sourceHash: proposal.sourceHash, artifactHash: proposal.artifactHash, evidence: produced.evidence.map((item) => item.obligation.ref), autoTransitioned: next.phase !== state.phase } },
      payloads,
    };
  });
  return { loaded: committed, proposal, images: await readImageContents(produced.visualPaths), pending: unmetPhaseObligations(committed.state, committed.workflow) };
}
