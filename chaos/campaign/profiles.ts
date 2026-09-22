import { FAULT_BOUNDARIES } from "../reify/faults.ts";
import type { FaultBoundary } from "./types.ts";

/**
 * Provider *transport* faults really open TLS to the real endpoint, so they
 * stay explicit opt-in for the whole process. Without the flag they are always
 * NotApplicable, and generating them would only dilute a campaign.
 */
export const NETWORK_PROVIDER_FAULTS = [
  "providerTimeout",
  "providerReset",
  "providerLatency",
  "providerStreamCut",
  "providerRateLimited",
  "providerServerError",
];

export interface CampaignProfile {
  name: string;
  description: string;
  /** Schedule weight: how many slots this profile takes in the round cycle. */
  weight: number;
  boundaries: FaultBoundary[];
  /** `null` means every fault available in the campaign pool. */
  faults: string[] | null;
}

const byBoundary = (boundary: FaultBoundary): string[] =>
  Object.entries(FAULT_BOUNDARIES)
    .filter(([, value]) => value === boundary)
    .map(([name]) => name);

/**
 * Boundary profiles are derived from `FAULT_BOUNDARIES`, so a new fault is
 * picked up by the campaign the moment it is grouped. Targeted profiles are
 * the narrower questions the issue names, and they are explicit because a
 * narrow slice is a deliberate statement about what should be explored.
 */
export const CAMPAIGN_PROFILES: Record<string, CampaignProfile> = {
  mixed: {
    name: "mixed",
    description: "整个真实 fault 空间，按生成器权重",
    weight: 2,
    boundaries: ["process", "file-state", "provider-oauth", "race"],
    faults: null,
  },
  process: {
    name: "process",
    description: "进程 / 资源边界",
    weight: 3,
    boundaries: ["process"],
    faults: byBoundary("process"),
  },
  "file-state": {
    name: "file-state",
    description: "文件 / 状态边界",
    weight: 3,
    boundaries: ["file-state"],
    faults: byBoundary("file-state"),
  },
  "provider-oauth": {
    name: "provider-oauth",
    description: "provider / OAuth 边界（凭证侧；传输侧仍 opt-in）",
    weight: 2,
    boundaries: ["provider-oauth"],
    faults: byBoundary("provider-oauth"),
  },
  race: {
    name: "race",
    description: "race / 时序边界",
    weight: 3,
    boundaries: ["race"],
    faults: byBoundary("race"),
  },
  "kernel-lifecycle": {
    name: "kernel-lifecycle",
    description: "定向：kernel / worker 生命周期",
    weight: 1,
    boundaries: ["process"],
    faults: [
      "killKernelDuringBuild",
      "pauseKernelDuringBuild",
      "killIdleKernel",
      "killKernelChild",
      "killAuthorityDuringBuild",
    ],
  },
  "runtime-recovery": {
    name: "runtime-recovery",
    description: "定向：常驻 runtime / Prime 恢复",
    weight: 1,
    boundaries: ["process"],
    faults: ["killRuntimeDuringBuild", "pauseRuntimeDuringBuild", "restartRuntimeDuringBuild", "killPrimeRuntime"],
  },
  "session-isolation": {
    name: "session-isolation",
    description: "定向：conversation / run 隔离",
    weight: 1,
    boundaries: ["race"],
    faults: ["raceTwoConversationsBuild", "raceCrossConversationFault", "raceRepeatSubmitDuringFault"],
  },
  "desktop-consistency": {
    name: "desktop-consistency",
    description: "定向：Desktop ↔ backend 一致性",
    weight: 1,
    boundaries: ["file-state", "race"],
    faults: ["missingDesktopProjection", "raceRestartDuringTransition"],
  },
};

export function resolveProfiles(names?: string[]): CampaignProfile[] {
  if (!names?.length) return Object.values(CAMPAIGN_PROFILES);
  const resolved: CampaignProfile[] = [];
  for (const name of names) {
    const profile = CAMPAIGN_PROFILES[name];
    if (!profile) {
      throw new Error(`未知 profile "${name}"，可选：${Object.keys(CAMPAIGN_PROFILES).join(", ")}`);
    }
    resolved.push(profile);
  }
  return resolved;
}

/** Every fault the campaign may generate, given the provider opt-in. */
export function campaignFaultPool(providerFaults: boolean): string[] {
  const all = Object.keys(FAULT_BOUNDARIES);
  if (providerFaults) return all;
  return all.filter((name) => !NETWORK_PROVIDER_FAULTS.includes(name));
}

/** The concrete fault pool one profile generates from. */
export function profileFaultScope(profile: CampaignProfile, pool: string[]): string[] {
  if (!profile.faults) return pool;
  const selected = profile.faults.filter((name) => pool.includes(name));
  return selected.length ? selected : pool;
}
