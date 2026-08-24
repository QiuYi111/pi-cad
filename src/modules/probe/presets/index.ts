/**
 * PROBE presets: visual, geometry, surfaces, measure, section,
 * sections_scan, compare, assembly, interference.
 *
 * Each preset reproduces exactly the cadctl call + evidence-path policy
 * the corresponding legacy tool used (Phase 2 is a move, not a behavior
 * change — the phase-0/1 test suite is the oracle).
 */
import { basename, join, resolve } from "node:path";

import {
  assemblyTree,
  compareGeometry,
  currentGeometryEvidencePath,
  currentRunEvidenceRoot,
  inspectGeometry,
  inspectInterference,
  inspectSection,
  inspectSurfaces,
  inspectVisual,
  currentVisualEvidenceDir,
  measure,
  scanSections,
} from "../../../shared/capability.ts";
import { registerProbe, type ProbePreset } from "../registry.ts";

// --------------------------------------------------------------------------
// visual
// --------------------------------------------------------------------------

export interface VisualProbeArgs {
  artifact: string;
  views: string[];
  width: number;
  height: number;
  labels: boolean;
  display: "solid";
}

const visualPreset: ProbePreset<VisualProbeArgs> = {
  name: "visual",
  async run(args, ctx) {
    const outDir = await currentVisualEvidenceDir(ctx.cwd, args.artifact);
    const envelope = await inspectVisual(ctx.cwd, args.artifact, outDir, {
      views: args.views,
      width: args.width,
      height: args.height,
      labels: args.labels,
      display: args.display,
    });
    const payload = envelope.payload as {
      views?: Array<{ name: string }>;
      error?: string;
    };
    return {
      envelope,
      kind: "visual",
      headline: `visual render: ${(payload.views ?? []).length} views of ${args.artifact}`,
      includeEnvelope: false,
      artifactPath: resolve(ctx.cwd, args.artifact),
    };
  },
};

// --------------------------------------------------------------------------
// geometry
// --------------------------------------------------------------------------

export interface GeometryProbeArgs {
  artifact: string;
  output?: string;
}

const geometryPreset: ProbePreset<GeometryProbeArgs> = {
  name: "geometry",
  async run(args, ctx) {
    const output = args.output ?? (await currentGeometryEvidencePath(ctx.cwd, args.artifact));
    const envelope = await inspectGeometry(ctx.cwd, args.artifact, output);
    return {
      envelope,
      kind: "geometry",
      headline: `geometry facts: ${args.artifact}`,
      artifactPath: resolve(ctx.cwd, args.artifact),
    };
  },
};

// --------------------------------------------------------------------------
// surfaces
// --------------------------------------------------------------------------

export interface SurfacesProbeArgs {
  artifact: string;
  labels: boolean;
  views?: string[];
}

const surfacesPreset: ProbePreset<SurfacesProbeArgs> = {
  name: "surfaces",
  async run(args, ctx) {
    const root = await currentRunEvidenceRoot(ctx.cwd);
    const outDir = root
      ? join(root, "surfaces", basename(args.artifact).replace(/\.[^.]+$/, ""))
      : resolve(ctx.cwd, ".pi-cad", "evidence", "surfaces", basename(args.artifact).replace(/\.[^.]+$/, ""));
    const envelope = await inspectSurfaces(ctx.cwd, args.artifact, {
      output: join(outDir, "surfaces.json"),
      labels: args.labels,
      outDir,
      views: args.views,
    });
    const payload = envelope.payload as {
      surfaces?: Array<{ id: string; type: string; area: number; centroid: number[] }>;
      views?: Array<{ name: string; path: string }>;
    };
    const surfaces = payload.surfaces ?? [];
    const byType = surfaces.reduce<Record<string, number>>((counts, surface) => {
      counts[surface.type] = (counts[surface.type] ?? 0) + 1;
      return counts;
    }, {});
    const areas = surfaces.map((surface) => surface.area).filter(Number.isFinite);
    return {
      envelope,
      kind: "surfaces",
      headline: `surface facts: ${payload.surfaces?.length ?? 0} boundary surfaces of ${args.artifact} (selectors, not semantics; valid for this artifact hash only)`,
      facts: [
        { key: "surfaceCount", value: String(surfaces.length) },
        { key: "typeDistribution", value: JSON.stringify(byType) },
        ...(areas.length ? [{ key: "areaRange", value: `${Math.min(...areas)}…${Math.max(...areas)}` }] : []),
        { key: "detail", value: "page the surfaces collection with cad_recall_observation for selectors and centroids" },
      ],
      visuals: (payload.views ?? []).map((v) => ({ name: v.name, path: v.path })),
      includeEnvelope: false,
      artifactPath: resolve(ctx.cwd, args.artifact),
    };
  },
};

// --------------------------------------------------------------------------
// measure
// --------------------------------------------------------------------------

export interface MeasureProbeArgs {
  artifact: string;
  metric: string;
  a: string;
  b?: string;
}

const measurePreset: ProbePreset<MeasureProbeArgs> = {
  name: "measure",
  async run(args, ctx) {
    const envelope = await measure(ctx.cwd, args.artifact, {
      metric: args.metric,
      a: args.a,
      b: args.b,
    });
    const payload = envelope.payload as {
      value?: unknown;
      units?: string;
      metric?: string;
      a?: string;
      b?: string;
      error?: string;
    };
    return {
      envelope,
      kind: "measure",
      headline: `measure ${payload.metric ?? args.metric}(${payload.a ?? args.a}${payload.b ?? (args.b ? `, ${args.b}` : "")}) = ${JSON.stringify(payload.value ?? null)} ${payload.units ?? "mm"}`,
      includeEnvelope: false,
      artifactPath: resolve(ctx.cwd, args.artifact),
    };
  },
};

// --------------------------------------------------------------------------
// section
// --------------------------------------------------------------------------

export interface SectionProbeArgs {
  artifact: string;
  origin: [number, number, number];
  normal: [number, number, number];
  display: "solid" | "hidden_edges" | "solid_with_hidden";
  width: number;
  height: number;
  labels: boolean;
}

const sectionPreset: ProbePreset<SectionProbeArgs> = {
  name: "section",
  async run(args, ctx) {
    const root = await currentRunEvidenceRoot(ctx.cwd);
    const outDir = root ? join(root, "section") : resolve(ctx.cwd, ".pi-cad", "evidence", "section");
    const envelope = await inspectSection(ctx.cwd, args.artifact, outDir, args);
    const payload = envelope.payload as {
      intersectionCurves?: number;
      sectionFaceCount?: number;
    };
    return {
      envelope,
      kind: "section",
      headline: `section: intersectionCurves=${payload.intersectionCurves ?? "?"} sectionFaces=${payload.sectionFaceCount ?? "?"}`,
      includeEnvelope: false,
      artifactPath: resolve(ctx.cwd, args.artifact),
    };
  },
};

// --------------------------------------------------------------------------
// sections scan
// --------------------------------------------------------------------------

export interface SectionsScanProbeArgs {
  artifact: string;
  axis: "x" | "y" | "z";
  count?: number;
  step?: number;
}

const sectionsScanPreset: ProbePreset<SectionsScanProbeArgs> = {
  name: "sections_scan",
  async run(args, ctx) {
    const root = await currentRunEvidenceRoot(ctx.cwd);
    const output = join(
      root ?? resolve(ctx.cwd, ".pi-cad", "evidence"),
      "sections",
      `${Date.now().toString(36)}.json`,
    );
    const envelope = await scanSections(ctx.cwd, args.artifact, {
      axis: args.axis,
      count: args.count,
      step: args.step,
      output,
    });
    const payload = envelope.payload as { positionCount?: number; areaRange?: number[] };
    return {
      envelope,
      kind: "sections",
      headline: `sections scan: ${payload.positionCount ?? "?"} sections along ${args.axis.toUpperCase()} — area range ${JSON.stringify(payload.areaRange ?? [])}. Facts only; the critical section is your judgment.`,
      includeEnvelope: false,
      artifactPath: resolve(ctx.cwd, args.artifact),
    };
  },
};

// --------------------------------------------------------------------------
// compare
// --------------------------------------------------------------------------

export interface CompareProbeArgs {
  before: string;
  after: string;
  metrics?: string[];
  transformBefore?: number[][];
  transformAfter?: number[][];
  output?: string;
}

const comparePreset: ProbePreset<CompareProbeArgs> = {
  name: "compare",
  async run(args, ctx) {
    const root = await currentRunEvidenceRoot(ctx.cwd);
    const output =
      args.output ?? join(root ?? resolve(ctx.cwd, ".pi-cad", "evidence"), "compare", `${Date.now().toString(36)}.json`);
    const envelope = await compareGeometry(ctx.cwd, args.before, args.after, output, {
      metrics: args.metrics,
      transformBefore: args.transformBefore,
      transformAfter: args.transformAfter,
    });
    return {
      envelope,
      kind: "compare",
      headline: `geometry compare: ${args.before} → ${args.after}`,
      includeEnvelope: false,
      artifactHashFrom: "after",
      artifactPath: resolve(ctx.cwd, args.after),
    };
  },
};

// --------------------------------------------------------------------------
// assembly tree
// --------------------------------------------------------------------------

export interface AssemblyProbeArgs {
  artifact: string;
  output?: string;
}

const assemblyPreset: ProbePreset<AssemblyProbeArgs> = {
  name: "assembly",
  async run(args, ctx) {
    const root = await currentRunEvidenceRoot(ctx.cwd);
    const output =
      args.output ?? join(root ?? resolve(ctx.cwd, ".pi-cad", "evidence"), "assembly", `${Date.now().toString(36)}.json`);
    const envelope = await assemblyTree(ctx.cwd, args.artifact, output);
    const payload = envelope.payload as { leafCount?: number; occurrences?: unknown[] };
    return {
      envelope,
      kind: "assembly",
      headline: `assembly tree: leafCount=${payload.leafCount ?? "?"} occurrences=${(payload.occurrences ?? []).length}`,
      includeEnvelope: false,
      artifactPath: resolve(ctx.cwd, args.artifact),
    };
  },
};

// --------------------------------------------------------------------------
// interference
// --------------------------------------------------------------------------

export interface InterferenceProbeArgs {
  artifact: string;
  output?: string;
}

const interferencePreset: ProbePreset<InterferenceProbeArgs> = {
  name: "interference",
  async run(args, ctx) {
    const root = await currentRunEvidenceRoot(ctx.cwd);
    const output =
      args.output ?? join(root ?? resolve(ctx.cwd, ".pi-cad", "evidence"), "interference", `${Date.now().toString(36)}.json`);
    const envelope = await inspectInterference(ctx.cwd, args.artifact, output);
    const payload = envelope.payload as {
      partCount?: number;
      pairCount?: number;
      summary?: Record<string, number>;
    };
    return {
      envelope,
      kind: "interference",
      headline: `interference facts: ${payload.partCount ?? "?"} parts, ${payload.pairCount ?? "?"} pairs — ${JSON.stringify(payload.summary ?? {})}. Interpret penetration vs intentional contact yourself.`,
      artifactPath: resolve(ctx.cwd, args.artifact),
    };
  },
};

// --------------------------------------------------------------------------
// registration
// --------------------------------------------------------------------------

export function registerProbePresets(): void {
  registerProbe(visualPreset);
  registerProbe(geometryPreset);
  registerProbe(surfacesPreset);
  registerProbe(measurePreset);
  registerProbe(sectionPreset);
  registerProbe(sectionsScanPreset);
  registerProbe(comparePreset);
  registerProbe(assemblyPreset);
  registerProbe(interferencePreset);
}
