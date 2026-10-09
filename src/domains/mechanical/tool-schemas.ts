import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";

import type { CadRequirements, Route } from "../../shared/protocol.ts";

export function okTool(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

export function errTool(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details, isError: true };
}

export function validateInputDeclarations(record: CadRequirements, cwd: string): string | null {
  for (const [index, input] of (record.inputs ?? []).entries()) {
    if (typeof input !== "string" || !input.trim()) return `requirements.inputs[${index}] must be a non-empty path`;
    if (!/\.(step|stp)$/i.test(input)) {
      return `requirements.inputs[${index}] must reference a .step or .stp artifact`;
    }
    const absolute = resolve(cwd, input);
    const rel = relative(resolve(cwd), absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) return `requirements.inputs[${index}] escapes the project root`;
    if (existsSync(absolute)) {
      const real = realpathSync(absolute);
      const realRel = relative(realpathSync(cwd), real);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        return `requirements.inputs[${index}] resolves outside the project root`;
      }
    }
  }
  return null;
}

/**
 * Route parameter schemas. Cross-field rules are enforced fail-closed in the
 * backend after structural validation: objective=design requires the full
 * tuple, analyze/convert must not carry it.
 */
export const RouteParamsSchema = Type.Object(
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
    reason: Type.String({ description: "Why this route matches the task, decided level by level" }),
  },
  { additionalProperties: false },
);

/**
 * Strict evidence-obligations schema, shared by requirements and plan.
 *
 * additionalProperties: false at EVERY level: a typo like "casez" must fail
 * closed at the tool boundary. Silently dropping it would degrade a
 * case-scoped obligation back to the legacy "any simulation evidence
 * satisfies required" semantics.
 */
export const SimulationCaseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    tool: Type.Literal("cad_simulate"),
  },
  { additionalProperties: false },
);

export const EvidenceObligationsSchema = Type.Object(
  {
    simulation: Type.Optional(
      Type.Object(
        {
          disposition: Type.Enum({
            required: "required",
            optional: "optional",
            not_applicable: "not_applicable",
            blocked_external: "blocked_external",
          }),
          rationale: Type.Optional(Type.String()),
          cases: Type.Optional(
            Type.Array(SimulationCaseSchema, {
              minItems: 1,
              description:
                "Opaque Recipe-native simulation cases: the harness checks current-version evidence from cad_simulate but never interprets what a case means",
            }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const AssertionExpectationSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("exact"),
      value: Type.Number(),
      unit: Type.Optional(Type.String()),
      tolerance: Type.Optional(Type.Number({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("range"),
      min: Type.Optional(Type.Number()),
      max: Type.Optional(Type.Number()),
      unit: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("boolean"), expected: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("relation"), description: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

export const AcceptanceAssertionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    mustRef: Type.String({ pattern: "^M[1-9][0-9]*$" }),
    statement: Type.String({
      minLength: 1,
      description: "Observable acceptance claim about the completed deliverable; never describe feature history, pre-operation construction geometry, or removed geometry",
    }),
    binding: Type.Object(
      {
        subject: Type.String({
          minLength: 1,
          description: "Entity observable in the completed deliverable",
        }),
        quantity: Type.String({ minLength: 1 }),
        reference: Type.Optional(Type.String({
          minLength: 1,
          description: "Reference observable or derivable from the completed deliverable, not an intermediate or removed entity",
        })),
        direction: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    expectation: AssertionExpectationSchema,
    canonicalCheck: Type.Optional(
      Type.Object(
        {
          field: Type.Enum({
            bbox_x: "bbox.x",
            bbox_y: "bbox.y",
            bbox_z: "bbox.z",
            volume: "volume",
            surfaceArea: "surfaceArea",
            solidCount: "solidCount",
            occurrenceCount: "occurrenceCount",
            cylinderCount: "cylinderCount",
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * Fail-closed cross-field validation of route params: design requires the
 * full tuple, analyze/convert must not carry any of it. Returns the Route
 * or an error string.
 */
export function buildRoute(
  params: Record<string, string | undefined>,
): Route | string {
  const { objective, lineage, structure, maturity } = params;
  if (objective === "analyze" || objective === "convert") {
    if (lineage !== undefined || structure !== undefined || maturity !== undefined) {
      return `${objective} routes take no lineage/structure/maturity; those belong to objective=design`;
    }
    return { objective } as Route;
  }
  if (objective !== "design") return `unsupported objective: ${objective}`;
  if (!lineage || !structure || !maturity) {
    return "objective=design requires lineage, structure, and maturity together";
  }
  return { objective: "design", lineage, structure, maturity } as Route;
}

/**
 * Assembly design record (whitepaper 7.3): the four architecture questions.
 * Strict at every level — unknown fields fail closed at the tool boundary.
 */
export const AssemblyDesignRecordSchema = Type.Object(
  {
    summary: Type.String({ minLength: 1 }),
    modules: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          purpose: Type.String({ minLength: 1 }),
          envelopeMm: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
          notes: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, description: "An assembly has at least two modules" },
    ),
    datums: Type.Array(
      Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          kind: Type.Enum({ primary: "primary", secondary: "secondary", tertiary: "tertiary" }),
          definedBy: Type.String({ minLength: 1, description: "Physical features that realize this datum" }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    sequence: Type.Array(
      Type.Object(
        {
          step: Type.Number(),
          installs: Type.Array(Type.String(), { minItems: 1 }),
          notes: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, description: "Install order; each step names the modules it installs" },
    ),
    envelopes: Type.Optional(
      Type.Array(
        Type.Object(
          {
            module: Type.String(),
            bboxMm: Type.Tuple([
              Type.Number(),
              Type.Number(),
              Type.Number(),
              Type.Number(),
              Type.Number(),
              Type.Number(),
            ]),
            massKg: Type.Optional(Type.Number()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * Interface contracts record (whitepaper 7.4): one entry per A↔B pair with
 * the ten contract items.
 */
export const InterfaceContractsRecordSchema = Type.Object(
  {
    contracts: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          a: Type.String({ minLength: 1, description: "Module on side A" }),
          b: Type.String({ minLength: 1, description: "Module on side B" }),
          purpose: Type.String({ minLength: 1 }),
          locating: Type.String({ minLength: 1, description: "Locating scheme: which features/datums locate A against B" }),
          dof: Type.String({ minLength: 1, description: "Which degrees of freedom the interface constrains" }),
          fasteners: Type.String({ minLength: 1, description: "Fastener plan (type, size, count) or 'none/integral'" }),
          fits: Type.String({ minLength: 1, description: "Fits and tolerances at the locating features" }),
          assemblyDirection: Type.String({ minLength: 1, description: "Direction the parts approach along" }),
          toolAccess: Type.String({ minLength: 1, description: "Tool access for fastening/inspection" }),
          notes: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);
