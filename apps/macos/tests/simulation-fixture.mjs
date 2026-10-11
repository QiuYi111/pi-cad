// Run the exact native probe and original ManagedSimulationRunner. Only the
// immutable Linux runtime commands/GPU executable boundary are synthetic.
import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
export function simulationFixture(home,repo,audit) {
 let mode='normal';
 return {
  setMode(value){mode=value},
  execute(r,project,done){
   const q=JSON.parse(r.input), selected=mode, root=join(home,'simulation',project.split('/').at(-1));mkdirSync(root,{recursive:true});
   audit.push({type:'simulation-probe',mode:selected,root:q.root});
   if(selected==='malformed')return done({code:0,stdout:'not JSON',stderr:''});
   if(selected==='forged-ready')return done({code:0,stdout:JSON.stringify({schema:1,state:'ready',detail:'claimed ready',identity:{backend:'torch-fem',runtime:'torch-fem-0.9-cu126',digest:'a'.repeat(64),accelerator:{actualDevice:'cpu'}}}),stderr:''});
   let script=r.args[r.args.indexOf('-e')+1].replaceAll('/opt/reify/pi-cad',repo);
   const setup=`const __cp=require('node:child_process'),__events=require('node:events'),__stream=require('node:stream');const __calls=[];__cp.spawn=(command,args)=>{__calls.push({command,args});const child=new __events.EventEmitter();child.stdout=new __stream.PassThrough();child.stderr=new __stream.PassThrough();let code=0,stdout='',stderr='';if(command==='test'&&${JSON.stringify(selected)}==='missing')code=1;else if(command==='env'){if(args[args.indexOf('-c')+1]!==require('node:fs').readFileSync(${JSON.stringify(repo+'/scripts/probe-torch-fem-runtime.py')},'utf8'))throw Error('Original CUDA probe was not executed');if(args.at(-1)!=='cuda'||!args.includes(${JSON.stringify('/opt/pi-cad-runtime/torch-fem-0.9-cu126/project/python/runtimes/torch-fem-cuda')}))throw Error('Wrong runtime/probe arguments');if(${JSON.stringify(selected)}==='probe-error'){code=1;stderr='CUDA sparse solve failed'}else stdout=JSON.stringify({'torch-fem':${JSON.stringify(selected==='wrong-version'?'0.8.0':'0.9.0')},torch:'2.13.0+cu126',cupy:'14.1.1',requestedDevice:'cuda',actualDevice:${JSON.stringify(selected==='cpu'?'cpu':'cuda')},cudaAvailable:true,gpu:'Synthetic GPU',sparseProbe:[0.090909,0.636364]});}else if(command==='uname')stdout='x86_64';else if(command==='bwrap')stdout='bubblewrap 0.10';else if(command==='bash')stdout='b'.repeat(64);else if(command!=='test')throw Error('Unexpected qualification command '+command);setImmediate(()=>{if(stdout)child.stdout.write(stdout);if(stderr)child.stderr.write(stderr);child.stdout.end();child.stderr.end();child.emit('close',code,null)});return child};process.on('exit',()=>console.error('QUALIFICATION_AUDIT '+JSON.stringify(__calls)));`;
   script=setup+script;const child=spawn(process.execPath,['-e',script],{cwd:repo,env:{...process.env,PI_CAD_CANONICAL_PROJECT_DIR:root}}),out=[],err=[];
   child.stdout.on('data',x=>out.push(x));child.stderr.on('data',x=>err.push(x));child.stdin.end(JSON.stringify({root}));
   child.on('close',code=>{const stderr=Buffer.concat(err).toString(),line=stderr.split('\n').find(x=>x.startsWith('QUALIFICATION_AUDIT '));if(line)audit.push({type:'simulation-qualification',mode:selected,commands:JSON.parse(line.slice(20))});const response={code,stdout:Buffer.concat(out).toString(),stderr};if(selected==='delay')setTimeout(()=>done(response),1200);else done(response)});
  }
 }
}
