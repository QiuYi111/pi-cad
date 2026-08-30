#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const payload = JSON.parse(readFileSync(0, "utf8"));
if (typeof payload.root !== "string" || !payload.root) throw new Error("experience root is required");
process.env.PI_CAD_EXPERIENCE_ROOT = payload.root;

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { finalizeExperience, recordBenchmarkEvaluation } = await jiti.import("../src/experience/store.ts", { default: true });
const result = payload.op === "finalize"
  ? await finalizeExperience(payload.input)
  : await recordBenchmarkEvaluation(payload.identifier, payload.evaluation);
process.stdout.write(`${JSON.stringify(result)}\n`);
