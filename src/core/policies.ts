import { extname, isAbsolute, relative, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  CAPABILITY_TOOLS,
  CONTROL_TOOLS,
  type CadPhase,
  type CadRunState,
} from "../shared/protocol.ts";

export const BUILTIN_READONLY = ["read", "grep", "find", "ls"];
export const BUILTIN_SOURCE = [...BUILTIN_READONLY, "bash", "edit", "write"];

/**
 * Tools Pi-CAD is allowed to manage. Everything else in the host session —
 * other extensions' tools (Goal, Ralph, ...), builtin tools the user enabled
 * or disabled — is explicitly NOT ours: `setActiveTools` replaces the whole
 * global set, so touching anything outside this namespace would silently
 * uninstall other plugins' tools.
 */
export const PI_CAD_OWNED_TOOLS: ReadonlySet<string> = new Set<string>([
  ...CONTROL_TOOLS,
  ...CAPABILITY_TOOLS,
]);

function effectivePhase(state: CadRunState | null): CadPhase {
  if (!state || state.status === "done" || state.status === "aborted") {
    return "intake";
  }
  return state.phase;
}

/**
 * Apply the Pi-CAD phase tool policy as an OVERLAY on the global active tool
 * set, never as the global set itself:
 *
 * 1. read the actual current active set (preserving other plugins and user
 *    tool choices, including deliberately disabled ones);
 * 2. remove only the Pi-CAD-owned tools;
 * 3. re-add the Pi-CAD-owned tools valid for the current phase.
 *
 * This is visibility/prompt hygiene only — actual enforcement lives in the
 * `tool_call` guard, so a manually re-activated tool still cannot bypass the
 * phase policy.
 */
export function applyCadToolOverlay(pi: ExtensionAPI, state: CadRunState | null): void {
  const phase = effectivePhase(state);
  const phaseAllowed = new Set(toolsForPhase(phase));

  // Current global active set. The host API guarantees getActiveTools(); the
  // optional chaining keeps minimal test doubles working (they track state
  // through setActiveTools only).
  const current = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  const next = new Set<string>(current);

  for (const name of PI_CAD_OWNED_TOOLS) {
    next.delete(name);
  }

  const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
  const registered = all.length > 0 ? new Set(all.map((tool) => tool.name)) : null;
  for (const name of PI_CAD_OWNED_TOOLS) {
    if (phaseAllowed.has(name) && (registered === null || registered.has(name))) {
      next.add(name);
    }
  }

  pi.setActiveTools([...next]);
}

const REVIEW_TOOLS = [
  ...BUILTIN_READONLY,
  "bash",
  "cad_inspect_visual",
  "cad_inspect_geometry",
  "cad_inspect_section",
  "cad_measure",
  "cad_compare_geometry",
  "cad_assembly_tree",
  "cad_simulate",
  "cad_optimize",
  "cad_transition",
];

const SOURCE_CAPABILITY_TOOLS = CAPABILITY_TOOLS.filter(
  (name) => name !== "cad_simulate" && name !== "cad_optimize",
);

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
        ...SOURCE_CAPABILITY_TOOLS,
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
      return [...COGNITIVE_TOOLS, "cad_simulate", "cad_wait_for_user"];
    case "audit":
      return [
        ...COGNITIVE_TOOLS,
        ...CAPABILITY_TOOLS.filter((name) => name !== "cad_optimize"),
        "cad_commit_plan",
        "cad_wait_for_user",
      ];
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
      return [...COGNITIVE_TOOLS, "cad_simulate", "cad_wait_for_user"];
    case "ready":
      return [
        ...BUILTIN_READONLY,
        "bash",
        ...SOURCE_CAPABILITY_TOOLS,
        "cad_simulate",
        "cad_finish",
      ];
    case "done":
      return BUILTIN_READONLY;
  }
}

export function isMutatingBash(command: string): boolean {
  const c = command.trim();
  if (/\b(rm|mv|cp|touch|tee|install|chmod|chown|ln|mkfs|dd)\b/.test(c)) return true;
  if (/(^|[|&;]\s*)(cat|echo|printf|python3?|uv)\b[^\n|&;]*\s(>>?)\s/.test(c)) return true;
  if (/>\s*\S/.test(c) && !/(2>)/.test(c)) return true;
  if (/\bcadctl\s+(build|render|export|drawing|simulate|optimize|present)\b/.test(c)) return true;
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
