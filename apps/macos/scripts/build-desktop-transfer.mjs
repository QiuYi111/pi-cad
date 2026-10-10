import {build} from 'esbuild';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../../..');
const source=`
import {CadTransferService} from './apps/desktop/electron/main/cad-transfer.ts';
const timers=new Map(),calls=new Map();let sequence=0,service,io,scope='',jobs=new Map(),exportSources=new Map();
globalThis.setTimeout=(fn,ms=0)=>{const id=String(++sequence);timers.set(id,{fn,repeat:false});nativeCadTimer(id,ms,false);return id};
globalThis.setInterval=(fn,ms)=>{const id=String(++sequence);timers.set(id,{fn,repeat:true});nativeCadTimer(id,ms,true);return id};
globalThis.clearTimeout=globalThis.clearInterval=id=>{timers.delete(String(id));nativeCadCancelTimer(String(id))};
globalThis.reifyCadTimer=id=>{const timer=timers.get(id);if(!timer)return;if(!timer.repeat)timers.delete(id);timer.fn()};
function fs(op,path,text='',other=''){const result=JSON.parse(nativeCadFS(op,path,text,other));if(!result.ok)throw Error(result.error);return result.value}
function rpc(operation,fields={}){const id=String(++sequence);return new Promise((resolve,reject)=>{calls.set(id,{resolve,reject});nativeCadIO(id,JSON.stringify({operation,scope,...fields}))})}
globalThis.reifyCadResolve=(id,json,error)=>{const c=calls.get(id);if(!c)return;calls.delete(id);if(error)c.reject(Object.assign(Error(error.message),error));else c.resolve(JSON.parse(json))};
globalThis.reifyCadInit=(home,addin)=>{
 service=new CadTransferService({host:{platform:'darwin',env:{},home,insideWsl:false},fs:{exists:async p=>fs('exists',p),readText:async p=>fs('read',p),writeTextAtomic:async(p,t)=>fs('write',p,t),mkdirp:async p=>fs('mkdir',p),readdir:async p=>fs('list',p),rm:async p=>fs('remove',p),cp:async(a,b)=>fs('copy',a,'',b)},registry:{read:async()=>null},runner:{run:async()=>{throw Error('Windows executor unavailable')},start:()=>{throw Error('Windows executor unavailable')}},clock:{now:()=>Date.now(),sleep:ms=>new Promise(r=>setTimeout(r,ms))},bundledFusionAddin:addin,bundledSolidworksExe:null,projectInWsl:false,pid:nativeCadPID(),emit:event=>{if(event.type==='job')jobs.set(event.job.jobId,event.job);nativeCadEvent(JSON.stringify(event))},agent:(body,timeout)=>rpc('agent',{body,timeout,source:exportSources.get(body.jobId)})});
};
globalThis.reifyCadRequest=(id,operation,json)=>{
 Promise.resolve().then(async()=>{const q=JSON.parse(json||'{}');
  if(operation==='attach'){scope=q.scope;io={root:q.root,spoolPollMs:2000,readText:path=>rpc('read',{path}),writeTextAtomic:(path,text)=>rpc('write',{path,text}),readdir:async path=>{const names=await rpc('list',{path});if(path!=='.pi-cad/transfer/requests')return names;const visible=[];for(const name of names){if(!name.endsWith('.json'))continue;const id=name.slice(0,-5);try{const body=JSON.parse(await rpc('read',{path:path+'/'+name}));const owned=jobs.has(id);if(body.sessionId===undefined?owned:body.sessionId===q.sessionId&&(q.sessionId!=null||owned))visible.push(name);else nativeCadEvent(JSON.stringify({type:'scope-error',message:'云端导出属于其他对话或缺少对话标识，请从当前画布导出'}))}catch{}}return visible;},exists:path=>rpc('exists',{path}),remove:path=>rpc('remove',{path}),copyIn:(file,path)=>rpc('upload',{file,path}),toHostPath:path=>rpc('cache',{path})};await service.start(io);return service.getStatus(true)}
  if(operation==='status'){if(io)await service.writeHeartbeat();return service.getStatus(true);}
  if(operation==='install')return service.installFusionAddin();
  if(operation==='export'){const job=service.startExport('fusion',q.path);exportSources.set(job.jobId,{path:q.path,sha256:q.sha256});return job;}
  if(operation==='test')return service.testExport('fusion');
  if(operation==='cancel')return service.cancel(q.jobId);
  if(operation==='close'){const active=[...jobs.values()].filter(j=>['queued','running'].includes(j.state));for(const job of active)service.cancel(job.jobId);if(io)await Promise.all(active.map(j=>io.writeTextAtomic('.pi-cad/transfer/cancel/'+j.jobId,'').catch(()=>{})));const deadline=Date.now()+6000;while(active.some(j=>['queued','running'].includes(jobs.get(j.jobId)?.state))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));await service.stop();io=null;return true}
  throw Error('Unknown CAD action');
 }).then(result=>nativeCadComplete(id,JSON.stringify(result),''),error=>nativeCadComplete(id,'',error.message||String(error)));
};
globalThis.reifyCadDispose=()=>{for(const id of timers.keys())clearTimeout(id);for(const [id,c] of calls){c.reject(Error('CAD connection closed'));calls.delete(id)}};
`;
const output=await build({stdin:{contents:source,resolveDir:root,loader:'ts'},bundle:true,format:'iife',platform:'browser',target:'safari17',write:false,plugins:[{name:'native-posix',setup(build){build.onResolve({filter:/^node:path$/},()=>({path:'native-path',namespace:'native'}));build.onLoad({filter:/.*/,namespace:'native'},()=>({contents:`const call=(op,args)=>nativeCadPath(op,JSON.stringify(args));export const posix={join:(...p)=>call('join',p),dirname:p=>call('dirname',[p]),basename:p=>call('basename',[p])};export const win32=posix;`,loader:'js'}))}}]});
await writeFile(process.argv[2],output.outputFiles[0].text);
