import { open, stat } from "node:fs/promises";

export interface TailJsonLinesResult<T> {
  records: T[];
  truncated: boolean;
  bytesRead: number;
}

/** Read a bounded tail of an append-only JSONL file, ignoring torn lines. */
export async function readJsonLinesTail<T>(
  path: string,
  maxBytes: number,
  maxRecords: number,
): Promise<TailJsonLinesResult<T>> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  if (!Number.isInteger(maxRecords) || maxRecords <= 0) throw new Error("maxRecords must be a positive integer");
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { records: [], truncated: false, bytesRead: 0 };
  }
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf-8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    const records: T[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as T);
      } catch {
        // A bounded head fragment or torn final append is not a record.
      }
    }
    return {
      records: records.slice(-maxRecords),
      truncated: start > 0 || records.length > maxRecords,
      bytesRead,
    };
  } finally {
    await handle.close();
  }
}

/** Read at most maxBytes from the beginning of a small snapshot file. */
export async function readTextPrefix(
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive integer");
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return { text: "", truncated: false, bytesRead: 0 };
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes;
    return {
      text: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf-8"),
      truncated,
      bytesRead: Math.min(bytesRead, maxBytes),
    };
  } finally {
    await handle.close();
  }
}
