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
      const records = object(state.records);
      const evidence = Array.isArray(state.evidence) ? state.evidence : [];
      const unmet = [
        ...(Array.isArray(phase.recordObligations) ? phase.recordObligations : []).filter((item: any) => !records[item.ref]),
        ...(Array.isArray(phase.evidenceObligations) ? phase.evidenceObligations : []).filter((item: any) => !evidence.some((entry: any) => entry?.obligationRef === item.ref)),
      ].map((item: any) => item.ref);
      const roots = (phase.writeScopes ?? []).flatMap((scope: string) => scope === "project:source" ? ["models/", "src/", "design/"] : scope === "project:recipe" ? ["recipes/", "simulation/"] : scope === "project:deliverable" ? ["build/", "drawings/", "presentation/", "exports/"] : []);
      return { text: ["## Current Action", `phase=${state.phase} status=${state.status}`, `purpose=${phase.purpose ?? ""}`, `actions=${(phase.actions ?? []).join(",") || "none"}`, `unmetObligations=${unmet.join(",") || "none"}`, `writeRoots=${roots.join(",") || "none"}`, `transitions=${transitions.join(",") || "none"}`, "Every mutation result refreshes this card; never use a transition or action absent from the latest result."].join("\n") };
    },
  });
  compiler.register({
    id: "mechanical.mission", version: "1.0.0", maxBytesRead: 65536, maxBytesEmitted: 32768,
    async render(reader) { const frame = object(await reader.readContextFrame()); return { text: frame.mission ? `## Mission\n${String(frame.mission)}` : "" }; },
  });
  compiler.register({
    id: "mechanical.observations", version: "1.0.0", maxBytesRead: 524288, maxBytesEmitted: 32768,
    async render(reader) {
      const index = object(await reader.readIndex("observations"));
      const entries = Array.isArray(index.entries) ? index.entries.slice(0, 8).map((value: unknown) => {
        const item = object(value);
        return {
          id: item.id,
          tool: item.tool,
          phase: item.phase,
          headline: item.headline,
          subjectHash: item.subjectHash,
          payloadBytes: item.payloadBytes,
          visualCount: item.visualCount,
          collections: Array.isArray(item.collections) ? item.collections.map((entry: unknown) => {
            const descriptor = object(entry);
            return { name: descriptor.name, count: descriptor.count };
          }) : [],
        };
      }) : [];
      if (!entries.length) return { text: "" };
      return { text: `## Observation Refs\n${JSON.stringify({ schema: 1, total: index.total, entries })}\nUse cad_recall_observation to materialize a snapshot, visuals, or a bounded collection page.` };
    },
  });
  compiler.register({
    id: "mechanical.runtime-availability", version: "1.0.0", maxBytesRead: 131072, maxBytesEmitted: 16384,
    async render(reader) { const index = await reader.readIndex("runtime-availability"); return { text: index ? `## Runtime Availability\n${JSON.stringify(index)}` : "" }; },
  });
  return compiler;
}
