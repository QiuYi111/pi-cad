/**
 * Acceptance gate (adversarial review, three layers).
 *
 * Layer T1 — deterministic reconciliation: every numeric claim in the
 * agent's acceptance checks must appear in the measured evidence digest
 * (bbox dims / volume / surface area / topology counts / measure values).
 * Pure number set membership + tolerance. No NLP. Fail-closed.
 *
 * Layer T2 — structured acceptance: `accepted` must carry one check per
 * Mission Must item ({mustRef, claimedValue?, basis}). Forcing the agent
 * to walk the list at the moment of acceptance.
 *
 * Layer T3 — adversarial reviewer (env PI_CAD_ACCEPTANCE_REVIEWER=1):
 * one small LLM call over Must + checks + digest. Burden of proof is
 * inverted: it must find contradictions. The LLM never issues the
 * verdict — its structured `assertions` are cross-checked by the SAME
 * deterministic reconciliation (LLM as translator, harness as judge),
 * and its objections become blocking probe demands. Budget-capped:
 * after PI_CAD_ACCEPTANCE_MAX_BLOCKS the acceptance proceeds with the
 * dissent recorded in the event journal (never deadlocks the run).
 *
 * This module is control plane: no cadctl, no backend imports.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CadRunState, EvidenceRef } from "../shared/protocol.ts";
import { CadRunStore } from "../shared/store.ts";

/** Relative tolerance for dimension/volume/area claims (1%). */
const REL_TOLERANCE = 0.01;
/** Reviewer budget: blocking objections may block this many acceptances per run. */
const DEFAULT_MAX_BLOCKS = 2;
/** Char budget for the digest summary handed to the reviewer. */
const DIGEST_PROMPT_BUDGET = 4000;

// ---------------------------------------------------------------------------
// Evidence digest (deterministic)
// ---------------------------------------------------------------------------

export interface EvidenceDigest {
  /** label → measured number, e.g. "bbox.x" → 1.5, "cylinderCount" → 0. */
  numbers: Record<string, number>;
  /** Human-readable one-liners for prompts and block messages. */
  lines: string[];
}

interface EvidenceEnvelopeLike {
  payload?: {
    bbox?: { x?: number; y?: number; z?: number };
    volume?: number;
    surfaceArea?: number;
    solidCount?: number;
    cylinders?: unknown[];
    planes?: unknown[];
    value?: number;
    metric?: string;
  };
}

async function readEvidenceEnvelope(path: string): Promise<EvidenceEnvelopeLike | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as EvidenceEnvelopeLike;
  } catch {
    return null;
  }
}

/**
 * Newest geometry (+measure) evidence for the current artifact hash,
 * reduced to a flat number set. This is the ONLY truth the gate trusts.
 */
export async function buildEvidenceDigest(
  cwd: string,
  state: CadRunState,
): Promise<EvidenceDigest | null> {
  const hash = state.currentArtifactHash;
  if (!hash) return null;
  const refs = (state.evidence ?? []).filter(
    (ref: EvidenceRef) =>
      (ref.kind === "geometry" || ref.kind === "measure") &&
      ref.artifactHash === hash &&
      ref.paths?.length,
  );
  if (!refs.length) return null;

  const numbers: Record<string, number> = {};
  const lines: string[] = [];
  // Process in order; later refs (newer) overwrite earlier labels.
  for (const ref of refs) {
    const envelope = await readEvidenceEnvelope(ref.paths[ref.paths.length - 1]);
    const p = envelope?.payload;
    if (!p) continue;
    if (ref.kind === "geometry") {
      if (p.bbox?.x !== undefined) numbers["bbox.x"] = p.bbox.x;
      if (p.bbox?.y !== undefined) numbers["bbox.y"] = p.bbox.y;
      if (p.bbox?.z !== undefined) numbers["bbox.z"] = p.bbox.z;
      if (p.volume !== undefined) numbers.volume = p.volume;
      if (p.surfaceArea !== undefined) numbers.surfaceArea = p.surfaceArea;
      if (p.solidCount !== undefined) numbers.solidCount = p.solidCount;
      if (Array.isArray(p.cylinders)) numbers.cylinderCount = p.cylinders.length;
      if (Array.isArray(p.planes)) numbers.planeCount = p.planes.length;
      lines.push(
        `geometry: bbox=[${p.bbox?.x ?? "?"}, ${p.bbox?.y ?? "?"}, ${p.bbox?.z ?? "?"}] ` +
          `volume=${p.volume ?? "?"} surfaceArea=${p.surfaceArea ?? "?"} ` +
          `solids=${p.solidCount ?? "?"} cylinders=${Array.isArray(p.cylinders) ? p.cylinders.length : "?"}`,
      );
    } else if (ref.kind === "measure" && typeof p.value === "number") {
      const label = `measure.${p.metric ?? "value"}`;
      numbers[label] = p.value;
      lines.push(`measure ${p.metric ?? "value"}=${p.value}`);
    }
  }
  if (!lines.length) return null;
  return { numbers, lines };
}

// ---------------------------------------------------------------------------
// T1: deterministic reconciliation
// ---------------------------------------------------------------------------

export interface AcceptanceCheck {
  mustRef: string;
  claimedValue?: number;
  unit?: string;
  basis: string;
}

export interface ReconciliationContradiction {
  mustRef: string;
  claimed: number;
  digest: string;
}

const COUNT_KEYS = new Set(["solidCount", "cylinderCount", "planeCount"]);

function numbersMatch(claimed: number, key: string, value: number): boolean {
  if (COUNT_KEYS.has(key)) return claimed === value;
  const tol = Math.abs(value) * REL_TOLERANCE;
  return Math.abs(claimed - value) <= Math.max(tol, 1e-9);
}

/** A claim passes when it matches ANY number in the digest. */
export function reconcileClaim(
  claim: { mustRef: string; claimedValue: number },
  digest: EvidenceDigest,
): ReconciliationContradiction | null {
  for (const [key, value] of Object.entries(digest.numbers)) {
    if (numbersMatch(claim.claimedValue, key, value)) return null;
  }
  const digestView = Object.entries(digest.numbers)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")
    .slice(0, 300);
  return { mustRef: claim.mustRef, claimed: claim.claimedValue, digest: digestView };
}

// ---------------------------------------------------------------------------
// T3: adversarial reviewer
// ---------------------------------------------------------------------------

export interface ReviewerAssertion {
  mustRef: string;
  metric?: string;
  expected?: number;
  tolerance?: number;
}

export interface ReviewerObjection {
  mustRef: string;
  severity?: string;
  why: string;
  suggestedProbe?: string;
}

export interface ReviewerVerdict {
  assertions: ReviewerAssertion[];
  objections: ReviewerObjection[];
}

const REVIEWER_PROMPT = `You are the acceptance reviewer inside a mechanical CAD harness. Your job is to BLOCK bad acceptances, not to approve them. Burden of proof is on the design: anything the measurements do not show is NOT verified.

Inputs: the Mission Must items, the accepting agent's checks, its acceptance note, and the measured evidence digest (the only truth you may trust — never trust the note or the checks' bases).

For every Must item, decide: supported / contradicted / insufficient_evidence, based strictly on the digest numbers. A numeric requirement whose number does not appear in the digest (within ~1% for dimensions/volumes, exact for counts) is contradicted or unverifiable. A topological requirement (e.g. "through hole", "semicircular cut") must be backed by a matching digest signature (e.g. cylinders>=1) or it is insufficient_evidence.

Output STRICT JSON only, no prose, no code fences:
{
  "assertions": [
    {"mustRef": "<verbatim Must item>", "metric": "width", "expected": 0.52105, "tolerance": 0.01}
  ],
  "objections": [
    {"mustRef": "<verbatim Must item>", "severity": "blocking", "why": "<the contradiction or missing measurement, citing digest numbers>", "suggestedProbe": "<one concrete cad_probe call that would settle it>"}
  ]
}

assertions: translate EVERY numeric or topological Must item (including ones the agent's checks missed or lied about) into {mustRef, metric, expected, tolerance}. These will be cross-checked deterministically against the digest.
objections: every Must item not supported by the digest. severity=blocking for numeric contradictions and missing required topology; severity=note for minor caveats. suggestedProbe must be a specific measurement, never "check again".`;

function reviewerEnabled(): boolean {
  return process.env.PI_CAD_ACCEPTANCE_REVIEWER === "1";
}

function reviewerModel(ctx: ExtensionContext): unknown | undefined {
  const spec = process.env.PI_CAD_ACCEPTANCE_MODEL;
  if (spec) {
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const registry = ctx.modelRegistry as unknown as {
        find?: (provider: string, modelId: string) => unknown | undefined;
      };
      const found = registry.find?.(spec.slice(0, slash), spec.slice(slash + 1));
      if (found) return found;
    }
  }
  return ctx.model;
}

function reviewerReasoning(): string | undefined {
  const raw = process.env.PI_CAD_ACCEPTANCE_REASONING?.trim().toLowerCase();
  if (!raw) return "medium";
  if (raw === "off" || raw === "none") return undefined;
  return raw;
}

function parseReviewerJson(text: string): ReviewerVerdict | null {
  const stripped = text.replace(/```(?:json)?/g, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as Partial<ReviewerVerdict>;
    return {
      assertions: Array.isArray(parsed.assertions) ? parsed.assertions : [],
      objections: Array.isArray(parsed.objections) ? parsed.objections : [],
    };
  } catch {
    return null;
  }
}

async function runReviewer(
  ctx: ExtensionContext,
  input: { must: string[]; checks: AcceptanceCheck[]; note: string; digest: EvidenceDigest },
): Promise<ReviewerVerdict | null> {
  const model = reviewerModel(ctx);
  if (!model) return null;
  const registry = ctx.modelRegistry as unknown as {
    complete?: (
      model: unknown,
      request: { messages: Array<Record<string, unknown>> },
      options: Record<string, unknown>,
    ) => Promise<{ content?: Array<{ type?: string; text?: string }>; usage?: unknown; stopReason?: string }>;
  };
  if (!registry.complete) return null;

  const prompt = [
    REVIEWER_PROMPT,
    "",
    "<mission_must>",
    ...input.must.map((m, i) => `${i + 1}. ${m}`),
    "</mission_must>",
    "",
    "<agent_checks>",
    input.checks.length
      ? input.checks
          .map(
            (c) =>
              `- mustRef: ${c.mustRef}${c.claimedValue !== undefined ? ` | claimed: ${c.claimedValue}${c.unit ? ` ${c.unit}` : ""}` : ""} | basis: ${c.basis}`,
          )
          .join("\n")
      : "(none provided)",
    "</agent_checks>",
    "",
    "<acceptance_note>",
    input.note || "(empty)",
    "</acceptance_note>",
    "",
    "<evidence_digest>",
    ...input.digest.lines.slice(0, DIGEST_PROMPT_BUDGET / 80),
    "</evidence_digest>",
  ].join("\n");

  try {
    const response = await registry.complete(
      model,
      {
        messages: [
          { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: 4096,
        cacheRetention: "none",
        ...(reviewerReasoning() ? { reasoningEffort: reviewerReasoning() } : {}),
      },
    );
    const text = (response.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join("\n");
    if (!text) return null;
    return parseReviewerJson(text);
  } catch {
    // Reviewer failure must never hard-block: gate degrades to T1/T2.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gate orchestration
// ---------------------------------------------------------------------------

const blocksByRun = new Map<string, number>();

function maxBlocks(): number {
  const raw = Number(process.env.PI_CAD_ACCEPTANCE_MAX_BLOCKS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_BLOCKS;
}

export interface AcceptanceGateInput {
  cwd: string;
  state: CadRunState;
  checks?: AcceptanceCheck[];
  note?: string;
  ctx?: ExtensionContext;
}

export interface AcceptanceGateResult {
  ok: boolean;
  reason?: string;
  /** Recorded dissent when acceptance proceeded past the block budget. */
  dissent?: ReviewerObjection[];
}

async function loadMissionMust(cwd: string, state: CadRunState): Promise<string[]> {
  try {
    const run = new CadRunStore(cwd, state.runId);
    const raw = await readFile(join(run.recordsDir, "requirements.json"), "utf-8");
    const requirements = JSON.parse(raw) as { must?: string[] };
    return Array.isArray(requirements.must) ? requirements.must : [];
  } catch {
    return [];
  }
}

export async function runAcceptanceGate(
  input: AcceptanceGateInput,
): Promise<AcceptanceGateResult> {
  const { cwd, state } = input;
  const must = await loadMissionMust(cwd, state);
  if (!must.length) return { ok: true }; // nothing to reconcile against

  const checks = input.checks ?? [];
  const problems: string[] = [];

  // T2: one check per Must item, each with a stated basis.
  if (checks.length < must.length) {
    problems.push(
      `acceptance checks cover ${checks.length}/${must.length} Mission Must items — provide one check per Must, each citing the measured value from current evidence`,
    );
  }
  for (const check of checks) {
    if (!check.mustRef?.trim() || !check.basis?.trim()) {
      problems.push(`every check needs mustRef and basis (got: ${JSON.stringify(check).slice(0, 120)})`);
    }
  }

  // Digest + T1 reconciliation (deterministic).
  const digest = await buildEvidenceDigest(cwd, state);
  const numericClaims = checks.filter((c) => typeof c.claimedValue === "number");
  if (numericClaims.length && !digest) {
    return {
      ok: false,
      reason:
        "cannot verify claimed values: no readable geometry/measure evidence for the current artifact hash — re-run the probes before accepting",
    };
  }
  if (digest) {
    for (const claim of numericClaims) {
      const contradiction = reconcileClaim(
        { mustRef: claim.mustRef, claimedValue: claim.claimedValue as number },
        digest,
      );
      if (contradiction) {
        problems.push(
          `check "${contradiction.mustRef}" claims ${contradiction.claimed}, but the measured evidence says: ${contradiction.digest}`,
        );
      }
    }
  }

  // T3: adversarial reviewer (env-gated).
  if (reviewerEnabled() && input.ctx && digest) {
    const verdict = await runReviewer(input.ctx, {
      must,
      checks,
      note: input.note ?? "",
      digest,
    });
    if (verdict) {
      // Reviewer assertions get the SAME deterministic cross-check: the
      // LLM translates Must → numbers, the harness judges them.
      for (const assertion of verdict.assertions) {
        if (typeof assertion.expected !== "number") continue;
        const contradiction = reconcileClaim(
          { mustRef: assertion.mustRef, claimedValue: assertion.expected },
          digest,
        );
        if (contradiction) {
          problems.push(
            `reviewer: Must "${contradiction.mustRef}" expects ${contradiction.claimed}; measured evidence: ${contradiction.digest}`,
          );
        }
      }
      const blocking = verdict.objections.filter((o) => (o.severity ?? "blocking") === "blocking");
      if (blocking.length) {
        const used = blocksByRun.get(state.runId) ?? 0;
        if (used < maxBlocks()) {
          blocksByRun.set(state.runId, used + 1);
          const rendered = blocking
            .map(
              (o) =>
                `- Must "${o.mustRef}": ${o.why}${o.suggestedProbe ? ` (settle it: ${o.suggestedProbe})` : ""}`,
            )
            .join("\n");
          // Deterministic contradictions are harder evidence than
          // objections — always surface them alongside.
          const deterministic = problems.length ? `Measured-evidence contradictions:\n${problems.map((p) => `- ${p}`).join("\n")}\n\n` : "";
          return {
            ok: false,
            reason:
              `${deterministic}adversarial reviewer objections (block ${used + 1}/${maxBlocks()}):\n${rendered}\n` +
              `Resolve each with a concrete measurement (cad_probe), then re-accept with updated checks.`,
          };
        }
        // Budget exhausted: proceed with dissent on record.
        return { ok: true, dissent: blocking };
      }
    }
  }

  if (problems.length) {
    return {
      ok: false,
      reason: problems.join("\n"),
    };
  }
  return { ok: true };
}
