#!/usr/bin/env node
import YAML from "yaml";
import { createJiti } from "jiti";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const source = Buffer.concat(chunks).toString("utf8");
const value = YAML.parse(source);
if (!value || value.schema !== 1 || typeof value.id !== "string" || typeof value.version !== "string" || !value.workflow) {
  throw new Error("Workflow package must define schema: 1, id, version, and workflow.");
}
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { compileWorkflowDefinition } = await jiti.import("../src/harness/workflow/compiler.ts");
const { mechanicalRegistries } = await jiti.import("../src/domains/mechanical/registries.ts");
const { bootstrapAgentApiContracts } = await jiti.import("../src/agent-api/bootstrap.ts");
bootstrapAgentApiContracts();
const compiled = compileWorkflowDefinition(value.workflow, mechanicalRegistries);
if (compiled.id !== value.id || compiled.version !== String(value.version)) throw new Error("Workflow package identity does not match the compiled workflow.");
process.stdout.write(`${JSON.stringify({ id: value.id, version: value.version, hash: compiled.hash })}\n`);
