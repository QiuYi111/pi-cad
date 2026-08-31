import { test, expect, _electron as electron } from "@playwright/test";

test("packaged viewer converts a real project STEP", async () => {
  const executablePath = process.env.PI_CAD_PACKAGED_EXE;
  const step = process.env.PI_CAD_REAL_STEP;
  test.skip(!executablePath || !step, "Set PI_CAD_PACKAGED_EXE and PI_CAD_REAL_STEP.");
  const application = await electron.launch({ executablePath: executablePath! });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    const mesh = await page.evaluate((path) => window.piCad.viewer.loadStep(path), step!);
    expect(mesh.parts.length).toBeGreaterThan(0);
    expect(mesh.parts[0]?.positions.length).toBeGreaterThan(100);
    expect(mesh.parts[0]?.indices.length).toBeGreaterThan(100);
  } finally { await application.close(); }
});
