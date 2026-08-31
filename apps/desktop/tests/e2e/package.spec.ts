import { test, expect, _electron as electron } from "@playwright/test";

test("packaged Windows app starts", async () => {
  const executablePath = process.env.PI_CAD_PACKAGED_EXE;
  test.skip(!executablePath, "Set PI_CAD_PACKAGED_EXE after electron-builder finishes.");
  const application = await electron.launch({
    executablePath: executablePath!,
    env: { ...process.env, PI_CAD_DESKTOP_E2E: "1", PI_CAD_PROJECT_CWD: "/workspace/package-smoke" },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await expect(page.getByText("Pi-CAD").first()).toBeVisible();
    await expect(page.getByTestId("workflow-rail")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await application.close();
  }
});
