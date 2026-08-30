export function physicalUnitIndex(document) {
  if (!document || document.schema_version !== 1 || document.canonical_step_unit !== "mm" || !Array.isArray(document.samples)) {
    throw new Error("invalid detailed-200 physical-unit adjudication");
  }
  const index = new Map();
  for (const sample of document.samples) {
    if (!sample || typeof sample.sample_id !== "string" || !Number.isFinite(sample.scale_to_mm) || sample.scale_to_mm <= 0) {
      throw new Error("invalid physical-unit sample");
    }
    if (index.has(sample.sample_id)) throw new Error(`duplicate physical-unit sample ${sample.sample_id}`);
    index.set(sample.sample_id, sample);
  }
  return index;
}

function formatValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** Add an authoritative mm contract without silently rewriting any non-unit semantics. */
export function normalizePhysicalUnitPrompt(prompt, sample) {
  if (!sample) return prompt;
  const converted = sample.dimensions
    .filter((dimension) => dimension.dimension !== "dimensionless" && dimension.mm !== null && dimension.mm !== undefined)
    .map((dimension) => `- ${dimension.name}: ${formatValue(dimension.mm)} mm`)
    .join("\n");
  const semanticWarnings = (sample.non_unit_semantic_issues ?? []).map((issue) => `- ${issue}`).join("\n");
  return `${prompt}\n\nAuthoritative unit normalization:\nThe source physical unit is ${sample.source_unit}. The delivered STEP and every physical length below use millimetres. These converted values supersede the source-unit numerals for construction; angles, counts, ratios, topology, and every non-unit statement remain unchanged.\n${converted}${semanticWarnings ? `\nNon-unit wording remains intentionally unmodified and may still require clarification:\n${semanticWarnings}` : ""}`;
}

export function legacyEvaluatorScale(sample) {
  return sample ? 1 / sample.scale_to_mm : 1;
}
