import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("packaged viewer converts a real project STEP", async () => {
  const executablePath = process.env.PI_CAD_PACKAGED_EXE;
  const step = process.env.PI_CAD_REAL_STEP;
  test.skip(!executablePath || !step, "Set PI_CAD_PACKAGED_EXE and PI_CAD_REAL_STEP.");
  const userData = await mkdtemp(join(tmpdir(), "pi-cad-real-viewer-"));
  const application = await electron.launch({
    executablePath: executablePath!,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, PI_CAD_PROJECT_CWD: dirname(step!) },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    const mesh = await page.evaluate((path) => window.piCad.viewer.loadStep(path), step!);
    expect(mesh.parts.length).toBeGreaterThan(0);
    const part = mesh.parts[0]!;
    expect(part.positions.length).toBeGreaterThanOrEqual(24);
    expect(part.positions.length % 3).toBe(0);
    expect(part.indices.length).toBeGreaterThanOrEqual(12);
    expect(part.indices.length % 3).toBe(0);
    expect(part.positions.every(Number.isFinite)).toBe(true);
    expect(Math.max(...part.indices)).toBeLessThan(part.positions.length / 3);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
