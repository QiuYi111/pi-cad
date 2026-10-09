import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { systemSkip } from "../../support/system-requirements.ts";

const project = resolve(import.meta.dirname, "../../..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent-plan-c-upstream"));
const resourceEntry = join(primeRoot, "packages/coding-agent/src/core/resource-loader.ts");
const settingsEntry = join(primeRoot, "packages/coding-agent/src/core/settings-manager.ts");
// The Prime checkout is optional for the default suite; only npm run test:prime
// requires it. Without it, skip with a reason instead of failing at import.
const primeMissing = !existsSync(resourceEntry) || !existsSync(settingsEntry);
const skipReason = systemSkip(
  "prime-checkout",
  !primeMissing,
  `Prime checkout not found at ${primeRoot}; set PRIME_AGENT_REPO to run this boundary test (npm run test:prime)`,
);
const { DefaultResourceLoader } = primeMissing ? {} as any : await import(pathToFileURL(resourceEntry).href);
const { SettingsManager } = primeMissing ? {} as any : await import(pathToFileURL(settingsEntry).href);

test("actual Prime 0.8 discovers cad as Python-backed, preserves Prime skills, and loads only the thin extension", { skip: skipReason }, async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "prime-plan-c-agent-"));
  try {
    const settingsManager = SettingsManager.inMemory({});
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [join(project, "src/integrations/prime/extension.ts")],
      additionalSkillPaths: [join(project, "skills/cad/SKILL.md")],
      noExtensions: true,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      bundledSkillsDir: join(primeRoot, "packages/coding-agent/skills"),
    });
    await loader.reload();

    const { skills, diagnostics } = loader.getSkills();
    assert.deepEqual(diagnostics, []);
    const cadSkill = skills.find((skill: any) => skill.name === "cad");
    assert.equal(cadSkill?.kind, "python");
    assert.equal((cadSkill as any).python.importName, "cad");
    assert.equal(resolve((cadSkill as any).python.packagePath), join(project, "skills/cad"));
    assert.ok(skills.some((skill: any) => skill.name === "agent-message"));
    assert.ok(skills.some((skill: any) => skill.name === "agent-observe"));
    for (const legacy of ["pi-cad", "pi-cad-tools", "mechanical-design", "parametric-cad-modeling"]) {
      assert.ok(!skills.some((skill: any) => skill.name === legacy), `legacy Pi-CAD skill leaked into Prime: ${legacy}`);
    }

    assert.deepEqual(loader.getLoadedExtensionPaths().map((path: string) => resolve(path)), [join(project, "src/integrations/prime/extension.ts")]);
    assert.deepEqual(loader.getExtensions().errors, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
