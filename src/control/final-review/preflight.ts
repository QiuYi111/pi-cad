import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  AcceptanceAssertion,
  CadRequirements,
  CadRunState,
  CanonicalAssertionField,
} from "../../shared/protocol.ts";

export interface CanonicalGeometryDigest {
  units?: string;
  bbox?: { x: number; y: number; z: number };
  volume?: number;
  surfaceArea?: number;
  solidCount?: number;
  occurrenceCount?: number;
  cylinderCount?: number;
  sourcePath: string;
}

export interface PreflightAssertionResult {
  assertionId: string;
  field: CanonicalAssertionField;
  expected: unknown;
  observed?: number;
  verdict: "pass" | "fail" | "unresolved";
  delta?: number;
  finding: string;
  evidenceRef: string;
}

export interface FinalReviewPreflightResult {
  digest: CanonicalGeometryDigest | null;
  artifactIntegrity: {
    verdict: "pass";
    finding: string;
    evidenceRef: "preflight:artifact-integrity";
  };
  checks: PreflightAssertionResult[];
  contradictions: PreflightAssertionResult[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeDigest(raw: unknown, sourcePath: string): CanonicalGeometryDigest {
  const envelope = asRecord(raw) ?? {};
  // cadctl inspection files may be either the bare payload or a persisted
  // CadEventEnvelope. Supporting both keeps preflight independent of the
  // observation renderer and closes the historical bare-payload regression.
  const payload = asRecord(envelope.payload) ?? envelope;
  const bboxRaw = payload.bbox;
  let bbox: CanonicalGeometryDigest["bbox"];
  if (Array.isArray(bboxRaw) && bboxRaw.length >= 3) {
    const [x, y, z] = bboxRaw.map(finite);
    if (x !== undefined && y !== undefined && z !== undefined) bbox = { x, y, z };
  } else {
    const box = asRecord(bboxRaw);
    const x = finite(box?.x);
    const y = finite(box?.y);
    const z = finite(box?.z);
    if (x !== undefined && y !== undefined && z !== undefined) bbox = { x, y, z };
  }
  const cylinders = payload.cylinders;
  return {
    ...(typeof payload.units === "string" ? { units: payload.units } : {}),
    ...(bbox ? { bbox } : {}),
    ...(finite(payload.volume) !== undefined ? { volume: finite(payload.volume)! } : {}),
    ...(finite(payload.surfaceArea) !== undefined ? { surfaceArea: finite(payload.surfaceArea)! } : {}),
    ...(finite(payload.solidCount) !== undefined ? { solidCount: finite(payload.solidCount)! } : {}),
    ...(finite(payload.occurrenceCount) !== undefined ? { occurrenceCount: finite(payload.occurrenceCount)! } : {}),
    ...(Array.isArray(cylinders)
      ? { cylinderCount: cylinders.length }
      : finite(payload.cylinderCount) !== undefined
        ? { cylinderCount: finite(payload.cylinderCount)! }
        : {}),
    sourcePath,
  };
}

export async function loadCanonicalGeometryDigest(
  cwd: string,
  state: CadRunState,
): Promise<CanonicalGeometryDigest | null> {
  const ref = [...state.evidence].reverse().find(
    (item) => item.kind === "geometry" && item.artifactHash === state.currentArtifactHash,
  );
  if (!ref) return null;
  const candidates = [...ref.paths, ...(ref.artifacts ?? []).map((item) => item.path)]
    .filter((path, index, all) => path.endsWith(".json") && all.indexOf(path) === index);
  for (const path of candidates) {
    try {
      return normalizeDigest(JSON.parse(await readFile(resolve(cwd, path), "utf-8")), path);
    } catch {
      // A verified evidence ref can still contain non-digest JSON sidecars;
      // continue until a usable payload is found.
    }
  }
  return null;
}

function observedValue(
  digest: CanonicalGeometryDigest,
  field: CanonicalAssertionField,
): number | undefined {
  if (field === "bbox.x" || field === "bbox.y" || field === "bbox.z") {
    return digest.bbox?.[field.slice(-1) as "x" | "y" | "z"];
  }
  return digest[field];
}

function expectedText(assertion: AcceptanceAssertion): string {
  const expectation = assertion.expectation;
  if (expectation.kind === "exact") return `${expectation.value}${expectation.unit ? ` ${expectation.unit}` : ""}`;
  if (expectation.kind === "range") return `[${expectation.min ?? "-∞"}, ${expectation.max ?? "+∞"}]${expectation.unit ? ` ${expectation.unit}` : ""}`;
  if (expectation.kind === "boolean") return String(expectation.expected);
  return expectation.description;
}

function compareCanonical(
  assertion: AcceptanceAssertion,
  observed: number | undefined,
  evidenceRef: string,
): PreflightAssertionResult {
  const field = assertion.canonicalCheck!.field;
  const expected = assertion.expectation;
  const base = { assertionId: assertion.id, field, expected, observed, evidenceRef };
  if (observed === undefined || (expected.kind !== "exact" && expected.kind !== "range")) {
    return {
      ...base,
      verdict: "unresolved",
      finding: `${field} cannot deterministically establish expectation ${expectedText(assertion)}`,
    };
  }
  if (expected.kind === "exact") {
    const delta = observed - expected.value;
    const countField = field.endsWith("Count");
    const tolerance = countField
      ? 0
      : expected.tolerance ?? Math.max(1e-9, Math.abs(expected.value) * 1e-6);
    const pass = Math.abs(delta) <= tolerance;
    return {
      ...base,
      delta,
      verdict: pass ? "pass" : "fail",
      finding: `${field}: expected ${expectedText(assertion)}, observed ${observed}, delta ${delta}`,
    };
  }
  const pass = (expected.min === undefined || observed >= expected.min) &&
    (expected.max === undefined || observed <= expected.max);
  return {
    ...base,
    verdict: pass ? "pass" : "fail",
    finding: `${field}: expected ${expectedText(assertion)}, observed ${observed}`,
  };
}

export async function runFinalReviewPreflight(
  cwd: string,
  state: CadRunState,
  requirements: CadRequirements,
): Promise<FinalReviewPreflightResult> {
  const digest = await loadCanonicalGeometryDigest(cwd, state);
  const checks = requirements.assertions
    .filter((assertion) => assertion.canonicalCheck)
    .map((assertion) => compareCanonical(
      assertion,
      digest ? observedValue(digest, assertion.canonicalCheck!.field) : undefined,
      digest?.sourcePath ?? "geometry:digest-unavailable",
    ));
  return {
    digest,
    artifactIntegrity: {
      verdict: "pass",
      finding: state.route?.objective === "analyze"
        ? "Harness verified that the bound input artifact exists and matches its recorded hash."
        : "Harness verified that the bound generating source and current artifact both exist and match their recorded hashes. Source contents are intentionally withheld from the reviewer.",
      evidenceRef: "preflight:artifact-integrity",
    },
    checks,
    contradictions: checks.filter((check) => check.verdict === "fail"),
  };
}
