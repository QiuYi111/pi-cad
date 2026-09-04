import type { DistillationStatus } from "@shared/contracts";

export function distillationTitle(state: DistillationStatus["state"]): string {
  if (state === "running") return "Distilling experience";
  if (state === "failed") return "Distillation failed";
  return "Distillation complete";
}
