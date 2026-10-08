import { beforeEach, describe, expect, it } from "vitest";
import { CadTransferService, evaluateDispatcherFile, type DispatchRequest } from "../electron/main/cad-transfer";
import { BridgeProjectIO } from "../electron/main/cad-transfer-project-io";
import { layoutFor } from "../electron/main/cad-transfer-paths";
import type { CadTransferEvent } from "../src/shared/contracts";
import { FakeProject, MANIFEST, detectDeps } from "./helpers/cad-transfer-fakes";

const L = (deps: ReturnType<typeof detectDeps>) => layoutFor(deps.host);
const FEATURES = { schema: "reify.features/1", part: "plate", reference: { feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }] } };

interface Harness {
  deps: ReturnType<typeof detectDeps>;
  project: FakeProject;
  service: CadTransferService;
  events: CadTransferEvent[];
  /** Behaviour of the fake Fusion add-in for the next jobs. */
  addin: { mode: "ok" | "fail" | "silent"; delayTicks: number; seen: string[] };
}

function harness(): Harness {
  const deps = detectDeps();
  const events: CadTransferEvent[] = [];
  deps.fs.dirs.add("C:\\Users\\me\\AppData\\Local\\Autodesk\\webdeploy");
  deps.fs.put("C:\\Users\\me\\AppData\\Roaming\\Autodesk\\Autodesk Fusion 360\\API\\AddIns\\ReifyExport\\ReifyExport.manifest", MANIFEST("0.1.0"));
  const refreshBeat = () => deps.fs.put(L(deps).fusionHeartbeat, JSON.stringify({
    pid: 1, app: "Fusion 2.0.1", signedIn: true, updatedAt: new Date(deps.clock.now()).toISOString(),
  }));
  refreshBeat();
  const project = new FakeProject("/work/proj", deps.fs, (r) => `\\\\wsl.localhost\\Ubuntu\\work\\proj\\${r.replace(/\//g, "\\")}`);
  const addin = { mode: "ok" as Harness["addin"]["mode"], delayTicks: 1, seen: [] as string[] };
  const waiting = new Map<string, number>();
  deps.clock.hooks.push(async () => {
    refreshBeat();
    const inbox = L(deps).fusionInbox;
    for (const name of await deps.fs.readdir(inbox)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const ticks = (waiting.get(id) ?? 0) + 1;
      waiting.set(id, ticks);
      if (ticks < addin.delayTicks || addin.mode === "silent") continue;
      addin.seen.push(id);
      const job = JSON.parse((await deps.fs.readText(`${inbox}\\${name}`))!);
      await deps.fs.rm(`${inbox}\\${name}`);
      const out = `${L(deps).fusionOutbox}\\${id}`;
      deps.fs.put(`${out}\\log.txt`, "log line");
      if (addin.mode === "fail") {
        deps.fs.put(`${out}\\result.json`, JSON.stringify({ schema: "reify.transfer.result/1", jobId: id, ok: false, target: "fusion",
          error: { code: "EXECUTOR_FAILED", message: "extrude failed", feature: "plate/base", step: "extrude" } }));
        continue;
      }
      deps.fs.put(`${out}\\${job.output.native}`, "F3D");
      deps.fs.put(`${out}\\${job.output.check_step}`, "STEP");
      deps.fs.put(`${out}\\result.json`, JSON.stringify({
        schema: "reify.transfer.result/1", jobId: id, ok: true, target: "fusion",
        executor: { name: "ReifyExport", version: "0.1.0", app: "Fusion" },
        files: { native: job.output.native, check_step: job.output.check_step, log: "log.txt" },
        features_built: 1, feature_volumes: [{ name: "plate/base", volume_mm3: 6000 }], error: null,
      }));
    }
  });
  const service = new CadTransferService({ ...deps, pid: 42, emit: (e) => events.push(e), random: () => 0.123456 });
  service.setProject(project);
  return { deps, project, service, events, addin };
}

const request = (extra: Partial<DispatchRequest> = {}): DispatchRequest => ({
  jobId: "job-1", target: "fusion", features: FEATURES, native: "exports/plate.f3d", checkStep: "build/transfer/job-1/check.step", ...extra,
});

describe("dispatcher: Fusion jobs", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it("runs a job, copies the results into the project, and writes status and result", async () => {
    const result = await h.service.runJob(request());
    expect(result).toMatchObject({ ok: true, target: "fusion", jobId: "job-1", error: null, features_built: 1 });
    expect(result.files).toEqual({ native: "exports/plate.f3d", check_step: "build/transfer/job-1/check.step", log: ".pi-cad/transfer/logs/job-1.log" });
    expect(h.project.files.get("exports/plate.f3d")).toBe("F3D");
    expect(h.project.files.get("build/transfer/job-1/check.step")).toBe("STEP");
    expect(h.project.json(".pi-cad/transfer/results/job-1.json")).toMatchObject({ schema: "reify.transfer.spool-result/1", ok: true });
    expect(h.project.json(".pi-cad/transfer/status/job-1.json")).toMatchObject({ state: "done" });
    const phases = h.events.filter((e) => e.type === "job").map((e) => e.type === "job" && e.job.state);
    expect(phases).toEqual(["queued", "running", "running", "done"]);
    const done = h.events.at(-1);
    expect(done).toMatchObject({ type: "job", job: { state: "done", native: "exports/plate.f3d", nativeFolder: "\\\\wsl.localhost\\Ubuntu\\work\\proj\\exports" } });
  });

  it("writes the job file with tmp + rename into the inbox with the protocol schema", async () => {
    let jobText = "";
    h.deps.clock.hooks.unshift(async () => {
      const text = await h.deps.fs.readText(`${L(h.deps).fusionInbox}\\job-1.json`);
      if (text) jobText = text;
    });
    await h.service.runJob(request({ timeoutS: 120 }));
    expect(JSON.parse(jobText)).toMatchObject({
      schema: "reify.transfer.job/1", jobId: "job-1", target: "fusion", check: true, timeoutS: 120,
      output: { native: "part.f3d", check_step: "check.step" }, features: { part: "plate" },
    });
  });

  it("returns EXECUTOR_FAILED with the feature name when the add-in reports an error", async () => {
    h.addin.mode = "fail";
    const result = await h.service.runJob(request());
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: "EXECUTOR_FAILED", message: "extrude failed", feature: "plate/base", step: "extrude" });
    expect(h.project.files.has("exports/plate.f3d")).toBe(false);
    expect(h.project.files.get(".pi-cad/transfer/logs/job-1.log")).toBe("log line");
    expect(h.project.json(".pi-cad/transfer/status/job-1.json").state).toBe("failed");
  });

  it("times out after job.timeoutS and removes the unread inbox file", async () => {
    h.addin.mode = "silent";
    const before = h.deps.clock.now();
    const result = await h.service.runJob(request({ timeoutS: 5 }));
    expect(result.error).toMatchObject({ code: "TIMEOUT" });
    expect(h.deps.clock.now() - before).toBeGreaterThanOrEqual(5000);
    expect(h.deps.clock.now() - before).toBeLessThan(7000);
    expect(await h.deps.fs.exists(`${L(h.deps).fusionInbox}\\job-1.json`)).toBe(false);
  });

  it("uses a 300 s default timeout", async () => {
    h.addin.mode = "silent";
    const before = h.deps.clock.now();
    const result = await h.service.runJob(request());
    expect(result.error?.code).toBe("TIMEOUT");
    expect((h.deps.clock.now() - before) / 1000).toBeGreaterThanOrEqual(300);
  });

  it("cancels a running job", async () => {
    h.addin.mode = "silent";
    let ticks = 0;
    h.deps.clock.hooks.push(() => { if (++ticks === 3) h.service.cancel("job-1"); });
    const result = await h.service.runJob(request());
    expect(result.error?.code).toBe("CANCELLED");
    expect(h.project.json(".pi-cad/transfer/status/job-1.json").state).toBe("cancelled");
  });

  it("runs one job at a time and keeps the second one queued", async () => {
    h.addin.delayTicks = 3;
    const first = h.service.runJob(request({ jobId: "job-a", native: "exports/a.f3d" }));
    const second = h.service.runJob(request({ jobId: "job-b", native: "exports/b.f3d" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.project.json(".pi-cad/transfer/status/job-b.json").state).toBe("queued");
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.addin.seen).toEqual(["job-a", "job-b"]);
    const order = h.events.filter((e) => e.type === "job").map((e) => e.type === "job" ? `${e.job.jobId}:${e.job.state}` : "");
    expect(order.indexOf("job-b:running")).toBeGreaterThan(order.indexOf("job-a:done"));
  });

  it("cancels a queued job without starting it", async () => {
    h.addin.delayTicks = 3;
    const first = h.service.runJob(request({ jobId: "job-a", native: "exports/a.f3d" }));
    const second = h.service.runJob(request({ jobId: "job-b", native: "exports/b.f3d" }));
    expect(h.service.cancel("job-b")).toBe(true);
    expect((await second).error?.code).toBe("CANCELLED");
    expect((await first).ok).toBe(true);
    expect(h.addin.seen).toEqual(["job-a"]);
    expect(h.service.cancel("unknown")).toBe(false);
  });

  it("returns TARGET_NOT_READY when the add-in does not run", async () => {
    h.deps.clock.hooks.length = 0;
    h.deps.clock.time += 60_000; // heartbeat is now stale
    const result = await h.service.runJob(request());
    expect(result.error).toMatchObject({ code: "TARGET_NOT_READY", step: "addin_not_running" });
  });

  it("rejects paths that leave the project and unsafe job ids", async () => {
    expect((await h.service.runJob(request({ native: "../evil.f3d" }))).error?.message).toMatch(/inside the project/);
    expect((await h.service.runJob(request({ native: "/etc/passwd" }))).ok).toBe(false);
    expect((await h.service.runJob(request({ jobId: "../x" }))).ok).toBe(false);
    expect((await h.service.runJob(request({ features: "../../secret.json" }))).ok).toBe(false);
  });

  it("flags a result file that the add-in listed but did not write", async () => {
    h.deps.clock.hooks.push(async () => {
      await h.deps.fs.rm(`${L(h.deps).fusionOutbox}\\job-1\\part.f3d`);
    });
    const result = await h.service.runJob(request());
    expect(result.error).toMatchObject({ code: "EXECUTOR_FAILED" });
    expect(result.error?.message).toMatch(/part\.f3d/);
  });
});

describe("dispatcher: SolidWorks jobs", () => {
  it("spawns ReifyExport.exe --job <dir> and copies results", async () => {
    const h = harness();
    h.deps.registry.keys.set("HKLM\\SOFTWARE\\SolidWorks", { values: {}, subkeys: ["SOLIDWORKS 2024"] });
    h.deps.fs.put(h.deps.bundledSolidworksExe!);
    h.deps.runner.onStart = async (args) => {
      const dir = args[1]!;
      const job = JSON.parse((await h.deps.fs.readText(`${dir}\\job.json`))!);
      h.deps.fs.put(`${dir}\\${job.output.native}`, "SLDPRT");
      h.deps.fs.put(`${dir}\\check.step`, "STEP");
      h.deps.fs.put(`${dir}\\result.json`, JSON.stringify({ ok: true, files: { native: job.output.native, check_step: "check.step" }, features_built: 1 }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await h.service.runJob({ ...request({ target: "solidworks", native: "exports/plate.SLDPRT" }) });
    expect(result.ok).toBe(true);
    expect(h.deps.runner.started[0]!.args[0]).toBe("--job");
    expect(h.deps.runner.started[0]!.args[1]).toBe(`${L(h.deps).solidworksJobs}\\job-1`);
    expect(h.project.files.get("exports/plate.SLDPRT")).toBe("SLDPRT");
  });

  it("reports EXECUTOR_FAILED when the program exits without a result, and kills it on timeout", async () => {
    const h = harness();
    h.deps.registry.keys.set("HKLM\\SOFTWARE\\SolidWorks", { values: {}, subkeys: ["SOLIDWORKS 2024"] });
    h.deps.fs.put(h.deps.bundledSolidworksExe!);
    h.deps.runner.onStart = async () => ({ code: 3, stdout: "", stderr: "COM error" });
    const crashed = await h.service.runJob(request({ target: "solidworks", native: "exports/a.SLDPRT" }));
    expect(crashed.error?.code).toBe("EXECUTOR_FAILED");
    expect(crashed.error?.message).toMatch(/code 3.*COM error/);

    h.deps.runner.onStart = () => new Promise(() => undefined);
    const hung = await h.service.runJob(request({ jobId: "job-2", target: "solidworks", native: "exports/b.SLDPRT", timeoutS: 2 }));
    expect(hung.error?.code).toBe("TIMEOUT");
    expect(h.deps.runner.started[1]!.killed).toBe(true);
  });
});

describe("spool", () => {
  it("round trip: heartbeat, request, status, result; stop marks the dispatcher unavailable", async () => {
    const h = harness();
    await h.service.start(h.project);
    const alive = evaluateDispatcherFile(h.project.files.get(".pi-cad/transfer/dispatcher.json") ?? null, h.deps.clock.now());
    expect(alive).toEqual({ alive: true, targets: { fusion: "ready", solidworks: "not_installed" } });
    expect(h.project.json(".pi-cad/transfer/dispatcher.json")).toMatchObject({ schema: "reify.transfer.dispatcher/1", pid: 42 });

    h.project.files.set(".pi-cad/transfer/features.json", JSON.stringify(FEATURES));
    h.project.files.set(".pi-cad/transfer/requests/spool-1.json", JSON.stringify({
      schema: "reify.transfer.request/1", jobId: "spool-1", target: "fusion", features: ".pi-cad/transfer/features.json",
      native: "exports/bracket.f3d", checkStep: "build/transfer/spool-1/check.step", check: true, timeoutS: 60,
    }));
    await h.service.pollSpool();
    for (let i = 0; i < 50 && !h.project.files.has(".pi-cad/transfer/results/spool-1.json"); i++) await new Promise((r) => setTimeout(r, 1));
    const result = h.project.json(".pi-cad/transfer/results/spool-1.json");
    expect(result).toMatchObject({ schema: "reify.transfer.spool-result/1", ok: true, files: { native: "exports/bracket.f3d" } });
    expect(h.project.json(".pi-cad/transfer/status/spool-1.json").state).toBe("done");
    expect(h.project.files.get("exports/bracket.f3d")).toBe("F3D");

    // The same request is not run twice.
    await h.service.pollSpool();
    expect(h.addin.seen).toEqual(["spool-1"]);

    await h.service.stop();
    const stopped = evaluateDispatcherFile(h.project.files.get(".pi-cad/transfer/dispatcher.json") ?? null, h.deps.clock.now());
    expect(stopped.alive).toBe(false);
    expect(h.project.json(".pi-cad/transfer/dispatcher.json").targets).toEqual({ fusion: "unavailable", solidworks: "unavailable" });
  });

  it("treats a missing or stale dispatcher.json as unavailable", () => {
    const now = Date.parse("2026-10-07T10:00:00Z");
    const file = (age: number) => JSON.stringify({ updatedAt: new Date(now - age * 1000).toISOString(), targets: { fusion: "ready", solidworks: "ready" } });
    expect(evaluateDispatcherFile(null, now).alive).toBe(false);
    expect(evaluateDispatcherFile(file(16), now)).toEqual({ alive: false, targets: { fusion: "unavailable", solidworks: "unavailable" } });
    expect(evaluateDispatcherFile(file(15), now).alive).toBe(true);
    expect(evaluateDispatcherFile("{oops", now).alive).toBe(false);
  });

  it("cancels through the cancel/<jobId> file", async () => {
    const h = harness();
    h.addin.mode = "silent";
    await h.service.start(h.project);
    h.project.files.set(".pi-cad/transfer/requests/spool-2.json", JSON.stringify({
      schema: "reify.transfer.request/1", jobId: "spool-2", target: "fusion", features: ".pi-cad/transfer/f.json", native: "exports/x.f3d",
    }));
    h.project.files.set(".pi-cad/transfer/f.json", JSON.stringify(FEATURES));
    let ticks = 0;
    h.deps.clock.hooks.push(async () => {
      if (++ticks === 2) { h.project.files.set(".pi-cad/transfer/cancel/spool-2", ""); await h.service.pollSpool(); }
    });
    await h.service.pollSpool();
    for (let i = 0; i < 100 && !h.project.files.has(".pi-cad/transfer/results/spool-2.json"); i++) await new Promise((r) => setTimeout(r, 1));
    expect(h.project.json(".pi-cad/transfer/results/spool-2.json").error.code).toBe("CANCELLED");
    expect(h.project.files.has(".pi-cad/transfer/cancel/spool-2")).toBe(false);
    await h.service.stop();
  });

  it("answers a bad request and a request left running by a crashed dispatcher", async () => {
    const h = harness();
    await h.service.start(h.project);
    h.project.files.set(".pi-cad/transfer/requests/bad.json", "{nope");
    h.project.files.set(".pi-cad/transfer/requests/orphan.json", JSON.stringify({
      schema: "reify.transfer.request/1", jobId: "orphan", target: "fusion", features: "f.json", native: "exports/x.f3d",
    }));
    h.project.files.set(".pi-cad/transfer/status/orphan.json", JSON.stringify({ state: "running" }));
    await h.service.pollSpool();
    for (let i = 0; i < 50 && !(h.project.files.has(".pi-cad/transfer/results/bad.json") && h.project.files.has(".pi-cad/transfer/results/orphan.json")); i++) await new Promise((r) => setTimeout(r, 1));
    expect(h.project.json(".pi-cad/transfer/results/bad.json").error.code).toBe("EXECUTOR_FAILED");
    expect(h.project.json(".pi-cad/transfer/results/orphan.json").error.message).toMatch(/restarted/);
    await h.service.stop();
  });
});

describe("status and test export", () => {
  it("caches status briefly and emits a status event on change", async () => {
    const h = harness();
    const first = await h.service.getStatus();
    expect(first.targets.fusion.state).toBe("ready");
    expect(first.dispatcherActive).toBe(false);
    expect(h.events.filter((e) => e.type === "status")).toHaveLength(1);
    await h.service.getStatus(true);
    expect(h.events.filter((e) => e.type === "status")).toHaveLength(1);
  });

  /** A stub of the real sidecar: transfer-export writes a spool request, waits for the dispatcher, answers like transfer-ops.ts. */
  function sidecar(h: Harness, service: () => CadTransferService, opts: { checkFails?: boolean; calls?: Array<Record<string, unknown>> } = {}) {
    return async (body: Record<string, unknown>) => {
      opts.calls?.push(body);
      if (body.op !== "transfer-export") return {};
      const id = String(body.jobId);
      const root = ".pi-cad/transfer";
      h.project.files.set(`build/transfer/${id}/features.json`, JSON.stringify(FEATURES));
      h.project.files.set(`${root}/requests/${id}.json`, JSON.stringify({
        schema: "reify.transfer.request/1", jobId: id, target: body.target, features: `build/transfer/${id}/features.json`,
        native: body.output ?? `exports/${String(body.doc).split("/").pop()!.replace(/\.FCStd$/i, "")}.f3d`, checkStep: `build/transfer/${id}/check.step`, check: true, timeoutS: 300,
      }));
      let result: Record<string, any> | null = null;
      for (let i = 0; i < 2000 && !result; i++) {
        await service().pollSpool();
        result = h.project.files.has(`${root}/results/${id}.json`) ? h.project.json(`${root}/results/${id}.json`) : null;
        if (!result) await new Promise((r) => setTimeout(r, 1));
      }
      h.project.files.delete(`${root}/requests/${id}.json`);
      if (!result!.ok) {
        throw Object.assign(new Error(result!.error.message), {
          code: "TRANSFER_EXECUTOR_FAILED", target: result!.error.feature, detail: { target: body.target, feature: result!.error.feature ?? null, log: result!.files?.log },
        });
      }
      if (opts.checkFails) {
        throw Object.assign(new Error("fusion built a different shape: volume differs. The first feature that differs is plate/base."), {
          code: "TRANSFER_CHECK_FAILED", target: "plate/base", detail: { log: result!.files.log },
        });
      }
      return { target: body.target, file: result!.files.native, checkStep: result!.files.check_step, check: "passed", features: 1, log: result!.files.log, detail: null };
    };
  }

  async function activeService(h: Harness, opts: Parameters<typeof sidecar>[2] = {}) {
    let service!: CadTransferService;
    service = new CadTransferService({ ...h.deps, pid: 1, emit: (e) => h.events.push(e), random: () => 0.5, agent: sidecar(h, () => service, opts) });
    await service.start(h.project);
    return service;
  }

  it("test export builds the plate and sends transfer-export with the UI job id; the final state comes from the agent", async () => {
    const h = harness();
    const calls: Array<Record<string, unknown>> = [];
    const service = await activeService(h, { calls });
    const result = await service.testExport("fusion");
    await service.stop();
    expect(result).toMatchObject({ ok: true, message: "Test export passed." });
    expect(calls.map((c) => c.op)).toEqual(["part-open", "part-apply", "transfer-export"]);
    const ops = (calls[1]!.ops as Array<{ op: string }>).map((o) => o.op);
    expect(ops).toEqual(["sketch", "pad", "sketch", "hole", "sketch", "pocket"]);
    const exportCall = calls[2]!;
    expect(exportCall).toMatchObject({ target: "fusion", check: true });
    expect(exportCall.output).toMatch(/^build\/transfer-test\/plate-\d+\.f3d$/);
    expect(String(exportCall.jobId)).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    expect(result.logPath).toBeTruthy();
    // One id for the dispatcher events and the agent: no `done` before the agent returns, then the final done.
    const states = h.events.filter((e) => e.type === "job" && e.job.jobId === exportCall.jobId).map((e) => e.type === "job" ? `${e.job.state}:${e.job.message}` : "");
    expect(states).toContain("running:Checking the shape.");
    expect(states.filter((x) => x.startsWith("done:"))).toHaveLength(1);
    expect(states.at(-1)).toMatch(/^done:Export done\. The shape check passed/);
  });

  it("surfaces TRANSFER_CHECK_FAILED with the failing feature", async () => {
    const h = harness();
    const service = await activeService(h, { checkFails: true });
    const result = await service.testExport("fusion");
    await service.stop();
    expect(result).toMatchObject({ ok: false, failedFeature: "plate/base" });
    expect(result.message).toMatch(/^TRANSFER_CHECK_FAILED/);
    expect(result.job?.error).toMatchObject({ code: "TRANSFER_CHECK_FAILED", feature: "plate/base" });
  });

  it("surfaces the executor error code and feature from the sidecar", async () => {
    const h = harness();
    h.addin.mode = "fail";
    const service = await activeService(h);
    const result = await service.testExport("fusion");
    await service.stop();
    expect(result).toMatchObject({ ok: false, failedFeature: "plate/base" });
    expect(result.job?.error).toMatchObject({ code: "TRANSFER_EXECUTOR_FAILED", message: "extrude failed", feature: "plate/base" });
  });

  it("does not run when the target is not ready", async () => {
    const h = harness();
    h.deps.clock.hooks.length = 0;
    h.deps.clock.time += 60_000;
    const service = new CadTransferService({ ...h.deps, pid: 1, agent: async () => ({}) });
    service.setProject(h.project);
    const result = await service.testExport("fusion");
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ name: "CAD program ready", ok: false });
  });

  it("startExport finds the part document and exports through the agent", async () => {
    const h = harness();
    h.project.files.set("parts/bracket.FCStd", "x");
    const calls: Array<Record<string, unknown>> = [];
    const service = await activeService(h, { calls });
    const job = service.startExport("fusion", "build/bracket.step");
    expect(job.state).toBe("queued");
    for (let i = 0; i < 2000 && !h.events.some((e) => e.type === "job" && e.job.jobId === job.jobId && e.job.state === "done" && e.job.native); i++) await new Promise((r) => setTimeout(r, 1));
    expect(calls[0]).toMatchObject({ op: "transfer-export", doc: "parts/bracket.FCStd", jobId: job.jobId, check: true });
    expect(calls[0]).not.toHaveProperty("output");
    expect(h.project.files.get("exports/bracket.f3d")).toBe("F3D");
    const missing = service.startExport("fusion", "build/unknown.step");
    for (let i = 0; i < 100 && !h.events.some((e) => e.type === "job" && e.job.jobId === missing.jobId && e.job.state === "failed"); i++) await new Promise((r) => setTimeout(r, 1));
    expect(h.events.find((e) => e.type === "job" && e.job.jobId === missing.jobId && e.job.state === "failed")).toMatchObject({ job: { message: expect.stringMatching(/cannot find the part file/) } });
    await service.stop();
  });

  it("cancel works before the sidecar has written the request", async () => {
    const h = harness();
    h.project.files.set("parts/bracket.FCStd", "x");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let service!: CadTransferService;
    const inner = sidecar(h, () => service);
    service = new CadTransferService({ ...h.deps, pid: 1, emit: (e) => h.events.push(e), agent: async (b) => { await gate; return inner(b); } });
    await service.start(h.project);
    const job = service.startExport("fusion", "build/bracket.step");
    await new Promise((r) => setTimeout(r, 5));
    expect(service.cancel(job.jobId)).toBe(true);
    expect(h.project.files.has(`.pi-cad/transfer/cancel/${job.jobId}`)).toBe(true);
    release();
    for (let i = 0; i < 2000 && !h.events.some((e) => e.type === "job" && e.job.jobId === job.jobId && e.job.state === "cancelled"); i++) await new Promise((r) => setTimeout(r, 1));
    expect(h.events.some((e) => e.type === "job" && e.job.jobId === job.jobId && e.job.state === "cancelled")).toBe(true);
    expect(h.addin.seen).toEqual([]);
    await service.stop();
  });
});

describe("assemblies (P2)", () => {
  const ASSEMBLY = { schema: "reify.assembly/1", units: "mm", name: "asm", parts: [{ ref: "parts/axle.FCStd", name: "axle", features: FEATURES }], occurrences: [] };

  it("serves a spool request with kind assembly: job.json has assembly in place of features, extras are copied", async () => {
    const h = harness();
    let jobText = "";
    h.deps.clock.hooks.unshift(async () => {
      const text = await h.deps.fs.readText(`${L(h.deps).fusionInbox}\\asm-1.json`);
      if (text) jobText = text;
    });
    // The add-in also writes extra files and lists them.
    h.deps.clock.hooks.push(async () => {
      const out = `${L(h.deps).fusionOutbox}\\asm-1`;
      const text = await h.deps.fs.readText(`${out}\\result.json`);
      if (text && !text.includes('"extra"')) {
        h.deps.fs.put(`${out}\\axle.f3d`, "AXLE");
        h.deps.fs.put(`${out}\\result.json`, JSON.stringify({ ...JSON.parse(text), files: { ...JSON.parse(text).files, extra: ["axle.f3d"] } }));
      }
    });
    await h.service.start(h.project);
    h.project.files.set("build/transfer/asm-1/assembly.json", JSON.stringify(ASSEMBLY));
    h.project.files.set(".pi-cad/transfer/requests/asm-1.json", JSON.stringify({
      schema: "reify.transfer.request/1", jobId: "asm-1", target: "fusion", kind: "assembly", assembly: "build/transfer/asm-1/assembly.json",
      native: "exports/asm.f3d", checkStep: "build/transfer/asm-1/check.step", check: true,
    }));
    await h.service.pollSpool();
    for (let i = 0; i < 100 && !h.project.files.has(".pi-cad/transfer/results/asm-1.json"); i++) await new Promise((r) => setTimeout(r, 1));
    await h.service.stop();
    const job = JSON.parse(jobText);
    expect(job).toMatchObject({ kind: "assembly", assembly: { schema: "reify.assembly/1" } });
    expect(job.features).toBeUndefined();
    const result = h.project.json(".pi-cad/transfer/results/asm-1.json");
    expect(result.ok).toBe(true);
    expect(result.files.extra).toEqual(["exports/axle.f3d"]);
    expect(h.project.files.get("exports/axle.f3d")).toBe("AXLE");
  });

  it("part jobs keep their old job.json shape (features, no kind)", async () => {
    const h = harness();
    let jobText = "";
    h.deps.clock.hooks.unshift(async () => { jobText ||= (await h.deps.fs.readText(`${L(h.deps).fusionInbox}\\job-1.json`)) ?? ""; });
    await h.service.runJob(request());
    const job = JSON.parse(jobText);
    expect(job.kind).toBeUndefined();
    expect(job.features).toBeDefined();
  });

  it("rejects bad assembly paths and bad extra file names", async () => {
    const h = harness();
    expect((await h.service.runJob({ jobId: "a1", target: "fusion", kind: "assembly", assembly: "../x.json", native: "exports/a.f3d" })).ok).toBe(false);
    expect((await h.service.runJob({ jobId: "a2", target: "fusion", kind: "assembly", native: "exports/a.f3d" })).error?.message).toMatch(/no assembly/);
    h.deps.clock.hooks.push(async () => {
      const out = `${L(h.deps).fusionOutbox}\\a3`;
      const text = await h.deps.fs.readText(`${out}\\result.json`);
      if (text) h.deps.fs.put(`${out}\\result.json`, JSON.stringify({ ...JSON.parse(text), files: { ...JSON.parse(text).files, extra: ["..\\evil"] } }));
    });
    const bad = await h.service.runJob({ jobId: "a3", target: "fusion", kind: "assembly", assembly: ASSEMBLY, native: "exports/a.f3d" });
    expect(bad.error?.message).toMatch(/bad name/);
  });

  it("startExport accepts assembly documents, sends no output, and shows the file from the answer", async () => {
    const h = harness();
    h.project.files.set("assembly/gearbox.FCStd", "x");
    const calls: Array<Record<string, unknown>> = [];
    const service = new CadTransferService({
      ...h.deps, pid: 1, emit: (e) => h.events.push(e),
      agent: async (b) => { calls.push(b); return { file: "exports/gearbox.SLDASM", check: "passed" }; },
    });
    service.setProject(h.project);
    const job = service.startExport("solidworks", "build/gearbox.step");
    service.startExport("fusion", "assembly/gearbox.FCStd");
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
    expect(calls.map((c) => [c.target, c.doc])).toEqual(expect.arrayContaining([
      ["solidworks", "assembly/gearbox.FCStd"], ["fusion", "assembly/gearbox.FCStd"],
    ]));
    for (const call of calls) expect(call).not.toHaveProperty("output");
    for (let i = 0; i < 100 && !h.events.some((e) => e.type === "job" && e.job.jobId === job.jobId && e.job.state === "done"); i++) await new Promise((r) => setTimeout(r, 1));
    expect(h.events.find((e) => e.type === "job" && e.job.jobId === job.jobId && e.job.state === "done")).toMatchObject({ job: { native: "exports/gearbox.SLDASM" } });
  });
});

describe("WSL project", () => {
  it("converts paths with wslpath through the bridge and copies results into the distro", async () => {
    const calls: string[][] = [];
    const bridge = {
      kind: "wsl" as const,
      async exec(args: string[]) {
        calls.push(args);
        if (args[0] === "wslpath") return { stdout: "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\exports\r\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
      async pipe(args: string[], input: string) { calls.push([...args, input]); return { stdout: "", stderr: "" }; },
      async toRuntimePath(value: string) { return value.replace(/^C:\\/, "/mnt/c/").replaceAll("\\", "/"); },
    };
    const io = new BridgeProjectIO(bridge, "/home/me/proj");
    await io.copyIn("C:\\Users\\me\\AppData\\Local\\Reify\\transfer\\fusion\\outbox\\j\\part.f3d", "exports/plate.f3d");
    const copy = calls.at(-1)!;
    // wsl.exe re-parses argv, so the paths are quoted into the script, never passed as $1/$2.
    expect(copy.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(copy[2]).toContain("cp -f -- '/mnt/c/Users/me/AppData/Local/Reify/transfer/fusion/outbox/j/part.f3d' '/home/me/proj/exports/plate.f3d.tmp'");
    expect(copy[2]).not.toContain("$1");
    expect(await io.toHostPath("exports")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\exports");
    expect(calls.at(-1)).toEqual(["wslpath", "-w", "/home/me/proj/exports"]);
    await io.writeTextAtomic(".pi-cad/transfer/dispatcher.json", "{}");
    const write = calls.at(-1)!;
    expect(write.at(-1)).toBe("{}");
    expect(write[2]).toContain("mv -f -- '/home/me/proj/.pi-cad/transfer/dispatcher.json.tmp' '/home/me/proj/.pi-cad/transfer/dispatcher.json'");
    expect(write[2]).not.toContain("$1");
  });

  it("returns null for a missing file and an empty list for a missing folder", async () => {
    const bridge = {
      kind: "wsl" as const,
      async exec(): Promise<{ stdout: string; stderr: string }> { throw new Error("exit 3"); },
      async pipe() { return { stdout: "", stderr: "" }; },
      async toRuntimePath(v: string) { return v; },
    };
    const io = new BridgeProjectIO(bridge, "/p");
    expect(await io.readText("a")).toBeNull();
    expect(await io.readdir("b")).toEqual([]);
    expect(await io.exists("c")).toBe(false);
  });
});
