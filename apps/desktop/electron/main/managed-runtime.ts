import type { AppSettings, RuntimeStatus } from "../../src/shared/contracts.js";
import { runtimeChecksReady, type RuntimeBridge } from "./runtime-bridge.js";

export async function updateManagedRuntime(bridge: RuntimeBridge, settings: AppSettings, onStatus: (status: RuntimeStatus) => void): Promise<void> {
  if (settings.piCadRepo || settings.primeAgentRepo || !bridge.bundledRuntimePath) return;
  const status = await bridge.check(settings);
  const hostReady = bridge.kind !== "wsl" || status.checks.some((item) => item.id === "wsl" && item.status === "ready");
  const stale = status.checks.some((item) => (item.id === "prime" || item.id === "picad") && item.status !== "ready");
  if (!hostReady || !stale) return;
  const installed = await bridge.install(settings, onStatus);
  if (!runtimeChecksReady(installed.checks)) throw new Error(installed.message || "Runtime update did not finish");
}
