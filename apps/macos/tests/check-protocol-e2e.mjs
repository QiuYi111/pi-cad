import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const {audit}=JSON.parse(readFileSync(process.argv[2],'utf8'));
const prompts=audit.filter(x=>x.type==='prompt');
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
