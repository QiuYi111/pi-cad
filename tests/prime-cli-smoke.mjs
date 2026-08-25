import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const project = resolve(import.meta.dirname, "..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent-plan-c-upstream"));
const tsx = join(primeRoot, "node_modules/.bin/tsx");
const fixture = mkdtempSync(join(tmpdir(), "prime-plan-c-cli-"));
try {
  const dataHome = join(fixture, "authority-data");
  const projectKey = createHash("sha256").update(realpathSync(fixture)).digest("hex");
  const canonicalProject = join(dataHome, "pi-cad", projectKey);
  const setup = spawnSync(tsx, [join(project, "tests/setup-prime-plan-c-fixture.ts"), fixture], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, PI_CAD_REPO: project, PI_CAD_CANONICAL_PROJECT_DIR: canonicalProject },
  });
  assert.equal(setup.status, 0, setup.stderr);
  copyFileSync(join(project, "tests/fixtures/prime-faux-ipython-extension.ts"), join(fixture, "prime-faux-ipython-extension.ts"));

  const capture = join(fixture, "provider-contexts.jsonl");
  const primeEnv = { ...process.env };
  delete primeEnv.HTTP_PROXY;
  delete primeEnv.HTTPS_PROXY;
  delete primeEnv.ALL_PROXY;
  const run = spawnSync(process.execPath, [
    join(project, "scripts/prime-cad-sidecar.mjs"),
    "--extension", "/workspace/prime-faux-ipython-extension.ts",
    "--daemon-socket", "/workspace/daemon.sock",
    "--provider", "faux",
    "--model", "faux",
    "--no-session",
    "--mode", "json",
    "--print", "Exercise the Plan C Prime kernel boundary.",
  ], {
    cwd: project,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...primeEnv,
      PRIME_AGENT_REPO: primeRoot,
      PRIME_AGENT_CODING_AGENT_DIR: join(fixture, "prime-agent"),
      PRIME_AGENT_SESSION_DIR: join(fixture, "sessions"),
      PRIME_AGENT_KERNEL_VENV: process.env.PRIME_AGENT_KERNEL_VENV ?? resolve(homedir(), ".prime-plan-c/test-kernel-venv"),
      PI_OFFLINE: "0",
      NO_PROXY: "pypi.org,files.pythonhosted.org,registry.npmjs.org",
      PI_CAD_PROJECT_CWD: fixture,
      PI_CAD_REPO: project,
      XDG_DATA_HOME: dataHome,
    },
  });
  assert.equal(run.status, 42, `${run.stderr}\n${run.stdout}`);
  assert.match(run.stderr, /WORKFLOW_INCOMPLETE/);
  const contexts = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.match(JSON.stringify(contexts[0]), /<name>cad<\/name>/);
  const events = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const toolEnds = events.filter((event) => event.type === "tool_execution_end");
  const toolText = toolEnds.flatMap((event) => event.result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.ok(toolEnds.every((event) => event.isError !== true), toolText);
  assert.match(toolText, /CAD_IMPORT/);
  assert.match(toolText, /CAD_COMMIT[^\n]*commit-[a-f0-9]{32}/);
  assert.match(toolText, /CAD_LOAD[^\n]*41/);
  assert.match(toolText, /CAD_PERSIST[^\n]*42/);
  assert.ok(events.some((event) => event.type === "message_end" && JSON.stringify(event.message).includes("PRIME_PLAN_C_SMOKE_OK")));

  assert.equal(contexts.length, 3);
  const firstCard = JSON.stringify(contexts[0]);
  const laterCards = contexts.slice(1).map((context) => JSON.stringify(context));
  assert.match(firstCard, /MUST.*provider-handoff/);
  assert.doesNotMatch(firstCard, /record provider-handoff@/);
  for (const card of laterCards) {
    assert.match(card, /record provider-handoff@/);
    assert.doesNotMatch(card, /MUST.*- provider-handoff/);
  }
  const imageBase64 = readFileSync(join(fixture, "mandatory.png")).toString("base64");
  for (const context of contexts) {
    const rendered = JSON.stringify(context);
    assert.match(rendered, /Prime provider boundary/);
    for (const heading of ["WHERE", "GOAL", "SOP", "MUST", "CAN", "NEXT", "STATE", "WARNINGS"]) assert.match(rendered, new RegExp(heading));
    assert.doesNotMatch(rendered, /PLAN_C_ORDINARY_CANARY_MUST_STAY_OUT/);
    const images = context.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((item) => item.type === "image");
    assert.equal(images.length, 1, JSON.stringify(context.messages.map((message) => ({ role: message.role, content: Array.isArray(message.content) ? message.content.map((item) => item.type) : typeof message.content }))));
    assert.equal(images[0].data, imageBase64);
  }

  const crossCapture = join(fixture, "provider-contexts-cross.jsonl");
  writeFileSync(join(fixture, ".prime-plan-c-load-mode"), "1\n");
  const cross = spawnSync(process.execPath, [
    join(project, "scripts/prime-cad-sidecar.mjs"),
    "--extension", "/workspace/prime-faux-ipython-extension.ts",
    "--daemon-socket", "/workspace/daemon-cross.sock",
    "--provider", "faux",
    "--model", "faux",
    "--no-session",
    "--mode", "json",
    "--print", "Load the existing Plan C commit in a new Prime session.",
  ], {
    cwd: project,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...primeEnv,
      PRIME_AGENT_REPO: primeRoot,
      PRIME_AGENT_CODING_AGENT_DIR: join(fixture, "prime-agent-cross"),
      PRIME_AGENT_SESSION_DIR: join(fixture, "sessions-cross"),
      PRIME_AGENT_KERNEL_VENV: process.env.PRIME_AGENT_KERNEL_VENV ?? resolve(homedir(), ".prime-plan-c/test-kernel-venv"),
      PI_OFFLINE: "0",
      NO_PROXY: "pypi.org,files.pythonhosted.org,registry.npmjs.org",
      PI_CAD_PROJECT_CWD: fixture,
      PI_CAD_REPO: project,
      XDG_DATA_HOME: dataHome,
    },
  });
  assert.equal(cross.status, 42, `${cross.stderr}\n${cross.stdout}`);
  assert.match(cross.stderr, /WORKFLOW_INCOMPLETE/);
  const crossEvents = cross.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const crossToolText = crossEvents.filter((event) => event.type === "tool_execution_end").flatMap((event) => event.result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
  assert.match(crossToolText, /CAD_CROSS_SESSION[^\n]*commit-[a-f0-9]{32}[^\n]*41/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
