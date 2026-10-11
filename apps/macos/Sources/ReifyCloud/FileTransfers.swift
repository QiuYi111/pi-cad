import Foundation

public struct ImportedStep: Decodable {
    public let path: String
    public let sha256: String
    public let name: String
}

extension WorkspaceBridge {
    /// Run the desktop importer: hash, stage, verify, publish without overwriting.
    public func importStep(_ bytes: Data, fileName: String) async throws -> ImportedStep {
        guard ["step", "stp"].contains((fileName as NSString).pathExtension.lowercased()), !fileName.contains("/"), !fileName.contains("\\") else { throw CloudError("请选择 STEP 文件") }
        guard bytes.count <= 64 * 1024 * 1024 else { throw CloudError("文件超过 64 MB") }
        guard let root = projectRoot else { throw CloudError("请先打开项目") }
        let staged = ".reify/uploads/\(UUID().uuidString).step"
        try await upload(bytes, name: staged)
        let script = #"""
        // REIFY_STEP_IMPORT
        const fs=require('fs'),p=require('path'),cp=require('child_process'),crypto=require('crypto');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{let source;try{
          const q=JSON.parse(input),root=fs.realpathSync(q.root);source=fs.realpathSync(p.join(root,q.staged));if(!source.startsWith(root+p.sep))throw Error('文件不属于当前项目');
          const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');if(hash(source)!==q.sha256)throw Error('上传文件已变化');
          const jiti=require('/opt/reify/pi-cad/node_modules/jiti').createJiti('/opt/reify/pi-cad/package.json');
          const {safeUploadName}=await jiti.import('/opt/reify/pi-cad/apps/desktop/electron/main/cloud-uploads.ts');
          const {importStepIntoProject}=await jiti.import('/opt/reify/pi-cad/apps/desktop/electron/main/step-import.ts');
          const runtime={exec:async(args,options={})=>{const r=cp.spawnSync(args[0],args.slice(1),{cwd:root,encoding:'utf8',timeout:options.timeout??120000});if(r.error||r.status!==0)throw Error(r.stderr||r.error?.message||'导入失败');return {stdout:r.stdout,stderr:r.stderr}}};
          const relative=await importStepIntoProject(runtime,{source,fileName:safeUploadName(q.fileName),projectPath:root});if(hash(p.join(root,relative))!==q.sha256)throw Error('导入文件校验失败');
          console.log(JSON.stringify({path:relative,sha256:q.sha256,name:p.basename(relative)}));
        }catch(error){console.error(error.message);process.exitCode=1}finally{if(source)fs.rmSync(source,{force:true})}});
        """#
        let payload: [String: Any] = ["root": root, "staged": staged, "fileName": fileName, "sha256": Self.hash(bytes)]
        let output = try await exec(["/opt/reify/node/bin/node", "-e", script], input: String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self), timeoutMs: 150000)
        let result = try JSONDecoder().decode(ImportedStep.self, from: Data(output.utf8))
        guard result.sha256 == Self.hash(bytes), result.path.hasPrefix("imports/"), try relativeProjectPath(result.path) == result.path else { throw CloudError("导入结果校验失败") }
        guard Self.hash(try await download(result.path)) == result.sha256 else { throw CloudError("导入文件已变化") }
        return result
    }
}
