import { CadProjectStore } from "../shared/store.ts";
import { HarnessProjectStoreV7 } from "./run-store.ts";

export type KernelEngine = "v6" | "v7";

let warnedV6Fallback = false;

/**
 * Active runs win over defaults. This is the no-migration compatibility
 * rule: an active v6 run keeps its engine even after v7 becomes the default.
 */
export async function selectKernelEngine(cwd: string, configured = process.env.PI_CAD_KERNEL): Promise<KernelEngine> {
  if (configured !== undefined && configured !== "v6" && configured !== "v7") throw new Error(`PI_CAD_KERNEL must be v6 or v7, got ${configured}`);
  if (configured === "v6" && !warnedV6Fallback) {
    warnedV6Fallback = true;
    process.emitWarning("PI_CAD_KERNEL=v6 is a deprecated operational fallback; new work defaults to Harness Kernel v7.", { code: "PI_CAD_V6_DEPRECATED" });
  }
  const v7 = await new HarnessProjectStoreV7(cwd).currentRun().catch(() => null);
  if (v7 && !["done", "aborted", "blocked_external", "budget_exhausted"].includes(v7.state.status)) return "v7";
  const v6State = await new CadProjectStore(cwd).load().catch(() => null);
  if (v6State && !["done", "aborted", "blocked_external", "budget_exhausted"].includes(v6State.status)) return "v6";
  // Explicit fallback applies only when no active run would be orphaned.
  return configured ?? "v7";
}
