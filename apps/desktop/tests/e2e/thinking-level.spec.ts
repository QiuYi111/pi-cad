import { expect, test, _electron as electron } from "@playwright/test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stored level the model cannot run has to be folded the way Prime clamps it.
 * The demo catalog lists `zai/glm-5.3` as `off, minimal, low, medium, high`, so
 * a stored `xhigh` belongs on `high` — the closest level below it. Landing on
 * `off` instead would silently switch the user's reasoning back off.
 */
test("an authoritative catalog folds a stored thinking level without dropping reasoning", async () => {
  const root = await mkdtemp(join(tmpdir(), "reify-thinking-level-"));
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
  await writeFile(settingsPath, JSON.stringify({ provider: "zai", model: "glm-5.3", thinking: "xhigh", onboardingComplete: true }));

  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, appRoot, "--pi-cad-e2e"],
    env: { ...process.env, PI_CAD_DESKTOP_E2E: "1", PI_CAD_PROJECT_CWD: "/workspace/demo" },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
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
