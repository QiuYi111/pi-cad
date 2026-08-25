import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { mechanicalRegistries } from "../../src/domains/mechanical/registries.ts";
import { mechanicalBuiltinWorkflows } from "../../src/domains/mechanical/workflows.ts";
import { cadStart } from "../../src/harness/kernel.ts";

const cwd = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("task workspace is required");

await mkdir(cwd, { recursive: true });
const workflowName = "prime-plan-c-task.yaml";
await copyFile(resolve(import.meta.dirname, "workflows", workflowName), resolve(cwd, workflowName));
await writeFile(resolve(cwd, "pi-cad.yaml"), [
  "schema: 1",
  "workflow:",
  `  source: ${workflowName}`,
  "  parameters: {}",
  "",
].join("\n"));

const started = await cadStart({
  cwd,
  registries: mechanicalRegistries,
  builtins: mechanicalBuiltinWorkflows(),
  reason: "CADTestBench Prime Plan C task",
  interactionMode: "headless",
});

console.log(JSON.stringify({
  runId: started.state.runId,
  workflowId: started.workflow.id,
  workflowHash: started.workflow.hash,
  phase: started.state.phase,
  status: started.state.status,
}, null, 2));
