import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mechanicalContextCompiler } from "../src/domains/mechanical/context-providers.ts";
import { mechanicalRegistries } from "../src/domains/mechanical/registries.ts";
import { TransactionStore } from "../src/harness/transaction-store.ts";

test("restricted Context Providers read only bounded committed snapshots and report metrics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cad-context-v7-"));
  try {
    const project = new TransactionStore(join(cwd, ".pi-cad", "v7-project"));
    const run = new TransactionStore(join(cwd, ".pi-cad", "runs", "v7-context"));
    await project.commit({ expectedGeneration: 0, payloads: { "state.json": { schema: 1, projectId: "p", currentRunId: "v7-context" } }, event: { type: "ProjectStarted" } });
    await run.commit({
      expectedGeneration: 0,
      payloads: {
        "state.json": { schemaVersion: 7, kernelVersion: "v7", phase: "review", status: "active" },
        "workflow.json": { phases: { review: { actions: ["cad_probe"], recordObligations: [], evidenceObligations: [{ ref: "simulation:case-1" }], transitions: { accepted: { target: "ready" } } } } },
        "registry-contract.json": { schema: 1, hash: "a".repeat(64) },
        "context/frame.json": { schema: 1, mission: "Keep the load path explicit." },
        "indexes/observations.json": { schema: 1, latest: [{ id: "obs-1", headline: "No collision" }] },
        "indexes/runtime-availability.json": { schema: 1, runtimes: [{ id: "openfoam/openfoam-14", status: "unknown" }] },
      },
      event: { type: "RunStarted" },
    });
    const runRoot = join(cwd, ".pi-cad", "runs", "v7-context");
    const largeJournal = `${"x".repeat(1024)}\n`.repeat(10_000);
    await Promise.all([
      writeFile(join(runRoot, "events.jsonl"), largeJournal),
      writeFile(join(runRoot, "refs.jsonl"), largeJournal),
      writeFile(join(runRoot, "observations.jsonl"), largeJournal),
      mkdir(join(runRoot, "reviews")),
      mkdir(join(runRoot, "historical-runs")),
    ]);
    await Promise.all(Array.from({ length: 1_000 }, (_, index) => Promise.all([
      writeFile(join(runRoot, "reviews", `${index}.json`), "{}\n"),
      writeFile(join(runRoot, "historical-runs", `${index}.json`), "{}\n"),
    ])));

    const compiler = mechanicalContextCompiler(mechanicalRegistries);
    const result = await compiler.compile({
      project,
      run,
      providerIds: ["kernel.current-action", "kernel.current-action", "mechanical.mission", "mechanical.observations", "mechanical.runtime-availability"],
      allowedIndexes: new Set(["observations", "runtime-availability"]),
      aggregateReadBudget: 1024 * 1024,
      aggregateEmitBudget: 128 * 1024,
    });
    assert.match(result.text, /simulation:case-1/);
    assert.match(result.text, /Keep the load path explicit/);
    assert.equal(result.metrics.length, 5);
    assert.equal(result.metrics[1]!.cacheHit, true);
    assert.equal(result.metrics[1]!.bytesRead, 0);
    assert.ok(result.metrics.reduce((sum, metric) => sum + metric.bytesRead, 0) < 1024 * 1024);
    assert.ok(result.metrics.every((metric) => metric.bytesEmitted <= 32768));
    const durations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      await compiler.compile({ project, run, providerIds: ["kernel.current-action", "mechanical.observations"], allowedIndexes: new Set(["observations"]), aggregateReadBudget: 1024 * 1024, aggregateEmitBudget: 64 * 1024 });
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    assert.ok(durations[Math.ceil(durations.length * 0.95) - 1]! <= 250, `warm context p95 exceeded 250ms: ${durations.join(",")}`);
    await assert.rejects(
      compiler.compile({ project, run, providerIds: ["mechanical.observations"], allowedIndexes: new Set(), aggregateReadBudget: 1024, aggregateEmitBudget: 1024 }),
      /index is not registered/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
