import { extname, isAbsolute, relative, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  CAPABILITY_TOOLS,
  CONTROL_TOOLS,
  type CadPhase,
  type CadRunState,
} from "../shared/protocol.ts";
import { contractTools, phaseContract } from "../control/phase-contract.ts";

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
