import Foundation

public struct WorkflowDocument: Codable, Identifiable {
    public let id: String
    public let version: String
    public let description: String
    public let sourcePath: String?
    public let sourceHash: String?
    public let phases: [WorkflowPhase]
    public let raw: String
    public let editable: Bool
    public let adopted: Bool
    public var key: String { "\(id)@\(version)" }
}

@MainActor public struct WorkflowLibrary {
    public let bridge: WorkspaceBridge
    public init(bridge: WorkspaceBridge) { self.bridge = bridge }
    public func list() async throws -> [WorkflowDocument] { try await command("list") }
    public func save(_ source: String, original: WorkflowDocument? = nil) async throws -> WorkflowDocument {
        var fields: [String: Any] = ["raw": source]
        if let original, let path = original.sourcePath {
            fields["sourcePath"] = path; fields["sourceHash"] = original.sourceHash
        }
        return try await command("save", fields: fields)
    }
    public func delete(_ document: WorkflowDocument) async throws {
        let _: JSONValue = try await command("delete", fields: ["sourcePath": document.sourcePath ?? "", "id": document.id, "version": document.version, "sourceHash": document.sourceHash ?? ""])
    }
    public func adopt(_ document: WorkflowDocument, identity: String) async throws {
        let _: JSONValue = try await command("adopt", fields: ["id": document.id, "version": document.version, "identity": identity])
    }
    private func command<T: Decodable>(_ operation: String, fields: [String: Any] = [:]) async throws -> T {
        var payload = fields; payload["operation"] = operation
        let input = String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
        let output = try await bridge.exec(["/opt/reify/node/bin/node", "-e", Self.script], input: input, timeoutMs: 65000)
        return try JSONDecoder().decode(T.self, from: Data(output.utf8))
    }
    // Uses the installed desktop validator and the same cloud library/policy.
    // Inline code lets an existing cloud installation serve the native client.
    private static let script = #"""
    // REIFY_WORKFLOW_LIBRARY
    const fs=require('fs'),p=require('path'),crypto=require('crypto'),cp=require('child_process');
    const YAML=require('/opt/reify/pi-cad/node_modules/yaml'),base='/workspace/home/.pi-cad',root=p.join(base,'workflows'),builtin='/opt/reify/pi-cad/workflow-packages/mechanical/naked.yaml',policyPath=p.join(base,'workflow-adoptions.json');
    const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
    const atomic=(f,text)=>{const t=f+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(t,text,{mode:0o600,flag:'wx'});fs.renameSync(t,f)}finally{if(fs.existsSync(t))fs.unlinkSync(t)}};
    function policy(){if(!fs.existsSync(policyPath))return {schema:1,globalSafetyPolicyVersion:'builtin-current',adopted:{},history:[]};return JSON.parse(fs.readFileSync(policyPath,'utf8'))}
    function confined(f){const r=fs.realpathSync(root),q=fs.realpathSync(f);if(!q.startsWith(r+p.sep)||!q.endsWith('.yaml'))throw Error('只能修改用户工作流');return q}
    function read(f,editable){const raw=fs.readFileSync(f,'utf8');if(Buffer.byteLength(raw)>8*1024*1024)throw Error('工作流文件过大');const v=YAML.parse(raw),entries=Object.entries(v.workflow?.phases||{}),initial=v.workflow?.initialPhase;return {id:v.id||v.workflow?.id,version:String(v.version||v.workflow?.version||'1.0.0'),description:v.description||'',sourcePath:f,sourceHash:hash(raw),raw,editable,adopted:false,phases:entries.map(([id,s],i)=>({id,title:id.replaceAll('_',' ').replace(/\b\w/g,x=>x.toUpperCase()),purpose:s.purpose||'',status:id===initial?'active':i<entries.findIndex(([key])=>key===initial)?'complete':'pending',transitions:Object.entries(s.transitions||{}).map(([event,t])=>({event,target:t.target})),capabilities:s.actions||[],obligations:[...(s.recordObligations||[]),...(s.evidenceObligations||[])].map(x=>x.ref)}))}}
    function list(){const out=[];const r=fs.realpathSync(root);function walk(d,n=0){if(n>8)throw Error('工作流目录过深');for(const e of fs.readdirSync(d,{withFileTypes:true})){if(e.isSymbolicLink())continue;const f=p.join(d,e.name);if(e.isDirectory())walk(f,n+1);else if(e.isFile()&&e.name.endsWith('.yaml'))out.push(read(confined(f),true))}}walk(r);out.push(read(builtin,false));const a=policy().adopted;return out.map(x=>({...x,adopted:a[x.id]?.version===x.version||(!a[x.id]&&out.filter(y=>y.id===x.id).length===1)})).sort((a,b)=>a.key?.localeCompare(b.key)||a.id.localeCompare(b.id)||a.version.localeCompare(b.version))}
    let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{text+=x;if(Buffer.byteLength(text)>8*1024*1024)throw Error('工作流文件过大')});process.stdin.on('end',()=>{try{
      fs.mkdirSync(root,{recursive:true});const q=JSON.parse(text);let result;
      if(q.operation==='list')result=list();
      else if(q.operation==='save'){
        const v=YAML.parse(q.raw);if(!v?.id||!v.version||!v.workflow?.phases)throw Error('必须填写 id、version 和 workflow.phases');
        const checked=cp.spawnSync(process.execPath,['/opt/reify/pi-cad/scripts/desktop-validate-workflow.mjs'],{input:q.raw,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});if(checked.error||checked.status!==0)throw Error(checked.stderr||checked.stdout||checked.error?.message||'工作流校验失败');
        let target;if(q.sourcePath){target=confined(q.sourcePath);if(!q.sourceHash||hash(fs.readFileSync(target,'utf8'))!==q.sourceHash)throw Error('工作流已被修改，请重新读取')}
        else{if(!/^[a-z][a-z0-9_]*(?:[.:/-][a-z0-9_]+)*$/.test(v.id))throw Error('工作流 id 无效');target=p.join(fs.realpathSync(root),v.id.replace(/[/:]/g,'-')+'.yaml');if(fs.existsSync(target))throw Error('工作流已经存在')}
        atomic(target,q.raw);result=read(target,true);
      }else if(q.operation==='delete'){
        const target=confined(q.sourcePath),current=read(target,true);if(current.id!==q.id||current.version!==q.version||current.sourceHash!==q.sourceHash)throw Error('工作流已被修改，请重新读取');fs.unlinkSync(target);
        const a=policy();if(a.adopted[q.id]?.version===q.version){delete a.adopted[q.id];atomic(policyPath,JSON.stringify(a,null,2)+'\n')}result={deleted:true};
      }else if(q.operation==='adopt'){
        if(!list().some(x=>x.id===q.id&&x.version===q.version))throw Error('工作流版本不存在');const a=policy(),at=new Date().toISOString(),by=q.identity||'native-client',from=a.adopted[q.id]?.version;a.adopted[q.id]={version:q.version,adoptedBy:by,adoptedAt:at};a.history.push({id:q.id,...(from?{from}:{}),to:q.version,adoptedBy:by,adoptedAt:at});atomic(policyPath,JSON.stringify(a,null,2)+'\n');result=a;
      }else throw Error('未知工作流操作');console.log(JSON.stringify(result));
    }catch(error){console.error(error.message);process.exitCode=1}});
    """#
}
