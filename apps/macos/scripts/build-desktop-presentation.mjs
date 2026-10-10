import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../../..');
async function moduleSource(path, exports) {
  const input = await readFile(resolve(root, path), 'utf8');
  const source = stripTypeScriptTypes(input, { mode: 'transform', sourceMap: false })
    .replace(/^import[\s\S]*?;\s*/gm, '')
    .replace(/\bexport\s+(?=(?:const|let|function|class)\b)/g, '')
    .replace(/export\s*\{\s*\}\s*;/g, '');
  return `(() => {\n${source}\nreturn {${exports.join(',')}};\n})()`;
}
const activity = await moduleSource('apps/desktop/src/renderer/src/lib/activity.ts', ['reducePrimeEvent']);
const runtime = await moduleSource('apps/desktop/electron/main/runtime-state.ts', ['PrimeRuntimeState']);
const phase = await moduleSource('apps/desktop/src/renderer/src/lib/runtime-phase.ts', ['turnPhaseView']);
const source = `// Generated from the existing desktop sources. Do not edit this output.
globalThis.crypto = { randomUUID: () => nativeUUID() };
globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));
const Activity = ${activity};
const Runtime = ${runtime};
const Phase = ${phase};
let messages = [], runtime = new Runtime.PrimeRuntimeState({state:'ready',checks:[]});
globalThis.reifyReset = (sessionId, thinking) => { messages=[]; runtime=new Runtime.PrimeRuntimeState({state:'ready',checks:[]}); runtime.sessionReady(sessionId,thinking); };
globalThis.reifyReduce = event => { runtime.applyEvent(event); messages=Activity.reducePrimeEvent(messages,event); return JSON.stringify(messages); };
globalThis.reifyLoad = rows => {
  messages=[];
  for(let index=0; index<rows.length; index++) {
    const message=rows[index], id=message.id||'history-'+index;
    if(message.role==='user')messages=Activity.reducePrimeEvent(messages,{type:'desktop_user_message',id,text:typeof message.content==='string'?message.content:(message.content||[]).filter(x=>x.type==='text').map(x=>x.text||'').join('\\n')});
    else if(message.role==='assistant') {
      messages=Activity.reducePrimeEvent(messages,{type:'message_end',message:{...message,id}});
      for(const call of Array.isArray(message.content)?message.content:[])if(call.type==='toolCall')messages=Activity.reducePrimeEvent(messages,{type:'tool_execution_start',toolCallId:call.id,toolName:call.name,args:call.arguments});
    } else if(message.role==='toolResult')messages=Activity.reducePrimeEvent(messages,{type:'tool_execution_end',toolCallId:message.toolCallId,toolName:message.toolName,result:message,isError:message.isError});
    else if(message.role==='custom')messages=Activity.reducePrimeEvent(messages,{type:'message_end',message});
  }
  messages=Activity.reducePrimeEvent(messages,{type:'agent_end'});
  return JSON.stringify(messages);
};
globalThis.reifyBegin = () => runtime.beginTurn('prompt');
globalThis.reifyStopping = () => runtime.beginStopping();
globalThis.reifyCommandFailed = (command,message,timeout) => command==='prompt' ? runtime.rpcFailure(timeout?'rpc_timeout':'rpc_rejected',message) : runtime.commandFailed(command,message);
globalThis.reifyExited = () => runtime.processExited(null,'disconnected');
globalThis.reifyTurn = now => {
  if(runtime.failureDeadline!==undefined&&now>=runtime.failureDeadline)runtime.settleFailure();
  if(runtime.retryDeadline!==undefined&&now>=runtime.retryDeadline)runtime.retryDelayElapsed(runtime.status.retry?.attempt||0);
  const last=runtime.lastProviderEventAt;if(runtime.activeTurn()&&last!==undefined&&now-last>=600000)runtime.providerStall(now-last);
  const view=Phase.turnPhaseView(runtime.status,now);return JSON.stringify(view?{...view,retry:runtime.status.retry||null}:null);
};
`;
// The native JS engine has no DOM. Select the parser's entity-table variant.
const markdown = await build({ entryPoints: [resolve(import.meta.dirname, 'desktop-markdown.mjs')], bundle: true, platform: 'browser', conditions: ['react-native', 'browser'], format: 'iife', target: 'safari17', write: false, metafile: true });
await writeFile(process.argv[2], source + '\n' + markdown.outputFiles[0].text);
const packages = new Map();
for (const input of Object.keys(markdown.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(input));
  while (directory.includes('/node_modules/')) {
    try {
      const info = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (!packages.has(info.name)) {
        let license;
        for (const name of ['license', 'LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
          try { license = await readFile(join(directory, name), 'utf8'); break; } catch {}
        }
        if (!license) throw Error(`Missing license: ${info.name}`);
        packages.set(info.name, `${info.name} ${info.version}\n${license}`);
      }
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      directory = dirname(directory);
    }
  }
}
await writeFile(join(dirname(process.argv[2]), 'DesktopThirdParty.txt'), [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join('\n\n-----\n\n'));
