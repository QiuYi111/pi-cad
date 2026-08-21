/**
 * SIMULATE shared lifecycle (refactor Phase 6).
 *
 * validate → freeze inputs (run-scoped spec) → execute backend →
 * collect results → observation. The three solvers (structural /
 * flow / thermal) become adapters over this one lifecycle; evidence
 * identity resolution and visual-first observation are shared.
 *
 * Invariants (unchanged from the pre-split tools):
 *   - specs are frozen by writeRunSpec before the solve;
 *   - artifactHash binds to the authoritative source (analysisModel
 *     override > envelope inputHashes > on-disk hash > spec hash);
 *   - images attach only for status="solved";
 *   - the solver never judges pass/fail.
 */
import { resolve } from "node:path";

import {
  flowCommand,
  readImageContents,
  simulationCommand,
  thermalCommand,
} from "../../shared/capability.ts";
import { writeRunSpec } from "../../shared/run-spec.ts";
import { sha256File } from "../../shared/store.ts";
import type { CadEventEnvelope } from "../../shared/protocol.ts";

export type SimulateStage = "validate" | "run";

export interface SimulateAdapter {
  /** Registry id: structural | flow | thermal (+ future). */
  readonly id: string;
  /** Run-spec namespace used by writeRunSpec (spec kind on disk). */
  readonly specKind: string;
  /** Agent-facing evidence kind bound by the control plane. */
  readonly evidenceKind: string;
  run(
    cwd: string,
    stage: SimulateStage,
    specPath: string,
    outputDir: string,
    timeoutMs?: number,
  ): Promise<CadEventEnvelope>;
}

const structuralAdapter: SimulateAdapter = {
  id: "structural",
  specKind: "simulation",
  evidenceKind: "simulation",
  run: (cwd, stage, specPath, outputDir, timeoutMs) =>
    simulationCommand(cwd, stage, specPath, outputDir, timeoutMs),
};

const flowAdapter: SimulateAdapter = {
  id: "flow",
  specKind: "flow",
  evidenceKind: "simulation",
  run: (cwd, stage, specPath, outputDir, timeoutMs) =>
    flowCommand(cwd, stage, specPath, outputDir, timeoutMs),
};

const thermalAdapter: SimulateAdapter = {
  id: "thermal",
  specKind: "thermal",
  evidenceKind: "simulation",
  run: (cwd, stage, specPath, outputDir, timeoutMs) =>
    thermalCommand(cwd, stage, specPath, outputDir, timeoutMs),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ADAPTERS = new Map<string, SimulateAdapter>();

export function registerSimulateAdapter(adapter: SimulateAdapter): void {
  if (ADAPTERS.has(adapter.id)) {
    throw new Error(`simulate adapter already registered: ${adapter.id}`);
  }
  ADAPTERS.set(adapter.id, adapter);
}

function ensureDefaults(): void {
  for (const adapter of [structuralAdapter, flowAdapter, thermalAdapter]) {
    if (!ADAPTERS.has(adapter.id)) ADAPTERS.set(adapter.id, adapter);
  }
}

export function simulateAdapter(id: string): SimulateAdapter {
  ensureDefaults();
  const adapter = ADAPTERS.get(id);
  if (!adapter) throw new Error(`unknown simulate adapter: ${id}`);
  return adapter;
}

export function simulateAdapterIds(): string[] {
  ensureDefaults();
  return [...ADAPTERS.keys()].sort();
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

export interface SimulationSubject {
  /** Artifact path the evidence should bind to (post-analysisModel resolution). */
  artifactPath?: string;
  /** Hash override from analysis-model verification (authoritative source). */
  subjectOverrideHash?: string | null;
  /** Extra input-hash keys that may bind the subject (e.g. fluidDomain). */
  fallbackInputKeys?: string[];
}

export interface SimulateLifecycleInput {
  cwd: string;
  adapter: SimulateAdapter;
  /** Final spec (defaults already applied) — frozen verbatim. */
  spec: Record<string, unknown>;
  subject: SimulationSubject;
  caseId?: string;
  timeoutMs?: number;
  stage?: SimulateStage;
}

export interface SimulateLifecycleResult {
  envelope: CadEventEnvelope;
  specPath: string;
  outputDir: string;
  artifactHash: string;
  specHash: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  solved: boolean;
}

export async function runSimulationLifecycle(
  input: SimulateLifecycleInput,
): Promise<SimulateLifecycleResult> {
  const { cwd, adapter, subject } = input;

  // Freeze inputs: the spec on disk is what the solver sees, hash-bound.
  const { specPath, outputDir } = await writeRunSpec(cwd, adapter.specKind, input.spec);

  const envelope = await adapter.run(
    cwd,
    input.stage ?? "run",
    specPath,
    outputDir,
    input.timeoutMs ?? 3_600_000,
  );

  // Evidence identity: authoritative source > envelope hashes > disk > spec.
  let artifactHash: string | null = subject.subjectOverrideHash ?? null;
  if (!artifactHash) {
    const inputHashes = envelope.inputHashes ?? {};
    if (subject.artifactPath && inputHashes.artifact) {
      artifactHash = inputHashes.artifact;
    } else {
      for (const key of subject.fallbackInputKeys ?? []) {
        if (inputHashes[key]) {
          artifactHash = inputHashes[key];
          break;
        }
      }
    }
    if (!artifactHash && subject.artifactPath) {
      try {
        artifactHash = await sha256File(resolve(cwd, subject.artifactPath));
      } catch {
        // Keep spec hash as provenance fallback.
      }
    }
  }
  if (!artifactHash) artifactHash = envelope.inputHashes.spec ?? "";

  const payload = (envelope.payload ?? {}) as {
    status?: string;
    visualization?: { views?: Array<{ path: string }> };
  };
  const solved = envelope.ok && payload.status === "solved";
  const images = solved
    ? await readImageContents((payload.visualization?.views ?? []).map((v) => v.path))
    : [];

  return {
    envelope,
    specPath,
    outputDir,
    artifactHash,
    specHash: envelope.inputHashes.spec ?? "",
    images,
    solved,
  };
}
