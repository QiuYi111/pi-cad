/**
 * PROBE module entry (refactor Phase 2/3).
 *
 * Importing this module registers every builtin preset exactly once.
 */
import { registerProbePresets } from "./presets/index.ts";

let registered = false;

export function ensureProbePresets(): void {
  if (registered) return;
  registerProbePresets();
  registered = true;
}

export {
  probePreset,
  probePresetNames,
  renderProbeResult,
  type ProbeContext,
  type ProbePreset,
  type ProbeResult,
} from "./registry.ts";
