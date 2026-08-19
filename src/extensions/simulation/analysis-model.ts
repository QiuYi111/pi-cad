/**
 * Authoritative vs analysis model (0.8 M4, whitepaper section 10).
 *
 * The canonical design is never fused, bonded, or simplified for solver
 * convenience. When a simulation's geometry input is a DERIVED model, the
 * spec must declare it:
 *
 *   analysisModel: { source, operations: ["fused"|"bonded"|...] }
 *
 * and then the evidence SUBJECT is the authoritative design (the source),
 * while the derived model is only a hash-bound input. Fail closed when a
 * derived subject lacks the declaration, and never guess from geometry:
 * the guard compares hashes only.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

import { CadProjectStore, sha256File } from "../../shared/store.ts";

export const AnalysisModelSchema = Type.Object(
  {
    source: Type.String({
      description: "Path of the authoritative design this model derives from (the evidence subject)",
    }),
    operations: Type.Array(
      Type.Enum({
        fused: "fused",
        bonded: "bonded",
        simplified: "simplified",
        defeatured: "defeatured",
        sectioned: "sectioned",
      }),
      { minItems: 1, description: "Deterministic operations applied to derive the analysis model" },
    ),
  },
  { additionalProperties: false },
);

export interface AnalysisModelDeclaration {
  source: string;
  operations: string[];
}

export interface AnalysisModelCheck {
  /** Fail-closed reason; absent when the subject is legitimate. */
  error?: string;
  /**
   * Evidence subject override: the authoritative design's hash when an
   * analysisModel is declared for a derived subject.
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
 *   2. subject is derived and analysisModel is declared -> fine, and the
 *      evidence subject becomes the declared source (which must itself be
 *      canonical — fake provenance fails closed);
 *   3. subject is derived and nothing is declared -> fail closed;
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
        "declare analysisModel {source, operations} with source pointing at the authoritative design",
      ].join("; "),
    };
  }
  const sourceAbs = resolve(cwd, opts.analysisModel.source);
  if (!existsSync(sourceAbs)) {
    return { error: `analysisModel.source does not exist: ${opts.analysisModel.source}` };
  }
  const sourceHash = await sha256File(sourceAbs);
  if (!canonical.has(sourceHash)) {
    return {
      error: `analysisModel.source ${opts.analysisModel.source} is not a canonical design artifact of this workspace`,
    };
  }
  // The evidence is ABOUT the authoritative design; the derived model is
  // only a hash-bound input.
  return { subjectOverrideHash: sourceHash };
}
