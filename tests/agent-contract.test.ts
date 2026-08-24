import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { renderCurrentActionCard, transitionFailureDetails } from "../src/core/agent-contract.ts";
import { ACTIVE_PUBLIC_TOOL_NAMES } from "../src/shared/public-tools.ts";
import { CAD_PHASES } from "../src/shared/protocol.ts";

test("AgentContract covers every active tool, phase, event, obligation, and cookbook", async () => {
  const contract = JSON.parse(await readFile(join(process.cwd(), "assets", "agent-contract.json"), "utf-8"));
  assert.equal(contract.schema, 1);
  assert.deepEqual(contract.tools.map((item) => item.name).sort(), [...ACTIVE_PUBLIC_TOOL_NAMES].sort());
  assert.deepEqual(contract.phases.map((item) => item.phase).sort(), [...CAD_PHASES].sort());
  assert.ok(contract.events.length > 0);
  assert.ok(contract.obligations.length > 0);
  assert.ok(contract.tools.every((item: { inputSchema?: { schemaSource?: string } }) => item.inputSchema && !item.inputSchema.schemaSource), "every public tool must embed the exact registered schema");
  const catalog = JSON.parse(await readFile(join(process.cwd(), "assets", "cookbook-catalog.json"), "utf-8"));
  assert.deepEqual(catalog.tools.map((item: { tool: string }) => item.tool).sort(), [...ACTIVE_PUBLIC_TOOL_NAMES].sort());
});

test("Current Action Card is sufficient for phase tools, writes, obligations, events, and runtimes", () => {
  const state = {
    schemaVersion: 6, runId: "r", projectId: "p", createdAt: "x", updatedAt: "x",
    route: { objective: "design", lineage: "greenfield", structure: "part", maturity: "engineering" },
    phase: "review", status: "active", mutationPolicy: "read_only", phaseRecords: [], evidence: [], staleEvidence: [],
    currentArtifactPath: "build/part.step", currentArtifactHash: "a".repeat(64),
  } as any;
  const card = renderCurrentActionCard(state, "## Ready managed runtimes\n- backend=openfoam runtime=openfoam-14");
  for (const text of ["Route / phase / status", "Phase purpose", "Allowed writes", "Available Pi-CAD tools", "Unmet records", "Current artifact", "Legal cad_transition events", "Recommended next action", "Ready managed runtimes"]) assert.match(card, new RegExp(text));
  assert.doesNotMatch(card, /read src\//i);
  const rejected = transitionFailureDetails(state, "invented_event");
  assert.equal(rejected.attemptedEvent, "invented_event");
  assert.ok(Array.isArray(rejected.allowedEvents));
  assert.ok(rejected.suggestedActions.length > 0);
});
