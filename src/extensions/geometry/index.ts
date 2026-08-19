import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";

import {
  artifactPathForKind,
  assemblyTree,
  inspectInterference,
  scanSections,
  buildPayload,
  buildStep,
  compareGeometry,
  currentGeometryEvidencePath,
  currentRunEvidenceRoot,
  defaultBuildOutput,
  envelopeArtifactHash,
  exportArtifact,
  geometryPayload,
  hashOrEmpty,
  inspectGeometry,
  inspectSection,
  inspectSurfaces,
  measure,
  measurePayload,
  readImageContents,
} from "../../shared/capability.ts";
import type { CadEventEnvelope } from "../../shared/protocol.ts";

const artifactParam = Type.String({
  description: "Path to the STEP/STP artifact to inspect, relative to the project root",
});
const sourceParam = Type.String({
  description: "Path to the build123d Python source to execute, relative to the project root",
});
const outputParam = Type.String({
  description: "Output STEP path. Defaults to build/<source-stem>.step",
});

function envelopeText(envelope: CadEventEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export default function cadGeometryExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cad_build_step",
    label: "CAD Build STEP",
    description:
      "Execute a build123d Python source and produce a STEP artifact. This tool has no engineering opinion: it returns exit code, paths, hashes, and logs. It does not judge whether the geometry is correct.",
    promptSnippet: "Execute build123d source and write a deterministic STEP artifact",
    promptGuidelines: [
      "Prefer cad_commit_candidate in the build phase; the harness runs this automatically and binds evidence to the candidate.",
      "The source must expose a build123d Shape as `result`, or call cadctl gen_step(result, output).",
    ],
    parameters: Type.Object({
      source: sourceParam,
      output: Type.Optional(outputParam),
      force: Type.Optional(Type.Boolean({ description: "Regenerate even if outputs exist" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = params.output ?? defaultBuildOutput(ctx.cwd, params.source);
      const sourceHash = await hashOrEmpty(resolve(ctx.cwd, params.source));
      const envelope = await buildStep(ctx.cwd, {
        source: params.source,
        output,
        force: params.force ?? true,
      });
      const text = envelope.ok
        ? `cad_build_step ${envelope.ok ? "succeeded" : "failed"}.\n${envelopeText(envelope)}`
        : `cad_build_step failed: ${buildPayload(envelope).error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.ok ? envelopeArtifactHash(envelope, "step") : undefined,
          sourceHash,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_inspect_geometry",
    label: "CAD Inspect Geometry",
    description:
      "Return deterministic STEP/B-Rep facts: bbox, volume, surface area, solid count, occurrence count, and labels/planes/cylinders. Geometry classification is not engineering naming; a cylinder is only #cN.",
    promptSnippet: "Return deterministic geometry facts for a STEP artifact",
    promptGuidelines: [
      "Use #pN and #cN labels from the returned payload as selectors for cad_measure.",
      "Interpret what those faces mean yourself; this tool will not.",
    ],
    parameters: Type.Object({
      artifact: artifactParam,
      output: Type.Optional(Type.String({ description: "Optional JSON evidence output path" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = params.output ?? (await currentGeometryEvidencePath(ctx.cwd, params.artifact));
      const envelope = await inspectGeometry(ctx.cwd, params.artifact, output);
      const payload = geometryPayload(envelope);
      const text = envelope.ok
        ? `cad_inspect_geometry succeeded.\n${envelopeText(envelope)}`
        : `cad_inspect_geometry failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact ?? (await hashOrEmpty(resolve(ctx.cwd, params.artifact))),
          kind: "geometry" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_inspect_surfaces",
    label: "CAD Inspect Surfaces",
    description:
      "Enumerate deterministic boundary-surface facts for a STEP artifact and return current-artifact-scoped surface IDs, geometry properties, and optional labeled views. Surface IDs are selectors only; this tool never decides which surface is an inlet, outlet, wall, thermal boundary, interface, or manufacturing feature.",
    promptSnippet: "Inspect deterministic STEP boundary surfaces and obtain surface selectors",
    promptGuidelines: [
      "Use cad_inspect_surfaces before assigning flow/thermal/structural boundary conditions.",
      "Surface IDs are scoped to the current artifact hash; any geometry change invalidates them.",
      "Decide inlet/outlet/wall meaning yourself from geometry, area, position, normal, and the labeled views.",
    ],
    parameters: Type.Object({
      artifact: artifactParam,
      labels: Type.Optional(Type.Boolean({ description: "Render labeled selector views (default true)" })),
      views: Type.Optional(Type.Array(Type.Enum({ iso: "iso", front: "front", right: "right", top: "top" }), { description: "Labeled view subset (default iso, front, right, top)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = await currentRunEvidenceRoot(ctx.cwd);
      const outDir = root
        ? join(root, "surfaces", basename(params.artifact).replace(/\.[^.]+$/, ""))
        : resolve(ctx.cwd, ".pi-cad", "evidence", "surfaces", basename(params.artifact).replace(/\.[^.]+$/, ""));
      const output = join(outDir, "surfaces.json");
      const envelope = await inspectSurfaces(ctx.cwd, params.artifact, {
        output,
        labels: params.labels ?? true,
        outDir,
        views: params.views,
      });
      const payload = envelope.payload as {
        error?: string;
        surfaces?: Array<{ id: string; type: string; area: number; centroid: number[] }>;
        views?: Array<{ path: string; name: string }>;
      };
      if (!envelope.ok) {
        return {
          content: [{ type: "text", text: `cad_inspect_surfaces failed: ${payload.error ?? "unknown error"}` }],
          details: { envelope },
        };
      }
      const summary = (payload.surfaces ?? [])
        .map((s) => `${s.id}: ${s.type} area=${s.area} centroid=[${s.centroid.map((v) => v.toFixed(3)).join(", ")}]`)
        .join("\n");
      const images = await readImageContents((payload.views ?? []).map((view) => view.path));
      return {
        content: [
          {
            type: "text",
            text: `cad_inspect_surfaces: ${payload.surfaces?.length ?? 0} boundary surfaces (selectors, not semantics).\n${summary}\nSurface IDs are valid for this artifact hash only; classify their meaning yourself.`,
          },
          ...images,
        ],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact ?? (await hashOrEmpty(resolve(ctx.cwd, params.artifact))),
          kind: "surfaces" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_measure",
    label: "CAD Measure",
    description:
      "Return one deterministic numeric measurement for an explicit selector and metric. Cylindrical faces use #cN. distance between two cylindrical faces is axis-to-axis distance; use clearance for closest surface distance. Other selectors: #pN planar face, #fN any face.",
    promptSnippet: "Measure one explicit metric between labeled STEP selectors",
    promptGuidelines: [
      "Selectors are #pN (planar), #cN (cylindrical), or #fN (any face) from cad_inspect_geometry.",
      "For hole centers use metric=distance with two #cN cylindrical faces.",
      "Verify every user-specified critical dimension before accepting a candidate.",
    ],
    parameters: Type.Object({
      artifact: artifactParam,
      metric: Type.Enum({
        distance: "distance",
        clearance: "clearance",
        radius: "radius",
        diameter: "diameter",
        area: "area",
        volume: "volume",
        bbox: "bbox",
        frame: "frame",
        alignment_delta: "alignment_delta",
      }),
      a: Type.String({ description: "First selector, e.g. #c0" }),
      b: Type.Optional(Type.String({ description: "Second selector for two-selector metrics" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const envelope = await measure(ctx.cwd, params.artifact, {
        metric: params.metric,
        a: params.a,
        b: params.b,
      });
      const payload = measurePayload(envelope);
      const text = envelope.ok
        ? `cad_measure ${payload.metric}(${payload.a}${payload.b ? `, ${payload.b}` : ""}) = ${JSON.stringify(payload.value)} ${payload.units ?? "mm"}`
        : `cad_measure failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact,
          kind: "measure" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_inspect_section",
    label: "CAD Inspect Section",
    description:
      "Render a deterministic section plane through a STEP artifact and return the image plus intersection facts. The tool does not name the section or explain it.",
    promptSnippet: "Render an explicit plane section through a STEP artifact",
    promptGuidelines: [
      "Use sections through bores, cavities, shells, and mating interfaces.",
      "The plane is explicit in model coordinates: origin + normal.",
    ],
    parameters: Type.Object({
      artifact: artifactParam,
      origin: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
      normal: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
      display: Type.Optional(Type.Enum({ solid: "solid", hidden_edges: "hidden_edges", solid_with_hidden: "solid_with_hidden" })),
      width: Type.Optional(Type.Integer({ minimum: 160, maximum: 1600 })),
      height: Type.Optional(Type.Integer({ minimum: 120, maximum: 1200 })),
      labels: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = await currentRunEvidenceRoot(ctx.cwd);
      const outDir = root ? join(root, "section") : resolve(ctx.cwd, ".pi-cad", "evidence", "section");
      const envelope = await inspectSection(ctx.cwd, params.artifact, outDir, {
        origin: params.origin as [number, number, number],
        normal: params.normal as [number, number, number],
        display: params.display ?? "solid",
        width: params.width ?? 640,
        height: params.height ?? 480,
        labels: params.labels ?? true,
      });
      const payload = envelope.payload as { views?: Array<{ path: string; name: string }>; error?: string; intersectionCurves?: number; sectionFaceCount?: number };
      if (!envelope.ok || !payload.views?.length) {
        return { content: [{ type: "text", text: `cad_inspect_section failed: ${payload.error ?? "no section returned"}` }], details: { envelope } };
      }
      const images = await readImageContents(payload.views.map((view) => view.path));
      return {
        content: [
          { type: "text", text: `cad_inspect_section succeeded. intersectionCurves=${payload.intersectionCurves ?? "?"} sectionFaces=${payload.sectionFaceCount ?? "?"}` },
          ...images,
        ],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact ?? (await hashOrEmpty(resolve(ctx.cwd, params.artifact))),
          kind: "section" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_compare_geometry",
    label: "CAD Compare Geometry",
    description:
      "Return a deterministic before/after geometry diff: bbox, volume, surface area, entity counts, center delta, and common volume. No engineering interpretation.",
    promptSnippet: "Return deterministic geometry diff between two STEP artifacts",
    promptGuidelines: [
      "Inspect each artifact in its native frame first.",
      "The harness automatically runs this in modify/convert review.",
    ],
    parameters: Type.Object({
      before: Type.String({ description: "Before STEP path" }),
      after: Type.String({ description: "After STEP path" }),
      metrics: Type.Optional(Type.Array(Type.String())),
      transformBefore: Type.Optional(Type.String({ description: "Optional JSON 4x4 matrix applied to before" })),
      transformAfter: Type.Optional(Type.String({ description: "Optional JSON 4x4 matrix applied to after" })),
      output: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = await currentRunEvidenceRoot(ctx.cwd);
      const output = params.output ?? join(root ?? resolve(ctx.cwd, ".pi-cad", "evidence"), "compare", `${Date.now().toString(36)}.json`);
      let transformBefore: number[][] | undefined;
      let transformAfter: number[][] | undefined;
      if (params.transformBefore) transformBefore = JSON.parse(params.transformBefore) as number[][];
      if (params.transformAfter) transformAfter = JSON.parse(params.transformAfter) as number[][];
      const envelope = await compareGeometry(ctx.cwd, params.before, params.after, output, {
        metrics: params.metrics ?? undefined,
        transformBefore,
        transformAfter,
      });
      const payload = envelope.payload as { error?: string; delta?: unknown };
      const text = envelope.ok
        ? `cad_compare_geometry succeeded. delta=${JSON.stringify(payload.delta ?? {})}`
        : `cad_compare_geometry failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.after ?? (await hashOrEmpty(resolve(ctx.cwd, params.after))),
          kind: "compare" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_assembly_tree",
    label: "CAD Assembly Tree",
    description:
      "Return occurrence labels, parent/child paths, local transforms, world transforms, and leaf count for a STEP assembly. Labels are only those present in the file.",
    promptSnippet: "Return assembly occurrence tree and transforms",
    promptGuidelines: [
      "Use for hierarchy-safe conversion and assembly diagnosis.",
      "Do not infer that an occurrence is a motor/bearing unless the source label says so.",
    ],
    parameters: Type.Object({
      artifact: artifactParam,
      output: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = await currentRunEvidenceRoot(ctx.cwd);
      const output = params.output ?? join(root ?? resolve(ctx.cwd, ".pi-cad", "evidence"), "assembly", `${Date.now().toString(36)}.json`);
      const envelope = await assemblyTree(ctx.cwd, params.artifact, output);
      const payload = envelope.payload as { error?: string; leafCount?: number; occurrences?: unknown[] };
      const text = envelope.ok
        ? `cad_assembly_tree succeeded. leafCount=${payload.leafCount ?? "?"} occurrences=${(payload.occurrences ?? []).length}`
        : `cad_assembly_tree failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact ?? (await hashOrEmpty(resolve(ctx.cwd, params.artifact))),
          kind: "assembly" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_inspect_interference",
    label: "CAD Interference Facts",
    description:
      "Pairwise solid interference facts for a STEP assembly: intersection volume, minimum distance, and a three-state classification (penetration/contact/clearance) per part pair. Raw facts only — the tool never says pass or fail.",
    promptSnippet: "Report pairwise penetration/contact/clearance facts",
    promptGuidelines: [
      "Required evidence for assembly routes at integration review; re-observed automatically after every candidate commit.",
      "Interpretation is yours: a press fit is penetration, a deliberate stop is contact, a needed gap is clearance.",
      "Use the same artifact you are reviewing; pair facts are bound to the artifact hash.",
    ],
    parameters: Type.Object({
      artifact: artifactParam,
      output: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = await currentRunEvidenceRoot(ctx.cwd);
      const output = params.output ?? join(root ?? resolve(ctx.cwd, ".pi-cad", "evidence"), "interference", `${Date.now().toString(36)}.json`);
      const envelope = await inspectInterference(ctx.cwd, params.artifact, output);
      const payload = envelope.payload as {
        error?: string;
        partCount?: number;
        pairCount?: number;
        summary?: Record<string, number>;
      };
      const text = envelope.ok
        ? `cad_inspect_interference: ${payload.partCount ?? "?"} parts, ${payload.pairCount ?? "?"} pairs — ${JSON.stringify(payload.summary ?? {})}. Facts only: interpret penetration vs intentional contact yourself.`
        : `cad_inspect_interference failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact ?? (await hashOrEmpty(resolve(ctx.cwd, params.artifact))),
          kind: "interference" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_scan_sections",
    label: "CAD Scan Sections",
    description:
      "Scan deterministic cross-section facts along an axis: per-section area, centroid, in-plane second moments, principal moments, bbox, and loop count. Facts only — which section is critical is your engineering judgment.",
    promptSnippet: "Scan cross-section area/moments along an axis",
    promptGuidelines: [
      "Use for stiffness-critical parts (beams, spars, shafts) to see how area and moments vary along the axis.",
      "Provide exactly one of count (evenly spaced) or step (fixed spacing).",
      "The scan reports facts; interpreting the critical section is yours.",
    ],
    parameters: Type.Object(
      {
        artifact: artifactParam,
        axis: Type.Enum({ x: "x", y: "y", z: "z" }),
        count: Type.Optional(Type.Integer({ minimum: 1 })),
        step: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
        output: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if ((params.count === undefined) === (params.step === undefined)) {
        return {
          content: [{ type: "text", text: "cad_scan_sections failed: provide exactly one of count or step" }],
        };
      }
      const root = await currentRunEvidenceRoot(ctx.cwd);
      const output = params.output ?? join(root ?? resolve(ctx.cwd, ".pi-cad", "evidence"), "sections", `${Date.now().toString(36)}.json`);
      const envelope = await scanSections(ctx.cwd, params.artifact, {
        axis: params.axis,
        count: params.count,
        step: params.step,
        output,
      });
      const payload = envelope.payload as { error?: string; positionCount?: number; areaRange?: number[] };
      const text = envelope.ok
        ? `cad_scan_sections: ${payload.positionCount ?? "?"} sections along ${params.axis.toUpperCase()} — area range ${JSON.stringify(payload.areaRange ?? [])}. Facts only; the critical section is your judgment.`
        : `cad_scan_sections failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.inputHashes.artifact ?? (await hashOrEmpty(resolve(ctx.cwd, params.artifact))),
          kind: "sections" as const,
        },
      };
    },
  });

  pi.registerTool({
    name: "cad_export",
    label: "CAD Export",
    description:
      "Export a STEP artifact or build123d source to an explicit format. Supported deterministic formats: step, stl, glb, brep. Unsupported formats fail explicitly.",
    promptSnippet: "Export a source/artifact to an explicit format",
    promptGuidelines: [
      "STEP remains the primary artifact; other formats are sidecars.",
      "Do not use export to patch design intent into a mesh.",
    ],
    parameters: Type.Object({
      source: Type.String(),
      output: Type.String(),
      format: Type.Enum({ step: "step", stl: "stl", glb: "glb", brep: "brep" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const envelope = await exportArtifact(ctx.cwd, { source: params.source, output: params.output, format: params.format });
      const payload = envelope.payload as { error?: string; output?: string };
      const text = envelope.ok
        ? `cad_export succeeded: ${payload.output ?? params.output}`
        : `cad_export failed: ${payload.error ?? "unknown error"}`;
      return {
        content: [{ type: "text", text }],
        details: {
          envelope,
          artifactHash: envelope.artifacts[0]?.sha256 ?? envelope.inputHashes.source,
          kind: "export" as const,
        },
      };
    },
  });
}
