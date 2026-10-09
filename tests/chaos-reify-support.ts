import assert from "node:assert/strict";
import { join } from "node:path";
import { ReifyRuntime } from "../chaos/reify/runtime.ts";
import { ReifySession } from "../chaos/reify/session.ts";
import { ReifyTrace } from "../chaos/reify/trace.ts";
import { sleep } from "../chaos/support/process.ts";

export async function waitForBuildChild(session: ReifySession, kernelPid: number, timeoutMs = 30_000): Promise<number | null> {
  return await session.waitForBuildChild(kernelPid, timeoutMs);
}

/** A real kernel rooted at the given runtime, once it has one. */
export async function waitForRuntimeKernel(session: ReifySession, runtimePid: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const kernel = (await session.snapshot()).kernels.find((item) => item.ppid === runtimePid && !item.orphan);
    if (kernel) return kernel;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

export async function withRealSession<T>(body: (session: ReifySession, trace: ReifyTrace) => Promise<T>): Promise<T> {
  const session = await ReifySession.start();
  const trace = new ReifyTrace();
  try {
    return await body(session, trace);
  } finally {
    await session.close().catch(() => undefined);
  }
}

export async function withRuntime<T>(body: (session: ReifySession, runtime: ReifyRuntime) => Promise<T>): Promise<T> {
  const session = await ReifySession.start();
  const runtime = await ReifyRuntime.start({
    project: session.project,
    runtimeDirectory: join(session.root, "runtime"),
    env: session.env,
  });
  session.registerAuthorityPid(runtime.pid);
  try {
    return await body(session, runtime);
  } finally {
    await runtime.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  }
}

/** Drive a real run to `cook` through the runtime's own socket. */
export async function driveRunThroughRuntime(runtime: ReifyRuntime, conversation: string): Promise<string> {
  const view = (await runtime.call("workflow-start", { id: "mechanical.default", sessionId: conversation })) as { runId?: string };
  assert.ok(view.runId, "真 runtime 必须真建 run");
  await runtime.call("commit", { name: "plan", sessionId: conversation });
  await runtime.call("workflow-advance", { event: "plan_ready", sessionId: conversation });
  return view.runId!;
}

export const runIdOf = (view: unknown): string | null => {
  const runId = (view as { runId?: string } | null)?.runId;
  return typeof runId === "string" ? runId : null;
};

/** The product's own capability list, asked the way the harness asks it. */
export async function buildCapable(session: ReifySession, conversation: string): Promise<boolean> {
  const view = (await session.call("workflow-current", { sessionId: conversation })) as
    | { operations?: { capability?: string }[]; can?: string[] }
    | null;
  if ((view?.operations ?? []).some((operation) => operation.capability === "cad_build_step")) return true;
  return (view?.can ?? []).some((entry) => entry.startsWith("cad_build_step"));
}
