import { Type } from "typebox";

import { CadProbeParametersSchema, CadRecallObservationParametersSchema } from "../../modules/probe/tool.ts";
import {
  AcceptanceAssertionSchema,
  AssemblyDesignRecordSchema,
  EvidenceObligationsSchema,
  InterfaceContractsRecordSchema,
  RouteParamsSchema,
} from "./tool-schemas.ts";

/**
 * Input schemas of every Mechanical Pack action, kept apart from the Pi
 * extension modules that register them. Pinning the Action Registry reads this
 * table, so the contract needs no extension runtime. Each registering module
 * passes the same object to Pi, so the live schema and the pinned one cannot diverge.
 */
const sourceParam = Type.String({
  description: "Path to the build123d Python source to execute, relative to the project root",
});
const outputParam = Type.String({
  description: "Output STEP path. Defaults to build/<source-stem>.step",
});

const CadSimulateParametersSchema = Type.Object({ recipe: Type.String({ minLength: 1, description: "v7 directory containing pi-recipe.yaml" }), obligationRef: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false });
const CadSimObserveParametersSchema = Type.Object({ run: Type.String({ minLength: 1 }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })) }, { additionalProperties: false });
const CadCommitSimulationParametersSchema = Type.Object({ run: Type.String({ minLength: 1 }), observation: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export const MECHANICAL_ACTION_PARAMETERS = {
  cad_route: RouteParamsSchema,
  cad_reroute: Type.Object(
    {
      objective: Type.Enum({ analyze: "analyze", convert: "convert", design: "design" }),
      lineage: Type.Optional(Type.Enum({ greenfield: "greenfield", legacy: "legacy", hybrid: "hybrid" })),
      structure: Type.Optional(Type.Enum({ part: "part", assembly: "assembly" })),
      maturity: Type.Optional(
        Type.Enum({
          prototype: "prototype",
          engineering: "engineering",
          manufacturing: "manufacturing",
          release: "release",
        }),
      ),
      reason: Type.String({ description: "What changed about the task's shape and why the new route fits" }),
      authorityToken: Type.Optional(Type.String({ description: "One-time harness-issued downgrade authority" })),
    },
    { additionalProperties: false },
  ),
  cad_commit_requirements: Type.Object({
    goal: Type.String(),
    deliverables: Type.Array(Type.String(), { minItems: 1 }),
    must: Type.Array(Type.String(), { default: [] }),
    assertions: Type.Array(AcceptanceAssertionSchema, { default: [] }),
    preferences: Type.Array(Type.String(), { default: [] }),
    assumptions: Type.Array(Type.String(), { default: [] }),
    openUnknowns: Type.Array(Type.String(), { default: [] }),
    deferredClarifications: Type.Optional(Type.Array(Type.Object({
      question: Type.String(),
      reason: Type.String(),
      alternatives: Type.Array(Type.String(), { minItems: 2 }),
      fallback: Type.String(),
      impact: Type.String(),
    }))),
    inputs: Type.Optional(Type.Array(Type.String())),
    evidenceObligations: Type.Optional(EvidenceObligationsSchema),
  }),
  cad_revise_requirements: Type.Object({
    goal: Type.String(),
    deliverables: Type.Array(Type.String(), { minItems: 1 }),
    must: Type.Array(Type.String(), { default: [] }),
    assertions: Type.Array(AcceptanceAssertionSchema, { default: [] }),
    preferences: Type.Array(Type.String(), { default: [] }),
    assumptions: Type.Array(Type.String(), { default: [] }),
    openUnknowns: Type.Array(Type.String(), { default: [] }),
    deferredClarifications: Type.Optional(Type.Array(Type.Object({
      question: Type.String(),
      reason: Type.String(),
      alternatives: Type.Array(Type.String(), { minItems: 2 }),
      fallback: Type.String(),
      impact: Type.String(),
    }))),
    inputs: Type.Optional(Type.Array(Type.String())),
    evidenceObligations: Type.Optional(EvidenceObligationsSchema),
    reason: Type.String({ minLength: 1 }),
    routeAssessment: Type.Object({
      outcome: Type.Enum({ unchanged: "unchanged", changed: "changed" }),
      reason: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  cad_commit_plan: Type.Object({
    summary: Type.String(),
    protected: Type.Array(Type.String(), { default: [] }),
    plannedChanges: Type.Array(Type.String(), { default: [] }),
    interfaces: Type.Array(Type.Any(), { default: [] }),
    datums: Type.Array(Type.String(), { default: [] }),
    reviewPlan: Type.Array(Type.String(), { default: [] }),
    architecture: Type.Optional(Type.Array(Type.String())),
    selectionRationale: Type.Optional(Type.String()),
    evidenceObligations: Type.Optional(EvidenceObligationsSchema),
    workstreams: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String(),
          status: Type.Enum({
            open: "open",
            complete: "complete",
            not_applicable: "not_applicable",
            blocked_external: "blocked_external",
          }),
        }),
      ),
    ),
  }),
  cad_commit_frame_context: Type.Object(
    {
      disposition: Type.Enum({
        confirmed: "confirmed",
        already_provided: "already_provided",
        not_applicable: "not_applicable",
        user_declined: "user_declined",
        assumed_headless: "assumed_headless",
      }, {
        description:
          "confirmed: you asked and the user answered. already_provided: the user stated the mapping unprompted earlier. not_applicable: coordinates carry through and direction is irrelevant. user_declined: the user explicitly declined. assumed_headless: no user turn exists, so a best-effort mapping is recorded as clarification debt.",
      }),
      axes: Type.Array(
        Type.Object(
          {
            axis: Type.Enum({ x: "x", y: "y", z: "z" }),
            mapsTo: Type.String({
              minLength: 1,
              description: "Functional meaning of this artifact axis, in the user's words",
            }),
          },
          { additionalProperties: false },
        ),
        {
          minItems: 3,
          description:
            "All three artifact axes must be mapped — including not_applicable/declined records (a best-effort reading of the file's own axes, honestly attributed)",
        },
      ),
      howConfirmed: Type.String({
        minLength: 1,
        description:
          "What the user pointed at or said when confirming; for other dispositions, why that disposition applies (e.g. which earlier message stated the mapping)",
      }),
      notes: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  cad_commit_assembly_design: AssemblyDesignRecordSchema,
  cad_commit_interface_contracts: InterfaceContractsRecordSchema,
  cad_commit_candidate: Type.Object({
    sources: Type.Array(Type.String(), { minItems: 1 }),
    label: Type.String({ minLength: 1 }),
    format: Type.Optional(Type.String()),
    output: Type.Optional(Type.String()),
  }),
  cad_submit_for_review: Type.Object(
    { summary: Type.Optional(Type.String({ description: "Optional terse submission label; not acceptance evidence" })) },
    { additionalProperties: false },
  ),
  cad_transition: Type.Object({
    event: Type.String(),
    note: Type.String(),
  }),
  cad_wait_for_user: Type.Object({ reason: Type.String() }),
  cad_defer_clarification: Type.Object({
    question: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
    alternatives: Type.Array(Type.String({ minLength: 1 }), { minItems: 2 }),
    fallback: Type.String({ minLength: 1 }),
    impact: Type.String({ minLength: 1 }),
    affectsContract: Type.Boolean(),
  }, { additionalProperties: false }),
  cad_declare_blocker: Type.Object({
    type: Type.Enum({ user_authority: "user_authority", external_input: "external_input" }),
    reason: Type.String({ minLength: 1 }),
    needed: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  cad_finish: Type.Object({}),
  cad_build_step: Type.Object({
    source: sourceParam,
    output: Type.Optional(outputParam),
    force: Type.Optional(Type.Boolean({ description: "Regenerate even if outputs exist" })),
  }),
  cad_export: Type.Object({
    source: Type.String(),
    sourceSha256: Type.Optional(Type.String({ description: "SHA-256 from the selected ArtifactRef; export refuses if the file has changed." })),
    output: Type.String(),
    format: Type.Enum({ step: "step", stl: "stl", glb: "glb", brep: "brep" }),
  }),
  cad_probe: CadProbeParametersSchema,
  cad_recall_observation: CadRecallObservationParametersSchema,
  cad_derive_analysis_model: Type.Object({ recipe: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
  cad_optimize: Type.Object({ recipe: Type.String({ minLength: 1 }), action: Type.Optional(Type.String({ minLength: 1 })), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
  cad_simulate: CadSimulateParametersSchema,
  cad_sim_observe: CadSimObserveParametersSchema,
  cad_commit_simulation: CadCommitSimulationParametersSchema,
  cad_generate_drawing: Type.Object({ recipe: Type.String({ minLength: 1 }), obligationRef: Type.Optional(Type.String({ minLength: 1 })), stage: Type.Enum({ validate: "validate", generate: "generate" }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
  cad_render_scene: Type.Object({ recipe: Type.String({ minLength: 1 }), obligationRef: Type.Optional(Type.String({ minLength: 1 })), stage: Type.Enum({ validate: "validate", preview: "preview", generate: "generate", run: "run" }), outputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) }, { additionalProperties: false }),
} as const;
