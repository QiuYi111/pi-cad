/**
 * Equivalence check of a transfer: the STEP that Fusion or SolidWorks wrote
 * against the STEP of the Reify part.
 *
 * Pass when all three hold:
 * - the relative volume error is at most 1e-6;
 * - the bounding boxes are equal within 1e-6 of the part size;
 * - the face fingerprints match one to one (same rule as the build change summary).
 *
 * On a failure the first feature whose solid volume differs names the place to look.
 */
import { matchFaces } from "../modules/model/build-changes.ts";
import type { GeometryPayload } from "../shared/protocol.ts";

export const VOLUME_TOLERANCE = 1e-6;
export const BBOX_TOLERANCE = 1e-6;

export interface FeatureVolume { name: string; volume_mm3: number }

export interface EquivalenceReport {
  passed: boolean;
  volume: { reference: number | null; executor: number | null; relativeError: number | null; ok: boolean };
  bbox: { reference: number[] | null; executor: number[] | null; maxError: number | null; ok: boolean };
  faces: { reference: number; executor: number; unmatchedReference: number; unmatchedExecutor: number; ok: boolean };
  /** First feature whose solid volume differs from the reference. */
  firstDifferingFeature: { name: string; reference: number; executor: number; relativeError: number } | null;
  failures: string[];
}

function size(payload: GeometryPayload): number[] | null {
  const box = payload.bbox;
  return box ? [box.x, box.y, box.z] : null;
}

/** The first feature, in build order, whose volume after the feature differs by more than the tolerance. */
export function firstDifferingFeature(reference: readonly FeatureVolume[] | undefined, executor: readonly FeatureVolume[] | undefined) {
  if (!reference?.length || !executor?.length) return null;
  const built = new Map(executor.map((item) => [item.name, item.volume_mm3]));
  for (const item of reference) {
    const other = built.get(item.name);
    if (other === undefined) return { name: item.name, reference: item.volume_mm3, executor: Number.NaN, relativeError: Number.POSITIVE_INFINITY };
    const error = Math.abs(other - item.volume_mm3) / Math.max(Math.abs(item.volume_mm3), 1e-12);
    if (error > VOLUME_TOLERANCE) return { name: item.name, reference: item.volume_mm3, executor: other, relativeError: error };
  }
  return null;
}

export function compareEquivalence(
  reference: GeometryPayload,
  executor: GeometryPayload,
  featureVolumes?: { reference?: readonly FeatureVolume[]; executor?: readonly FeatureVolume[] },
): EquivalenceReport {
  const failures: string[] = [];

  const referenceVolume = typeof reference.volume === "number" ? reference.volume : null;
  const executorVolume = typeof executor.volume === "number" ? executor.volume : null;
  const volumeError = referenceVolume !== null && executorVolume !== null
    ? Math.abs(executorVolume - referenceVolume) / Math.max(Math.abs(referenceVolume), 1e-12)
    : null;
  const volumeOk = volumeError !== null && volumeError <= VOLUME_TOLERANCE;
  if (!volumeOk) failures.push(volumeError === null ? "volume is missing in one STEP" : `volume differs by ${volumeError.toExponential(2)} (limit ${VOLUME_TOLERANCE})`);

  const referenceBox = size(reference);
  const executorBox = size(executor);
  let boxError: number | null = null;
  if (referenceBox && executorBox) {
    const diagonal = Math.hypot(...referenceBox);
    boxError = Math.max(...referenceBox.map((value, index) => Math.abs(value - executorBox[index]!))) / Math.max(diagonal, 1e-12);
  }
  const boxOk = boxError !== null && boxError <= BBOX_TOLERANCE;
  if (!boxOk) failures.push(boxError === null ? "bounding box is missing in one STEP" : `bounding box differs by ${boxError.toExponential(2)} of the part size (limit ${BBOX_TOLERANCE})`);

  const referenceFaces = reference.faceFingerprints ?? [];
  const executorFaces = executor.faceFingerprints ?? [];
  const diagonal = Math.max(Math.hypot(...(referenceBox ?? [0, 0, 0])), Math.hypot(...(executorBox ?? [0, 0, 0])), 1e-9);
  const match = matchFaces(referenceFaces, executorFaces, diagonal, { cylindersByAxis: true });
  const facesOk = referenceFaces.length > 0 && match.unmatchedBefore.length === 0 && match.unmatchedAfter.length === 0;
  if (!facesOk) {
    failures.push(referenceFaces.length === 0 || executorFaces.length === 0
      ? "face fingerprints are missing in one STEP"
      : `faces do not match one to one: ${match.unmatchedBefore.length} of ${referenceFaces.length} reference faces and ${match.unmatchedAfter.length} of ${executorFaces.length} exported faces have no partner`);
  }

  const passed = volumeOk && boxOk && facesOk;
  return {
    passed,
    volume: { reference: referenceVolume, executor: executorVolume, relativeError: volumeError, ok: volumeOk },
    bbox: { reference: referenceBox, executor: executorBox, maxError: boxError, ok: boxOk },
    faces: {
      reference: referenceFaces.length, executor: executorFaces.length,
      unmatchedReference: match.unmatchedBefore.length, unmatchedExecutor: match.unmatchedAfter.length, ok: facesOk,
    },
    firstDifferingFeature: passed ? null : firstDifferingFeature(featureVolumes?.reference, featureVolumes?.executor),
    failures,
  };
}
