import { readdirSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root: chaos/support/process.ts -> <repo>/ */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const LAUNCHER = path.join(REPO_ROOT, "scripts", "chaos.mjs");
export const TOOLS_DIR = path.join(REPO_ROOT, ".chaos-cache", "bin");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function waitForLine(
  child: ChildProcess,
  pattern: RegExp,
  timeoutMs = 20_000,
  describeFailure: () => string = () => "",
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`process did not report ${pattern} within ${timeoutMs}ms. ${describeFailure()}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(pattern);
      if (match) {
        cleanup();
        resolve(match);
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`process exited before reporting ${pattern}. ${describeFailure()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

export function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SpawnedEntry {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  waitForLine: (pattern: RegExp, timeoutMs?: number) => Promise<RegExpMatchArray>;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
}

/**
 * Spawn a chaos sub-entry point (`__serve`, `__worker`, `__upstream`) through
 * the single jiti launcher so TypeScript sources run without a build step.
 */
export function spawnEntry(
  subcommand: string,
  args: string[] = [],
  env: Record<string, string> = {},
): SpawnedEntry {
  const child = spawn(process.execPath, [LAUNCHER, subcommand, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });

  const waitForLine = (pattern: RegExp, timeoutMs = 20_000): Promise<RegExpMatchArray> =>
    new Promise((resolve, reject) => {
      const test = () => {
        const match = out.match(pattern);
        if (match) {
          cleanup();
          resolve(match);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `sub-entry "${subcommand}" did not report ${pattern} within ${timeoutMs}ms\nstdout:\n${out}\nstderr:\n${err}`,
          ),
        );
      }, timeoutMs);
      const onExit = () => {
        cleanup();
        reject(new Error(`sub-entry "${subcommand}" exited before ready\nstdout:\n${out}\nstderr:\n${err}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off("data", test);
        child.off("exit", onExit);
      };
      child.stdout?.on("data", test);
      child.once("exit", onExit);
      test();
    });

  const stop = async (signal: NodeJS.Signals = "SIGKILL") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return { child, stdout: () => out, stderr: () => err, waitForLine, stop };
}

/** Plain `setTimeout` sleep shared by every chaos module. */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Numeric pids currently listed in `/proc`. */
export function procPids(): number[] {
  return readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number);
}

/** The argv of a live process, or `[]` when it is gone or unreadable. */
export function procCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** One `/proc/<pid>/stat` line without tripping over `comm` parentheses. */
export function procStat(pid: number): { ppid: number; state: string; pgrp: number } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", ppid: Number(fields[1]), pgrp: Number(fields[2]) };
  } catch {
    return null;
  }
}

/** The kernel state letter (`T` = really stopped), or `null` when the process is gone. */
export function processState(pid: number): string | null {
  return procStat(pid)?.state ?? null;
}

/** Every pid in the process tree rooted at `pid`, children before the root. */
export function processTree(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const childPid of procPids()) {
    const stat = procStat(childPid);
    if (!stat) continue;
    children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), childPid]);
  }
  const ordered: number[] = [];
  const walk = (root: number): void => {
    for (const child of children.get(root) ?? []) walk(child);
    ordered.push(root);
  };
  walk(pid);
  return ordered;
}

/** Wait until every pid in the list has really stopped (SIGSTOP landed). */
export async function waitForStopped(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pids.every((pid) => processState(pid) === "T")) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

/** Every pid that is still alive when the budget runs out. */
export async function waitForProcessesGone(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = pids.filter((pid) => isProcessAlive(pid));
    if (!alive.length || Date.now() > deadline) return alive;
    await sleep(100);
  }
}
