import type { AppSettings } from "../../src/shared/contracts.js";
import type { RuntimeBridge } from "./runtime-bridge.js";
import { RemoteBridge } from "./remote-bridge.js";

/** Blender and ParaView are not provisioned in cloud workspaces during stage 1 (plan §9.5). */
export const STAGE_1_CLOUD_UNAVAILABLE = "阶段 1 云端模式不可用";

export function isCloudMode(settings: Pick<AppSettings, "mode">): boolean {
  return settings.mode === "cloud";
}

/** Throws the stage 1 message for a feature that does not run in cloud mode. */
export function assertCloudAvailable(settings: Pick<AppSettings, "mode">, feature: string): void {
  if (isCloudMode(settings)) throw new Error(`${feature}：${STAGE_1_CLOUD_UNAVAILABLE}`);
}

/** Identifies the runtime bridge a settings value needs. A change of key replaces the bridge. */
export function runtimeBridgeKey(settings: AppSettings, platform: NodeJS.Platform): string {
  if (isCloudMode(settings)) return `cloud:${settings.cloud?.userEmail ?? ""}`;
  return platform === "win32" ? `wsl:${settings.distro}` : `native:${platform}`;
}

export interface RuntimeBridgeFactories {
  local(): RuntimeBridge;
  remote(): RuntimeBridge;
}

/** Chooses the bridge for the mode: the cloud workspace in cloud mode, the local runtime otherwise. */
export function createRuntimeBridge(settings: AppSettings, platform: NodeJS.Platform, factories: RuntimeBridgeFactories): { key: string; bridge: RuntimeBridge } {
  return {
    key: runtimeBridgeKey(settings, platform),
    bridge: isCloudMode(settings) ? factories.remote() : factories.local(),
  };
}

/**
 * The cloud workspace bridge when the factory chose one, otherwise null. Handlers that move files
 * to or from the workspace use this instead of re-reading the mode from settings.
 */
export function workspaceBridgeOf(bridge: RuntimeBridge): RemoteBridge | null {
  return bridge instanceof RemoteBridge ? bridge : null;
}
