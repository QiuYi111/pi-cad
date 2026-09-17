import { expect, test, _electron as electron } from "@playwright/test";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The runtime must publish retry, tool and stop phases itself; the status bar
 * showing them proves the renderer never has to infer state from Prime events.
 */
test("status bar reports retry, tool and stop phases", async () => {
  const root = await mkdtemp(join(tmpdir(), "reify-runtime-phases-"));
  const appRoot = join(root, "app");
  await mkdir(appRoot, { recursive: true });
  await cp(join(process.cwd(), "out"), join(appRoot, "out"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await cp(join(process.cwd(), "node_modules/yaml"), join(appRoot, "node_modules/yaml"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "reify-runtime-phases", version: "0.0.0", type: "module", main: "out/main/index.js" }));
  const executablePath = join(process.cwd(), "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron");
  await chmod(executablePath, 0o755).catch(() => undefined);

  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(root, "user-data")}`, appRoot, "--pi-cad-e2e", "--pi-cad-e2e-open-step=/workspace/demo/imported.step"],
    env: { ...process.env, PI_CAD_DESKTOP_E2E: "1", PI_CAD_PROJECT_CWD: "/workspace/demo" },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await page.getByRole("button", { name: "进入 Reify" }).click();
    const kernel = page.locator(".status-bar b").first();
    const composer = page.getByPlaceholder("Ask anything about the design");
    await composer.waitFor({ timeout: 20_000 });

    await composer.fill("Provider retry please");
    await composer.press("Enter");
    await page.waitForFunction(() => /^Retrying 1\/3$/.test(document.querySelector(".status-bar b")?.textContent ?? ""), null, { timeout: 30_000, polling: 25 });
    await page.waitForFunction(() => document.querySelector(".conversation-turn span")?.textContent === "Retrying 1/3", null, { timeout: 30_000, polling: 25 });
    await expect(page.getByText("Recovered after one retry.")).toBeAttached({ timeout: 30_000 });

    // A reasoning limit is a live phase of the turn, not a terminal: the row
    // keeps its clocks and reports no terminal reason until the retry arrives.
    await composer.fill("Reasoning limit please");
    await composer.press("Enter");
    await page.waitForFunction(() => {
      const row = document.querySelector(".conversation-turn");
      return row?.querySelector("span")?.textContent === "Reasoning limit"
        && Boolean(row.querySelector("time[data-timer='turn']"))
        && !row.hasAttribute("data-terminal-reason");
    }, null, { timeout: 30_000, polling: 25 });
    await page.waitForFunction(() => document.querySelector(".conversation-turn span")?.textContent === "Retrying 1/3", null, { timeout: 30_000, polling: 25 });
    await expect(page.getByText("Recovered from the reasoning limit.")).toBeAttached({ timeout: 30_000 });

    await composer.fill("Long calculation");
    await composer.press("Enter");
    await page.waitForFunction(() => document.querySelector(".status-bar b")?.textContent === "Running tool", null, { timeout: 30_000, polling: 25 });
    // The conversation row reads the same runtime phase and labels its clocks,
    // so the turn total can never pass as reasoning time.
    await page.waitForFunction(() => document.querySelector(".stream-state span")?.textContent === "Running tool", null, { timeout: 30_000, polling: 25 });
    await expect(page.locator(".stream-state time[data-timer='turn']")).toHaveCount(1);
    await expect(page.locator(".stream-state time[data-timer='phase']")).toHaveCount(1);
    await page.getByRole("button", { name: "Stop" }).click();
    await page.waitForFunction(() => document.querySelector(".status-bar b")?.textContent === "Stopped", null, { timeout: 30_000, polling: 25 });
    await expect(kernel).toHaveText("Stopped");
    await expect(page.locator(".stream-state").last()).toContainText("Stopped");
    await expect(page.locator(".stream-state").last().locator("time")).toHaveCount(0);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
