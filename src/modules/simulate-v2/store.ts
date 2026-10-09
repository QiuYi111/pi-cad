/**
 * Runtime and command types shared by the managed simulation runner. The
 * v6 run/observation store that used to live here was removed with the v6
 * kernel; v7 Recipe runs persist through the harness run store.
 */
export interface RuntimeIdentity {
  backend: string;
  runtime: string;
  platform: string;
  resolvedVersion: string;
  digest: string;
  launcher: string;
  accelerator?: Record<string, unknown>;
}

export interface SimulationCommandResult {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  diagnostics: string[];
}

export interface SimulationCommandRunner {
  resolveRuntime(cwd: string, backend: string, runtime: string): Promise<RuntimeIdentity>;
  execute(input: {
    cwd: string;
    workspace: string;
    recipeDirectory: string;
    command: string;
    environment: Record<string, string>;
    stdoutPath: string;
    stderrPath: string;
    timeoutMs: number;
    backend: string;
    runtime: string;
    signal?: AbortSignal;
  }): Promise<SimulationCommandResult>;
}
