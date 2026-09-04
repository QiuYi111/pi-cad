/**
 * ModelBackend interface (refactor Phase 5).
 *
 * The workflow layer depends on THIS interface, never on build123d or
 * cadctl directly. The first backend is build123d (via `python -m
 * cadctl`); future backends (CadQuery, OpenCascade, FreeCAD) register
 * here without touching workflow code.
 *
 * Contract (design doc §8 contract tests):
 *   - build() returns a CadEventEnvelope whose artifacts carry the
 *     produced STEP path + sha256 (deterministic output);
 *   - provenance (inputHashes.source, backendVersion) is filled by the
 *     backend, not synthesized by callers;
 *   - artifact binding: envelope artifacts[kind="step"] must exist on
 *     success.
 */
import type { CadEventEnvelope } from "../../shared/protocol.ts";
import { buildStep, exportArtifact } from "../../shared/capability.ts";
import type { ModelParameterValue } from "../../shared/model-parameters.ts";

export interface ModelBuildInput {
  source: string;
  output: string;
  force?: boolean;
  parameters?: Record<string, ModelParameterValue>;
}

export interface ModelExportInput {
  source: string;
  output: string;
  format: string;
}

export interface ModelBackend {
  readonly id: string;
  /** Human-readable backend version provenance (envelope backendVersion). */
  readonly label: string;
  build(cwd: string, input: ModelBuildInput, timeoutMs?: number): Promise<CadEventEnvelope>;
  export(cwd: string, input: ModelExportInput, timeoutMs?: number): Promise<CadEventEnvelope>;
}

/** The reference backend: build123d through the cadctl CLI wire contract. */
export class Build123dBackend implements ModelBackend {
  readonly id = "build123d";
  readonly label = "build123d (cadctl)";

  build(cwd: string, input: ModelBuildInput, timeoutMs?: number): Promise<CadEventEnvelope> {
    return buildStep(cwd, input, timeoutMs);
  }

  export(cwd: string, input: ModelExportInput, timeoutMs?: number): Promise<CadEventEnvelope> {
    return exportArtifact(cwd, input, timeoutMs);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const BACKENDS = new Map<string, ModelBackend>();

export function registerModelBackend(backend: ModelBackend): void {
  if (BACKENDS.has(backend.id)) {
    throw new Error(`model backend already registered: ${backend.id}`);
  }
  BACKENDS.set(backend.id, backend);
}

function ensureDefaults(): void {
  if (!BACKENDS.has("build123d")) {
    registerModelBackend(new Build123dBackend());
  }
}

export const DEFAULT_MODEL_BACKEND = "build123d";

export function modelBackend(id: string = DEFAULT_MODEL_BACKEND): ModelBackend {
  ensureDefaults();
  const backend = BACKENDS.get(id);
  if (!backend) throw new Error(`unknown model backend: ${id}`);
  return backend;
}

export function modelBackendIds(): string[] {
  ensureDefaults();
  return [...BACKENDS.keys()].sort();
}
