import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readJsonLinesTail, readTextPrefix } from "../src/shared/bounded-files.ts";

test("bounded JSONL tail reads only the configured bytes and newest records", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-bounded-jsonl-"));
  try {
    const path = join(cwd, "events.jsonl");
    writeFileSync(path, Array.from({ length: 10_000 }, (_, id) => JSON.stringify({ id, text: "x".repeat(80) })).join("\n") + "\n");
    const result = await readJsonLinesTail<{ id: number }>(path, 4096, 5);
    assert.equal(result.bytesRead, 4096);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.records.map((record) => record.id), [9995, 9996, 9997, 9998, 9999]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bounded snapshot reader never reads beyond its prefix budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-bounded-text-"));
  try {
    const path = join(cwd, "working.md");
    writeFileSync(path, "a".repeat(50_000));
    const result = await readTextPrefix(path, 256);
    assert.equal(result.bytesRead, 256);
    assert.equal(result.text.length, 256);
    assert.equal(result.truncated, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
