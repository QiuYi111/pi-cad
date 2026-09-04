#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const prompt = args.at(-1) || "";

if (args.length > 1) {
  process.stdout.write(/Judge one checkpoint continuation/i.test(prompt)
    ? "PASS\nThe next action checks the recorded failure before rebuilding.\n"
    : "Inspect the load path and the ambiguous interface before changing geometry.\n");
  process.exit(0);
}

const requestPath = resolve(args[0] || "");
const root = dirname(requestPath);
const request = JSON.parse(await readFile(requestPath, "utf8"));
const entries = (await readFile(join(root, "index.jsonl"), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((entry) => entry.seq >= request.from_seq && entry.seq <= request.cutoff_seq && entry.evaluation_status === "evaluated");
const source = entries.find((entry) => entry.quality <= 3) || entries[0];
if (!source) throw new Error("fixture needs one evaluated trajectory");
const evidence = source.feedback || "The bracket was built before its load path was checked.";
const target = join(process.cwd(), "skills", "parametric-cad-modeling", "references", "cookbook.md");
await appendFile(target, "\n## Learned repair\n\nBefore rebuilding a failed bracket, inspect its load path and ambiguous interfaces.\n", "utf8");

const jobs = join(root, "distill-jobs");
const stem = basename(requestPath, ".json");
await mkdir(jobs, { recursive: true });
await writeFile(join(jobs, `${stem}.replay.json`), `${JSON.stringify({
  cases: [{
    kind: "repair",
    seq: source.seq,
    task: "Repair a load-bearing bracket.",
    checkpoint: "The first geometry failed review before revision.",
    evidence,
    failureSignature: "Geometry was changed without checking its load path.",
    expectedRepair: "Inspect the load path and interface before rebuilding.",
    regressionGuard: "Do not proceed directly to another geometry edit.",
  }],
}, null, 2)}\n`, "utf8");
await writeFile(join(jobs, `${stem}.audit.md`), "# E2E distillation audit\n\nOne rated failure produced one bounded repair and replay case.\n", "utf8");
process.stdout.write("fixture distillation complete\n");
