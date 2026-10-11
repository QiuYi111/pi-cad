// Real Git repositories and the unchanged desktop publisher. Only the workflow
// catalog/process paths are adapted at the disposable cloud service boundary.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export function publishFixture(home, repo, files) {
  const projects = new Map();
  let mode = 'normal';
  function git(root, args, input) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', input });
    if (result.status !== 0) throw Error(result.stderr || 'Fixture Git command failed');
    return result.stdout.trim();
  }
  function prepare(project) {
    if (projects.has(project)) return projects.get(project);
    const root = join(home, 'release-projects', project.split('/').at(-1));
    const remote = join(home, 'publish-remotes', project.split('/').at(-1) + '.git');
    mkdirSync(root, { recursive: true });
    mkdirSync(remote, { recursive: true });
    for (const [path, bytes] of files) {
      if (path.startsWith('.pi-cad/')) continue;
      const target = join(root, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, bytes);
    }
    writeFileSync(join(root, '.gitignore'), '.pi-cad/\n');
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Reify E2E']);
    git(root, ['config', 'user.email', 'e2e@reify.test']);
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'Test-only saved candidate']);
    const revision = git(root, ['rev-parse', 'HEAD']);
    git(remote, ['init', '--bare', '-q']); git(root, ['remote', 'add', 'origin', remote]);
    const other = git(root, ['commit-tree', revision + '^{tree}', '-p', revision], 'Test-only conflicting version\n');
    git(root, ['tag', 'reify/remote-conflict', other]);
    git(root, ['push', '-q', 'origin', 'refs/tags/reify/remote-conflict']);
    git(root, ['tag', 'reify/local-conflict', other]);
    const dirty = Buffer.concat([files.get('bracket.py'), Buffer.from('\n# unsaved source stays unchanged during tag publication\n')]);
    files.set('bracket.py', dirty); writeFileSync(join(root, 'bracket.py'), dirty);
    const note = Buffer.from('keep this untracked publication note\n');
    files.set('publish-untracked.txt', note); writeFileSync(join(root, 'publish-untracked.txt'), note);
    const info = { root, remote, revision, other, baseline: git(root, ['status', '--porcelain=v1']) };
    projects.set(project, info); return info;
  }
  function execute(args, input, project, catalog, audit, send) {
    const q = JSON.parse(input), info = projects.get(project);
    if (!info) { send({ code: 1, stdout: '', stderr: 'No test publication repository' }); return; }
    const { root, remote } = info;
    const hook = join(remote, 'hooks', 'pre-receive');
    if (mode === 'push-failure') { writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o700); }
    else rmSync(hook, { force: true });
    const manifest = root + q.release.manifestPath.slice(q.root.length);
    let original;
    if (mode === 'manifest-changed') { original = readFileSync(manifest); writeFileSync(manifest, JSON.stringify({ ...JSON.parse(original), changed: true })); }
    const statusBefore = git(root, ['status', '--porcelain=v1']);
    // Packaging happens before tag publication and may save parameter records.
    // Freeze the completed-package state before the first publisher invocation.
    info.publishBaseline ??= statusBefore;
    const native = args[args.indexOf('-e') + 1]
      .replaceAll('/opt/reify/pi-cad', repo)
      .replace('const root=fs.realpathSync(q.root)', `const root=fs.realpathSync(${JSON.stringify(root)})`);
    const stub = `let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{const request=JSON.parse(text);if(request.op!=='viewer-catalog'||request.sessionId!==${JSON.stringify(catalog.commits[0].id.slice('commit-'.length))}){console.log(JSON.stringify({schema:1,ok:false,error:{message:'Wrong publish conversation'}}));process.exitCode=1}else console.log(JSON.stringify({schema:1,ok:true,result:${JSON.stringify(catalog)}}))});`;
    const setup = `const __cp=require('child_process'),__spawn=__cp.spawn.bind(__cp);__cp.spawn=(command,args,options)=>args.some(x=>x.endsWith('pi-cad-agent-api.mjs'))?__spawn(process.execPath,['-e',${JSON.stringify(stub)}],options):__spawn(command,args,options);`;
    const child = spawn(process.execPath, ['-e', setup + native], { cwd: repo });
    const out = [], err = [];
    child.stdout.on('data', x => out.push(x)); child.stderr.on('data', x => err.push(x));
    child.on('close', code => {
      if (original) writeFileSync(manifest, original);
      const statusAfter = git(root, ['status', '--porcelain=v1']);
      audit.push({ type: 'tag-publish', mode, tag: q.tag, remote: q.remote, code, revision: info.revision,
        statusBefore, statusAfter, baseline: info.publishBaseline, head: git(root, ['rev-parse', 'HEAD']),
        remoteRefs: git(remote, ['show-ref', '--tags']), dirty: readFileSync(join(root, 'bracket.py'), 'utf8'),
        untracked: readFileSync(join(root, 'publish-untracked.txt'), 'utf8'), conflictRevision: info.other });
      send({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    });
    child.stdin.end(input);
  }
  return { prepare, execute, revision: project => projects.get(project)?.revision,
    get mode() { return mode; }, set mode(value) { mode = value; } };
}
