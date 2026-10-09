import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { CadEventEnvelope } from "../protocol.ts";
import { packageRoot } from "../paths.ts";
import { assertLinuxRuntime } from "../platform.ts";
import { runProcess } from "../process-runner.ts";
import { isWarmCadctlCommand, runWarmCadctl } from "../cadctl-worker.ts";

export const DEFAULT_CADCTL_TIMEOUT_MS = 180_000;

/** Reproducible uv-managed Python command inside the Linux/WSL runtime. */
export function pythonInvocation(extra?: "simulation", _cwd?: string): { command: string; prefixArgs: string[] } {
  assertLinuxRuntime("Pi-CAD Python capability");
  const uvExtra = extra ? ["--extra", extra] : [];
  return {
    command: process.env.PI_CAD_UV ?? "uv",
    prefixArgs: ["run", "--project", join(packageRoot(), "python"), ...uvExtra, "python"],
  };
}

/** The interpreter the runtime installed, or the project venv `uv` builds. */
export function managedPythonInterpreter(): string | null {
  const configured = (process.env.PI_CAD_PYTHON ?? "").trim();
  if (configured && existsSync(configured)) return configured;
  const venv = join(packageRoot(), "python", ".venv", "bin", "python");
  return existsSync(venv) ? venv : null;
}

/**
 * Command line for the warm cadctl kernel.
 *
 * The kernel has to be a direct child of the process that owns it. The only
 * owner-death signal that still reaches a stopped process is
 * `PR_SET_PDEATHSIG`, and a process can only arm that against its own parent,
 * so `uv run` -- which puts an interpreter child in that slot and outlives a
 * SIGKILLed owner -- cannot be the launcher. The managed interpreter is
 * spawned directly; `uv` stays the launcher only while that environment does
 * not exist yet, where building it is the whole point.
 */
function warmKernelInvocation(extra?: "simulation"): { command: string; args: string[] } {
  const managed = managedPythonInterpreter();
  if (managed) return { command: managed, args: ["-m", "cadctl.worker"] };
  const python = pythonInvocation(extra);
  return { command: python.command, args: [...python.prefixArgs, "-m", "cadctl.worker"] };
}

/** Minimal host environment for spawning the uv-managed cadctl process. */
export function cadctlEnv(cwd?: string): NodeJS.ProcessEnv {
  assertLinuxRuntime("Pi-CAD cadctl capability");
  const env = { ...process.env, NO_COLOR: "1", ...(cwd ? { PI_CAD_INVOCATION_CWD: resolve(cwd) } : {}) };
  // cadctl stdout is a JSON transport. Prime and terminal hosts may set
  // FORCE_COLOR globally, which lets dependency diagnostics inject ANSI
  // bytes ahead of the envelope and makes the bridge unparsable.
  delete env.FORCE_COLOR;
  return env;
}

export interface CadctlOptions {
  cwd: string;
  timeoutMs?: number;
  extra?: "simulation";
  signal?: AbortSignal;
}

export async function runCadctl(
  args: string[],
  options: CadctlOptions,
): Promise<CadEventEnvelope> {
  const python = pythonInvocation(options.extra, options.cwd);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CADCTL_TIMEOUT_MS;
  const maxStdoutBytes = 16 * 1024 * 1024;
  const maxStderrBytes = 1024 * 1024;
  const useWorker = process.env.PI_CAD_CADCTL_TRANSPORT !== "process" && isWarmCadctlCommand(args[0]);
  const kernel = useWorker ? warmKernelInvocation(options.extra) : null;
  const result = kernel
    ? await runWarmCadctl(
        {
          key: `${kernel.command}\0${kernel.args.join("\0")}`,
          command: kernel.command,
          args: kernel.args,
          cwd: packageRoot(),
          env: cadctlEnv(),
        },
        { args, cwd: options.cwd, timeoutMs, maxStdoutBytes, maxStderrBytes },
      )
    : await runProcess({
        command: python.command,
        args: [...python.prefixArgs, "-m", "cadctl", ...args],
        cwd: options.cwd,
        env: cadctlEnv(options.cwd),
        timeoutMs,
        signal: options.signal,
        maxStdoutBytes,
        maxStderrBytes,
      });
  if (result.exitCode !== 0 || result.terminationReason) {
    const diagnostic = [result.stderr, result.stdout].filter(Boolean).join("\n").slice(-8192);
    throw new Error(
      `cadctl process failed${result.terminationDetail ? `: ${result.terminationDetail}` : ` with exit ${result.exitCode}`}: ${diagnostic}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`cadctl returned non-JSON output: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || !("ok" in parsed)) {
    throw new Error("cadctl returned an invalid envelope");
  }
  return parsed as CadEventEnvelope;
}
