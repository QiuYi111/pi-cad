import { Session } from "./sut/session.ts";
import { resetHttpLog, sleep } from "./sut/http.ts";
import { BUG_NAMES, type BugName } from "./sut/server.ts";
import { invariantDefinitions } from "./invariants/index.ts";
import { Trace } from "./types.ts";
import type { Command } from "./model/commands.ts";
import { chaosRun, executeCommand, settleWindowFor } from "./runner/runner.ts";
import { replayArtifact } from "./runner/replay.ts";
import { shrinkArtifact } from "./runner/shrink.ts";

const USAGE = `Reify chaos POC

  chaos run     [--bug <name>] [--runs N] [--seed N] [--max-commands N] [--no-external] [--json]
  chaos replay  <artifact.json> [--seed]
  chaos shrink  <artifact.json>
  chaos demo    [--bug <name>]
  chaos bugs
  chaos invariants

bug: ${BUG_NAMES.join(", ")}
`;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=");
      if (inline !== undefined) flags[key] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[key] = argv[++index];
      else flags[key] = true;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function bugFrom(flags: Record<string, string | boolean>): BugName | null {
  const raw = typeof flags.bug === "string" ? flags.bug : null;
  if (!raw) return null;
  if (!BUG_NAMES.includes(raw as BugName)) {
    throw new Error(`未知 bug "${raw}"，可选：${BUG_NAMES.join(", ")}`);
  }
  return raw as BugName;
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);
  switch (command) {
    case "run":
      return await commandRun(flags);
    case "replay":
      return await commandReplay(positionals[0], flags);
    case "shrink":
      return await commandShrink(positionals[0]);
    case "demo":
      return await commandDemo(flags);
    case "bugs":
      process.stdout.write(`${BUG_NAMES.join("\n")}\n`);
      return 0;
    case "invariants":
      for (const invariant of invariantDefinitions) {
        process.stdout.write(`${invariant.name.padEnd(26)} ${invariant.description}\n`);
      }
      return 0;
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`未知命令 "${command}"\n${USAGE}`);
      return 2;
  }
}

async function commandRun(flags: Record<string, string | boolean>): Promise<number> {
  const bug = bugFrom(flags);
  const result = await chaosRun({
    bug,
    numRuns: flags.runs ? Number(flags.runs) : undefined,
    seed: flags.seed ? Number(flags.seed) : undefined,
    maxCommands: flags["max-commands"] ? Number(flags["max-commands"]) : undefined,
    external: !boolFlag(flags, "no-external"),
    quiet: boolFlag(flags, "json"),
  });
  if (boolFlag(flags, "json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (bug) {
    // Injecting a bug is a self-test: the runner must detect it.
    if (result.failed) {
      process.stdout.write(`✅ 植入的 bug "${bug}" 已被发现：${result.invariant}\n`);
      return 0;
    }
    process.stderr.write(`❌ 植入的 bug "${bug}" 没有被发现\n`);
    return 1;
  }
  if (result.failed) {
    process.stderr.write(`❌ 发现系统问题：${result.invariant}（见 ${result.artifactPath}）\n`);
    return 1;
  }
  return 0;
}

async function commandReplay(file: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!file) {
    process.stderr.write("用法：chaos replay <artifact.json> [--seed]\n");
    return 2;
  }
  const result = await replayArtifact(file, { seed: boolFlag(flags, "seed") });
  process.stdout.write(
    `${result.ok ? "✅" : "❌"} replay(${result.mode}) 期望 ${result.expectedInvariant}，得到 ${
      result.observedInvariant ?? "无"
    }\n  ${result.detail ?? ""}\n`,
  );
  return result.ok ? 0 : 1;
}

async function commandShrink(file: string | undefined): Promise<number> {
  if (!file) {
    process.stderr.write("用法：chaos shrink <artifact.json>\n");
    return 2;
  }
  const result = await shrinkArtifact(file);
  process.stdout.write(
    `${result.ok ? "✅" : "❌"} shrink 后仍复现 ${result.invariant ?? result.expectedInvariant}\n` +
      `  原始 ${result.originalLength} 步 → 最小 ${result.shrunkLength} 步（numShrinks=${result.numShrinks}）\n`,
  );
  return result.ok ? 0 : 1;
}

/** A fixed, readable fault chain: start a run, kill its worker, watch recovery, fault the external API. */
async function commandDemo(flags: Record<string, string | boolean>): Promise<number> {
  const bug = bugFrom(flags);
  const session = await Session.start({ bug });
  const trace = new Trace();
  const chain: Command[] = [
    { kind: "action", name: "createProject", params: {} },
    { kind: "action", name: "createRun", params: { projectIndex: 0 } },
    { kind: "action", name: "startWorker", params: { runIndex: 0 } },
    { kind: "action", name: "refresh", params: { runIndex: 0 } },
    { kind: "action", name: "settle", params: { ms: 300 } },
    { kind: "fault", name: "killWorker", params: { runIndex: 0 } },
    { kind: "action", name: "settle", params: { ms: 400 } },
    { kind: "action", name: "continueRun", params: { runIndex: 0 } },
    ...(session.hasExternalFaults
      ? ([
          { kind: "fault", name: "externalLatency", params: { latencyMs: 900 } },
          { kind: "action", name: "startWorker", params: { runIndex: 0 } },
          { kind: "action", name: "settle", params: { ms: 400 } },
          { kind: "action", name: "clearFaults", params: {} },
        ] as Command[])
      : []),
    { kind: "action", name: "settle", params: { ms: 400 } },
  ];

  process.stdout.write(`chaos demo（bug=${bug ?? "none"}，外部故障=${session.hasExternalFaults}）\n`);
  try {
    await session.reset();
    resetHttpLog();
    for (const command of chain) {
      await executeCommand(session, command, trace);
      const label = `${command.kind}:${command.name}`;
      await sleep(Math.min(settleWindowFor(command), 400));
      const snapshot = await session.snapshot();
      process.stdout.write(
        `  ${label.padEnd(26)} runs=[${snapshot.runs
          .map((run) => `${run.id}:${run.state}(workers=${run.activeWorkers.length})`)
          .join(" ")}]\n`,
      );
    }
    await sleep(400);
    const final = await session.snapshot();
    process.stdout.write(
      `最终：${final.runs
        .map((run) => `${run.id} ${run.state} effects=${run.effectTokens.length} crashed=${run.crashedWorkers}`)
        .join("; ")}\n`,
    );
    process.stdout.write(`invariant 检查：${invariantDefinitions.map((definition) => definition.name).join(", ")}\n`);
    return 0;
  } finally {
    await session.close().catch(() => undefined);
  }
}
