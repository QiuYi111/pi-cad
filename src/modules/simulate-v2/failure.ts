import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SimulationFailureStage = "manifest" | "inputs" | "runtime" | "compute" | "observe" | "validate" | "quota" | "interrupted";
export type SimulationFailureOwner = "recipe" | "input" | "runtime" | "harness";

export interface SimulationFailure {
  stage: SimulationFailureStage;
  code: string;
  fingerprint: string;
  retryable: boolean;
  likelyOwner: SimulationFailureOwner;
  suggestedAction: string;
  message: string;
  runId?: string;
  observationId?: string;
  logCollections?: string[];
  previousOccurrences?: number;
  retryRequires?: string[];
  issues?: Array<{ stage: SimulationFailureStage; code: string; message: string; likelyOwner: SimulationFailureOwner; suggestedAction: string }>;
}

export function simulationFailure(input: Omit<SimulationFailure, "fingerprint">): SimulationFailure {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ stage: input.stage, code: input.code, message: input.message, issues: input.issues }))
    .digest("hex");
  return { ...input, fingerprint };
}

function failuresPath(cwd: string, workflowRunId: string): string {
  return join(cwd, ".pi-cad", "runs", workflowRunId, "simulation", "failures.jsonl");
}

export async function recordSimulationFailure(cwd: string, workflowRunId: string, failure: SimulationFailure): Promise<SimulationFailure> {
  const path = failuresPath(cwd, workflowRunId);
  let previous = 0;
  try {
    const raw = await readFile(path, "utf-8");
    previous = raw.split(/\r?\n/).filter(Boolean).reduce((count, line) => {
      try { return (JSON.parse(line) as { fingerprint?: string }).fingerprint === failure.fingerprint ? count + 1 : count; }
      catch { return count; }
    }, 0);
  } catch {
    // The first occurrence creates the journal.
  }
  const retryRequires = previous > 0 ? retryRequirements(failure.likelyOwner) : undefined;
  const recorded = {
    ...failure,
    previousOccurrences: previous,
    ...(retryRequires ? { retryRequires } : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...recorded })}\n`, "utf-8");
  return recorded;
}

function retryRequirements(owner: SimulationFailureOwner): string[] {
  if (owner === "recipe") return ["change the Recipe/observer file identified by the failure", "or select a different valid output request"];
  if (owner === "input") return ["supply or change the missing/invalid declared input", "or revise the manifest declaration"];
  if (owner === "runtime") return ["runtime readiness, installed files, driver, or accelerator state must change", "or explicitly choose another registered runtime"];
  return ["harness/runtime state or the failing implementation must change before retry"];
}

export function renderSimulationFailure(failure: SimulationFailure): string {
  return [
    `Simulation failed at ${failure.stage}: ${failure.code}`,
    failure.message,
    `fingerprint=${failure.fingerprint}`,
    `retryable=${failure.retryable} likelyOwner=${failure.likelyOwner}`,
    `suggestedAction=${failure.suggestedAction}`,
    ...(failure.previousOccurrences ? [`sameFailurePreviously=${failure.previousOccurrences}`] : []),
    ...(failure.retryRequires?.length ? [`Retry only after: ${failure.retryRequires.join("; ")}`] : []),
    ...(failure.issues?.length ? ["Preflight issues:", ...failure.issues.map((item) => `- [${item.stage}/${item.code}] ${item.message}; next=${item.suggestedAction}`)] : []),
    ...(failure.runId ? [`runId=${failure.runId}`] : []),
    ...(failure.observationId ? [`observationId=${failure.observationId}`] : []),
    ...(failure.logCollections?.length ? [`logCollections=${failure.logCollections.join(",")}`] : []),
  ].join("\n").slice(0, 8192);
}
