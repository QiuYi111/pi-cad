import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import probe from "../src/extensions/probe/index.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { queryObservationCollectionV7, readObservationPayloadV7, recordObservationV7, readObservationV7 } from "../src/harness/observations.ts";
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
      const next = await recordObservationV7({
        cwd, workflowRunId: loaded.state.runId, registries: mechanicalRegistries, tool: "cad_probe", headline: `probe ${index}`,
        facts: [{ key: "index", value: index }], provenance: { preset: "geometry" }, capacity: 3,
        payload: { rows: Array.from({ length: index === 4 ? 444 : 2 }, (_, row) => ({ row, score: 1000 - row })) },
      });
      ids.push(next.state.contextRefs!.latestObservation!.split("/").at(-2)!);
    }
    const store = new HarnessRunStoreV7(cwd, loaded.state.runId);
    const index = await store.transactions.readJson<any>("indexes/observations.json");
    assert.equal(index.total, 5);
    assert.equal(index.entries.length, 3);
    assert.equal(index.entries[0].id, ids.at(-1));
    const snapshot = await readObservationV7({ cwd, workflowRunId: loaded.state.runId, id: ids.at(-1)!, registries: mechanicalRegistries });
    assert.equal(snapshot.headline, "probe 4");
    assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
    assert.match(snapshot.payloadDigest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(snapshot.collections?.find((item) => item.name === "rows")?.count, 444);
    const payload = await readObservationPayloadV7({ cwd, workflowRunId: loaded.state.runId, id: ids.at(-1)!, registries: mechanicalRegistries }) as any;
    assert.equal(payload.rows.length, 444);
    const first = await queryObservationCollectionV7({ cwd, workflowRunId: loaded.state.runId, id: ids.at(-1)!, collection: "rows", query: { where: [{ field: "row", op: "gte", value: 400 }], orderBy: [{ field: "row", direction: "asc" }], fields: ["row"], limit: 20 }, registries: mechanicalRegistries });
    assert.equal(first.totalMatched, 44);
    assert.equal(first.items.length, 20);
    const second = await queryObservationCollectionV7({ cwd, workflowRunId: loaded.state.runId, id: ids.at(-1)!, collection: "rows", query: { where: [{ field: "row", op: "gte", value: 400 }], orderBy: [{ field: "row", direction: "asc" }], fields: ["row"], limit: 20, cursor: first.nextCursor }, registries: mechanicalRegistries });
    assert.deepEqual((second.items as any[]).slice(0, 2), [{ row: 420 }, { row: 421 }]);
    const tools = new Map<string, any>();
    probe({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
    const recalled = await tools.get("cad_recall_observation").execute("recall-1", { observationId: ids.at(-1), collection: "rows", limit: 2 }, undefined, undefined, { cwd });
    assert.match(recalled.content[0].text, /"totalMatched": 444/);
    assert.equal(recalled.details.nextCursor !== undefined, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
