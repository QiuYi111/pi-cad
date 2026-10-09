import assert from "node:assert/strict";
import { test } from "node:test";

import { Session } from "../chaos/sut/session.ts";
import { Trace, InvariantViolation } from "../chaos/types.ts";
import { runSequence } from "../chaos/runner/runner.ts";
import type { Command } from "../chaos/model/commands.ts";
import type { BugName } from "../chaos/sut/server.ts";

const faultChain: Command[] = [
  { kind: "action", name: "createProject", params: {} },
  { kind: "action", name: "createRun", params: { projectIndex: 0 } },
  { kind: "action", name: "startWorker", params: { runIndex: 0 } },
  { kind: "action", name: "settle", params: { ms: 300 } },
  { kind: "fault", name: "killWorker", params: { runIndex: 0 } },
  { kind: "action", name: "settle", params: { ms: 400 } },
  { kind: "action", name: "continueRun", params: { runIndex: 0 } },
  { kind: "action", name: "settle", params: { ms: 300 } },
];

async function withSession<T>(bug: BugName | null, body: (session: Session) => Promise<T>): Promise<T> {
  const session = await Session.start({ bug });
  try {
    await session.reset();
    return await body(session);
  } finally {
    await session.close().catch(() => undefined);
  }
}

/**
 * Framework guard: one planted recovery bug must be caught by the invariants.
 * If this stops failing, the chaos runner has gone vacuous. Recovery, pause and
 * external-fault behaviour of the toy service is not product coverage and lives
 * nowhere else.
 */
test("chaos: 注入的恢复 bug 会被 invariant 抓到", async () => {
  let violation: InvariantViolation | null = null;
  await withSession("double-worker", async (session) => {
    const trace = new Trace();
    try {
      await runSequence(session, faultChain, trace, 800);
    } catch (error) {
      if (error instanceof InvariantViolation) violation = error;
      else throw error;
    }
  });
  assert.ok(violation, "double-worker bug 必须被 invariant 抓到");
  assert.ok(
    ["worker-ownership", "worker-liveness", "single-active-worker"].includes(violation!.invariant),
    `unexpected invariant ${violation!.invariant}`,
  );
});

