import { expect, test, _electron as electron, type Page } from "@playwright/test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSettings, RuntimeStatus } from "../../src/shared/contracts";

/** A packaged copy of `out`, launched on its own settings file. */
async function launchReify(prefix: string, settings: Partial<AppSettings> & { onboardingComplete?: boolean }, args: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const appRoot = join(root, "app");
  await mkdir(appRoot, { recursive: true });
  await cp(join(process.cwd(), "out"), join(appRoot, "out"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await cp(join(process.cwd(), "node_modules/yaml"), join(appRoot, "node_modules/yaml"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "reify-thinking-level", version: "0.0.0", type: "module", main: "out/main/index.js" }));
  const executablePath = join(process.cwd(), "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron");
  await chmod(executablePath, 0o755).catch(() => undefined);

  const userData = join(root, "user-data");
  const settingsPath = join(userData, "settings.json");
  await mkdir(userData, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings));

  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, appRoot, "--pi-cad-e2e", ...args],
    env: { ...process.env, PI_CAD_DESKTOP_E2E: "1", PI_CAD_PROJECT_CWD: "/workspace/demo" },
  });
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  return { application, page, root, settingsPath };
}

/** Levels the main process published for one session, in order. */
function sessionLevels(page: Page, sessionId: string) {
  return page.evaluate((id) => {
    const seen = (window as unknown as { __reifyThinking?: Array<{ sessionId?: string; thinking?: string }> }).__reifyThinking || [];
    return seen.filter((status) => status.sessionId === id).map((status) => status.thinking);
  }, sessionId);
}

/** Every `set_thinking_level` the main process was asked for, in order. */
function thinkingAttempts(page: Page) {
  return page.evaluate(() => {
    const seen = (window as unknown as { __reifyThinkingAttempts?: string[] }).__reifyThinkingAttempts || [];
    return [...seen];
  });
}

/** Collapses the repeats the runtime publishes for one level. */
function levelChanges(levels: Array<string | undefined>) {
  return levels.filter((level, index) => level !== levels[index - 1]);
}

/** Records both the published statuses and every thinking RPC attempt. */
function recordRuntime(page: Page) {
  return page.evaluate(() => {
    const attempts: string[] = [];
    (window as unknown as { __reifyThinkingAttempts: typeof attempts }).__reifyThinkingAttempts = attempts;
    window.piCad.runtime.onEvent((event: { type?: string; message?: string }) => {
      if (event.type === "runtime_diagnostic" && event.message?.startsWith("set_thinking_level")) attempts.push(event.message);
    });
    const seen: Array<{ sessionId?: string; thinking?: string }> = [];
    (window as unknown as { __reifyThinking: typeof seen }).__reifyThinking = seen;
    window.piCad.runtime.onStatus((status: RuntimeStatus) => seen.push({ sessionId: status.sessionId, thinking: status.thinking }));
  });
}

/**
 * A stored level the model cannot run has to be folded the way Prime clamps it.
 * The demo catalog lists `zai/glm-5.3` as `off, minimal, low, medium, high`, so
 * a stored `xhigh` belongs on `high` — the closest level below it. Landing on
 * `off` instead would silently switch the user's reasoning back off.
 */
test("an authoritative catalog folds a stored thinking level without dropping reasoning", async () => {
  const { application, page, root, settingsPath } = await launchReify("reify-thinking-level-", {
    provider: "zai", model: "glm-5.3", thinking: "xhigh", onboardingComplete: true,
  });
  try {
    const effort = page.getByLabel("Effort");
    await effort.waitFor({ timeout: 30_000 });

    // The selector shows the level the model runs, not the stored `xhigh` and
    // not the first level the catalog happens to list.
    await expect(effort).toHaveValue("high", { timeout: 30_000 });
    await expect(effort.locator("option")).toHaveCount(5);

    // The fold is written back, so the runtime that reads the saved level at
    // start never sees the unsupported one either.
    await expect.poll(async () => JSON.parse(await readFile(settingsPath, "utf8")).thinking, { timeout: 30_000 }).toBe("high");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Switching sessions is the other way the setting and the sidecar drift apart:
 * the saved level does not move, the state stays `ready`, but the restored
 * session runs the level it was last used with. The renderer has to reconcile
 * that instead of assuming the level it already sent is still in force.
 */
test("a session switch reconciles the level the restored session runs", async () => {
  const { application, page, root, settingsPath } = await launchReify(
    "reify-session-thinking-",
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", onboardingComplete: true },
    ["--pi-cad-e2e-open-step=/workspace/demo/imported.step"],
  );
  try {
    await page.getByPlaceholder("Ask anything about the design").waitFor({ timeout: 20_000 });

    // Watch every status the main process publishes from here on.
    await recordRuntime(page);

    // Prime reports the level the live session holds.
    await page.evaluate(() => window.piCad.runtime.start());
    await expect.poll(() => sessionLevels(page, "desktop-e2e"), { timeout: 30_000 }).toContain("high");

    const shell = page.locator(".workbench-page");
    if (!(await shell.getAttribute("class"))?.includes("mode-conversation")) await page.keyboard.press("Control+Backslash");
    await expect(shell).toHaveClass(/mode-conversation/);
    await page.getByText("Folding stand", { exact: true }).click();

    // The restored conversation was last run at `medium`, so the renderer must
    // push the saved `high` back into the sidecar it just switched to.
    await expect.poll(() => sessionLevels(page, "demo-restored"), { timeout: 30_000 }).toContain("medium");
    await expect.poll(async () => (await sessionLevels(page, "demo-restored")).at(-1), { timeout: 30_000 }).toBe("high");
    // Reconciling the sidecar does not rewrite the saved setting.
    expect(JSON.parse(await readFile(settingsPath, "utf8")).thinking).toBe("high");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The last way the setting and the sidecar drift apart is a rejected reconcile:
 * the saved level never moves, the session state stays `ready`, and the only
 * thing that failed was the RPC. Counting the level as delivered before the RPC
 * answers — and clearing a ref on failure — would hide that split forever,
 * because nothing else would retrigger the effect. The split has to stay
 * visible and the reconciliation has to run again on its own.
 */
test("a rejected thinking reconcile is retried instead of being marked delivered", async () => {
  const { application, page, root, settingsPath } = await launchReify(
    "reify-rejected-thinking-",
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", onboardingComplete: true },
    ["--pi-cad-e2e-open-step=/workspace/demo/imported.step", "--pi-cad-e2e-reject-thinking=1"],
  );
  try {
    await page.getByPlaceholder("Ask anything about the design").waitFor({ timeout: 20_000 });
    await recordRuntime(page);

    await page.evaluate(() => window.piCad.runtime.start());
    await expect.poll(() => sessionLevels(page, "desktop-e2e"), { timeout: 30_000 }).toContain("high");

    const shell = page.locator(".workbench-page");
    if (!(await shell.getAttribute("class"))?.includes("mode-conversation")) await page.keyboard.press("Control+Backslash");
    await expect(shell).toHaveClass(/mode-conversation/);
    await page.getByText("Folding stand", { exact: true }).click();

    // The restored session runs `medium` while the saved level is `high`, so the
    // renderer pushes `high` once — and that first attempt is rejected.
    await expect.poll(() => sessionLevels(page, "demo-restored"), { timeout: 30_000 }).toContain("medium");
    // The split the user has to know about is visible while it lasts...
    await expect(page.getByTestId("thinking-sync-error")).toBeVisible({ timeout: 30_000 });
    // ...and the reconciliation runs again on its own: no other status change is
    // injected to push the effect along.
    await expect.poll(async () => (await sessionLevels(page, "demo-restored")).at(-1), { timeout: 30_000 }).toBe("high");
    await expect(page.getByTestId("thinking-sync-error")).toHaveCount(0, { timeout: 30_000 });

    // One rejected attempt plus the accepted one, and the accepted one is not
    // sent again for the same session and level.
    await expect.poll(() => thinkingAttempts(page), { timeout: 30_000 }).toEqual([
      "set_thinking_level high attempt 1",
      "set_thinking_level high attempt 2",
    ]);
    await page.waitForTimeout(2_000);
    expect(await thinkingAttempts(page)).toHaveLength(2);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).thinking).toBe("high");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The other way a reconcile can be wrong is ordering. A session that runs
 * `medium` gets the saved `high` pushed into it; the demo holds that call open.
 * If the user moves the level to `low` while the first call is still on the
 * wire, a renderer that sends both levels at once lets the slow `high` land
 * last — the sidecar ends on a level nobody asks for any more. The newer target
 * has to wait for the request in flight, so the level that lands last is the
 * level that was picked last.
 */
test("a newer thinking reconcile waits for the request still on the wire", async () => {
  const { application, page, root, settingsPath } = await launchReify(
    "reify-slow-thinking-",
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", onboardingComplete: true },
    ["--pi-cad-e2e-open-step=/workspace/demo/imported.step", "--pi-cad-e2e-slow-thinking=3000"],
  );
  try {
    await page.getByPlaceholder("Ask anything about the design").waitFor({ timeout: 20_000 });
    await recordRuntime(page);

    await page.evaluate(() => window.piCad.runtime.start());
    await expect.poll(() => sessionLevels(page, "desktop-e2e"), { timeout: 30_000 }).toContain("high");

    const shell = page.locator(".workbench-page");
    if (!(await shell.getAttribute("class"))?.includes("mode-conversation")) await page.keyboard.press("Control+Backslash");
    await expect(shell).toHaveClass(/mode-conversation/);
    await page.getByText("Folding stand", { exact: true }).click();

    // The restored session runs `medium`, so the renderer pushes the saved
    // `high` — and the demo holds that first call open.
    await expect.poll(() => thinkingAttempts(page), { timeout: 30_000 }).toEqual(["set_thinking_level high attempt 1"]);

    // The user picks `low` while `high` is still unanswered.
    await page.getByLabel("Effort").selectOption("low");

    // Wait for the slow request to land before reading the final state, so the
    // order below is the order the sidecar ended up applying.
    await expect.poll(async () => (await sessionLevels(page, "demo-restored")).includes("high"), { timeout: 30_000 }).toBe(true);
    // `high` lands first, `low` after it: the sidecar ends on the level that was
    // picked last, and the newer target is not sent a second time.
    await expect.poll(async () => (await sessionLevels(page, "demo-restored")).at(-1), { timeout: 30_000 }).toBe("low");
    expect(levelChanges(await sessionLevels(page, "demo-restored"))).toEqual(["medium", "high", "low"]);
    expect(await thinkingAttempts(page)).toEqual([
      "set_thinking_level high attempt 1",
      "set_thinking_level low attempt 2",
    ]);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).thinking).toBe("low");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
