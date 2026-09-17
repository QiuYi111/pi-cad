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
    await page.evaluate(() => {
      const seen: Array<{ sessionId?: string; thinking?: string }> = [];
      (window as unknown as { __reifyThinking: typeof seen }).__reifyThinking = seen;
      window.piCad.runtime.onStatus((status: RuntimeStatus) => seen.push({ sessionId: status.sessionId, thinking: status.thinking }));
    });

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
