import { beforeEach, describe, expect, it } from "vitest";
import { CadTransferService, evaluateDispatcherFile, firstVolumeMismatch, type DispatchRequest } from "../electron/main/cad-transfer";
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
    await h.service.pollSpool();
    for (let i = 0; i < 20 && !h.service["jobs"].has("spool-2"); i++) await new Promise((r) => setTimeout(r, 1));
    h.project.files.set(".pi-cad/transfer/cancel/spool-2", "");
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

  it("builds the reference plate, exports it, and checks the feature volumes", async () => {
    const h = harness();
    const calls: Array<Record<string, unknown>> = [];
    const service = new CadTransferService({
      ...h.deps, pid: 1, emit: () => undefined, random: () => 0.5,
      agent: async (body) => {
        calls.push(body);
        if (body.op === "transfer-features") return { features: FEATURES };
        return {};
      },
    });
    service.setProject(h.project);
    const result = await service.testExport("fusion");
    expect(result).toMatchObject({ ok: true, message: "Test export passed." });
    expect(calls.map((c) => c.op)).toEqual(["part-open", "part-apply", "transfer-features"]);
    const ops = (calls[1]!.ops as Array<{ op: string }>).map((o) => o.op);
    expect(ops).toEqual(["sketch", "pad", "sketch", "hole", "sketch", "pocket"]);
    expect(result.logPath).toMatch(/log\.txt$/);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it("fails the test with the feature name when volumes differ or the export fails", async () => {
    const h = harness();
    const agent = async (body: Record<string, unknown>) => body.op === "transfer-features"
      ? { features: { ...FEATURES, reference: { feature_volumes: [{ name: "plate/base", volume_mm3: 5000 }] } } } : {};
    const service = new CadTransferService({ ...h.deps, pid: 1, agent });
    service.setProject(h.project);
    expect(await service.testExport("fusion")).toMatchObject({ ok: false, failedFeature: "plate/base" });
    h.addin.mode = "fail";
    expect(await service.testExport("fusion")).toMatchObject({ ok: false, failedFeature: "plate/base", message: "extrude failed" });
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

  it("startExport finds the part document, asks for features, and queues the job", async () => {
    const h = harness();
    h.project.files.set("parts/bracket.FCStd", "x");
    const service = new CadTransferService({
      ...h.deps, pid: 1, emit: (e) => h.events.push(e), agent: async (b) => b.op === "transfer-features" ? { features: FEATURES } : {},
    });
    service.setProject(h.project);
    const job = service.startExport("fusion", "build/bracket.step");
    expect(job.state).toBe("queued");
    for (let i = 0; i < 100 && !h.events.some((e) => e.type === "job" && e.job.state === "done"); i++) await new Promise((r) => setTimeout(r, 1));
    expect(h.project.files.get("exports/bracket.f3d")).toBe("F3D");
    const missing = service.startExport("fusion", "build/unknown.step");
    for (let i = 0; i < 50 && !h.events.some((e) => e.type === "job" && e.job.jobId === missing.jobId && e.job.state === "failed"); i++) await new Promise((r) => setTimeout(r, 1));
    expect(h.events.find((e) => e.type === "job" && e.job.jobId === missing.jobId && e.job.state === "failed")).toMatchObject({ job: { message: expect.stringMatching(/cannot find the part file/) } });
  });

  it("finds the first volume mismatch", () => {
    const result = { feature_volumes: [{ name: "a", volume_mm3: 1 }, { name: "b", volume_mm3: 2.1 }] } as never;
    expect(firstVolumeMismatch({ reference: { feature_volumes: [{ name: "a", volume_mm3: 1 }, { name: "b", volume_mm3: 2 }] } }, result)).toBe("b");
    expect(firstVolumeMismatch({}, result)).toBeNull();
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
    expect(copy.slice(-2)).toEqual(["/mnt/c/Users/me/AppData/Local/Reify/transfer/fusion/outbox/j/part.f3d", "/home/me/proj/exports/plate.f3d"]);
    expect(await io.toHostPath("exports")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\exports");
    expect(calls.at(-1)).toEqual(["wslpath", "-w", "/home/me/proj/exports"]);
    await io.writeTextAtomic(".pi-cad/transfer/dispatcher.json", "{}");
    expect(calls.at(-1)!.slice(-2)).toEqual(["/home/me/proj/.pi-cad/transfer/dispatcher.json", "{}"]);
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
