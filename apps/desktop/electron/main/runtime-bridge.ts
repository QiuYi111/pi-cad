import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import type { AppSettings, RuntimeStatus } from "../../src/shared/contracts.js";

export interface RuntimePaths {
  piCadRepo: string;
  primeAgentRepo: string;
  projectPath: string;
}

const ENGINEERING_KNOWLEDGE = [
  ["parametric-cad-modeling", "skills/parametric-cad-modeling/SKILL.md", "skills/parametric-cad-modeling/references/cookbook.md"],
  ["mechanical-design", "skills/mechanical-design/SKILL.md", "skills/mechanical-design/references/design-reasoning.md"],
  ["assembly-design", "skills/assembly-design/SKILL.md", "skills/assembly-design/references/interfaces.md"],
  ["design-for-manufacturing", "skills/design-for-manufacturing/SKILL.md", "skills/design-for-manufacturing/references/geometry-rules.md"],
] as const;

export function engineeringKnowledgeProbe(piCadRoot: string): { count: number; command: string } {
  const files = ENGINEERING_KNOWLEDGE.flatMap(([, ...paths]) => paths);
  const tests = files.map((path) => `test -s ${JSON.stringify(`${piCadRoot}/${path}`)}`).join(" && ");
  return {
    count: ENGINEERING_KNOWLEDGE.length,
    command: `if ${tests}; then printf 'knowledge=${ENGINEERING_KNOWLEDGE.length}\\n'; else printf 'knowledge=missing\\n'; fi`,
  };
}

export async function withCanonicalProjectEnvironment(
  bridge: RuntimeBridge,
  projectPath: string,
  argv: string[],
): Promise<string[]> {
  let canonical = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  if (canonical) canonical = await bridge.toRuntimePath(canonical);
  else {
    const realProject = (await bridge.exec(["realpath", "-e", "--", projectPath])).stdout.trim();
    if (!realProject.startsWith("/")) throw new Error("Could not resolve the project authority directory.");
    const key = createHash("sha256").update(realProject).digest("hex");
    canonical = `${await bridge.homeDirectory()}/.local/share/pi-cad/${key}`;
  }
  return ["env", `PI_CAD_CANONICAL_PROJECT_DIR=${canonical}`, ...argv];
}

export interface RuntimeBridge {
  readonly kind: "wsl" | "native";
  readonly bundledRuntimePath?: string;
  exec(args: string[], options?: { input?: string; timeout?: number; user?: string }): Promise<{ stdout: string; stderr: string }>;
  spawn(args: string[]): ChildProcessWithoutNullStreams;
  pipe(args: string[], input: string, timeout?: number): Promise<{ stdout: string; stderr: string }>;
  toRuntimePath(value: string): Promise<string>;
  homeDirectory(): Promise<string>;
  commandPath(name: "node" | "uv"): Promise<string>;
  resolveRuntimePaths(settings: AppSettings): Promise<RuntimePaths>;
  check(settings: AppSettings): Promise<RuntimeStatus>;
  install(settings: AppSettings, onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus>;
  installWsl(onStatus?: (status: RuntimeStatus) => void): Promise<RuntimeStatus>;
  revealPath(path: string): Promise<string>;
}
