import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { inspectGeometry, stopPersistentProbeWorker } = await jiti.import("../src/shared/capability.ts");
const cwd = await mkdtemp(join(tmpdir(), "pi-cad-probe-benchmark-"));
const artifact = resolve("tests/fixtures/interference_single.step");

async function timed(name, fn) {
  const started = performance.now();
  await fn();
  return { name, durationMs: Math.round(performance.now() - started) };
}

try {
  process.env.PI_CAD_PROBE_WORKER = "0";
  stopPersistentProbeWorker();
  const oneShot = [];
  for (let index = 0; index < 3; index += 1) {
    oneShot.push(await timed(`oneshot-${index + 1}`, () => inspectGeometry(cwd, artifact, join(cwd, ".pi-cad", "benchmark", `oneshot-${index}.json`), 60_000)));
  }

  process.env.PI_CAD_PROBE_WORKER = "1";
  stopPersistentProbeWorker();
  const persistent = [];
  for (let index = 0; index < 4; index += 1) {
    persistent.push(await timed(`worker-${index + 1}`, () => inspectGeometry(cwd, artifact, join(cwd, ".pi-cad", "benchmark", `worker-${index}.json`), 60_000)));
  }
  const oneShotMean = oneShot.reduce((sum, item) => sum + item.durationMs, 0) / oneShot.length;
  const warm = persistent.slice(1);
  const warmMean = warm.reduce((sum, item) => sum + item.durationMs, 0) / warm.length;
  console.log(JSON.stringify({
    schema: 1,
    command: "cadctl inspect",
    oneShot,
    persistent,
    oneShotMeanMs: Math.round(oneShotMean),
    workerColdMs: persistent[0].durationMs,
    workerWarmMeanMs: Math.round(warmMean),
    warmSpeedup: Number((oneShotMean / warmMean).toFixed(2)),
  }, null, 2));
} finally {
  stopPersistentProbeWorker();
  delete process.env.PI_CAD_PROBE_WORKER;
  await rm(cwd, { recursive: true, force: true });
}
