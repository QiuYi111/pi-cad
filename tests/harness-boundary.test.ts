import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(child);
    }
  };
  await visit(root);
  return result;
}

test("generic harness has no Mechanical route ontology or Domain Pack dependency", async () => {
  const root = join(process.cwd(), "src", "harness");
  for (const path of await files(root)) {
    const source = await readFile(path, "utf-8");
    assert.doesNotMatch(source, /\b(?:greenfield|legacy|assembly|manufacturing|maturity|interference|drawing)\b|routeKey|RouteLineage|RouteStructure|domains\/mechanical/i, path);
    assert.doesNotMatch(source, /pi\.registerTool/, path);
  }
});
