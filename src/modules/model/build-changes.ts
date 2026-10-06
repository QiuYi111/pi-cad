/**
 * What changed between two builds of the same output.
 *
 * Both model backends (build123d and FreeCAD) feed the same summary: volume,
 * area, bounding box and face deltas come from the geometry evidence of the
 * previous and the current build. Faces have no stable handles across builds,
 * so they are matched by fingerprint. The matching rule is the same as
 * `python/cadctl/fingerprints.py`; both sides run the vectors in
 * `tests/fixtures/face-fingerprints`.
 */
import type { FaceFingerprint, GeometryPayload } from "../../shared/protocol.ts";

export type { FaceFingerprint } from "../../shared/protocol.ts";

export const CENTROID_TOLERANCE = 1e-3;
export const AREA_TOLERANCE = 1e-3;
export const DIRECTION_DOT = 0.9999;
export const RADIUS_TOLERANCE = 1e-3;
/** Highlight and label payloads stay small enough for a command line. */
export const MAX_HIGHLIGHT_FACES = 2000;

const ABSOLUTE_EPSILON = 1e-6;
const RELATIVE_EPSILON = 1e-9;

export interface Change<T> { before: T | null; after: T; delta?: number | null }

/** Feature-level facts that only the FreeCAD backend can supply. */
export interface FeatureChanges {
  features?: { recomputed?: string[]; added?: string[]; removed?: string[] };
  params?: { changed?: Record<string, [unknown, unknown]> };
  intent?: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  highlight?: { paths?: string[] };
}

export interface BuildChanges {
  schema: 1;
  baseline: { sha256: string } | null;
  volumeMm3: { before: number | null; after: number | null; delta: number | null };
  areaMm2: { before: number | null; after: number | null; delta: number | null };
  bboxMm: { before: number[] | null; after: number[] | null; changed: boolean };
  solids: { before: number | null; after: number | null };
  faces: { before: number | null; after: number | null; new: number | null; removed: number | null };
  features?: FeatureChanges["features"];
  params?: FeatureChanges["params"];
  intent?: FeatureChanges["intent"];
  warnings?: FeatureChanges["warnings"];
}

export interface FaceMatch {
  pairs: Array<[number, number]>;
  unmatchedBefore: number[];
  unmatchedAfter: number[];
}

function differs(a: number, b: number): boolean {
  return Math.abs(a - b) > ABSOLUTE_EPSILON + RELATIVE_EPSILON * Math.max(Math.abs(a), Math.abs(b));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(a.reduce((sum, value, index) => sum + (value - (b[index] ?? 0)) ** 2, 0));
}

function unitDot(a: readonly number[], b: readonly number[]): number {
  const na = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const nb = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  if (na < 1e-12 || nb < 1e-12) return 0;
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0) / (na * nb);
}

function compatible(a: FaceFingerprint, b: FaceFingerprint, diagonal: number): number | null {
  if (a.type !== b.type) return null;
  const gap = distance(a.c, b.c);
  if (gap > CENTROID_TOLERANCE * diagonal) return null;
  if (Math.abs(a.a - b.a) > AREA_TOLERANCE * Math.max(Math.abs(a.a), Math.abs(b.a), 1e-12)) return null;
  if (a.type === "PLANE" && a.n && b.n) {
    if (unitDot(a.n, b.n) < DIRECTION_DOT) return null;
  } else if (a.type === "CYLINDER" || a.type === "CONE") {
    if (a.ax && b.ax && Math.abs(unitDot(a.ax, b.ax)) < DIRECTION_DOT) return null;
    if (a.r !== undefined && b.r !== undefined
      && Math.abs(a.r - b.r) > RADIUS_TOLERANCE * Math.max(Math.abs(a.r), Math.abs(b.r), 1e-12)) return null;
  }
  return gap;
}

/** Greedy one-to-one matching by ascending centroid distance. */
export function matchFaces(before: readonly FaceFingerprint[], after: readonly FaceFingerprint[], diagonal: number): FaceMatch {
  const candidates: Array<[number, number, number]> = [];
  before.forEach((a, i) => after.forEach((b, j) => {
    const gap = compatible(a, b, diagonal);
    if (gap !== null) candidates.push([gap, i, j]);
  }));
  candidates.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const [, i, j] of candidates) {
    if (usedBefore.has(i) || usedAfter.has(j)) continue;
    usedBefore.add(i);
    usedAfter.add(j);
    pairs.push([i, j]);
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return {
    pairs,
    unmatchedBefore: before.map((_, i) => i).filter((i) => !usedBefore.has(i)),
    unmatchedAfter: after.map((_, j) => j).filter((j) => !usedAfter.has(j)),
  };
}

function bboxDiagonal(payload: GeometryPayload | null): number {
  const box = payload?.bbox;
  return box ? Math.sqrt(box.x ** 2 + box.y ** 2 + box.z ** 2) : 0;
}

function matchableFaces(previous: GeometryPayload | null, current: GeometryPayload): FaceMatch | null {
  if (!previous?.faceFingerprints || !current.faceFingerprints) return null;
  const diagonal = Math.max(bboxDiagonal(previous), bboxDiagonal(current), 1e-9);
  return matchFaces(previous.faceFingerprints, current.faceFingerprints, diagonal);
}

function numberChange(before: number | undefined, after: number | undefined) {
  const hasBefore = typeof before === "number";
  const hasAfter = typeof after === "number";
  return {
    before: hasBefore ? before : null,
    after: hasAfter ? after : null,
    delta: hasBefore && hasAfter && differs(before, after) ? round3(after - before) : hasBefore && hasAfter ? 0 : null,
  };
}

function boxArray(payload: GeometryPayload | null): number[] | null {
  const box = payload?.bbox;
  return box ? [box.x, box.y, box.z] : null;
}

export function summarizeBuildChanges(
  previous: GeometryPayload | null,
  current: GeometryPayload,
  extra?: FeatureChanges & { baselineSha256?: string },
): BuildChanges {
  const before = boxArray(previous);
  const after = boxArray(current);
  const match = matchableFaces(previous, current);
  const changes: BuildChanges = {
    schema: 1,
    baseline: previous ? { sha256: extra?.baselineSha256 ?? "" } : null,
    volumeMm3: numberChange(previous?.volume, current.volume),
    areaMm2: numberChange(previous?.surfaceArea, current.surfaceArea),
    bboxMm: {
      before,
      after,
      changed: !!before && !!after && before.some((value, index) => differs(value, after[index]!)),
    },
    solids: { before: previous?.solidCount ?? null, after: current.solidCount ?? null },
    faces: {
      before: previous?.faceCount ?? null,
      after: current.faceCount ?? null,
      new: match ? match.unmatchedAfter.length : null,
      removed: match ? match.unmatchedBefore.length : null,
    },
  };
  if (extra?.features) changes.features = extra.features;
  if (extra?.params) changes.params = extra.params;
  if (extra?.intent) changes.intent = extra.intent;
  if (extra?.warnings) changes.warnings = extra.warnings;
  return changes;
}

function lineDistance(point: readonly number[], origin: readonly number[], direction: readonly number[]): number {
  const length = Math.sqrt(direction.reduce((sum, value) => sum + value * value, 0)) || 1;
  const offset = point.map((value, index) => value - (origin[index] ?? 0));
  const along = offset.reduce((sum, value, index) => sum + value * (direction[index] ?? 0) / length, 0);
  return Math.sqrt(offset.reduce((sum, value, index) => sum + (value - along * (direction[index] ?? 0) / length) ** 2, 0));
}

/** Same underlying surface (plane position, cylinder axis and radius), whatever the face extent. */
function sameSurface(a: FaceFingerprint, b: FaceFingerprint, tolerance: number): boolean | null {
  if (a.type !== b.type) return false;
  if (a.type === "PLANE" && a.n && b.n) {
    if (unitDot(a.n, b.n) < DIRECTION_DOT) return false;
    const offset = (f: FaceFingerprint) => f.c.reduce((sum, value, index) => sum + value * (f.n![index] ?? 0), 0)
      / (Math.sqrt(f.n!.reduce((sum, value) => sum + value * value, 0)) || 1);
    return Math.abs(offset(a) - offset(b)) <= tolerance;
  }
  if ((a.type === "CYLINDER" || a.type === "CONE") && a.ax && b.ax && a.ap && b.ap) {
    if (Math.abs(unitDot(a.ax, b.ax)) < DIRECTION_DOT) return false;
    if (a.r !== undefined && b.r !== undefined && Math.abs(a.r - b.r) > tolerance) return false;
    return lineDistance(b.ap, a.ap, a.ax) <= tolerance;
  }
  return null; // no surface parameters: cannot tell
}

/**
 * Faces of the current build that lie on a surface the previous build did not
 * have: a new cylinder wall, a moved plane, a fillet. A face that only grew or
 * shrank on an unchanged surface (the top of a plate that gained a hole) is not
 * listed, so the highlight shows what the edit made, not everything it touched.
 * Faces without surface parameters fall back to the fingerprint match.
 */
export function changedFaces(previous: GeometryPayload | null, current: GeometryPayload): FaceFingerprint[] {
  if (!previous?.faceFingerprints || !current.faceFingerprints) return [];
  const diagonal = Math.max(bboxDiagonal(previous), bboxDiagonal(current), 1e-9);
  const tolerance = Math.max(2e-4, 1e-5 * diagonal);
  const strict = matchFaces(previous.faceFingerprints, current.faceFingerprints, diagonal);
  const unmatched = new Set(strict.unmatchedAfter);
  const changed: FaceFingerprint[] = [];
  current.faceFingerprints.forEach((face, index) => {
    if (!unmatched.has(index)) return;
    const verdicts = previous.faceFingerprints!.map((old) => sameSurface(old, face, tolerance));
    if (verdicts.some((verdict) => verdict === true)) return; // same surface existed before
    changed.push(face);
  });
  return changed.slice(0, MAX_HIGHLIGHT_FACES);
}

interface ManifestBinding { target?: string; facts?: { area?: number; type?: string; bbox?: number[][] } }
interface ManifestEntity { path: string; kind: string; bindings?: ManifestBinding[] }

/**
 * Labels for changed faces: every identity-manifest feature or face group whose
 * bound face has the area and type of a changed face is named at the centre of
 * its bounding box.
 */
export function annotationsForChangedFaces(
  manifest: { entities?: ManifestEntity[] } | null,
  changed: readonly FaceFingerprint[],
  limit = 8,
): Array<{ text: string; at: [number, number, number] }> {
  if (!manifest?.entities?.length || !changed.length) return [];
  const labels: Array<{ text: string; at: [number, number, number] }> = [];
  for (const entity of manifest.entities) {
    if (entity.kind !== "feature" && entity.kind !== "faces") continue;
    const faces = (entity.bindings ?? []).filter((binding) => binding.target === "face" && binding.facts?.bbox && binding.facts.area !== undefined);
    const hit = faces.find((binding) => changed.some((face) =>
      face.type.toLowerCase() === (binding.facts!.type ?? "").toLowerCase()
      && Math.abs(face.a - binding.facts!.area!) <= AREA_TOLERANCE * Math.max(face.a, binding.facts!.area!, 1e-12)));
    if (!hit) continue;
    const [low, high] = hit.facts!.bbox!;
    const segments = entity.path.split("/");
    labels.push({
      text: entity.kind === "faces" ? segments.slice(-2).join("/") : segments[segments.length - 1]!,
      at: [0, 1, 2].map((axis) => round3(((low![axis] ?? 0) + (high![axis] ?? 0)) / 2)) as [number, number, number],
    });
    if (labels.length >= limit) break;
  }
  return labels;
}
