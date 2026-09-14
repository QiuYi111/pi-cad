import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("packaged desktop app starts", async () => {
  const executablePath = process.env.PI_CAD_PACKAGED_EXE;
  test.skip(!executablePath, "Set PI_CAD_PACKAGED_EXE after electron-builder finishes.");
  const userData = await mkdtemp(join(tmpdir(), "pi-cad-package-user-"));
  const application = await electron.launch({
    executablePath: executablePath!,
    args: [`--user-data-dir=${userData}`, "--pi-cad-e2e"],
    env: { ...process.env, PI_CAD_DESKTOP_E2E: "1", PI_CAD_PROJECT_CWD: "/workspace/package-smoke" },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    const enter = page.getByRole("button", { name: "进入 Reify" });
    if (await enter.isVisible()) {
      await expect(page.getByText("MAKE IDEAS REAL")).toBeVisible();
      if (process.env.PI_CAD_SETUP_SCREENSHOT) { await page.waitForTimeout(600); await page.screenshot({ path: process.env.PI_CAD_SETUP_SCREENSHOT }); }
      await enter.click();
    }
    await expect(page.getByText("Reify").first()).toBeVisible();
    await expect(page.locator(".workbench-page")).toBeVisible();
    await expect(page.locator(".floating-composer")).toHaveCount(1);
    await expect(page.locator(".composer-handle")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
