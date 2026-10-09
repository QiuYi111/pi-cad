import { readFileSync } from "node:fs";

/**
 * Field 22 of `/proc/<pid>/stat` -- the instant the process started. Read from
 * the last `)` onwards so a `comm` with spaces or parentheses cannot shift it.
 */
function processStartTime(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Identity a spawned kernel uses to notice that this process died.
 *
 * The kernel cannot rely on this process to clean up: `SIGKILL` runs no
 * handler, and a process that dies from a signal never reaches its exit hooks.
 * Passing our own pid, plus the start time that pid had, lets the kernel tell
 * a dead owner apart from an unrelated process that later reused the number.
 */
export function kernelOwnerBinding(pid = process.pid): NodeJS.ProcessEnv {
  const binding: NodeJS.ProcessEnv = { PI_CAD_OWNER_PID: String(pid) };
  const started = processStartTime(pid);
  if (started) binding.PI_CAD_OWNER_START = started;
  return binding;
}
