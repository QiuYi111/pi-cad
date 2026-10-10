// A disposable cloud protocol server. No production credentials or model calls.
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
const sha = data => createHash('sha256').update(data).digest('hex');
const port = Number(process.env.REIFY_FIXTURE_PORT ?? 18765);
const projects = [{id: '11111111-1111-4111-8111-111111111111', name: '桌面支架', role: 'maintainer', createdAt: new Date().toISOString()}];
let state = 'stopped', accesses = new Set(), refreshes = new Set();
const stats = {login: 0, rejectedLogin: 0, refresh: 0, projects: 0, start: 0, stop: 0, spawn: 0, prompt: 0, abort: 0, uploads: 0, downloads: 0, kills: 0, attaches: 0};
const audit = [];
function box(x,y,z,w,d,h) {
  const v=[[x,y,z],[x+w,y,z],[x+w,y+d,z],[x,y+d,z],[x,y,z+h],[x+w,y,z+h],[x+w,y+d,z+h],[x,y+d,z+h]];
  return [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]].map(t=>t.map(i=>v[i]));
}
const triangles=[...box(0,0,0,80,40,4),...box(0,0,4,80,4,26)];
const stl=Buffer.alloc(84+triangles.length*50);stl.writeUInt32LE(triangles.length,80);
triangles.forEach((t,i)=>t.flat().forEach((value,j)=>stl.writeFloatLE(value,84+i*50+12+j*4)));

const files = new Map([['bracket.stl', stl], ['bracket.step', Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;')], ['corrupt.stl', stl]]);
const sessions = new Map();
const spawns = new Map();
const user = {id: 'e2e-user', email: 'e2e@reify.test', displayName: '测试账户'};
const view = () => ({name: 'ws-e2e', state, desired: state === 'stopped' ? 'stopped' : 'running', lastError: null, queuePosition: null, reclaimAt: null});
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
  if (path === '/__test/stats') return respond(res,200,{stats,audit,state});
  if (path === '/__test/drop') { for(const ws of bridge.clients) ws.close(1012,'fixture restart'); return respond(res,200,{ok:true}); }
  if (path === '/__test/idle') { broadcast({type:'idle_warning',reclaimAt:new Date(Date.now()+60000).toISOString()}); return respond(res,200,{ok:true}); }
  if (path === '/v1/auth/login') {
    if(b.email !== user.email || b.password !== 'fixture-password') { stats.rejectedLogin++; return respond(res,401,{code:'invalid_credentials',message:'邮箱或密码错误'}); }
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
  if (path === '/v1/workspace/start') {
    stats.start++; state='starting'; setTimeout(()=>{state='running';broadcast({type:'workspace_state',state});},150); return respond(res,200,view());
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
    const bytes=Buffer.from(JSON.stringify(row)+'\n');
    if(activeSpawn) {activeSpawn.replay.push(bytes);const target=activeSpawn.socket;const h=Buffer.alloc(4);h.writeUInt32BE(1);if(target.readyState===WebSocket.OPEN){const split=Math.max(1,bytes.indexOf(Buffer.from('支架'))+1);target.send(Buffer.concat([h,bytes.subarray(0,split)]));target.send(Buffer.concat([h,bytes.subarray(split)]));}}
    else frame(1,bytes);
  };
  const reply = (r,data={}) => output({type:'response',id:r.id,command:r.type,success:true,data});
  ws.on('message',(data,binary)=>{
    if(binary) {
      const ch=data.readUInt32BE(0), bytes=data.subarray(4);
      if(upload?.ch===ch) { upload.data=Buffer.concat([upload.data,bytes]); return; }
      if(ch!==1) return;
      stdin=Buffer.concat([stdin,bytes]);
      for(let at; (at=stdin.indexOf(10))>=0;) {
        const r=JSON.parse(stdin.subarray(0,at).toString());stdin=stdin.subarray(at+1);
        if(r.type==='get_state') reply(r,{sessionId:'fixture-session',thinkingLevel:'minimal',isStreaming:!!timer});
        else if(r.type==='get_messages') reply(r,{messages:rows});
        else if(r.type==='new_session') { rows=[];sessions.set(project,rows);if(activeSpawn)activeSpawn.rows=rows;reply(r); }
        else if(r.type==='prompt') {
          stats.prompt++;rows.push({role:'user',content:r.message});reply(r);output({type:'agent_start'});
          if(r.message==='模拟模型错误') {
            const message={role:'assistant',content:[],stopReason:'error',errorMessage:'测试模型服务不可用'};
            rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});continue;
          }
          output({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'正在创建支架…'}});
          timer=setTimeout(()=>{const message={role:'assistant',content:[{type:'text',text:'支架已完成。尺寸 80 × 40 × 30 mm，已生成 STL 和 STEP 文件。'}]};rows.push(message);output({type:'message_end',message});output({type:'agent_end',messages:rows});timer=null;},r.message.includes('长任务') ? 30000 : 450);
        } else if(r.type==='abort') {stats.abort++;clearTimeout(timer);timer=null;reply(r);output({type:'agent_end',messages:rows});}
        else if(r.type==='extension_ui_response') {}
        else output({type:'response',id:r.id,success:false,error:'unsupported fixture RPC'});
      }
      return;
    }
    const r=JSON.parse(data.toString());
    if(r.type==='spawn') {
      stats.spawn++; audit.push({type:'spawn',args:r.args,env:r.env});
      if(!r.args.includes('/opt/reify/pi-cad/scripts/prime-cad-sidecar.mjs') || !r.args.includes('--reviewer-inherit-author') || r.env?.PI_CAD_CANONICAL_PROJECT_DIR?.startsWith('/workspace/state/')!==true) return send({type:'error',ch:r.ch,message:'wrong cloud runtime command'});
      project=r.env.PI_CAD_CANONICAL_PROJECT_DIR;rows=sessions.get(project)??[];if(rows.length&&!r.args.includes('/workspace/.prime-sessions/fixture-session.jsonl'))return send({type:'error',ch:r.ch,message:'missing session resume'});sessions.set(project,rows);send({type:'spawned',ch:r.ch,spawnId:(activeSpawn={id:randomUUID(),project,rows,replay:[],socket:ws}).id,pid:123});
          spawns.set(activeSpawn.id,activeSpawn);
    } else if(r.type==='attach') {
      const old=spawns.get(r.spawnId);if(!old)return send({type:'error',ch:r.ch,code:'no_such_spawn',message:'没有这个进程'});
      stats.attaches++;activeSpawn=old;activeSpawn.socket=ws;project=old.project;rows=old.rows;
      for(const bytes of old.replay)frame(r.ch,bytes);
    } else if(r.type==='exec') { if(r.args.includes('/opt/reify/pi-cad/scripts/desktop-export-mesh.py')) return send({type:'exec_result',ch:r.ch,code:0,stderr:'',stdout:JSON.stringify({parts:[{positions:triangles.flat(2),indices:Array.from({length:triangles.length*3},(_,i)=>i)}]})}); if(r.args.some(a=>a.includes('REIFY_LATEST_SESSION'))) return send({type:'exec_result',ch:r.ch,code:0,stderr:'',stdout:JSON.stringify((sessions.get('/workspace/state/'+r.args.at(-1).split('/')[3])?.length??0)>0?'fixture-session.jsonl':null)}); send({type:'exec_result',ch:r.ch,code:0,stderr:'',stdout:JSON.stringify([...files].map(([path,bytes])=>({path,size:bytes.length})))}); }
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
    else if(r.type==='kill') {stats.kills++;clearTimeout(timer);if(activeSpawn)spawns.delete(activeSpawn.id);send({type:'exit',ch:r.ch,code:0,signal:'SIGTERM'});}
    else if(r.type==='ping') send({type:'pong'});
  });

});
server.listen(port,'127.0.0.1',()=>console.log(`READY http://127.0.0.1:${server.address().port}`));
function shutdown(){for(const ws of [...events.clients,...bridge.clients]) ws.terminate();server.close(()=>process.exit(0));}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
