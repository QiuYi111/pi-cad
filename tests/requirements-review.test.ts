import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerControlTools, type ControllerDeps } from "../src/core/controller.ts";
import type { FinalReviewResult } from "../src/shared/protocol.ts";
import { CadProjectStore } from "../src/shared/store.ts";

const contract = {
  goal: "make a 10 mm box",
  deliverables: ["STEP"],
  must: ["overall global X extent is 10 mm"],
  assertions: [{
    id: "A-x",
    mustRef: "M1",
    statement: "Overall global X extent is 10 mm",
    binding: { subject: "final body", quantity: "overall extent", direction: "global X" },
    expectation: { kind: "exact", value: 10, unit: "mm", tolerance: 0.001 },
    canonicalCheck: { field: "bbox.x" },
  }],
  preferences: [],
  assumptions: [],
  openUnknowns: [],
} as const;

function depsWithReviews(pi: ExtensionAPI, results: FinalReviewResult[]): ControllerDeps {
  return {
    pi,
    persist: async (_pi, store, state, events) => {
      await store.save(state);
      for (const event of events) await store.appendEvent(event.type, event.data);
    },
    runBaselineAuto: async () => { throw new Error("unused"); },
    runCandidateAuto: async () => { throw new Error("unused"); },
    runConvertCandidateAuto: async () => { throw new Error("unused"); },
    requirementsReviewerRunner: {
      run: async () => {
        const result = results.shift();
        if (!result) throw new Error("unexpected requirements review");
        return { result, usage: [], reviewerModel: "fake/adversary", sourceRefs: ["requirements:A-x"] };
      },
    },
  };
}

test("adversarial requirements review blocks a bad contract before implementation and accepts a repaired resubmission", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-cad-requirements-review-"));
  const previous = process.env.PI_CAD_REQUIREMENTS_REVIEWER;
  process.env.PI_CAD_REQUIREMENTS_REVIEWER = "1";
  try {
    const tools = new Map<string, any>();
    const pi = { registerTool(tool: { name: string }) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
    const failed: FinalReviewResult = {
      verdict: "fail",
      assertionChecks: [{
        assertionId: "A-x",
        verdict: "binding_suspect",
        finding: "the proposed binding uses the wrong geometric referent",
        evidenceRefs: ["requirements:A-x"],
      }],
      semanticObjections: [],
      summary: "repair the requirement binding",
    };
    const passed: FinalReviewResult = {
      verdict: "pass",
      assertionChecks: [{
        assertionId: "A-x",
        verdict: "pass",
        finding: "the Must and independently observable assertion agree",
        evidenceRefs: ["requirements:A-x"],
      }],
      semanticObjections: [],
      summary: "contract is ready",
    };
    registerControlTools(pi, depsWithReviews(pi, [failed, passed]));
    const ctx = { cwd } as ExtensionContext;
    const routed = await tools.get("cad_route").execute("route", {
      objective: "design",
      lineage: "greenfield",
      structure: "part",
      maturity: "prototype",
      reason: "test route",
    }, undefined, undefined, ctx);
    assert.match(routed.content[0].text, /REQUIREMENTS|requirements/i);

    const rejected = await tools.get("cad_commit_requirements").execute(
      "requirements-1", contract, undefined, undefined, ctx,
    );
    assert.match(rejected.content[0].text, /requirements review FAIL/i);
    const store = new CadProjectStore(cwd);
    const afterReject = await store.load();
    assert.equal(afterReject?.phase, "requirements");
    assert.equal(afterReject?.requirementsVersion, undefined);

    const accepted = await tools.get("cad_commit_requirements").execute(
      "requirements-2", contract, undefined, undefined, ctx,
    );
    assert.match(accepted.content[0].text, /Requirements committed/i);
    const afterAccept = await store.load();
    assert.equal(afterAccept?.phase, "part_design");
    assert.ok(afterAccept?.requirementsVersion);
    assert.equal((await store.listReviewsNewestFirst()).length, 2);
  } finally {
    if (previous === undefined) delete process.env.PI_CAD_REQUIREMENTS_REVIEWER;
    else process.env.PI_CAD_REQUIREMENTS_REVIEWER = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});
