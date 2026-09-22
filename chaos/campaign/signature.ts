import { FAULT_BOUNDARIES } from "../reify/faults.ts";
import type { ReifyFailureArtifact } from "../reify/artifacts.ts";
import type { Command } from "../reify/model.ts";
import type { FailureCluster, FailureNature, FaultBoundary } from "./types.ts";

export interface FailureInput {
  roundIndex: number;
  seed: number;
  artifactPath: string;
  commit: string | null;
  runtimeMode: boolean;
  artifact: ReifyFailureArtifact;
}

/**
 * Drop the parts of a failure message that are real but not identifying: pids,
 * ports, ms, paths, hashes. Two runs of the same bug must land on the same
 * string, otherwise dedupe does nothing.
 */
export function normalizeText(text: string): string {
  return text
    // The harness's own temp project dir is different every round, so it never
    // identifies a bug.
    .replace(/\/tmp\/[^\s'",;)]+/g, "/tmp/#")
    .replace(/0x[0-9a-fA-F]+/g, "#")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "#")
    .replace(/[0-9a-fA-F]{16,}/g, "#")
    // Real ids the product generates (`v7-1790022485343-1fcc3d90`) are
    // different every round and never identify a bug.
    .replace(/\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{6,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/#{2,}/g, "#")
    .replace(/#(?:\s+#)+/g, "#")
    // "1 个 kernel ..." and "2 个 kernel ..." are the same bug seen twice, not
    // two bugs: the count is multiplicity, not identity.
    .replace(/^#\s*个\s*/, "N 个 ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The commands that really ran, in order, without the params. */
export function commandShape(commands: Command[]): string[] {
  return commands.map((command) => `${command.kind}:${command.name}`);
}

/**
 * The step that was running when the system broke: the last command the round
 * really executed. That is what distinguishes "orphan kernel after killing the
 * authority" from "orphan kernel after killing the runtime".
 */
export function failingStepOf(artifact: ReifyFailureArtifact): string {
  const executed = artifact.replaySequence?.length ? artifact.replaySequence : artifact.shrunkSequence;
  const last = executed.at(-1);
  return last ? `${last.kind}:${last.name}` : "unknown";
}

/** The real boundary the failure's faults hit, when the faults say so. */
export function boundaryOf(artifact: ReifyFailureArtifact): FaultBoundary | "unknown" {
  const executed = artifact.replaySequence?.length ? artifact.replaySequence : artifact.shrunkSequence;
  const last = executed.at(-1);
  if (last?.kind === "fault" && FAULT_BOUNDARIES[last.name]) return FAULT_BOUNDARIES[last.name];
  const boundaries = executed
    .filter((command) => command.kind === "fault")
    .map((command) => FAULT_BOUNDARIES[command.name])
    .filter((boundary): boundary is FaultBoundary => Boolean(boundary));
  return boundaries.at(-1) ?? "unknown";
}

/**
 * The log line that describes how it failed, ignoring the harness's own
 * bookkeeping notes.
 */
export function logSignatureOf(artifact: ReifyFailureArtifact): string {
  const generic = /^(campaign|fault .* 不适用|未知 |组件观测失败)/;
  const lines = [...(artifact.logs ?? [])]
    .map((line) => normalizeText(line))
    .filter((line) => line.length > 0 && !generic.test(line));
  return lines.at(-1) ?? "";
}

/**
 * The dedupe key: what invariant broke, and how it read once the identifying
 * parts were removed. Everything else (pids, run ids, temp dirs, seeds, exact
 * sequences, which command happened to run last, which fault happened to be
 * armed earlier, how many orphans this round leaked) is evidence, not
 * identity: the same root cause must not become a new issue because the
 * generator appended one more step. Boundaries, steps, shapes and log lines
 * are all kept on the cluster instead.
 */
export function failureSignature(artifact: ReifyFailureArtifact): string {
  return [artifact.invariant, normalizeText(artifact.detail ?? "")].join(" | ");
}

/**
 * Whether this failure is a product finding or the harness tripping over its
 * own fault injection. `fault-outcome-honest` means a fault step threw a real
 * exception; when that exception is a permission/missing-file error from the
 * file-state faults, it came from the harness's own file handling, and calling
 * it a product bug would be a false positive by construction.
 */
export function failureNature(artifact: ReifyFailureArtifact): FailureNature {
  if (artifact.invariant !== "fault-outcome-honest") return "product";
  const failed = (artifact.faultOutcomes ?? []).find((outcome) => outcome.status === "InjectionFailed");
  const reason = `${failed?.reason ?? ""} ${artifact.detail ?? ""}`;
  // The harness tripping over its own fault injection: a permission/missing
  // file error while it manipulates its own files, or asking a surface for an
  // operation that surface simply does not have.
  if (boundaryOf(artifact) === "file-state" && HARNESS_FILE_ERROR.test(reason)) return "harness";
  return /does not expose operation/.test(reason)
    ? "harness"
    : "product";
}

const HARNESS_FILE_ERROR = /\b(EACCES|EPERM|ENOENT|EISDIR|ENOTDIR|EROFS)\b|permission denied|no such file or directory/;

function clusterId(signature: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `c${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * One bug, one cluster: group by signature and keep every distinct sequence
 * shape as evidence instead of inventing a new issue per random failure.
 */
export function clusterFailures(inputs: FailureInput[]): FailureCluster[] {
  const lengthByPath = new Map(
    inputs.map((input) => [
      input.artifactPath,
      input.artifact.replaySequence?.length ?? input.artifact.shrunkSequence.length,
    ]),
  );
  const bySignature = new Map<string, FailureCluster>();
  for (const input of inputs) {
    const signature = failureSignature(input.artifact);
    const shape = commandShape(input.artifact.replaySequence?.length ? input.artifact.replaySequence : input.artifact.shrunkSequence);
    const shapeKey = shape.join(">");
    let cluster = bySignature.get(signature);
    if (!cluster) {
      cluster = {
        id: clusterId(signature),
        signature,
        invariant: input.artifact.invariant,
        boundary: boundaryOf(input.artifact),
        boundaries: [boundaryOf(input.artifact)],
        nature: failureNature(input.artifact),
        failingSteps: [failingStepOf(input.artifact)],
        reason: normalizeText(input.artifact.detail ?? ""),
        logSignatures: [logSignatureOf(input.artifact)].filter((line) => line.length > 0),
        shapes: [],
        occurrences: 0,
        roundIndexes: [],
        seeds: [],
        artifactPaths: [],
        representative: input.artifactPath,
        firstSeenAt: input.artifact.createdAt,
        lastSeenAt: input.artifact.createdAt,
        runtimeModes: [],
        commits: [],
        verdict: "unverified",
      };
      bySignature.set(signature, cluster);
    }
    cluster.occurrences += 1;
    cluster.roundIndexes.push(input.roundIndex);
    cluster.seeds.push(input.seed);
    cluster.artifactPaths.push(input.artifactPath);
    const failingStep = failingStepOf(input.artifact);
    if (!cluster.failingSteps.includes(failingStep)) cluster.failingSteps.push(failingStep);
    const boundary = boundaryOf(input.artifact);
    if (!cluster.boundaries.includes(boundary)) cluster.boundaries.push(boundary);
    const logSignature = logSignatureOf(input.artifact);
    if (logSignature && !cluster.logSignatures.includes(logSignature)) cluster.logSignatures.push(logSignature);
    if (!cluster.shapes.some((existing) => existing.join(">") === shapeKey)) cluster.shapes.push(shape);
    if (!cluster.runtimeModes.includes(input.runtimeMode)) cluster.runtimeModes.push(input.runtimeMode);
    if (input.commit && !cluster.commits.includes(input.commit)) cluster.commits.push(input.commit);
    if (input.artifact.createdAt < cluster.firstSeenAt) cluster.firstSeenAt = input.artifact.createdAt;
    if (input.artifact.createdAt > cluster.lastSeenAt) cluster.lastSeenAt = input.artifact.createdAt;
  }
  // Triage should shrink the smallest real evidence in the cluster, not the
  // longest sequence that happened to land there first.
  for (const cluster of bySignature.values()) {
    let best = cluster.representative;
    let bestLength = Number.POSITIVE_INFINITY;
    for (const path of cluster.artifactPaths) {
      const length = lengthByPath.get(path) ?? Number.POSITIVE_INFINITY;
      if (length < bestLength) {
        bestLength = length;
        best = path;
      }
    }
    cluster.representative = best;
  }
  return [...bySignature.values()].sort((a, b) => b.occurrences - a.occurrences || a.signature.localeCompare(b.signature));
}
