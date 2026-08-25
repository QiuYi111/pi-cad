import assert from "node:assert/strict";
import { test } from "node:test";

import core from "../src/extensions/core/index.ts";
import drawing from "../src/extensions/drawing/index.ts";
import geometry from "../src/extensions/geometry/index.ts";
import presentation from "../src/extensions/presentation/index.ts";
import probe from "../src/extensions/probe/index.ts";
import simulation from "../src/extensions/simulation/index.ts";
import { buildRegistryContract, registryContractHash, verifyRegistryContract } from "../src/harness/registry-contract.ts";
import { contractEntry, createRegistrySet, StrictRegistry } from "../src/harness/registry.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { ACTIVE_PUBLIC_TOOL_NAMES } from "../src/shared/public-tools.ts";

function fakePi() {
  const pi: any = {
    tools: new Map<string, unknown>(), commands: new Map(), handlers: new Map(), activeTools: [],
    registerTool(tool: any) { pi.tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { pi.commands.set(name, command); },
    on(event: string, handler: any) { pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]); },
    setActiveTools(tools: string[]) { pi.activeTools = [...tools]; },
    getActiveTools() { return [...pi.activeTools]; },
    getAllTools() { return [...pi.tools.values()]; },
    appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} },
  };
  return pi;
}

test("Mechanical tools register their live schemas and produce a deterministic Registry Contract", () => {
  const pi = fakePi();
  for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
  for (const name of ACTIVE_PUBLIC_TOOL_NAMES) {
    const registration = mechanicalRegistries.actions.require(name);
    assert.deepEqual(registration.contract.schema, {
      input: (pi.tools.get(name) as any).parameters,
      output: { protocol: "pi-tool-result-v1", failClosed: true },
    });
  }
  const first = buildRegistryContract(mechanicalRegistries);
  const second = buildRegistryContract(mechanicalRegistries);
  assert.deepEqual(second, first);
  assert.equal(first.hash, registryContractHash(first));
  // Seven host actions plus the internal generic reducer actions (including
  // Plan C's generic workspace commit and the externally hosted image tool);
  // cad_start is both public and Kernel-owned, so it is counted only once.
  assert.equal(Object.keys(first.actions).length, ACTIVE_PUBLIC_TOOL_NAMES.length + 14);
  assert.equal(Object.keys(first.runtimeProfiles).length, 5);
});

test("Registry Contract restore fails closed on hash, missing IDs, and semantic drift", () => {
  const pinned = buildRegistryContract(mechanicalRegistries);
  const badHash = { ...pinned, hash: "0".repeat(64) };
  assert.ok(verifyRegistryContract(badHash, mechanicalRegistries).some((issue) => issue.reason === "invalid_hash"));

  const empty = createRegistrySet();
  assert.ok(verifyRegistryContract(pinned, empty).some((issue) => issue.reason === "missing"));

  const drifted = createRegistrySet();
  const action = mechanicalRegistries.actions.entries()[0]!;
  drifted.actions.register({
    ...action,
    contract: { ...action.contract, semantics: { changed: true } },
  });
  const one = buildRegistryContract(createRegistrySet());
  one.actions[action.id] = contractEntry(action);
  one.hash = registryContractHash(one);
  assert.ok(verifyRegistryContract(one, drifted).some((issue) => issue.kind === "actions" && issue.reason === "incompatible"));
});

test("registries reject duplicates, freeze mutation, and accept only explicitly declared compatibility", () => {
  const old = new StrictRegistry("actions");
  const original = old.register({ id: "example", contract: { version: "1.0.0", schema: { type: "object" }, semantics: { meaning: "old" } } });
  assert.throws(() => old.register(original), /duplicate/);
  old.freeze();
  assert.throws(() => old.register({ id: "later", contract: { version: "1.0.0", schema: {}, semantics: {} } }), /frozen/);

  const pinnedRegistries = createRegistrySet();
  pinnedRegistries.actions.register(original);
  const pinned = buildRegistryContract(pinnedRegistries);
  const live = createRegistrySet();
  live.actions.register({
    id: "example",
    contract: {
      version: "2.0.0",
      schema: { type: "object", required: [] },
      semantics: { meaning: "new" },
      compatibleWith: [contractEntry(original)],
    },
  });
  assert.deepEqual(verifyRegistryContract(pinned, live), []);
});
