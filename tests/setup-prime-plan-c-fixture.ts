import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";

const cwd = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("fixture cwd is required");
const workflow = compileWorkflowDefinition({
  schema: 1,
  id: "test/prime-plan-c-provider",
  version: "1.0.0",
  parametersSchema: {},
  initialPhase: "design",
  phases: {
    design: {
      purpose: "Prime provider boundary",
      guidance: "Keep ordinary workspace data outside model context.",
      actions: ["cad_commit", "transition"],
      grants: ["transition"],
      writeScopes: ["run:state"],
      recordObligations: [{ ref: "provider-handoff", type: "workspace_commit", closeWith: "cad_commit" }],
      evidenceObligations: [],
      contextProviders: ["kernel.current-action"],
      hooks: [],
      transitions: {},
      terminal: true,
    },
  },
}, mechanicalRegistries);

await writeFile(join(cwd, "mandatory.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
await writeFile(join(cwd, "ordinary-secret.txt"), "PLAN_C_ORDINARY_CANARY_MUST_STAY_OUT");
const started = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
await new HarnessRunStoreV7(cwd, started.state.runId).mutate(mechanicalRegistries, (loaded) => ({
  state: { ...loaded.state, contextRefs: { mandatoryImageProvider: "mandatory.png" } },
  event: { type: "PrimeProviderFixturePrepared" },
}));
