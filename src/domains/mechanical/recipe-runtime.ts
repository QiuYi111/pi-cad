import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../../harness/canonical.ts";
import type { RecipeRuntimeIdentityV1, RecipeRuntimeV1 } from "../../harness/recipe/types.ts";
import { managedSimulationRunner, spawnLogged } from "../../modules/simulate-v2/runtime.ts";
import { runProcess } from "../../shared/process-runner.ts";

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

class ManagedMechanicalRecipeRuntime implements RecipeRuntimeV1 {
  async qualify(cwd: string, profileId: string): Promise<RecipeRuntimeIdentityV1> {
    const slash = profileId.indexOf("/");
    if (slash < 1 || slash === profileId.length - 1) throw new Error(`invalid managed Recipe runtime profile: ${profileId}`);
    const identity = await managedSimulationRunner.resolveRuntime(cwd, profileId.slice(0, slash), profileId.slice(slash + 1));
    return { profileId, platform: identity.platform, version: identity.resolvedVersion, digest: identity.digest, launcher: identity.launcher, ...(identity.accelerator ? { details: identity.accelerator as never } : {}) };
  }
  async execute(input: Parameters<RecipeRuntimeV1["execute"]>[0]) {
    const profileId = (input.environment.PI_RECIPE_RUNTIME_PROFILE ?? "").trim();
    const slash = profileId.indexOf("/");
    if (slash < 1) throw new Error("Managed Recipe execution requires PI_RECIPE_RUNTIME_PROFILE");
    const result = await managedSimulationRunner.execute({ cwd: input.cwd, workspace: input.workspace, recipeDirectory: input.recipeDirectory, command: input.argv.map(shellQuote).join(" "), environment: Object.fromEntries(Object.entries(input.environment).filter(([key]) => key !== "PI_RECIPE_RUNTIME_PROFILE")), stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, timeoutMs: input.timeoutMs, backend: profileId.slice(0, slash), runtime: profileId.slice(slash + 1), signal: input.signal });
    return { exitCode: result.exitCode, durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr };
  }
}

async function hashRuntimeTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path); const name = relative(root, path).split(sep).join("/") || ".";
    if (info.isDirectory()) { hash.update(`d\0${name}\0`); for (const entry of (await readdir(path)).sort()) if (![".venv", "__pycache__"].includes(entry)) await visit(join(path, entry)); }
    else if (info.isFile() && !name.endsWith(".pyc")) { hash.update(`f\0${name}\0${info.size}\0`); hash.update(await readFile(path)); }
  };
  await visit(root); return hash.digest("hex");
}

const packageDirectory = fileURLToPath(new URL("../../../", import.meta.url));

class PackageMechanicalRecipeRuntime implements RecipeRuntimeV1 {
  private identity?: Promise<RecipeRuntimeIdentityV1>;
  async qualify(_cwd: string, profileId: string): Promise<RecipeRuntimeIdentityV1> {
    if (profileId !== "pi-cad/cadctl-0.9") throw new Error(`unsupported package Recipe runtime: ${profileId}`);
    this.identity ??= (async () => {
      const python = join(packageDirectory, "python", ".venv", "bin", "python");
      const version = await runProcess({ command: python, args: ["--version"], cwd: packageDirectory, timeoutMs: 30_000, maxStdoutBytes: 4096, maxStderrBytes: 4096 });
      if (version.exitCode !== 0) throw new Error(`package Recipe Python is unavailable: ${version.stderr}`);
      const distributions = await runProcess({ command: python, args: ["-c", "import importlib.metadata as m; print('\\n'.join(sorted(f'{d.metadata[\"Name\"]}=={d.version}' for d in m.distributions())))"], cwd: packageDirectory, timeoutMs: 30_000, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 4096 });
      if (distributions.exitCode !== 0) throw new Error(`package Recipe environment cannot be inventoried: ${distributions.stderr}`);
      const sourceHash = await hashRuntimeTree(join(packageDirectory, "python"));
      return { profileId, platform: `${process.platform}-${process.arch}`, version: "0.9.0", digest: canonicalDigest({ profileId, sourceHash, distributions: distributions.stdout, pythonVersion: `${version.stdout}${version.stderr}`.trim(), platform: `${process.platform}-${process.arch}` }), launcher: "bubblewrap" };
    })();
    return this.identity;
  }
  async execute(input: Parameters<RecipeRuntimeV1["execute"]>[0]) {
    const workspace = resolve(input.workspace); const recipeRel = relative(workspace, resolve(input.recipeDirectory)).split(sep).join("/");
    if (recipeRel.startsWith("..")) throw new Error("Recipe directory escapes package runtime workspace");
    const bwrap = ["--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session", "--clearenv", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache", "--ro-bind", "/etc/passwd", "/etc/passwd", "--ro-bind", "/etc/group", "/etc/group", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home", "--dir", "/opt", "--ro-bind", packageDirectory, "/opt/pi-cad", "--bind", workspace, "/workspace", "--chdir", `/workspace/${recipeRel}`, "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/opt/pi-cad/python/.venv/bin:/usr/local/bin:/usr/bin:/bin", "--setenv", "PI_CAD_PYTHON", "/opt/pi-cad/python/.venv/bin/python", "--setenv", "PI_CAD_PYTHON_PROJECT", "/opt/pi-cad/python", "--setenv", "PI_CAD_INVOCATION_CWD", "/workspace"];
    for (const [key, value] of Object.entries(input.environment)) { if (key === "PI_RECIPE_RUNTIME_PROFILE") continue; const rel = value.startsWith(workspace) ? relative(workspace, value).split(sep).join("/") : null; bwrap.push("--setenv", key, rel !== null && !rel.startsWith("..") ? `/workspace/${rel}` : value); }
    bwrap.push("--", ...input.argv);
    const result = await spawnLogged({ command: "bwrap", args: bwrap, cwd: input.cwd, stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, timeoutMs: input.timeoutMs, signal: input.signal, workspaceLimit: { path: workspace, maxBytes: 16 * 1024 ** 3 } });
    return { exitCode: result.exitCode, durationMs: result.durationMs, stdout: result.stdout, stderr: result.stderr };
  }
}

export class MechanicalRecipeRuntime implements RecipeRuntimeV1 {
  private readonly managed = new ManagedMechanicalRecipeRuntime(); private readonly packaged = new PackageMechanicalRecipeRuntime();
  private select(profileId: string): RecipeRuntimeV1 { return profileId.startsWith("pi-cad/") ? this.packaged : this.managed; }
  qualify(cwd: string, profileId: string) { return this.select(profileId).qualify(cwd, profileId); }
  execute(input: Parameters<RecipeRuntimeV1["execute"]>[0]) { const profileId = input.environment.PI_RECIPE_RUNTIME_PROFILE; if (!profileId) throw new Error("Recipe runtime profile was not frozen into the execution environment"); return this.select(profileId).execute(input); }
}
