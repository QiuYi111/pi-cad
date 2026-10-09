import {
  FUSION_ADDIN_NAME, FUSION_MANIFEST_NAME, HEARTBEAT_MAX_AGE_S, SOLIDWORKS_EXECUTOR_NAME, SOLIDWORKS_MINIMUM_VERSION,
  fusionAddinsDir, hostPath, layoutFor,
  type Clock, type HostEnvironment, type HostFs, type ProcessRunner, type RegistryReader,
} from "./cad-transfer-paths.js";
import { SOLIDWORKS_GUIDE, STATE_TEXT } from "../../src/shared/cad-transfer-guide.js";
import type { CadTransferState, CadTransferTargetStatus } from "../../src/shared/contracts.js";

export interface DetectDeps {
  host: HostEnvironment;
  fs: HostFs;
  registry: RegistryReader;
  runner: ProcessRunner;
  clock: Clock;
  /** Bundled add-in folder (holds ReifyExport.manifest). */
  bundledFusionAddin: string | null;
  /** Bundled SolidWorks executor exe. */
  bundledSolidworksExe: string | null;
  /** The project lives in WSL (runtime bridge kind "wsl"). */
  projectInWsl: boolean;
}

function make(
  target: "fusion" | "solidworks", state: CadTransferState, extra: Partial<CadTransferTargetStatus> = {},
): CadTransferTargetStatus {
  return { target, state, visible: true, detail: STATE_TEXT[target][state], ...extra };
}

export function manifestVersion(text: string | null): string | null {
  if (!text) return null;
  try {
    const value = (JSON.parse(text) as { version?: unknown }).version;
    return typeof value === "string" && value ? value : null;
  } catch { return null; }
}

export async function bundledAddinVersion(deps: Pick<DetectDeps, "fs" | "host" | "bundledFusionAddin">): Promise<string | null> {
  if (!deps.bundledFusionAddin) return null;
  const p = hostPath(deps.host.platform);
  return manifestVersion(await deps.fs.readText(p.join(deps.bundledFusionAddin, FUSION_MANIFEST_NAME)));
}

export async function installedAddinVersion(deps: Pick<DetectDeps, "fs" | "host">): Promise<string | null | "unreadable"> {
  const dir = fusionAddinsDir(deps.host);
  if (!dir) return null;
  const p = hostPath(deps.host.platform);
  const folder = p.join(dir, FUSION_ADDIN_NAME);
  if (!(await deps.fs.exists(folder))) return null;
  return manifestVersion(await deps.fs.readText(p.join(folder, FUSION_MANIFEST_NAME))) ?? "unreadable";
}

async function fusionInstalled(deps: DetectDeps): Promise<boolean> {
  const { host, fs } = deps;
  const p = hostPath(host.platform);
  if (host.platform === "win32") {
    return fs.exists(p.join(host.env.LOCALAPPDATA || p.join(host.home, "AppData", "Local"), "Autodesk", "webdeploy"));
  }
  if (host.platform === "darwin") {
    for (const root of ["/Applications", p.join(host.home, "Applications")]) {
      for (const name of ["Autodesk Fusion.app", "Autodesk Fusion 360.app"]) {
        if (await fs.exists(p.join(root, name))) return true;
      }
    }
  }
  return false;
}

export async function detectFusion(deps: DetectDeps): Promise<CadTransferTargetStatus> {
  const { host, fs, clock } = deps;
  if (host.platform !== "win32" && host.platform !== "darwin") {
    return make("fusion", "unsupported_platform", { detail: "Fusion exports work on Windows and macOS only." });
  }
  const layout = layoutFor(host);
  const bundled = await bundledAddinVersion(deps);
  const installed = await installedAddinVersion(deps);
  const heartbeatText = await fs.readText(layout.fusionHeartbeat);
  let heartbeat: { updatedAt?: string; app?: string; signedIn?: boolean } | null = null;
  try { heartbeat = heartbeatText ? JSON.parse(heartbeatText) : null; } catch { heartbeat = null; }
  const updated = heartbeat?.updatedAt ? Date.parse(heartbeat.updatedAt) : NaN;
  const age = Number.isFinite(updated) ? Math.max(0, (clock.now() - updated) / 1000) : undefined;
  const fresh = age !== undefined && age <= HEARTBEAT_MAX_AGE_S;
  const installedVersion = installed && installed !== "unreadable" ? installed : undefined;
  const common: Partial<CadTransferTargetStatus> = {
    ...(installedVersion ? { addinInstalledVersion: installedVersion } : {}),
    ...(bundled ? { addinBundledVersion: bundled } : {}),
    ...(bundled && installedVersion && bundled !== installedVersion ? { updateAvailable: true } : {}),
    ...(age !== undefined ? { heartbeatAgeS: Math.round(age) } : {}),
    ...(heartbeat?.app ? { appVersion: heartbeat.app } : {}),
    ...(heartbeat?.signedIn !== undefined ? { signedIn: heartbeat.signedIn } : {}),
  };
  // A fresh heartbeat proves Fusion and the add-in exist, even when Fusion lives in an unusual place.
  if (!fresh && !(await fusionInstalled(deps))) return make("fusion", "not_installed", common);
  if (!fresh && installed === null) return make("fusion", "addin_missing", common);
  if (!fresh) {
    return make("fusion", "addin_not_running", {
      ...common,
      ...(common.updateAvailable ? { note: "A newer add-in is available. Click Update add-in." } : {}),
    });
  }
  const notes = [
    common.updateAvailable ? "A newer add-in is available. Click Update add-in." : "",
    heartbeat?.signedIn === false ? "Fusion is not signed in. Sign in to Fusion." : "",
  ].filter(Boolean).join(" ");
  return make("fusion", "ready", { ...common, ...(notes ? { note: notes } : {}) });
}

/** "SldWorks.Application.32" gives revision 32. SolidWorks 2024 has revision 32. */
export function solidworksYearFromProgId(value: string | undefined): number | null {
  const match = value?.match(/(\d+)\s*$/);
  if (!match) return null;
  const revision = Number(match[1]);
  return revision >= 20 && revision < 100 ? 1992 + revision : null;
}

export async function detectSolidworks(deps: DetectDeps): Promise<CadTransferTargetStatus> {
  const { host, registry, runner, fs } = deps;
  if (host.platform !== "win32") {
    const wslOnly = host.insideWsl;
    return make("solidworks", "unsupported_platform", {
      visible: wslOnly,
      ...(wslOnly ? { note: SOLIDWORKS_GUIDE.wslOnlyNote } : {}),
    });
  }
  const note = deps.projectInWsl ? SOLIDWORKS_GUIDE.wslNote : undefined;
  const base = { minimumVersion: SOLIDWORKS_MINIMUM_VERSION, ...(note ? { note } : {}) };
  const root = await registry.read("HKLM\\SOFTWARE\\SolidWorks");
  const progId = await registry.read("HKLM\\SOFTWARE\\Classes\\SldWorks.Application");
  if (!root && !progId) return make("solidworks", "not_installed", base);
  const curVer = await registry.read("HKLM\\SOFTWARE\\Classes\\SldWorks.Application\\CurVer");
  let year = solidworksYearFromProgId(curVer?.values[""] ?? curVer?.values["(Default)"]);
  for (const name of root?.subkeys ?? []) {
    const match = name.match(/SOLIDWORKS\s+(\d{4})\b/i);
    if (match) year = Math.max(year ?? 0, Number(match[1]));
  }
  const version = year ? `SolidWorks ${year}` : undefined;
  if (year !== null && year < SOLIDWORKS_MINIMUM_VERSION) {
    return make("solidworks", "not_installed", {
      ...base, ...(version ? { appVersion: version } : {}),
      detail: `${version} is too old. Install SolidWorks ${SOLIDWORKS_MINIMUM_VERSION} or newer.`,
    });
  }
  const exe = deps.bundledSolidworksExe;
  if (!exe || !(await fs.exists(exe))) {
    return make("solidworks", "executor_missing", { ...base, ...(version ? { appVersion: version } : {}) });
  }
  const probe = await runner.run(exe, ["--version"], { timeoutMs: 10_000 }).catch(() => null);
  if (!probe || probe.code !== 0) {
    return make("solidworks", "executor_missing", {
      ...base, ...(version ? { appVersion: version } : {}),
      detail: "The export program does not start. Install Reify again.",
    });
  }
  const executorVersion = probe.stdout.trim().split(/\r?\n/)[0]?.trim() || undefined;
  return make("solidworks", "ready", {
    ...base, ...(version ? { appVersion: version } : {}), ...(executorVersion ? { executorVersion } : {}),
  });
}
