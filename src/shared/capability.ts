import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  BuildPayload,
  CadEventEnvelope,
  GeometryPayload,
  MeasurePayload,
  VisualPayload,
} from "./protocol.ts";
import { CadProjectStore, sha256File } from "./store.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_VIEWS = ["iso", "front", "back", "left", "right", "top", "bottom"];

export function packageRoot(): string {
  // <package>/src/shared/capability.ts -> <package>
  return fileURLToPath(new URL("../../", import.meta.url));
}

function sitePackages(): string | null {
  const path = join(packageRoot(), ".python", "site-packages");
  return existsSync(path) ? path : null;
}

function pythonBinary(): string {
  const override = process.env.PI_CAD_PYTHON;
  if (override) return override;
  const venvRoot = process.env.PI_CAD_VENV ?? join(packageRoot(), ".venv");
  const venv = process.platform === "win32"
    ? join(venvRoot, "Scripts", "python.exe")
    : join(venvRoot, "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

function cadctlEnv(): NodeJS.ProcessEnv {
  const entries = [join(packageRoot(), "python"), sitePackages()].filter(
    (entry): entry is string => Boolean(entry),
  );
  const previous = process.env.PYTHONPATH;
  const pythonPath = previous ? [...entries, previous].join(delimiter) : entries.join(delimiter);
  return { ...process.env, PYTHONPATH: pythonPath };
}

export interface CadctlOptions {
  cwd: string;
  timeoutMs?: number;
}

async function runCadctl(
  args: string[],
  options: CadctlOptions,
): Promise<CadEventEnvelope> {
  const bin = pythonBinary();
  const { stdout } = await execFileAsync(bin, ["-m", "cadctl", ...args], {
    cwd: options.cwd,
    env: cadctlEnv(),
    timeout: options.timeoutMs ?? 180_000,
    maxBuffer: 64 * 1024 * 1024,
    killSignal: "SIGKILL",
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`cadctl returned non-JSON output: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
    throw new Error("cadctl returned an invalid envelope");
  }
  return parsed as CadEventEnvelope;
}

export interface CapabilityBuildInput {
  source: string;
  output: string;
  force?: boolean;
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
  if (input.force) args.push("--force");
  return runCadctl(args, { cwd, timeoutMs });
}

export async function inspectGeometry(
  cwd: string,
  artifact: string,
  output: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  return runCadctl(
    ["inspect", "--artifact", resolve(cwd, artifact), "--output", resolve(cwd, output)],
    { cwd, timeoutMs },
  );
}

export interface VisualOptions {
  views?: string[];
  width?: number;
  height?: number;
  display?: "solid";
  labels?: boolean;
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
  if (options.labels) args.push("--labels");
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

export interface ExportOptions {
  source: string;
  output: string;
  format: string;
}

export async function exportArtifact(
  cwd: string,
  options: ExportOptions,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  return runCadctl(
    [
      "export",
      "--source",
      resolve(cwd, options.source),
      "--output",
      resolve(cwd, options.output),
      "--format",
      options.format,
    ],
    { cwd, timeoutMs },
  );
}

export async function cadctlCapabilities(cwd: string, timeoutMs?: number): Promise<CadEventEnvelope> {
  return runCadctl(["capability"], { cwd, timeoutMs });
}


export async function drawingCommand(
  cwd: string,
  stage: "validate" | "generate",
  spec: string,
  outputDir?: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  const args = ["drawing", stage, "--spec", resolve(cwd, spec)];
  if (outputDir) args.push("--output-dir", resolve(cwd, outputDir));
  return runCadctl(args, { cwd, timeoutMs });
}

export async function simulationCommand(
  cwd: string,
  stage: "validate" | "run",
  spec: string,
  outputDir: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  return runCadctl(
    ["simulate", stage, "--spec", resolve(cwd, spec), "--output-dir", resolve(cwd, outputDir)],
    { cwd, timeoutMs },
  );
}

export async function presentationCommand(
  cwd: string,
  stage: "validate" | "generate" | "run",
  spec: string,
  outputDir: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  return runCadctl(
    ["present", stage, "--spec", resolve(cwd, spec), "--output-dir", resolve(cwd, outputDir)],
    { cwd, timeoutMs },
  );
}

export async function optimizationCommand(
  cwd: string,
  spec: string,
  outputDir: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  return runCadctl(
    ["optimize", "--spec", resolve(cwd, spec), "--output-dir", resolve(cwd, outputDir)],
    { cwd, timeoutMs },
  );
}

export async function imageContent(
  path: string,
): Promise<{ type: "image"; data: string; mimeType: string }> {
  const data = await readFile(path);
  return { type: "image", data: data.toString("base64"), mimeType: "image/png" };
}

export async function readImageContents(
  paths: string[],
): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  return Promise.all(paths.map((path) => imageContent(path)));
}

export function defaultBuildOutput(cwd: string, source: string): string {
  const absolute = resolve(cwd, source);
  const stem = basename(absolute).replace(/\.py$/i, "");
  return join(cwd, "build", `${stem}.step`);
}

export function defaultVisualEvidenceDir(cwd: string, artifact: string): string {
  return join(cwd, ".pi-cad", "evidence", "visual", basename(artifact).replace(/\.[^.]+$/, ""));
}

export function defaultGeometryEvidencePath(cwd: string, artifact: string): string {
  return join(
    cwd,
    ".pi-cad",
    "evidence",
    "geometry",
    `${basename(artifact).replace(/\.[^.]+$/, "")}.json`,
  );
}

export function runEvidenceRoot(cwd: string, runId: string): string {
  return join(cwd, ".pi-cad", "runs", runId, "evidence");
}

export function runVisualEvidenceDir(cwd: string, runId: string, artifact: string): string {
  return join(runEvidenceRoot(cwd, runId), "visual", basename(artifact).replace(/\.[^.]+$/, ""));
}

export function runGeometryEvidencePath(cwd: string, runId: string, artifact: string): string {
  return join(runEvidenceRoot(cwd, runId), "geometry", `${basename(artifact).replace(/\.[^.]+$/, "")}.json`);
}

export function runCompareEvidencePath(cwd: string, runId: string, label: string): string {
  return join(runEvidenceRoot(cwd, runId), "compare", `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

export async function currentRunEvidenceRoot(cwd: string): Promise<string | null> {
  const runId = await new CadProjectStore(cwd).currentRunId();
  return runId ? runEvidenceRoot(cwd, runId) : null;
}

export async function currentVisualEvidenceDir(cwd: string, artifact: string): Promise<string> {
  const runId = await new CadProjectStore(cwd).currentRunId();
  return runId ? runVisualEvidenceDir(cwd, runId, artifact) : defaultVisualEvidenceDir(cwd, artifact);
}

export async function currentGeometryEvidencePath(cwd: string, artifact: string): Promise<string> {
  const runId = await new CadProjectStore(cwd).currentRunId();
  return runId ? runGeometryEvidencePath(cwd, runId, artifact) : defaultGeometryEvidencePath(cwd, artifact);
}

export async function hashOrEmpty(path: string): Promise<string> {
  try {
    return await sha256File(path);
  } catch {
    return "";
  }
}

export function envelopeArtifactHash(
  envelope: CadEventEnvelope,
  kind = "step",
): string | undefined {
  const artifact = envelope.artifacts?.find((entry) => entry.kind === kind);
  return artifact?.sha256 ?? envelope.outputHashes?.[artifact?.path ?? ""];
}

export function artifactPathForKind(envelope: CadEventEnvelope, kind: string): string | undefined {
  return envelope.artifacts?.find((entry) => entry.kind === kind)?.path;
}

export function payloadOf<T>(envelope: CadEventEnvelope): T {
  return envelope.payload as T;
}

export function buildPayload(envelope: CadEventEnvelope): BuildPayload {
  return payloadOf<BuildPayload>(envelope);
}

export function visualPayload(envelope: CadEventEnvelope): VisualPayload {
  return payloadOf<VisualPayload>(envelope);
}

export function geometryPayload(envelope: CadEventEnvelope): GeometryPayload {
  return payloadOf<GeometryPayload>(envelope);
}

export function measurePayload(envelope: CadEventEnvelope): MeasurePayload {
  return payloadOf<MeasurePayload>(envelope);
}
