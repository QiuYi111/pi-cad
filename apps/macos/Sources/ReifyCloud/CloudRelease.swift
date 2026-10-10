import Foundation

public struct CloudReleaseResult: Codable {
    public let releaseId: String
    public let path: String
    public let manifestPath: String
    public let reused: Bool
    public struct File: Codable { public let path: String; public let sha256: String; public let role: String }
    public let files: [File]
}

/// Runs the original desktop release backend in the workspace. Its approval
/// callback returns to the Mac, where the unchanged approval store can observe
/// revocations while a cloud package is being prepared.
@MainActor public final class CloudReleaseJob {
    private var process: RemoteProcess?
    private var pending: CheckedContinuation<CloudReleaseResult, Error>?
    private var result: CloudReleaseResult?
    private var deadline: Task<Void, Never>?
    public init() {}
    public func run(bridge: WorkspaceBridge, sessionID: String?, approvalJSON: Data, validate: @escaping () async -> Bool) async throws -> CloudReleaseResult {
        guard pending == nil, let root = bridge.projectRoot else { throw CloudError("请先打开项目") }
        let project = (root as NSString).lastPathComponent
        let fields: [String: Any] = ["root": root, "canonical": "/workspace/state/\(project)", "sessionId": sessionID.map { $0 as Any } ?? NSNull(), "approval": try JSONSerialization.jsonObject(with: approvalJSON)]
        let input = String(decoding: try JSONSerialization.data(withJSONObject: fields), as: UTF8.self)
        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            Task { @MainActor [self] in
                do {
                    let child = try await bridge.startProcess(["env", "PI_CAD_CANONICAL_PROJECT_DIR=/workspace/state/\(project)", "/opt/reify/node/bin/node", "-e", Self.script], onEvent: { [weak self] event in
                        guard let self, self.pending != nil else { return }
                        if event["type"] as? String == "approval_check", let id = event["id"] as? String {
                            Task { @MainActor [weak self] in
                                let valid = await validate()
                                guard let self, self.pending != nil, let process = self.process else { return }
                                do { try await process.write(String(decoding: try JSONSerialization.data(withJSONObject: ["id": id, "valid": valid]), as: UTF8.self)) }
                                catch { self.finish(.failure(error)) }
                            }
                        } else if event["type"] as? String == "release_result", let value = event["result"] {
                            do { self.result = try JSONDecoder().decode(CloudReleaseResult.self, from: JSONSerialization.data(withJSONObject: value)) }
                            catch { self.finish(.failure(error)) }
                        } else if event["type"] as? String == "release_error" { self.finish(.failure(CloudError(event["message"] as? String ?? "发布失败"))) }
                    }, onExit: { [weak self] code in
                        guard let self else { return }
                        if code == 0, let result = self.result { self.finish(.success(result)) }
                        else { self.finish(.failure(CloudError(self.process?.stderr.isEmpty == false ? self.process!.stderr : "发布中断，未完成文件包"))) }
                    })
                    guard pending != nil else { await child.stop(); return }
                    process = child
                    try await child.write(input)
                    deadline = Task { @MainActor [weak self] in
                        do { try await Task.sleep(for: .seconds(300)) } catch { return }
                        guard let self, self.pending != nil else { return }
                        await self.cancel(message: "发布超时，未完成文件包")
                    }
                } catch { finish(.failure(error)) }
            }
        }
    }
    private func finish(_ outcome: Result<CloudReleaseResult, Error>) {
        guard let pending else { return }
        self.pending = nil; deadline?.cancel(); deadline = nil
        pending.resume(with: outcome)
        if case .failure = outcome { let child = process; Task { await child?.stop() } }
    }
    public func cancel(message: String = "已取消发布") async {
        finish(.failure(CloudError(message)))
        await process?.stop(); process = nil
    }
    private static let script = #"""
    // REIFY_DESKTOP_RELEASE
    const fs=require('fs'),p=require('path'),cp=require('child_process'),crypto=require('crypto'),readline=require('readline');
    const rl=readline.createInterface({input:process.stdin}),checks=new Map();let started=false;
    const emit=value=>console.log(JSON.stringify(value));
    const ask=()=>new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{checks.delete(id);reject(Error('本机批准检查超时'))},60000);checks.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)}});emit({type:'approval_check',id})});
    rl.on('line',async line=>{try{const frame=JSON.parse(line),q=JSON.parse(frame.value);if(started){checks.get(q.id)?.resolve(q.valid===true);checks.delete(q.id);return}started=true;
      if(!/^\/workspace\/projects\/[a-zA-Z0-9-]+$/.test(q.root)||q.canonical!=='/workspace/state/'+p.basename(q.root)||typeof q.sessionId!=='string')throw Error('项目或对话无效');
      const root=fs.realpathSync(q.root),env={...process.env,PI_CAD_CANONICAL_PROJECT_DIR:q.canonical};
      const destination=p.join(root,'.pi-cad','releases');fs.mkdirSync(destination,{recursive:true});if(!fs.realpathSync(destination).startsWith(root+p.sep))throw Error('发布目录不属于此项目');
      const jiti=require('/opt/reify/pi-cad/node_modules/jiti').createJiti('/opt/reify/pi-cad/package.json');const {ViewerBackend}=await jiti.import('/opt/reify/pi-cad/apps/desktop/electron/main/viewer.ts');
      const exec=(args,options={})=>new Promise((resolve,reject)=>{const child=cp.spawn(args[0],args.slice(1),{cwd:root,env}),out=[],err=[];let size=0;const timer=setTimeout(()=>child.kill('SIGTERM'),options.timeout||60000);child.stdout.on('data',bytes=>{out.push(bytes);size+=bytes.length;if(size>8*1024*1024)child.kill('SIGTERM')});child.stderr.on('data',bytes=>err.push(bytes));child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('close',code=>{clearTimeout(timer);const value={stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()};if(code===0&&size<=8*1024*1024)resolve(value);else reject(Object.assign(Error(value.stderr||'发布命令失败'),value))});child.stdin.end(options.input||'')});
      const bridge={kind:'remote',canonicalProjectDir:()=>q.canonical,exec,pipe:(args,input,timeout)=>exec(args,{input,timeout}),spawn:args=>cp.spawn(args[0],args.slice(1),{cwd:root,env}),toRuntimePath:async value=>{const path=p.resolve(root,value);if(path!==root&&!path.startsWith(root+p.sep))throw Error('文件不属于此项目');return path},commandPath:async()=>'/opt/reify/node/bin/node',resolveRuntimePaths:async()=>({piCadRepo:'/opt/reify/pi-cad',primeAgentRepo:'/opt/reify/prime-agent',projectPath:root})};
      const backend=new ViewerBackend(bridge,()=>q.sessionId);
      const validate=async()=>{const catalog=await backend.catalog({}),commit=catalog.commits.find(item=>item.id===q.approval.commitId);if(!commit||catalog.projectId!==q.approval.projectId||crypto.createHash('sha256').update(JSON.stringify(commit.artifacts)).digest('hex')!==q.approval.artifactSetHash)return false;return ask()};
      try{const result=await backend.releaseCommit({},q.approval.commitId,q.approval,destination,validate);if(!await validate())throw Error('批准已撤销，未完成下载');if(!result.path.startsWith(root+p.sep)||!result.manifestPath.startsWith(root+p.sep))throw Error('文件包不属于当前项目');emit({type:'release_result',result:{...result,path:q.root+result.path.slice(root.length),manifestPath:q.root+result.manifestPath.slice(root.length)}})}finally{backend.stop()}
      rl.close();process.stdin.destroy();
    }catch(error){emit({type:'release_error',message:error.message});process.exitCode=1;for(const check of checks.values())check.resolve(false);checks.clear();rl.close();process.stdin.destroy()}});
    """#
}
