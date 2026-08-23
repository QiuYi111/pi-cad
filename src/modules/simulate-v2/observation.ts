import { deflateSync } from "node:zlib";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { readImageContents } from "../../shared/capability.ts";
import { sha256File } from "../../shared/store.ts";
import type { ExportDeclaration, SimulationRecipeManifest } from "./protocol.ts";

export interface MaterializedExportBase { type: string }
export interface MaterializedImage extends MaterializedExportBase { type: "image"; path: string }
export interface MaterializedScalar extends MaterializedExportBase { type: "scalar"; value: number; unit?: string }
export interface MaterializedTimeseries extends MaterializedExportBase { type: "timeseries"; path: string }
export interface MaterializedTable extends MaterializedExportBase { type: "table"; path: string }
export interface MaterializedField extends MaterializedExportBase { type: "field"; path: string; format?: string }
export interface MaterializedArtifact extends MaterializedExportBase { type: "artifact"; path: string; format?: string }
export type MaterializedExport = MaterializedImage | MaterializedScalar | MaterializedTimeseries | MaterializedTable | MaterializedField | MaterializedArtifact;

export interface ValidatedExport {
  name: string;
  declaration: ExportDeclaration;
  materialized: MaterializedExport;
  absolutePath?: string;
  sha256?: string;
  plotPath?: string;
  summary?: string;
}

export interface ValidatedObservation {
  schema: 1;
  selected: ValidatedExport[];
  validForCommit: boolean;
  warnings: string[];
}

export interface SimulationToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function validatedPath(workspace: string, path: unknown, where: string): Promise<string> {
  if (typeof path !== "string" || path.trim() === "" || isAbsolute(path)) throw new Error(`${where}.path must be a non-empty relative path`);
  const absolute = resolve(workspace, path);
  if (!inside(workspace, absolute)) throw new Error(`${where}.path escapes observation workspace`);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) throw new Error(`${where}.path does not name a file: ${path}`);
  return absolute;
}

function finiteArray(value: unknown, where: string): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`${where} must be a non-empty array of finite numbers`);
  }
  return value as number[];
}

function finiteRange(values: number[]): { min: number; max: number } {
  let min = values[0];
  let max = values[0];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] < min) min = values[index];
    if (values[index] > max) max = values[index];
  }
  return { min, max };
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${where} contains unknown fields: ${unknown.join(", ")}`);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

async function writeTimeseriesPlot(path: string, x: number[], y: number[]): Promise<void> {
  const width = 800;
  const height = 450;
  const pixels = Buffer.alloc(width * height * 3, 255);
  const set = (px: number, py: number, r: number, g: number, b: number) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const offset = (py * width + px) * 3;
    pixels[offset] = r; pixels[offset + 1] = g; pixels[offset + 2] = b;
  };
  const line = (x0: number, y0: number, x1: number, y1: number, color: [number, number, number]) => {
    const dx = Math.abs(x1 - x0); const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0); const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    while (true) {
      set(x0, y0, ...color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  const left = 55; const right = width - 20; const top = 20; const bottom = height - 40;
  line(left, bottom, right, bottom, [40, 40, 40]);
  line(left, bottom, left, top, [40, 40, 40]);
  const minX = Math.min(...x); const maxX = Math.max(...x); const minY = Math.min(...y); const maxY = Math.max(...y);
  const sx = (right - left) / Math.max(maxX - minX, Number.EPSILON);
  const sy = (bottom - top) / Math.max(maxY - minY, Number.EPSILON);
  const limit = Math.min(x.length, 2000);
  const index = (i: number) => Math.min(x.length - 1, Math.floor((i * (x.length - 1)) / Math.max(limit - 1, 1)));
  for (let i = 1; i < limit; i += 1) {
    const a = index(i - 1); const b = index(i);
    line(Math.round(left + (x[a] - minX) * sx), Math.round(bottom - (y[a] - minY) * sy), Math.round(left + (x[b] - minX) * sx), Math.round(bottom - (y[b] - minY) * sy), [34, 105, 190]);
  }
  const scanlines: Buffer[] = [];
  for (let row = 0; row < height; row += 1) scanlines.push(Buffer.from([0]), pixels.subarray(row * width * 3, (row + 1) * width * 3));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.concat(scanlines))), pngChunk("IEND", Buffer.alloc(0))]);
  await writeFile(path, png);
}

export async function validateObservationFile(input: {
  manifest: SimulationRecipeManifest;
  observationFile: string;
  workspace: string;
  selectedNames: string[];
  plotDir: string;
  computeSucceeded: boolean;
}): Promise<ValidatedObservation> {
  const raw = JSON.parse(await readFile(input.observationFile, "utf-8")) as { schema?: unknown; exports?: unknown };
  if (raw.schema !== 1 || !raw.exports || typeof raw.exports !== "object" || Array.isArray(raw.exports)) throw new Error("observations.json must contain schema=1 and an exports object");
  rejectUnknownFields(raw as Record<string, unknown>, ["schema", "exports"], "observations.json");
  const materialized = raw.exports as Record<string, unknown>;
  for (const name of Object.keys(materialized)) if (!(name in input.manifest.exports)) throw new Error(`observer materialized undeclared export: ${name}`);
  await mkdir(input.plotDir, { recursive: true });
  const selected: ValidatedExport[] = [];
  const missing: string[] = [];
  for (const name of input.selectedNames) {
    const declaration = input.manifest.exports[name];
    const item = materialized[name];
    if (!item || typeof item !== "object" || Array.isArray(item)) { missing.push(name); continue; }
    const value = item as Record<string, unknown>;
    if (value.type !== declaration.type) throw new Error(`export ${name} materialized type ${String(value.type)} does not match declaration ${declaration.type}`);
    if (declaration.type === "scalar") {
      rejectUnknownFields(value, ["type", "value", "unit"], `export ${name}`);
      if (typeof value.value !== "number" || !Number.isFinite(value.value)) throw new Error(`export ${name}.value must be finite`);
      if (value.unit !== undefined && value.unit !== declaration.unit) throw new Error(`export ${name}.unit does not match declaration`);
      selected.push({ name, declaration, materialized: value as unknown as MaterializedScalar, summary: `${value.value}${declaration.unit ? ` ${declaration.unit}` : ""}` });
      continue;
    }
    const absolutePath = await validatedPath(input.workspace, value.path, `export ${name}`);
    const size = (await stat(absolutePath)).size;
    if (declaration.type === "image" && size > 20 * 1024 * 1024) throw new Error(`export ${name} image exceeds 20 MiB`);
    if (declaration.type === "image") {
      rejectUnknownFields(value, ["type", "path"], `export ${name}`);
      const signature = (await readFile(absolutePath)).subarray(0, 8);
      if (!signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`export ${name} image must be PNG`);
    }
    if ((declaration.type === "timeseries" || declaration.type === "table") && size > 50 * 1024 * 1024) throw new Error(`export ${name} JSON exceeds 50 MiB`);
    const common = { name, declaration, materialized: value as unknown as MaterializedExport, absolutePath, sha256: await sha256File(absolutePath) };
    if (declaration.type === "timeseries") {
      rejectUnknownFields(value, ["type", "path"], `export ${name}`);
      const series = JSON.parse(await readFile(absolutePath, "utf-8")) as { x?: unknown; y?: unknown };
      if (!series || typeof series !== "object" || Array.isArray(series)) throw new Error(`export ${name} timeseries must be an object`);
      rejectUnknownFields(series as Record<string, unknown>, ["x", "y"], `export ${name} timeseries`);
      const x = finiteArray(series.x, `${name}.x`); const y = finiteArray(series.y, `${name}.y`);
      if (x.length !== y.length) throw new Error(`export ${name} x/y lengths differ`);
      const plotPath = resolve(input.plotDir, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.png`);
      await writeTimeseriesPlot(plotPath, x, y);
      const range = finiteRange(y);
      selected.push({ ...common, plotPath, summary: `${x.length} samples; ${x[0]} -> ${x.at(-1)}, ${y[0]} -> ${y.at(-1)}; min=${range.min} max=${range.max}` });
      continue;
    }
    if (declaration.type === "table") {
      rejectUnknownFields(value, ["type", "path"], `export ${name}`);
      const table = JSON.parse(await readFile(absolutePath, "utf-8")) as { columns?: unknown; rows?: unknown };
      if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error(`export ${name} table must be an object`);
      rejectUnknownFields(table as Record<string, unknown>, ["columns", "rows"], `export ${name} table`);
      if (!Array.isArray(table.columns) || table.columns.some((column) => typeof column !== "string") || !Array.isArray(table.rows)) throw new Error(`export ${name} table requires columns[] and rows[]`);
      if (table.rows.some((row) => !Array.isArray(row) || row.length !== table.columns!.length)) throw new Error(`export ${name} table row width mismatch`);
      selected.push({ ...common, summary: `${table.rows.length} rows x ${table.columns.length} columns` });
      continue;
    }
    if (declaration.type === "field" || declaration.type === "artifact") {
      rejectUnknownFields(value, ["type", "path", "format"], `export ${name}`);
      if (declaration.format && value.format !== declaration.format) throw new Error(`export ${name}.format does not match declaration`);
    }
    selected.push(common);
  }
  if (missing.length > 0 && input.computeSucceeded) throw new Error(`observer did not materialize required outputs: ${missing.join(", ")}`);
  return { schema: 1, selected, validForCommit: input.computeSucceeded && missing.length === 0, warnings: missing.length ? [`partial failure observation; missing ${missing.join(", ")}`] : [] };
}

export async function renderSimulationObservation(input: {
  runId: string;
  observationId: string;
  backend: string;
  runtime: string;
  durationMs: number;
  observation: ValidatedObservation;
  diagnostics?: string[];
}): Promise<SimulationToolContent[]> {
  const visualEntries = input.observation.selected.filter((entry) => (entry.declaration.type === "image" && entry.absolutePath) || entry.plotPath);
  const imagePaths = visualEntries.flatMap((entry) => entry.declaration.type === "image" && entry.absolutePath ? [entry.absolutePath] : entry.plotPath ? [entry.plotPath] : []).slice(0, 8);
  const images = await readImageContents(imagePaths);
  const lines = [`Simulation ${input.runId}. Observation ${input.observationId}.`, "", "Quantitative observations"];
  const quantitative = input.observation.selected.filter((entry) => entry.declaration.type === "scalar" || entry.declaration.type === "timeseries" || entry.declaration.type === "table").slice(0, 16);
  if (quantitative.length === 0) lines.push("- none materialized");
  for (const entry of quantitative) lines.push(`- ${entry.name}: ${entry.summary ?? entry.declaration.type}`);
  lines.push("", "Solver health", `- backend: ${input.backend}`, `- runtime: ${input.runtime}`, `- wall time: ${(input.durationMs / 1000).toFixed(2)} s`);
  for (const warning of input.observation.warnings) lines.push(`- warning: ${warning}`);
  for (const diagnostic of (input.diagnostics ?? []).slice(0, 20)) lines.push(`- ${diagnostic.slice(0, 500)}`);
  const renderedQuantitative = new Set(quantitative.map((entry) => entry.name));
  const renderedVisuals = new Set(visualEntries.slice(0, 8).map((entry) => entry.name));
  const artifacts = input.observation.selected.filter((entry) =>
    entry.declaration.type === "artifact" || entry.declaration.type === "field" ||
    ((entry.declaration.type === "image" || entry.plotPath) && !renderedVisuals.has(entry.name)) ||
    ((entry.declaration.type === "scalar" || entry.declaration.type === "timeseries" || entry.declaration.type === "table") && !renderedQuantitative.has(entry.name))
  );
  if (artifacts.length) {
    lines.push("", "Artifacts");
    for (const entry of artifacts) lines.push(`- ${entry.name}: ${entry.absolutePath ?? "retained in immutable observation snapshot"}${entry.sha256 ? ` sha256=${entry.sha256}` : ""}`);
  }
  return [...images, { type: "text", text: lines.join("\n") }];
}
