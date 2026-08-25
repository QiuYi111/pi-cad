import { isAbsolute, relative, resolve, sep } from "node:path";

import { PI_CAD_OWNED_TOOLS } from "../../core/policies.ts";
import { PermissionEngineV7, assertScopedWrite, type WriteScopeRule } from "../../harness/permissions.ts";
import { HarnessProjectStoreV7 } from "../../harness/run-store.ts";
import { mechanicalRegistries } from "./registries.ts";
import { mechanicalActionRecoveryV7 } from "./action-recovery-v7.ts";
import type { LoadedHarnessRunV7 } from "../../harness/run-store.ts";

export const MECHANICAL_V7_WRITE_RULES: readonly WriteScopeRule[] = [
  { scope: "project:source", roots: ["models", "src", "design"] },
  { scope: "project:recipe", roots: ["recipes", "simulation"] },
  { scope: "project:deliverable", roots: ["build", "drawings", "presentation", "exports"] },
];

export interface ToolPolicyDecision {
  block: true;
  reason: string;
}

const CODE_MODE_CONTAINERS = new Set(["exec", "wait", "notebook"]);
const SHELL_ACTIONS = new Set(["bash", "exec_command", "write_stdin"]);
const PATH_WRITE_ACTIONS = new Set(["write", "edit"]);
const ADAPTER_ACTIONS: Readonly<Record<string, string>> = {
  exec_command: "bash",
  write_stdin: "bash",
  apply_patch: "edit",
};

function recoverableBlocked(loaded: LoadedHarnessRunV7, code: string, error: unknown, details: Record<string, unknown> = {}): ToolPolicyDecision {
  return {
    block: true,
    reason: JSON.stringify({
      schema: 1,
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
      ...details,
      nextAction: mechanicalActionRecoveryV7(loaded),
    }),
  };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function patchText(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "input" in input && typeof input.input === "string") return input.input;
  return null;
}

/** Parse every path whose contents or identity can be changed by apply_patch. */
export function applyPatchTargets(input: unknown): string[] {
  const patch = patchText(input);
  if (!patch) throw new Error("apply_patch input is missing");
  if (!patch.includes("*** Begin Patch") || !patch.includes("*** End Patch")) throw new Error("apply_patch envelope is malformed");
  const targets: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    const value = header?.[1] ?? move?.[1];
    if (value?.trim()) targets.push(value.trim());
  }
  if (targets.length === 0) throw new Error("apply_patch contains no file targets");
  return [...new Set(targets)];
}

/**
 * The one v7 authorization path used by direct Pi calls and Code Mode's
 * nested-tool preflight. Tool visibility is deliberately not trusted.
 */
export async function authorizeMechanicalToolV7(input: {
  cwd: string;
  toolName: string;
  toolInput: unknown;
}): Promise<ToolPolicyDecision | undefined> {
  if (CODE_MODE_CONTAINERS.has(input.toolName)) return undefined;
  const loaded = await new HarnessProjectStoreV7(input.cwd).currentRun(mechanicalRegistries);
  if (!loaded) {
    if (PI_CAD_OWNED_TOOLS.has(input.toolName) && !["cad_start", "cad_route"].includes(input.toolName)) {
      return { block: true, reason: "Pi-CAD v7 has no active run; call cad_route or cad_start first" };
    }
    return undefined;
  }

  const authorizationAction = ADAPTER_ACTIONS[input.toolName] ?? input.toolName;
  const registered = mechanicalRegistries.actions.get(authorizationAction);
  if (registered) {
    try {
      new PermissionEngineV7(mechanicalRegistries, loaded.registryContract)
        .assertAction(loaded.state, loaded.workflow, authorizationAction);
    } catch (error) {
      return recoverableBlocked(loaded, "ACTION_NOT_ENABLED", error, { attemptedAction: input.toolName });
    }
  } else if (PI_CAD_OWNED_TOOLS.has(input.toolName)) {
    return { block: true, reason: `Pi-CAD v7 action is not registered: ${input.toolName}` };
  } else {
    return undefined;
  }

  const phase = loaded.workflow.phases[loaded.state.phase]!;
  if (PATH_WRITE_ACTIONS.has(input.toolName)) {
    const path = input.toolInput && typeof input.toolInput === "object" && "path" in input.toolInput
      ? input.toolInput.path
      : undefined;
    if (typeof path !== "string" || !path.trim()) return { block: true, reason: `${input.toolName} path is missing` };
    try {
      assertScopedWrite({ cwd: input.cwd, target: path, enabledScopes: phase.writeScopes, rules: MECHANICAL_V7_WRITE_RULES });
    } catch (error) {
      return recoverableBlocked(loaded, "WRITE_SCOPE_VIOLATION", error, { attemptedAction: input.toolName, attemptedPath: path });
    }
  }
  if (input.toolName === "apply_patch") {
    try {
      for (const target of applyPatchTargets(input.toolInput)) {
        assertScopedWrite({ cwd: input.cwd, target, enabledScopes: phase.writeScopes, rules: MECHANICAL_V7_WRITE_RULES });
      }
    } catch (error) {
      return recoverableBlocked(loaded, "WRITE_SCOPE_VIOLATION", error, { attemptedAction: input.toolName });
    }
  }
  if (SHELL_ACTIONS.has(input.toolName)) {
    // A shell command can mutate through arbitrary interpreters and cannot be
    // proven read-only by string matching. Read-only workflow phases therefore
    // get no raw shell, even if a legacy grant still projects its name.
    if (phase.writeScopes.length === 0) {
      return recoverableBlocked(loaded, "READ_ONLY_ACTION", `Pi-CAD v7 read_only: ${input.toolName} is disabled; use bounded read tools or cad_probe`, { attemptedAction: input.toolName });
    }
    if (input.toolName === "exec_command" && input.toolInput && typeof input.toolInput === "object" && "workdir" in input.toolInput) {
      const workdir = input.toolInput.workdir;
      if (typeof workdir !== "string" || !inside(input.cwd, resolve(input.cwd, workdir))) {
        return recoverableBlocked(loaded, "WORKDIR_ESCAPE", "exec_command workdir escapes the project root", { attemptedAction: input.toolName });
      }
    }
  }
  return undefined;
}
