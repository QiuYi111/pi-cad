import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppSettings, RuntimeStatus } from "../../src/shared/contracts.js";

export interface RuntimePaths {
  piCadRepo: string;
  primeAgentRepo: string;
  projectPath: string;
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
  installWsl(): Promise<RuntimeStatus>;
  revealPath(path: string): Promise<string>;
}
