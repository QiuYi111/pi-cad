/**
 * Authoritative vs analysis model (0.8 M4 + review P0-6).
 *
 * The canonical design is never fused, bonded, or simplified for solver
 * convenience. When a simulation's geometry input is a DERIVED model, the
 * derivation must be a harness-owned record, not an agent claim:
 *
 *   cad_derive_analysis_model({ source, operations, output? })
 *     - fused/bonded: the harness performs the boolean union itself and
 *       writes the output STEP — mechanically verified.
 *     - simplified/defeatured/sectioned: the Agent authors the model; the
 *       harness hashes both ends at record time (authored, labeled).
 *
 * Simulations declare { analysisModel: { derivationRef } } pointing at the
 * stored record. The guard verifies:
 *   1. the record exists and parses;
 *   2. record.sourceHash IS a canonical artifact of the workspace
 *      (compared by hash only — no geometry heuristics);
 *   3. record.outputHash MATCHES the geometry actually being solved —
 *      an unrelated STEP can no longer claim provenance, closing the
 *      "source is real but the derivation is not" hole.
 *
 * The evidence SUBJECT then becomes the authoritative design; the derived
 * model stays a hash-bound input.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

import { CadProjectStore, sha256File } from "../../shared/store.ts";

export const DeriveAnalysisModelSchema = Type.Object(
  {
    source: Type.String({ description: "Authoritative design STEP this model derives from" }),
    operations: Type.Array(
      Type.Enum({
        fused: "fused",
        bonded: "bonded",
        simplified: "simplified",
        defeatured: "defeatured",
        sectioned: "sectioned",
      }),
      { minItems: 1, description: "fused/bonded are executed by the harness; simplified/defeatured/sectioned record your authored model" },
    ),
    output: Type.Optional(
      Type.String({ description: "Output STEP. Required for authored operations; optional for fused/bonded (harness writes it)" }),
    ),
  },
  { additionalProperties: false },
);

export const AnalysisModelSchema = Type.Object(
  {
    derivationRef: Type.String({
      description: "Path of the harness-owned derivation record (from cad_derive_analysis_model)",
    }),
  },
  { additionalProperties: false },
);

export interface AnalysisModelDeclaration {
  derivationRef: string;
}

interface DerivationRecord {
  sourceHash?: string;
  outputHash?: string;
  executed?: boolean;
  operations?: string[];
}

export interface AnalysisModelCheck {
  /** Fail-closed reason; absent when the subject is legitimate. */
  error?: string;
  /**
   * Evidence subject override: the authoritative design's hash when the
   * subject is a derived model with a valid derivation record.
   */
  subjectOverrideHash?: string;
}

async function canonicalHashes(cwd: string): Promise<Set<string>> {
  const canonical = new Set<string>();
  const store = new CadProjectStore(cwd);
  try {
    const state = await store.load();
    if (state?.currentArtifactHash) canonical.add(state.currentArtifactHash);
    if (state?.baselineArtifactHash) canonical.add(state.baselineArtifactHash);
  } catch {
    // no active run — the head still defines the design
  }
  try {
    const project = await store.loadProject();
    if (project?.head.artifactHash) canonical.add(project.head.artifactHash);
  } catch {
    // no project yet (adhoc use) — nothing to protect
  }
  return canonical;
}

/**
 * Verify the simulation subject against the canonical design hashes of the
 * workspace. Rules:
 *
 *   1. subject hash is canonical -> fine (derived inputs like fluidDomain
 *      are already hash-bound via inputArtifacts);
 *   2. subject is derived with a valid derivation record -> fine, and the
 *      evidence subject becomes the record's source (which must itself be
 *      canonical);
 *   3. subject is derived with no declaration -> fail closed;
 *   4. no canonical design in the workspace -> adhoc use, nothing to
 *      protect.
 */
export async function verifyAnalysisModel(
  cwd: string,
  opts: {
    subject: string;
    analysisModel?: AnalysisModelDeclaration;
  },
): Promise<AnalysisModelCheck> {
  const canonical = await canonicalHashes(cwd);
  if (canonical.size === 0) return {};
  const subjectAbs = resolve(cwd, opts.subject);
  if (!existsSync(subjectAbs)) return { error: `simulation subject does not exist: ${opts.subject}` };
  const subjectHash = await sha256File(subjectAbs);
  if (canonical.has(subjectHash)) return {};

  if (!opts.analysisModel) {
    return {
      error: [
        `simulation subject ${opts.subject} is not the canonical design of this workspace`,
        "and no analysisModel is declared: the canonical design is never fused/bonded/simplified for solver convenience",
        "create a derivation with cad_derive_analysis_model, then declare analysisModel {derivationRef}",
      ].join("; "),
    };
  }
  const recordAbs = resolve(cwd, opts.analysisModel.derivationRef);
  if (!existsSync(recordAbs)) {
    return { error: `analysisModel.derivationRef does not exist: ${opts.analysisModel.derivationRef}` };
  }
  let record: DerivationRecord;
  try {
    record = JSON.parse(await readFile(recordAbs, "utf-8")) as DerivationRecord;
  } catch {
    return { error: `analysisModel.derivationRef is not a readable derivation record: ${opts.analysisModel.derivationRef}` };
  }
  if (!record.sourceHash || !record.outputHash) {
    return { error: `derivation record is malformed (needs sourceHash and outputHash): ${opts.analysisModel.derivationRef}` };
  }
  // THE closing check: the geometry being solved must be exactly what the
  // derivation produced — an unrelated STEP cannot borrow provenance.
  if (record.outputHash !== subjectHash) {
    return {
      error: [
        `simulation subject ${opts.subject} is not the model the derivation record produced`,
        "(record output hash does not match the subject): create a fresh derivation for this geometry",
      ].join("; "),
    };
  }
  if (!canonical.has(record.sourceHash)) {
    return {
      error: `derivation record's source is not a canonical design artifact of this workspace`,
    };
  }
  // The evidence is ABOUT the authoritative design; the derived model is
  // only a hash-bound input.
  return { subjectOverrideHash: record.sourceHash };
}
