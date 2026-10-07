import { win32, posix } from "node:path";
import type {
  Clock, HostEnvironment, HostFs, ProcessRunner, ProjectIO, RegistryKey, RegistryReader, RunningProcess, RunResult,
} from "../../electron/main/cad-transfer-paths";
import type { DetectDeps } from "../../electron/main/cad-transfer-detect";

export const WIN: HostEnvironment = {
  platform: "win32", home: "C:\\Users\\me", insideWsl: false,
  env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
};
export const MAC: HostEnvironment = { platform: "darwin", home: "/Users/me", env: {}, insideWsl: false };
export const LINUX: HostEnvironment = { platform: "linux", home: "/home/me", env: {}, insideWsl: false };

/** In-memory file system. Keys use the separator of the platform. */
export class FakeFs implements HostFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  constructor(private readonly sep: "\\" | "/" = "\\") {}
  private get path() { return this.sep === "\\" ? win32 : posix; }
  private parents(path: string) {
    let p = this.path.dirname(path);
    while (p && p !== this.path.dirname(p)) { this.dirs.add(p); p = this.path.dirname(p); }
  }
  put(path: string, text = "") { this.files.set(path, text); this.parents(path); }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path); }
  async readText(path: string) { return this.files.get(path) ?? null; }
  async writeTextAtomic(path: string, text: string) { this.put(path, text); }
  async mkdirp(path: string) { this.dirs.add(path); this.parents(path); }
  async readdir(path: string) {
    const names = new Set<string>();
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (key.startsWith(path + this.sep)) names.add(key.slice(path.length + 1).split(this.sep)[0]!);
    }
    return [...names];
  }
  async rm(path: string) {
    for (const key of [...this.files.keys()]) if (key === path || key.startsWith(path + this.sep)) this.files.delete(key);
    for (const key of [...this.dirs]) if (key === path || key.startsWith(path + this.sep)) this.dirs.delete(key);
  }
  async cp(source: string, target: string) {
    for (const [key, value] of [...this.files]) {
      if (key === source || key.startsWith(source + this.sep)) this.put(target + key.slice(source.length), value);
    }
    this.dirs.add(target);
  }
}

export class FakeRegistry implements RegistryReader {
  keys = new Map<string, RegistryKey>();
  async read(key: string) { return this.keys.get(key) ?? null; }
}

/** Clock whose sleep moves time forward at once and runs tick hooks (fake executors). */
export class FakeClock implements Clock {
  time = Date.parse("2026-10-07T10:00:00Z");
  hooks: Array<() => Promise<void> | void> = [];
  now() { return this.time; }
  async sleep(ms: number) {
    this.time += ms;
    for (const hook of this.hooks) await hook();
    await Promise.resolve();
  }
}

export class FakeRunner implements ProcessRunner {
  versionResult: RunResult = { code: 0, stdout: "ReifyExport 0.1.0\n", stderr: "" };
  started: Array<{ exe: string; args: string[]; killed: boolean }> = [];
  /** Called when a job process starts; returns when the process should end. */
  onStart: (args: string[], record: { killed: boolean }) => Promise<RunResult> = async () => ({ code: 0, stdout: "", stderr: "" });
  async run(_exe: string, args: string[]) { return args[0] === "--version" ? this.versionResult : { code: 0, stdout: "", stderr: "" }; }
  start(exe: string, args: string[]): RunningProcess {
    const record = { exe, args, killed: false };
    this.started.push(record);
    const done = this.onStart(args, record);
    return { done, kill: () => { record.killed = true; } };
  }
}

/** Project folder in memory. Host files are read from `host` when copied in. */
export class FakeProject implements ProjectIO {
  files = new Map<string, string>();
  copies: Array<{ from: string; to: string }> = [];
  constructor(readonly root: string, private readonly host: FakeFs, private readonly hostPathOf: (relative: string) => string = (r) => `${root}/${r}`) {}
  async readText(relative: string) { return this.files.get(relative) ?? null; }
  async writeTextAtomic(relative: string, text: string) { this.files.set(relative, text); }
  async readdir(relative: string) {
    const names = new Set<string>();
    for (const key of this.files.keys()) if (key.startsWith(`${relative}/`)) names.add(key.slice(relative.length + 1).split("/")[0]!);
    return [...names];
  }
  async exists(relative: string) { return this.files.has(relative); }
  async remove(relative: string) { this.files.delete(relative); }
  async copyIn(hostFile: string, relative: string) {
    const text = await this.host.readText(hostFile);
    if (text === null) throw new Error(`missing host file ${hostFile}`);
    this.files.set(relative, text); this.copies.push({ from: hostFile, to: relative });
  }
  async toHostPath(relative: string) { return this.hostPathOf(relative); }
  json(relative: string) { return JSON.parse(this.files.get(relative) ?? "null"); }
}

export function detectDeps(overrides: Partial<DetectDeps> & { fs?: FakeFs } = {}): DetectDeps & { fs: FakeFs; registry: FakeRegistry; clock: FakeClock; runner: FakeRunner } {
  const host = overrides.host ?? WIN;
  return {
    host, fs: new FakeFs(host.platform === "win32" ? "\\" : "/"), registry: new FakeRegistry(), runner: new FakeRunner(), clock: new FakeClock(),
    bundledFusionAddin: host.platform === "win32" ? "C:\\Program Files\\Reify\\resources\\executors\\fusion\\ReifyExport" : "/Applications/Reify.app/executors/fusion/ReifyExport",
    bundledSolidworksExe: "C:\\Program Files\\Reify\\resources\\executors\\solidworks\\ReifyExport.exe",
    projectInWsl: false,
    ...overrides,
  } as never;
}

export const MANIFEST = (version: string) => JSON.stringify({ id: "ReifyExport", version, runOnStartup: true });
