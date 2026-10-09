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
  /**
   * Real preparation commands this profile's rounds start from. A profile that
   * wants the multi-conversation races has to bring two working conversations
   * with it: the faults' preconditions stay strict, and the preparation is a
   * real action in the sequence the artifact records.
   */
  preparation?: string;
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
    // Half of this pool is the multi-conversation races; the round brings the
    // second working conversation instead of leaving them NotApplicable.
    preparation: "multi-conversation",
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
  "idle-kernel": {
    name: "idle-kernel",
    description: "定向：warm kernel 空闲时被杀 / kernel 树里的子进程",
    // `killIdleKernel` needs an owned warm kernel, which only a real build
    // creates: in the mixed soak it reported "这一轮还没真 build 过" more often
    // than it injected. The round builds once first instead of the campaign
    // hoping a build happened before the fault.
    weight: 1,
    boundaries: ["process"],
    faults: ["killIdleKernel", "killKernelChild", "killKernelDuringBuild", "pauseKernelDuringBuild"],
    preparation: "warm-kernel",
  },
  "session-isolation": {
    name: "session-isolation",
    description: "定向：conversation / run 隔离",
    weight: 1,
    boundaries: ["race"],
    faults: ["raceTwoConversationsBuild", "raceCrossConversationFault", "raceRepeatSubmitDuringFault"],
    preparation: "multi-conversation",
  },
  "lifecycle-action-race": {
    name: "lifecycle-action-race",
    description: "定向：kernel / runtime 的 kill、restart 与用户 action 交错",
    // Both boundaries: the kill / restart is a real process fault, and the
    // point of the profile is that a real user action overlaps it.
    weight: 1,
    boundaries: ["process", "race"],
    faults: [
      "raceUserActionDuringKernelFault",
      "raceRestartDuringTransition",
      "killRuntimeDuringBuild",
      "restartRuntimeDuringBuild",
      "killAuthorityDuringBuild",
      "killKernelDuringBuild",
    ],
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
