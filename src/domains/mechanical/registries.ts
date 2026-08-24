import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createRegistrySet, type Registration, type RegistrySet } from "../../harness/registry.ts";
import { CadStartParamsSchema } from "../../harness/kernel.ts";

// Pi loads each configured extension independently. Some loaders therefore
// evaluate this module more than once even though all extensions share one
// process. Keep the registry on globalThis so every Mechanical Pack action
// contributes to the same contract set before a workflow is compiled.
const MECHANICAL_REGISTRIES_KEY = Symbol.for("pi-cad.mechanical-registries.v7");
const sharedGlobal = globalThis as unknown as Record<PropertyKey, unknown>;
export const mechanicalRegistries: RegistrySet =
  (sharedGlobal[MECHANICAL_REGISTRIES_KEY] as RegistrySet | undefined) ?? createRegistrySet();
sharedGlobal[MECHANICAL_REGISTRIES_KEY] = mechanicalRegistries;

function staticRegistration(id: string, schema: unknown, semantics: unknown): Registration {
  return { id, contract: { version: "1.0.0", schema: schema as never, semantics: semantics as never } };
}

const genericActions = {
  cad_start: "Compile and atomically start the selected immutable workflow.",
  workflow_replace: "Replace a workflow snapshot without mutating its predecessor.",
  transition: "Apply a legal workflow event through the generic reducer.",
  commit_record: "Close one predeclared record obligation with a typed immutable record.",
  commit_evidence: "Close the exact obligation pre-bound to immutable evidence provenance.",
  finish: "Close a ready run and atomically promote its declared Project Head effects.",
} as const;

for (const [id, meaning] of Object.entries(genericActions)) {
  mechanicalRegistries.actions.registerIdempotent(staticRegistration(
    id,
    { input: id === "cad_start" ? CadStartParamsSchema : { type: "object", additionalProperties: false }, output: id === "cad_start" ? { protocol: "pi-tool-result-v1", failClosed: true } : { protocol: "kernel-mutation-result-v1" } },
    { owner: "kernel", mutation: "transactional", meaning },
  ));
}

for (const id of ["read", "grep", "find", "ls", "bash", "edit", "write", "exec_command", "write_stdin", "apply_patch"]) {
  mechanicalRegistries.actions.registerIdempotent(staticRegistration(
    id,
    { input: { protocol: `pi-host-tool/${id}` }, output: { protocol: "pi-tool-result-v1" } },
    { owner: "pi-host", mutation: ["edit", "write", "bash", "exec_command", "write_stdin", "apply_patch"].includes(id) ? "phase-guarded" : "read-only", meaning: `Host ${id} tool governed by Kernel grants and write scopes.` },
  ));
}

const grants: Record<string, { meaning: string; tools: string[]; writeBoundary: string; safetyCap: string }> = {
  file_read: { meaning: "Read project files through bounded host tools.", tools: ["read", "grep", "find", "ls"], writeBoundary: "none", safetyCap: "project-root" },
  shell: { meaning: "Run a controlled Linux process where the phase permits it.", tools: ["bash"], writeBoundary: "phase-policy", safetyCap: "process-runner" },
  file_edit_source: { meaning: "Edit declared source-authoring paths.", tools: ["edit", "write"], writeBoundary: "models/**, Python model sources, simulation/**", safetyCap: "project-root-minus-harness" },
  file_edit_recipe: { meaning: "Edit Recipe authoring paths without changing design CAD.", tools: ["edit", "write"], writeBoundary: "simulation/** or recipes/**", safetyCap: "project-root-minus-harness" },
  observe: { meaning: "Create typed probes; v7 observations are read directly from immutable indexed files.", tools: ["cad_probe"], writeBoundary: "run-owned-observation-storage", safetyCap: "no-project-source-write" },
  observe_interference: { meaning: "Observe pairwise solid interference facts.", tools: ["cad_probe"], writeBoundary: "run-owned-observation-storage", safetyCap: "no-project-source-write" },
  observe_programmable: { meaning: "Run fenced read-only B-Rep calculations.", tools: ["cad_probe"], writeBoundary: "run-owned-observation-storage", safetyCap: "no-project-source-write" },
  model_build: { meaning: "Execute deterministic MODEL primitives.", tools: ["cad_build_step"], writeBoundary: "declared-model-output", safetyCap: "no-head-promotion" },
  deliverable: { meaning: "Generate declared export, drawing, or presentation artifacts.", tools: ["cad_export", "cad_generate_drawing", "cad_render_scene"], writeBoundary: "declared-deliverable-output", safetyCap: "no-head-promotion" },
  simulate: { meaning: "Prepare, execute, observe, and explicitly commit simulation Recipes.", tools: ["cad_simulate", "cad_sim_observe", "cad_commit_simulation", "cad_derive_analysis_model"], writeBoundary: "recipe-and-run-storage", safetyCap: "managed-runtime-no-network" },
  optimize: { meaning: "Execute an optimization Recipe without implicit acceptance.", tools: ["cad_optimize"], writeBoundary: "recipe-and-run-storage", safetyCap: "managed-runtime-no-network" },
  route: { meaning: "Select the initial Mechanical workflow.", tools: ["cad_route"], writeBoundary: "workflow-snapshot", safetyCap: "registered-workflow-only" },
  reroute: { meaning: "Replace the Mechanical workflow under monotonicity/authority rules.", tools: ["cad_reroute"], writeBoundary: "workflow-snapshot", safetyCap: "authority-protected" },
  commit_requirements: { meaning: "Commit the authoritative requirements record.", tools: ["cad_commit_requirements"], writeBoundary: "record:requirements", safetyCap: "typed-record-only" },
  commit_frame_context: { meaning: "Commit the imported-frame interpretation.", tools: ["cad_commit_frame_context"], writeBoundary: "record:frame_context", safetyCap: "typed-record-only" },
  commit_plan: { meaning: "Commit the plan owned by the current phase.", tools: ["cad_commit_plan"], writeBoundary: "record:plan", safetyCap: "typed-record-only" },
  commit_assembly_design: { meaning: "Commit the Mechanical assembly definition.", tools: ["cad_commit_assembly_design"], writeBoundary: "record:assembly_design", safetyCap: "typed-record-only" },
  commit_interface_contracts: { meaning: "Commit Mechanical interface contracts.", tools: ["cad_commit_interface_contracts"], writeBoundary: "record:interface_contracts", safetyCap: "typed-record-only" },
  commit_candidate: { meaning: "Propose a source-authored candidate without unconditional Project Head promotion.", tools: ["cad_commit_candidate"], writeBoundary: "candidate-and-evidence", safetyCap: "review-required" },
  transition: { meaning: "Request one event exposed by the workflow snapshot.", tools: ["cad_transition"], writeBoundary: "state", safetyCap: "snapshot-transition-table" },
  wait_for_user: { meaning: "Pause an interactive run for user-owned authority.", tools: ["cad_wait_for_user"], writeBoundary: "state", safetyCap: "interactive-only" },
  finish: { meaning: "Finish after every closure guard is satisfied.", tools: ["cad_finish"], writeBoundary: "state-and-project-head", safetyCap: "ready-only" },
};

for (const [id, descriptor] of Object.entries(grants)) {
  const maxWriteScopes = id === "file_edit_source" ? ["project:source", "project:recipe", "project:deliverable"]
    : id === "file_edit_recipe" ? ["project:recipe"]
      : id === "observe" || id.startsWith("observe_") ? ["run:observation"]
        : id === "model_build" || id === "deliverable" ? ["project:deliverable"]
          : id === "simulate" || id === "optimize" ? ["project:recipe", "run:observation", "run:evidence"]
            : id.startsWith("commit_") ? ["run:record", "run:state"]
              : id === "route" || id === "reroute" || id === "transition" || id === "wait_for_user" ? ["run:state"]
                : id === "finish" ? ["run:state", "project:head"]
                  : [];
  mechanicalRegistries.grants.registerIdempotent(staticRegistration(id, { tools: descriptor.tools, maxWriteScopes }, descriptor));
}

const simple = (kind: keyof Pick<RegistrySet, "hooks" | "contextProviders" | "reviewProfiles" | "recordTypes" | "evidenceTypes" | "recipeKinds">, ids: Record<string, unknown>) => {
  for (const [id, semantics] of Object.entries(ids)) {
    mechanicalRegistries[kind].registerIdempotent(staticRegistration(id, { protocol: `${kind}-v1` }, semantics));
  }
};

simple("hooks", {
  "mechanical.candidate.observe": { timing: "after-candidate-freeze", effect: "produce observations only" },
  "mechanical.requirements.invalidate": { timing: "requirements-revision", effect: "dependency-directed invalidation" },
  "mechanical.project.promote": { timing: "accepted-closure", effect: "declared Project Head promotion" },
});
simple("contextProviders", {
  "kernel.current-action": { source: "state/workflow/registry snapshots", maxBytesRead: 131072, maxBytesEmitted: 32768 },
  "mechanical.mission": { source: "requirements record snapshot", maxBytesRead: 65536, maxBytesEmitted: 32768 },
  "mechanical.observations": { source: "bounded observation index", maxBytesRead: 524288, maxBytesEmitted: 32768 },
  "mechanical.runtime-availability": { source: "bounded runtime manifests", maxBytesRead: 131072, maxBytesEmitted: 16384 },
});
simple("reviewProfiles", {
  "mechanical.design-review": { reviewer: "fresh", deterministicPreflight: true, authority: "advisory-until-reducer" },
  "mechanical.final-review": { reviewer: "fresh", deterministicPreflight: true, authority: "closure-gate" },
});
simple("recordTypes", {
  requirements: { freshness: "requirements-version", closure: "cad_commit_requirements" },
  frame_context: { freshness: "baseline-and-requirements", closure: "cad_commit_frame_context" },
  plan: { freshness: "phase-and-requirements", closure: "cad_commit_plan" },
  assembly_design: { freshness: "requirements-and-route", closure: "cad_commit_assembly_design" },
  interface_contracts: { freshness: "assembly-design-and-requirements", closure: "cad_commit_interface_contracts" },
});

for (const id of ["visual", "geometry", "surfaces", "build", "compare", "section", "drawing", "simulation", "presentation", "convert", "assembly", "interference", "sections", "optimization"]) {
  mechanicalRegistries.evidenceTypes.registerIdempotent(staticRegistration(id, { protocol: "evidence-ref-v1" }, { freshness: "subject-and-declared-input-hashes", explicitCommit: id === "simulation" }));
}

simple("recipeKinds", {
  simulation: { result: "evidence", obligationBinding: "required", observerRerunnable: true },
  optimization: { result: "artifact-or-evidence", obligationBinding: "optional", observerRerunnable: true },
  drawing: { result: "artifact-or-evidence", obligationBinding: "optional", observerRerunnable: true },
  presentation: { result: "artifact-or-evidence", obligationBinding: "optional", observerRerunnable: true },
  "analysis-model": { result: "record-and-artifact", obligationBinding: "forbidden", observerRerunnable: false },
});

const runtimeRegistry = JSON.parse(readFileSync(fileURLToPath(new URL("../../../assets/simulation-runtimes.json", import.meta.url)), "utf-8")) as { schema: number; runtimes: Array<Record<string, unknown>> };
for (const runtime of runtimeRegistry.runtimes) {
  const id = `${String(runtime.backend)}/${String(runtime.runtime)}`;
  mechanicalRegistries.runtimeProfiles.registerIdempotent(staticRegistration(
    id,
    { registrySchema: runtimeRegistry.schema, availabilityManifestSchema: 1, identityDigest: "sha256" },
    runtime,
  ));
}
mechanicalRegistries.runtimeProfiles.registerIdempotent(staticRegistration(
  "pi-cad/cadctl-0.9",
  { registrySchema: 1, identityDigest: "sha256" },
  { owner: "mechanical-pack", launcher: "bubblewrap", network: "none", runtime: "cadctl-0.9", limits: { cpu: 8, memoryGiB: 24, tasks: 1024, wallHours: 4, workspaceGiB: 16 } },
));
