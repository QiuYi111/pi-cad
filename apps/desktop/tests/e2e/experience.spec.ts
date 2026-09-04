import { test, expect, _electron as electron } from "@playwright/test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extract from "extract-zip";

const repository = resolve(process.cwd(), "../..");

test("desktop rating distills a real trajectory and publishes only after replay", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "pi-cad-experience-e2e-"));
  const appRoot = join(root, "app");
  const electronRoot = join(root, "electron");
  const project = join(root, "project");
  const experience = join(root, "experience");
  const candidateRepo = join(root, "pi-cad");
  const sessionRoot = join(project, ".prime-sessions");
  const session = join(sessionRoot, "failed-bracket.jsonl");
  const distiller = join(repository, "apps", "desktop", "tests", "fixtures", "distillation-agent.mjs");

  await mkdir(appRoot, { recursive: true });
  await cp(join(process.cwd(), "out"), join(appRoot, "out"), { recursive: true });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await cp(join(process.cwd(), "node_modules", "yaml"), join(appRoot, "node_modules", "yaml"), { recursive: true });
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "pi-cad-experience-e2e", version: "0.0.0", type: "module", main: "out/main/index.js" }));

  await mkdir(candidateRepo, { recursive: true });
  for (const name of ["src", "scripts", "skills", "workflow-packages", "packages", "assets"]) {
    await cp(join(repository, name), join(candidateRepo, name), { recursive: true });
  }
  await cp(join(repository, "package.json"), join(candidateRepo, "package.json"));
  await symlink(join(repository, "node_modules"), join(candidateRepo, "node_modules"), "dir");
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(session, [
    JSON.stringify({ type: "session", name: "E2E failed bracket" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "Design a load-bearing bracket." } }),
    JSON.stringify({ type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", usage: { input: 1200, output: 400 }, content: [{ type: "thinking", thinking: "I will build immediately." }, { type: "text", text: "The bracket is complete." }] } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "cad_build_step", content: "Model built without a load-path check." } }),
  ].join("\n") + "\n");

  const cacheRoot = join(process.env.LOCALAPPDATA || "", "electron", "Cache");
  let electronZip = "";
  for await (const candidate of glob(join(cacheRoot, "**/electron-v*-win32-x64.zip"))) { electronZip = candidate; break; }
  let executablePath = join(process.cwd(), "node_modules", "electron", "dist", "electron.exe");
  if (electronZip) { await extract(electronZip, { dir: electronRoot }); executablePath = join(electronRoot, "electron.exe"); }
  await chmod(executablePath, 0o755);

  const passthrough = ["PI_CAD_DESKTOP_E2E_REAL_TRACES", "PI_CAD_EXPERIENCE_ROOT", "PI_CAD_DISTILL_COMMAND_JSON"];
  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(root, "user-data")}`, appRoot, "--pi-cad-e2e"],
    env: {
      ...process.env,
      PI_CAD_DESKTOP_E2E_REAL_TRACES: "1",
      PI_CAD_EXPERIENCE_ROOT: experience,
      PI_CAD_DISTILL_COMMAND_JSON: JSON.stringify([process.execPath, distiller]),
      WSLENV: [...new Set([...(process.env.WSLENV || "").split(":").filter(Boolean), ...passthrough])].join(":"),
    },
  });

  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await page.getByRole("button", { name: "Open Pi-CAD" }).click();
    await page.evaluate(async ({ project, candidateRepo }) => {
      await window.piCad.settings.update({ projectPath: project, piCadRepo: candidateRepo, primeAgentRepo: "/tmp/prime-e2e" });
    }, { project, candidateRepo });
    await page.getByRole("button", { name: "Trajectories" }).click();
    await expect(page.getByText("E2E failed bracket")).toBeVisible();
    await page.getByText("E2E failed bracket").click();
    await expect(page.getByText("The bracket is complete.")).toBeVisible();
    await expect(page.locator(".trace-check")).toHaveClass(/selected/);
    const footer = page.locator(".trace-list footer");
    await footer.getByLabel("Quality").selectOption("2");
    await footer.getByLabel("Difficulty").selectOption("4");
    await footer.getByPlaceholder("What worked or failed?").fill("The bracket was built before its load path was checked.");
    await footer.getByRole("button", { name: "Rate 1" }).click();
    await expect(page.locator(".rating-status")).toContainText("Rating saved", { timeout: 90_000 });
    await expect(page.locator(".trace-row").filter({ hasText: "E2E failed bracket" })).toContainText("2/5");
    await footer.getByRole("button", { name: "Distill now" }).click();
    await expect(page.getByText("Distilling experience")).toBeVisible();
    await expect(page.getByText("Reusable experience updated.")).toBeVisible({ timeout: 180_000 });
    await page.screenshot({ path: join(process.cwd(), "test-results", "experience-distilled.png") });

    const index = (await readFile(join(experience, "index.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ quality: 2, difficulty: 4, feedback: "The bracket was built before its load path was checked." });
    await expect(readFile(join(candidateRepo, "skills", "parametric-cad-modeling", "references", "cookbook.md"), "utf8"))
      .resolves.toContain("Before rebuilding a failed bracket, inspect its load path");
    const replay = JSON.parse(await readFile(join(experience, "distill-jobs", "distill-1-1.replay-result.json"), "utf8"));
    expect(replay).toMatchObject({ passed: true, results: [{ kind: "repair", seq: 1, pass: true }] });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
