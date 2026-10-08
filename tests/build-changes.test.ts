import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  annotationsForChangedFaces,
  changedFaces,
  matchFaces,
  summarizeBuildChanges,
} from "../src/modules/model/build-changes.ts";
import type { FaceFingerprint, GeometryPayload } from "../src/shared/protocol.ts";

const fixtureDirectory = new URL("./fixtures/face-fingerprints/", import.meta.url);

test("shared face fingerprint vectors match the Python implementation", () => {
  const files = readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json")).sort();
  assert.ok(files.length >= 5);
  for (const name of files) {
    const vector = JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
    const result = matchFaces(vector.before, vector.after, vector.diagonal);
    assert.deepEqual(result, vector.expected, name);
  }
});

const plane = (c: [number, number, number], a: number, n: number[]): FaceFingerprint => ({ type: "PLANE", c, a, n });
const cylinder = (c: [number, number, number], a: number, r: number): FaceFingerprint => ({ type: "CYLINDER", c, a, ax: [0, 0, 1], r });

function payload(overrides: Partial<GeometryPayload>): GeometryPayload {
  return { bbox: { x: 40, y: 20, z: 10 }, volume: 8000, surfaceArea: 2000, solidCount: 1, faceCount: 3, ...overrides };
}

const before = payload({
  faceFingerprints: [plane([0, 0, 5], 800, [0, 0, 1]), plane([0, 0, -5], 800, [0, 0, -1]), cylinder([10, 0, 0], 188.5, 3)],
});
const after = payload({
  volume: 7903.7,
  faceFingerprints: [plane([0, 0, 5], 800, [0, 0, 1]), plane([0, 0, -5], 800, [0, 0, -1]), cylinder([10, 0, 0], 251.3, 4)],
});

test("no baseline: nothing is compared and nothing is highlighted", () => {
  const changes = summarizeBuildChanges(null, after);
  assert.equal(changes.baseline, null);
  assert.deepEqual(changes.volumeMm3, { before: null, after: 7903.7, delta: null });
  assert.equal(changes.faces.new, null);
  assert.deepEqual(changedFaces(null, after), []);
});

test("volume delta, unchanged bbox, and changed faces", () => {
  const changes = summarizeBuildChanges(before, after, { baselineSha256: "abc" });
  assert.deepEqual(changes.baseline, { sha256: "abc" });
  assert.equal(changes.volumeMm3.delta, -96.3);
  assert.equal(changes.bboxMm.changed, false);
  assert.deepEqual(changes.faces, { before: 3, after: 3, new: 1, removed: 1 });
  const highlight = changedFaces(before, after);
  assert.equal(highlight.length, 1);
  assert.equal(highlight[0]!.type, "CYLINDER");
  assert.equal(highlight[0]!.r, 4);
});

test("a face that only changed extent on an unchanged surface is not highlighted", () => {
  // The top plane lost area to a new hole but did not move; the hole wall is new.
  const withHole = payload({
    faceFingerprints: [plane([0, 0, 5], 700, [0, 0, 1]), plane([0, 0, -5], 700, [0, 0, -1]), { type: "CYLINDER", c: [10, 0, 0], a: 251.3, ax: [0, 0, 1], ap: [10, 0, -5], r: 4 }],
  });
  const without = payload({
    faceFingerprints: [plane([0, 0, 5], 800, [0, 0, 1]), plane([0, 0, -5], 800, [0, 0, -1])],
  });
  const highlighted = changedFaces(without, withHole);
  assert.deepEqual(highlighted.map((face) => face.type), ["CYLINDER"]);
  // The summary still counts the two resized planes as changed geometry.
  assert.equal(summarizeBuildChanges(without, withHole).faces.new, 3);
});

test("a plane that moved is highlighted", () => {
  const thin = payload({ faceFingerprints: [plane([0, 0, 5], 800, [0, 0, 1]), plane([0, 0, -5], 800, [0, 0, -1])] });
  const thick = payload({ faceFingerprints: [plane([0, 0, 8], 800, [0, 0, 1]), plane([0, 0, -5], 800, [0, 0, -1])] });
  const highlighted = changedFaces(thin, thick);
  assert.equal(highlighted.length, 1);
  assert.deepEqual(highlighted[0]!.c, [0, 0, 8]);
});

test("bbox change is reported", () => {
  const wider = payload({ bbox: { x: 45, y: 20, z: 10 }, faceFingerprints: before.faceFingerprints });
  const changes = summarizeBuildChanges(before, wider);
  assert.equal(changes.bboxMm.changed, true);
  assert.deepEqual(changes.bboxMm.after, [45, 20, 10]);
});

test("identical rebuild has zero deltas and no highlight", () => {
  const changes = summarizeBuildChanges(before, before);
  assert.equal(changes.volumeMm3.delta, 0);
  assert.deepEqual(changes.faces, { before: 3, after: 3, new: 0, removed: 0 });
  assert.deepEqual(changedFaces(before, before), []);
});

test("evidence from before fingerprints existed degrades to counts only", () => {
  const legacy = payload({ faceFingerprints: undefined });
  const changes = summarizeBuildChanges(legacy, after);
  assert.equal(changes.faces.new, null);
  assert.deepEqual(changedFaces(legacy, after), []);
});

test("FreeCAD feature facts pass through unchanged", () => {
  const extra = {
    features: { recomputed: ["bracket/mount_hole"] },
    params: { changed: { hole_d: [6, 8] as [number, number] } },
    intent: [{ path: "bracket/min_wall", status: "pass" }],
    warnings: [{ code: "SKETCH_UNDER_CONSTRAINED" }],
  };
  const changes = summarizeBuildChanges(before, after, extra);
  assert.deepEqual(changes.features, extra.features);
  assert.deepEqual(changes.params, extra.params);
  assert.deepEqual(changes.intent, extra.intent);
  assert.deepEqual(changes.warnings, extra.warnings);
});

test("changed faces are named from the identity manifest", () => {
  const manifest = {
    entities: [
      { path: "bracket", kind: "instance", bindings: [] },
      {
        path: "bracket/mount_hole", kind: "feature",
        bindings: [{ target: "face", facts: { type: "cylinder", area: 251.3, bbox: [[6, -4, -5], [14, 4, 5]] } }],
      },
      {
        path: "bracket/base/top", kind: "faces",
        bindings: [{ target: "face", facts: { type: "plane", area: 800, bbox: [[-20, -10, 5], [20, 10, 5]] } }],
      },
    ],
  };
  const labels = annotationsForChangedFaces(manifest, changedFaces(before, after));
  assert.deepEqual(labels, [{ text: "mount_hole", at: [10, 0, 0] }]);
  assert.deepEqual(annotationsForChangedFaces(null, changedFaces(before, after)), []);
});

test("transfer check places a cylinder by its axis, because kernels put the centroid of a full cylinder at different seams", () => {
  // FreeCAD reports the hole centroid on the -X side, Fusion on the +X side, 4 mm apart; the hole is the same.
  const freecad: FaceFingerprint = { type: "CYLINDER", c: [-17, -10, 2.5], a: 62.8319, ax: [0, 0, -1], ap: [-15, -10, 5], r: 2 };
  const fusion: FaceFingerprint = { type: "CYLINDER", c: [-13, -10, 2.5], a: 62.8319, ax: [0, 0, -1], ap: [-15, -10, 2.25], r: 2 };
  assert.equal(matchFaces([freecad], [fusion], 50).pairs.length, 0, "the build-change rule stays centroid based");
  assert.deepEqual(matchFaces([freecad], [fusion], 50, { cylindersByAxis: true }).pairs, [[0, 0]]);
  // A cylinder on another axis, or at another height, is still a different face.
  const moved = { ...fusion, ap: [-14, -10, 2.25] };
  assert.equal(matchFaces([freecad], [moved], 50, { cylindersByAxis: true }).pairs.length, 0);
  const lower = { ...fusion, c: [-13, -10, 1.5] };
  assert.equal(matchFaces([freecad], [lower], 50, { cylindersByAxis: true }).pairs.length, 0);
});

test("transfer check places a cone by its axis as well", () => {
  const freecad: FaceFingerprint = { type: "CONE", c: [-5.25, 0, 4.75], a: 23.3251, ax: [0, 0, 1], ap: [0, 0, 4.5] };
  const fusion: FaceFingerprint = { type: "CONE", c: [5.25, 0, 4.75], a: 23.3251, ax: [0, 0, 1], ap: [0, 0, 4.75] };
  assert.equal(matchFaces([freecad], [fusion], 50).pairs.length, 0);
  assert.deepEqual(matchFaces([freecad], [fusion], 50, { cylindersByAxis: true }).pairs, [[0, 0]]);
});
