import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default async function registerPrimeSubagentFaux(pi: any): Promise<void> {
  const primeRoot = process.env.PRIME_AGENT_REPO;
  const capturePath = process.env.PRIME_SUBAGENT_CAPTURE ?? join(process.cwd(), "subagent-provider-contexts.jsonl");
  if (!primeRoot) throw new Error("Prime subagent fixture requires PRIME_AGENT_REPO");
  appendFileSync(join(process.cwd(), "subagent-provider-loaded.txt"), "faux provider extension loaded\n", "utf8");
  const ai = await import(pathToFileURL(join(primeRoot, "packages/ai/dist/index.js")).href);
  const faux = ai.registerFauxProvider({ provider: "faux", models: [{ id: "faux", reasoning: false, input: ["text", "image"] }] });
  const calls = new Map<string, number>();

  const childCode = (name: "A" | "B" | "G") => {
    const folder = name === "A" ? "subagents/child-a" : name === "B" ? "subagents/child-b" : "subagents/grandchild";
    const target = name === "A" ? 25 : name === "B" ? 10 : 5;
    const initial = name === "A" ? 10 : name === "B" ? 8 : 5;
    const crossSection = name === "A" ? 20 : name === "B" ? 10 : 5;
    const thickness = name === "A" ? 5 : name === "B" ? 10 : 5;
    const initialCrossSection = name === "B" ? 8 : crossSection;
    const initialThickness = name === "B" ? 8 : thickness;
    const probe = name === "A" ? "result = {'x': shape.bounding_box().size.X}" : "result = {'volume': round(shape.volume, 6)}";
    return [
      "from pathlib import Path",
      "import agent_message, cad, json",
      "await cad.workflow.start('mechanical.naked', interaction_mode='headless')",
      `folder = Path('${folder}')`,
      "folder.mkdir(parents=True, exist_ok=True)",
      "source = folder / 'module.py'",
      `source.write_text('from build123d import Box\\nresult = Box(${initial}, ${initialCrossSection}, ${initialThickness})\\n', encoding='utf-8')`,
      "first = await cad.model.build(source, folder / 'model.step')",
      `first_probe = await cad.probe.run(subject=first, purpose='Check initial child ${name} geometry', code=${JSON.stringify(probe)})`,
      ...(name === "A" ? [
        "assert first_probe.value['x'] == 10 and first_probe.value['x'] != 25, first_probe.value",
        `source.write_text('from build123d import Box\\nresult = Box(${target}, ${crossSection}, ${thickness})\\n', encoding='utf-8')`,
        "artifact = await cad.model.build(source, folder / 'model.step', force=True)",
        `evidence = await cad.probe.run(subject=artifact, purpose='Verify repaired child ${name} geometry', code=${JSON.stringify(probe)})`,
        "assert evidence.value['x'] == 25, evidence.value",
      ] : [
        ...(name === "B" ? [
          "assert abs(first_probe.value['volume'] - 512) < 1e-6 and abs(first_probe.value['volume'] - 1000) > 1e-6, first_probe.value",
          `source.write_text('from build123d import Box\\nresult = Box(${target}, ${crossSection}, ${thickness})\\n', encoding='utf-8')`,
          "artifact = await cad.model.build(source, folder / 'model.step', force=True)",
          `evidence = await cad.probe.run(subject=artifact, purpose='Verify repaired child ${name} geometry', code=${JSON.stringify(probe)})`,
          "assert abs(evidence.value['volume'] - 1000) < 1e-6, evidence.value",
        ] : [
          "artifact = first",
          "evidence = first_probe",
          "assert abs(evidence.value['volume'] - 125) < 1e-6, evidence.value",
          "import json",
          "Path('subagents/grandchild-ref.json').write_text(json.dumps({'path': str(artifact.path), 'sha256': artifact.sha256, 'role': artifact.role, 'evidence': evidence.value}), encoding='utf-8')",
        ]),
      ]),
      ...(name === "A" ? [
        "import asyncio, rlm, time",
        "grandchild = await rlm.run('TASK_GRANDCHILD: build a 5 mm cube, probe its volume, and return the ArtifactRef and evidence.', name='cad-grandchild')",
        "deadline = time.monotonic() + 120",
        "while True:",
        "    descendants = {item.rlm_child_id: item.status for item in await rlm.list_subagents()}",
        "    if descendants.get(grandchild.rlm_child_id) in {'completed', 'error'}: break",
        "    if time.monotonic() >= deadline: raise TimeoutError(f'grandchild did not finish: {descendants}')",
        "    await asyncio.sleep(0.2)",
        "assert descendants[grandchild.rlm_child_id] == 'completed', descendants",
        "grandchild_ref = json.loads(Path('subagents/grandchild-ref.json').read_text(encoding='utf-8'))",
        "assert grandchild_ref['sha256'] and grandchild_ref['role'] == 'candidate', grandchild_ref",
      ] : []),
      "run = await cad.workflow.current()",
      "await cad.workflow.advance('finished')",
      `summary = f'${name === "G" ? "GRANDCHILD" : `CHILD_${name}`}_ARTIFACT run={run[\"runId\"]} path={artifact.path} sha256={artifact.sha256} role={artifact.role} evidence={evidence.value}'`,
      ...(name === "A" ? ["summary += f' GRANDCHILD_ARTIFACT path={grandchild_ref[\"path\"]} sha256={grandchild_ref[\"sha256\"]} role={grandchild_ref[\"role\"]} evidence={grandchild_ref[\"evidence\"]}'"] : []),
      "print(summary)",
      "await agent_message.send(summary, receiver_role='parent')",
    ].join("\n");
  };

  const parentCode = [
    "import asyncio, cad, rlm, time",
    "await cad.workflow.start('mechanical.naked', interaction_mode='headless')",
    "child_a = await rlm.run('TASK_CHILD_A: target a 25 mm part. Deliberately build it at 10 mm, measure and identify the mismatch, repair it to 25 mm, rebuild, remeasure, and return the ArtifactRef and evidence in subagents/child-a.', name='cad-child-a')",
    "child_b = await rlm.run('TASK_CHILD_B: target a 10 mm cube. Deliberately build it at 8 mm, measure and identify the wrong volume, repair it to 10 mm, rebuild, remeasure, and return the ArtifactRef and evidence in subagents/child-b.', name='cad-child-b')",
    "fault = await rlm.run('TASK_FAULT: simulate a provider failure; this child must not affect the other runs.', name='cad-fault-child')",
    "children = [child_a, child_b]",
    "deadline = time.monotonic() + 240",
    "while True:",
    "    states = {item.rlm_child_id: item.status for item in await rlm.list_subagents()}",
    "    if all(states.get(child.rlm_child_id) in {'completed', 'error'} for child in [*children, fault]): break",
    "    if time.monotonic() >= deadline: raise TimeoutError(f'RLM children did not finish: {states}')",
    "    await asyncio.sleep(0.2)",
    "assert all(states[child.rlm_child_id] == 'completed' for child in children), states",
    "assert states[fault.rlm_child_id] in {'completed', 'error'}, states",
    "print('PARENT_SPAWNED', [(child.name, child.rlm_child_id) for child in children])",
    "adopted = await cad.commit('adopted-subagent-results', artifacts=[cad.artifacts.ref('subagents/child-a/model.step', role='candidate'), cad.artifacts.ref('subagents/child-b/model.step', role='candidate'), cad.artifacts.ref('subagents/grandchild/model.step', role='candidate')])",
    "assert len(adopted.artifacts) == 3, adopted.artifacts",
    "print('PARENT_ADOPTED', adopted.id, [str(item.path) for item in adopted.artifacts])",
    "await cad.workflow.advance('finished')",
  ].join("\n");

  const responseFor = (context: any) => {
    appendFileSync(capturePath, `${JSON.stringify(context)}\n`, "utf8");
    const depth = Number(String(context.systemPrompt ?? "").match(/Recursive agent depth:\s*(\d+)/)?.[1] ?? 0);
    const latestUser = [...(context.messages ?? [])].reverse().find((message: any) => message?.role === "user");
    const taskText = JSON.stringify(latestUser?.content ?? "");
    const task = depth > 0
      ? taskText.includes("TASK_FAULT") ? "F" : taskText.includes("TASK_GRANDCHILD") ? "G" : taskText.includes("TASK_CHILD_A") ? "A" : taskText.includes("TASK_CHILD_B") ? "B" : "UNKNOWN"
      : "PARENT";
    const key = `${depth}:${task}`;
    const call = (calls.get(key) ?? 0) + 1;
    calls.set(key, call);

    if (depth > 0) {
      if (task === "F") throw new Error("intentional faux-provider failure for isolation smoke");
      if (call === 1) return ai.fauxAssistantMessage(ai.fauxToolCall("ipython", { code: childCode(task as "A" | "B" | "G") }), { stopReason: "toolUse" });
      return ai.fauxAssistantMessage(`CHILD_${task}_DONE`);
    }
    if (call === 1) return ai.fauxAssistantMessage(ai.fauxToolCall("ipython", { code: parentCode }), { stopReason: "toolUse" });
    return ai.fauxAssistantMessage("PARENT_SUBAGENT_SMOKE_OK");
  };

  faux.setResponses(Array.from({ length: 64 }, () => responseFor));
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
