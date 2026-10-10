import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const {audit}=JSON.parse(readFileSync(process.argv[2],'utf8'));
const prompts=audit.filter(x=>x.type==='prompt');
const analysis=prompts.filter(x=>x.message.startsWith('Run the managed simulation/torch-fem-linear-elastic Recipe'));
assert.equal(analysis.length,2,'Invalid/stale analysis reached the agent');
assert.equal(audit.filter(x=>x.type==='simulation-abort').length,2,'Analysis Stop did not reach the cloud');
for(const request of analysis){
 assert.equal(request.imageCount,0,'Analysis sent unrelated draft attachments');
 assert.match(request.message,/CAD artifact bracket\.step at SHA-256 [a-f0-9]{64}\./);
 const checkedModel=audit.slice(0,audit.indexOf(request)).filter(x=>x.type==='file-download'&&/^\/workspace\/projects\/[^/]+\/bracket\.step$/.test(x.path)).at(-1);
 assert(checkedModel&&request.message.includes('SHA-256 '+checkedModel.sha256+'.'),'Analysis hash differs from the exact current model bytes');
}
for(const text of ['E=210000.125 MPa, nu=0.49999999999999994','mesh size=0.25 mm','[0,0,250.5] N'])assert(analysis[1].message.includes(text),'Adjusted/boundary parameter value lost '+text);
for(const text of ['E=70000 MPa, nu=0.33','mesh size=2 mm','fix all DOFs on the x-min face','[0,0,-100] N on the x-max face','managed CUDA solver','convergence, reaction balance, mesh refinement','Do not accept the result from exit code alone.'])assert(analysis[0].message.includes(text),'Analysis request lost '+text);
const qualifications=audit.filter(x=>x.type==='simulation-qualification');
for(const mode of ['normal','cpu','wrong-version','probe-error','missing','delay'])assert(qualifications.some(x=>x.mode===mode),'Missing qualification mode '+mode);
for(const q of qualifications.filter(x=>['normal','delay'].includes(x.mode))){
 assert(q.commands.some(c=>c.command==='test'&&c.args.includes('/usr/bin/bwrap')));
 assert(q.commands.some(c=>c.command==='bash'&&c.args.join(' ').includes('sha256sum')),'Managed runtime hash was bypassed');
 const probe=q.commands.find(c=>c.command==='env');assert(probe&&probe.args.includes('CUDA_VISIBLE_DEVICES=0')&&probe.args.includes('UV_NO_SYNC=1')&&probe.args.at(-1)==='cuda');
 assert(probe.args[probe.args.indexOf('-c')+1].includes('spsolve'),'Original sparse qualification probe was bypassed');
}
console.log('PASS: independent server records confirm two exact-source analysis requests, default/adjusted material/load/mesh values without rounding the nu boundary, evidence binding, both aborts, draft attachments excluded, original fresh runtime qualification/hash and missing/GPU/version/failure/scoped-reply refusal (runtime and solver outputs synthetic)');
assert.equal(prompts.filter(x=>x.message==='已编辑第一条').length,1);
assert.equal(prompts.filter(x=>x.message==='排队第二条').length,1);
assert.equal(prompts.filter(x=>x.message==='只保存在对话的笔记').length,0);
assert.equal(prompts.filter(x=>x.message==='断线暂停的需求').length,0);
const image=prompts.find(x=>x.message.startsWith('图片需求验收'));
assert.equal(image.imageCount,1);
assert.deepEqual(image.imageTypes,['image/png']);
const requests=audit.filter(x=>x.type==='engineering').map(x=>x.request);
assert(requests.every(x=>Object.hasOwn(x,'sessionId')));
assert(requests.some(x=>x.sessionId===null));
const answers=audit.filter(x=>x.type==='ui-answer');
assert.deepEqual(answers.map(x=>x.method),['confirm','editor','input','select']);
assert.equal(answers[0].value,true);
assert(audit.some(x=>x.type==='spawn'&&x.args.includes('--reviewer-provider')&&x.args.includes('PI_CAD_DESKTOP_PERMISSION=read-only')));
console.log('PASS: server received queue prompts exactly once, no local note, image payload, explicit conversation scope, dialog answers and independent read-only reviewer');

const conceptPrompts=prompts.filter(x=>x.message.startsWith('Continue the design from concept V'));
assert.equal(conceptPrompts.length,2, 'outdated or invalid region produced a prompt');
assert(conceptPrompts.every(x=>x.imageCount===1 && x.imageTypes[0]==='image/png' && x.message.includes('imageSHA256='+x.imageHashes[0])));
assert(conceptPrompts.some(x=>x.message.includes('x=0.100, y=0.200, width=0.300, height=0.400') && x.message.includes('只修改右上角')));
assert(conceptPrompts.some(x=>x.message.includes('Use the full image.')));
console.log('PASS: server receives original image bytes matching the concept hash, exact normalized region and note; invalid/outdated concepts are never sent');

const reviewSubmissions=audit.filter(x=>x.type==='review-submission');
assert.equal(reviewSubmissions.length,1, 'changed candidate was submitted or review duplicated');
assert(reviewSubmissions[0].message.includes('with SHA-256 '+reviewSubmissions[0].candidateSHA));
assert(reviewSubmissions[0].message.includes('pinned workflow') && reviewSubmissions[0].message.includes('do not treat machine review as human approval'));
console.log('PASS: server receives one exact-candidate review request with pinned workflow and separate human approval');

const releaseChecks=audit.filter(x=>x.type==='release-approval-check');
assert(releaseChecks.some(x=>x.number===3), 'original release backend did not revalidate after preparing the package');
assert(releaseChecks.filter(x=>x.number===2).length>=4, 'reuse/cancel/revoke paths skipped the live native approval callback');
console.log('PASS: original release backend asks the native approval store before/after package preparation and when reusing, cancelling or revoking a package');

const rebuilds=audit.filter(x=>x.type==='source-rebuild');
assert(rebuilds.some(x=>x.mode==='match'&&x.code===0));
assert(rebuilds.some(x=>x.mode==='old-replaced'&&x.code===0));
assert(rebuilds.some(x=>x.mode==='build-failure'&&x.code!==0));
assert(rebuilds.every(x=>x.worktreeCount===1 && x.dirtySource.includes('SOURCE_WIDTH = 999') && x.untouched==='keep this untracked file\n'));
assert(rebuilds.filter(x=>x.code===0).every(x=>x.values.width===80));
assert(rebuilds.filter(x=>x.code===0).every(x=>x.sourceSHA===rebuilds.find(y=>y.mode==='match').sourceSHA));
console.log('PASS: original backend removes all detached worktrees after success/failure, uses the same archived source/parameters and preserves the dirty live source and unrelated file');

const publications=audit.filter(x=>x.type==='tag-publish');
assert.equal(publications.filter(x=>x.tag==='reify/e2e'&&x.code===0).length,2);
assert(publications.every(x=>x.remote==='origin'&&x.statusBefore===x.statusAfter&&x.statusAfter===x.baseline&&x.head===x.revision));
assert(publications.every(x=>x.dirty.includes('unsaved source stays unchanged')&&x.untracked==='keep this untracked publication note\n'));
assert(publications.every(x=>x.remoteRefs.includes(x.conflictRevision+' refs/tags/reify/remote-conflict')));
assert(publications.some(x=>x.mode==='push-failure'&&x.code!==0&&!x.remoteRefs.includes('refs/tags/reify/push-failed')));
assert(publications.some(x=>x.mode==='normal'&&x.tag==='reify/push-failed'&&x.code===0&&x.remoteRefs.includes(x.revision+' refs/tags/reify/push-failed')));
assert(publications.some(x=>x.mode==='manifest-changed'&&x.code!==0&&!x.remoteRefs.includes('refs/tags/reify/changed-manifest')));
assert(!publications.some(x=>['reify/disabled','reify/wrong-server','reify/wrong-remote','reify/corrupt-local','reify/read-only','reify/unbound','reify/revoked'].includes(x.tag)));
console.log('PASS: real Git remote receives only permitted version-bound tags; conflicts are untouched; failed push is retryable; source/HEAD/index/untracked file and local package survive all publication outcomes');

const traces=audit.filter(x=>x.type==='trace');
const ratings=traces.filter(x=>x.op==='rate');
assert.equal(ratings.length,2,'invalid/read-only/missing-current rating reached the original writer');
assert.equal(ratings[0].paths.length,2);assert.equal(ratings[1].paths.length,1);
assert(ratings.every(x=>x.code===0&&x.paths.every(p=>p.startsWith('/workspace/projects/')&&p.includes('/.prime-sessions/'))));
assert(ratings[0].ratings.every(x=>x.quality===2&&x.difficulty===5&&x.feedback==='评分原文保留'));
assert(ratings[1].ratings.some(x=>x.feedback==='只评分当前对话'&&x.quality===4&&x.difficulty===3));
assert.equal(traces.filter(x=>x.op==='read'&&x.code!==0).length,2,'symlink/cross-project readers did not refuse');
assert(traces.some(x=>x.op==='distill'&&x.mode==='normal'&&x.code===0));
assert.equal(traces.filter(x=>x.op==='validate'&&x.mode==='normal'&&x.code===0).length,2);
assert(traces.some(x=>x.op==='validate'&&x.mode==='replay-failure'&&x.code!==0));
const prime=traces.flatMap(x=>x.prime);
assert(prime.length>0&&prime.every(x=>x.provider==='zai'&&x.model==='glm-5.3-flash'&&x.thinking==='high'),'experience jobs lost the selected GLM settings');
assert(traces.every(x=>['list','read','rate','distill','validate'].includes(x.op)),'cloud adopted candidate rules');
console.log('PASS: independent server record confirms exact multi/current ratings, refused readers, original distillation and replay failure/retry, selected zai/GLM/high environment and no cloud adoption (Prime replies remain synthetic)');

const fusion=audit.filter(x=>x.type==='fusion-agent');
const exports=fusion.filter(x=>x.request.op==='transfer-export');
assert(exports.length>=8&&exports.every(x=>x.request.check===true&&x.request.target==='fusion'&&typeof x.request.sessionId==='string'));
assert(fusion.some(x=>x.request.op==='part-apply'&&x.request.ops.length===6&&x.request.ops.filter(y=>y.op==='hole').length===1&&x.request.ops.filter(y=>y.op==='pocket').length===1));
assert(exports.some(x=>x.response?.result?.file==='exports/arm.f3d'&&x.response.result.check==='passed'&&x.response.result.notes.length>0));
assert(exports.some(x=>x.mode==='shape-fail'&&x.response?.error?.code==='TRANSFER_CHECK_FAILED'&&x.response.error.detail.report.passed===false&&x.response.error.detail.report.volume.ok===false));
assert(exports.some(x=>x.response?.error?.code==='TRANSFER_UNSUPPORTED_OP'&&x.response.error.target==='plate/holes'&&x.response.error.detail.log));
assert(exports.some(x=>x.response?.error?.code==='TRANSFER_EXECUTOR_FAILED'&&x.response.error.message.includes('cancelled')));
assert(exports.some(x=>x.response?.error?.code==='TRANSFER_TIMEOUT'));
assert(audit.some(x=>x.type==='fusion-io'&&x.op==='write'&&x.path.startsWith('.pi-cad/transfer/cancel/')));
assert(audit.some(x=>x.type==='fusion-io'&&x.op==='metadata'&&x.path==='parts/bracket.FCStd'));
console.log('PASS: original cloud transfer-export receives explicit conversation/check scope, full reference operations, assembly joint notice, true equivalence failure report, feature/log errors, cancellation and timeout; native dispatcher uses real project spool files (CAD/executor geometry remains synthetic)');

assert(audit.some(x=>x.type==='fusion-display-check'&&x.mode==='displayed-mismatch'&&x.report.passed===false));
assert(audit.some(x=>x.type==='fusion-display-check'&&x.mode==='normal'&&x.report.passed===true));
console.log('PASS: the original equivalence checker additionally rejects a same-name FreeCAD document whose shape differs from the displayed STEP');
