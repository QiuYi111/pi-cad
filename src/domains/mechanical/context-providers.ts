import { ContextCompiler, type ContextSnapshotReader } from "../../harness/context.ts";
import type { RegistrySet } from "../../harness/registry.ts";

function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }

export function mechanicalContextCompiler(registries: RegistrySet): ContextCompiler {
  const compiler = new ContextCompiler(registries);
  compiler.register({
    id: "kernel.current-action", version: "1.0.0", maxBytesRead: 131072, maxBytesEmitted: 32768,
    async render(reader: ContextSnapshotReader) {
      const [stateValue, workflowValue] = await Promise.all([reader.readState(), reader.readWorkflow()]);
      const state = object(stateValue); const workflow = object(workflowValue); const phase = object(object(workflow.phases)[String(state.phase)]);
      if (!state.phase) return { text: "" };
      const transitions = Object.entries(object(phase.transitions)).map(([event, value]) => `${event}→${String(object(value).target)}`);
      return { text: ["## Current Action", `phase=${state.phase} status=${state.status}`, `actions=${(phase.actions ?? []).join(",") || "none"}`, `recordObligations=${(phase.recordObligations ?? []).map((item: any) => item.ref).join(",") || "none"}`, `evidenceObligations=${(phase.evidenceObligations ?? []).map((item: any) => item.ref).join(",") || "none"}`, `transitions=${transitions.join(",") || "none"}`].join("\n") };
    },
  });
  compiler.register({
    id: "mechanical.mission", version: "1.0.0", maxBytesRead: 65536, maxBytesEmitted: 32768,
    async render(reader) { const frame = object(await reader.readContextFrame()); return { text: frame.mission ? `## Mission\n${String(frame.mission)}` : "" }; },
  });
  compiler.register({
    id: "mechanical.observations", version: "1.0.0", maxBytesRead: 524288, maxBytesEmitted: 32768,
    async render(reader) { const index = await reader.readIndex("observations"); return { text: index ? `## Observation Index\n${JSON.stringify(index)}` : "" }; },
  });
  compiler.register({
    id: "mechanical.runtime-availability", version: "1.0.0", maxBytesRead: 131072, maxBytesEmitted: 16384,
    async render(reader) { const index = await reader.readIndex("runtime-availability"); return { text: index ? `## Runtime Availability\n${JSON.stringify(index)}` : "" }; },
  });
  return compiler;
}
