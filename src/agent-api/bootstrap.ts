import core from "../extensions/core/index.ts";
import drawing from "../extensions/drawing/index.ts";
import geometry from "../extensions/geometry/index.ts";
import presentation from "../extensions/presentation/index.ts";
import probe from "../extensions/probe/index.ts";
import simulation from "../extensions/simulation/index.ts";
import ui from "../extensions/ui/index.ts";

let bootstrapped = false;

/** Pin the same live action schemas as the production extension composition. */
export function bootstrapAgentApiContracts(): void {
  if (bootstrapped) return;
  const api = {
    registerTool() {}, registerCommand() {}, on() {}, setActiveTools() {},
    getActiveTools() { return []; }, getAllTools() { return []; },
    appendEntry() {}, sendUserMessage() {}, setSessionName() {},
    events: { emit() {}, on() {} },
  } as any;
  for (const extension of [core, probe, geometry, ui, drawing, simulation, presentation]) extension(api);
  bootstrapped = true;
}
