import { httpJson, post, sleep } from "./http.ts";

export interface WorkerOptions {
  workerId: string;
  runId: string;
  sessionId: string;
  controlUrl: string;
  externalUrl: string;
  steps: number;
  stepMs: number;
  callTimeoutMs: number;
}

/**
 * A real worker process.
 *
 * It registers with the control plane, then loops: call the external API
 * through the fault-injection proxy, commit a design effect for the step
 * token, and report completion. On SIGTERM it reports a graceful exit; on
 * SIGKILL it simply dies, which is what the crash-recovery invariants need.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const control = options.controlUrl;
  let stopping = false;
  const onSignal = async () => {
    stopping = true;
    try {
      await post(`${control}/api/workers/${options.workerId}/exited`, { reason: "graceful" });
    } catch {
      /* control plane may already be gone */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void onSignal());
  process.on("SIGINT", () => void onSignal());

  await post(`${control}/api/workers/${options.workerId}/ready`, {});

  for (let step = 0; step < options.steps; step += 1) {
    if (stopping) return;
    const token = `${options.runId}:${step}`;
    let delivered = false;
    // One logical operation, at most two wire attempts. A timeout after the
    // upstream already accepted the request is exactly the duplicate-effect
    // scenario the "no duplicate side effects" invariant must catch.
    for (let attempt = 0; attempt < 2 && !delivered; attempt += 1) {
      try {
        const result = await httpJson(
          "POST",
          `${options.externalUrl}/v1/complete`,
          { token, runId: options.runId },
          options.callTimeoutMs,
        );
        if (result.status < 400) delivered = true;
      } catch {
        await sleep(40);
      }
    }
    if (stopping) return;
    // The effect is committed with the step token regardless of the wire
    // outcome: the token is what makes the operation idempotent.
    await post(`${control}/api/workers/${options.workerId}/effect`, { token, delivered });
    await post(`${control}/api/workers/${options.workerId}/heartbeat`, { step });
    await sleep(options.stepMs);
  }

  if (stopping) return;
  await post(`${control}/api/workers/${options.workerId}/complete`, { reason: "done" });
  process.exit(0);
}

function parseArgs(argv: string[]): WorkerOptions {
  const flag = (name: string, fallback?: string): string => {
    const index = argv.indexOf(name);
    if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required flag ${name}`);
  };
  return {
    workerId: flag("--worker"),
    runId: flag("--run"),
    sessionId: flag("--session", ""),
    controlUrl: flag("--control"),
    externalUrl: flag("--external"),
    steps: Number(flag("--steps", "4")),
    stepMs: Number(flag("--step-ms", "120")),
    callTimeoutMs: Number(flag("--call-timeout", "400")),
  };
}

/** Child-process entry point (`__worker`). */
export async function runWorkerEntry(argv: string[]): Promise<void> {
  await runWorker(parseArgs(argv));
}
