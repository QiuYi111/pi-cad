import { expect, test, _electron as electron } from "@playwright/test";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extract from "extract-zip";

test("beta workbench keeps one movable composer above canvas and conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "reify-beta-workbench-"));
  const appRoot = join(root, "app");
  const electronRoot = join(root, "electron");
  await mkdir(appRoot, { recursive: true });
  await cp(join(process.cwd(), "out"), join(appRoot, "out"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await cp(join(process.cwd(), "node_modules/yaml"), join(appRoot, "node_modules/yaml"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "reify-beta-workbench", version: "0.0.0", type: "module", main: "out/main/index.js" }));

  const cacheRoot = join(process.env.LOCALAPPDATA || "", "electron", "Cache");
  let electronZip = "";
  for await (const candidate of glob(join(cacheRoot, "**/electron-v*-win32-x64.zip"))) { electronZip = candidate; break; }
  let executablePath = join(process.cwd(), "node_modules/electron/dist/electron.exe");
  if (electronZip) { await extract(electronZip, { dir: electronRoot }); executablePath = join(electronRoot, "electron.exe"); }
  await chmod(executablePath, 0o755);

  const application = await electron.launch({ executablePath, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--user-data-dir=${join(root, "user-data")}`, appRoot, "--pi-cad-e2e", "--pi-cad-e2e-open-step=/workspace/demo/imported.step"], env: { ...process.env, PI_CAD_DESKTOP_E2E: "1", PI_CAD_PROJECT_CWD: "/workspace/demo" } });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1366, 768));
    await page.waitForTimeout(180);
    await page.getByRole("button", { name: "进入 Reify" }).click();
    await expect(page.locator(".workbench-page")).toHaveClass(/mode-canvas/);
    await expect(page.locator(".floating-composer")).toHaveCount(1);
    const before = await page.locator(".floating-composer").boundingBox();
    expect(before).not.toBeNull();

    await page.keyboard.press("Control+Backslash");
    await expect(page.locator(".workbench-page")).toHaveClass(/mode-conversation/);
    const open = await page.locator(".floating-composer").boundingBox();
    expect(open).toEqual(before);
    await page.keyboard.press("Control+Backslash");
    await expect(page.locator(".workbench-page")).toHaveClass(/mode-canvas/);
    expect(await page.locator(".floating-composer").boundingBox()).toEqual(before);

    const handle = page.locator(".composer-handle");
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 70, handleBox!.y + handleBox!.height / 2 - 55, { steps: 6 });
    await page.mouse.up();
    const moved = await page.locator(".floating-composer").boundingBox();
    expect(moved!.x).toBeGreaterThan(before!.x + 50);
    expect(moved!.y).toBeLessThan(before!.y - 35);
    await page.reload();
    await expect(page.locator(".floating-composer")).toBeVisible();
    const restored = await page.locator(".floating-composer").boundingBox();
    expect(Math.abs(restored!.x - moved!.x)).toBeLessThan(2);
    expect(Math.abs(restored!.y - moved!.y)).toBeLessThan(2);

    await page.screenshot({ path: join(process.cwd(), "test-results", "beta-workbench-1366x768.png") });
    await page.keyboard.press("Control+Backslash");
    await expect(page.locator(".workbench-page")).toHaveClass(/mode-conversation/);
    await page.waitForTimeout(650);
    expect(await page.locator(".floating-composer").boundingBox()).toEqual(restored);
    await expect(page.getByRole("complementary", { name: "Projects and conversations" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新对话" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建项目" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开项目" })).toBeVisible();
    await page.getByRole("button", { name: "收起侧栏" }).click();
    await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
    await page.getByRole("button", { name: "展开侧栏" }).click();
    await expect(page.getByRole("button", { name: "新建项目" })).toBeVisible();
    await page.waitForTimeout(320);
    await page.screenshot({ path: join(process.cwd(), "test-results", "beta-conversation-1366x768.png") });

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.locator(".settings-index")).toBeVisible();
    await page.screenshot({ path: join(process.cwd(), "test-results", "beta-settings-1366x768.png") });
    await page.getByRole("button", { name: "Workflows" }).click();
    await expect(page.getByTestId("workflow-editor")).toBeVisible();
    await expect(page.getByLabel("Workflow YAML")).toHaveCount(0);
    await page.getByRole("button", { name: "Edit source" }).click();
    await expect(page.getByLabel("Workflow YAML")).toBeVisible();
    await page.screenshot({ path: join(process.cwd(), "test-results", "beta-workflows-1366x768.png") });
    await page.getByRole("button", { name: "Trajectories" }).click();
    await expect(page.getByTestId("traces-page")).toBeVisible();
    await expect(page.locator(".rating-panel")).toHaveCount(0);
    await page.locator(".rating-toggle").click();
    await expect(page.locator(".rating-panel")).toBeVisible();
    await page.screenshot({ path: join(process.cwd(), "test-results", "beta-trajectories-1366x768.png") });
    await page.getByRole("button", { name: "Workbench" }).click();
    await expect(page.locator(".workbench-page")).toHaveClass(/mode-conversation/);
    await expect(page.locator(".design-pane")).toBeHidden();
    await page.keyboard.press("Control+Backslash");
    await handle.dblclick();
    await page.waitForTimeout(280);
    await expect(page.locator(".workbench-page")).toHaveClass(/mode-canvas/);
    await page.locator(".cad-viewer-open-source").evaluate((host) => {
      const navigation = document.createElement("div");
      navigation.className = "tcv_cad_navigation";
      navigation.dataset.testid = "upstream-viewer-navigation";
      host.append(navigation);
    });
    await expect(page.getByTestId("upstream-viewer-navigation")).toBeHidden();
    const reset = await page.locator(".floating-composer").boundingBox();
    expect(Math.abs((reset!.x + reset!.width / 2) / 1366 - .5)).toBeLessThan(.02);

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1920, 1080));
    await page.waitForTimeout(180);
    await page.screenshot({ path: join(process.cwd(), "test-results", "beta-workbench-1920x1080.png") });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.25));
    await page.waitForTimeout(180);
    const zoomed = await page.locator(".floating-composer").boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(zoomed!.x).toBeGreaterThanOrEqual(0);
    expect(zoomed!.y).toBeGreaterThanOrEqual(0);
    expect(zoomed!.x + zoomed!.width).toBeLessThanOrEqual(viewport.width);
    expect(zoomed!.y + zoomed!.height).toBeLessThanOrEqual(viewport.height - 36);
    await page.screenshot({ path: join(process.cwd(), "test-results", "beta-workbench-125-percent.png") });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(920, 680));
    await page.waitForTimeout(180);
    const compact = await page.locator(".floating-composer").boundingBox();
    expect(compact!.x).toBeGreaterThanOrEqual(0);
    expect(compact!.y).toBeGreaterThanOrEqual(0);
    expect(compact!.x + compact!.width).toBeLessThanOrEqual(920);
    expect(compact!.y + compact!.height).toBeLessThanOrEqual(640);
    await page.screenshot({ path: join(process.cwd(), "test-results", "beta-workbench-920x680.png") });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
