import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default async function registerPrimePlanCFaux(pi: any): Promise<void> {
  const primeRoot = process.env.PRIME_AGENT_REPO;
  const loadMode = process.env.PRIME_PLAN_C_FAUX_MODE === "load" || existsSync(join(process.cwd(), ".prime-plan-c-load-mode"));
  const capturePath = process.env.PRIME_PLAN_C_CAPTURE ?? join(process.cwd(), loadMode ? "provider-contexts-cross.jsonl" : "provider-contexts.jsonl");
  if (!primeRoot) throw new Error("Prime Plan C faux fixture requires PRIME_AGENT_REPO");
  const ai = await import(pathToFileURL(join(primeRoot, "packages/ai/src/index.ts")).href);
  const faux = ai.registerFauxProvider({ provider: "faux", models: [{ id: "faux", reasoning: false, input: ["text", "image"] }] });
  const capture = (response: any) => (context: unknown) => {
    appendFileSync(capturePath, `${JSON.stringify(context)}\n`, "utf8");
    return response;
  };
  if (loadMode) {
    faux.setResponses([
      capture(ai.fauxAssistantMessage(ai.fauxToolCall("ipython", {
        code: "import cad\ntry:\n    await cad.history()\nexcept Exception as error:\n    print('CAD_CROSS_SESSION_BLOCKED', str(error))",
      }), { stopReason: "toolUse" })),
      capture(ai.fauxAssistantMessage("PRIME_PLAN_C_LOAD_OK")),
    ]);
  } else {
  faux.setResponses([
    capture(ai.fauxAssistantMessage(ai.fauxToolCall("ipython", {
      code: "import cad\nplan_c_marker = 41\nprint('CAD_IMPORT', cad.__file__)\nplan_c_workflow = await cad.workflow.start('mechanical.naked', interaction_mode='headless')\nprint('CAD_WORKFLOW', plan_c_workflow['workflowId'], plan_c_workflow['phase'])\nplan_c_commit = await cad.commit('provider-handoff', variables={'marker': plan_c_marker})\nprint('CAD_COMMIT', plan_c_commit.id)",
    }), { stopReason: "toolUse" })),
    capture(ai.fauxAssistantMessage(ai.fauxToolCall("ipython", {
      code: "plan_c_loaded = await cad.load(plan_c_commit.id)\nprint('CAD_LOAD', plan_c_loaded.variables['marker'])\nprint('CAD_PERSIST', plan_c_marker + 1)",
    }), { stopReason: "toolUse" })),
    capture(ai.fauxAssistantMessage("PRIME_PLAN_C_SMOKE_OK")),
  ]);
  }
  const apiProvider = ai.getApiProvider(faux.api);
  if (!apiProvider) throw new Error("faux provider was not registered");
  pi.registerProvider("faux", {
    api: faux.api,
    apiKey: "faux-key",
    baseUrl: faux.getModel().baseUrl,
    streamSimple: apiProvider.streamSimple,
    models: faux.models.map((model: any) => ({
      api: model.api,
      baseUrl: model.baseUrl,
      contextWindow: model.contextWindow,
      cost: model.cost,
      id: model.id,
      input: model.input,
      maxTokens: model.maxTokens,
      name: model.name,
      reasoning: model.reasoning,
    })),
  });
}
