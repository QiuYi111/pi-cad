import { createHash } from "node:crypto";

import { runProcess } from "../../shared/process-runner.ts";
import type { RecipeRuntimeIdentityV1, RecipeRuntimeV1 } from "./types.ts";

export class LocalRecipeRuntime implements RecipeRuntimeV1 {
  async qualify(_cwd: string, profileId: string): Promise<RecipeRuntimeIdentityV1> {
    const value = `${profileId}\0${process.platform}\0${process.arch}\0${process.version}`;
    return { profileId, platform: `${process.platform}-${process.arch}`, version: process.version, digest: createHash("sha256").update(value).digest("hex"), launcher: "local-test" };
  }

  async execute(input: Parameters<RecipeRuntimeV1["execute"]>[0]) {
    const [command, ...args] = input.argv;
    if (!command) throw new Error("Recipe argv is empty");
    const result = await runProcess({
      command, args, cwd: input.recipeDirectory, env: { ...process.env, ...input.environment }, timeoutMs: input.timeoutMs,
      stdoutPath: input.stdoutPath, stderrPath: input.stderrPath, signal: input.signal,
      maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024,
    });
    return {
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
    };
  }
}
