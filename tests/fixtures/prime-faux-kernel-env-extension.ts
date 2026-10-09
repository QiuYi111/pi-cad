import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default async function registerPrimeKernelEnvFaux(pi: any): Promise<void> {
  const primeRoot = process.env.PRIME_AGENT_REPO;
  if (!primeRoot) throw new Error("Prime kernel smoke requires PRIME_AGENT_REPO");
  const ai = await import(pathToFileURL(join(primeRoot, "packages/ai/dist/index.js")).href);
  const faux = ai.registerFauxProvider({ provider: "faux", models: [{ id: "faux", reasoning: false, input: ["text"] }] });
  let calls = 0;
  const kernelCode = [
    "import cad, ipykernel, json, pydantic, rlm, sys",
    "await cad.workflow.start('mechanical.default', interaction_mode='headless')",
    "workflow = await cad.workflow.current()",
    "result = {'executable': sys.executable, 'prefix': sys.prefix, 'sys_path': sys.path, 'modules': {'pydantic': pydantic.__file__, 'rlm': rlm.__file__, 'ipykernel': ipykernel.__file__}, 'workflow': workflow}",
    "open('kernel-preflight-result.json', 'w', encoding='utf-8').write(json.dumps(result, default=str))",
    "print('PRIME_KERNEL_CAD_TOOL_OK', workflow)",
  ].join("\n");
  faux.setResponses(Array.from({ length: 64 }, () => () => {
    calls += 1;
    if (calls === 1) return ai.fauxAssistantMessage(ai.fauxToolCall("ipython", { code: kernelCode }), { stopReason: "toolUse" });
    return ai.fauxAssistantMessage("KERNEL_ENV_SMOKE_OK");
  }));
  const apiProvider = ai.getApiProvider(faux.api);
  if (!apiProvider) throw new Error("faux provider was not registered");
  pi.registerProvider("faux", {
    api: faux.api,
    apiKey: "faux-key",
    baseUrl: faux.getModel().baseUrl,
    streamSimple: apiProvider.streamSimple,
    models: faux.models.map((model: any) => ({ ...model })),
  });
  appendFileSync(join(process.cwd(), "kernel-provider-loaded.txt"), "loaded\n", "utf8");
}
