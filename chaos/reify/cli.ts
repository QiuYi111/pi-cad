import { join } from "node:path";

import { InvariantViolation } from "../types.ts";
import { CAMPAIGNS_DIR, loadCampaign, runReifyCampaign, type CampaignOptions } from "../campaign/campaign.ts";
import { CAMPAIGN_PROFILES, resolveProfiles } from "../campaign/profiles.ts";
import { renderCampaignReport, renderCampaignSummary } from "../campaign/report.ts";
import { reifyActionDefinitions } from "./actions.ts";
import { loadReifyArtifact, saveReifyArtifact } from "./artifacts.ts";
import { inspectReifyComponents, runtimeObservation, type ReifyComponents } from "./components.ts";
import { FAULT_BOUNDARIES, reifyFaultDefinitions } from "./faults.ts";
import { ReifyPrimeRuntime } from "./prime.ts";
import { ReifyRuntime } from "./runtime.ts";
import { checkInvariantsOn, reifyInvariantDefinitions } from "./invariants.ts";
import type { Command } from "./model.ts";
import { executeReifyCommand, reifyChaosRun, reifySettleWindowFor, replayReifyArtifact, runReifySequence, shrinkReifyArtifact } from "./runner.ts";
import { ReifySession } from "./session.ts";
import { ReifyTrace } from "./trace.ts";

const USAGE = `真 Reify chaos slice

  chaos reify demo                     一条真故障链：真 run → 真 kernel → 真 kill
  chaos reify run [--runs N] [--seed N] [--max-commands N] [--runtime] [--json]
  chaos reify replay <artifact.json>              按 artifact 里存的序列重放
  chaos reify replay <artifact.json> --seed       按 artifact 里的 seed+path 精确重放原路径
  chaos reify shrink <artifact.json>
  chaos reify inspect [--json] [--prime] [--provider-probe]
                                       起真 runtime，打真 run/kernel，看 provider/Desktop/WSL
  chaos reify space [--json]           列出 action / fault 空间和各自覆盖的边界
  chaos reify campaign run [--mode short|nightly|targeted] [--rounds N] [--seed N]
                           [--max-commands N] [--profiles a,b] [--runtime-ratio 0..1]
                           [--provider-faults] [--concurrency N] [--triage-replays N]
                           [--id NAME] [--out DIR] [--skip-triage] [--json]
                                       跑大规模真 campaign，落 artifact + dedupe + report
  chaos reify campaign rerun <dir> [--json]   用 manifest 原样重跑一条 campaign
  chaos reify campaign report <dir> [--json]  用已落盘的数据重出 report
  chaos reify campaign profiles        列出 campaign profile
  chaos reify campaign list            列出本地 campaign
  chaos reify invariants
`;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=");
      if (inline !== undefined) flags[key!] = inline;
      else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) flags[key!] = argv[++index]!;
      else flags[key!] = true;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

const boolFlag = (flags: ParsedArgs["flags"], key: string): boolean => flags[key] === true || flags[key] === "true";

function stateLine(snapshot: Awaited<ReturnType<ReifySession["snapshot"]>>): string {
  const runs = snapshot.runs.map((run) => `${run.id} ${run.phase}/${run.status} artifacts=${run.artifacts.length}`).join(" | ");
  const kernels = snapshot.kernels.map((kernel) => `${kernel.pid}${kernel.orphan ? "(orphan)" : ""}`).join(",") || "none";
  const conversations = snapshot.conversations.map((conversation) => `${conversation.id}->${conversation.runId ?? "none"}`).join(" ");
  return `runs=[${runs}] kernels=[${kernels}] ${conversations}`;
}

/** Run a readable chain, printing real state after every real command. */
async function runChain(session: ReifySession, trace: ReifyTrace, chain: Command[], title: string): Promise<void> {
  process.stdout.write(`\n== ${title}\n`);
  for (const command of chain) {
    await executeReifyCommand(session, command, trace);
    const label = `${command.kind}:${command.name}`;
    process.stdout.write(`  ${label.padEnd(30)} ${stateLine(await session.snapshot())}\n`);
    await new Promise((accept) => setTimeout(accept, reifySettleWindowFor(command)));
    await checkInvariantsOn(session, trace, label);
  }
}

async function demo(): Promise<number> {
  const session = await ReifySession.start();
  const trace = new ReifyTrace();
  try {
    await runChain(session, trace, [
      { kind: "action", name: "startRun", params: { conversationIndex: 0 } },
      { kind: "action", name: "commitPlan", params: { conversationIndex: 0 } },
      { kind: "action", name: "advance", params: { event: "plan_ready", conversationIndex: 0 } },
      { kind: "action", name: "build", params: { source: "part.py", conversationIndex: 0 } },
    ], "真 Reify：建 run → 真 build（真 cadctl kernel 出 STEP）");

    const catalog = (await session.call("viewer-catalog", { sessionId: session.conversation(0) })) as {
      currentRun?: { id?: string; artifacts?: { id: string; path: string; sha256: string }[] };
    };
    for (const artifact of catalog.currentRun?.artifacts ?? []) {
      process.stdout.write(`  artifact ${artifact.id} ${artifact.path} ${artifact.sha256.slice(0, 12)}\n`);
    }

    // Fault 1: the kernel dies mid-build. The fault's recovery step proves the
    // system heals by running one more real build.
    process.stdout.write("\n== 真故障 1：build 途中 SIGKILL 真 kernel\n");
    const before = trace.notes.length;
    await runReifySequence(session, [{ kind: "fault", name: "killKernelDuringBuild", params: {} }], trace);
    for (const note of trace.notes.slice(before)) process.stdout.write(`  ${note}\n`);
    process.stdout.write(`  ${stateLine(await session.snapshot())}\n`);
    const recovery = session.history.recoveries.at(-1);
    process.stdout.write(`  恢复证据：故障后真 build 成功（${recovery?.buildMs ?? "?"}ms）\n`);

    // Fault 2: the control-plane process dies mid-build.
    process.stdout.write("\n== 真故障 2：build 途中 SIGKILL 真控制面\n");
    const faultNotes = trace.notes.length;
    let violation: InvariantViolation | null = null;
    try {
      await runReifySequence(session, [{ kind: "fault", name: "killAuthorityDuringBuild", params: {} }], trace);
    } catch (error) {
      if (error instanceof InvariantViolation) violation = error;
      else throw error;
    }
    for (const note of trace.notes.slice(faultNotes)) process.stdout.write(`  ${note}\n`);
    process.stdout.write(`  ${stateLine(await session.snapshot())}\n`);
    if (!violation) {
      process.stdout.write("\n没有抓到真问题（这类故障在当前实现下被正确处理）\n");
      return 0;
    }

    // The reproducible path is the setup that puts a real run in `cook` plus
    // the fault that kills the authority mid-build. Replaying it re-creates
    // the same orphan kernel, so `chaos reify replay <artifact>` works.
    const reproduction: Command[] = [
      { kind: "action", name: "startRun", params: { conversationIndex: 0 } },
      { kind: "action", name: "commitPlan", params: { conversationIndex: 0 } },
      { kind: "action", name: "advance", params: { event: "plan_ready", conversationIndex: 0 } },
      { kind: "fault", name: "killAuthorityDuringBuild", params: {} },
    ];
    const artifact = {
      schema: 1 as const,
      sut: "reify" as const,
      createdAt: new Date().toISOString(),
      invariant: violation.invariant,
      detail: violation.detail,
      evidence: violation.evidence,
      seed: 0,
      // The fixed demo chain is hand-written, not generated, so it has no
      // fast-check path: it replays by sequence only (`replay <artifact>`).
      replayPath: "",
      maxCommands: reproduction.length,
      originalSequence: reproduction,
      shrunkSequence: reproduction,
      replaySequence: reproduction,
      reproducible: true,
      actionSequence: reproduction.filter((command) => command.kind === "action"),
      faultSequence: [{ kind: "fault" as const, name: "killAuthorityDuringBuild", params: {} }],
      requests: session.requests,
      ids: { conversations: session.conversations, runs: [...trace.ids.runs], kernels: [...trace.ids.kernels] },
      stateTimeline: trace.timeline,
      logs: trace.notes,
      recoveries: session.history.recoveries,
      project: { root: session.root, project: session.project, canonical: session.canonical, workflowHome: session.workflowHome },
    };
    const artifactPath = saveReifyArtifact(artifact);
    process.stdout.write(`\n抓到真问题：${violation.invariant}\n  ${violation.detail}\n  artifact=${artifactPath}\n`);
    return 0;
  } finally {
    const keep = process.env.CHAOS_REIFY_KEEP === "1";
    process.stdout.write(`\n项目目录：${session.project}${keep ? "（保留）" : "（已清理）"}\n`);
    if (keep) {
      await session.reset();
      process.exitCode = 0;
    }
    await session.close().catch(() => undefined);
  }
}

async function commandRun(flags: ParsedArgs["flags"]): Promise<number> {
  const session = await ReifySession.start();
  try {
    // `--runtime` drives every request through the long-lived authority sidecar
    // (the real Desktop/Prime backend), which is what makes the runtime
    // lifecycle faults real instead of a per-call wrapper dying.
    if (boolFlag(flags, "runtime")) {
      const runtime = await ReifyRuntime.start({
        project: session.project,
        runtimeDirectory: join(session.root, "runtime"),
        env: session.env,
      });
      session.attachRuntime(runtime);
    }
    const result = await reifyChaosRun({
      numRuns: flags.runs ? Number(flags.runs) : undefined,
      seed: flags.seed ? Number(flags.seed) : undefined,
      maxCommands: flags["max-commands"] ? Number(flags["max-commands"]) : undefined,
      quiet: boolFlag(flags, "json"),
      session,
    });
    if (boolFlag(flags, "json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`真实 invariant：${result.invariants.join(", ")}\n`);
      process.stdout.write(`fault 结果：${summarizeFaultOutcomes(result.faultOutcomes)}\n`);
      if (result.recoveries.length) {
        process.stdout.write(`真 build 恢复证据 ${result.recoveries.length} 次（最近 ${result.recoveries.at(-1)?.buildMs}ms）\n`);
      }
    }
    return result.failed ? 1 : 0;
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** One line that says how the fault space really behaved, not just "no error". */
function summarizeFaultOutcomes(outcomes: { status: string }[]): string {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
  if (!counts.size) return "这轮没跑到 fault";
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(" ");
}

/**
 * Show the explored space: how many real actions, how many real faults, and
 * which boundary each fault really hits.
 */
async function space(flags: ParsedArgs["flags"]): Promise<number> {
  const boundaries = new Set(Object.values(FAULT_BOUNDARIES));
  const report = {
    actions: reifyActionDefinitions.map((definition) => ({ name: definition.name, description: definition.description })),
    faults: reifyFaultDefinitions.map((definition) => ({
      name: definition.name,
      boundary: FAULT_BOUNDARIES[definition.name] ?? "unknown",
      description: definition.description,
      hasPrecondition: typeof definition.precondition === "function",
    })),
    counts: {
      actions: reifyActionDefinitions.length,
      faults: reifyFaultDefinitions.length,
      boundaries: [...boundaries],
      races: reifyFaultDefinitions.filter((definition) => FAULT_BOUNDARIES[definition.name] === "race").length,
    },
  };
  if (boolFlag(flags, "json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`\n== action（${report.counts.actions} 个，全是真操作）\n`);
  for (const action of report.actions) process.stdout.write(`  ${action.name.padEnd(26)} ${action.description}\n`);
  process.stdout.write(`\n== fault（${report.counts.faults} 个）\n`);
  for (const boundary of [...boundaries]) {
    const faults = report.faults.filter((fault) => fault.boundary === boundary);
    process.stdout.write(`  [${boundary}] ${faults.length} 个\n`);
    for (const fault of faults) process.stdout.write(`    ${fault.name.padEnd(30)} ${fault.description}\n`);
  }
  process.stdout.write(`\n覆盖边界：${report.counts.boundaries.join(", ")}\n`);
  return 0;
}

/**
 * Drive the real Reify runtime, observe every component RES-385 connected,
 * and print the unified identity graph. This is the "接得上、看得见" command:
 * no fault campaign, only real start / observe evidence.
 */
async function inspect(flags: ParsedArgs["flags"]): Promise<number> {
  const session = await ReifySession.start();
  const conversation = session.conversation(0);
  const runtime = await ReifyRuntime.start({
    project: session.project,
    runtimeDirectory: join(session.root, "runtime"),
    env: session.env,
  });
  session.registerAuthorityPid(runtime.pid);
  const drivenRuns: string[] = [];
  const pidSequence: number[] = [runtime.pid];
  // Provider network probe is explicit opt-in: observing the boundary must not
  // change the outside world. Without the flag this only reads local state.
  const probeProvider = flags["provider-probe"] === true;
  let orphaned: number[] = [];
  try {
    // Real run + real plan, served by the long-lived runtime over its socket.
    const view = (await runtime.call("workflow-start", { id: "mechanical.default", sessionId: conversation })) as {
      runId?: string;
      phase?: string;
      status?: string;
    };
    if (typeof view?.runId === "string") drivenRuns.push(view.runId);
    await runtime.call("commit", { name: "plan", sessionId: conversation });
    await runtime.call("workflow-advance", { event: "plan_ready", sessionId: conversation });

    // A real slow build in flight, so the CAD kernel really is a live child of
    // the runtime pid while the identity graph is built.
    const pendingBuild = runtime.call("model-build", {
      source: "slow_part.py",
      output: `build/slow-${conversation}.step`,
      validation: "fast",
      sessionId: conversation,
    });
    const ownedKernel = await waitForRuntimeKernel(session, runtime.pid, 20_000);
    const runtimes = [runtimeObservation(runtime, drivenRuns)];
    const components = await inspectReifyComponents(session, { runtimes, probeProvider });
    const build = (await pendingBuild) as { build?: { ok?: boolean; durationMs?: number } };

    // Optional real Prime runtime: start the real Desktop runtime process and
    // handshake its real RPC without sending a provider turn.
    let primeInfo: { pid: number; sessionId: string | null; alive: boolean } | null = null;
    let primeLog = "";
    if (flags.prime === true) {
      if (!ReifyPrimeRuntime.available()) {
        process.stdout.write("Prime runtime 不可用：没有可解析的 prime-agent checkout\n");
      } else {
        const selection = components.provider.selection;
        const prime = await ReifyPrimeRuntime.start({
          project: session.project,
          env: session.env,
          provider: selection.provider,
          model: selection.model,
          thinking: selection.thinking ?? "medium",
        });
        primeInfo = { pid: prime.pid, sessionId: prime.current?.sessionId ?? null, alive: prime.alive };
        primeLog = prime.logTail;
        await prime.close();
      }
    }

    // Real runtime lifecycle: restart, then stop, then start again. After each
    // change the fresh runtime must still answer for the same durable run.
    const restarted = await runtime.restart();
    pidSequence.push(restarted.pid);
    session.registerAuthorityPid(runtime.pid);
    const afterRestart = (await runtime.call("workflow-current", { sessionId: conversation })) as { runId?: string; status?: string } | null;
    await runtime.stop();
    const startedAgain = await runtime.start();
    pidSequence.push(startedAgain.pid);
    session.registerAuthorityPid(runtime.pid);
    const afterStart = (await runtime.call("workflow-current", { sessionId: conversation })) as { runId?: string; status?: string } | null;
    const snapshot = await session.snapshot();
    orphaned = snapshot.kernels.filter((kernel) => kernel.orphan).map((kernel) => kernel.pid);

    const report = {
      runtime: {
        pid: runtime.pid,
        pidSequence,
        restarts: runtime.restarts.length,
        authorSocket: runtime.authorSocket,
        requests: runtime.requests,
        logTail: runtime.logTail,
      },
      run: {
        id: drivenRuns[0] ?? null,
        phase: view.phase ?? null,
        afterRestartRunId: afterRestart?.runId ?? null,
        afterRestartStatus: afterRestart?.status ?? null,
        afterStartRunId: afterStart?.runId ?? null,
        build: build.build ?? null,
      },
      kernel: { ownedByRuntimePid: ownedKernel ?? null, orphanedAfterRestart: orphaned },
      components,
      prime: primeInfo ? { ...primeInfo, logTail: primeLog } : { available: ReifyPrimeRuntime.available(), started: false },
    };

    if (boolFlag(flags, "json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printInspect(report, components);
    }
    return 0;
  } finally {
    // Never leave a real orphan behind: stop the runtime and its kernels.
    await runtime.close().catch(() => undefined);
    for (const pid of orphaned) session.killKernel(pid, "SIGKILL");
    await session.close().catch(() => undefined);
  }
}

/** Wait until the runtime pid really owns a live CAD kernel. */
async function waitForRuntimeKernel(session: ReifySession, runtimePid: number, timeoutMs: number): Promise<{ pid: number; ppid: number; orphan: boolean } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await session.snapshot();
    const kernel = snapshot.kernels.find((candidate) => candidate.ppid === runtimePid) ?? null;
    if (kernel) return kernel;
    if (Date.now() > deadline) return null;
    await new Promise((accept) => setTimeout(accept, 100));
  }
}

function printInspect(report: any, components: ReifyComponents): void {
  const provider = components.provider;
  const desktop = report.components?.desktop ?? components.desktop;
  const wsl = components.wsl;
  process.stdout.write(`\n== 真 runtime（authority sidecar 常驻进程）\n`);
  process.stdout.write(`  pid 序列=${report.runtime.pidSequence.join(" → ")}（restarts=${report.runtime.restarts}）\n`);
  process.stdout.write(`  socket=${report.runtime.authorSocket}\n`);
  process.stdout.write(`  真请求：${report.runtime.requests.map((r: any) => `${r.op}${r.ok ? "✓" : "✗"}`).join(", ")}\n`);
  process.stdout.write(`\n== conversation → run → runtime/kernel\n`);
  process.stdout.write(`  conversation=${sessionLine(report)} run=${report.run.id ?? "none"}\n`);
  process.stdout.write(`  kernel=${report.kernel.ownedByRuntimePid ? `pid=${report.kernel.ownedByRuntimePid.pid} ppid=${report.kernel.ownedByRuntimePid.ppid}(runtime)` : "none"}；重启后孤儿=${report.kernel.orphanedAfterRestart.join(",") || "无"}\n`);
  process.stdout.write(`  identity 节点=${components.identities.nodes.length} 边=${components.identities.edges.length}\n`);
  process.stdout.write(`\n== provider / OAuth 边界\n`);
  process.stdout.write(`  选择=${provider.selection.provider}/${provider.selection.model}（${provider.selection.source}）\n`);
  process.stdout.write(`  凭证=${provider.credentials.map((c) => `${c.id}(${c.type}${c.expired ? ",expired" : ""})`).join(", ") || "无"}\n`);
  process.stdout.write(`  probe ${provider.probe.url ?? "(no endpoint)"} → ${provider.probe.status ?? provider.probe.error ?? provider.probe.skipped}\n`);
  process.stdout.write(`\n== Desktop ↔ backend 投影\n`);
  process.stdout.write(`  ${desktop.consistent ? "一致" : "不一致"}：${desktop.mismatch ?? `${desktop.projection.runId} ${desktop.projection.phase}/${desktop.projection.status}`}\n`);
  process.stdout.write(`\n== Windows ↔ WSL 边界\n`);
  process.stdout.write(`  host=${wsl.host} boundary=${wsl.boundary} distro=${wsl.distro ?? "-"}\n`);
  process.stdout.write(`  Windows 侧：${wsl.windows?.reachable ? `wsl.exe 看到 ${wsl.windows.distros.join(", ") || "无"}；${wsl.windows.version ?? ""}` : "不可达"}\n`);
  process.stdout.write(`  ${wsl.note}\n`);
  if (components.prime.processes.length) {
    process.stdout.write(`\n== 真 Prime 进程\n`);
    for (const process_ of components.prime.processes) {
      process.stdout.write(`  ${process_.role} pid=${process_.pid} provider=${process_.provider ?? "?"} model=${process_.model ?? "?"}\n`);
    }
  }
}

function sessionLine(report: any): string {
  const conversation = report.components?.identities?.nodes?.find((node: any) => node.kind === "conversation");
  return conversation?.label ?? "conv-a";
}

function campaignOptions(flags: ParsedArgs["flags"]): CampaignOptions {
  return {
    mode: flags.mode as CampaignOptions["mode"],
    rounds: flags.rounds ? Number(flags.rounds) : undefined,
    seed: flags.seed ? Number(flags.seed) : undefined,
    maxCommands: flags["max-commands"] ? Number(flags["max-commands"]) : undefined,
    profiles: typeof flags.profiles === "string" ? flags.profiles.split(",").map((name) => name.trim()).filter(Boolean) : undefined,
    runtimeRatio: flags["runtime-ratio"] ? Number(flags["runtime-ratio"]) : undefined,
    providerFaults: boolFlag(flags, "provider-faults") ? true : undefined,
    concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
    triageReplays: flags["triage-replays"] ? Number(flags["triage-replays"]) : undefined,
    campaignId: typeof flags.id === "string" ? flags.id : undefined,
    outDir: typeof flags.out === "string" ? flags.out : undefined,
    skipTriage: boolFlag(flags, "skip-triage"),
  };
}

/**
 * `chaos reify campaign`: the long-running dataset builder. `run` is the
 * repeatable entrypoint; `rerun` reads a manifest so the same seeds, profiles
 * and generator settings can be replayed later.
 */
async function campaign(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);
  switch (subcommand) {
    case "profiles": {
      for (const profile of Object.values(CAMPAIGN_PROFILES)) {
        process.stdout.write(
          `${profile.name.padEnd(20)} w=${profile.weight} [${profile.boundaries.join(",")}] ${profile.description}\n`,
        );
      }
      return 0;
    }
    case "list": {
      const { readdirSync } = await import("node:fs");
      const entries = readdirSync(CAMPAIGNS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        try {
          const loaded = loadCampaign(join(CAMPAIGNS_DIR, entry.name));
          const failed = loaded.rounds.filter((round) => round.status === "failed").length;
          process.stdout.write(
            `${entry.name.padEnd(34)} ${loaded.manifest.mode.padEnd(9)} ${String(loaded.rounds.length).padStart(4)} 轮` +
              ` 失败 ${String(failed).padStart(3)} unique ${String(loaded.clusters.length).padStart(2)} ${loaded.manifest.version.gitCommit.slice(0, 8)}\n`,
          );
        } catch (error) {
          process.stdout.write(`${entry.name.padEnd(34)} 读不了：${(error as Error).message}\n`);
        }
      }
      return 0;
    }
    case "report": {
      const dir = positionals[0];
      if (!dir) {
        process.stderr.write("用法：chaos reify campaign report <campaignDir>\n");
        return 2;
      }
      const loaded = loadCampaign(dir);
      if (!loaded.report) {
        process.stderr.write(`${dir} 还没有 report.json；先跑 campaign run，或看 report.md\n`);
        return 2;
      }
      if (boolFlag(flags, "json")) process.stdout.write(`${JSON.stringify(loaded.report, null, 2)}\n`);
      else process.stdout.write(renderCampaignReport(loaded.report));
      return 0;
    }
    case "rerun": {
      const dir = positionals[0];
      if (!dir) {
        process.stderr.write("用法：chaos reify campaign rerun <campaignDir>\n");
        return 2;
      }
      const loaded = loadCampaign(dir);
      const manifest = loaded.manifest;
      const summary = await runReifyCampaign({
        mode: manifest.mode,
        rounds: manifest.rounds,
        seed: manifest.seed,
        maxCommands: manifest.maxCommands,
        profiles: manifest.profiles,
        runtimeRatio: manifest.runtimeRatio,
        providerFaults: manifest.providerFaults,
        concurrency: manifest.concurrency,
        triageReplays: manifest.triageReplays,
        parentCampaignId: manifest.campaignId,
        quiet: boolFlag(flags, "json"),
        outDir: typeof flags.out === "string" ? flags.out : undefined,
      });
      if (boolFlag(flags, "json")) process.stdout.write(`${JSON.stringify(summary.report, null, 2)}\n`);
      else process.stdout.write(`${renderCampaignSummary(summary.report, summary.outDir)}\n`);
      return summary.report.failures.reproducible > 0 ? 1 : 0;
    }
    case "run": {
      const options = campaignOptions(flags);
      const summary = await runReifyCampaign({ ...options, quiet: boolFlag(flags, "json") });
      if (boolFlag(flags, "json")) process.stdout.write(`${JSON.stringify(summary.report, null, 2)}\n`);
      else process.stdout.write(`${renderCampaignSummary(summary.report, summary.outDir)}\n`);
      return summary.report.failures.reproducible > 0 ? 1 : 0;
    }
    default:
      process.stderr.write(`未知 campaign 子命令 "${subcommand ?? ""}"\n`);
      process.stdout.write(resolveProfiles().map((profile) => profile.name).join(", ") + "\n");
      return 2;
  }
}

export async function runReifyCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);
  switch (command) {
    case undefined:
    case "demo":
      return await demo();
    case "run":
      return await commandRun(flags);
    case "replay": {
      const file = positionals[0];
      if (!file) {
        process.stderr.write("用法：chaos reify replay <artifact.json> [--seed]\n");
        return 2;
      }
      const result = await replayReifyArtifact(file, { seed: boolFlag(flags, "seed") });
      process.stdout.write(
        `${result.ok ? "✅" : "❌"} replay(${result.mode}) 期望 ${result.expectedInvariant}，得到 ${result.observedInvariant ?? "无"}\n  ${result.detail ?? ""}\n`,
      );
      return result.ok ? 0 : 1;
    }
    case "shrink": {
      const file = positionals[0];
      if (!file) {
        process.stderr.write("用法：chaos reify shrink <artifact.json>\n");
        return 2;
      }
      loadReifyArtifact(file);
      const result = await shrinkReifyArtifact(file);
      process.stdout.write(
        `${result.ok ? "✅" : "❌"} shrink 后仍复现 ${result.invariant ?? result.expectedInvariant}\n` +
          `  原始 ${result.originalLength} 步 → 最小 ${result.shrunkLength} 步（numShrinks=${result.numShrinks}）\n`,
      );
      return result.ok ? 0 : 1;
    }
    case "inspect":
      return await inspect(flags);
    case "space":
      return await space(flags);
    case "campaign":
      return await campaign(rest);
    case "invariants":
      for (const invariant of reifyInvariantDefinitions) {
        process.stdout.write(`${invariant.name.padEnd(28)} ${invariant.description}\n`);
      }
      return 0;
    case "help":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`未知命令 "${command}"\n${USAGE}`);
      return 2;
  }
}
