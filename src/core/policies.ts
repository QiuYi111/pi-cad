import { extname, isAbsolute, relative, resolve } from "node:path";

/** Final-review submission gate: PI_CAD_FINAL_REVIEWER=1 enables cad_submit_for_review. */
export function finalReviewerEnabled(): boolean {
  const value = process.env.PI_CAD_FINAL_REVIEWER?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export function writePathAllowed(
  cwd: string,
  rawPath: string,
  policy: "read_only" | "source_only" | "allowed",
  allowSimulationRecipe = false,
): { allowed: boolean; reason?: string } {
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(resolve(cwd), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { allowed: false, reason: "path escapes project root" };
  }
  if (rel.startsWith(".pi-cad")) {
    return { allowed: false, reason: ".pi-cad is owned by the harness" };
  }
  const normalized = rel.split("\\").join("/");
  if (allowSimulationRecipe && (normalized === "simulation" || normalized.startsWith("simulation/"))) {
    return { allowed: true };
  }
  if (policy === "allowed") return { allowed: true };
  if (policy === "read_only") {
    return { allowed: false, reason: `workflow phase is read_only (tried to write ${rel})` };
  }
  const ok = extname(absolute) === ".py" || normalized.startsWith("models/") || normalized.startsWith("simulation/");
  if (!ok) {
    return { allowed: false, reason: `source_only policy allows only Python model sources (tried ${rel})` };
  }
  return { allowed: true };
}
