import {
  CAPABILITY_TOOLS,
  CONTROL_TOOLS,
} from "../../shared/protocol.ts";

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
