/** Real host services for the CAD transfer dispatcher. Electron-free, so the main process only wires paths in. */
import { spawn, execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Clock, HostFs, ProcessRunner, RegistryReader, RunResult } from "./cad-transfer-paths.js";

export const nodeFs: HostFs = {
  async exists(path) { try { await stat(path); return true; } catch { return false; } },
  async readText(path) { try { return await readFile(path, "utf8"); } catch { return null; } },
  async writeTextAtomic(path, text) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, text, "utf8");
    await rename(`${path}.tmp`, path);
  },
  async mkdirp(path) { await mkdir(path, { recursive: true }); },
  async readdir(path) { try { return await readdir(path); } catch { return []; } },
  async rm(path) { await rm(path, { recursive: true, force: true }); },
  async cp(source, target) { await cp(source, target, { recursive: true, force: true }); },
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const nodeRunner: ProcessRunner = {
  run(exe, args, options = {}) {
    return new Promise<RunResult>((resolve) => {
      execFile(exe, args, { timeout: options.timeoutMs ?? 30_000, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut: Boolean(error && (error as { killed?: boolean }).killed) });
      });
    });
  },
  start(exe, args) {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<RunResult>((resolve) => {
      child.once("error", (error) => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` }));
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });
    return { done, kill: () => { child.kill(); } };
  },
};

/** Parse the output of `reg.exe query <key>`. */
export function parseRegQuery(key: string, output: string): { values: Record<string, string>; subkeys: string[] } {
  const values: Record<string, string> = {};
  const subkeys: string[] = [];
  const base = key.replace(/\\+$/, "").toLowerCase();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      if (line.toLowerCase().startsWith(`${base}\\`)) subkeys.push(line.slice(base.length + 1).split("\\")[0]!);
      continue;
    }
    const match = line.match(/^\s+(.+?)\s{2,}REG_\w+\s*(.*)$/);
    if (match) values[match[1] === "(Default)" || match[1] === "<NO NAME>" ? "" : match[1]!] = match[2]!.trim();
  }
  return { values, subkeys: [...new Set(subkeys)] };
}

export const regExeReader: RegistryReader = {
  read(key) {
    return new Promise((resolve) => {
      execFile("reg.exe", ["query", key], { timeout: 8000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        resolve(error ? null : parseRegQuery(key, String(stdout)));
      });
    });
  },
};
