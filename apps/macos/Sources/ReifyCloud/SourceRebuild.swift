import Foundation

public struct SourceRebuildResult: Codable {
    public let commitId: String
    public let sourceRevision: String
    public let source: String
    public let output: String
    public let expectedSha256: String
    public let actualSha256: String
    public let byteMatch: Bool
    public let geometryMatch: Bool?
    public let geometryDetail: String
    public struct Environment: Codable { public let python: String; public let git: String; public let platform: String }
    public let environment: Environment
    public let parameters: [String: JSONValue]
}

extension EngineeringService {
    public func rebuild(_ commit: EngineeringCommit, manifest: StoredParameterManifest) async throws -> SourceRebuildResult {
        guard let root = bridge.projectRoot, let sessionID, let revision = commit.sourceRevision, revision.range(of: "^[0-9a-f]{40,64}$", options: .regularExpression) != nil else { throw CloudError("此版本没有保存源码") }
        let body: [String: Any] = ["root": root, "canonical": "/workspace/state/\((root as NSString).lastPathComponent)", "sessionId": sessionID,
            "commit": try JSONSerialization.jsonObject(with: JSONEncoder().encode(commit)), "manifest": try JSONSerialization.jsonObject(with: JSONEncoder().encode(manifest))]
        let text = try await bridge.exec(["/opt/reify/node/bin/node", "-e", Self.rebuildScript], input: String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self), timeoutMs: 360000)
        let result = try JSONDecoder().decode(SourceRebuildResult.self, from: Data(text.utf8))
        guard result.commitId == commit.id && result.sourceRevision == revision,
              result.output == root + "/.pi-cad/rebuilds/" + commit.id + ".step",
              result.actualSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              commit.artifacts.contains(where: { $0.sha256 == result.expectedSha256 && $0.path == manifest.manifest.output.path }), result.byteMatch == (result.actualSha256 == result.expectedSha256) else { throw CloudError("重建结果与保存版本不一致") }
        // The result is useful only if its output still contains the reported bytes.
        let bytes = try await bridge.download(bridge.relativeProjectPath(result.output))
        guard WorkspaceBridge.hash(bytes) == result.actualSha256 else { throw CloudError("重建文件已变化，请重新重建") }
        return result
    }
    private static let rebuildScript = #"""
    // REIFY_DESKTOP_REBUILD
    const fs=require('fs'),p=require('path'),cp=require('child_process');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{let backend;try{
      const q=JSON.parse(input);if(!/^\/workspace\/projects\/[a-zA-Z0-9-]+$/.test(q.root)||q.canonical!=='/workspace/state/'+p.basename(q.root)||typeof q.sessionId!=='string')throw Error('项目或对话无效');
      const root=fs.realpathSync(q.root),env={...process.env,PI_CAD_CANONICAL_PROJECT_DIR:q.canonical};
      const jiti=require('/opt/reify/pi-cad/node_modules/jiti').createJiti('/opt/reify/pi-cad/package.json');const {ViewerBackend}=await jiti.import('/opt/reify/pi-cad/apps/desktop/electron/main/viewer.ts');const {canonicalDigest}=await jiti.import('/opt/reify/pi-cad/src/harness/canonical.ts');
      const exec=(args,options={})=>new Promise((resolve,reject)=>{const child=cp.spawn(args[0],args.slice(1),{cwd:root,env}),out=[],err=[];let size=0;const timer=setTimeout(()=>child.kill('SIGTERM'),options.timeout||60000);child.stdout.on('data',bytes=>{out.push(bytes);size+=bytes.length;if(size>8*1024*1024)child.kill('SIGTERM')});child.stderr.on('data',bytes=>err.push(bytes));child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('close',code=>{clearTimeout(timer);const value={stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()};if(code===0&&size<=8*1024*1024)resolve(value);else reject(Object.assign(Error(value.stderr||'重建命令失败'),value))});child.stdin.end(options.input||'')});
      const bridge={kind:'remote',canonicalProjectDir:()=>q.canonical,exec,pipe:(args,input,timeout)=>exec(args,{input,timeout}),spawn:args=>cp.spawn(args[0],args.slice(1),{cwd:root,env}),toRuntimePath:async value=>{const path=p.resolve(root,value);if(path!==root&&!path.startsWith(root+p.sep))throw Error('文件不属于此项目');return path},commandPath:async()=>'/opt/reify/node/bin/node',resolveRuntimePaths:async()=>({piCadRepo:'/opt/reify/pi-cad',primeAgentRepo:'/opt/reify/prime-agent',projectPath:root})};
      backend=new ViewerBackend(bridge,()=>q.sessionId);
      const identity=commit=>({id:commit.id,sourceRevision:commit.sourceRevision||null,workflowHash:commit.workflowHash||null,artifacts:commit.artifacts});
      const check=async()=>{const catalog=await backend.catalog({}),commit=catalog.commits.find(item=>item.id===q.commit.id),manifest=catalog.parameterManifests.find(item=>item.path===q.manifest.path);if(!commit||canonicalDigest(identity(commit))!==canonicalDigest(identity(q.commit)))throw Error('版本已变化，请重新读取工程结果');if(!manifest||canonicalDigest(manifest)!==canonicalDigest(q.manifest))throw Error('保存参数已变化，请重新读取工程结果');return catalog};
      await check();const result=await backend.rebuildCommit({},q.commit.id,q.manifest.path);await check();if(!result.output.startsWith(root+p.sep))throw Error('重建文件不属于此项目');console.log(JSON.stringify({...result,output:q.root+result.output.slice(root.length)}));
    }catch(error){console.error(error.message);process.exitCode=1}finally{backend?.stop()}});
    """#
}
