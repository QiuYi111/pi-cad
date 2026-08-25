import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const project = resolve(import.meta.dirname, "..");
const primeRoot = resolve(process.env.PRIME_AGENT_REPO ?? resolve(project, "../prime-agent-plan-c-upstream"));
const resourceModule = await import(pathToFileURL(join(primeRoot, "packages/coding-agent/src/core/resource-loader.ts")).href);
const settingsModule = await import(pathToFileURL(join(primeRoot, "packages/coding-agent/src/core/settings-manager.ts")).href);
const { DefaultResourceLoader } = resourceModule;
const { SettingsManager } = settingsModule;

test("actual Prime 0.8 discovers cad as Python-backed, preserves Prime skills, and loads only the thin extension", async () => {
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
