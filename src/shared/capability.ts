import { existsSync } from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type {
  BuildPayload,
  CadEventEnvelope,
  GeometryPayload,
  MeasurePayload,
  VisualPayload,
} from "./protocol.ts";
import { CadProjectStore, sha256File } from "./store.ts";
import { managedSimulationRunner } from "../modules/simulate-v2/runtime.ts";
import { assertLinuxRuntime } from "./platform.ts";
import { runProcess } from "./process-runner.ts";

export const DEFAULT_VIEWS = ["iso", "front", "back", "left", "right", "top", "bottom"];

export function packageRoot(): string {
  // <package>/src/shared/capability.ts -> <package>
  return fileURLToPath(new URL("../../", import.meta.url));
}

/** Reproducible uv-managed Python command inside the Linux/WSL runtime. */
export function pythonInvocation(extra?: "simulation", _cwd?: string): { command: string; prefixArgs: string[] } {
  assertLinuxRuntime("Pi-CAD Python capability");
  const uvExtra = extra ? ["--extra", extra] : [];
  return {
    command: process.env.PI_CAD_UV ?? "uv",
    prefixArgs: ["run", "--project", join(packageRoot(), "python"), ...uvExtra, "python"],
  };
}

/** Minimal host environment for spawning the uv-managed cadctl process. */
export function cadctlEnv(cwd?: string): NodeJS.ProcessEnv {
  assertLinuxRuntime("Pi-CAD cadctl capability");
  const env = { ...process.env, NO_COLOR: "1", ...(cwd ? { PI_CAD_INVOCATION_CWD: resolve(cwd) } : {}) };
  // cadctl stdout is a JSON transport. Prime and terminal hosts may set
  // FORCE_COLOR globally, which lets dependency diagnostics inject ANSI
  // bytes ahead of the envelope and makes the bridge unparsable.
  delete env.FORCE_COLOR;
  return env;
}

export interface CadctlOptions {
  cwd: string;
  timeoutMs?: number;
  extra?: "simulation";
}

async function runCadctl(
  args: string[],
  options: CadctlOptions,
): Promise<CadEventEnvelope> {
  const python = pythonInvocation(options.extra, options.cwd);
  const result = await runProcess({
    command: python.command,
    args: [...python.prefixArgs, "-m", "cadctl", ...args],
    cwd: options.cwd,
    env: cadctlEnv(options.cwd),
    timeoutMs: options.timeoutMs ?? 180_000,
    maxStdoutBytes: 16 * 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.terminationReason) {
    throw new Error(
      `cadctl process failed${result.terminationDetail ? `: ${result.terminationDetail}` : ` with exit ${result.exitCode}`}: ${result.stderr.slice(-8192)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
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
 * Programmable read-only B-Rep probe. The code is written to a
 * harness-owned temporary file (the probe CLI takes no inline code), the
 * subject artifact path is already resolved by the caller from run state —
 * never from agent input — and the temporary file is removed afterwards.
 * Envelope inputHashes bind both the artifact and the script.
 */
export async function probePython(
  cwd: string,
  artifact: string,
  code: string,
  timeoutMs = 30_000,
): Promise<CadEventEnvelope> {
  const tmpDir = join(cwd, ".pi-cad", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const codeFile = join(tmpDir, `probe-${randomUUID().slice(0, 8)}.py`);
  writeFileSync(codeFile, code, "utf-8");
  try {
    return await runCadctl(
      ["probe", "--artifact", resolve(cwd, artifact), "--code-file", codeFile],
      { cwd, timeoutMs },
    );
  } finally {
    rmSync(codeFile, { force: true });
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

/**
 * Live doctor report for the Python runtime the harness would actually use
 * right now through the uv-managed project. Cached per process: the
 * probe runs once per Pi session, so the startup cost is paid once and later
 * capability gating reads the same snapshot. `.pi-cad-runtime.json` remains
 * an install-time diagnostic, not the runtime source of truth.
 */
export interface DoctorReport {
  python?: string;
  mode?: string;
  capabilities?: {
    simulation?: { status?: string; backend?: string };
    differentiableOptimization?: { status?: string };
    [name: string]: unknown;
  };
}

let doctorProbeCache: DoctorReport | null | undefined;

export async function currentDoctorReport(
  cwd?: string,
  timeoutMs = 30_000,
): Promise<DoctorReport | null> {
  if (doctorProbeCache !== undefined) return doctorProbeCache;
  try {
    const python = pythonInvocation(undefined, cwd);
    const result = await runProcess({
      command: python.command,
      args: [...python.prefixArgs, "-m", "cadctl", "doctor", "--json"],
      cwd: cwd ?? packageRoot(),
      env: cadctlEnv(cwd),
      timeoutMs,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    });
    if (result.exitCode !== 0 || result.terminationReason) throw new Error(result.terminationDetail ?? result.stderr);
    doctorProbeCache = JSON.parse(result.stdout.trim()) as DoctorReport;
  } catch {
    doctorProbeCache = null;
  }
  return doctorProbeCache;
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

export async function presentationCommand(
  cwd: string,
  stage: "validate" | "preview" | "generate" | "run",
  spec: string,
  outputDir: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  return runCadctl(
    ["present", stage, "--spec", resolve(cwd, spec), "--output-dir", resolve(cwd, outputDir)],
    { cwd, timeoutMs },
  );
}

/**
 * Create a harness-owned analysis-model derivation record. fused/bonded
 * are executed by the backend (boolean union); authored operations hash
 * both ends at record time.
 */
export async function deriveAnalysisModel(
  cwd: string,
  spec: string,
  outputDir: string,
  timeoutMs?: number,
): Promise<CadEventEnvelope> {
  return runCadctl(
    ["derive-analysis-model", "--spec", resolve(cwd, spec), "--output-dir", resolve(cwd, outputDir)],
    { cwd, timeoutMs },
  );
}

export async function optimizationCommand(
  cwd: string,
  spec: string,
  outputDir: string,
  runtime = "torch-fem-0.9-cu126",
  timeoutMs = 3_600_000,
): Promise<CadEventEnvelope> {
  const workspace = resolve(outputDir);
  const specPath = resolve(spec);
  if (dirname(specPath) !== workspace) throw new Error("managed optimization spec must be inside its run workspace");
  await managedSimulationRunner.resolveRuntime(cwd, "torch-fem", runtime);
  const stdoutPath = join(workspace, "managed-stdout.log");
  const stderrPath = join(workspace, "managed-stderr.log");
  const result = await managedSimulationRunner.execute({
    cwd,
    workspace,
    recipeDirectory: workspace,
    command: "uv run --offline --frozen --project \"$PI_CAD_PYTHON_PROJECT\" python -m cadctl optimize --spec spec.json --output-dir .",
    environment: {},
    stdoutPath,
    stderrPath,
    timeoutMs,
    backend: "torch-fem",
    runtime,
  });
  const stdout = await readFile(stdoutPath, "utf-8").catch(() => result.stdout);
  let parsed: CadEventEnvelope;
  try {
    parsed = JSON.parse(stdout.trim()) as CadEventEnvelope;
  } catch {
    return {
      tool: "cad_optimize",
      toolVersion: "0.9.0",
      ok: false,
      payload: { error: `managed optimization failed with exit ${result.exitCode}`, diagnostics: result.diagnostics },
      inputHashes: { spec: await sha256File(specPath) },
      outputHashes: {},
      artifacts: [],
      durationMs: result.durationMs,
      warnings: [],
    };
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") return value === "/workspace" || value.startsWith("/workspace/") ? join(workspace, value.slice("/workspace".length)) : value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, remap(item)]));
    return value;
  };
  return remap(parsed) as CadEventEnvelope;
}

export async function imageContent(
  path: string,
): Promise<{ type: "image"; data: string; mimeType: string }> {
  const data = await readFile(path);
  const mimeType = detectImageMimeType(data);
  if (!mimeType) throw new Error(`unsupported image encoding: ${path}`);
  return { type: "image", data: data.toString("base64"), mimeType };
}

export function detectImageMimeType(data: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
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

export function runInterferenceEvidencePath(cwd: string, runId: string, artifact: string): string {
  return join(runEvidenceRoot(cwd, runId), "interference", `${basename(artifact).replace(/\.[^.]+$/, "")}.json`);
}

export function runAssemblyEvidencePath(cwd: string, runId: string, artifact: string): string {
  return join(runEvidenceRoot(cwd, runId), "assembly", `${basename(artifact).replace(/\.[^.]+$/, "")}.json`);
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
