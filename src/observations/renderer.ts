/**
 * Observation renderer (refactor Phase 1).
 *
 * Turns an ObservationBundle into agent-facing tool content:
 *
 *   1. engineering visuals (images first — visual-first ordering);
 *   2. headline;
 *   3. facts;
 *   4. diagnostics;
 *   5. provenance + artifact references.
 *
 * `includeEnvelope` keeps the raw envelope JSON as a trailing appendix
 * during migration (Phase 1) so no information is lost before prompts
 * are rewritten (Phase 3).
 */
import { readImageContents } from "../shared/capability.ts";
import type { CadEventEnvelope } from "../shared/protocol.ts";
import type { ObservationBundle } from "./bundle.ts";
import { bundleFromEnvelope, type BundleInputs } from "./bundle.ts";
import { profileProjection } from "./profiles.ts";

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface RenderOptions {
  /** Visual-first (default) puts images before text. */
  order?: "visual-first" | "text-first";
  /** Append the raw envelope JSON (migration safety, Phase 1). */
  includeEnvelope?: CadEventEnvelope | null;
}

export function renderBundleText(bundle: ObservationBundle): string {
  const lines: string[] = [bundle.headline];

  if (bundle.facts.length > 0) {
    lines.push("facts:");
    for (const fact of bundle.facts) lines.push(`  ${fact.key}: ${fact.value}`);
  }

  const diagnostics = bundle.diagnostics.filter((d) => d.level !== "info");
  if (diagnostics.length > 0) {
    lines.push("diagnostics:");
    for (const d of diagnostics) lines.push(`  [${d.level}] ${d.message}`);
  }

  const p = bundle.provenance;
  lines.push(
    `provenance: tool=${p.tool}` +
      (p.toolVersion ? ` v${p.toolVersion}` : "") +
      ` duration=${p.durationMs}ms`,
  );

  if (bundle.artifacts.length > 0) {
    lines.push("artifacts:");
    for (const a of bundle.artifacts) {
      lines.push(`  - ${a.path} (${a.kind}, sha256:${a.sha256.slice(0, 12)})`);
    }
  }

  return lines.join("\n");
}

export function renderBundle(
  bundle: ObservationBundle,
  options: RenderOptions = {},
): { text: string; imagePaths: string[] } {
  const text = options.includeEnvelope
    ? `${renderBundleText(bundle)}\n${JSON.stringify(options.includeEnvelope, null, 2)}`
    : renderBundleText(bundle);
  const imagePaths = bundle.visuals.map((v) => v.path);
  return { text, imagePaths };
}

/** Full agent-facing content array (images loaded as base64 blocks). */
export async function renderBundleContent(
  bundle: ObservationBundle,
  options: RenderOptions = {},
): Promise<ToolContent[]> {
  const { text, imagePaths } = renderBundle(bundle, options);
  const images = imagePaths.length > 0 ? await readImageContents(imagePaths) : [];
  const textBlock: ToolContent = { type: "text", text };
  return options.order === "text-first" || images.length === 0
    ? [textBlock, ...images]
    : [...images, textBlock];
}

/**
 * One-call observation: envelope (+ optional explicit inputs) → bundle
 * → agent content. Explicit inputs override the profile projection.
 */
export async function observeContent(
  envelope: CadEventEnvelope,
  inputs: Partial<BundleInputs> = {},
  options: RenderOptions = {},
): Promise<{ content: ToolContent[]; bundle: ObservationBundle }> {
  const projected = profileProjection(envelope);
  const bundle = bundleFromEnvelope(envelope, {
    headline: inputs.headline ?? projected.headline,
    visuals: inputs.visuals ?? projected.visuals,
    facts: inputs.facts ?? projected.facts,
    diagnostics: inputs.diagnostics,
    artifactRoles: inputs.artifactRoles,
  });
  return {
    content: await renderBundleContent(bundle, {
      ...options,
      includeEnvelope: options.includeEnvelope ?? envelope,
    }),
    bundle,
  };
}
