import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAgentApi } from "../../../../src/agent-api/handlers";
import { defaultCanonicalProjectDirectory } from "../../../../src/authority/storage";
import { shutdownWarmCadctlWorkers } from "../../../../src/shared/cadctl-worker";

test("installed desktop completes real WSL onboarding and applies a live model parameter", async () => {
  const executablePath = process.env.PI_CAD_INSTALLED_EXE;
  test.skip(!executablePath, "Set PI_CAD_INSTALLED_EXE after installing the Windows package.");
  test.setTimeout(25 * 60_000);

  const root = await mkdtemp(join(tmpdir(), "pi-cad-installed-e2e-"));
  const project = join(root, "project");
  const runtimeRoot = join(root, "runtime");
  const userData = join(root, "user-data");
  await mkdir(project, { recursive: true });
  const canonical = defaultCanonicalProjectDirectory(project);
  await writeFile(join(project, "box.py"), [
    "import build123d as bd",
    "def build(parameters):",
    "    return bd.Box(parameters['width'], parameters['depth'], parameters['height'])",
    "",
  ].join("\n"));

  const previousCanonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  process.env.PI_CAD_CANONICAL_PROJECT_DIR = canonical;
  try {
    await handleAgentApi(project, { schema: 1, op: "workflow-start", id: "mechanical.benchmark-build", interactionMode: "headless" });
    await handleAgentApi(project, {
      schema: 1,
      op: "model-build",
      source: "box.py",
      output: "build/box.step",
      parameters: {
        width: { default: 40, min: 20, max: 80, step: 1, unit: "mm", label: "Width" },
        depth: { default: 24, min: 12, max: 48, step: 1, unit: "mm", label: "Depth" },
        height: { default: 12, min: 4, max: 30, step: 1, unit: "mm", label: "Height" },
      },
    });
  } finally {
    await shutdownWarmCadctlWorkers();
    if (previousCanonical === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
    else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previousCanonical;
  }

  const passthrough = [
    "PI_CAD_DESKTOP_E2E_AUTH",
    "PI_CAD_DESKTOP_RUNTIME_ROOT",
    "PI_CAD_PROJECT_CWD",
  ];
  const application = await electron.launch({
    executablePath: executablePath!,
    args: [`--user-data-dir=${userData}`, "--pi-cad-e2e-auth"],
    env: {
      ...process.env,
      PI_CAD_DESKTOP_E2E_AUTH: "1",
      PI_CAD_DESKTOP_RUNTIME_ROOT: runtimeRoot,
      PI_CAD_PROJECT_CWD: project,
      PI_CAD_CANONICAL_PROJECT_DIR: "",
      WSLENV: [...new Set([...(process.env.WSLENV || "").split(":").filter(Boolean), ...passthrough])].join(":"),
    },
  });

  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await expect(page.getByText("READY THE WORKBENCH")).toBeVisible();
    const install = page.getByRole("button", { name: "Install bundled runtime" });
    await expect(install).toBeVisible({ timeout: 120_000 });
    await install.click();
    await expect(page.getByRole("button", { name: "Open Pi-CAD" })).toBeEnabled({ timeout: 20 * 60_000 });
    await page.getByRole("button", { name: "Open Pi-CAD" }).click();

    const catalog = await page.evaluate(() => window.piCad.viewer.catalog());
    const settings = await page.evaluate(() => window.piCad.settings.get());
    expect(catalog.currentRun, JSON.stringify({ canonical, project, settings, catalog }, null, 2)).not.toBeNull();
    await expect(page.getByTestId("parameter-panel")).toBeVisible({ timeout: 120_000 });
    const width = page.getByRole("spinbutton", { name: "Width" });
    await width.fill("67");
    await expect(page.locator(".parameter-status")).toContainText("Preview ready", { timeout: 120_000 });
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".parameter-status")).toContainText("Applied", { timeout: 180_000 });
    await page.getByRole("button", { name: "Workflows" }).click();
    await page.getByRole("button", { name: "Workbench" }).click();
    await expect(page.getByRole("spinbutton", { name: "Width" })).toHaveValue("67", { timeout: 60_000 });

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText(/4 engineering skills/)).toBeVisible({ timeout: 120_000 });
    await page.screenshot({ path: join(process.cwd(), "test-results", "installed-onboarding-parameters.png"), fullPage: true });

    await expect(readFile(join(runtimeRoot, "pi-cad", "skills", "parametric-cad-modeling", "references", "cookbook.md"), "utf8"))
      .resolves.toContain("Select topology by stable geometric conditions");
    await expect(readFile(join(runtimeRoot, "pi-cad", "skills", "mechanical-design", "references", "design-reasoning.md"), "utf8"))
      .resolves.toContain("Identify load paths");
    await expect(readFile(join(runtimeRoot, "pi-cad", "skills", "assembly-design", "references", "interfaces.md"), "utf8"))
      .resolves.toContain("mechanically meaningful module pair");
    await expect(readFile(join(runtimeRoot, "pi-cad", "skills", "design-for-manufacturing", "references", "geometry-rules.md"), "utf8"))
      .resolves.toContain("Check process-specific access and risk");
    const manifest = JSON.parse(await readFile(join(project, "build", "box.step.parameters.json"), "utf8"));
    expect(manifest.parameters.find((item: { id: string }) => item.id === "width")?.value).toBe(67);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    await rm(canonical, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
