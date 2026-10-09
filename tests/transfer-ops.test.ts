import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { compareEquivalence, firstDifferingFeature } from "../src/agent-api/transfer-check.ts";
import { recordDfmSummary } from "../src/agent-api/part-ops.ts";
import { handleTransferOperation, transferHooks, TRANSFER_DIR } from "../src/agent-api/transfer-ops.ts";
import { dispatchSidecarRequest } from "../src/authority/sidecar.ts";
import type { FaceFingerprint, GeometryPayload } from "../src/shared/protocol.ts";

const plane = (c: [number, number, number], a: number, n: number[]): FaceFingerprint => ({ type: "PLANE", c, a, n });
const geometry = (overrides: Partial<GeometryPayload> = {}): GeometryPayload => ({
  bbox: { x: 40, y: 30, z: 5 }, volume: 5000, solidCount: 1, faceCount: 2,
  faceFingerprints: [plane([20, 15, 5], 1200, [0, 0, 1]), plane([20, 15, 0], 1200, [0, 0, -1])],
  ...overrides,
});

test("equal geometry passes the equivalence check", () => {
  const report = compareEquivalence(geometry(), geometry());
  assert.equal(report.passed, true);
  assert.equal(report.firstDifferingFeature, null);
});

test("a volume error above 1e-6 fails the check and names the first differing feature", () => {
  const report = compareEquivalence(geometry(), geometry({ volume: 5000.01 }), {
    reference: [{ name: "plate/base", volume_mm3: 6000 }, { name: "plate/holes", volume_mm3: 5000 }],
    executor: [{ name: "plate/base", volume_mm3: 6000 }, { name: "plate/holes", volume_mm3: 5000.01 }],
  });
  assert.equal(report.passed, false);
  assert.equal(report.volume.ok, false);
  assert.equal(report.firstDifferingFeature?.name, "plate/holes");
  assert.match(report.failures[0]!, /volume differs/);
});

test("a volume error below 1e-6 passes", () => {
  assert.equal(compareEquivalence(geometry(), geometry({ volume: 5000.004 })).passed, true);
});

test("a different bounding box or an unmatched face fails the check", () => {
  assert.equal(compareEquivalence(geometry(), geometry({ bbox: { x: 40, y: 30, z: 5.01 } })).bbox.ok, false);
  const missing = compareEquivalence(geometry(), geometry({ faceFingerprints: [plane([20, 15, 5], 1200, [0, 0, 1])] }));
  assert.equal(missing.faces.ok, false);
  assert.equal(missing.faces.unmatchedReference, 1);
});

test("a feature that the executor did not build is the first differing feature", () => {
  const found = firstDifferingFeature([{ name: "a", volume_mm3: 1 }], [{ name: "b", volume_mm3: 1 }]);
  assert.equal(found?.name, "a");
});

// ------------------------------------------------------------------ spool flow

let cwd = "";
const spool = (...parts: string[]) => join(cwd, TRANSFER_DIR, ...parts);
const savedHooks = { ...transferHooks };
let clock = Date.parse("2026-10-07T12:00:00Z");

async function dispatcher(targets: Record<string, string>, ageMs = 0) {
  await mkdir(spool(), { recursive: true });
  await writeFile(spool("dispatcher.json"), JSON.stringify({ schema: 1, pid: 1, updatedAt: new Date(clock - ageMs).toISOString(), targets }));
}

const canonical = {
  features: { schema: "reify.features/1", part: "plate", bodies: [], reference: { feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }] } },
  featureCount: 7, part: "plate",
};

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "transfer-ops-"));
  await mkdir(join(cwd, "parts"), { recursive: true });
  await writeFile(join(cwd, "parts", "plate.FCStd"), "x");
  clock = Date.parse("2026-10-07T12:00:00Z");
  transferHooks.now = () => clock;
  transferHooks.sleep = async (ms) => { clock += ms; await answerPendingRequest(); };
  transferHooks.pollMs = 1000;
  transferHooks.canonicalize = async () => canonical;
  transferHooks.inspect = async () => geometry();
});

afterEach(async () => {
  Object.assign(transferHooks, savedHooks);
  answer = null;
  await rm(cwd, { recursive: true, force: true });
});

/** What the desktop dispatcher does: read the request, write the result. */
let answer: ((request: any) => Promise<Record<string, unknown>>) | null = null;
async function answerPendingRequest() {
  if (!answer) return;
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(spool("requests")).catch(() => [] as string[]);
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const request = JSON.parse(await readFile(spool("requests", name), "utf8"));
    const handler = answer;
    answer = null;
    const result = await handler!(request);
    await mkdir(spool("results"), { recursive: true });
    await writeFile(spool("results", `${request.jobId}.json`), JSON.stringify({ jobId: request.jobId, target: request.target, ...result }));
  }
}

const exportRequest = { schema: 1, op: "transfer-export", doc: "parts/plate.FCStd", target: "fusion", output: "exports/plate.f3d" } as const;

test("transfer-status reports unavailable without a live dispatcher", async () => {
  assert.deepEqual(await handleTransferOperation(cwd, { schema: 1, op: "transfer-status" }), {
    fusion: "unavailable", solidworks: "unavailable", detail: { dispatcher: "absent" },
  });
  await dispatcher({ fusion: "ready", solidworks: "not_installed" }, 60_000);
  assert.equal((await handleTransferOperation(cwd, { schema: 1, op: "transfer-status" }) as any).detail.dispatcher, "stale");
  await dispatcher({ fusion: "ready", solidworks: "not_installed" });
  assert.deepEqual(await handleTransferOperation(cwd, { schema: 1, op: "transfer-status" }), {
    fusion: "ready", solidworks: "not_installed", detail: {},
  });
});

test("transfer-features writes the canonical JSON and does not need the desktop app", async () => {
  const result = await handleTransferOperation(cwd, { schema: 1, op: "transfer-features", doc: "parts/plate.FCStd" }) as any;
  assert.equal(result.part, "plate");
  assert.equal(result.features, 7);
  assert.equal(result.path, "build/transfer/plate.features.json");
  assert.equal(JSON.parse(await readFile(join(cwd, result.path), "utf8")).schema, "reify.features/1");
  assert.equal(result.data.schema, "reify.features/1");
});

test("transfer-export without the desktop app fails with TRANSFER_UNAVAILABLE", async () => {
  await assert.rejects(handleTransferOperation(cwd, exportRequest), (error: any) => error.code === "TRANSFER_UNAVAILABLE");
});

test("a target that is not ready fails with TRANSFER_TARGET_NOT_READY and a hint to Settings", async () => {
  await dispatcher({ fusion: "addin_not_running", solidworks: "not_installed" });
  await assert.rejects(handleTransferOperation(cwd, exportRequest), (error: any) => {
    assert.equal(error.code, "TRANSFER_TARGET_NOT_READY");
    assert.equal(error.detail.state, "addin_not_running");
    assert.match(error.hints[0], /Settings > CAD exports/);
    return true;
  });
});

test("a wrong output suffix or target is a bad request before any work", async () => {
  await dispatcher({ fusion: "ready", solidworks: "ready" });
  await assert.rejects(handleTransferOperation(cwd, { ...exportRequest, output: "exports/plate.SLDPRT" }), (error: any) => error.code === "BAD_REQUEST");
  await assert.rejects(handleTransferOperation(cwd, { ...exportRequest, target: "catia" as never }), (error: any) => error.code === "BAD_REQUEST");
});

test("a good export is checked and returns the native file", async () => {
  await dispatcher({ fusion: "ready", solidworks: "not_installed" });
  answer = async (request) => {
    await mkdir(join(cwd, "exports"), { recursive: true });
    await writeFile(join(cwd, request.native), "f3d");
    await writeFile(join(cwd, request.checkStep), "step");
    assert.equal(request.features.endsWith("features.json"), true);
    return { ok: true, files: { native: request.native, check_step: request.checkStep, log: `build/transfer/${request.jobId}/log.txt` }, features_built: 7, feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }] };
  };
  const result = await handleTransferOperation(cwd, exportRequest) as any;
  assert.equal(result.check, "passed");
  assert.equal(result.file, "exports/plate.f3d");
  assert.equal(result.features, 7);
  assert.equal(result.dfm, null, "a document without a DFM profile has no DFM state");
});

test("an export states the document's latest DFM state and is not blocked by errors", async () => {
  await dispatcher({ fusion: "ready", solidworks: "not_installed" });
  await recordDfmSummary(cwd, "parts/plate.FCStd", {
    rulepack: "quanzhou.cnc_mill", material: "al6061", layer: "lint+geometry",
    counts: { error: 2, warn: 1, info: 0, pass: 3 }, geometry: { state: "stale", last_rev: 1 },
    issues: [{ rule: "hole.min_diameter", severity: "error" }],
  });
  answer = async (request) => {
    await mkdir(join(cwd, "exports"), { recursive: true });
    await writeFile(join(cwd, request.native), "f3d");
    await writeFile(join(cwd, request.checkStep), "step");
    return { ok: true, files: { native: request.native, check_step: request.checkStep }, features_built: 7, feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }] };
  };
  const result = await handleTransferOperation(cwd, exportRequest) as any;
  assert.equal(result.check, "passed");
  assert.deepEqual(result.dfm, {
    rulepack: "quanzhou.cnc_mill", material: "al6061", layer: "lint+geometry",
    counts: { error: 2, warn: 1, info: 0, pass: 3 }, geometry: { state: "stale", last_rev: 1 },
  });
});

test("a caller can choose the job id", async () => {
  await dispatcher({ fusion: "ready", solidworks: "not_installed" });
  let seen = "";
  answer = async (request) => {
    seen = request.jobId;
    await mkdir(join(cwd, "exports"), { recursive: true });
    await writeFile(join(cwd, request.native), "f3d");
    await writeFile(join(cwd, request.checkStep), "step");
    return { ok: true, files: { native: request.native, check_step: request.checkStep }, features_built: 7 };
  };
  await handleTransferOperation(cwd, { ...exportRequest, jobId: "ui-job-1" } as never);
  assert.equal(seen, "ui-job-1");
  await assert.rejects(handleTransferOperation(cwd, { ...exportRequest, jobId: "../x" } as never), (error: any) => error.code === "BAD_REQUEST");
});

test("an assembly document is exported as an assembly job with the default .SLDASM name", async () => {
  await dispatcher({ fusion: "ready", solidworks: "ready" });
  transferHooks.canonicalize = async () => ({ ...canonical, kind: "assembly", features: { schema: "reify.assembly/1", reference: { feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }] } } });
  let seen: any = null;
  answer = async (request) => {
    seen = request;
    await mkdir(join(cwd, "exports"), { recursive: true });
    await writeFile(join(cwd, request.native), "asm");
    await writeFile(join(cwd, request.checkStep), "step");
    return { ok: true, files: { native: request.native, check_step: request.checkStep }, features_built: 7, feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }] };
  };
  const result = await handleTransferOperation(cwd, { schema: 1, op: "transfer-export", doc: "parts/plate.FCStd", target: "solidworks" } as never) as any;
  assert.equal(result.file, "exports/plate.SLDASM");
  assert.equal(seen.kind, "assembly");
  assert.equal(typeof seen.assembly, "string");
  assert.equal(seen.features, undefined);
  await assert.rejects(
    handleTransferOperation(cwd, { schema: 1, op: "transfer-export", doc: "parts/plate.FCStd", target: "solidworks", output: "exports/x.SLDPRT" } as never),
    (error: any) => error.code === "BAD_REQUEST",
  );
});

const arm = [{ path: "arm/j1", type: "revolute", value: 30 }];

test("an assembly with joints says that the joints were not exported", async () => {
  await dispatcher({ fusion: "ready", solidworks: "ready" });
  transferHooks.canonicalize = async () => ({ ...canonical, kind: "assembly", joints: arm, features: { schema: "reify.assembly/1", reference: { feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }] } } });
  answer = async (request) => {
    await mkdir(join(cwd, "exports"), { recursive: true });
    await writeFile(join(cwd, request.native), "f3d");
    await writeFile(join(cwd, request.checkStep), "step");
    return { ok: true, files: { native: request.native, check_step: request.checkStep }, features_built: 7, feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }] };
  };
  const exported = await handleTransferOperation(cwd, { schema: 1, op: "transfer-export", doc: "assembly/arm.FCStd", target: "fusion" } as never) as any;
  assert.equal(exported.notes.length, 1);
  assert.match(exported.notes[0], /arm\/j1 \(revolute at 30\)/);
  assert.match(exported.notes[0], /not exported/);
  const dry = await handleTransferOperation(cwd, { schema: 1, op: "transfer-features", doc: "assembly/arm.FCStd" }) as any;
  assert.equal(dry.notes.length, 1);
  assert.deepEqual(dry.joints, arm);
});

test("a part or an assembly without joints has no notes", async () => {
  transferHooks.canonicalize = async () => ({ ...canonical, kind: "assembly", joints: [] });
  const dry = await handleTransferOperation(cwd, { schema: 1, op: "transfer-features", doc: "assembly/arm.FCStd" }) as any;
  assert.equal("notes" in dry, false);
});

test("the dry run reports the kind of the document", async () => {
  transferHooks.canonicalize = async () => ({ ...canonical, kind: "assembly" });
  const result = await handleTransferOperation(cwd, { schema: 1, op: "transfer-features", doc: "parts/plate.FCStd" }) as any;
  assert.equal(result.kind, "assembly");
  assert.equal(result.path, "build/transfer/plate.assembly.json");
});

test("check=False skips the check and says so", async () => {
  await dispatcher({ fusion: "ready", solidworks: "not_installed" });
  transferHooks.inspect = async () => { throw new Error("must not inspect"); };
  answer = async (request) => {
    await mkdir(join(cwd, "exports"), { recursive: true });
    await writeFile(join(cwd, request.native), "f3d");
    return { ok: true, files: { native: request.native }, features_built: 7 };
  };
  const result = await handleTransferOperation(cwd, { ...exportRequest, check: false }) as any;
  assert.equal(result.check, "skipped");
  assert.equal(result.checkStep, null);
});

test("a shape that differs fails with TRANSFER_CHECK_FAILED and names the feature", async () => {
  await dispatcher({ fusion: "ready", solidworks: "not_installed" });
  let calls = 0;
  transferHooks.inspect = async () => (calls++ === 0 ? geometry() : geometry({ volume: 4900 }));
  answer = async (request) => {
    await mkdir(join(cwd, "exports"), { recursive: true });
    await writeFile(join(cwd, request.native), "f3d");
    await writeFile(join(cwd, request.checkStep), "step");
    return { ok: true, files: { native: request.native, check_step: request.checkStep }, features_built: 7, feature_volumes: [{ name: "plate/base", volume_mm3: 5900 }] };
  };
  await assert.rejects(handleTransferOperation(cwd, exportRequest), (error: any) => {
    assert.equal(error.code, "TRANSFER_CHECK_FAILED");
    assert.equal(error.target, "plate/base");
    assert.equal(error.detail.report.passed, false);
    return true;
  });
  // The files stay for debugging.
  assert.equal(await readFile(join(cwd, "exports", "plate.f3d"), "utf8"), "f3d");
});

test("executor errors map to the stable codes and keep the feature name", async () => {
  const cases: Array<[string, string]> = [
    ["EXECUTOR_FAILED", "TRANSFER_EXECUTOR_FAILED"], ["UNSUPPORTED_OP", "TRANSFER_UNSUPPORTED_OP"],
    ["TIMEOUT", "TRANSFER_TIMEOUT"], ["TARGET_NOT_READY", "TRANSFER_TARGET_NOT_READY"],
  ];
  for (const [executorCode, code] of cases) {
    await dispatcher({ fusion: "ready", solidworks: "not_installed" });
    answer = async () => ({ ok: false, error: { code: executorCode, message: "boom", feature: "plate/holes", step: "extrude" } });
    await assert.rejects(handleTransferOperation(cwd, exportRequest), (error: any) => {
      assert.equal(error.code, code, executorCode);
      if (code !== "TRANSFER_TARGET_NOT_READY") assert.equal(error.target, "plate/holes");
      assert.equal(error.detail.feature, "plate/holes");
      return true;
    });
  }
});

test("no answer in time fails with TRANSFER_TIMEOUT and leaves a cancel file", async () => {
  await dispatcher({ fusion: "ready", solidworks: "not_installed" });
  const keepAlive = transferHooks.sleep;
  transferHooks.sleep = async (ms) => { await keepAlive(ms); await dispatcher({ fusion: "ready", solidworks: "not_installed" }); };
  await assert.rejects(handleTransferOperation(cwd, exportRequest), (error: any) => error.code === "TRANSFER_TIMEOUT");
  const { readdir } = await import("node:fs/promises");
  assert.equal((await readdir(spool("cancel"))).length, 1);
});

test("the desktop app stopping during a job fails with TRANSFER_UNAVAILABLE", async () => {
  await dispatcher({ fusion: "ready", solidworks: "not_installed" });
  await assert.rejects(handleTransferOperation(cwd, exportRequest), (error: any) => error.code === "TRANSFER_UNAVAILABLE");
});

test("a read-only desktop denies transfer-export but allows the dry run and the status", async () => {
  const denied = await dispatchSidecarRequest("author", cwd, exportRequest as never, undefined, undefined, { authorReadOnly: true });
  assert.equal(denied.ok, false);
  assert.match(denied.error!.message, /desktop read-only mode denies operation: transfer-export/);
  const status = await dispatchSidecarRequest("author", cwd, { schema: 1, op: "transfer-status" } as never, undefined, undefined, { authorReadOnly: true });
  assert.equal(status.ok, true);
  const reviewer = await dispatchSidecarRequest("reviewer", cwd, { schema: 1, op: "transfer-status" } as never);
  assert.equal(reviewer.ok, false);
});
