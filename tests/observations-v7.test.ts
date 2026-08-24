import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import probe from "../src/extensions/probe/index.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { recordObservationV7, readObservationV7 } from "../src/harness/observations.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7, HarnessRunStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

test("v7 Observations are immutable direct files with a bounded newest-first index", async () => {
  probe({ registerTool() {} } as any);
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-observations-v7-"));
  try {
    const workflow = compileWorkflowDefinition({ schema: 1, id: "test/observations", version: "1.0.0", parametersSchema: {}, initialPhase: "work", phases: {
      work: { purpose: "Observe", actions: ["cad_probe"], grants: ["observe"], writeScopes: ["run:observation"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action", "mechanical.observations"], hooks: [], transitions: { done: { target: "end" } } },
      end: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
    } }, mechanicalRegistries);
    const loaded = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const next = await recordObservationV7({ cwd, workflowRunId: loaded.state.runId, registries: mechanicalRegistries, tool: "cad_probe", headline: `probe ${index}`, facts: [{ key: "index", value: index }], provenance: { preset: "geometry" }, capacity: 3 });
      ids.push(next.state.contextRefs!.latestObservation!.split("/").at(-1)!.replace(/\.json$/, ""));
    }
    const store = new HarnessRunStoreV7(cwd, loaded.state.runId);
    const index = await store.transactions.readJson<any>("indexes/observations.json");
    assert.equal(index.total, 5);
    assert.equal(index.entries.length, 3);
    assert.equal(index.entries[0].id, ids.at(-1));
    const snapshot = await readObservationV7({ cwd, workflowRunId: loaded.state.runId, id: ids.at(-1)!, registries: mechanicalRegistries });
    assert.equal(snapshot.headline, "probe 4");
    assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
