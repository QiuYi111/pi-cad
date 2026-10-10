import { execFileSync, spawn } from "node:child_process";

export function childExit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; signal: NodeJS.Signals | null }> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => accept({ code: code ?? 1, signal }));
  });
}

export function gitRevision(directory: string): string {
  try { return execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

export function capturedChildExit(command: string, args: string[], env: NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<{ code: number; signal: NodeJS.Signals | null; diagnostic: string; aborted: boolean }> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let diagnostic = "";
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => { diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-8192); };
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
    child.once("error", (error) => { abortSignal?.removeEventListener("abort", abort); reject(error); });
    child.once("exit", (code, signal) => {
      abortSignal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      accept({ code: code ?? 1, signal, diagnostic, aborted });
    });
  });
}
