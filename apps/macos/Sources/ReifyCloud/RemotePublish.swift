import Foundation

public struct RemotePublishResult: Codable {
    public let releaseId: String
    public let remote: String
    public let remoteUrl: String
    public let tag: String
    public let sourceRevision: String
    public let state: String
    public let reused: Bool
    public let packageUploaded: Bool
}

extension EngineeringService {
    public func publishTag(_ release: CloudReleaseResult, remote: String, tag: String, policy: Data, manifestSHA: String, sourceRevision: String) async throws -> RemotePublishResult {
        guard let root = bridge.projectRoot, let sessionID else { throw CloudError("请先打开已保存的对话") }
        let body: [String: Any] = ["root": root, "canonical": "/workspace/state/\((root as NSString).lastPathComponent)", "sessionId": sessionID, "release": try JSONSerialization.jsonObject(with: JSONEncoder().encode(release)),
            "remote": remote, "tag": tag, "policy": try JSONSerialization.jsonObject(with: policy), "manifestSHA": manifestSHA, "sourceRevision": sourceRevision]
        let text = try await bridge.exec(["/opt/reify/node/bin/node", "-e", Self.publishScript], input: String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self), timeoutMs: 180000)
        let result = try JSONDecoder().decode(RemotePublishResult.self, from: Data(text.utf8))
        guard result.releaseId == release.releaseId, result.remote == remote.trimmingCharacters(in: .whitespacesAndNewlines), result.tag == tag, result.sourceRevision == sourceRevision, result.state == "published", !result.packageUploaded else { throw CloudError("标签发布结果与文件包不一致") }
        return result
    }
    private static let publishScript = #"""
    // REIFY_DESKTOP_PUBLISH
    const fs=require('fs'),p=require('path'),cp=require('child_process'),crypto=require('crypto');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{let backend;try{
      const q=JSON.parse(input);if(!/^\/workspace\/projects\/[a-zA-Z0-9-]+$/.test(q.root)||q.canonical!=='/workspace/state/'+p.basename(q.root)||typeof q.sessionId!=='string')throw Error('项目或对话无效');
      const root=fs.realpathSync(q.root),env={...process.env,PI_CAD_CANONICAL_PROJECT_DIR:q.canonical};
      const translate=value=>{if(typeof value!=='string'||!value.startsWith(q.root+'/.pi-cad/releases/Reify-')||value.split('/').includes('..'))throw Error('文件包不属于当前项目');return root+value.slice(q.root.length)};
      const release={...q.release,path:translate(q.release.path),manifestPath:translate(q.release.manifestPath)};if(release.manifestPath!==release.path+'/release-manifest.json')throw Error('文件包路径无效');
      const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),manifestBytes=fs.readFileSync(release.manifestPath);if(hash(manifestBytes)!==q.manifestSHA)throw Error('云端文件包清单已变化');const manifest=JSON.parse(manifestBytes);if(manifest.releaseId!==release.releaseId||manifest.sourceRevision!==q.sourceRevision)throw Error('文件包版本已变化');
      const jiti=require('/opt/reify/pi-cad/node_modules/jiti').createJiti('/opt/reify/pi-cad/package.json');const {ViewerBackend}=await jiti.import('/opt/reify/pi-cad/apps/desktop/electron/main/viewer.ts');
      const exec=(args,options={})=>new Promise((resolve,reject)=>{if(args[0]==='cat'&&args.includes(release.manifestPath)&&hash(fs.readFileSync(release.manifestPath))!==q.manifestSHA)return reject(Error('云端文件包清单已变化'));const child=cp.spawn(args[0],args.slice(1),{cwd:root,env}),out=[],err=[];let size=0;const timer=setTimeout(()=>child.kill('SIGTERM'),options.timeout||60000);child.stdout.on('data',bytes=>{out.push(bytes);size+=bytes.length;if(size>8*1024*1024)child.kill('SIGTERM')});child.stderr.on('data',bytes=>err.push(bytes));child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('close',code=>{clearTimeout(timer);const value={stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()};if(code===0&&size<=8*1024*1024)resolve(value);else reject(Object.assign(Error(value.stderr||'标签发布失败'),value))});child.stdin.end(options.input||'')});
      const bridge={kind:'remote',canonicalProjectDir:()=>q.canonical,exec,pipe:(args,input,timeout)=>exec(args,{input,timeout}),spawn:args=>cp.spawn(args[0],args.slice(1),{cwd:root,env}),toRuntimePath:async value=>{const path=p.resolve(root,value);if(path!==root&&!path.startsWith(root+p.sep))throw Error('文件不属于此项目');return path},commandPath:async()=>'/opt/reify/node/bin/node',resolveRuntimePaths:async()=>({piCadRepo:'/opt/reify/pi-cad',primeAgentRepo:'/opt/reify/prime-agent',projectPath:root})};
      backend=new ViewerBackend(bridge,()=>q.sessionId);const catalog=await backend.catalog({});if(catalog.projectId!==manifest.projectId||!catalog.commits.some(item=>item.id===manifest.commitId&&item.sourceRevision===manifest.sourceRevision&&item.workflowHash===manifest.workflowHash))throw Error('文件包属于另一个对话或版本');
      const result=await backend.publishRemoteRelease({remotePublish:q.policy},release,q.remote,q.tag);console.log(JSON.stringify(result));
    }catch(error){console.error(error.message);process.exitCode=1}finally{backend?.stop()}});
    """#
}
