import { test, expect, _electron as electron } from "@playwright/test";
import { appendFile, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("packaged viewer converts a real project STEP", async () => {
  const executablePath = process.env.PI_CAD_PACKAGED_EXE;
  const step = process.env.PI_CAD_REAL_STEP;
  test.skip(!executablePath || !step, "Set PI_CAD_PACKAGED_EXE and PI_CAD_REAL_STEP.");
  const userData = await mkdtemp(join(tmpdir(), "pi-cad-real-viewer-"));
  const project = join(userData, "project");
  const source = join(project, "input.step");
  const badSource = join(project, "broken.step");
  const exported = join(project, "exported.step");
  await mkdir(project);
  await copyFile(step!, source);
  await writeFile(badSource, "not a STEP model");
  const application = await electron.launch({
    executablePath: executablePath!,
    args: [
      `--user-data-dir=${userData}`,
      `--pi-cad-test-open-step=${source}`,
      `--pi-cad-test-open-step=${badSource}`,
      `--pi-cad-test-open-step=${source}`,
      `--pi-cad-test-export-step=${exported}`,
    ],
    env: { ...process.env, PI_CAD_PROJECT_CWD: project },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await page.evaluate((projectPath) => window.piCad.settings.update({ projectPath, piCadRepo: "", primeAgentRepo: "" }), project);
    const runtime = await page.evaluate(() => window.piCad.runtime.check());
    if (runtime.state !== "idle") await page.evaluate(() => window.piCad.runtime.install());
    await page.reload();
    const openProduct = page.getByRole("button", { name: "进入 Reify" });
    if (await openProduct.isVisible()) await openProduct.click();
    await expect(page.locator(".workbench-page")).toHaveClass(/mode-conversation/, { timeout: 20 * 60_000 });
    const mesh = await page.evaluate((path) => window.piCad.viewer.loadStep(path), source);
    expect(mesh.sha256).toBe(createHash("sha256").update(await readFile(source)).digest("hex"));
    expect(mesh.parts.length).toBeGreaterThan(0);
    const part = mesh.parts[0]!;
    expect(part.positions.length).toBeGreaterThanOrEqual(24);
    expect(part.positions.length % 3).toBe(0);
    expect(part.indices.length).toBeGreaterThanOrEqual(12);
    expect(part.indices.length % 3).toBe(0);
    expect(part.positions.every(Number.isFinite)).toBe(true);
    expect(Math.max(...part.indices)).toBeLessThan(part.positions.length / 3);

    await page.locator(".chat-header .open-step").click();
    await expect(page.locator(".workbench-page")).toHaveClass(/mode-canvas/);
    await expect(page.locator(".viewer-file-identity")).toContainText("input.step");
    await expect(page.locator(".viewer-file-identity code")).toHaveText(mesh.sha256!.slice(0, 10));
    const canvas = page.locator(".cad-viewer-open-source canvas");
    if (await canvas.isVisible()) {
      const bounds = await canvas.boundingBox();
      expect(bounds).not.toBeNull();
      await page.mouse.move(bounds!.x + bounds!.width * .55, bounds!.y + bounds!.height * .5);
      await page.mouse.down();
      await page.mouse.move(bounds!.x + bounds!.width * .7, bounds!.y + bounds!.height * .62, { steps: 8 });
      await page.mouse.up();
    } else {
      await expect(page.getByText("3D preview unavailable", { exact: true })).toBeVisible();
    }

    await page.getByRole("button", { name: "Export copy" }).click();
    await expect.poll(async () => {
      try { return (await readFile(exported)).equals(await readFile(source)); }
      catch { return false; }
    }).toBe(true);
    await page.getByTestId("cad-viewer").getByRole("button", { name: "Open STEP" }).click();
    await expect(page.getByRole("alert")).toContainText("The current model is preserved.");
    await expect(page.locator(".viewer-file-identity")).toContainText("input.step");
    await appendFile(source, "\n");
    const changedHash = createHash("sha256").update(await readFile(source)).digest("hex");
    await page.getByTestId("cad-viewer").getByRole("button", { name: "Open STEP" }).click();
    await expect(page.locator(".viewer-file-identity code")).toHaveText(changedHash.slice(0, 10));
    const reopened = await page.evaluate((path) => window.piCad.viewer.loadStep(path), exported);
    expect(reopened.sha256).toBe(mesh.sha256);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
