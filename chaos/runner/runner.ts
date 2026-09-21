import fc from "fast-check";
import { Session } from "../sut/session.ts";
import type { BugName } from "../sut/server.ts";
import { get, resetHttpLog, sleep, httpLog } from "../sut/http.ts";
import { actionDefinitions } from "../actions/index.ts";
import { allFaultDefinitions, processFaultDefinitions } from "../faults/index.ts";
import { checkInvariants, invariantDefinitions } from "../invariants/index.ts";
import { buildSequenceArbitrary, describeCommand, type Command } from "../model/commands.ts";
import { InvariantViolation, Trace, type ActionDefinition, type FaultDefinition } from "../types.ts";
import { saveArtifact, type FailureArtifact } from "./artifacts.ts";

export const KNOWN_FAULTS = new Map(allFaultDefinitions.map((definition) => [definition.name, definition]));
export const KNOWN_ACTIONS = new Map(actionDefinitions.map((definition) => [definition.name, definition]));

/** How long to keep observing the system after each command. */
const SETTLE_WINDOWS: Record<string, number> = {
  killWorker: 900,
  pauseWorker: 200,
  externalLatency: 350,
  externalDisconnect: 350,
  externalDown: 350,
  startWorker: 700,
  restartWorker: 900,
  continueRun: 700,
  stopWorker: 700,
  cancelRun: 700,
};
const DEFAULT_SETTLE_MS = 80;
const POLL_INTERVAL_MS = 50;

export interface ChaosRunOptions {
  bug?: BugName | null;
  numRuns?: number;
  seed?: number;
  maxCommands?: number;
  external?: boolean;
  quiet?: boolean;
  session?: Session;
  save?: boolean;
}

export interface ChaosRunResult {
  failed: boolean;
  seed: number;
  numRuns: number;
  invariant?: string;
  originalLength: number;
  shrunkLength: number;
  numShrinks: number;
  replayPath?: string;
  artifactPath?: string;
  replayOk?: boolean;
  allInvariants: string[];
}

export function availableFaults(hasExternal: boolean): FaultDefinition[] {
  return hasExternal ? allFaultDefinitions : processFaultDefinitions;
}

export async function executeCommand(
  session: Session,
  command: Command,
  trace: Trace,
  faults: Map<string, FaultDefinition> = KNOWN_FAULTS,
  actions: Map<string, ActionDefinition> = KNOWN_ACTIONS,
): Promise<void> {
  if (command.kind === "fault") {
    const definition = faults.get(command.name);
    if (!definition) {
      trace.note(`unknown fault ${command.name}`);
      return;
    }
    // A fault that cannot be applied must never masquerade as a system bug.
    try {
      await session.faults.inject(definition, command.params, trace);
    } catch (error) {
      trace.note(`fault ${command.name} 注入失败`, (error as Error).message);
    }
    return;
  }
  const definition = actions.get(command.name);
  if (!definition) {
    trace.note(`unknown action ${command.name}`);
    return;
  }
  await definition.run({ session, trace, params: command.params });
}

async function observeUntil(session: Session, trace: Trace, label: string, windowMs: number): Promise<void> {
  const deadline = Date.now() + windowMs;
  let recorded = false;
  for (;;) {
    const snapshot = await session.snapshot();
    if (!recorded) {
      trace.observe(snapshot, label);
      recorded = true;
    }
    await checkInvariants({ session, snapshot, now: Date.now() });
    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }
}

export function settleWindowFor(command: Command): number {
  return SETTLE_WINDOWS[command.name] ?? DEFAULT_SETTLE_MS;
}

export async function runSequence(
  session: Session,
  commands: Command[],
  trace: Trace,
  finalSettleMs: number,
): Promise<void> {
  for (const command of commands) {
    await executeCommand(session, command, trace);
    await observeUntil(session, trace, describeCommand(command), settleWindowFor(command));
  }
  await observeUntil(session, trace, "final-settle", finalSettleMs);
}

export function finalSettleFor(bug: BugName | null): number {
  if (bug === "stuck-recovery") return 2_800;
  if (bug === "duplicate-effect") return 1_600;
  return 700;
}

interface RecordedFailure {
  commands: Command[];
  error: unknown;
}

async function prepareIteration(session: Session): Promise<void> {
  const scratch = new Trace();
  await session.faults.recoverAll(scratch).catch(() => undefined);
  await session.reset();
  resetHttpLog();
}

export async function chaosRun(options: ChaosRunOptions = {}): Promise<ChaosRunResult> {
  const bug = options.bug ?? null;
  const ownsSession = options.session === undefined;
  const session = options.session ?? (await Session.start({ bug, external: options.external }));

  try {
    const faults = availableFaults(session.hasExternalFaults);
    const sequenceArbitrary = buildSequenceArbitrary(actionDefinitions, faults, options.maxCommands ?? 12);
    const finalSettleMs = finalSettleFor(bug);

    let firstFailure: RecordedFailure | null = null;

    const property = fc.asyncProperty(sequenceArbitrary, async (commands: Command[]) => {
      const trace = new Trace();
      await prepareIteration(session);
      try {
        await runSequence(session, commands, trace, finalSettleMs);
      } catch (error) {
        if (!firstFailure) firstFailure = { commands: [...commands], error };
        throw error;
      }
    });

    const details = await fc.check(property, {
      numRuns: options.numRuns ?? 12,
      seed: options.seed,
    });

    if (!details.failed) {
      if (!options.quiet) {
        process.stdout.write(
          `chaos: ${details.numRuns} 轮全部通过（bug=${bug ?? "none"}，seed=${details.seed}，invariants=${invariantDefinitions.length}）\n`,
        );
      }
      return {
        failed: false,
        seed: details.seed,
        numRuns: details.numRuns,
        originalLength: 0,
        shrunkLength: 0,
        numShrinks: 0,
        allInvariants: invariantDefinitions.map((definition) => definition.name),
      };
    }

    const shrunk = ((details.counterexample?.[0] as Command[] | undefined) ?? []).slice();
    const violation = details.errorInstance instanceof InvariantViolation ? details.errorInstance : null;
    const original = firstFailure?.commands ?? shrunk;

    // Replay the shrunk sequence once for a clean, artifact-ready trace.
    const replayTrace = new Trace();
    await prepareIteration(session);
    let replayError: unknown = details.errorInstance;
    try {
      await runSequence(session, shrunk, replayTrace, finalSettleMs);
    } catch (error) {
      replayError = error;
    }
    let replayViolation = replayError instanceof InvariantViolation ? replayError : violation;
    let replayOk = replayError instanceof InvariantViolation;
    let replayedSequence = shrunk;
    if (!replayOk && original !== shrunk) {
      // Shrunk counterexample was not reproducible standalone: fall back to the
      // original sequence so the artifact always describes a real failure.
      const fallbackTrace = new Trace();
      await prepareIteration(session);
      try {
        await runSequence(session, original, fallbackTrace, finalSettleMs);
      } catch (error) {
        if (error instanceof InvariantViolation) {
          replayViolation = error;
          replayOk = true;
          replayedSequence = original;
          replayTrace.timeline.length = 0;
          replayTrace.entries.length = 0;
          replayTrace.timeline.push(...fallbackTrace.timeline);
          replayTrace.entries.push(...fallbackTrace.entries);
          for (const run of fallbackTrace.ids.runs) replayTrace.ids.runs.add(run);
          for (const worker of fallbackTrace.ids.workers) replayTrace.ids.workers.add(worker);
          for (const project of fallbackTrace.ids.projects) replayTrace.ids.projects.add(project);
        }
      }
    }
    const stats = await get<{ requests: { token: string; at: number }[] }>(`${session.upstreamUrl}/stats`).catch(
      () => ({ requests: [] }),
    );

    const artifact: FailureArtifact = {
      schema: 1,
      createdAt: new Date().toISOString(),
      invariant: replayViolation?.invariant ?? String((replayError as Error)?.message ?? "unknown"),
      detail: replayViolation?.detail ?? String((replayError as Error)?.message ?? replayError),
      seed: details.seed,
      replayPath: details.counterexamplePath ?? "",
      originalSequence: original,
      shrunkSequence: shrunk,
      replaySequence: replayedSequence,
      reproducible: replayOk,
      actionSequence: replayedSequence.filter((command) => command.kind === "action"),
      faultSequence: replayedSequence.filter((command) => command.kind === "fault"),
      apiRequests: [...httpLog],
      externalRequests: stats.requests,
      ids: {
        projects: [...replayTrace.ids.projects],
        runs: [...replayTrace.ids.runs],
        workers: [...replayTrace.ids.workers],
      },
      stateTimeline: replayTrace.timeline,
      logs: replayTrace.notes,
      sut: {
        bug,
        controlUrl: session.client.baseUrl,
        externalUrl: session.externalUrl,
        upstreamUrl: session.upstreamUrl,
      },
    };
    const artifactPath = options.save === false ? undefined : saveArtifact(artifact);

    if (!options.quiet) {
      process.stdout.write(
        `chaos: 发现 invariant 失败 ${artifact.invariant}\n` +
          `  seed=${details.seed} path=${details.counterexamplePath}\n` +
          `  原始序列 ${original.length} 步 → shrink 到 ${shrunk.length} 步（numShrinks=${details.numShrinks}）\n` +
          `  artifact=${artifactPath ?? "(未保存)"}\n`,
      );
    }

    return {
      failed: true,
      seed: details.seed,
      numRuns: details.numRuns,
      invariant: artifact.invariant,
      originalLength: original.length,
      shrunkLength: shrunk.length,
      numShrinks: details.numShrinks,
      replayPath: details.counterexamplePath ?? "",
      artifactPath,
      replayOk,
      allInvariants: invariantDefinitions.map((definition) => definition.name),
    };
  } finally {
    if (ownsSession) await session.close().catch(() => undefined);
  }
}
