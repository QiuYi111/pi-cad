// Real original desktop backend and real Git worktrees. Only CAD computation
// and Agent API catalog are synthetic; the native network/JSON path is real.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
export function rebuildFixture(home, repo, files, sha) {
  let mode='off';const projects=new Map();
  const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Reify E2E',GIT_AUTHOR_EMAIL:'e2e@reify.test',GIT_COMMITTER_NAME:'Reify E2E',GIT_COMMITTER_EMAIL:'e2e@reify.test'}}).trim();
  function project(id) {
    if(projects.has(id))return projects.get(id);
    const root=join(home,'source-rebuild',id.split('/').at(-1));mkdirSync(join(root,'history'),{recursive:true});
    const source=Buffer.from('# archived source fixture\nSOURCE_WIDTH = 80\n');const old=Buffer.from('ISO-10303-21;\nWIDTH=80;\nEND-ISO-10303-21;');
    writeFileSync(join(root,'.gitignore'),'.pi-cad/\n');writeFileSync(join(root,'bracket.py'),source);writeFileSync(join(root,'history/bracket-80.step'),old);
    git(root,'init','--quiet');git(root,'add','.');git(root,'commit','--quiet','-m','Preserved source fixture');const revision=git(root,'rev-parse','HEAD');
    writeFileSync(join(root,'bracket.py'),'# dirty live source\nSOURCE_WIDTH = 999\n');writeFileSync(join(root,'untouched.txt'),'keep this untracked file\n');
    const state={root,source,old,revision,status:git(root,'status','--porcelain=v1')};projects.set(id,state);return state;
  }
  function metadata(id,session) {
    const state=project(id);
    const artifact={id:'historical-80',path:'history/bracket-80.step',role:'model',sha256:sha(state.old)};
    const manifest={schema:1,modelId:'bracket',source:{path:mode==='missing-source'?'missing.py':'bracket.py',sha256:mode==='source-mismatch'?'0'.repeat(64):sha(state.source),entrypoint:'build'},output:{path:artifact.path,sha256:artifact.sha256},parameters:[{id:'width',type:'number',default:80,value:80,min:20,max:160,step:1,unit:'mm',label:'宽度'}]};
    if(mode==='stale-manifest')manifest.parameters[0].value=81;
    const stored={path:'@commit/history-80/bracket.parameters.json',sha256:sha(Buffer.from(JSON.stringify(manifest))),manifest};
    const commit={id:'history-80',name:'Width 80',parent:null,phase:'work',createdAt:'2026-10-01T00:00:00Z',artifacts:[artifact],sourceRevision:mode==='stale-version'?'0'.repeat(40):state.revision,workflowHash:'hash-'+session,acceptanceSummary:{requirements:[{id:'bbox',category:'geometry',status:'verified',method:'bounding box'}],assumptions:['Synthetic CAD fixture']}};
    return {commit,stored,state};
  }
  function execute(args,input,id,audit,send) {
    const q=JSON.parse(input),{commit,stored,state}=metadata(id,q.sessionId),root=state.root,currentMode=mode;
    writeFileSync(join(root,'history/bracket-80.step'),currentMode==='old-replaced'?'ISO-10303-21;\nWIDTH=777;':state.old);
    const catalog={projectId:id,projectHead:{updatedAt:'',artifacts:[]},currentRun:{id:'run-'+q.sessionId,phase:'work',status:'active',updatedAt:'',artifacts:[]},commits:[commit],parameterManifests:[stored],simulationRuns:[]};
    const stub=`let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{const q=JSON.parse(text);if(q.op!=='viewer-catalog'||q.sessionId!==${JSON.stringify(q.sessionId)}){console.log(JSON.stringify({schema:1,ok:false,error:{message:'Wrong rebuild conversation'}}));process.exitCode=1}else console.log(JSON.stringify({schema:1,ok:true,result:${JSON.stringify(catalog)}}))});`;
    const driver=join(root,'.pi-cad','fixture-cadctl');mkdirSync(join(root,'.pi-cad'),{recursive:true});
    const driverBody=`#!${process.execPath}\nconst fs=require('fs'),p=require('path'),crypto=require('crypto');const hash=data=>crypto.createHash('sha256').update(data).digest('hex'),mode=${JSON.stringify(currentMode)};const args=process.argv.slice(2);if(args.includes('--version')){console.log('Python synthetic CAD fixture');process.exit(0)}if(args[0]==='-m'){const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);let envelope;if(q.args[0]==='capability')envelope={ok:true,payload:{}};else{const artifact=q.args[q.args.indexOf('--artifact')+1],bytes=fs.readFileSync(artifact.replace(process.env.REIFY_FIXTURE_VIRTUAL_ROOT,${JSON.stringify(root)})),width=Number(bytes.toString().match(/WIDTH=(\\d+)/)?.[1]||80);envelope={ok:true,inputHashes:{artifact:hash(bytes)},payload:{units:'mm',bbox:{x:width,y:40,z:30},solidCount:1}}}console.log(JSON.stringify({id:q.id,exitCode:0,stdout:JSON.stringify(envelope),stderr:''}))});return;}const source=args[args.indexOf('--source')+1],output=args[args.indexOf('--output')+1],values=JSON.parse(args[args.indexOf('--parameters-json')+1]);fs.appendFileSync(${JSON.stringify(join(root,'.pi-cad','build-audit.jsonl'))},JSON.stringify({source,sourceSHA:hash(fs.readFileSync(source)),cwd:process.cwd(),values})+'\\n');if(mode==='build-failure'){console.log(JSON.stringify({ok:false,payload:{error:'Synthetic historical build failed'}}));process.exit(0)}const width=mode==='geometry-diff'?81:values.width,bytes=Buffer.from('ISO-10303-21;\\nWIDTH='+width+';\\nEND-ISO-10303-21;'+(mode==='byte-diff'?'\\nDIFFERENT ENCODING;':''));fs.mkdirSync(p.dirname(output),{recursive:true});fs.writeFileSync(output,bytes);console.log(JSON.stringify({ok:true,inputHashes:{output:hash(bytes)},payload:{}}));`;
    writeFileSync(driver,driverBody,{mode:0o755});
    let native=args[args.indexOf('-e')+1].replaceAll('/opt/reify/pi-cad',repo);
    native=native.replace('const root=fs.realpathSync(q.root)',`const root=fs.realpathSync(${JSON.stringify(root)})`);
    // The backend still executes its original Git and CAD RPC code. Stub the
    // external CAD executable and catalog CLI at the process boundary only.
    native=native.replace('backend=new ViewerBackend',`const originalSpawn=cp.spawn.bind(cp);cp.spawn=(command,args,options)=>{if(args.some(a=>a.endsWith('pi-cad-agent-api.mjs')))return originalSpawn(process.execPath,['-e',${JSON.stringify(stub)}],options);return originalSpawn(command===${JSON.stringify(repo+'/python/.venv/bin/python')}?${JSON.stringify(driver)}:command,args.map(a=>a===${JSON.stringify(repo+'/python/.venv/bin/cadctl')}?${JSON.stringify(driver)}:a),options)};backend=new ViewerBackend`);
    native=native.replace('projectPath:root','projectPath:q.root');
    native=native.replace('cp.spawn(args[0],args.slice(1),{cwd:root,env})','cp.spawn(args[0],args.slice(1).map(value=>value.replaceAll(q.root,root)),{cwd:root,env})');
    native=native.replace('if(!result.output.startsWith(root+p.sep))',"if(result.output.startsWith(q.root+p.sep))result.output=root+result.output.slice(q.root.length);if(!result.output.startsWith(root+p.sep))");
    const child=spawn(process.execPath,['-e',native],{cwd:repo,env:{...process.env,PI_CAD_CANONICAL_PROJECT_DIR:root,REIFY_FIXTURE_VIRTUAL_ROOT:q.root}}),out=[],errors=[];
    child.stdout.on('data',x=>out.push(x));child.stderr.on('data',x=>errors.push(x));child.stdin.end(input);
    child.on('close',code=>{
      const worktrees=git(root,'worktree','list','--porcelain');
      const builds=existsSync(join(root,'.pi-cad','build-audit.jsonl'))?readFileSync(join(root,'.pi-cad','build-audit.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
      audit.push({type:'source-rebuild',mode:currentMode,code,worktreeCount:worktrees.split('\n').filter(x=>x.startsWith('worktree ')).length,dirtySource:readFileSync(join(root,'bracket.py'),'utf8'),untouched:readFileSync(join(root,'untouched.txt'),'utf8'),sourceSHA:builds.at(-1)?.sourceSHA,values:builds.at(-1)?.values});
      const output=join(root,'.pi-cad','rebuilds','history-80.step');if(existsSync(output))files.set('.pi-cad/rebuilds/history-80.step',currentMode==='download-corrupt'?Buffer.from('changed output after build'):readFileSync(output));
      send({code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(errors).toString()});
    });
  }
  return {get mode(){return mode},set mode(value){mode=value},metadata,execute};
}
