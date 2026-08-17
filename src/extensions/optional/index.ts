import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import drawing from "../drawing/index.ts";
import presentation from "../presentation/index.ts";
import simulation from "../simulation/index.ts";

/**
 * Single explicit entry point for the optional release plugins.
 *
 * Pi-CAD packages do not load these by default. Load them with:
 *
 *   pi -e <pi-cad>/src/extensions/optional/index.ts
 */
export default function optionalExtensions(pi: ExtensionAPI) {
  drawing(pi);
  simulation(pi);
  presentation(pi);
}
