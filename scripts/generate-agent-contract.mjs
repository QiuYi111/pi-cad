import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checking = process.argv.includes("--check");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const { buildAgentContract } = await jiti.import(join(root, "src/core/agent-contract.ts"), { default: true });
const registeredSchemas = {};
const mockPi = {
  registerTool(tool) { registeredSchemas[tool.name] = tool.parameters; },
  registerCommand() {}, on() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
  appendEntry() {}, sendUserMessage() {}, setSessionName() {}, events: { emit() {}, on() {} },
};
for (const extension of pkg.pi.extensions) {
  const register = await jiti.import(join(root, extension), { default: true });
  register(mockPi);
}
const contract = buildAgentContract(registeredSchemas);
const unresolvedSchemas = contract.tools.filter((tool) => tool.inputSchema?.schemaSource).map((tool) => tool.name);
if (unresolvedSchemas.length) throw new Error(`active tools missing registered schemas: ${unresolvedSchemas.join(", ")}`);

const generated = new Map();
generated.set("assets/agent-contract.json", `${JSON.stringify(contract, null, 2)}\n`);
generated.set("skills/pi-cad/references/generated/architecture.md", renderArchitecture(contract));
generated.set("skills/pi-cad/references/generated/workflow.md", renderWorkflow(contract));
generated.set("assets/cookbook-catalog.json", `${JSON.stringify(renderCookbookCatalog(contract), null, 2)}\n`);
for (const category of ["control", "model", "probe", "simulation", "optimization", "deliverable", "experience"]) {
  generated.set(`skills/pi-cad-tools/references/generated/${category}.md`, renderTools(contract, category));
}

let drift = false;
for (const [relative, content] of generated) {
  const path = join(root, relative);
  if (checking) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== content) {
      drift = true;
      process.stderr.write(`generated agent contract is stale: ${relative}\n`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}
if (drift) process.exitCode = 1;

for (const tool of contract.tools) {
  const cookbook = join(root, "skills", tool.cookbook);
  try { await access(cookbook); }
  catch {
    process.stderr.write(`missing cookbook for ${tool.name}: ${tool.cookbook}\n`);
    process.exitCode = 1;
  }
}

function renderArchitecture(value) {
  const lines = [
    "# Generated Pi-CAD architecture contract",
    "",
    "> Generated from executable registries. Do not edit; run `npm run generate:agent-contract`.",
    "",
    "Normal Pi-CAD use relies on this contract, the current action card, and cookbooks. Reading `src/**` is not an operating step.",
    "",
    "## Layers",
    "",
    ...value.architecture.layers.map((item) => `- **${item.name}** — ${item.responsibility}`),
    "",
    "## Invariants",
    "",
    ...value.architecture.invariants.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}

function renderWorkflow(value) {
  const lines = [
    "# Generated workflow contract",
    "",
    "> Generated from route compiler, phase grants, and obligation registry. Do not edit.",
    "",
    "The per-turn Current Action Card is authoritative for the active route. This document explains every possible phase/event without requiring source inspection.",
    "",
    "## Phases",
    "",
  ];
  for (const phase of value.phases) {
    lines.push(`### ${phase.phase}`, "", phase.purpose, "", `- Mutation policy: ${phase.mutationPolicy}`, `- Grants: ${phase.grants.join(", ") || "none"}`, `- Tools: ${phase.tools.join(", ") || "none"}`, `- Required records: ${phase.requiredRecords.join(", ") || "none"}`, `- Possible events: ${phase.events.map((event) => `${event.event}→${event.targets.join("/")}`).join(", ") || "none"}`, "");
  }
  lines.push("## Events", "");
  for (const event of value.events) {
    lines.push(`### ${event.event}`, "", event.meaning, "", `- Use when: ${event.useWhen}`, `- Do not use when: ${event.doNotUseWhen}`, `- Occurs in: ${[...new Set(event.occurrences.map((item) => item.phase))].join(", ")}`, "");
  }
  lines.push("## Obligations", "");
  for (const obligation of value.obligations) {
    lines.push(`- **${obligation.key}** — close: ${obligation.closeWith} Invalidation: ${obligation.invalidatedBy} Recovery: ${obligation.recovery}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderTools(value, category) {
  const tools = value.tools.filter((tool) => tool.category === category);
  const lines = [
    `# Generated ${category} tool contract`,
    "",
    "> Generated from active registrations, TypeBox schemas, phase grants, and the cookbook catalog. Do not edit.",
    "",
  ];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`, "", tool.purpose, "", `- Available phases: ${tool.phases.join(", ") || "conditional only"}`, ...(tool.availability ? [`- Availability: ${tool.availability}`] : []), `- Writes: ${tool.writes.join("; ")}`, `- Produces: ${tool.produces.join("; ")}`, `- Lifecycle: ${tool.lifecycle}`, `- Success means: ${tool.success}`, `- Cookbook: \`${tool.cookbook}\``, `- Parameter contract: ${tool.inputSchema?.schemaSource ? tool.inputSchema.schemaSource : "embedded TypeBox JSON schema in assets/agent-contract.json"}`, "", "The live registered TypeBox schema and embedded contract are fail-closed. The cookbook supplies valid complete examples and parameter-selection rules.", "");
  }
  return lines.join("\n");
}

function renderCookbookCatalog(value) {
  const assets = {
    cad_build_step: ["parametric-cad-modeling/assets/build123d-part", "parametric-cad-modeling/assets/build123d-assembly"],
    cad_simulate: ["thermal-fluid-analysis/assets/recipes", "structural-analysis/assets/recipes"],
    cad_sim_observe: ["thermal-fluid-analysis/assets/recipes", "structural-analysis/assets/recipes"],
    cad_optimize: ["structural-analysis/assets/recipes/torch-fem-differentiable-sensitivity"],
  };
  return {
    schema: 1,
    tools: value.tools.map((tool) => ({
      tool: tool.name,
      responsibleSkill: tool.category === "control" ? "pi-cad" : "pi-cad-tools",
      generatedReference: `pi-cad-tools/references/generated/${tool.category}.md`,
      authoringCookbook: tool.cookbook,
      executableAssets: assets[tool.name] ?? [],
      qualification: tool.category === "simulation" || tool.name === "cad_optimize" ? "opt-in backend qualification plus stub smoke" : "fast behavioral/tool registration smoke",
    })),
    authoredObjects: [
      "requirements", "frame context", "implementation/investigation plan", "assembly design", "interface contracts",
      "build123d part source", "build123d assembly source", "analysis derivation", "typed/programmable Probe",
      "pi-sim.toml", "Allrun", "solver configuration", "observer", "optimization spec",
      "drawing spec", "export spec", "scene/render spec", "review decision", "transition", "clarification", "blocker", "Evidence commit",
    ],
  };
}
