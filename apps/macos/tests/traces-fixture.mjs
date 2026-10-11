// Original TraceStore, transcript archive/rating, distillation worker and replay
// scripts run against disposable files. Only Prime replies and the analyzer are
// replaced at their executable boundaries; no production rules are changed.
import {mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
export function tracesFixture(home, repo) {
  const traceHome=join(home,'trace-home'),bin=join(home,'trace-bin'),prime=join(home,'trace-prime');
  mkdirSync(bin,{recursive:true});mkdirSync(prime,{recursive:true});mkdirSync(traceHome,{recursive:true});
  const auditFile=join(home,'trace-prime-audit.jsonl');
  const primeScript=join(prime,'prime-agent.sh');
  writeFileSync(primeScript,`#!${process.execPath}\nconst fs=require('fs'),p=require('path'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(auditFile)},JSON.stringify({provider:process.env.PI_CAD_DISTILL_PROVIDER,model:process.env.PI_CAD_DISTILL_MODEL,thinking:process.env.PI_CAD_DISTILL_THINKING,args:args.slice(0,12)})+'\\n');if(args.includes('--dist')){const prompt=args.at(-1),requestPath=prompt.match(/immutable request manifest is: (.+)/)[1],request=JSON.parse(fs.readFileSync(requestPath)),root=p.dirname(requestPath),jobs=p.join(root,'distill-jobs'),stem=p.basename(requestPath,'.json'),candidate=p.join(jobs,stem+'.candidate'),index=fs.readFileSync(p.join(root,'index.jsonl'),'utf8').trim().split('\\n').map(JSON.parse).filter(x=>x.seq>=request.from_seq&&x.seq<=request.cutoff_seq&&x.evaluation_status==='evaluated');function first(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory()){const v=first(f);if(v)return v}else if(e.name==='SKILL.md')return f}}fs.appendFileSync(first(p.join(candidate,'skills')),'\\n<!-- Disposable native E2E candidate. -->\\n');const cases=index.slice(0,4).map(x=>({kind:x.quality<=3?'repair':'guard',seq:x.seq,task:'Synthetic bracket check',checkpoint:'Before check',evidence:x.feedback||'用户',failureSignature:'Synthetic error',expectedRepair:'Synthetic repair',regressionGuard:'Keep dimensions',engineeringCheck:[process.execPath,'-e','console.log("synthetic CAD evidence");process.exit(0)']}));fs.writeFileSync(p.join(jobs,stem+'.replay.json'),JSON.stringify({cases}));console.log('Synthetic distillation candidate');}else if(args.at(-1).startsWith('Judge one'))console.log('PASS\\nSynthetic checkpoint reply');else console.log('Synthetic next bounded action');\n`,{mode:0o755});
  writeFileSync(join(bin,'uv'),`#!${process.execPath}\n// Analyzing is outside this network test. Original archival stores its failure.\nconsole.error('Synthetic analyzer unavailable');process.exit(1);\n`,{mode:0o755});
  symlinkSync(process.execPath,join(bin,'node'));
  writeFileSync(join(bin,'realpath'),`#!${process.execPath}\nconst fs=require('fs');try{console.log(fs.realpathSync(process.argv.at(-1)))}catch(error){console.error(error.message);process.exitCode=1}\n`,{mode:0o755});
  let mode='normal';const roots=new Map();
  function prepare(project, histories) {
    const id=project.split('/').at(-1),root=join(home,'trace-projects',id),physical=join(home,'trace-state',id),sessions=join(root,'.prime-sessions');
    mkdirSync(physical,{recursive:true});mkdirSync(join(home,'trace-projects'),{recursive:true});if(!existsSync(root))symlinkSync(physical,root);mkdirSync(sessions,{recursive:true});roots.set(id,root);
    for(const [session,value] of histories){
      const entries=[{type:'session',id:session,name:value.title},...value.rows.map((message,index)=>({type:'message',id:'row-'+index,timestamp:'2026-10-11T01:00:00Z',message}))];
      writeFileSync(join(sessions,session+'.jsonl'),entries.map(JSON.stringify).join('\n')+'\n');
    }
    const low=[{type:'session',id:'trace-low',name:'失败记录'}, {type:'message',message:{role:'user',content:'用户要求检查孔径'}},{type:'message',message:{role:'assistant',provider:'zai',model:'glm-5.3-flash',usage:{input:110,output:20},content:[{type:'text',text:'检查工具结果'}]}},{type:'message',message:{role:'toolResult',toolName:'python',content:[{type:'text',text:'Tool failed: '+ '完整结果。'.repeat(160)}]}}];
    const high=[{type:'session',id:'trace-high',name:'通过记录'}, {type:'message',message:{role:'user',content:'用户要求保留尺寸'}},{type:'message',message:{role:'assistant',provider:'zai',model:'glm-5.3-flash',usage:{input:200,output:30},content:[{type:'text',text:'尺寸检查通过'}]}}];
    for(const [name,rows] of [['trace-low',low],['trace-high',high]]){const path=join(sessions,name+'.jsonl');if(!existsSync(path))writeFileSync(path,rows.map(JSON.stringify).join('\n')+'\n');}
    // A transcript symlink must never be listed or read as an in-project file.
    const escape=join(sessions,'escape.jsonl'),outside=join(home,'outside-trace.jsonl');writeFileSync(outside,JSON.stringify({message:{role:'user',content:'outside secret'}})+'\n');if(!existsSync(escape))symlinkSync(outside,escape);
    return root;
  }
  function execute(args,input,project,histories,audit,{event,stderr,exit}) {
    const encoded=args[args.indexOf('-e')+2],q=JSON.parse(input||Buffer.from(encoded,'base64').toString()),root=prepare(project,histories),virtual='/workspace/projects/'+project.split('/').at(-1),currentMode=mode;
    if(q.root!==virtual)throw Error('Trace fixture project mismatch');
    const actual=v=>typeof v==='string'?v.replace(virtual,root).replace('/workspace/home',traceHome):v;
    const body={...q,path:actual(q.path),paths:q.paths?.map(actual),jobPath:actual(q.jobPath)};
    let native=args[args.indexOf('-e')+1].replaceAll('/opt/reify/pi-cad',repo).replaceAll('/opt/reify/node/bin/node',process.execPath).replaceAll('/opt/reify/prime-agent',prime).replaceAll('/workspace/home',traceHome);
    native=native.replace('projectPath:q.root',`projectPath:${JSON.stringify(root)}`);
    // Ensure original desktop's PATH includes the disposable analyzer stub.
    native=native.replace("const spawn=args=>{const child=cp.spawn(args[0],args.slice(1),{env:process.env})",`const spawn=args=>{args=args.map(x=>x.startsWith('PATH=')?'PATH='+${JSON.stringify(bin)}+':'+x.slice(5):x);const child=cp.spawn(args[0],args.slice(1),{env:process.env})`);
    if(currentMode==='failure')native=native.replace("if(q.op==='distill')result=await", "if(q.op==='distill')throw Error('Synthetic experience failure');if(q.op==='distill')result=await");
    if(currentMode==='slow-read')native=native.replace("if(q.op==='read')result=await", "if(q.op==='read'&&q.path.endsWith('trace-low.jsonl'))await new Promise(r=>setTimeout(r,400));if(q.op==='read')result=await");
    if(currentMode==='wait')native=native.replace("if(q.op==='distill')result=await", "if(q.op==='distill')await new Promise(r=>setTimeout(r,30000));if(q.op==='distill')result=await");
    let replayPath,replayBytes;
    if(currentMode==='replay-failure'&&q.op==='validate') { replayPath=body.jobPath.replace('.job.json','.replay.json');replayBytes=readFileSync(replayPath);const replay=JSON.parse(replayBytes);replay.cases[0].engineeringCheck=[process.execPath,'-e','process.exit(1)'];writeFileSync(replayPath,JSON.stringify(replay)); }
    const child=spawn(process.execPath,['-e',native],{cwd:repo,env:{...process.env,PATH:bin+':'+process.env.PATH,PI_CAD_DISTILL_COMMAND_JSON:'',PI_CAD_DISTILL_PRIME_COMMAND:primeScript,PI_CAD_EXPERIENCE_ROOT:join(traceHome,'.cad/transcripts'),PI_CAD_DISTILL_THRESHOLD_TOKENS:'999999',PI_CAD_TRANSCRIPT_ANALYZER_ENV:join(home,'trace-analyzer'),PI_CAD_DISTILL_PROVIDER:'',PI_CAD_DISTILL_MODEL:'',PI_CAD_DISTILL_THINKING:''}});
    const out=[],err=[];let pending='';child.stdout.on('data',bytes=>{out.push(bytes);pending+=bytes.toString();for(let at;(at=pending.indexOf('\n'))>=0;){const line=pending.slice(0,at);pending=pending.slice(at+1);event?.(line.replaceAll(root,virtual).replaceAll(traceHome,'/workspace/home')+'\n');}});
    child.stderr.on('data',bytes=>{err.push(bytes);stderr?.(bytes)});
    child.on('close',code=>{if(replayBytes)writeFileSync(replayPath,replayBytes);const index=join(traceHome,'.cad/transcripts/index.jsonl');audit.push({type:'trace',op:q.op,mode:currentMode,code,paths:q.paths,jobPath:q.jobPath,ratings:existsSync(index)?readFileSync(index,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).map(x=>({runId:x.run_id,quality:x.quality,difficulty:x.difficulty,feedback:x.feedback})):[],prime:existsSync(auditFile)?readFileSync(auditFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]});exit(code,Buffer.concat(out).toString().replaceAll(root,virtual).replaceAll(traceHome,'/workspace/home'),Buffer.concat(err).toString());});
    child.stdin.end(JSON.stringify(body));return child;
  }
  return {execute,get mode(){return mode},set mode(v){mode=v}};
}
