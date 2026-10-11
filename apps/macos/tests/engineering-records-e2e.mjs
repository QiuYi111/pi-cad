// Exercise the real Agent API CLI, conversation registry, Git commit and immutable
// transaction store in a disposable project. The review result is synthetic;
// this is not a cloud/GLM review or a manufacturing approval.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const taskRoot = mkdtempSync(join(tmpdir(), 'reify-records-e2e-'));
const project = join(taskRoot, 'project'), storage = join(taskRoot, 'state');
mkdirSync(project);
const previousRoot = process.env.PI_CAD_CANONICAL_PROJECT_DIR;
process.env.PI_CAD_CANONICAL_PROJECT_DIR = storage;
const env = { ...process.env, PI_CAD_CANONICAL_PROJECT_DIR: storage, XDG_DATA_HOME: join(taskRoot, 'data'),
  GIT_AUTHOR_NAME: 'Reify E2E', GIT_AUTHOR_EMAIL: 'e2e@reify.test', GIT_COMMITTER_NAME: 'Reify E2E', GIT_COMMITTER_EMAIL: 'e2e@reify.test' };
const jiti = createRequire(import.meta.url)(join(repo, 'node_modules/jiti')).createJiti(join(repo, 'package.json'));
const { HarnessRunStoreV7 } = await jiti.import(join(repo, 'src/harness/run-store.ts'));
const { mechanicalRegistries } = await jiti.import(join(repo, 'src/domains/mechanical/registries.ts'));
const { bootstrapAgentApiContracts } = await jiti.import(join(repo, 'src/agent-api/bootstrap.ts'));
const { canonicalDigest } = await jiti.import(join(repo, 'src/harness/canonical.ts'));
bootstrapAgentApiContracts();
const sessionId = randomUUID();
function api(op, fields = {}, expectedOK = true) {
  const result = spawnSync(process.execPath, [join(repo, 'scripts/pi-cad-agent-api.mjs'), 'agent-api', project],
    { env, input: JSON.stringify({ schema: 1, op, sessionId, ...fields }), encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { throw Error(result.stderr || result.stdout); }
  assert.equal(envelope.ok, expectedOK, JSON.stringify(envelope));
  assert.equal(result.status, expectedOK ? 0 : 1);
  return expectedOK ? envelope.result : envelope.error;
}
try {
  writeFileSync(join(project, 'model.step'), 'ISO-10303-21;\nfixture only\nEND-ISO-10303-21;\n');
  writeFileSync(join(project, 'model.py'), '# disposable source fixture\n');
  const run = api('workflow-start', { id: 'mechanical.naked', interactionMode: 'headless' });
  assert.ok(run.runId && run.workflowHash);
  const store = new HarnessRunStoreV7(project, run.runId);
  const reviewPath = 'reviews/e2e-review.json';
  const review = { schema: 1, reviewId: 'e2e-review', profileId: 'independent-e2e', workflowHash: run.workflowHash,
    result: { verdict: 'pass', summary: 'Synthetic review result for CLI evidence regression' } };
  const envelope = { schema: 1, ok: true, payload: { bbox: { x: 20, y: 10, z: 5 }, volume: 1000 }, artifacts: [] };
  const geometryPath = 'evidence/geometry/e2e.json';
  const geometry = { schema: 1, evidence: { path: geometryPath, sha256: canonicalDigest(envelope), workflowHash: run.workflowHash }, envelope };
  await store.mutate(mechanicalRegistries, ({ state }) => ({
    state: { ...state, latestReview: { id: 'e2e-review', verdict: 'pass', path: reviewPath, profileId: 'independent-e2e',
      subjectHash: canonicalDigest({ fixture: true }), workflowHash: run.workflowHash, registryContractHash: state.workflow.registryContractHash } },
    payloads: { [reviewPath]: review, [geometryPath]: geometry }, event: { type: 'E2ESyntheticReviewStored' }
  }));
  const commit = api('commit', { name: 'e2e-reviewed', artifacts: ['model.step'] });
  assert.match(commit.sourceRevision, /^[a-f0-9]{40,64}$/);
  const machine = commit.acceptanceSummary.requirements.find(x => x.category === 'machine');
  assert.equal(machine.status, 'verified');
  assert.deepEqual(machine.evidence, { path: reviewPath, sha256: canonicalDigest(review) });
  assert.deepEqual(api('evidence-read', { path: reviewPath }), review);
  assert.deepEqual(api('evidence-read', { path: geometryPath }), geometry);
  const raw = await store.transactions.readPayload(geometryPath);
  assert.notEqual(createHash('sha256').update(raw).digest('hex'), geometry.evidence.sha256);
  assert.equal(api('viewer-catalog').commits[0].acceptanceSummary.requirements.find(x => x.category === 'machine').evidence.sha256, canonicalDigest(review));
  for (const fields of [{ sessionId: null }, { sessionId: randomUUID() }]) {
    const error = api('evidence-read', { path: reviewPath, ...fields }, false);
    assert.match(error.message, /no active Pi-CAD v7 run/);
  }
  api('evidence-read', { path: 'reviews/../state.json' }, false);
  await store.mutate(mechanicalRegistries, ({ state }) => ({ state: { ...state, latestReview: { ...state.latestReview, path: 'reviews/missing.json' } }, event: { type: 'E2EMissingReview' } }));
  const missing = api('commit', { name: 'e2e-missing-review', artifacts: ['model.step'] });
  const missingMachine = missing.acceptanceSummary.requirements.find(x => x.category === 'machine');
  assert.equal(missingMachine.status, 'unverified');
  assert.equal(missingMachine.evidence, undefined);
  const head = await store.transactions.readHead();
  writeFileSync(join(store.runDirectory, 'transactions', head.txId, reviewPath), '{"changed":true}\n');
  api('evidence-read', { path: reviewPath }, false);
  console.log('PASS: real Agent API CLI stores a review digest in Git-backed commits, reads review/geometry evidence, distinguishes geometry envelope/file hashes, rejects unbound conversation/path escape/corrupt stored bytes and does not verify a missing review');
} finally {
  if (previousRoot === undefined) delete process.env.PI_CAD_CANONICAL_PROJECT_DIR;
  else process.env.PI_CAD_CANONICAL_PROJECT_DIR = previousRoot;
  rmSync(taskRoot, { recursive: true, force: true });
}
