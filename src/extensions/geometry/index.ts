import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { Type } from "typebox";

import {
  buildPayload,
  buildStep,
  defaultBuildOutput,
  envelopeArtifactHash,
  exportArtifact,
  hashOrEmpty,
  probePython,
} from "../../shared/capability.ts";
import { ensureProbePresets, probePreset, renderProbeResult } from "../../modules/probe/index.ts";

const artifactParam = Type.String({
  description: "Path to the STEP/STP artifact to inspect, relative to the project root",
});
const sourceParam = Type.String({
  description: "Path to the build123d Python source to execute, relative to the project root",
});
const outputParam = Type.String({
  description: "Output STEP path. Defaults to build/<source-stem>.step",
});

/** Phase 2: legacy tools are thin wrappers over the probe registry. */
async function runProbePreset(
  presetName: string,
  args: unknown,
  cwd: string,
  label: string,
) {
  ensureProbePresets();
  const preset = probePreset(presetName);
  if (!preset) {
    return {
      content: [{ type: "text", text: `${label} failed: preset ${presetName} not registered` }],
    };
  }
  const result = await preset.run(args as never, { cwd });
  return renderProbeResult(result, label);
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
      if (!envelope.ok) {
        return {
          content: [
            { type: "text", text: `cad_build_step failed: ${buildPayload(envelope).error ?? "unknown error"}` },
          ],
          details: { envelope, sourceHash },
        };
      }
      const { content, details } = await renderProbeResult(
        {
          envelope,
          headline: `cad_build_step: ${params.source} → ${output}`,
          artifactHashFrom: "source",
          extraDetails: {
            artifactHash: envelopeArtifactHash(envelope, "step"),
            sourceHash,
          },
        },
        "cad_build_step",
      );
      return { content, details };
    },
  });

  pi.registerTool({
    name: "cad_inspect_geometry",
    label: "CAD Inspect Geometry",
    description:
      "[Deprecated wrapper — call cad_probe with preset=geometry instead; retires after the Phase 3 benchmark gate.] Return deterministic STEP/B-Rep facts: bbox, volume, surface area, solid count, occurrence count, and labels/planes/cylinders. Geometry classification is not engineering naming; a cylinder is only #cN.",
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
      return runProbePreset("geometry", params, ctx.cwd, "cad_inspect_geometry");
    },
  });

  pi.registerTool({
    name: "cad_inspect_surfaces",
    label: "CAD Inspect Surfaces",
    description:
      "[Deprecated wrapper — call cad_probe with preset=surfaces instead; retires after the Phase 3 benchmark gate.] Enumerate deterministic boundary-surface facts for a STEP artifact and return current-artifact-scoped surface IDs, geometry properties, and optional labeled views. Surface IDs are selectors only; this tool never decides which surface is an inlet, outlet, wall, thermal boundary, interface, or manufacturing feature.",
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
      return runProbePreset(
        "surfaces",
        {
          artifact: params.artifact,
          labels: params.labels ?? true,
          views: params.views?.length ? params.views : undefined,
        },
        ctx.cwd,
        "cad_inspect_surfaces",
      );
    },
  });

  pi.registerTool({
    name: "cad_measure",
    label: "CAD Measure",
    description:
      "[Deprecated wrapper — call cad_probe with preset=measure instead; retires after the Phase 3 benchmark gate.] Return one deterministic numeric measurement for an explicit selector and metric. Cylindrical faces use #cN. distance between two cylindrical faces is axis-to-axis distance; use clearance for closest surface distance. Other selectors: #pN planar face, #fN any face.",
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
      return runProbePreset("measure", params, ctx.cwd, "cad_measure");
    },
  });

  pi.registerTool({
    name: "cad_inspect_section",
    label: "CAD Inspect Section",
    description:
      "[Deprecated wrapper — call cad_probe with preset=section instead; retires after the Phase 3 benchmark gate.] Render a deterministic section plane through a STEP artifact and return the image plus intersection facts. The tool does not name the section or explain it.",
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
      return runProbePreset(
        "section",
        {
          artifact: params.artifact,
          origin: params.origin as [number, number, number],
          normal: params.normal as [number, number, number],
          display: params.display ?? "solid",
          width: params.width ?? 640,
          height: params.height ?? 480,
          labels: params.labels ?? true,
        },
        ctx.cwd,
        "cad_inspect_section",
      );
    },
  });

  pi.registerTool({
    name: "cad_compare_geometry",
    label: "CAD Compare Geometry",
    description:
      "[Deprecated wrapper — call cad_probe with preset=compare instead; retires after the Phase 3 benchmark gate.] Return a deterministic before/after geometry diff: bbox, volume, surface area, entity counts, center delta, and common volume. No engineering interpretation.",
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
      let transformBefore: number[][] | undefined;
      let transformAfter: number[][] | undefined;
      if (params.transformBefore) transformBefore = JSON.parse(params.transformBefore) as number[][];
      if (params.transformAfter) transformAfter = JSON.parse(params.transformAfter) as number[][];
      return runProbePreset(
        "compare",
        {
          before: params.before,
          after: params.after,
          metrics: params.metrics ?? undefined,
          transformBefore,
          transformAfter,
          output: params.output,
        },
        ctx.cwd,
        "cad_compare_geometry",
      );
    },
  });

  pi.registerTool({
    name: "cad_assembly_tree",
    label: "CAD Assembly Tree",
    description:
      "[Deprecated wrapper — call cad_probe with preset=assembly instead; retires after the Phase 3 benchmark gate.] Return occurrence labels, parent/child paths, local transforms, world transforms, and leaf count for a STEP assembly. Labels are only those present in the file.",
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
      return runProbePreset("assembly", params, ctx.cwd, "cad_assembly_tree");
    },
  });

  pi.registerTool({
    name: "cad_inspect_interference",
    label: "CAD Interference Facts",
    description:
      "[Deprecated wrapper — call cad_probe with preset=interference instead; retires after the Phase 3 benchmark gate.] Pairwise solid interference facts for a STEP assembly: intersection volume, minimum distance, and a three-state classification (penetration/contact/clearance) per part pair. Raw facts only — the tool never says pass or fail.",
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
      return runProbePreset("interference", params, ctx.cwd, "cad_inspect_interference");
    },
  });

  pi.registerTool({
    name: "cad_scan_sections",
    label: "CAD Scan Sections",
    description:
      "[Deprecated wrapper — call cad_probe with preset=sections_scan instead; retires after the Phase 3 benchmark gate.] Scan deterministic cross-section facts along an axis: per-section area, centroid, in-plane second moments, principal moments, bbox, and loop count. Facts only — which section is critical is your engineering judgment.",
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
      return runProbePreset(
        "sections-scan",
        {
          artifact: params.artifact,
          axis: params.axis,
          count: params.count,
          step: params.step,
        },
        ctx.cwd,
        "cad_scan_sections",
      );
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
      if (!envelope.ok) {
        const error = (envelope.payload as { error?: string }).error;
        return {
          content: [{ type: "text", text: `cad_export failed: ${error ?? "unknown error"}` }],
          details: { envelope },
        };
      }
      const payload = envelope.payload as { output?: string };
      return renderProbeResult(
        {
          envelope,
          headline: `cad_export succeeded: ${payload.output ?? params.output}`,
          includeEnvelope: false,
          artifactHashFrom: "source",
          extraDetails: {
            artifactHash: envelope.artifacts[0]?.sha256 ?? envelope.inputHashes.source,
            kind: "export",
          },
        },
        "cad_export",
      );
    },
  });

  pi.registerTool({
    name: "cad_probe_python",
    label: "CAD Probe Python",
    description:
      "[Deprecated wrapper — call cad_probe with preset=python instead; retires after the Phase 3 benchmark gate.] Run a read-only programmable B-Rep probe: arbitrary Python computation over the current (or baseline) design, returning a JSON result. Pure observability — no filesystem, import, subprocess, or network inside the probe; the subject is resolved from run state, never from a path you supply.",
    promptSnippet: "Compute any derived geometric quantity with Python (read-only)",
    promptGuidelines: [
      "Use when the typed inspection tools cannot express the quantity you need: derived ratios, fill/shape factors, symmetry checks, hole spacing patterns, mass-property relations, custom topology statistics.",
      "The scope preloads shape (the imported STEP), bd (build123d), np, math, statistics. Assign a JSON-serializable dict to result.",
      "subject=current|baseline is resolved by the harness from run state; you cannot pass an artifact path.",
      "This is observation, not evidence: results are hash-bound and auditable but do not create canonical evidence obligations.",
    ],
    parameters: Type.Object(
      {
        subject: Type.Enum({ current: "current", baseline: "baseline" }),
        purpose: Type.String({ description: "What engineering question this probe answers" }),
        code: Type.String({ description: "Python probe body; must set 'result' to a JSON-serializable value" }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { CadProjectStore } = await import("../../shared/store.ts");
      const store = new CadProjectStore(ctx.cwd);
      const state = await store.load();
      if (!state) {
        return { content: [{ type: "text", text: "cad_probe_python failed: no active Pi-CAD workflow" }] };
      }
      const rel =
        params.subject === "current" ? state.currentArtifactPath : state.baselineArtifactPath;
      if (!rel) {
        return {
          content: [{
            type: "text",
            text: `cad_probe_python failed: no ${params.subject} artifact bound in run state`,
          }],
        };
      }
      const envelope = await probePython(ctx.cwd, rel, params.code);
      const payload = envelope.payload as { result?: unknown; error?: string };
      return renderProbeResult(
        {
          envelope,
          headline: `cad_probe_python (${params.subject}, ${params.purpose}) = ${JSON.stringify(payload.result ?? null, null, 2)}`,
          includeEnvelope: false,
          // Deliberately no kind: probe results are observations, not
          // canonical evidence — they must not enter state.evidence.
          extraDetails: {
            subjectArtifactHash: envelope.inputHashes.artifact,
            scriptHash: envelope.inputHashes.script,
          },
        },
        "cad_probe_python",
      );
    },
  });
}
