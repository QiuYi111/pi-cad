/**
 * Observation profiles (refactor Phase 1).
 *
 * Per-cadctl-tool extraction of headline / visuals / facts from an
 * envelope payload. Profiles are data-driven and side-effect free —
 * they decide WHAT the agent sees out of a raw backend output, which
 * is exactly the Observation Layer's job (design doc §5.2).
 *
 * Rules every profile follows:
 *   - never invent engineering meaning (no "this is an inlet");
 *   - facts are deterministic and reproducible from the payload;
 *   - visuals (image paths) are extracted, never rendered here.
 */
import type { CadEventEnvelope } from "../shared/protocol.ts";
import type {
  ObservationFact,
  ObservationVisual,
} from "./bundle.ts";

export interface ObservationProfile {
  headline: (payload: Record<string, unknown>) => string;
  visuals?: (payload: Record<string, unknown>) => ObservationVisual[];
  facts?: (payload: Record<string, unknown>) => ObservationFact[];
}

const num = (value: unknown, digits = 3): string =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : String(value ?? "n/a");

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

/** Extract views[] entries {name, path} as visuals. */
function viewVisuals(payload: Record<string, unknown>): ObservationVisual[] {
  const views = Array.isArray(payload.views) ? payload.views : [];
  return views
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => ({ name: String(v.name ?? "view"), path: String(v.path ?? "") }))
    .filter((v) => v.path !== "");
}

function bboxFact(payload: Record<string, unknown>): string {
  const bbox = payload.bbox;
  if (Array.isArray(bbox) && bbox.length >= 6) {
    return bbox.slice(0, 6).map((v) => num(v, 2)).join(", ");
  }
  if (bbox && typeof bbox === "object") {
    const b = bbox as Record<string, unknown>;
    if (["x", "y", "z"].every((key) => typeof b[key] === "number")) {
      return `size=[${num(b.x, 6)}, ${num(b.y, 6)}, ${num(b.z, 6)}]`;
    }
    const xyz = (key: string) =>
      b[key] && Array.isArray(b[key]) ? (b[key] as number[]).map((v) => num(v, 2)).join(", ") : "n/a";
    return `min=[${xyz("min")}] max=[${xyz("max")}]`;
  }
  return "n/a";
}

const PROFILES: Record<string, ObservationProfile> = {
  cad_inspect_visual: {
    headline: (p) =>
      p.error
        ? `visual render failed: ${p.error}`
        : `visual render succeeded (${viewVisuals(p).length} views)`,
    visuals: viewVisuals,
    facts: (p) => [
      { key: "bbox", value: bboxFact(p) },
      { key: "units", value: String(p.units ?? "mm") },
      ...(p.solidCount !== undefined ? [{ key: "solids", value: String(p.solidCount) }] : []),
      ...(p.occurrenceCount !== undefined
        ? [{ key: "occurrences", value: String(p.occurrenceCount) }]
        : []),
    ],
  },

  cad_inspect_geometry: {
    headline: (p) =>
      p.error ? `geometry inspection failed: ${p.error}` : "geometry inspection succeeded",
    facts: (p) => [
      { key: "bbox", value: bboxFact(p) },
      { key: "volume", value: num(p.volume) },
      { key: "surfaceArea", value: num(p.surfaceArea) },
      ...(p.solidCount !== undefined ? [{ key: "solids", value: String(p.solidCount) }] : []),
      ...(p.occurrenceCount !== undefined
        ? [{ key: "occurrences", value: String(p.occurrenceCount) }]
        : []),
      ...(Array.isArray(p.labels)
        ? [{ key: "labels", value: `${(p.labels as unknown[]).length} (#pN planar / #cN cylindrical)` }]
        : []),
      ...(Array.isArray(p.cylinders)
        ? [
            { key: "cylinders", value: `${(p.cylinders as unknown[]).length} cylindrical faces` },
            ...((p.cylinders as Array<Record<string, unknown>>)
              .filter((item) => typeof item.radius === "number")
              .slice(0, 16)
              .map((item, index) => ({
                key: `cylinderRadius:${String(item.label ?? index)}`,
                value: num(item.radius, 6),
              }))),
          ]
        : []),
    ],
  },

  cad_measure: {
    headline: (p) =>
      p.error ? `measurement failed: ${p.error}` : `measurement: ${num(p.value, 6)}`,
    facts: (p) => [
      ...(p.metric !== undefined ? [{ key: "metric", value: String(p.metric) }] : []),
      ...(p.value !== undefined ? [{ key: "value", value: num(p.value, 6) }] : []),
      ...(p.units !== undefined ? [{ key: "units", value: String(p.units) }] : []),
      ...(p.a !== undefined ? [{ key: "a", value: String(p.a) }] : []),
      ...(p.b !== undefined ? [{ key: "b", value: String(p.b) }] : []),
    ],
  },

  cad_compare_geometry: {
    headline: (p) =>
      p.error ? `geometry comparison failed: ${p.error}` : "geometry comparison succeeded",
    facts: (p) => {
      const facts: ObservationFact[] = [];
      if (Array.isArray(p.metrics)) {
        for (const entry of p.metrics as Array<Record<string, unknown>>) {
          facts.push({ key: String(entry.name ?? "metric"), value: num(entry.value, 6) });
        }
      }
      if (Array.isArray(p.changedFaces)) {
        facts.push({ key: "changedFaces", value: String((p.changedFaces as unknown[]).length) });
      }
      if (Array.isArray(p.unchangedFaces)) {
        facts.push({ key: "unchangedFaces", value: String((p.unchangedFaces as unknown[]).length) });
      }
      return facts;
    },
  },

  cad_inspect_section: {
    headline: (p) =>
      p.error ? `section failed: ${p.error}` : "section succeeded",
    visuals: viewVisuals,
    facts: (p) => [
      ...(p.intersectionCurves !== undefined
        ? [{ key: "intersectionCurves", value: String(p.intersectionCurves) }]
        : []),
      ...(p.sectionFaceCount !== undefined
        ? [{ key: "sectionFaces", value: String(p.sectionFaceCount) }]
        : []),
    ],
  },

  cad_scan_sections: {
    headline: (p) =>
      p.error ? `section scan failed: ${p.error}` : "section scan succeeded",
    facts: (p) => [
      ...(p.positionCount !== undefined
        ? [{ key: "sections", value: `${p.positionCount} along ${String(p.axis ?? "z")}` }]
        : []),
      ...(Array.isArray(p.areaRange)
        ? [{ key: "areaRange", value: (p.areaRange as number[]).map((v) => num(v)).join("…") }]
        : []),
    ],
  },

  cad_assembly_tree: {
    headline: (p) =>
      p.error ? `assembly tree failed: ${p.error}` : "assembly tree succeeded",
    facts: (p) => [
      ...(p.leafCount !== undefined ? [{ key: "leafCount", value: String(p.leafCount) }] : []),
      ...(Array.isArray(p.occurrences)
        ? [{ key: "occurrences", value: String((p.occurrences as unknown[]).length) }]
        : []),
    ],
  },

  cad_inspect_interference: {
    headline: (p) => {
      if (p.error) return `interference inspection failed: ${p.error}`;
      const pairs = Array.isArray(p.pairs) ? (p.pairs as unknown[]).length : undefined;
      const partCount = p.partCount ?? p.parts ?? "?";
      const pairCount = p.pairCount ?? pairs ?? "?";
      return `interference facts: ${partCount} parts, ${pairCount} pairs`;
    },
    facts: (p) => {
      const facts: ObservationFact[] = [];
      if (p.summary && typeof p.summary === "object") {
        for (const [cls, count] of Object.entries(p.summary as Record<string, unknown>)) {
          facts.push({ key: `summary.${cls}`, value: String(count) });
        }
      }
      const pairs = Array.isArray(p.pairs) ? (p.pairs as Array<Record<string, unknown>>) : [];
      const anomalies = pairs.filter((pair) => {
        const classification = String(pair.classification ?? "").toLowerCase();
        return classification.includes("penetr") || classification.includes("contact") || classification.includes("interference");
      });
      facts.push({ key: "pairDetail", value: `${pairs.length} complete pair records retained; ${anomalies.length} contact/penetration pair(s) prioritized below` });
      for (const pair of anomalies.slice(0, 40)) {
        facts.push({
          key: `${String(pair.a ?? "?")}↔${String(pair.b ?? "?")}`,
          value: `${String(pair.classification ?? "?")}` +
            (pair.intersectionVolume !== undefined
              ? ` volume=${num(pair.intersectionVolume)}`
              : "") +
            (pair.clearance !== undefined ? ` clearance=${num(pair.clearance)}` : ""),
        });
      }
      if (anomalies.length > 40) facts.push({ key: "morePairs", value: `${anomalies.length - 40} additional prioritized pairs; page the pairs collection via cad_recall_observation` });
      return facts;
    },
  },

  cad_build_step: {
    headline: (p) =>
      p.error ? `build failed: ${p.error}` : "build succeeded",
    facts: (p) => [
      ...(p.step !== undefined ? [{ key: "artifact", value: String(p.step) }] : []),
      ...(p.exitCode !== undefined ? [{ key: "exitCode", value: String(p.exitCode) }] : []),
      ...(Array.isArray(p.sidecars) ? [{ key: "sidecars", value: list(p.sidecars).join(", ") }] : []),
    ],
  },

  cad_probe_python: {
    headline: (p) =>
      p.error ? `probe failed: ${p.error}` : "programmable probe succeeded",
    facts: (p) => [
      ...(p.result !== undefined ? [{ key: "result", value: JSON.stringify(p.result) }] : []),
      ...(p.stdout !== undefined ? [{ key: "stdout", value: String(p.stdout) }] : []),
    ],
  },
};

export function observationProfile(tool: string): ObservationProfile {
  return PROFILES[tool] ?? fallbackProfile();
}

function fallbackProfile(): ObservationProfile {
  return {
    headline: (p) =>
      p.error ? `${String(p.error)}` : "backend call succeeded",
    facts: (p) => {
      const facts: ObservationFact[] = [];
      for (const [key, value] of Object.entries(p).slice(0, 12)) {
        if (value === null || value === undefined) continue;
        facts.push({
          key,
          value:
            typeof value === "object" ? JSON.stringify(value).slice(0, 160) : String(value).slice(0, 160),
        });
      }
      return facts;
    },
  };
}

/** Convenience: build headline/visuals/facts via the tool's profile. */
export function profileProjection(
  envelope: CadEventEnvelope,
): { headline: string; visuals: ObservationVisual[]; facts: ObservationFact[] } {
  const profile = observationProfile(envelope.tool);
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  return {
    headline: profile.headline(payload),
    visuals: profile.visuals?.(payload) ?? [],
    facts: profile.facts?.(payload) ?? [],
  };
}
