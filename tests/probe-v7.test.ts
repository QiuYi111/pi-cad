/**
 * v7 probe end-to-end: evidence placement (F1) and observation recall.
 *
 * Both go through the public cad_probe / cad_recall_observation tools inside a
 * real v7 harness run; no v6 project pointer is written.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import probe from "../src/extensions/probe/index.ts";
import { harnessRunDirectory } from "../src/shared/storage-paths.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { buildRegistryContract } from "../src/harness/registry-contract.ts";
import { HarnessProjectStoreV7 } from "../src/harness/run-store.ts";
import { compileWorkflowDefinition } from "../src/harness/workflow/compiler.ts";

const STEP_FIXTURE = new URL("./fixtures/interference_contact.step", import.meta.url);

function probeTools(): Map<string, any> {
  const tools = new Map<string, any>();
  probe({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  return tools;
}

async function startV7Run(cwd: string): Promise<string> {
  const workflow = compileWorkflowDefinition({ schema: 1, id: "test/probe-v7", version: "1.0.0", parametersSchema: {}, initialPhase: "work", phases: {
    work: { purpose: "Observe", actions: ["cad_probe", "cad_recall_observation"], grants: ["observe"], writeScopes: ["run:observation"], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action", "mechanical.observations"], hooks: [], transitions: { done: { target: "end" } } },
    end: { purpose: "Done", actions: ["read"], grants: ["file_read"], writeScopes: [], recordObligations: [], evidenceObligations: [], contextProviders: ["kernel.current-action"], hooks: [], transitions: {}, terminal: true },
  } }, mechanicalRegistries);
  const loaded = await new HarnessProjectStoreV7(cwd).startRun({ workflow, registryContract: buildRegistryContract(mechanicalRegistries) });
  return loaded.state.runId;
}

function withProject<T>(name: string, body: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), `pi-cad-${name}-`));
  return body(cwd).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

test("F1: a geometry probe in a v7 run writes its evidence under the run directory", async () => {
  const tools = probeTools();
  await withProject("probe-evidence-v7", async (cwd) => {
    const runId = await startV7Run(cwd);
    mkdirSync(join(cwd, "build"), { recursive: true });
    writeFileSync(join(cwd, "build", "part.step"), readFileSync(STEP_FIXTURE));

    const result = await tools.get("cad_probe").execute("call-1", { preset: "geometry", args: { artifact: "build/part.step" } }, undefined, undefined, { cwd });
    assert.notEqual(result.isError, true, result.content[0].text);

    const runEvidence = join(harnessRunDirectory(cwd, runId), "evidence", "geometry", "part.json");
    const legacyDefault = join(cwd, ".pi-cad", "evidence", "geometry", "part.json");
    assert.equal(existsSync(runEvidence), true, "geometry evidence must land in the v7 run directory");
    assert.equal(existsSync(legacyDefault), false, "geometry evidence must not fall back to the default evidence directory");
  });
});

test("v7 cad_probe observations are recorded in the run and recalled by cad_recall_observation", async () => {
  const tools = probeTools();
  await withProject("recall-v7", async (cwd) => {
    await startV7Run(cwd);
    mkdirSync(join(cwd, "build"), { recursive: true });
    writeFileSync(join(cwd, "build", "part.step"), readFileSync(STEP_FIXTURE));
    const probeResult = await tools.get("cad_probe").execute("call-2", { preset: "geometry", args: { artifact: "build/part.step" } }, undefined, undefined, { cwd });
    assert.notEqual(probeResult.isError, true, probeResult.content[0].text);
    const observationId = probeResult.details.observationId as string;
    assert.match(observationId, /^observation-/);

    const recall = tools.get("cad_recall_observation");
    const summaries = await recall.execute("call-3", {}, undefined, undefined, { cwd });
    assert.notEqual(summaries.isError, true, summaries.content[0].text);
    assert.match(summaries.content[0].text, new RegExp(observationId));

    const detail = await recall.execute("call-4", { observationId }, undefined, undefined, { cwd });
    assert.notEqual(detail.isError, true, detail.content[0].text);
    assert.match(detail.content[0].text, /cad_probe\/geometry|geometry facts/);
    assert.equal(detail.details.observationId, observationId);

    const facts = await recall.execute("call-5", { observationId, collection: "facts", where: [{ field: "key", op: "contains", value: "" }], limit: 1 }, undefined, undefined, { cwd });
    assert.notEqual(facts.isError, true, facts.content[0].text);
    const page = JSON.parse(facts.content[0].text);
    assert.equal(page.collection, "facts");
    assert.equal(page.items.length, 1);
    assert.ok(page.totalMatched >= 1);
  });
});
