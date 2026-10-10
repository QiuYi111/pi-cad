import { test, expect, chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// This test uses the installed package and the deployed service, with a real model account.
// Credentials stay in a private file; traces are disabled to avoid recording secret inputs.
test.use({ trace: "off" });
test.setTimeout(900_000);
const credentialsPath = process.env.REIFY_E2E_CREDENTIALS;
const executable = process.env.PI_CAD_PACKAGED_EXE;
test.skip(!credentialsPath || !executable, "Set REIFY_E2E_CREDENTIALS and PI_CAD_PACKAGED_EXE");

test("installed thin client: first login, model setup, CAD save and restart", async () => {
  const credentials = JSON.parse(await readFile(credentialsPath!, "utf8"));
  const evidenceDir = process.env.REIFY_E2E_OUTPUT!;
  await mkdir(evidenceDir, { recursive: true });
  const profile = join(evidenceDir, "profile");
  const steps: Array<{ step: string; at: string; detail?: unknown }> = [];
  const record = async (step: string, detail?: unknown) => {
    steps.push({ step, at: new Date().toISOString(), ...(detail === undefined ? {} : { detail }) });
    console.log(step);
    await writeFile(join(evidenceDir, "result.json"), JSON.stringify({ steps }, null, 2));
  };
  const env = { ...process.env } as Record<string, string>;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
  env.NO_PROXY = "*";
  if (!credentials.registered) {
    const web = await chromium.launch({ channel: "msedge", headless: true, args: ["--no-proxy-server"] });
    try {
      const page = await web.newPage();
      await page.goto(`${credentials.baseUrl}/invite/${credentials.inviteToken}`);
      await page.locator("#pw").fill(credentials.password);
      await page.locator("#pw2").fill(credentials.password);
      await page.getByRole("button", { name: "注册", exact: true }).click();
      await expect(page.getByRole("heading", { name: "注册成功" })).toBeVisible();
      credentials.registered = true;
      await writeFile(credentialsPath!, JSON.stringify(credentials), { mode: 0o600 });
      await record("invite-registration-passed");
    } finally { await web.close(); }
  }
  let child: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let output = "";
  const launch = async () => {
    output = "";
    child = spawn(executable!, [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-proxy-server"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-20_000); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    await expect.poll(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1], { timeout: 60_000 }).toBeTruthy();
    const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)![1];
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent("page");
    page.setDefaultTimeout(30_000);
    await page.waitForLoadState("domcontentloaded");
    return page;
  };
  const close = async () => {
    await browser?.close().catch(() => {}); browser = undefined;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve()));
      child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000))]);
    }
  };
  try {
    let page = await launch();
    const initial = await page.evaluate(() => (window as any).piCad.settings.get());
    expect(initial).toMatchObject({ mode: "cloud", cloudOnly: true });
    await expect(page.getByRole("button", { name: "在本机运行（开发者）" })).toHaveCount(0);
    if (!(await page.evaluate(() => (window as any).piCad.cloud.status())).signedIn) {
      await page.getByLabel("邮箱", { exact: true }).fill(credentials.email);
      await page.getByLabel("密码", { exact: true }).fill(credentials.password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
    }
    await expect.poll(() => page.evaluate(async () => (await (window as any).piCad.cloud.status()).signedIn), { timeout: 30_000 }).toBe(true);
    await record("desktop-first-login-passed");
    const projectName = "Thin client E2E 2026-10-10";
    const selected = await page.evaluate(async () => (await (window as any).piCad.settings.get()).cloud?.projectId);
    if (!selected) {
      const existing = await page.evaluate(async (name) => (await (window as any).piCad.cloud.projects()).some((p: any) => p.name === name), projectName);
      if (!existing) {
        await page.getByLabel("新项目名称").fill(projectName);
        await page.getByRole("button", { name: "新建", exact: true }).click();
      }
      await page.locator("li").filter({ hasText: projectName }).getByRole("button", { name: "打开", exact: true }).click();
    } else if ((await page.evaluate(() => (window as any).piCad.cloud.status())).workspace.state === "stopped") {
      await page.evaluate(() => (window as any).piCad.cloud.workspaceStart());
    }
    await expect.poll(() => page.evaluate(async () => (await (window as any).piCad.cloud.status()).workspace.state), { timeout: 300_000, intervals: [2000] }).toBe("running");
    await record("cloud-workspace-running");
    const catalog = await page.evaluate(() => (window as any).piCad.auth.catalog());
    const provider = catalog.providers.find((p: any) => p.id === "zai");
    expect(provider).toBeTruthy();
    const model = provider.models.find((m: any) => m.id === "glm-5.3-flash") ?? provider.models.find((m: any) => /flash/.test(m.id)) ?? provider.models[0];
    const modelAuthPath = process.env.REIFY_E2E_MODEL_AUTH ?? credentials.modelAuthPath;
    expect(modelAuthPath, "Set REIFY_E2E_MODEL_AUTH or credentials.modelAuthPath").toBeTruthy();
    const auth = JSON.parse(await readFile(modelAuthPath, "utf8"));
    if (await page.getByRole("button", { name: "进入 Reify" }).isVisible()) {
      await page.getByLabel("提供商").selectOption("zai");
      await page.getByPlaceholder("API key").fill(auth.zai.key);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("button", { name: "进入 Reify" })).toBeEnabled({ timeout: 30_000 });
      await page.getByRole("button", { name: "进入 Reify" }).click();
    } else {
      await page.evaluate(({ key }) => (window as any).piCad.auth.setApiKey("zai", key), { key: auth.zai.key });
    }
    await page.getByLabel("Model", { exact: true }).selectOption(model.id);
    await page.getByLabel("Effort", { exact: true }).selectOption("low");
    await record("model-credentials-configured", { provider: "zai", model: model.id });
    await page.evaluate(() => {
      const w = window as any; w.__e2eEvents = []; w.__e2eStatus = null;
      w.piCad.runtime.onEvent((event: any) => w.__e2eEvents.push(event));
      w.piCad.runtime.onStatus((status: any) => { w.__e2eStatus = status; });
    });
    await page.evaluate(() => (window as any).piCad.runtime.start());
    await record("model-runtime-started");
    const prompt = "这是真实端到端测试。请用 CAD 工作流创建并保存一个 40×20×4 mm 的矩形板，中心有一个直径 6 mm 的通孔，命名为 thin-e2e-plate。保存可编辑 FreeCAD 零件和 STEP 文件，启用 DFM 检查，运行几何检查并显示模型。如已有同名零件，核对尺寸、文件和 DFM，显示已有模型；缺失时才创建。请直接做，不需要问我。完成后说明实际文件路径与尺寸。";
    const composer = page.getByPlaceholder("Ask anything about the design");
    await composer.fill(prompt); await composer.press("Enter");
    await page.waitForFunction(() => Boolean((window as any).__e2eStatus?.terminalReason), undefined, { timeout: 600_000 });
    expect(await page.evaluate(() => (window as any).__e2eStatus?.terminalReason)).toBe("completed");
    const result = await page.evaluate(async () => ({ restored: await (window as any).piCad.runtime.restore(), catalog: await (window as any).piCad.viewer.catalog(), settings: await (window as any).piCad.settings.get(), eventTypes: (window as any).__e2eEvents.map((e: any) => e.type) }));
    await writeFile(join(evidenceDir, "model-result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    expect(result.eventTypes).toContain("tool_execution_start");
    const artifacts = [...result.catalog.projectHead.artifacts, ...(result.catalog.currentRun?.artifacts ?? []), ...result.catalog.commits.flatMap((commit: any) => commit.artifacts)];
    const step = artifacts.find((artifact: any) => /\.(step|stp)$/i.test(artifact.path));
    expect(step, "the model must save a STEP artifact").toBeTruthy();
    expect(artifacts.some((artifact: any) => /\.FCStd$/i.test(artifact.path)), "the model must save an editable FreeCAD part").toBe(true);
    const geometry = await page.evaluate((path) => (window as any).piCad.viewer.inspectGeometry(path), step.path);
    expect(geometry.solidCount).toBe(1);
    expect(geometry.bbox.x).toBeCloseTo(40, 5);
    expect(geometry.bbox.y).toBeCloseTo(20, 5);
    expect(geometry.bbox.z).toBeCloseTo(4, 5);
    await record("saved-cad-geometry-passed", geometry);
    const section = await page.evaluate((path) => (window as any).piCad.viewer.inspectSection(path, "z"), step.path);
    expect(section.totalArea).toBeCloseTo(40 * 20 - Math.PI * 3 ** 2, 4);
    await record("six-mm-through-hole-passed", section);
    await page.screenshot({ path: join(evidenceDir, "workbench.png") });
    await record("real-model-turn-finished", { eventCount: result.eventTypes.length, catalog: result.catalog });
    await close();
    page = await launch();
    await expect.poll(() => page.evaluate(async () => (await (window as any).piCad.cloud.status()).signedIn), { timeout: 60_000 }).toBe(true);
    expect((await page.evaluate(() => (window as any).piCad.settings.get())).cloud.projectId).toBe(result.settings.cloud.projectId);
    await record("encrypted-login-and-project-survive-restart");
    const reopened = await page.evaluate(() => (window as any).piCad.viewer.catalog());
    const reopenedArtifacts = [...reopened.projectHead.artifacts, ...(reopened.currentRun?.artifacts ?? []), ...reopened.commits.flatMap((commit: any) => commit.artifacts)];
    expect(reopenedArtifacts.some((artifact: any) => artifact.sha256 === step.sha256 && artifact.path === step.path)).toBe(true);
    await record("saved-model-survives-restart");
    await page.evaluate(() => (window as any).piCad.runtime.stop());
    await page.evaluate(() => (window as any).piCad.cloud.workspaceStop());
    await record("workspace-stopped");
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) {
      const alerts = await page.locator('[role="alert"], .cloud-error').allInnerTexts().catch(() => []);
      const runtime = await page.evaluate(() => ({ events: (window as any).__e2eEvents, status: (window as any).__e2eStatus })).catch(() => null);
      await record("failed", { message: String(error).split(credentials.password).join("***"), alerts, runtime });
      await page.evaluate(() => (window as any).piCad.runtime.stop()).catch(() => {});
    }
    throw error;
  } finally { await close(); }
});
