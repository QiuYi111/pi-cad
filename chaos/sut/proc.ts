import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root: chaos/sut/proc.ts -> <repo>/ */
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
