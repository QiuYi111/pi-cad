import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = join(root, ".pi-cad", "qualifications", "torch-fem-cuda");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { managedSimulationRunner } = await jiti.import("../src/modules/simulate-v2/runtime.ts");
const { buildStep } = await jiti.import("../src/shared/capability.ts");
const { createIntakeState } = await jiti.import("../src/core/state-machine.ts");
const { commitSimulation } = await jiti.import("../src/extensions/simulation/v2.ts");
const { createSimulationRun } = await jiti.import("../src/modules/simulate-v2/store.ts");
const { CadProjectStore, sha256File } = await jiti.import("../src/shared/store.ts");

function spec(device, meshSize = 4, youngsModulus = 70000) {
  return {
    backend: "torch-fem",
    device,
    physics: { type: "linear_elasticity" },
    mesh: { element: "tet", box: [40, 8, 8], size: meshSize },
    materials: [{ name: "qualification", E: youngsModulus, nu: 0.33 }],
    constraints: [{ type: "fixed", region: { axis: "x", side: "min" } }],
    loads: [{ type: "nodal_force", region: { axis: "x", side: "max" }, vector: [0, 0, -100], distribute: "total" }],
    sensitivity: { type: "compliance_by_youngs_modulus" },
  };
}

async function executeCase(runtime, device, label = runtime, meshSize = 4, youngsModulus = 70000) {
  const workspace = join(outputRoot, label);
  await rm(workspace, { recursive: true, force: true });
  await cp(
    join(root, "skills", "structural-analysis", "assets", "recipes", "torch-fem-linear-elastic"),
    workspace,
    { recursive: true },
  );
  await writeFile(join(workspace, "case.json"), `${JSON.stringify(spec(device, meshSize, youngsModulus), null, 2)}\n`);
  const runtimeIdentity = await managedSimulationRunner.resolveRuntime(root, "torch-fem", runtime);
  const result = await managedSimulationRunner.execute({
    cwd: root,
    backend: "torch-fem",
    runtime,
    workspace,
    recipeDirectory: workspace,
    command: "bash Allrun",
    environment: {},
    stdoutPath: join(workspace, "stdout.log"),
    stderrPath: join(workspace, "stderr.log"),
    timeoutMs: 20 * 60 * 1000,
  });
  if (result.exitCode !== 0) throw new Error(`${runtime} failed: ${result.diagnostics.join("\n")}`);
  const payload = JSON.parse(await readFile(join(workspace, "result.json"), "utf8"));
  if (payload.status !== "solved") throw new Error(`${runtime} did not solve: ${JSON.stringify(payload)}`);
  if (payload.actualDevice !== device) throw new Error(`${runtime} requested ${device}, got ${payload.actualDevice}`);
  if (!payload.sensitivity || !Number.isFinite(payload.sensitivity.dCompliance_dE)) {
    throw new Error(`${runtime} did not materialize a finite differentiable sensitivity`);
  }
  return { runtimeIdentity, payload };
}

async function executeV2Lifecycle() {
  const project = join(outputRoot, "v2-lifecycle");
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, "build"), { recursive: true });
  await mkdir(join(project, "simulation"), { recursive: true });
  const recipePath = "simulation/torch-fem-linear-elastic";
  await cp(join(root, "skills", "structural-analysis", "assets", "recipes", "torch-fem-linear-elastic"), join(project, recipePath), { recursive: true });
  const casePath = join(project, recipePath, "case.json");
  const caseData = JSON.parse(await readFile(casePath, "utf8"));
  caseData.mesh.size = 10;
  await writeFile(casePath, `${JSON.stringify(caseData, null, 2)}\n`);
  const artifact = "build/model.step";
  const built = await buildStep(project, { source: join(root, "tests", "fixtures", "plate.py"), output: join(project, artifact), force: true });
  assert.equal(built.ok, true, JSON.stringify(built.payload));
  const store = new CadProjectStore(project);
  const workflow = await store.createRun({ runId: "qualification-v2" });
  await workflow.save({
    ...createIntakeState({ runId: "qualification-v2", projectId: store.projectId }),
    currentArtifactPath: artifact,
    currentArtifactHash: await sha256File(join(project, artifact)),
    evidenceObligations: { simulation: { disposition: "required", cases: [{ id: "torch-fem-cuda-qualification", tool: "cad_simulate" }] } },
  });
  const run = await createSimulationRun({
    cwd: project,
    backend: "torch-fem",
    runtime: "torch-fem-0.9-cu126",
    recipePath,
    outputs: ["reaction_magnitude", "runtime_health", "fields", "sensitivity"],
    runner: managedSimulationRunner,
  });
  assert.equal(run.run.status, "completed", JSON.stringify(run.run.entrypoint));
  assert.equal(run.observation?.validForCommit, true, JSON.stringify(run.observation));
  assert.deepEqual((await store.load())?.evidence, [], "torch-fem solve/observe must not create Evidence");
  const raw = JSON.parse(await readFile(join(run.runDirectory, "raw-project", recipePath, "result.json"), "utf8"));
  assert.equal(raw.actualDevice, "cuda");
  const evidence = await commitSimulation(project, run.run.runId, run.observation.observationId, "torch-fem-cuda-qualification");
  assert.equal((await store.load())?.evidence.length, 1);
  return { simulationRunId: run.run.runId, observationId: run.observation.observationId, evidenceId: evidence.id, actualDevice: raw.actualDevice };
}

async function executeOptimization() {
  const workspace = join(outputRoot, "optimization");
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const optimization = {
    mode: "topology_2d_rect_v0",
    device: "cuda",
    designDomain: { x: [0, 20], y: [0, 8], nx: 8, ny: 3 },
    material: { E: 1, nu: 0.3 },
    objective: { type: "compliance", sense: "minimize" },
    constraints: [{ type: "volume_fraction", max: 0.5 }],
    optimizer: { type: "mma", maxIterations: 3, penalty: 3, Emin: 0.001 },
  };
  await writeFile(join(workspace, "optimization.json"), `${JSON.stringify(optimization, null, 2)}\n`);
  const result = await managedSimulationRunner.execute({
    cwd: root,
    backend: "torch-fem",
    runtime: "torch-fem-0.9-cu126",
    workspace,
    recipeDirectory: workspace,
    command: 'uv run --offline --frozen --project "$PI_CAD_PYTHON_PROJECT" python -m cadctl optimize --spec optimization.json --output-dir results',
    environment: {},
    stdoutPath: join(workspace, "stdout.log"),
    stderrPath: join(workspace, "stderr.log"),
    timeoutMs: 20 * 60 * 1000,
  });
  if (result.exitCode !== 0) throw new Error(`managed CUDA optimization failed: ${result.diagnostics.join("\n")}`);
  const envelope = JSON.parse(result.stdout.trim());
  if (!envelope.ok || envelope.payload?.actualDevice !== "cuda") throw new Error(`optimization was not CUDA: ${result.stdout}`);
  return envelope.payload;
}

await mkdir(outputRoot, { recursive: true });
const cuda = await executeCase("torch-fem-0.9-cu126", "cuda");
const coarse = await executeCase("torch-fem-0.9-cu126", "cuda", "cuda-coarse", 8);
const cpu = await executeCase("torch-fem-0.9-cpu", "cpu");
const fdMinus = await executeCase("torch-fem-0.9-cpu", "cpu", "cpu-fd-minus", 4, 69930);
const fdPlus = await executeCase("torch-fem-0.9-cpu", "cpu", "cpu-fd-plus", 4, 70070);
const metrics = [
  ["maxDisplacement", cuda.payload.displacement.maxMagnitude, cpu.payload.displacement.maxMagnitude],
  ["maxVonMises", cuda.payload.stress.maxVonMisesElement, cpu.payload.stress.maxVonMisesElement],
  ["reactionMagnitude", cuda.payload.reaction.magnitude, cpu.payload.reaction.magnitude],
  ["dCompliance_dE", cuda.payload.sensitivity.dCompliance_dE, cpu.payload.sensitivity.dCompliance_dE],
];
for (const [name, gpu, host] of metrics) {
  const relativeError = Math.abs(gpu - host) / Math.max(Math.abs(gpu), Math.abs(host), 1e-12);
  if (relativeError > 1e-8) throw new Error(`${name} GPU/CPU relative error ${relativeError} exceeds 1e-8`);
}
assert.ok(cuda.payload.mesh.elementCount > coarse.payload.mesh.elementCount, "mesh refinement did not increase element count");
const refinementDelta = Math.abs(cuda.payload.displacement.maxMagnitude - coarse.payload.displacement.maxMagnitude) / cuda.payload.displacement.maxMagnitude;
assert.ok(refinementDelta < 0.5, `mesh refinement displacement delta ${refinementDelta} is too large`);
const finiteDifference = (fdPlus.payload.sensitivity.compliance - fdMinus.payload.sensitivity.compliance) / 140;
const gradientRelativeError = Math.abs(cuda.payload.sensitivity.dCompliance_dE - finiteDifference) / Math.abs(finiteDifference);
assert.ok(gradientRelativeError < 1e-4, `autograd/finite-difference relative error ${gradientRelativeError} exceeds 1e-4`);
const optimization = await executeOptimization();
const lifecycle = await executeV2Lifecycle();
const report = {
  schema: 1,
  qualifiedAt: new Date().toISOString(),
  status: "pass",
  cudaRuntimeIdentity: cuda.runtimeIdentity,
  cpuRuntimeIdentity: cpu.runtimeIdentity,
  comparisons: Object.fromEntries(metrics.map(([name, gpu, host]) => [name, { cuda: gpu, cpu: host, relativeError: Math.abs(gpu - host) / Math.max(Math.abs(gpu), Math.abs(host), 1e-12) }])),
  meshRefinement: { coarseElements: coarse.payload.mesh.elementCount, fineElements: cuda.payload.mesh.elementCount, relativeDisplacementDelta: refinementDelta },
  gradient: { autograd: cuda.payload.sensitivity.dCompliance_dE, finiteDifference, relativeError: gradientRelativeError },
  cuda: {
    requestedDevice: cuda.payload.requestedDevice,
    actualDevice: cuda.payload.actualDevice,
    mesh: cuda.payload.mesh,
    reaction: cuda.payload.reaction,
    sensitivity: cuda.payload.sensitivity,
  },
  optimization: {
    actualDevice: optimization.actualDevice,
    iterations: optimization.iterations,
    bestObjective: optimization.bestObjective,
    finalVolumeFraction: optimization.finalVolumeFraction,
  },
  lifecycle,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(join(outputRoot, "qualification-report.json"), serialized);
console.log(JSON.stringify({
  status: report.status,
  report: join(outputRoot, "qualification-report.json"),
  reportSha256: createHash("sha256").update(serialized).digest("hex"),
  gpu: report.cudaRuntimeIdentity.accelerator,
  comparisons: report.comparisons,
  meshRefinement: report.meshRefinement,
  gradient: report.gradient,
  optimization: report.optimization,
  lifecycle: report.lifecycle,
}));
