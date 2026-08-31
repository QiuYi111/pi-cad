import { test, expect, _electron as electron } from "@playwright/test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glob } from "node:fs/promises";
import extract from "extract-zip";

test("complete desktop product path", async () => {
  const nativeRoot = await mkdtemp(join(tmpdir(), "pi-cad-e2e-"));
  const appRoot = join(nativeRoot, "app");
  const electronRoot = join(nativeRoot, "electron");
  await mkdir(appRoot, { recursive: true });
  await cp(join(process.cwd(), "out"), join(appRoot, "out"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await cp(join(process.cwd(), "node_modules/yaml"), join(appRoot, "node_modules/yaml"), { recursive: true });
  const cacheRoot = join(process.env.LOCALAPPDATA || "", "electron", "Cache");
  let electronZip = "";
  for await (const candidate of glob(join(cacheRoot, "**/electron-v*-win32-x64.zip"))) { electronZip = candidate; break; }
  if (!electronZip) throw new Error("Electron cache archive is unavailable");
  await extract(electronZip, { dir: electronRoot });
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "pi-cad-e2e", version: "0.0.0", type: "module", main: "out/main/index.js" }));
  const application = await electron.launch({ executablePath: join(electronRoot, "electron.exe"), args: ["--disable-gpu", appRoot], env: { ...process.env, PI_CAD_DESKTOP_E2E: "1", PI_CAD_PROJECT_CWD: "/workspace/demo" } });
  const page = await application.firstWindow();
  page.on("console", (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[renderer:error] ${error.message}`));
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await expect(page.getByText("Pi-CAD").first()).toBeVisible();
  await expect(page.getByTestId("workflow-rail")).toBeVisible();

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(920, 680));
  await page.waitForTimeout(200);
  await expect(page.locator(".cad-viewer")).toBeVisible();
  await expect(page.getByPlaceholder("Ask anything about the design")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  await page.waitForTimeout(200);

  await page.getByLabel("Permission").selectOption("read-only");
  await expect(page.getByLabel("Permission")).toHaveValue("read-only");
  await page.getByLabel("Permission").selectOption("workspace");
  await page.getByLabel("Model").selectOption("gpt-5.6-luna");
  await page.getByLabel("Effort").selectOption("low");
  await expect(page.getByLabel("Model")).toHaveValue("gpt-5.6-luna");
  await expect(page.getByLabel("Effort")).toHaveValue("low");

  const composer = page.getByPlaceholder("Ask anything about the design");
  await composer.fill("Build a compact bracket");
  await composer.press("Enter");
  await expect(page.getByText("Building model")).toBeVisible();
  await expect(page.getByText("Model built")).toBeVisible();
  await expect(page.getByText("The first model is built and ready for inspection.")).toBeVisible();
  await expect(page.locator(".activity-media img")).toBeVisible();
  await page.locator(".activity-media img").click();
  await expect(page.getByRole("dialog", { name: "Tool image preview" })).toBeVisible();
  await page.getByRole("dialog", { name: "Tool image preview" }).click();
  await expect(page.getByText("Explode", { exact: true })).toBeVisible();
  await page.getByTitle("Section").click();
  await expect(page.getByText("Section", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Workflows" }).click();
  await expect(page.getByRole("heading", { name: "mechanical.one-shot" })).toBeVisible();
  await page.getByRole("button", { name: /concept/i }).click();
  await expect(page.getByText("image.generate")).toBeVisible();
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(page.getByRole("heading", { name: "custom.workflow" })).toBeVisible();
  await page.getByRole("button", { name: "Save workflow" }).click();
  await expect(page.getByText("Saved and validated")).toBeVisible();

  await page.getByRole("button", { name: "Trajectories" }).click();
  await expect(page.getByText("Folding stand")).toBeVisible();
  await page.getByText("Folding stand").click();
  await expect(page.getByText("I checked the interfaces before building.")).toBeVisible();
  await page.locator(".trace-check").click();
  await page.getByRole("button", { name: /Distill 1/ }).click();
  await expect(page.getByText(/Experience updated/)).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("ChatGPT connected")).toBeVisible();
  await application.close();
  await rm(nativeRoot, { recursive: true, force: true });
});
