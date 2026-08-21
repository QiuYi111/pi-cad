import { createHash } from "node:crypto";

import type { CadRunState } from "../../shared/protocol.ts";

export interface ReviewerEvidenceItem {
  ref: string;
  kind: string;
  tool: string;
  paths: string[];
}

export interface ReviewerEvidenceIndex {
  items: ReviewerEvidenceItem[];
  visualPaths: string[];
  snapshotHash: string;
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export function collectReviewerEvidenceIndex(state: CadRunState): ReviewerEvidenceIndex {
  const items = state.evidence
    .filter((ref) => ref.artifactHash === state.currentArtifactHash)
    .map((ref) => ({
      ref: `evidence:${ref.id}`,
      kind: ref.kind,
      tool: ref.tool,
      paths: [...ref.paths],
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
  const preferredKinds = ["visual", "assembly", "interference", "simulation"];
  const visualPaths = preferredKinds.flatMap((kind) =>
    items.filter((item) => item.kind === kind).flatMap((item) => item.paths.filter((path) => IMAGE_EXT.test(path))),
  ).filter((path, index, all) => all.indexOf(path) === index).slice(0, 6);
  const snapshotHash = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  return { items, visualPaths, snapshotHash };
}

export function renderReviewerEvidenceIndex(index: ReviewerEvidenceIndex): string {
  if (index.items.length === 0) return "(no current evidence)";
  return index.items.map((item) =>
    `${item.ref} [${item.kind}] ${item.tool}: ${item.paths.join(", ") || "(no paths)"}`,
  ).join("\n");
}
