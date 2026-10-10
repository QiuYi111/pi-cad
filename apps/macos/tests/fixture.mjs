// A disposable cloud protocol server. No production credentials or model calls.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const fixtureHome = mkdtempSync(`${tmpdir()}/reify-native-workflows-`);
const fixtureRepo = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/,'');
const fixtureJiti=createRequire(import.meta.url)(fixtureRepo+'/node_modules/jiti').createJiti(fixtureRepo+'/package.json');
const {canonicalDigest:fixtureDigest}=await fixtureJiti.import(fixtureRepo+'/src/harness/canonical.ts');
const sha = data => createHash('sha256').update(data).digest('hex');
const port = Number(process.env.REIFY_FIXTURE_PORT ?? 18765);
const projects = [{id: '11111111-1111-4111-8111-111111111111', name: '桌面支架', role: 'maintainer', createdAt: new Date().toISOString()}];
let state = 'stopped', accesses = new Set(), refreshes = new Set();
let accountPassword = 'fixture-password';
const stats = {login: 0, rejectedLogin: 0, refresh: 0, projects: 0, start: 0, stop: 0, spawn: 0, prompt: 0, abort: 0, uploads: 0, downloads: 0, kills: 0, attaches: 0};
const audit = [];
let customModels = '{"providers":{}}', favorites = [], defaults = {}, credentials = new Map([['openai-codex',true],['zai',true]]);
function catalog() {
  const definitions = [
    ['openai-codex','OpenAI Codex',true,'gpt-5.6-sol','Sol',['off','minimal','low','medium','high','xhigh','max']],
    ['zai','Z.AI',false,'glm-5.3-flash','GLM 5.3 Flash',['off','high']],
    ['custom','Custom',false,'custom-chat','Custom Chat',['off']]
  ];
  return {providers:definitions.map(([id,name,oauth,model,title,levels])=>({id,name,oauth,auth:{provider:id,configured:!!credentials.get(id),state:credentials.get(id)?'signed-in':'signed-out',source:credentials.get(id)?'stored':undefined,message:credentials.get(id)?'已连接':'未配置'},models:[{provider:id,id:model,name:title,thinkingLevels:levels,input:['text','image'],available:!!credentials.get(id)}]})),favorites,defaults};
}
function box(x,y,z,w,d,h) {
  const v=[[x,y,z],[x+w,y,z],[x+w,y+d,z],[x,y+d,z],[x,y,z+h],[x+w,y,z+h],[x+w,y+d,z+h],[x,y+d,z+h]];
  return [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]].map(t=>t.map(i=>v[i]));
}
const triangles=[...box(0,0,0,80,40,4),...box(0,0,4,80,4,26)];
const stl=Buffer.alloc(84+triangles.length*50);stl.writeUInt32LE(triangles.length,80);
triangles.forEach((t,i)=>t.flat().forEach((value,j)=>stl.writeFloatLE(value,84+i*50+12+j*4)));

const files = new Map([['bracket.stl', stl], ['bracket.step', Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;')], ['corrupt.stl', stl]]);
files.set('bracket.py',Buffer.from('# disposable model source fixture\n'));
let modelWidth=80, expandedCatalog=false, reviewVerified=false, approvalRevision=1, evidenceTampered=false;
const evidenceDocument=session=>({schema:1,reviewId:'fixture-review-'+session,profileId:'fixture-independent',workflowHash:'hash-'+session,result:{verdict:'pass',summary:'Fixture independent check'}});
const geometryDocument=session=>{const envelope={schema:1,ok:true,payload:{bbox:{x:80,y:40,z:30},volume:9600},artifacts:[]};return {schema:1,evidence:{path:'evidence/geometry/fixture.json',sha256:fixtureDigest(envelope),workflowHash:'hash-'+session},envelope}};
const evidenceFor=(path,session)=>path.startsWith('evidence/geometry/')?geometryDocument(session):evidenceDocument(session);
files.set('history/bracket-80.step',Buffer.from('ISO-10303-21;\nWIDTH=80;\nEND-ISO-10303-21;'));
files.set('engineering-report.json',Buffer.from('{"checks":[]}'));
function parameterManifest(){const manifest={schema:1,modelId:'bracket',source:{path:'bracket.py',sha256:sha(files.get('bracket.py')),entrypoint:'build'},output:{path:'bracket.step',sha256:sha(files.get('bracket.step'))},parameters:[{id:'width',type:'number',default:80,value:modelWidth,min:20,max:160,step:1,unit:'mm',label:'宽度'}]};const data=Buffer.from(JSON.stringify(manifest));files.set('bracket.parameters.json',data);return {path:'bracket.parameters.json',sha256:sha(data),manifest}}
const sessions = new Map();
const generatedSessions = new Set();
const spawns = new Map();
const user = {id: 'e2e-user', email: 'e2e@reify.test', displayName: '测试账户'};
let startupMode='normal', lastError=null;
const view = () => ({name: 'ws-e2e', state, desired: state === 'stopped' ? 'stopped' : 'running', lastError, queuePosition: state==='queued'?2:null, reclaimAt: null});
const token = (expiresIn = 900) => { const a = randomUUID(), r = randomUUID(); accesses.add(a); refreshes.add(r); return {accessToken: a, refreshToken: r, expiresIn, user}; };
const respond = (res, code, body) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(body === undefined ? undefined : JSON.stringify(body)); };
const events = new WebSocketServer({noServer: true}), bridge = new WebSocketServer({noServer: true});
const broadcast = row => { for(const ws of events.clients) if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(row)); };
const server = http.createServer(async (req, res) => {
  let text = ''; for await(const chunk of req) text += chunk;
  // Fastify rejects an empty body advertised as JSON, including workspace actions.
  if (!text && req.headers['content-type']?.startsWith('application/json')) return respond(res,400,{message:'请求格式不正确'});
  let b = {}; try { b = text ? JSON.parse(text) : {}; } catch { return respond(res,400,{message:'请求格式错误'}); }
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/v1/healthz') return respond(res,200,{ok:true});
  if (path === '/__test/approval-version') { approvalRevision=Number(b.version);return respond(res,200,{ok:true}); }
  if (path === '/__test/evidence-tamper') { evidenceTampered=b.enabled==='true';return respond(res,200,{ok:true}); }
  if (path === '/__test/catalog-parity') { expandedCatalog=true;return respond(res,200,{ok:true}); }
  if (path === '/__test/model-width') { modelWidth=Number(b.width);files.set('bracket.step',Buffer.from(`ISO-10303-21;\nWIDTH=${modelWidth};\nEND-ISO-10303-21;`));parameterManifest();return respond(res,200,{sha256:sha(files.get('bracket.step'))}); }
  if (path === '/__test/stats') return respond(res,200,{stats,audit,state});
  if (path === '/__test/start-mode') { startupMode=b.mode;return respond(res,200,{ok:true}); }
  if (path === '/__test/expire') { accesses.clear();refreshes.clear();return respond(res,200,{ok:true}); }
  if (path === '/__test/drop') { for(const ws of bridge.clients) ws.close(1012,'fixture restart'); return respond(res,200,{ok:true}); }
  if (path === '/__test/reclaim') {state='stopped';broadcast({type:'reclaimed'});for(const ws of bridge.clients)ws.close(1012,'idle pause');return respond(res,200,{ok:true});}
  if (path === '/__test/idle') { broadcast({type:'idle_warning',reclaimAt:new Date(Date.now()+60000).toISOString()}); return respond(res,200,{ok:true}); }
  if (path === '/v1/auth/login') {
    if(b.email !== user.email || b.password !== accountPassword) { stats.rejectedLogin++; return respond(res,401,{code:'invalid_credentials',message:'邮箱或密码错误'}); }
    stats.login++; return respond(res,200,token(1)); // exercise refresh immediately
  }
  if (path === '/v1/auth/refresh') {
    if(!refreshes.delete(b.refreshToken)) return respond(res,401,{message:'登录已失效'});
    stats.refresh++; return respond(res,200,token());
  }
  if (path === '/v1/auth/logout') { refreshes.delete(b.refreshToken); return respond(res,204); }
  if (!accesses.has((req.headers.authorization ?? '').replace('Bearer ',''))) return respond(res,401,{message:'登录已失效'});
  if (path === '/v1/projects' && req.method === 'GET') { stats.projects++; return respond(res,200,{projects}); }
  if (path === '/v1/projects' && req.method === 'POST') {
    if(!b.name?.trim()) return respond(res,400,{message:'请填写项目名称'});
    const p={id:randomUUID(), name:b.name.trim(), role:'maintainer',createdAt:new Date().toISOString()}; projects.push(p); return respond(res,201,p);
  }
  if (path.startsWith('/v1/projects/') && ['PATCH','DELETE'].includes(req.method)) {
    const at=projects.findIndex(p=>p.id===path.split('/').at(-1));if(at<0)return respond(res,404,{message:'项目不存在'});
    if(req.method==='DELETE'){projects.splice(at,1);return respond(res,204)}
    if(!b.name?.trim())return respond(res,400,{message:'请填写项目名称'});
    projects[at]={...projects[at],name:b.name.trim()};return respond(res,200,projects[at]);
  }
  if(path==='/v1/auth/password') {
    if(b.oldPassword!==accountPassword)return respond(res,401,{message:'原密码错误'});
    if(b.newPassword?.length<10)return respond(res,400,{message:'新密码至少 10 个字符'});
    accountPassword=b.newPassword;
    return respond(res,204);
  }
  if (path === '/v1/workspace/start') {
    stats.start++;lastError=null;
    if(startupMode==='fail'){startupMode='normal';state='failed';lastError='测试工作区磁盘不足';broadcast({type:'workspace_state',state});return respond(res,200,view());}
    if(startupMode==='queue'){startupMode='normal';state='queued';setTimeout(()=>{state='running';broadcast({type:'workspace_state',state});},750);return respond(res,409,{code:'capacity_full',message:'工作区已排队',position:2});}
    state='starting'; setTimeout(()=>{state='running';broadcast({type:'workspace_state',state});},150); return respond(res,200,view());
  }
  if (path === '/v1/workspace/stop') { stats.stop++; state='stopped';broadcast({type:'workspace_state',state}); return respond(res,200,view()); }
  if (path === '/v1/workspace' || path === '/v1/workspace/keepalive') return respond(res,200,view());
  respond(res,404,{message:'未找到'});
});
server.on('upgrade', (req,socket,head) => {
  if(!accesses.has((req.headers.authorization ?? '').replace('Bearer ',''))) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
  const wss = req.url === '/v1/events' ? events : req.url === '/v1/workspace/bridge' ? bridge : null;
  if(!wss) return socket.destroy();
  wss.handleUpgrade(req,socket,head,ws => wss.emit('connection',ws,req));
});
bridge.on('connection',ws=>{
  let rows=[], project='', stdin=Buffer.alloc(0), upload=null, timer=null, activeSpawn=null;
  const send = row => { if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(row)); };
  const frame = (ch,data) => { const h=Buffer.alloc(4);h.writeUInt32BE(ch); if(ws.readyState===WebSocket.OPEN) ws.send(Buffer.concat([h,Buffer.from(data)])); };
  const output = row => {
    if(activeSpawn) { if(row.type==='agent_start')activeSpawn.streaming=true; if(row.type==='agent_end'){activeSpawn.streaming=false;activeSpawn.timer=null;} activeSpawn.sessionID=currentSession; activeSpawn.histories=histories; }
    const bytes=Buffer.from(JSON.stringify(row)+'\n');
    if(activeSpawn) {activeSpawn.replay.push(bytes);const target=activeSpawn.socket;const h=Buffer.alloc(4);h.writeUInt32BE(1);if(target.readyState===WebSocket.OPEN){const split=Math.max(1,bytes.indexOf(Buffer.from('支架'))+1);target.send(Buffer.concat([h,bytes.subarray(0,split)]));target.send(Buffer.concat([h,bytes.subarray(split)]));}}
    else frame(1,bytes);
  };
  const reply = (r,data={}) => output({type:'response',id:r.id,command:r.type,success:true,data});
  const authProcesses = new Map();
  let currentSession='fixture-session', selectedModel={provider:'openai-codex',id:'gpt-5.6-sol'}, thinkingLevel='minimal';
  let histories = new Map([['fixture-session', {rows:[],title:'初始对话'}]]);
  let awaitingUI=null;
  ws.on('message',(data,binary)=>{
    if(binary) {
      const ch=data.readUInt32BE(0), bytes=data.subarray(4);
      if(authProcesses.has(ch)) {
        const process=authProcesses.get(ch);process.buffer+=bytes.toString();
        for(let at;(at=process.buffer.indexOf('\n'))>=0;){const line=process.buffer.slice(0,at);process.buffer=process.buffer.slice(at+1);const value=JSON.parse(line).value;
          if(value==='fixture-code'){credentials.set(process.provider,true);frame(ch,JSON.stringify({type:'auth_complete'})+'\n');send({type:'exit',ch,code:0});authProcesses.delete(ch)}
          else frame(ch,JSON.stringify({type:'auth_error',message:'授权码错误'})+'\n');}
        return;
      }
      if(upload?.ch===ch) { upload.data=Buffer.concat([upload.data,bytes]); return; }
      if(ch!==1) return;
      stdin=Buffer.concat([stdin,bytes]);
      for(let at; (at=stdin.indexOf(10))>=0;) {
        const r=JSON.parse(stdin.subarray(0,at).toString());stdin=stdin.subarray(at+1);
        if(r.type==='get_state') reply(r,{sessionId:currentSession,thinkingLevel,model:selectedModel,isStreaming:activeSpawn?.streaming??!!timer});
        else if(r.type==='get_messages') reply(r,{messages:rows});
        else if(r.type==='new_session') { histories.set(currentSession,{rows,title:histories.get(currentSession)?.title??'历史对话'});currentSession=randomUUID();rows=[];histories.set(currentSession,{rows,title:'新对话'});sessions.set(project,rows);if(activeSpawn){activeSpawn.rows=rows;activeSpawn.sessionID=currentSession;activeSpawn.histories=histories}reply(r); }
        else if(r.type==='set_session_name') { histories.set(currentSession,{rows,title:r.name});reply(r); }
        else if(r.type==='switch_session') { const id=r.sessionPath.split('/').at(-1).replace('.jsonl','');const saved=histories.get(id);if(!saved)return output({type:'response',id:r.id,success:false,error:'对话不存在'});currentSession=id;rows=saved.rows;sessions.set(project,rows);if(activeSpawn){activeSpawn.rows=rows;activeSpawn.sessionID=currentSession;activeSpawn.histories=histories}reply(r); }
        else if(r.type==='set_model') { const choice=catalog().providers.flatMap(p=>p.models).find(m=>m.provider===r.provider&&m.id===r.modelId);if(!choice?.available)output({type:'response',id:r.id,success:false,error:'模型不可用'});else {selectedModel={provider:r.provider,id:r.modelId};if(activeSpawn)activeSpawn.model=selectedModel;reply(r,{model:selectedModel})} }
        else if(r.type==='set_thinking_level') { const choice=catalog().providers.flatMap(p=>p.models).find(m=>m.provider===selectedModel.provider&&m.id===selectedModel.id);if(!choice?.thinkingLevels.includes(r.level))output({type:'response',id:r.id,success:false,error:'思考档位不支持'});else{thinkingLevel=r.level;if(activeSpawn)activeSpawn.thinking=thinkingLevel;reply(r)} }
        else if(r.type==='prompt') {
          audit.push({type:'prompt',message:r.message,imageCount:r.images?.length??0,imageTypes:r.images?.map(i=>i.mimeType)??[],imageHashes:r.images?.map(i=>sha(Buffer.from(i.data,'base64')))??[]});
          if(r.images?.some(i=>!i.data||!i.mimeType?.startsWith('image/')))return output({type:'response',id:r.id,success:false,error:'Invalid image payload'});
          if(r.message==='拒绝请求验收') { output({type:'response',id:r.id,success:false,error:'请求被拒绝'});continue; }
          stats.prompt++;rows.push({role:'user',content:r.message});reply(r);output({type:'agent_start'});
          histories.set(currentSession,{rows,title:histories.get(currentSession)?.title??'对话'});
          if(r.message==='弹窗协议测试') { awaitingUI={id:'ui-confirm',method:'confirm'};output({type:'extension_ui_request',...awaitingUI,title:'确认测试',message:'确认后继续'});continue; }
          if(r.message==='模拟模型错误') {
            const message={role:'assistant',content:[],stopReason:'error',errorMessage:'测试模型服务不可用'};
            rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});continue;
          }
          if(r.message.startsWith('Submit the current candidate ')) {
            audit.push({type:'review-submission',message:r.message,candidateSHA:sha(files.get('bracket.step'))});
            const call={type:'toolCall',id:'flow-review',name:'python',arguments:{code:'cad.review.submit(subject_commit="fixture")'}};
            rows.push({role:'assistant',content:[call]});output({type:'tool_execution_start',toolCallId:call.id,toolName:call.name,args:call.arguments});
            timer=activeSpawn.timer=setTimeout(()=>{reviewVerified=true;const result={role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:'Independent machine check passed (fixture)'}]};rows.push(result);output({type:'tool_execution_end',toolCallId:call.id,result});const message={role:'assistant',content:[{type:'text',text:'测试服务的独立机器审查已完成'}]};rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});timer=null;},350);continue;
          }
          if(['概念图验收','概念图自动展示验收'].includes(r.message)) {
            const call={type:'toolCall',id:r.message==='概念图验收'?'flow-concept':'flow-concept-auto',name:'python',arguments:{code:'codex_generate_image(prompt="fixture concept")'}};
            rows.push({role:'assistant',content:[call]});output({type:'tool_execution_start',toolCallId:call.id,toolName:call.name,args:call.arguments});
            timer=activeSpawn.timer=setTimeout(()=>{
              const result={role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'image',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',mimeType:'image/png'}],details:{attachments:[]}};
              rows.push(result);output({type:'tool_execution_end',toolCallId:call.id,result});
              const message={role:'assistant',content:[{type:'text',text:'概念图已生成'}]};rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});timer=null;
            },350);continue;
          }
          if(r.message==='工具卡片验收') {
            const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
            output({type:'extension_ui_request',id:'notice-card',method:'notify',message:'工具通知'});
            output({type:'extension_ui_request',id:'status-card',method:'setStatus',statusKey:'cad',statusText:'工作流已就绪'});
            const buildCall={type:'toolCall',id:'flow-build',name:'python',arguments:{code:'cad.model.build(source="bracket.py")'}};
            const simCall={type:'toolCall',id:'flow-sim',name:'python',arguments:{code:'cad.simulation.run()'}};
            rows.push({role:'assistant',content:[buildCall]});
            output({type:'tool_execution_start',toolCallId:buildCall.id,toolName:buildCall.name,args:buildCall.arguments});
            setTimeout(()=>output({type:'tool_execution_update',toolCallId:buildCall.id,stage:'检查模型',progress:0.6}),100);
            setTimeout(()=>{
              const result={role:'toolResult',toolCallId:buildCall.id,toolName:buildCall.name,content:[{type:'text',text:'已生成 /workspace/bracket.step'},{type:'image',data:png,mimeType:'image/png'}],details:{attachments:[{data:png,mimeType:'image/png',label:'正视图'}]}};
              rows.push(result);output({type:'tool_execution_end',toolCallId:buildCall.id,result});
              rows.push({role:'assistant',content:[simCall]});output({type:'tool_execution_start',toolCallId:simCall.id,toolName:simCall.name,args:simCall.arguments});
            },350);
            timer=activeSpawn.timer=setTimeout(()=>{
              const result={role:'toolResult',toolCallId:simCall.id,toolName:simCall.name,content:[{type:'text',text:'分析完成'}],details:{outputs:[{name:'最大应力',type:'scalar',value:12,unit:'MPa'},{name:'结果场',type:'field',path:'stress.vtk'}]}};
              rows.push(result);output({type:'tool_execution_end',toolCallId:simCall.id,result});
              const message={role:'assistant',content:[{type:'text',text:'工具卡片测试完成。\n\n| 项目 | 结果 |\n| --- | --- |\n| 应力 | **12 MPa** |\n\n```python\nprint(12)\n```\n\n1. 检查尺寸\n2. [下载结果](bracket.step)\n\n- [x] 已检查'}]};
              rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});timer=null;
            },700);continue;
          }
          if(r.message==='重试状态验收') {
            output({type:'auto_retry_start',attempt:1,maxAttempts:3,delayMs:2000,errorMessage:'Rate limit 429'});
            timer=activeSpawn.timer=setTimeout(()=>{
              output({type:'auto_retry_end',success:true});output({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'重新检查'}});
              timer=activeSpawn.timer=setTimeout(()=>{const message={role:'assistant',content:[{type:'text',text:'重试成功'}]};rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});timer=null;},300);
            },650);continue;
          }
          output({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'正在创建支架…'}});
          timer=activeSpawn.timer=setTimeout(()=>{modelWidth=80;files.set('bracket.step',Buffer.from('ISO-10303-21;\nWIDTH=80;\nEND-ISO-10303-21;'));parameterManifest();generatedSessions.add(project+'/'+currentSession);const message={role:'assistant',content:[{type:'text',text:'支架已完成。尺寸 80 × 40 × 30 mm，已生成 STL 和 STEP 文件。'}]};rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});timer=null;},r.message.includes('长任务') ? 30000 : 450);
        } else if(r.type==='abort') {stats.abort++;clearTimeout(timer);clearTimeout(activeSpawn?.timer);timer=null;reply(r);output({type:'agent_end',messages:rows});}
        else if(r.type==='extension_ui_response') {
          if(!awaitingUI||r.id!==awaitingUI.id)return;
          audit.push({type:'ui-answer',method:awaitingUI.method,value:r.value,cancelled:r.cancelled});
          if(awaitingUI.method==='confirm'&&r.value!==true)throw Error('confirm must return value:true');
          if(awaitingUI.method==='confirm')awaitingUI={id:'ui-editor',method:'editor',prefill:'预填第一行\n第二行'};
          else if(awaitingUI.method==='editor'){if(r.value!=='预填第一行\n第二行\n补充')throw Error('editor lost prefill');awaitingUI={id:'ui-input',method:'input',prefill:'尺寸',placeholder:'请输入尺寸'}}
          else if(awaitingUI.method==='input'){if(r.value!=='尺寸20')throw Error('input lost prefill');awaitingUI={id:'ui-select',method:'select',options:['方案一','方案二']}}
          else {if(r.value!=='方案二')throw Error('wrong selection');const message={role:'assistant',content:[{type:'text',text:'弹窗协议测试完成'}]};rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});awaitingUI=null;continue;}
          output({type:'extension_ui_request',title:'输入测试',...awaitingUI});
        }
        else output({type:'response',id:r.id,success:false,error:'unsupported fixture RPC'});
      }
      return;
    }
    const r=JSON.parse(data.toString());
    if(r.type==='spawn') {
      if(r.args.includes('/opt/reify/pi-cad/scripts/desktop-openai-oauth.mjs')) {
        authProcesses.set(r.ch,{provider:r.args.at(-1),buffer:''});send({type:'spawned',ch:r.ch,spawnId:randomUUID(),pid:456});
        frame(r.ch,JSON.stringify({type:'auth_url',url:'https://example.com/oauth',instructions:'测试服务商登录'})+'\n');frame(r.ch,JSON.stringify({type:'auth_input',placeholder:'测试授权码'})+'\n');return;
      }
      stats.spawn++; audit.push({type:'spawn',args:r.args,env:r.env});
      if(!r.args.includes('/opt/reify/pi-cad/scripts/prime-cad-sidecar.mjs') || (!r.args.includes('--reviewer-inherit-author')&&!r.args.includes('--reviewer-provider')) || r.env?.PI_CAD_CANONICAL_PROJECT_DIR?.startsWith('/workspace/state/')!==true) return send({type:'error',ch:r.ch,message:'wrong cloud runtime command'});
      selectedModel={provider:r.args[r.args.indexOf('--provider')+1],id:r.args[r.args.indexOf('--model')+1]};thinkingLevel=r.args[r.args.indexOf('--thinking')+1];
      project=r.env.PI_CAD_CANONICAL_PROJECT_DIR;rows=sessions.get(project)??[];if(rows.length&&!r.args.includes('/workspace/.prime-sessions/fixture-session.jsonl'))return send({type:'error',ch:r.ch,message:'missing session resume'});sessions.set(project,rows);send({type:'spawned',ch:r.ch,spawnId:(activeSpawn={id:randomUUID(),project,rows,replay:[],socket:ws,sessionID:currentSession,histories,model:selectedModel,thinking:thinkingLevel}).id,pid:123});
          spawns.set(activeSpawn.id,activeSpawn);
    } else if(r.type==='attach') {
      const old=spawns.get(r.spawnId);if(!old)return send({type:'error',ch:r.ch,code:'no_such_spawn',message:'没有这个进程'});
      stats.attaches++;activeSpawn=old;activeSpawn.socket=ws;project=old.project;rows=old.rows;currentSession=old.sessionID??'fixture-session';histories=old.histories??histories;selectedModel=old.model??selectedModel;thinkingLevel=old.thinking??thinkingLevel;
      for(const bytes of old.replay)frame(r.ch,bytes);
    } else if(r.type==='exec') {
      const result=value=>send({type:'exec_result',ch:r.ch,code:0,stderr:'',stdout:typeof value==='string'?value:JSON.stringify(value)});
      if(r.args.some(a=>a.includes('REIFY_EVIDENCE_READ'))) {
        // The native reader uses the original transaction verifier on real files.
        const q=JSON.parse(r.input),root=join(fixtureHome,'evidence-project');mkdirSync(root,{recursive:true});
        const native=r.args[r.args.indexOf('-e')+1].replaceAll('/opt/reify/pi-cad',fixtureRepo);
        const setup=`const __fixtureCp=require('child_process'),__fixtureFs=require('fs'),__fixtureJiti=require(${JSON.stringify(fixtureRepo+'/node_modules/jiti')}).createJiti(${JSON.stringify(fixtureRepo+'/package.json')});const {HarnessRunStoreV7:__FixtureStore}=await __fixtureJiti.import(${JSON.stringify(fixtureRepo+'/src/harness/run-store.ts')});const __fixtureStore=new __FixtureStore(${JSON.stringify(root)},${JSON.stringify(q.runId)});__fixtureFs.rmSync(__fixtureStore.runDirectory,{recursive:true,force:true});const __fixtureHead=await __fixtureStore.transactions.readHead();const __fixtureNext=await __fixtureStore.transactions.commit({expectedGeneration:__fixtureHead?.generation??0,payloads:{[${JSON.stringify(q.path)}]:${JSON.stringify(evidenceFor(q.path,q.sessionId))}},event:{type:'FixtureEvidence'}});if(${evidenceTampered})__fixtureFs.writeFileSync(require('path').join(__fixtureStore.runDirectory,'transactions',__fixtureNext.txId,${JSON.stringify(q.path)}),'changed evidence');__fixtureCp.spawnSync=(command,args,options)=>{const request=JSON.parse(options.input);if(request.sessionId!==${JSON.stringify(q.sessionId)})return {status:1,stdout:JSON.stringify({schema:1,ok:false,error:{message:'Wrong conversation'}})};return {status:0,stdout:JSON.stringify({schema:1,ok:true,result:{runId:${JSON.stringify('run-'+q.sessionId)},workflowHash:${JSON.stringify('hash-'+q.sessionId)}}}),stderr:''}};`;
        const script='(async()=>{'+setup+native+'})().catch(error=>{console.error(error);process.exitCode=1})',parts=[],errors=[];
        const child=spawn(process.execPath,['-e',script],{cwd:fixtureRepo,env:{...process.env,PI_CAD_CANONICAL_PROJECT_DIR:root}});child.stdout.on('data',x=>parts.push(x));child.stderr.on('data',x=>errors.push(x));
        child.on('close',code=>send({type:'exec_result',ch:r.ch,code,stdout:Buffer.concat(parts).toString(),stderr:Buffer.concat(errors).toString()}));child.stdin.end(JSON.stringify({...q,root}));return;
      }
      if(r.args.some(a=>a.includes('REIFY_STEP_IMPORT'))) {
        // Execute the native adapter and the original desktop importer on real files.
        const q=JSON.parse(r.input),root=join(fixtureHome,'projects',project.split('/').at(-1));mkdirSync(root,{recursive:true});
        for(const [relative,bytes] of files){const target=join(root,relative);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,bytes);}
        const script=r.args[r.args.indexOf('-e')+1].replaceAll('/opt/reify/pi-cad',fixtureRepo),parts=[],errors=[];
        const child=spawn(process.execPath,['-e',script],{cwd:fixtureRepo});child.stdout.on('data',x=>parts.push(x));child.stderr.on('data',x=>errors.push(x));
        child.on('close',code=>{const stdout=Buffer.concat(parts).toString();if(code===0){const imported=JSON.parse(stdout);files.set(imported.path,readFileSync(join(root,imported.path)));}files.delete(q.staged);send({type:'exec_result',ch:r.ch,code,stdout,stderr:Buffer.concat(errors).toString()});});
        child.stdin.end(JSON.stringify({...q,root}));return;
      }
      if(r.args.some(a=>a.includes('REIFY_WORKFLOW_LIBRARY'))) {
        // Run the client's complete script and the real desktop compiler against
        // disposable local storage, rather than returning fabricated save results.
        const script=r.args[r.args.indexOf('-e')+1].replaceAll('/opt/reify/pi-cad',fixtureRepo).replaceAll('/workspace/home',fixtureHome);
        const child=spawn(process.execPath,['-e',script],{cwd:fixtureRepo}),parts=[],errors=[];
        child.stdout.on('data',x=>parts.push(x));child.stderr.on('data',x=>errors.push(x));
        child.on('close',code=>send({type:'exec_result',ch:r.ch,code,stdout:Buffer.concat(parts).toString(),stderr:Buffer.concat(errors).toString()}));
        child.stdin.end(r.input??'{}');return;
      }
      if(r.args.includes('/opt/reify/pi-cad/scripts/pi-cad-agent-api.mjs')) {
        const q=JSON.parse(r.input??'{}');audit.push({type:'engineering',request:q});
        if(q.schema!==1||!Object.hasOwn(q,'sessionId'))return send({type:'exec_result',ch:r.ch,code:1,stdout:JSON.stringify({schema:1,ok:false,error:{message:'Missing conversation scope',code:'SCOPE_REQUIRED'}}),stderr:'node warning'});
        if(q.sessionId==='authority-error')return send({type:'exec_result',ch:r.ch,code:1,stdout:JSON.stringify({schema:1,ok:false,error:{message:'Finish the current phase',code:'PHASE_DENIED',target:'cad_build_step',hints:['Open the current workflow']}}),stderr:'node warning'});
        const bound=['engineering-a','engineering-b'].includes(q.sessionId)||generatedSessions.has(project+'/'+q.sessionId),name=q.sessionId==='engineering-b'?'sample.step':'bracket.step';
        const artifact={id:`artifact-${q.sessionId}`,path:name,role:'model',sha256:sha(files.get(name)??Buffer.from(''))};
        const run=bound?{runId:`run-${q.sessionId}`,workflowId:'mechanical.naked',workflowVersion:'1.0.0',workflowHash:'hash-'+q.sessionId,phase:'work',status:'active',operations:[{capability:'cad_build_step'}],updatedAt:new Date().toISOString(),phaseHistory:['work'],phases:[{id:'work',title:'Work',purpose:'Build',status:'active',transitions:[],capabilities:['cad_build_step'],obligations:[]}]}:null;
        if(q.op==='evidence-read'){if(!bound)return send({type:'exec_result',ch:r.ch,code:1,stdout:JSON.stringify({schema:1,ok:false,error:{message:'Conversation has no workflow',code:'CONVERSATION_UNBOUND'}}),stderr:''});if(!['reviews/fixture-machine.json','evidence/geometry/fixture.json'].includes(q.path))return send({type:'exec_result',ch:r.ch,code:1,stdout:JSON.stringify({schema:1,ok:false,error:{message:'Invalid fixture evidence'}}),stderr:''});return result({schema:1,ok:true,result:evidenceFor(q.path,q.sessionId)})}
        if(q.op==='workflow-current')return result({schema:1,ok:true,result:run});
        if(q.op==='viewer-catalog') {
          const advanced=expandedCatalog&&generatedSessions.has(project+'/'+q.sessionId);
          const historical={id:'historical-80',path:'history/bracket-80.step',role:'model',sha256:sha(files.get('history/bracket-80.step'))};
          const report={id:'engineering-report',path:'engineering-report.json',role:'evidence',sha256:sha(files.get('engineering-report.json'))};
          const commits=bound?[{id:'commit-'+q.sessionId,name:'Version '+q.sessionId,parent:null,phase:'work',createdAt:new Date().toISOString(),artifacts:[artifact]}]:[];
          const manifests=bound&&name==='bracket.step'?[parameterManifest()]:[];
          if(advanced){commits[0].sourceRevision=String(approvalRevision+1).repeat(40);commits[0].workflowHash=run.workflowHash;commits[0].acceptanceSummary={requirements:[{id:'machine',category:'machine',status:reviewVerified?'verified':'unverified',method:'Independent reviewer',evidence:{path:'reviews/fixture-machine.json',sha256:fixtureDigest(evidenceDocument(q.sessionId))}}],assumptions:['Fixture only']};commits.push({id:'history-80',name:'Width 80',parent:null,phase:'work',createdAt:'2026-10-01T00:00:00Z',artifacts:[historical],sourceRevision:'1'.repeat(40),acceptanceSummary:{requirements:[{id:'bbox',category:'geometry',status:'pass',method:'bounding box'}],assumptions:['Fixture only']}});const manifest=JSON.parse(JSON.stringify(parameterManifest().manifest));manifest.output={path:historical.path,sha256:historical.sha256};manifest.parameters[0].value=80;manifests.push({path:'@commit/history-80/bracket.parameters.json',sha256:sha(Buffer.from(JSON.stringify(manifest))),manifest});}
          return result({schema:1,ok:true,result:{projectId:project,projectHead:{updatedAt:'',artifacts:advanced?[report,artifact]:[]},currentRun:run?{id:run.runId,phase:run.phase,status:run.status,updatedAt:run.updatedAt,artifacts:[artifact]}:null,commits,simulationRuns:[],parameterManifests:manifests}});
        }
        if(q.op==='model-build'&&bound){const width=q.parameters?.width?.value;if(width===66)return result({schema:1,ok:true,result:{build:{ok:false,payload:{error:'模拟参数建模失败'}}}});if(typeof width!=='number'||width<20||width>160)return send({type:'exec_result',ch:r.ch,code:1,stdout:JSON.stringify({schema:1,ok:false,error:{message:'Invalid width',code:'PARAMETER_INVALID'}}),stderr:''});modelWidth=width;files.set('bracket.step',Buffer.from(`ISO-10303-21;\nWIDTH=${width};\nEND-ISO-10303-21;`));parameterManifest();return result({schema:1,ok:true,result:{build:{ok:true}}})}
        return send({type:'exec_result',ch:r.ch,code:1,stdout:JSON.stringify({schema:1,ok:false,error:{message:'Unsupported fixture engineering operation',code:'INVALID_OPERATION'}}),stderr:''});
      }
      if(r.args.includes('/opt/reify/pi-cad/scripts/desktop-prime-config.mjs')) {
        const op=r.args.at(-1),input=JSON.parse(r.input??'{}');audit.push({type:'config',command:op});
        try {
          if(op==='catalog')return result(catalog());
          if(op==='read-models-config')return result({text:customModels});
          if(op==='write-models-config'){const parsed=JSON.parse(input.text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('models.json must contain an object.');customModels=JSON.stringify(parsed,null,2)+'\n';return result({text:customModels})}
          if(op==='set-api-key'){if(!input.key?.trim())throw Error('API key required');credentials.set(input.provider,true);return result(catalog().providers.find(p=>p.id===input.provider).auth)}
          if(op==='logout'){credentials.delete(input.provider);return result({provider:input.provider,configured:false,state:'signed-out'})}
          if(op==='save-favorites'){favorites=input.models;return result({favorites})}
          if(op==='save-default'){const choice=catalog().providers.flatMap(p=>p.models).find(m=>m.provider===input.provider&&m.id===input.modelId);if(!choice?.available||!choice.thinkingLevels.includes(input.thinkingLevel))throw Error('Unsupported or unconfigured default');defaults=input;return result(input)}
          throw Error('Unknown config command');
        } catch(error){return send({type:'exec_result',ch:r.ch,code:1,stdout:'',stderr:error.message})}
      }
      if(r.args.some(a=>a.includes('REIFY_GEOMETRY_INSPECTION'))) {
        const [root,path,expected,axis]=r.args.slice(-4),bytes=files.get(path);
        if(!bytes||sha(bytes)!==expected)return send({type:'exec_result',ch:r.ch,code:1,stdout:'',stderr:'文件已变化，请重新读取工程结果'});
        return result(axis?{source:path,sha256:expected,units:'mm',axis,position:15,totalArea:320,faceCount:1}:{source:path,sha256:expected,units:'mm',bbox:{x:80,y:40,z:30},solidCount:2});
      }
      if(r.args.some(a=>a.includes('REIFY_PARAMETER_PREVIEW'))) {
        const q=JSON.parse(r.input),width=q.values.width;if(sha(files.get(q.source))!==q.sourceSHA)return send({type:'exec_result',ch:r.ch,code:1,stdout:'',stderr:'源码已变化'});
        return result({source:'/tmp/reify-native-preview/preview.step',sha256:'b'.repeat(64),identityBound:false,identitySource:'anonymous',parts:[{name:'参数预览',positions:triangles.flat(2).map((x,i)=>i%3===0?x*width/80:x),indices:Array.from({length:triangles.length*3},(_,i)=>i)}]});
      }
      if(r.args.some(a=>a.includes('REIFY_CONVERSATIONS')))return result([...histories].filter(([,s])=>s.rows.length).map(([id,s])=>({id,path:`/workspace/projects/${project.split('/').at(-1)}/.prime-sessions/${id}.jsonl`,title:s.title,updatedAt:Date.now(),model:`${selectedModel.provider}/${selectedModel.id}`,turns:s.rows.length,toolCalls:0,tokens:10})));
      if(r.args.some(a=>a.includes('REIFY_SESSION_PATH')))return result(r.args.at(-1).split('/').at(-1));
      if(r.args.includes('/opt/reify/pi-cad/scripts/desktop-export-mesh.py')) {
        const bound=r.args.some(a=>a.includes('REIFY_BOUND_STEP')),path=bound?r.args.at(-4):r.args.at(-1),name=path.split('/').slice(4).join('/'),bytes=files.get(name);
        if(bound&&sha(bytes??Buffer.from(''))!==r.args.at(-3))return send({type:'exec_result',ch:r.ch,code:1,stdout:'',stderr:'文件已变化，请重新读取工程结果'});
        const width=Number(bytes?.toString().match(/WIDTH=(\d+)/)?.[1]??modelWidth);
        const part=(group,name,color,ts)=>({id:'solid-'+group,partId:'part-'+group,occurrenceId:'occ-'+group,solidId:'solid-'+group,semanticId:'semantic-'+group,name,color,features:[{id:'feature-'+group}],datums:[{id:'datum-'+group}],positions:ts.flat(2).map((x,i)=>i%3===0?x*width/80:x),indices:Array.from({length:ts.length*3},(_,i)=>i)});
        return result({source:path,sha256:sha(bytes??Buffer.from('')),identityBound:true,identitySource:'identity',identityManifestSha256:'a'.repeat(64),parts:[part('base','底板','#9fa69b',triangles.slice(0,12)),part('support','支撑','#789982',triangles.slice(12))],bounds:{min:[0,0,0],max:[80,40,30]}});
      }
      if(r.args.some(a=>a.includes('REIFY_LATEST_SESSION')))return result(JSON.stringify((sessions.get('/workspace/state/'+r.args.at(-1).split('/')[3])?.length??0)>0?'fixture-session.jsonl':null));
      result([...files].map(([path,bytes])=>({path,size:bytes.length})));
    }
    else if(r.type==='file_get') {
      stats.downloads++;const name=r.path.split('/').slice(4).join('/'),bytes=files.get(name);
      if(!bytes) return send({type:'error',ch:r.ch,message:'文件不存在'});
      frame(r.ch,bytes);send({type:'file_end',ch:r.ch,size:bytes.length,sha256:name==='corrupt.stl'?'0'.repeat(64):sha(bytes)});
    } else if(r.type==='file_put_begin') {upload={...r,data:Buffer.alloc(0)};}
    else if(r.type==='file_put_end') {
      if(!upload||upload.ch!==r.ch) return send({type:'error',ch:r.ch,message:'no upload'});
      if(upload.size!==upload.data.length||upload.sha256!==sha(upload.data)) return send({type:'error',ch:r.ch,message:'checksum mismatch'});
      stats.uploads++;const name=upload.path.split('/').slice(4).join('/');files.set(name,upload.data);send({type:'file_put_done',ch:r.ch,path:upload.path,size:upload.data.length,sha256:sha(upload.data)});upload=null;
    } else if(r.type==='stdin_end') {clearTimeout(timer);if(activeSpawn)spawns.delete(activeSpawn.id);setTimeout(()=>send({type:'exit',ch:r.ch,code:0,signal:null}),200);}
    else if(r.type==='kill') {if(authProcesses.has(r.ch)){authProcesses.delete(r.ch);return send({type:'exit',ch:r.ch,code:0,signal:'SIGTERM'})}stats.kills++;clearTimeout(timer);clearTimeout(activeSpawn?.timer);if(activeSpawn)spawns.delete(activeSpawn.id);send({type:'exit',ch:r.ch,code:0,signal:'SIGTERM'});}
    else if(r.type==='ping') send({type:'pong'});
  });

});
server.listen(port,'127.0.0.1',()=>console.log(`READY http://127.0.0.1:${server.address().port}`));
function shutdown(){for(const ws of [...events.clients,...bridge.clients]) ws.terminate();server.close(()=>{rmSync(fixtureHome,{recursive:true,force:true});process.exit(0)});}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
