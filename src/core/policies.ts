import { extname, isAbsolute, relative, resolve } from "node:path";

import { CAPABILITY_TOOLS, type CadPhase } from "../shared/protocol.ts";

export const BUILTIN_READONLY = ["read", "grep", "find", "ls"];
export const BUILTIN_SOURCE = [...BUILTIN_READONLY, "bash", "edit", "write"];

const REVIEW_TOOLS = [
  ...BUILTIN_READONLY,
  "bash",
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_inspect_section",
  "cad_measure",
  "cad_compare_geometry",
  "cad_assembly_tree",
  "cad_transition",
];

const COGNITIVE_TOOLS = [
  ...BUILTIN_READONLY,
  "bash",
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_inspect_section",
  "cad_measure",
  "cad_compare_geometry",
  "cad_assembly_tree",
  "cad_transition",
];

export function toolsForPhase(phase: CadPhase): string[] {
  switch (phase) {
    case "intake":
      return [...BUILTIN_READONLY, "cad_route"];
    case "requirements":
      return [...BUILTIN_READONLY, "bash", "cad_commit_requirements", "cad_wait_for_user"];
    case "build":
    case "modify":
    case "convert":
      return [
        ...BUILTIN_SOURCE,
        ...CAPABILITY_TOOLS,
        "cad_commit_candidate",
        "cad_transition",
        "cad_wait_for_user",
      ];
    case "review":
    case "compare":
      return [...REVIEW_TOOLS, "cad_wait_for_user", "cad_commit_plan"];
    case "plan":
    case "intent":
    case "transform_plan":
      return [...COGNITIVE_TOOLS, "cad_commit_plan", "cad_wait_for_user"];
    case "baseline":
    case "source_baseline":
    case "investigate":
    case "explain":
    case "concept":
    case "domain_analysis":
      return [...COGNITIVE_TOOLS, "cad_wait_for_user"];
    case "audit":
      return [...COGNITIVE_TOOLS, ...CAPABILITY_TOOLS, "cad_commit_plan", "cad_wait_for_user"];
    case "gap_closure":
      return [
        ...BUILTIN_SOURCE,
        ...CAPABILITY_TOOLS,
        "cad_commit_candidate",
        "cad_commit_plan",
        "cad_transition",
        "cad_wait_for_user",
      ];
    case "package":
      return [...BUILTIN_READONLY, "bash", "edit", "write", ...CAPABILITY_TOOLS, "cad_commit_plan", "cad_transition", "cad_wait_for_user"];
    case "final_review":
      return [...COGNITIVE_TOOLS, "cad_wait_for_user"];
    case "ready":
      return [...BUILTIN_READONLY, "bash", ...CAPABILITY_TOOLS, "cad_finish"];
    case "done":
      return BUILTIN_READONLY;
  }
}

export function isMutatingBash(command: string): boolean {
  const c = command.trim();
  if (/\b(rm|mv|cp|touch|tee|install|chmod|chown|ln|mkfs|dd)\b/.test(c)) return true;
  if (/(^|[|&;]\s*)(cat|echo|printf|python3?|uv)\b[^\n|&;]*\s(>>?)\s/.test(c)) return true;
  if (/>\s*\S/.test(c) && !/(2>)/.test(c)) return true;
  if (/\bcadctl\s+(build|render|export|drawing|simulate|present)\b/.test(c)) return true;
  return false;
}

export function writePathAllowed(
  cwd: string,
  rawPath: string,
  policy: "read_only" | "source_only" | "allowed",
): { allowed: boolean; reason?: string } {
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(resolve(cwd), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { allowed: false, reason: "path escapes project root" };
  }
  if (rel.startsWith(".pi-cad")) {
    return { allowed: false, reason: ".pi-cad is owned by the harness" };
  }
  if (policy === "allowed") return { allowed: true };
  if (policy === "read_only") {
    return { allowed: false, reason: `workflow phase is read_only (tried to write ${rel})` };
  }
  const ok = extname(absolute) === ".py" || rel.startsWith("models/");
  if (!ok) {
    return { allowed: false, reason: `source_only policy allows only Python model sources (tried ${rel})` };
  }
  return { allowed: true };
}
