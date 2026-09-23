import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export default async function registerPrimeSubagentFaux(pi: any): Promise<void> {
  const primeRoot = process.env.PRIME_AGENT_REPO;
  const capturePath = process.env.PRIME_SUBAGENT_CAPTURE ?? join(process.cwd(), "subagent-provider-contexts.jsonl");
  if (!primeRoot) throw new Error("Prime subagent fixture requires PRIME_AGENT_REPO");
  const ai = await import(pathToFileURL(join(primeRoot, "packages/ai/src/index.ts")).href);
  const faux = ai.registerFauxProvider({ provider: "faux", models: [{ id: "faux", reasoning: false, input: ["text", "image"] }] });
  const calls = new Map<string, number>();

  const childCode = (name: "A" | "B" | "G") => {
    const folder = name === "A" ? "subagents/child-a" : name === "B" ? "subagents/child-b" : "subagents/grandchild";
    const target = name === "A" ? 25 : name === "B" ? 8 : 5;
    const initial = name === "A" ? 10 : name === "B" ? 6 : 5;
    const crossSection = name === "A" ? 20 : name === "B" ? 8 : 5;
    const thickness = name === "A" ? 5 : name === "B" ? 8 : 5;
    const probe = name === "A" ? "result = {'x': shape.bounding_box().size.X}" : "result = {'volume': round(shape.volume, 6)}";
    return [
      "from pathlib import Path",
      "import agent_message, cad, json",
      "await cad.workflow.start('mechanical.naked', interaction_mode='headless')",
      `folder = Path('${folder}')`,
      "folder.mkdir(parents=True, exist_ok=True)",
      "source = folder / 'module.py'",
      `source.write_text('from build123d import Box\\nresult = Box(${initial}, ${crossSection}, ${thickness})\\n', encoding='utf-8')`,
      "first = await cad.model.build(source, folder / 'model.step')",
      `first_probe = await cad.probe.run(subject=first, purpose='Check initial child ${name} geometry', code=${JSON.stringify(probe)})`,
      ...(name === "A" ? [
        "assert first_probe.value['x'] == 10, first_probe.value",
        `source.write_text('from build123d import Box\\nresult = Box(${target}, ${crossSection}, ${thickness})\\n', encoding='utf-8')`,
        "artifact = await cad.model.build(source, folder / 'model.step', force=True)",
        `evidence = await cad.probe.run(subject=artifact, purpose='Verify repaired child ${name} geometry', code=${JSON.stringify(probe)})`,
        "assert evidence.value['x'] == 25, evidence.value",
      ] : [
        ...(name === "B" ? [
          "assert abs(first_probe.value['volume'] - 384) < 1e-6, first_probe.value",
          `source.write_text('from build123d import Box\\nresult = Box(${target}, ${crossSection}, ${thickness})\\n', encoding='utf-8')`,
          "artifact = await cad.model.build(source, folder / 'model.step', force=True)",
          `evidence = await cad.probe.run(subject=artifact, purpose='Verify repaired child ${name} geometry', code=${JSON.stringify(probe)})`,
          "assert abs(evidence.value['volume'] - 512) < 1e-6, evidence.value",
        ] : [
          "artifact = first",
          "evidence = first_probe",
          "assert abs(evidence.value['volume'] - 125) < 1e-6, evidence.value",
          "import json",
          "Path('subagents/grandchild-ref.json').write_text(json.dumps({'path': str(artifact.path), 'sha256': artifact.sha256, 'role': artifact.role, 'evidence': evidence.value}), encoding='utf-8')",
        ]),
      ]),
      ...(name === "A" ? [
        "identity_v1 = await cad.model.build('nested_assembly.py', folder / 'assembly-v1.step')",
        `identity_v1_probe = await cad.probe.run(subject=identity_v1, purpose='Resolve named repeated assembly instances', code=${JSON.stringify("pin_a = cad_resolve('arm/pin_a', kind='instance')\npin_b = cad_resolve('arm/pin_b', kind='instance')\nleft = cad_resolve('arm/bracket_left', kind='instance', expect='many')\nright = cad_resolve('arm/bracket_right', kind='instance', expect='many')\nresult = {'pin_a': pin_a.identity, 'pin_b': pin_b.identity, 'pin_a_volume': pin_a.object.volume, 'left_count': len(left.objects), 'left_min_x': min(obj.bounding_box().min.X for obj in left.objects), 'right_min_x': min(obj.bounding_box().min.X for obj in right.objects)}")})`,
        "old_pin_ref = identity_v1_probe.value['pin_a']['artifactRefs'][0]",
        "assembly_source = Path('nested_assembly.py')",
        "assembly_v2_source = folder / 'nested_assembly_reordered.py'",
        "assembly_v2_source.write_text(assembly_source.read_text(encoding='utf-8').replace('result = build()', \"result = build({'pin_d': 6.0, 'spacer': True, 'reverse_order': True})\"), encoding='utf-8')",
        "identity_v2 = await cad.model.build(assembly_v2_source, folder / 'assembly-v2.step')",
        `identity_v2_probe = await cad.probe.run(subject=identity_v2, purpose='Resolve stable names after parameter and order changes', code=${JSON.stringify("pin_a = cad_resolve('arm/pin_a', kind='instance')\npin_b = cad_resolve('arm/pin_b', kind='instance')\nleft = cad_resolve('arm/bracket_left', kind='instance', expect='many')\nright = cad_resolve('arm/bracket_right', kind='instance', expect='many')\nold_ref_error = None\ntry:\n    cad_resolve(params['old_ref'])\nexcept Exception as error:\n    old_ref_error = getattr(error, 'code', type(error).__name__)\nresult = {'pin_a': pin_a.identity, 'pin_b': pin_b.identity, 'pin_a_volume': pin_a.object.volume, 'left_count': len(left.objects), 'left_min_x': min(obj.bounding_box().min.X for obj in left.objects), 'right_min_x': min(obj.bounding_box().min.X for obj in right.objects), 'old_ref_error': old_ref_error}")}, args={'old_ref': old_pin_ref})`,
        "assert identity_v1_probe.value['pin_a']['path'] == identity_v2_probe.value['pin_a']['path'], identity_v2_probe.value",
        "assert identity_v1_probe.value['pin_b']['path'] == identity_v2_probe.value['pin_b']['path'], identity_v2_probe.value",
        "assert identity_v1_probe.value['left_count'] == identity_v2_probe.value['left_count'] == 2, identity_v2_probe.value",
        "assert identity_v1_probe.value['left_min_x'] == identity_v2_probe.value['left_min_x'] == 0, identity_v2_probe.value",
        "assert identity_v1_probe.value['right_min_x'] == identity_v2_probe.value['right_min_x'] == 40, identity_v2_probe.value",
        "assert abs(identity_v1_probe.value['pin_a_volume'] - 125.663706) < 0.01 and abs(identity_v2_probe.value['pin_a_volume'] - 282.743339) < 0.01, identity_v2_probe.value",
        "assert identity_v2_probe.value['old_ref_error'] == 'unknown-ref', identity_v2_probe.value",
        "old_manifest = Path(str(identity_v1.path) + '.identity.json').read_bytes()",
        "v2_manifest_path = Path(str(identity_v2.path) + '.identity.json')",
        "current_manifest = v2_manifest_path.read_bytes()",
        "v2_manifest_path.write_bytes(old_manifest)",
        "stale_manifest_error = None",
        "try:",
        `    await cad.probe.run(subject=identity_v2, purpose='Reject a stale identity manifest', code=${JSON.stringify("result = {'ok': True}")})`,
        "except Exception as error:",
        "    stale_manifest_error = str(error)",
        "finally:",
        "    v2_manifest_path.write_bytes(current_manifest)",
        "assert stale_manifest_error and 'identity manifest' in stale_manifest_error and 'belongs to artifact' in stale_manifest_error, stale_manifest_error",
        "feature_failure_source = folder / 'feature-failure.py'",
        "feature_failure_source.write_text(\"from build123d import Box\\npart = Box(10, 10, 5)\\nidentity = Assembly('broken')\\nidentity.instance('broken/base', shape=part)\\nidentity.feature('broken/missing', owner='broken/base', kind='bearing_seat', selector={'entity': 'face', 'type': 'cylinder', 'radius': 0.5}, expect=1)\\nresult = part\\n\", encoding='utf-8')",
        "feature_failure = None",
        "try:",
        "    await cad.model.build(feature_failure_source, folder / 'feature-failure.step', force=True)",
        "except Exception as error:",
        "    feature_failure = str(error)",
        "assert feature_failure, feature_failure",
        "clearance = await cad.model.import_step('interference_clearance.step', folder / 'clearance.step')",
        `motion = await cad.probe.run(subject=clearance, purpose='Find a collision between clear motion endpoints', code=${JSON.stringify("import json, time\nfixed, moving = shape.solids()[:2]\nposes = []\nfor index in range(21):\n    parameter = index / 20\n    posed = moving.moved(bd.Location((-90 * parameter, 0, 0)))\n    common = posed & fixed\n    penetration = 0.0 if common is None else common.volume\n    poses.append({'parameter': parameter, 'penetration': penetration})\nfailures = [pose for pose in poses if pose['penetration'] > 1e-6]\nbatch_poses = [{'id': str(index), 'transforms': [{'solidIndex': 1, 'translationMm': [index, 0, 0]}]} for index in range(10)]\nstarted = time.monotonic()\nrepeated_imports = [bd.import_step(artifact_path) for _ in batch_poses]\nrepeated_import_seconds = time.monotonic() - started\nstarted = time.monotonic()\nbatch = cad_interference_batch(shape, batch_poses, [(0, 1)])\nbatch_seconds = time.monotonic() - started\ncomparison = {'poseCount': len(batch_poses), 'repeatedImportCount': len(repeated_imports), 'repeatedImportSeconds': repeated_import_seconds, 'batchedSubjectImportCount': 1, 'batchSeconds': batch_seconds, 'batchJsonBytes': len(json.dumps(batch, ensure_ascii=False).encode('utf-8'))}\nresult = {'sampleCount': len(poses), 'endpointsClear': poses[0]['penetration'] == 0 and poses[-1]['penetration'] == 0, 'firstFailure': None if not failures else failures[0]['parameter'], 'maximumPenetration': max(pose['penetration'] for pose in poses), 'passed': not failures, 'coverage': '21 discrete poses; interval between samples unverified', 'comparison': comparison, 'batch': batch}")})`,
        "assert motion.value['sampleCount'] == 21 and motion.value['endpointsClear'] and not motion.value['passed'] and motion.value['firstFailure'] is not None and motion.value['maximumPenetration'] > 0, motion.value",
        "timeout_error = None",
        "try:",
        `    await cad.probe.run(subject=clearance, purpose='Confirm a probe timeout is an explicit failure', code=${JSON.stringify("while True:\n    pass")})`,
        "except Exception as error:",
        "    timeout_error = str(error)",
        "assert timeout_error and ('probe exceeded 25s' in timeout_error or 'CPU wall limit' in timeout_error), timeout_error",
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
      ...(name === "A" ? ["integration_commit = await cad.commit('named-assembly-evidence', artifacts=[identity_v2])"] : []),
      "run = await cad.workflow.current()",
      "await cad.workflow.advance('finished')",
      ...(name === "A" ? [
        "done_view = await cad.workflow.current()",
        "assert done_view and done_view['status'] == 'done' and done_view['runId'] == run['runId'], done_view",
        `done_probe = await cad.probe.run(subject=identity_v2, purpose='Read a committed model after the workflow is done', code=${JSON.stringify("pin = cad_resolve('arm/pin_a', kind='instance')\nresult = {'path': pin.identity['path'], 'ref': pin.identity['artifactRefs'][0], 'solid_count': len(shape.solids())}")})`,
        "assert done_probe.value['path'] == 'arm/pin_a' and done_probe.value['solid_count'] > 0, done_probe.value",
        "(folder / 'integration-evidence.json').write_text(json.dumps({'artifacts': [{'path': str(identity_v1.path), 'sha256': identity_v1.sha256, 'probeHash': identity_v1_probe.artifact_hash, 'observationId': identity_v1_probe.observation_id}, {'path': str(identity_v2.path), 'sha256': identity_v2.sha256, 'probeHash': identity_v2_probe.artifact_hash, 'observationId': identity_v2_probe.observation_id}, {'path': str(clearance.path), 'sha256': clearance.sha256}], 'commit': {'id': integration_commit.id, 'name': integration_commit.name, 'runId': run['runId'], 'artifacts': [{'path': str(item.path), 'sha256': item.sha256} for item in integration_commit.artifacts]}, 'identityV1': identity_v1_probe.value, 'identityV2': identity_v2_probe.value, 'staleManifestError': stale_manifest_error, 'featureFailure': feature_failure, 'timeoutError': timeout_error, 'motion': motion.value, 'done': {'status': done_view['status'], 'probe': done_probe.value, 'artifactHash': done_probe.artifact_hash, 'observationId': done_probe.observation_id}}, sort_keys=True), encoding='utf-8')",
      ] : []),
      `summary = f'${name === "G" ? "GRANDCHILD" : `CHILD_${name}`}_ARTIFACT run={run[\"runId\"]} path={artifact.path} sha256={artifact.sha256} role={artifact.role} selfValidated initial={first_probe.value} final={evidence.value}'`,
      ...(name === "A" ? ["summary += f' GRANDCHILD_ARTIFACT path={grandchild_ref[\"path\"]} sha256={grandchild_ref[\"sha256\"]} role={grandchild_ref[\"role\"]} evidence={grandchild_ref[\"evidence\"]}'"] : []),
      "print(summary)",
      "await agent_message.send(summary, receiver_role='parent')",
    ].join("\n");
  };

  const parentCode = [
    "import asyncio, cad, rlm, time",
    "await cad.workflow.start('mechanical.naked', interaction_mode='headless')",
    "child_a = await rlm.run('TASK_CHILD_A: build a 10 mm part, probe it, repair it to 25 mm, rebuild and return the ArtifactRef and evidence in subagents/child-a.', name='cad-child-a')",
    "child_b = await rlm.run('TASK_CHILD_B: build a cube for an 8 mm target, probe the intentionally wrong initial size, repair it, then return the ArtifactRef and evidence in subagents/child-b.', name='cad-child-b')",
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
    const serialized = JSON.stringify(context);
    const depth = Number(String(context.systemPrompt ?? "").match(/Recursive agent depth:\s*(\d+)/)?.[1] ?? 0);
    const task = depth > 0
      ? serialized.includes("TASK_FAULT") ? "F" : serialized.includes("TASK_GRANDCHILD") ? "G" : serialized.includes("TASK_CHILD_A") ? "A" : serialized.includes("TASK_CHILD_B") ? "B" : "UNKNOWN"
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
