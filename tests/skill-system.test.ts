import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const skills = join(root, "skills");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

test("skills have valid frontmatter, resolvable links, executable assets, and no Python cache", () => {
  const all = files(skills);
  for (const path of all.filter((item) => item.endsWith("SKILL.md"))) {
    const text = readFileSync(path, "utf-8");
    assert.match(text, /^---\r?\nname: [^\r\n]+\r?\ndescription:/);
  }
  for (const path of all.filter((item) => item.endsWith(".md"))) {
    const text = readFileSync(path, "utf-8");
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(path), target)), `broken skill link ${path}: ${target}`);
    }
  }
  assert.ok(!all.some((path) => path.includes("__pycache__") || /\.pyc$/i.test(path)), "skills must not package Python caches");
  if (process.platform !== "win32") {
    for (const path of all.filter((item) => item.endsWith("Allrun"))) assert.ok((statSync(path).mode & 0o111) !== 0, `Recipe entrypoint is not executable: ${path}`);
  }
  for (const expected of [
    "parametric-cad-modeling/assets/build123d-part",
    "parametric-cad-modeling/assets/build123d-assembly",
    "thermal-fluid-analysis/assets/recipes/openfoam-steady-incompressible",
    "thermal-fluid-analysis/assets/recipes/openfoam-transient-vof",
    "thermal-fluid-analysis/assets/recipes/su2-steady-flow",
    "thermal-fluid-analysis/assets/recipes/su2-solid-thermal",
    "structural-analysis/assets/recipes/torch-fem-linear-elastic",
    "structural-analysis/assets/recipes/torch-fem-differentiable-sensitivity",
  ]) assert.ok(existsSync(join(skills, expected)), `missing executable/copyable asset ${expected}`);
});

test("handwritten prompts, routers, and READMEs do not duplicate exact public tool names", () => {
  const paths = [join(root, "README.md"), join(root, "README.zh-CN.md"), ...files(join(root, "src", "prompts")), ...files(skills).filter((path) => path.endsWith("SKILL.md"))];
  for (const path of paths) assert.doesNotMatch(readFileSync(path, "utf-8"), /\bcad_[a-z][a-z_]*/g, `exact tool catalog leaked into handwritten router: ${path}`);
});
