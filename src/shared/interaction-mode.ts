import type { InteractionMode } from "./protocol.ts";

export function interactionModeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): InteractionMode {
  const value = env.PI_CAD_HEADLESS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on"
    ? "headless"
    : "interactive";
}
