/** Storage faults: the real run state file, the desktop projection and partial state writes. */

import fc from "fast-check";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvariantViolation } from "../../types.ts";
import { FaultNotApplicable } from "../types.ts";
import type { Params, ReifyFaultDefinition } from "../types.ts";
import { sleep } from "../../support/process.ts";
import {
  conversationOf,
  runView,
  activeRunPrecondition,
  buildableRunPrecondition,
  proveRecovery,
} from "./shared.ts";

export const missingRunStateFile: ReifyFaultDefinition = {
  name: "missingRunStateFile",
  description: "把真 run 的 state.json 临时挪走，看真后端怎么应对缺文件",
  arbitrary: fc.constant<Params>({}),
  describe: () => "missingRunStateFile",
  precondition: (ctx) => buildableRunPrecondition(ctx, 0),
  inject: async (ctx) => {
    const conversation = conversationOf(ctx);
    const view = await runView(ctx, conversation);
    if (view.status !== "active" || !view.runId) {
      throw new FaultNotApplicable(`会话没有 active run（${view.status ?? "无"}）`, { conversation });
    }
    const dir = ctx.session.runDir(view.runId);
    const file = join(dir, "state.json");
    if (!existsSync(file)) throw new FaultNotApplicable("run state.json 本来就不在", { runId: view.runId });
    const hidden = `${file}.chaos-hidden`;
    renameSync(file, hidden);
    ctx.session.markDamagedRun(view.runId);
    ctx.session.armedFaults.set("missingRunStateFile", { file, hidden, runId: view.runId });
    ctx.session.armFault("missingRunStateFile");
    ctx.trace.record({ kind: "note", name: "missingRunStateFile", detail: { runId: view.runId, file } });
    await sleep(300);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("missingRunStateFile") as { file: string; hidden: string; runId: string } | undefined;
    ctx.session.disarmFault("missingRunStateFile");
    if (armed) {
      if (existsSync(armed.hidden) && !existsSync(armed.file)) renameSync(armed.hidden, armed.file);
      ctx.session.unmarkDamagedRun(armed.runId);
      ctx.trace.note(`run ${armed.runId} 的 state.json 放回去了`);
    }
    await proveRecovery(ctx, "missingRunStateFile");
  },
};

/** Make a run's real state file unreadable, the way a permissions fault would. */
export const unreadableRunStateFile: ReifyFaultDefinition = {
  name: "unreadableRunStateFile",
  description: "把真 run 的 state.json 改成不可读，看真后端怎么应对",
  arbitrary: fc.constant<Params>({}),
  describe: () => "unreadableRunStateFile",
  precondition: async (ctx) =>
    process.getuid?.() === 0
      ? { applicable: false, reason: "root 无视文件权限，chmod 造不出「读不到」" }
      : await activeRunPrecondition(ctx, 0),
  inject: async (ctx) => {
    const view = await runView(ctx, conversationOf(ctx));
    if (view.status !== "active" || !view.runId) throw new FaultNotApplicable(`会话没有 active run（${view.status ?? "无"}）`);
    const file = join(ctx.session.runDir(view.runId), "state.json");
    if (!existsSync(file)) throw new FaultNotApplicable("run state.json 本来就不在");
    chmodSync(file, 0o000);
    ctx.session.markDamagedRun(view.runId);
    ctx.session.armedFaults.set("unreadableRunStateFile", { file, runId: view.runId });
    ctx.session.armFault("unreadableRunStateFile");
    ctx.trace.record({ kind: "note", name: "unreadableRunStateFile", detail: { runId: view.runId, file } });
    await sleep(300);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("unreadableRunStateFile") as { file: string; runId: string } | undefined;
    ctx.session.disarmFault("unreadableRunStateFile");
    if (armed) {
      if (existsSync(armed.file)) chmodSync(armed.file, 0o644);
      ctx.session.unmarkDamagedRun(armed.runId);
      ctx.trace.note(`run ${armed.runId} 的 state.json 权限恢复了`);
    }
    await proveRecovery(ctx, "unreadableRunStateFile");
  },
};

/** Cut a state file in half, the way an interrupted write would. */
export const partialStateWrite: ReifyFaultDefinition = {
  name: "partialStateWrite",
  description: "把真 run 的 state.json 截成半截（模拟写一半断电）",
  arbitrary: fc.constant<Params>({}),
  describe: () => "partialStateWrite",
  precondition: async (ctx) => {
    const base = await buildableRunPrecondition(ctx, 0);
    if (!base.applicable) return base;
    const view = await runView(ctx, conversationOf(ctx));
    if (view.status !== "active" || !view.runId) {
      return { applicable: false, reason: `会话没有 active run（${view.status ?? "无"}）` };
    }
    const file = join(ctx.session.runDir(view.runId), "state.json");
    if (!existsSync(file)) return { applicable: false, reason: "run state.json 本来就不在" };
    // "写一半断电"要求这个文件本来就能读写。另一个 fault（比如
    // unreadableRunStateFile）刚把它改成读不到时，硬写只会造出 harness 自己的
    // EACCES，再被记成一次假的产品失败。这里明说「不适用」。
    try {
      accessSync(file, constants.R_OK | constants.W_OK);
    } catch {
      return { applicable: false, reason: "run state.json 现在读不了或写不了（多半是 unreadableRunStateFile 还挂着）" };
    }
    return base;
  },
  inject: async (ctx) => {
    const view = await runView(ctx, conversationOf(ctx));
    if (view.status !== "active" || !view.runId) throw new FaultNotApplicable(`会话没有 active run（${view.status ?? "无"}）`);
    const file = join(ctx.session.runDir(view.runId), "state.json");
    if (!existsSync(file)) throw new FaultNotApplicable("run state.json 本来就不在");
    // 截两次会把第一次留下的完整原件覆盖成半截，recover 之后文件再也回不去，
    // 那是 harness 自己造的损坏，不是产品问题。
    if (existsSync(`${file}.chaos-original`)) {
      throw new FaultNotApplicable("这个 run 的 state.json 已经截过一次，原件还在 .chaos-original");
    }
    const original = readFileSync(file);
    writeFileSync(`${file}.chaos-original`, original);
    writeFileSync(file, original.subarray(0, Math.max(1, Math.floor(original.length / 2))));
    ctx.session.markDamagedRun(view.runId);
    ctx.session.armedFaults.set("partialStateWrite", { file, runId: view.runId });
    ctx.session.armFault("partialStateWrite");
    ctx.trace.record({ kind: "note", name: "partialStateWrite", detail: { runId: view.runId, bytes: original.length } });
    await sleep(300);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("partialStateWrite") as { file: string; runId: string } | undefined;
    ctx.session.disarmFault("partialStateWrite");
    if (armed) {
      const backup = `${armed.file}.chaos-original`;
      if (existsSync(backup)) {
        // The fault owns the broken half-file, not every later write to this
        // path. If the product successfully wrote a complete state while the
        // fault was armed, restoring the injection-time backup would roll a
        // newer run state backwards and make the harness invent run-ownership
        // or terminal-state failures.
        let currentIsValid = false;
        if (existsSync(armed.file)) {
          try {
            JSON.parse(readFileSync(armed.file, "utf8"));
            currentIsValid = true;
          } catch {
            currentIsValid = false;
          }
        }
        if (currentIsValid) {
          rmSync(backup, { force: true });
          ctx.trace.note(`run ${armed.runId} 的 state.json 已被产品写回有效新状态，保留当前文件`);
        } else {
          copyFileSync(backup, armed.file);
          rmSync(backup, { force: true });
          ctx.trace.note(`run ${armed.runId} 的 state.json 仍损坏，恢复注入前备份`);
        }
      }
      ctx.session.unmarkDamagedRun(armed.runId);
    }
    await proveRecovery(ctx, "partialStateWrite");
  },
};

/** Delete the Desktop-facing status projection so the real authority must rewrite it. */
export const missingDesktopProjection: ReifyFaultDefinition = {
  name: "missingDesktopProjection",
  description: "删掉真 .pi-cad/status.json 投影，之后真请求必须把它写回来",
  arbitrary: fc.constant<Params>({}),
  describe: () => "missingDesktopProjection",
  precondition: async (ctx) =>
    ctx.session.attachedRuntime
      ? { applicable: true }
      : { applicable: false, reason: "这一轮没有 attached Desktop runtime；one-shot authority 不拥有 Desktop 投影" },
  inject: async (ctx) => {
    if (!ctx.session.attachedRuntime) {
      throw new FaultNotApplicable("这一轮没有 attached Desktop runtime；one-shot authority 不拥有 Desktop 投影");
    }
    const file = join(ctx.session.project, ".pi-cad", "status.json");
    if (!existsSync(file)) throw new FaultNotApplicable("这一轮还没有 Desktop 投影可删");
    ctx.session.markDamagedProjection();
    const payload = readFileSync(file);
    ctx.session.armedFaults.set("missingDesktopProjection", { file, payload });
    ctx.session.armFault("missingDesktopProjection");
    rmSync(file, { force: true });
    ctx.trace.record({ kind: "note", name: "missingDesktopProjection", detail: { file, bytes: payload.length } });
    await sleep(300);
  },
  recover: async (ctx) => {
    const armed = ctx.session.armedFaults.get("missingDesktopProjection") as { file: string } | undefined;
    ctx.session.disarmFault("missingDesktopProjection");
    ctx.session.unmarkDamagedProjection();
    if (!armed) {
      // Nothing was deleted in this round (or it was already put back): there
      // is no write-back to prove. Never fall through with an empty path --
      // `existsSync("")` is false for reasons that have nothing to do with the
      // product, and the harness would blame the product for it.
      ctx.trace.note("missingDesktopProjection 没挂上，跳过 Desktop 投影写回检查");
      return;
    }
    // The projection belongs to the long-lived runtime, the backend the Desktop
    // talks to. The runner recovers faults in reverse injection order, so a
    // round where another fault SIGKILLed that runtime recovers *this* fault
    // while it is still down; `session.call` then silently falls back to a
    // one-shot authority, which never owns `.pi-cad/status.json`, and the check
    // below would blame the product for a projection the harness never asked
    // the right process to write. Bring the runtime back first — the same real
    // restart the runtime faults do in their own recover — and keep the check
    // on the surface that really owns it.
    const runtime = ctx.session.attachedRuntime;
    if (runtime && !runtime.alive) {
      const info = await runtime.start();
      ctx.session.registerAuthorityPid(info.pid, "runtime");
      ctx.trace.note(`Desktop 投影要常驻 runtime 才算数：先把它重新起来 pid=${info.pid}`);
    }
    // One real request makes the real authority rewrite its own projection.
    await ctx.session.call("workflow-current", { sessionId: conversationOf(ctx) });
    if (!existsSync(armed.file)) {
      throw new InvariantViolation("recovery-convergence", "真 authority 没有把 .pi-cad/status.json 写回来", { file: armed.file });
    }
    ctx.trace.note("真 authority 已把 Desktop 投影写回来");
  },
};

// ---------------------------------------------------------------------------
