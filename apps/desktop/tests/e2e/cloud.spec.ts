import { test, expect, chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs the desktop app in cloud mode against a deployed platform API.
//   REIFY_CLOUD_URL       the public address (default: the app's built-in address)
//   REIFY_CLOUD_EMAIL     an account that already exists (made with `reify-admin invite create`)
//   REIFY_CLOUD_PASSWORD  its password
//
// The app is started directly and driven over the DevTools protocol. Playwright's own Electron launcher
// forces --password-store=basic, which makes safeStorage unavailable on Linux, and cloud sign-in needs it.
// On Linux the run needs a Secret Service on the session bus (gnome-keyring).
const email = process.env.REIFY_CLOUD_EMAIL ?? "";
const password = process.env.REIFY_CLOUD_PASSWORD ?? "";
const baseUrl = process.env.REIFY_CLOUD_URL ?? "";

test.skip(!email || !password, "REIFY_CLOUD_EMAIL and REIFY_CLOUD_PASSWORD are required");

async function waitForDevTools(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the app did not open its DevTools port");
}

test("cloud mode: sign in, open a project, run the workspace over the bridge", async () => {
  const userData = await mkdtemp(join(tmpdir(), "reify-cloud-e2e-"));
  // The first-run page also asks for a model provider sign-in (OAuth), which needs a person. Skip it here.
  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify({ mode: "cloud", onboardingComplete: true, cloud: baseUrl ? { baseUrl } : {} }),
    { mode: 0o600 },
  );
  const env = { ...process.env } as Record<string, string>;
  // The tailnet address must not go through a local HTTP proxy.
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
  env.NO_PROXY = "*";
  const port = 9300 + Math.floor(Math.random() * 500);
  const electronPath = join(process.cwd(), "node_modules/electron/dist", process.platform === "win32" ? "electron.exe" : "electron");
  const child = spawn(
    electronPath,
    [".", "--no-sandbox", ...(process.platform === "linux" ? ["--password-store=gnome-libsecret"] : []), `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let appOutput = "";
  const collect = (chunk: Buffer) => { appOutput = (appOutput + chunk.toString()).slice(-16000); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await waitForDevTools(port, child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent("page"));
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });

    // Sign in through the real login page.
    await expect(page.getByRole("heading", { name: "登录 Reify 云端" })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("邮箱").fill(email);
    await page.getByLabel("密码").fill(password);
    // Record the bridge states pushed by the main process from now on.
    await page.evaluate(() => {
      const w = window as any;
      w.__bridge = [];
      w.piCad.cloud.onEvent((event: any) => { if (event.type === "bridge_state") w.__bridge.push(event.state); });
    });
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "项目" })).toBeVisible({ timeout: 30_000 });

    // Create a project and open it. Opening it starts the workspace.
    const projectName = `e2e-${Date.now()}`;
    await page.getByLabel("新项目名称").fill(projectName);
    await page.getByRole("button", { name: "新建" }).click();
    const row = page.locator("li, article, div").filter({ hasText: projectName }).filter({ has: page.getByRole("button", { name: "打开" }) }).last();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "打开" }).click();

    // The workspace reaches "running" and the app holds the event channel.
    await expect
      .poll(async () => page.evaluate(async () => (await (window as any).piCad.cloud.status()).workspace.state), {
        timeout: 240_000,
        intervals: [2_000],
        message: "workspace should reach running",
      })
      .toBe("running");
    await expect
      .poll(async () => page.evaluate(async () => (await (window as any).piCad.cloud.status()).eventsConnected), { timeout: 30_000 })
      .toBe(true);
    // The runtime bridge connects to the workspace gateway.
    await expect
      .poll(async () => page.evaluate(() => (window as any).__bridge as string[]), { timeout: 60_000, message: "bridge should connect" })
      .toContain("connected");

    // The workbench loads for the opened project.
    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 30_000 });
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);

    // Clean up: stop the workspace so the test leaves nothing running.
    const stopped = await page.evaluate(async () => (await (window as any).piCad.cloud.workspaceStop()).workspace.state);
    expect(["stopped", "stopping"]).toContain(stopped);
  } catch (error) {
    // Show what the app itself reported. The password never appears in the app output.
    const tail = appOutput.split("\n").filter((line) => !/dbus|UNDICI|trace-warnings|libva|gpu|Fontconfig/i.test(line)).slice(-70).join("\n");
    const dump = `--- app output (tail) ---\n${tail.split(password).join("***")}`;
    if (process.env.REIFY_E2E_LOG) await writeFile(process.env.REIFY_E2E_LOG, dump, { mode: 0o600 });
    else console.log(dump);
    const page = browser?.contexts()[0]?.pages()[0];
    const alerts = page ? await page.locator('[role="alert"], [role="status"], .cloud-error').allInnerTexts().catch(() => []) : [];
    console.log(`--- page alerts ---\n${alerts.join("\n")}`);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    // The app can still be flushing files for a moment after it exits.
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }
});
