import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { CadEventEnvelope } from "../protocol.ts";
import type { ModelParameterValue } from "../model-parameters.ts";
import { runCadctl } from "./transport.ts";

export const DEFAULT_VIEWS = ["iso", "front", "back", "left", "right", "top", "bottom"];
export const FULL_GEOMETRY_VALIDATION_TIMEOUT_MS = 15 * 60_000;
export type GeometryValidationMode = "auto" | "fast" | "full";

export interface CapabilityBuildInput {
  source: string;
  output: string;
  force?: boolean;
  parameters?: Record<string, ModelParameterValue>;
  solidify?: boolean;
}

export async function buildStep(
  cwd: string,
  input: CapabilityBuildInput,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const source = resolve(cwd, input.source);
  const output = resolve(cwd, input.output);
  const args = [
    "build",
    "--source",
    source,
    "--output",
    output,
  ];
  if (input.parameters) args.push("--parameters-json", JSON.stringify(input.parameters));
  if (input.solidify) args.push("--solidify");
  if (input.force) args.push("--force");
  return runCadctl(args, { cwd, timeoutMs });
}

export async function inspectGeometry(
  cwd: string,
  artifact: string,
  output: string,
  timeoutMs?: number,
  validation: GeometryValidationMode = "auto",
): Promise<CadEventEnvelope> {
  return runCadctl(
    ["inspect", "--artifact", resolve(cwd, artifact), "--output", resolve(cwd, output), "--validation", validation],
    { cwd, timeoutMs },
  );
}

/** Bind a declarations.json (from the FreeCAD part backend) to its STEP and write the identity manifest. */
export async function bindIdentity(
  cwd: string,
  artifact: string,
  declarations: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  return runCadctl(
    ["bind-identity", "--artifact", resolve(cwd, artifact), "--declarations", resolve(cwd, declarations)],
    { cwd, timeoutMs },
  );
}

export interface VisualOptions {
  views?: string[];
  width?: number;
  height?: number;
  display?: "solid" | "solid_with_edges" | "hidden_edges" | "wireframe";
  labels?: boolean;
  focus?: string[];
  hide?: string[];
  explode?: number;
  ghostOthers?: boolean;
  /** Face fingerprints to colour orange (faces changed by this build). */
  highlight?: unknown[];
  /** Up to eight labels per view, anchored at 3D points. */
  annotations?: Array<{ text: string; at: [number, number, number] }>;
}

export async function inspectVisual(
  cwd: string,
  artifact: string,
  outDir: string,
  options: VisualOptions = {},
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const views = options.views?.length ? options.views : DEFAULT_VIEWS;
  const args = [
    "render",
    "--artifact",
    resolve(cwd, artifact),
    "--out-dir",
    resolve(cwd, outDir),
    "--views",
    views.join(","),
    "--width",
    String(options.width ?? 640),
    "--height",
    String(options.height ?? 480),
    "--display",
    options.display ?? "solid",
  ];
  // Agent-facing build evidence needs view identity and a world-frame cue;
  // callers can still pass labels:false for a clean presentation render.
  if (options.labels ?? true) args.push("--labels");
  if (options.focus?.length) args.push("--focus-json", JSON.stringify(options.focus));
  if (options.hide?.length) args.push("--hide-json", JSON.stringify(options.hide));
  if (options.explode !== undefined) args.push("--explode", String(options.explode));
  if (options.ghostOthers === false) args.push("--no-ghost-others");
  if (options.highlight?.length) args.push("--highlight-json", JSON.stringify(options.highlight));
  if (options.annotations?.length) args.push("--annotations-json", JSON.stringify(options.annotations));
  return runCadctl(args, { cwd, timeoutMs });
}

export interface MeasureOptions {
  metric: string;
  a: string;
  b?: string;
}

export async function measure(
  cwd: string,
  artifact: string,
  options: MeasureOptions,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = [
    "measure",
    "--artifact",
    resolve(cwd, artifact),
    "--metric",
    options.metric,
    "--a",
    options.a,
  ];
  if (options.b) args.push("--b", options.b);
  return runCadctl(args, { cwd, timeoutMs });
}

export interface CompareOptions {
  before: string;
  after: string;
  transformBefore?: number[][];
  transformAfter?: number[][];
  metrics?: string[];
  output?: string;
}

export async function compareGeometry(
  cwd: string,
  before: string,
  after: string,
  output?: string,
  options: Omit<CompareOptions, "before" | "after" | "output"> = {},
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = [
    "compare",
    "--before",
    resolve(cwd, before),
    "--after",
    resolve(cwd, after),
  ];
  if (options.metrics?.length) args.push("--metrics", options.metrics.join(","));
  if (options.transformBefore) args.push("--transform-before", JSON.stringify(options.transformBefore));
  if (options.transformAfter) args.push("--transform-after", JSON.stringify(options.transformAfter));
  if (output) args.push("--output", resolve(cwd, output));
  return runCadctl(args, { cwd, timeoutMs });
}

export interface SectionOptions {
  origin: [number, number, number];
  normal: [number, number, number];
  display?: "solid" | "hidden_edges" | "solid_with_hidden";
  labels?: boolean;
  width?: number;
  height?: number;
}

export async function inspectSection(
  cwd: string,
  artifact: string,
  outDir: string,
  options: SectionOptions,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = [
    "section",
    "--artifact",
    resolve(cwd, artifact),
    "--out-dir",
    resolve(cwd, outDir),
    "--origin",
    options.origin.join(","),
    "--normal",
    options.normal.join(","),
    "--display",
    options.display ?? "solid",
    "--width",
    String(options.width ?? 640),
    "--height",
    String(options.height ?? 480),
  ];
  if (options.labels) args.push("--labels");
  return runCadctl(args, { cwd, timeoutMs });
}

export async function assemblyTree(
  cwd: string,
  artifact: string,
  output?: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = ["assembly-tree", "--artifact", resolve(cwd, artifact)];
  if (output) args.push("--output", resolve(cwd, output));
  return runCadctl(args, { cwd, timeoutMs });
}

/**
 * Cross-section facts along an axis: area, centroid, second moments,
 * principal moments, loop count per section. Facts only — never a
 * "critical section" judgment.
 */
export async function scanSections(
  cwd: string,
  artifact: string,
  options: { axis?: string; count?: number; step?: number; output?: string },
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = ["scan-sections", "--artifact", resolve(cwd, artifact), "--axis", options.axis ?? "z"];
  if (options.count !== undefined) args.push("--count", String(options.count));
  if (options.step !== undefined) args.push("--step", String(options.step));
  if (options.output) args.push("--output", resolve(cwd, options.output));
  return runCadctl(args, { cwd, timeoutMs });
}

/**
 * Programmable disposable B-Rep experiment. Copy the bound STEP and code to
 * an OS temporary directory before invoking cadctl. The CLI makes its own
 * analysis copy; neither process receives the official project path as its
 * working directory or subject argument. No candidate is promoted here.
 * Envelope inputHashes bind both the artifact and the script.
 */
export async function probePython(
  cwd: string,
  artifact: string,
  code: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CadEventEnvelope> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-cad-probe-"));
  const subject = join(tmpDir, "subject.step");
  const codeFile = join(tmpDir, "probe.py");
  const identitySource = `${resolve(cwd, artifact)}.identity.json`;
  const identityCopy = `${subject}.identity.json`;
  try {
    copyFileSync(resolve(cwd, artifact), subject);
    if (existsSync(identitySource)) copyFileSync(identitySource, identityCopy);
    writeFileSync(codeFile, code, "utf-8");
    return await runCadctl(
      ["probe", "--artifact", subject, "--code-file", codeFile, "--params-json", JSON.stringify(params)],
      { cwd: tmpDir, timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Pairwise solid interference facts. The interpreter reports
 * penetration/contact/clearance per part pair — raw facts with volumes and
 * distances; engineering meaning (press fit vs collision) is the Agent's.
 */
export async function inspectInterference(
  cwd: string,
  artifact: string,
  output?: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = ["inspect-interference", "--artifact", resolve(cwd, artifact)];
  if (output) args.push("--output", resolve(cwd, output));
  return runCadctl(args, { cwd, timeoutMs });
}

export interface ExportOptions {
  source: string;
  sourceSha256?: string;
  output: string;
  format: string;
}

export async function exportArtifact(
  cwd: string,
  options: ExportOptions,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = [
      "export",
      "--source",
      resolve(cwd, options.source),
      "--output",
      resolve(cwd, options.output),
      "--format",
      options.format,
    ];
  if (options.sourceSha256) args.push("--source-sha256", options.sourceSha256);
  return runCadctl(args, { cwd, timeoutMs });
}

export interface InspectSurfacesOptions {
  output?: string;
  labels?: boolean;
  outDir?: string;
  views?: string[];
}

export async function inspectSurfaces(
  cwd: string,
  artifact: string,
  options: InspectSurfacesOptions = {},
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = ["inspect-surfaces", "--artifact", resolve(cwd, artifact)];
  if (options.output) args.push("--output", resolve(cwd, options.output));
  if (options.labels) {
    args.push("--labels");
    if (options.outDir) args.push("--out-dir", resolve(cwd, options.outDir));
    if (options.views?.length) args.push("--views", options.views.join(","));
  }
  return runCadctl(args, { cwd, timeoutMs });
}

export function defaultBuildOutput(cwd: string, source: string): string {
  const absolute = resolve(cwd, source);
  const stem = basename(absolute).replace(/\.py$/i, "");
  return join(cwd, "build", `${stem}.step`);
}
