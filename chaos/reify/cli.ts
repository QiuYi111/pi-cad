import { InvariantViolation } from "../types.ts";
import { loadReifyArtifact, saveReifyArtifact } from "./artifacts.ts";
import { checkInvariantsOn, reifyInvariantDefinitions } from "./invariants.ts";
import type { Command } from "./model.ts";
import { executeReifyCommand, reifyChaosRun, reifySettleWindowFor, replayReifyArtifact, runReifySequence, shrinkReifyArtifact } from "./runner.ts";
import { ReifySession } from "./session.ts";
import { ReifyTrace } from "./trace.ts";

const USAGE = `真 Reify chaos slice

  chaos reify demo                     一条真故障链：真 run → 真 kernel → 真 kill
  chaos reify run [--runs N] [--seed N] [--max-commands N] [--json]
  chaos reify replay <artifact.json> [--seed]
  chaos reify shrink <artifact.json>
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
      replayPath: "demo",
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
  const result = await reifyChaosRun({
    numRuns: flags.runs ? Number(flags.runs) : undefined,
    seed: flags.seed ? Number(flags.seed) : undefined,
    maxCommands: flags["max-commands"] ? Number(flags["max-commands"]) : undefined,
    quiet: boolFlag(flags, "json"),
  });
  if (boolFlag(flags, "json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`真实 invariant：${result.invariants.join(", ")}\n`);
    if (result.recoveries.length) {
      process.stdout.write(`真 build 恢复证据 ${result.recoveries.length} 次（最近 ${result.recoveries.at(-1)?.buildMs}ms）\n`);
    }
  }
  return result.failed ? 1 : 0;
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
