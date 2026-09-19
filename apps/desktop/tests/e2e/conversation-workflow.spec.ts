import { expect, test, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(process.cwd(), "../..");
const WORKFLOW_ID = "test/desktop-conversation";
/**
 * One phase that is acknowledged by a transition. The suite starts Run A for
 * one conversation and advances it to the terminal phase, and leaves Run B of
 * the other conversation in its first, non-terminal phase.
 */
const WORKFLOW_PACKAGE = `schema: 1
id: ${WORKFLOW_ID}
description: Desktop conversation lifecycle fixture.
tags: [test]
version: 1.0.0
workflow:
  schema: 1
  id: ${WORKFLOW_ID}
  version: 1.0.0
  parametersSchema: {type: object, additionalProperties: false}
  initialPhase: inspect
  phases:
    inspect:
      purpose: Acknowledge inspection.
      actions: [transition]
      grants: [file_read, transition]
      writeScopes: []
      recordObligations: []
      evidenceObligations: []
      contextProviders: [kernel.current-action]
      hooks: []
      transitions: {checked: {target: done}}
    done:
      purpose: Preserve the acknowledged inspection.
      actions: []
      grants: [file_read]
      writeScopes: []
      recordObligations: []
      evidenceObligations: []
      contextProviders: []
      hooks: []
      transitions: {}
      terminal: true
`;

interface Fixture {
  root: string;
  appRoot: string;
  project: string;
  workflowHome: string;
  canonical: string;
  userData: string;
}

/**
 * The suite runs the real Reify authority (Agent API, run store, conversation
 * bindings, workflow packages) and drives the real Desktop window and main
 * process. Only Prime's own turns come from the deterministic demo runtime, so
 * the conversation scoping under test is production code from the renderer
 * down to the authority.
 */
async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "reify-conversation-lifecycle-"));
  const appRoot = join(root, "app");
  await mkdir(appRoot, { recursive: true });
  await cp(join(process.cwd(), "out"), join(appRoot, "out"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await cp(join(process.cwd(), "node_modules/yaml"), join(appRoot, "node_modules/yaml"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "reify-conversation-lifecycle", version: "0.0.0", type: "module", main: "out/main/index.js" }));
  const project = join(root, "project");
  const workflowHome = join(root, "workflow-home");
  const canonical = join(root, "canonical");
  const userData = join(root, "user-data");
  await mkdir(join(project, ".prime-sessions"), { recursive: true });
  await mkdir(join(workflowHome, ".pi-cad", "workflows"), { recursive: true });
  await mkdir(canonical, { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(join(workflowHome, ".pi-cad", "workflows", "desktop-conversation.yaml"), WORKFLOW_PACKAGE);
  // Prime names a session after its transcript, and the Desktop lists
  // conversations by transcript, so these files are the two conversations.
  for (const [id, title] of [["conv-a", "Conversation A"], ["conv-b", "Conversation B"]] as const) {
    await writeFile(join(project, ".prime-sessions", `${id}.jsonl`), [
      JSON.stringify({ type: "session_info", name: title }),
      JSON.stringify({ type: "message", message: { role: "user", content: `${title} brief` } }),
      "",
    ].join("\n"));
  }
  return { root, appRoot, project, workflowHome, canonical, userData };
}

/** Call the same Agent API the Desktop main process uses. */
function agentApi(fixture: Fixture, request: Record<string, unknown>): any {
  const stdout = execFileSync(process.execPath, [join(REPO_ROOT, "scripts/pi-cad-agent-api.mjs"), "agent-api", fixture.project], {
    input: JSON.stringify({ schema: 1, ...request }),
    env: {
      ...process.env,
      PI_CAD_PROJECT_CWD: fixture.project,
      PI_CAD_CANONICAL_PROJECT_DIR: fixture.canonical,
      PI_CAD_WORKFLOW_HOME: fixture.workflowHome,
    },
    encoding: "utf8",
  });
  const response = JSON.parse(stdout) as { ok: boolean; result?: unknown; error?: { message?: string } };
  if (!response.ok) throw new Error(response.error?.message ?? "Agent API request failed");
  return response.result;
}

async function launch(fixture: Fixture) {
  const executablePath = join(process.cwd(), "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron");
  await chmod(executablePath, 0o755).catch(() => undefined);
  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${fixture.userData}`, fixture.appRoot, "--pi-cad-e2e", "--pi-cad-e2e-workflow-authority"],
    env: {
      ...process.env,
      PI_CAD_DESKTOP_E2E: "1",
      PI_CAD_DESKTOP_E2E_REAL_TRACES: "1",
      PI_CAD_DESKTOP_E2E_WORKFLOW_AUTHORITY: "1",
      PI_CAD_PROJECT_CWD: fixture.project,
      PI_CAD_REPO: REPO_ROOT,
      PI_CAD_CANONICAL_PROJECT_DIR: fixture.canonical,
      PI_CAD_WORKFLOW_HOME: fixture.workflowHome,
    },
  });
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await page.waitForTimeout(300);
  // The first launch shows the first-run screen; a relaunch goes straight to
  // the workbench because onboarding is already complete.
  const enter = page.getByRole("button", { name: "进入 Reify" });
  const composer = page.getByPlaceholder("Ask anything about the design");
  await expect(enter.or(composer).first()).toBeVisible({ timeout: 30_000 });
  if (await enter.isVisible()) await enter.click();
  await expect(composer).toBeVisible({ timeout: 30_000 });
  return { application, page };
}

function workflow(page: import("@playwright/test").Page) {
  return page.evaluate(async () => await window.piCad.workflow.current());
}

/** Open a conversation from the sidebar. The suite's reads spawn real
 * processes, so the click waits through a cold or busy authority. */
async function openConversation(page: import("@playwright/test").Page, title: string) {
  const open = page.locator(".sidebar-session").filter({ hasText: title }).getByRole("button");
  try {
    await open.click({ timeout: 90_000 });
  } catch (error) {
    // A missing row means the conversation list itself failed, so record what
    // the sidebar and the trace store actually said.
    console.log("[conversations unavailable]", JSON.stringify(await page.locator(".conversation-sidebar").innerText().catch(() => "?")));
    console.log("[trace store]", JSON.stringify(await page.evaluate(async () => (await window.piCad.traces.list()).map((item) => item.id)).catch((reason: Error) => `ERR ${reason.message}`)));
    throw error;
  }
}

test("each Desktop conversation keeps its own workflow across new, switch and restart", async () => {
  const fixture = await createFixture();
  let application: Awaited<ReturnType<typeof launch>>["application"] | undefined;
  try {
    // Conversation A reaches its terminal phase; conversation B starts its own
    // run and stays in the non-terminal first phase.
    const runA = agentApi(fixture, { op: "workflow-start", id: WORKFLOW_ID, sessionId: "conv-a" }) as { runId: string };
    agentApi(fixture, { op: "workflow-advance", event: "checked", sessionId: "conv-a" });
    const runB = agentApi(fixture, { op: "workflow-start", id: WORKFLOW_ID, sessionId: "conv-b" }) as { runId: string };
    expect(runB.runId).not.toBe(runA.runId);

    let launched = await launch(fixture);
    application = launched.application;
    let page = launched.page;
    const rail = page.getByTestId("workflow-rail");

    // No conversation is selected yet, so there is no workflow to show.
    await expect(rail).toContainText("No active workflow");

    // Conversation A shows its own finished run, never B's.
    await openConversation(page, "Conversation A");
    await expect.poll(async () => (await workflow(page))?.runId, { timeout: 60_000 }).toBe(runA.runId);
    expect((await workflow(page))?.status).toBe("done");
    await expect(rail).toContainText("Inspect", { timeout: 60_000 });
    await expect(rail.locator(".rail-step.complete")).toHaveCount(2);

    // A new conversation is unbound immediately: it does not inherit A's final
    // state, and its own first turn opens a Prime session with no binding.
    await page.getByRole("button", { name: "新对话" }).click();
    await expect(rail).toContainText("No active workflow", { timeout: 60_000 });
    await expect.poll(async () => (await workflow(page))?.runId, { timeout: 60_000 }).toBeUndefined();
    await page.getByPlaceholder("Ask anything about the design").fill("Provider retry please");
    await page.getByPlaceholder("Ask anything about the design").press("Enter");
    await expect(page.getByText("Recovered after one retry.")).toBeAttached({ timeout: 30_000 });
    await expect(rail).toContainText("No active workflow", { timeout: 60_000 });
    expect((await workflow(page))?.runId).toBeUndefined();

    // Conversation B restores its own non-terminal run.
    await openConversation(page, "Conversation B");
    await expect.poll(async () => (await workflow(page))?.runId, { timeout: 60_000 }).toBe(runB.runId);
    expect((await workflow(page))?.status).toBe("active");
    await expect(rail.locator(".rail-step.active")).toHaveText(/Inspect/, { timeout: 60_000 });

    // Back and forth: neither conversation adopts the other's run.
    await openConversation(page, "Conversation A");
    await expect.poll(async () => (await workflow(page))?.runId, { timeout: 60_000 }).toBe(runA.runId);
    await expect(rail.locator(".rail-step.complete")).toHaveCount(2);
    await openConversation(page, "Conversation B");
    await expect.poll(async () => (await workflow(page))?.runId, { timeout: 60_000 }).toBe(runB.runId);
    await expect(rail.locator(".rail-step.active")).toHaveText(/Inspect/, { timeout: 60_000 });

    // Restart the Desktop: both conversations still restore their own run.
    await application.close();
    launched = await launch(fixture);
    application = launched.application;
    page = launched.page;
    const restartedRail = page.getByTestId("workflow-rail");
    await openConversation(page, "Conversation A");
    await expect.poll(async () => (await workflow(page))?.runId, { timeout: 60_000 }).toBe(runA.runId);
    await expect(restartedRail.locator(".rail-step.complete")).toHaveCount(2, { timeout: 60_000 });
    await openConversation(page, "Conversation B");
    await expect.poll(async () => (await workflow(page))?.runId, { timeout: 60_000 }).toBe(runB.runId);
    await expect(restartedRail.locator(".rail-step.active")).toHaveText(/Inspect/, { timeout: 60_000 });
    expect((await workflow(page))?.status).toBe("active");
  } finally {
    await application?.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
  }
});
