import { describe, expect, it } from "vitest";
import { detectFusion, detectSolidworks, solidworksYearFromProgId } from "../electron/main/cad-transfer-detect";
import { installFusionAddin } from "../electron/main/cad-transfer-install";
import { parseRegQuery } from "../electron/main/cad-transfer-node";
import { layoutFor } from "../electron/main/cad-transfer-paths";
import { LINUX, MAC, MANIFEST, WIN, detectDeps } from "./helpers/cad-transfer-fakes";

const ADDIN = "C:\\Users\\me\\AppData\\Roaming\\Autodesk\\Autodesk Fusion 360\\API\\AddIns\\ReifyExport";
const BUNDLE = "C:\\Program Files\\Reify\\resources\\executors\\fusion\\ReifyExport";

function beat(deps: ReturnType<typeof detectDeps>, ageS: number, extra: object = {}) {
  deps.fs.put(layoutFor(deps.host).fusionHeartbeat, JSON.stringify({
    pid: 1, version: "0.1.0", app: "Fusion 2.0.1", signedIn: true, updatedAt: new Date(deps.clock.now() - ageS * 1000).toISOString(), ...extra,
  }));
}

describe("Fusion detection", () => {
  it("reports unsupported_platform on Linux", async () => {
    expect((await detectFusion(detectDeps({ host: LINUX }))).state).toBe("unsupported_platform");
  });
  it("reports not_installed without webdeploy", async () => {
    expect((await detectFusion(detectDeps())).state).toBe("not_installed");
  });
  it("reports addin_missing when Fusion exists and the add-in folder does not", async () => {
    const deps = detectDeps();
    deps.fs.dirs.add("C:\\Users\\me\\AppData\\Local\\Autodesk\\webdeploy");
    deps.fs.put(`${BUNDLE}\\ReifyExport.manifest`, MANIFEST("0.1.0"));
    const status = await detectFusion(deps);
    expect(status.state).toBe("addin_missing");
    expect(status.addinBundledVersion).toBe("0.1.0");
  });
  it("reports addin_not_running for a stale heartbeat", async () => {
    const deps = detectDeps();
    deps.fs.dirs.add("C:\\Users\\me\\AppData\\Local\\Autodesk\\webdeploy");
    deps.fs.put(`${ADDIN}\\ReifyExport.manifest`, MANIFEST("0.1.0"));
    beat(deps, 16);
    const status = await detectFusion(deps);
    expect(status.state).toBe("addin_not_running");
    expect(status.addinInstalledVersion).toBe("0.1.0");
  });
  it("reports ready for a heartbeat of 15 s or less", async () => {
    const deps = detectDeps();
    deps.fs.dirs.add("C:\\Users\\me\\AppData\\Local\\Autodesk\\webdeploy");
    deps.fs.put(`${ADDIN}\\ReifyExport.manifest`, MANIFEST("0.1.0"));
    beat(deps, 15);
    const status = await detectFusion(deps);
    expect(status.state).toBe("ready");
    expect(status.appVersion).toBe("Fusion 2.0.1");
  });
  it("flags an update when the installed version differs from the bundled one", async () => {
    const deps = detectDeps();
    deps.fs.dirs.add("C:\\Users\\me\\AppData\\Local\\Autodesk\\webdeploy");
    deps.fs.put(`${ADDIN}\\ReifyExport.manifest`, MANIFEST("0.1.0"));
    deps.fs.put(`${BUNDLE}\\ReifyExport.manifest`, MANIFEST("0.2.0"));
    beat(deps, 1);
    const status = await detectFusion(deps);
    expect(status).toMatchObject({ state: "ready", updateAvailable: true, addinInstalledVersion: "0.1.0", addinBundledVersion: "0.2.0" });
  });
  it("finds the macOS app and add-in folder", async () => {
    const deps = detectDeps({ host: MAC });
    expect((await detectFusion(deps)).state).toBe("not_installed");
    deps.fs.dirs.add("/Applications/Autodesk Fusion.app");
    expect((await detectFusion(deps)).state).toBe("addin_missing");
    deps.fs.put("/Users/me/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/ReifyExport/ReifyExport.manifest", MANIFEST("0.1.0"));
    expect((await detectFusion(deps)).state).toBe("addin_not_running");
  });
});

describe("SolidWorks detection", () => {
  const withSolidworks = (deps: ReturnType<typeof detectDeps>, curVer = "SldWorks.Application.32") => {
    deps.registry.keys.set("HKLM\\SOFTWARE\\SolidWorks", { values: {}, subkeys: ["SOLIDWORKS 2024"] });
    deps.registry.keys.set("HKLM\\SOFTWARE\\Classes\\SldWorks.Application", { values: { "": "SldWorks Application" }, subkeys: ["CurVer"] });
    deps.registry.keys.set("HKLM\\SOFTWARE\\Classes\\SldWorks.Application\\CurVer", { values: { "": curVer }, subkeys: [] });
  };
  it("is hidden on macOS and Linux", async () => {
    for (const host of [MAC, LINUX]) {
      const status = await detectSolidworks(detectDeps({ host }));
      expect(status).toMatchObject({ state: "unsupported_platform", visible: false });
    }
  });
  it("shows a note when the app runs inside WSL", async () => {
    const status = await detectSolidworks(detectDeps({ host: { ...LINUX, insideWsl: true } }));
    expect(status).toMatchObject({ state: "unsupported_platform", visible: true });
    expect(status.note).toMatch(/WSL/);
  });
  it("reports not_installed without registry keys", async () => {
    expect((await detectSolidworks(detectDeps())).state).toBe("not_installed");
  });
  it("rejects a version older than 2022", async () => {
    const deps = detectDeps();
    deps.registry.keys.set("HKLM\\SOFTWARE\\SolidWorks", { values: {}, subkeys: ["SOLIDWORKS 2021"] });
    const status = await detectSolidworks(deps);
    expect(status.state).toBe("not_installed");
    expect(status.detail).toMatch(/2021/);
  });
  it("reports executor_missing when the exe is absent or does not run", async () => {
    const deps = detectDeps();
    withSolidworks(deps);
    expect((await detectSolidworks(deps)).state).toBe("executor_missing");
    deps.fs.put(deps.bundledSolidworksExe!);
    deps.runner.versionResult = { code: 1, stdout: "", stderr: "boom" };
    expect((await detectSolidworks(deps)).state).toBe("executor_missing");
  });
  it("reports ready with the SolidWorks year and executor version", async () => {
    const deps = detectDeps({ projectInWsl: true });
    withSolidworks(deps);
    deps.fs.put(deps.bundledSolidworksExe!);
    const status = await detectSolidworks(deps);
    expect(status).toMatchObject({ state: "ready", appVersion: "SolidWorks 2024", executorVersion: "ReifyExport 0.1.0" });
    expect(status.note).toMatch(/WSL/);
  });
  it("maps ProgID revisions to years", () => {
    expect(solidworksYearFromProgId("SldWorks.Application.30")).toBe(2022);
    expect(solidworksYearFromProgId("SldWorks.Application.32")).toBe(2024);
    expect(solidworksYearFromProgId(undefined)).toBeNull();
  });
  it("parses reg.exe output", () => {
    const out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\SolidWorks\r\n    Foo    REG_SZ    bar\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\SolidWorks\\SOLIDWORKS 2024\r\n";
    expect(parseRegQuery("HKLM\\SOFTWARE\\SolidWorks".replace("HKLM", "HKEY_LOCAL_MACHINE"), out)).toEqual({ values: { Foo: "bar" }, subkeys: ["SOLIDWORKS 2024"] });
  });
});

describe("Fusion add-in install", () => {
  it("copies the bundled add-in and reports the version", async () => {
    const deps = detectDeps();
    deps.fs.put(`${BUNDLE}\\ReifyExport.manifest`, MANIFEST("0.2.0"));
    deps.fs.put(`${BUNDLE}\\ReifyExport.py`, "print(1)");
    const result = await installFusionAddin(deps);
    expect(result).toMatchObject({ version: "0.2.0", folder: ADDIN, replacedVersion: null });
    expect(await deps.fs.readText(`${ADDIN}\\ReifyExport.py`)).toBe("print(1)");
  });
  it("updates an older add-in and removes stale files", async () => {
    const deps = detectDeps();
    deps.fs.put(`${ADDIN}\\ReifyExport.manifest`, MANIFEST("0.1.0"));
    deps.fs.put(`${ADDIN}\\old.py`, "stale");
    deps.fs.put(`${BUNDLE}\\ReifyExport.manifest`, MANIFEST("0.2.0"));
    const result = await installFusionAddin(deps);
    expect(result).toMatchObject({ version: "0.2.0", replacedVersion: "0.1.0" });
    expect(await deps.fs.exists(`${ADDIN}\\old.py`)).toBe(false);
  });
  it("fails clearly when the bundle is missing or the platform has no Fusion", async () => {
    await expect(installFusionAddin(detectDeps())).rejects.toThrow(/Install Reify again/);
    await expect(installFusionAddin(detectDeps({ host: LINUX }))).rejects.toThrow(/Windows and macOS/);
  });
});
