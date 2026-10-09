import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { EvidenceKind } from "./protocol.ts";

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return sha256(data);
}

export function hashRecord(record: unknown): string {
  return sha256(canonicalJson(record));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeEvidenceId(
  kind: EvidenceKind,
  artifactHash: string,
  specHash?: string,
  caseId?: string,
): string {
  let identity = artifactHash.slice(0, 12);
  if (caseId) identity = `${identity}-case-${caseId}`;
  else if (specHash) identity = `${identity}-${specHash.slice(0, 12)}`;
  return `${kind}-${identity}-${randomUUID().slice(0, 8)}`;
}
