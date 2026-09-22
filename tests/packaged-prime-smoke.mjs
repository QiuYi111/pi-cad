// Runs the real packaged Prime, Python kernel and CAD authority with a scripted provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [bundleArg, workArg] = process.argv.slice(2);
if (!bundleArg || !workArg) throw new Error("usage: packaged-prime-smoke.mjs <installed-runtime> <test-directory>");
const bundle = resolve(bundleArg);
const work = resolve(workArg);
await mkdir(work, { recursive: true });
await mkdir(join(work, "run"), { recursive: true });
await writeFile(join(work, "part.py"), "import build123d as bd\nresult = bd.Box(10, 20, 30)\n");
const cells = [
  "import cad\nawait cad.workflow.start('mechanical.naked')\nprint('CAD_READY')",
  "artifact = await cad.model.build('part.py')\nprint('BUILD_OK', artifact.path)",
  "measurement = await cad.probe.run(subject=artifact, purpose='Measure the actual box volume', code=\"result = {'volume': shape.volume}\")\nprint('PROBE_OK', measurement.value)\nreference = await cad.model.import_step('build/part.step', 'build/reference.step')\nprint('IMPORT_OK', reference.path)",
  "await cad.workflow.advance('finished')\nprint('WORKFLOW_DONE')",
];
await writeFile(join(work, "fixture.mjs"), `
import * as ai from '/opt/prime/packages/ai/dist/index.js';
export default function(pi) {
  const faux = ai.registerFauxProvider({ provider: 'reify-release-test', models: [{ id: 'test', reasoning: false, input: ['text', 'image'] }] });
  const cells = ${JSON.stringify(cells)};
  faux.setResponses([...cells.map(code => ai.fauxAssistantMessage(ai.fauxToolCall('ipython', {code}), {stopReason:'toolUse'})), ai.fauxAssistantMessage('REIFY_RELEASE_OK')]);
  pi.registerProvider('reify-release-test', { api: faux.api, apiKey: 'test', baseUrl: faux.getModel().baseUrl, streamSimple: ai.getApiProvider(faux.api).streamSimple, models: faux.models });
}
`);
const outputFile = openSync(join(work, "stdout.jsonl"), "w");
const errorFile = openSync(join(work, "stderr.log"), "w");
const run = spawnSync(process.execPath, [join(bundle, "pi-cad/scripts/prime-cad-sidecar.mjs"),
  "--extension", "/workspace/fixture.mjs", "--provider", "reify-release-test", "--model", "test",
  "--thinking", "off", "--mode", "json", "--no-session", "--print", "Run the installation acceptance check.",
], {
  encoding: "utf8", timeout: 240_000, stdio: ["ignore", outputFile, errorFile],
  env: { ...process.env, PI_CAD_REPO: join(bundle, "pi-cad"), PRIME_AGENT_REPO: join(bundle, "prime-agent"),
    PI_CAD_PROJECT_CWD: work, PRIME_AGENT_CODING_AGENT_DIR: join(work, "agent"),
    PRIME_AGENT_KERNEL_VENV: process.env.PRIME_AGENT_KERNEL_VENV || join(work, "kernel"),
    XDG_RUNTIME_DIR: join(work, "run"), XDG_DATA_HOME: join(work, "data"),
  },
});
closeSync(outputFile);
closeSync(errorFile);
run.stdout = readFileSync(join(work, "stdout.jsonl"), "utf8");
run.stderr = readFileSync(join(work, "stderr.log"), "utf8");
assert.equal(run.status, 0, `Prime failed (${run.status}): ${(run.stderr || "").slice(-6000)}`);
const events = run.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
const tools = events.filter((event) => event.type === "tool_execution_end");
assert.equal(tools.length, 4, `Expected 4 real Python calls; got ${tools.length}. See ${work}/stdout.jsonl`);
for (const event of tools) assert.notEqual(event.isError, true, JSON.stringify(event.result).slice(0, 2500));
const text = tools.flatMap((event) => event.result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
for (const marker of ["CAD_READY", "BUILD_OK", "PROBE_OK", "IMPORT_OK", "WORKFLOW_DONE"]) assert.match(text, new RegExp(marker));
const images = tools.flatMap((event) => event.result.content || []).filter((item) => item.type === "image");
assert.equal(images.length, 14, "Build and STEP import must each attach seven actual views");
assert.match(text, /6000/);
assert.ok((await readFile(join(work, "build/part.step"))).length > 1000);
assert.ok((await readFile(join(work, "build/reference.step"))).length > 1000);
console.log(JSON.stringify({ prime: "0.9.5", pythonCalls: tools.length, images: images.length, build: "passed", probe: "passed", stepImport: "passed", workflow: "passed", evidence: work }, null, 2));
