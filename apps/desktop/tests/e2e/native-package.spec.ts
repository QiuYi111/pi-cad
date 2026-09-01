import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("packaged Unix app selects the native runtime", async () => {
  const executablePath = process.env.PI_CAD_PACKAGED_EXE;
  test.skip(!executablePath || process.env.PI_CAD_NATIVE_PACKAGE !== "1", "Set a packaged Linux or macOS executable.");
  const userData = await mkdtemp(join(tmpdir(), "pi-cad-native-package-"));
  const application = await electron.launch({ executablePath: executablePath!, args: [`--user-data-dir=${userData}`] });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    const status = await page.evaluate(() => window.piCad.runtime.check());
    expect(status.checks.some((check) => check.id === "host" && check.status === "ready")).toBe(true);
    expect(status.checks.some((check) => check.id === "wsl")).toBe(false);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
