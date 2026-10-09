/**
 * Paths and injectable host services of the CAD transfer dispatcher.
 * Nothing here imports Electron, so tests run without a real machine.
 */
import { posix, win32 } from "node:path";

export type HostPlatform = NodeJS.Platform;

export interface HostFs {
  exists(path: string): Promise<boolean>;
  /** Text of the file, or null when the file is missing or unreadable. */
  readText(path: string): Promise<string | null>;
  /** mkdir -p, write `<path>.tmp`, rename. */
  writeTextAtomic(path: string, text: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rm(path: string): Promise<void>;
  /** Copy a file or a directory tree. Replaces the target. */
  cp(source: string, target: string): Promise<void>;
}

export interface RegistryKey { values: Record<string, string>; subkeys: string[] }
export interface RegistryReader {
  /** null when the key does not exist. */
  read(key: string): Promise<RegistryKey | null>;
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean }
export interface RunningProcess { done: Promise<RunResult>; kill(): void }
export interface ProcessRunner {
  run(exe: string, args: string[], options?: { timeoutMs?: number }): Promise<RunResult>;
  start(exe: string, args: string[]): RunningProcess;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The project folder. It is a native folder or a folder inside WSL. */
export interface ProjectIO {
  /** Project root in runtime path form (POSIX). */
  readonly root: string;
  readText(relative: string): Promise<string | null>;
  writeTextAtomic(relative: string, text: string): Promise<void>;
  readdir(relative: string): Promise<string[]>;
  exists(relative: string): Promise<boolean>;
  remove(relative: string): Promise<void>;
  /** Copy a host file into the project. */
  copyIn(hostFile: string, relative: string): Promise<void>;
  /** Host path (Windows form in WSL setups) of a project path. */
  toHostPath(relative: string): Promise<string>;
  /** Spool polling interval. Remote projects poll less often to spare the gateway. */
  readonly spoolPollMs?: number;
}

export interface HostEnvironment {
  platform: HostPlatform;
  env: Record<string, string | undefined>;
  home: string;
  /** The Electron app itself runs inside WSL (Linux build under WSLg). */
  insideWsl: boolean;
}

export function hostPath(platform: HostPlatform) {
  return platform === "win32" ? win32 : posix;
}

export function jobRootFor(host: HostEnvironment): string {
  const p = hostPath(host.platform);
  if (host.platform === "win32") return p.join(host.env.LOCALAPPDATA || p.join(host.home, "AppData", "Local"), "Reify", "transfer");
  if (host.platform === "darwin") return p.join(host.home, "Library", "Application Support", "Reify", "transfer");
  return p.join(host.env.XDG_DATA_HOME || p.join(host.home, ".local", "share"), "Reify", "transfer");
}

export function fusionAddinsDir(host: HostEnvironment): string | null {
  const p = hostPath(host.platform);
  if (host.platform === "win32") {
    return p.join(host.env.APPDATA || p.join(host.home, "AppData", "Roaming"), "Autodesk", "Autodesk Fusion 360", "API", "AddIns");
  }
  if (host.platform === "darwin") {
    return p.join(host.home, "Library", "Application Support", "Autodesk", "Autodesk Fusion 360", "API", "AddIns");
  }
  return null;
}

export const FUSION_ADDIN_NAME = "ReifyExport";
export const FUSION_MANIFEST_NAME = "ReifyExport.manifest";
export const SOLIDWORKS_EXECUTOR_NAME = "ReifyExport.exe";
/** Oldest SolidWorks major version the executor supports. */
export const SOLIDWORKS_MINIMUM_VERSION = 2022;
/** Heartbeat and dispatcher files older than this many seconds count as stale. */
export const HEARTBEAT_MAX_AGE_S = 15;

export const SPOOL_DIR = ".pi-cad/transfer";

export interface TransferLayout {
  jobRoot: string;
  fusionDir: string;
  fusionHeartbeat: string;
  fusionInbox: string;
  fusionOutbox: string;
  solidworksJobs: string;
}

export function layoutFor(host: HostEnvironment): TransferLayout {
  const p = hostPath(host.platform);
  const jobRoot = jobRootFor(host);
  const fusionDir = p.join(jobRoot, "fusion");
  return {
    jobRoot,
    fusionDir,
    fusionHeartbeat: p.join(fusionDir, "heartbeat.json"),
    fusionInbox: p.join(fusionDir, "inbox"),
    fusionOutbox: p.join(fusionDir, "outbox"),
    solidworksJobs: p.join(jobRoot, "solidworks", "jobs"),
  };
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function isSafeJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID.test(value);
}

/** A project-relative POSIX path that stays inside the project. */
export function isProjectRelative(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").some((part) => part === ".." || part === "");
}

export function newJobId(now: number, random: () => number = Math.random): string {
  const d = new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 8);
  return `${d}-${Math.floor(random() * 0xffffff).toString(16).padStart(6, "0")}`;
}
