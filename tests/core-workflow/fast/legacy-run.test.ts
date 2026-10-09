import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import core from "../../../src/extensions/core/index.ts";
import drawing from "../../../src/extensions/drawing/index.ts";
import geometry from "../../../src/extensions/geometry/index.ts";
import presentation from "../../../src/extensions/presentation/index.ts";
import probe from "../../../src/extensions/probe/index.ts";
import simulation from "../../../src/extensions/simulation/index.ts";

function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
    on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return [...tools.values()]; },
    appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} }, tools, handlers,
  };
  return pi;
}

test("public v7 entry refuses a project with an unfinished v6 run and accepts it once the old run state is moved aside", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v6-refusal-"));
  try {
    const runId = "run-20260101-001";
    await mkdir(join(cwd, ".pi-cad", "runs", runId), { recursive: true });
    await writeFile(join(cwd, ".pi-cad", "project.json"), JSON.stringify({
      schemaVersion: 6, projectId: "legacy", currentRunId: runId, head: { evidence: [], updatedAt: "x" }, createdAt: "x", updatedAt: "x",
    }));
    await writeFile(join(cwd, ".pi-cad", "runs", runId, "state.json"), JSON.stringify({
      schemaVersion: 6, runId, projectId: "legacy", status: "active", phase: "requirements", route: null,
    }));
    const pi = fakePi();
    for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
    const context = { cwd, hasUI: false } as any;
    await assert.rejects(
      pi.handlers.get("before_agent_start")[0]({ systemPrompt: "base" }, context),
      /v6 kernel was removed[\s\S]*unfinished legacy v6 run \(run-20260101-001[\s\S]*mv \.pi-cad\/project\.json/,
    );
    const blocked = await pi.handlers.get("tool_call")[0]({ toolName: "cad_route", input: {} }, context);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /v6 kernel was removed/);

    await rename(join(cwd, ".pi-cad", "project.json"), join(cwd, ".pi-cad", "project.json.v6-old"));
    const routed = await pi.tools.get("cad_route").execute("call-1", {
      objective: "design", lineage: "greenfield", structure: "part", maturity: "prototype", reason: "fresh start",
    }, undefined, undefined, context);
    assert.match(routed.content[0].text, /v7/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("public v7 entry also refuses a legacy schema 5 project with an unfinished run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-v5-refusal-"));
  try {
    const runId = "run-20251201-001";
    await mkdir(join(cwd, ".pi-cad", "runs", runId), { recursive: true });
    await writeFile(join(cwd, ".pi-cad", "project.json"), JSON.stringify({
      schemaVersion: 5, projectId: "legacy", currentRunId: runId, head: { evidence: [], updatedAt: "x" }, createdAt: "x", updatedAt: "x",
    }));
    await writeFile(join(cwd, ".pi-cad", "runs", runId, "state.json"), JSON.stringify({
      schemaVersion: 5, runId, projectId: "legacy", status: "waiting_user", phase: "requirements", route: null,
    }));
    const pi = fakePi();
    for (const extension of [core, probe, geometry, drawing, simulation, presentation]) extension(pi);
    const context = { cwd, hasUI: false } as any;
    await assert.rejects(
      pi.handlers.get("before_agent_start")[0]({ systemPrompt: "base" }, context),
      /legacy v5 run \(run-20251201-001, status=waiting_user\)/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
