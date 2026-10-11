import Foundation

public struct TraceSummary: Codable, Identifiable {
    public let id: String
    public let path: String
    public let title: String
    public let updatedAt: Double
    public let model: String?
    public let turns: Int
    public let toolCalls: Int
    public let tokens: Int?
    public struct Evaluation: Codable { public let quality: Int; public let difficulty: Int; public let feedback: String? }
    public let evaluation: Evaluation?
}
public struct TraceRating: Codable {
    public let rated: Int
    public let triggered: Bool
    public let pendingTokens: Int
    public let thresholdTokens: Int
    public let message: String
}
public struct TraceDistillation: Codable {
    public var state: String
    public let processed: Int
    public let total: Int
    public let outputPath: String?
    public var message: String?
    public let candidateRoot: String?
    public let changedFiles: [String]?
    public let sourceFailureSeqs: [Int]?
    public var validationStatus: String?
    public let jobPath: String?
}
public struct TraceEntry: Identifiable {
    public let id: Int
    public let role: String
    public let text: String
    public let tool: String?
    public let timestamp: String?
    public init?(index: Int, value: JSONValue) {
        let message = value["message"] ?? value
        guard let role = message["role"]?.stringValue, ["user", "assistant", "toolResult"].contains(role) else { return nil }
        id = index; self.role = role; tool = message["toolName"]?.stringValue; timestamp = value["timestamp"]?.stringValue
        let content = message["content"]
        text = content?.stringValue ?? content?.arrayValue?.filter { $0["type"]?.stringValue == "text" }.compactMap { $0["text"]?.stringValue }.joined(separator: "\n") ?? ""
    }
}

/// Calls the existing desktop TraceStore and experience scripts in the workspace.
/// Long jobs use their own channel and never consume assistant events.
@MainActor public struct TraceService {
    public let bridge: WorkspaceBridge
    public let sessionID: String?
    public let provider: String
    public let model: String
    public let thinking: String
    public init(bridge: WorkspaceBridge, sessionID: String?, provider: String, model: String, thinking: String) {
        self.bridge = bridge; self.sessionID = sessionID; self.provider = provider; self.model = model; self.thinking = thinking
    }
    private func payload(_ operation: String, fields: [String: Any]) throws -> [String: Any] {
        guard let root = bridge.projectRoot else { throw CloudError("请先打开项目") }
        var q = fields
        q["op"] = operation; q["root"] = root; q["sessionId"] = sessionID.map { $0 as Any } ?? NSNull()
        q["provider"] = provider; q["model"] = model; q["thinking"] = thinking
        return q
    }
    private func request<T: Decodable>(_ op: String, fields: [String: Any] = [:]) async throws -> T {
        let q = try payload(op, fields: fields)
        let output = try await bridge.exec(["/opt/reify/node/bin/node", "-e", Self.script], input: String(decoding: try JSONSerialization.data(withJSONObject: q), as: UTF8.self), timeoutMs: 60000)
        guard let envelope = (try JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any], envelope["type"] as? String == "result", envelope["op"] as? String == op, envelope["root"] as? String == bridge.projectRoot else { throw CloudError("记录返回了错误项目的数据") }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: envelope["result"] ?? NSNull(), options: .fragmentsAllowed))
    }
    public func list() async throws -> [TraceSummary] { try await request("list") }
    public func read(_ path: String) async throws -> [TraceEntry] {
        let rows: [JSONValue] = try await request("read", fields: ["path": path])
        return rows.enumerated().compactMap { TraceEntry(index: $0.offset, value: $0.element) }
    }
    public func start(_ operation: String, paths: [String], quality: Int, difficulty: Int, feedback: String, jobPath: String? = nil,
                      onEvent: @escaping ([String: Any]) -> Void, onExit: @escaping (Int) -> Void) async throws -> RemoteProcess {
        guard ["rate", "distill", "validate"].contains(operation), (1...5).contains(quality), (1...5).contains(difficulty) else { throw CloudError("评分须为 1 到 5") }
        var fields: [String: Any] = ["paths": paths, "evaluation": ["quality": quality, "difficulty": difficulty, "feedback": feedback]]
        if let jobPath { fields["jobPath"] = jobPath }
        let q = try payload(operation, fields: fields)
        let encoded = try JSONSerialization.data(withJSONObject: q).base64EncodedString()
        let root = bridge.projectRoot
        return try await bridge.startProcess(["/opt/reify/node/bin/node", "-e", Self.script, encoded], onEvent: { event in
            guard event["root"] as? String == root, event["op"] as? String == operation else { onEvent(["type": "error", "message": "经验任务返回了错误项目的数据"]); return }
            onEvent(event)
        }, onExit: onExit)
    }
    private static let script = #"""
    // REIFY_DESKTOP_TRACES
    const fs=require('fs'),p=require('path'),cp=require('child_process'),children=new Set();let input='';
    const exec=(args,options={})=>new Promise((resolve,reject)=>{const child=spawn(args),out=[],err=[];let size=0;const timer=setTimeout(()=>child.kill('SIGTERM'),options.timeout||60000);child.stdout.on('data',b=>{out.push(b);size+=b.length;if(size>16*1024*1024)child.kill('SIGTERM')});child.stderr.on('data',b=>err.push(b));child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',code=>{clearTimeout(timer);const value={stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()};code===0&&size<=16*1024*1024?resolve(value):reject(Error(value.stderr||'经验命令失败'))});child.stdin.end(options.input||'')});
    const spawn=args=>{const child=cp.spawn(args[0],args.slice(1),{env:process.env});children.add(child);child.on('close',()=>children.delete(child));return child};
    process.on('SIGTERM',()=>{for(const child of children)child.kill('SIGTERM');process.exit(143)});
    async function run(q){const emit=(type,result)=>console.log(JSON.stringify({type,op:q.op,root:q.root,...result}));try{
      if(!/^\/workspace\/projects\/[a-zA-Z0-9-]+$/.test(q.root)||!['list','read','rate','distill','validate'].includes(q.op))throw Error('项目或操作无效');
      const home='/workspace/home',experience=process.env.PI_CAD_EXPERIENCE_ROOT||home+'/.cad/transcripts';process.env.PI_CAD_EXPERIENCE_ROOT=experience;
      const jiti=require('/opt/reify/pi-cad/node_modules/jiti').createJiti('/opt/reify/pi-cad/package.json'),{TraceStore}=await jiti.import('/opt/reify/pi-cad/apps/desktop/electron/main/traces.ts');
      const bridge={exec,spawn,homeDirectory:async()=>home,commandPath:async()=>'/opt/reify/node/bin/node',resolveRuntimePaths:async()=>({piCadRepo:'/opt/reify/pi-cad',primeAgentRepo:'/opt/reify/prime-agent',projectPath:q.root})},store=new TraceStore(bridge),settings={mode:'cloud',provider:q.provider,model:q.model,thinking:q.thinking};
      if(['rate','distill'].includes(q.op)&&(!Array.isArray(q.paths)||!q.paths.length||q.paths.length>500||!Number.isInteger(q.evaluation?.quality)||q.evaluation.quality<1||q.evaluation.quality>5||!Number.isInteger(q.evaluation?.difficulty)||q.evaluation.difficulty<1||q.evaluation.difficulty>5))throw Error('请选择记录，评分须为 1 到 5');
      let result;
      if(q.op==='list')result=await store.list(settings);
      if(q.op==='read')result=await store.read(settings,q.path);
      if(q.op==='rate')result=await store.rate(settings,[...new Set(q.paths)],q.evaluation);
      if(q.op==='distill')result=await store.distill(settings,[...new Set(q.paths)],q.evaluation,status=>emit('status',{status}));
      if(q.op==='validate'){
        const prefix=experience+'/distill-jobs/';if(typeof q.jobPath!=='string'||!q.jobPath.startsWith(prefix)||!q.jobPath.endsWith('.job.json')||q.jobPath.includes('/../'))throw Error('候选记录不属于经验库');
        const realRoot=fs.realpathSync(experience+'/distill-jobs'),realJob=fs.realpathSync(q.jobPath);if(!realJob.startsWith(realRoot+p.sep))throw Error('候选记录不属于经验库');
        const job=JSON.parse(fs.readFileSync(realJob,'utf8'));if(!job.candidate_root||!fs.realpathSync(job.candidate_root).startsWith(realRoot+p.sep))throw Error('候选规则不属于经验库');
        emit('status',{message:'正在重放保存的任务，核对候选规则与工程结果'});result=await store.candidateAction(settings,q.jobPath,'validate');
      }
      emit('result',{result});
    }catch(error){emit('error',{message:error.message});console.error(error.message);process.exitCode=1}}
    if(process.argv[1])run(JSON.parse(Buffer.from(process.argv[1],'base64').toString()));else{process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>run(JSON.parse(input)))}
    """#
}
