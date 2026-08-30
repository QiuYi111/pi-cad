import { extname, isAbsolute, relative, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  CAPABILITY_TOOLS,
  CONTROL_TOOLS,
  type CadPhase,
  type CadRunState,
} from "../shared/protocol.ts";
import { contractTools, phaseContract } from "../control/phase-contract.ts";
import { compiledSpec } from "../workflows/index.ts";
import { isHeadless, isTerminalStatus } from "./interaction-mode.ts";

export const BUILTIN_READONLY = ["read", "grep", "find", "ls"];

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
  if (!state || isTerminalStatus(state.status)) {
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
  const activeState = state && !isTerminalStatus(state.status) ? state : null;
  const phaseAllowed = new Set(activeState ? toolsForState(activeState) : toolsForPhase(phase));

  // Current global active set. The host API guarantees getActiveTools(); the
  // optional chaining keeps minimal test doubles working (they track state
  // through setActiveTools only).
  const current = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  if (activeState?.routeRequiresReassessment) {
    // A reassessment marker is a control-plane lock, not ordinary phase
    // visibility. Hide every tool outside the state-level allowlist,
    // including tools owned by other extensions.
    const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
    const registered = new Set(all.map((tool) => tool.name));
    const locked = new Set(current.filter((name) => phaseAllowed.has(name)));
    for (const name of phaseAllowed) {
      if (registered.size === 0 || registered.has(name)) locked.add(name);
    }
    pi.setActiveTools([...locked]);
    return;
  }
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

const NO_REROUTE_PHASES = new Set<CadPhase>(["intake", "requirements", "ready", "done"]);

/**
 * Phase 7: tool lists are COMPILED from phase contracts (capability
 * grants). The phase-0 golden matrix pins byte-for-byte equivalence
 * with the pre-contract hardcoded lists.
 */
export function toolsForPhase(phase: CadPhase): string[] {
  const tools = contractTools(phaseContract(phase));
  if (!NO_REROUTE_PHASES.has(phase)) return [...tools, "cad_reroute"];
  return tools;
}

export function finalReviewerEnabled(): boolean {
  const value = process.env.PI_CAD_FINAL_REVIEWER?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

export function requirementsReviewerEnabled(): boolean {
  const value = process.env.PI_CAD_REQUIREMENTS_REVIEWER?.trim().toLowerCase();
  if (value) return value === "1" || value === "true" || value === "on";
  return finalReviewerEnabled();
}

/** The transition table, not a hardcoded phase list, defines final closure. */
export function finalSubmissionAllowed(state: CadRunState): boolean {
  if (!finalReviewerEnabled() || !state.route) return false;
  const spec = compiledSpec(state.route);
  return spec.transitions[state.phase]?.accepted === "ready";
}

export function toolsForState(state: CadRunState): string[] {
  if (state.routeRequiresReassessment) {
    return [
      ...BUILTIN_READONLY,
      "cad_revise_requirements",
      "cad_reroute",
      ...(isHeadless(state) ? ["cad_declare_blocker"] : ["cad_wait_for_user"]),
    ];
  }
  let tools = toolsForPhase(state.phase);
  if (state.requirementsVersion && !tools.includes("cad_revise_requirements")) {
    tools = [...tools, "cad_revise_requirements"];
  }
  if (isHeadless(state)) {
    tools = tools.filter((tool) => tool !== "cad_wait_for_user");
    if (!isTerminalStatus(state.status) && state.phase !== "ready" && state.phase !== "done") {
      tools = [...tools, "cad_defer_clarification", "cad_declare_blocker"];
    }
  }
  return finalSubmissionAllowed(state) ? [...tools, "cad_submit_for_review"] : tools;
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
