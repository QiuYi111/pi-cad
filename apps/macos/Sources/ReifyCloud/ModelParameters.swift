import Foundation

public struct ModelParameter: Codable, Identifiable {
    public let id: String
    public let type: String
    public let `default`: JSONValue
    public let value: JSONValue
    public let min: Double?
    public let max: Double?
    public let step: Double?
    public struct Option: Codable, Hashable { public let value: String; public let label: String? }
    public let options: [Option]?
    public let unit: String?
    public let label: String?
    public let description: String?
    public let group: String?
    func validate(_ value: JSONValue) throws {
        switch (type, value) {
        case ("number", .number(let number)), ("integer", .number(let number)):
            guard number.isFinite, type != "integer" || number.rounded() == number,
                  min.map({ number >= $0 }) ?? true, max.map({ number <= $0 }) ?? true else { throw CloudError("\(label ?? id)：请输入范围内的\(type == "integer" ? "整数" : "数值")") }
        case ("boolean", .bool): break
        case ("enum", .string(let selected)):
            guard options?.contains(where: { $0.value == selected }) == true else { throw CloudError("\(label ?? id)：请选择有效选项") }
        default: throw CloudError("\(label ?? id)：参数格式无效")
        }
    }
}
public struct StoredParameterManifest: Codable {
    public struct Manifest: Codable {
        public struct File: Codable { public let path: String; public let sha256: String }
        public let schema: Int
        public let modelId: String
        public let source: File
        public let output: File
        public let parameters: [ModelParameter]
    }
    public let path: String
    public let sha256: String
    public let manifest: Manifest
    public func values(_ updates: [String: JSONValue]) throws -> [String: JSONValue] {
        let declared = Set(manifest.parameters.map(\.id))
        guard declared.count == manifest.parameters.count, updates.keys.allSatisfy({ declared.contains($0) }) else { throw CloudError("参数未在模型中定义，或存在重复参数") }
        var values: [String: JSONValue] = [:]
        for parameter in manifest.parameters { let value = updates[parameter.id] ?? parameter.value; try parameter.validate(value); values[parameter.id] = value }
        return values
    }
}

extension EngineeringService {
    private func freshManifest(_ selected: StoredParameterManifest) async throws -> StoredParameterManifest {
        guard !selected.path.hasPrefix("@commit/") else { throw CloudError("历史版本请先重建为候选，再修改参数") }
        let catalog = try await self.catalog()
        guard let current = catalog.parameterManifests.first(where: { $0.path == selected.path && $0.sha256 == selected.sha256 }) else { throw CloudError("模型参数已变化，请重新读取工程结果") }
        guard current.manifest.schema == 1 else { throw CloudError("模型参数格式无效") }
        let bytes = try await bridge.download(bridge.relativeProjectPath(current.path))
        guard WorkspaceBridge.hash(bytes) == current.sha256 else { throw CloudError("模型参数文件已变化") }
        for file in [current.manifest.source, current.manifest.output] {
            let data = try await bridge.download(bridge.relativeProjectPath(file.path))
            guard WorkspaceBridge.hash(data) == file.sha256 else { throw CloudError("模型或源码已变化，请重新读取工程结果") }
        }
        return current
    }
    public func previewParameters(_ selected: StoredParameterManifest, updates: [String: JSONValue]) async throws -> Data {
        let values = try selected.values(updates)
        let current = try await freshManifest(selected)
        guard let root = bridge.projectRoot else { throw CloudError("请先打开项目") }
        let source = try bridge.relativeProjectPath(current.manifest.source.path)
        let payload: [String: Any] = ["root": root, "source": source, "sourceSHA": current.manifest.source.sha256, "values": values.mapValues(\.foundationValue)]
        let script = #"""
        // REIFY_PARAMETER_PREVIEW
        const fs=require('fs'),p=require('path'),cp=require('child_process'),crypto=require('crypto');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{let tmp;try{
          const q=JSON.parse(input),root=fs.realpathSync(q.root),source=fs.realpathSync(p.join(root,q.source));if(!source.startsWith(root+p.sep))throw Error('源码不属于当前项目');
          const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');if(hash()!==q.sourceSHA)throw Error('源码已变化');
          tmp=fs.mkdtempSync('/tmp/reify-native-preview-');const output=p.join(tmp,'preview.step');
          function run(args){const result=cp.spawnSync('/opt/reify/pi-cad/python/.venv/bin/python',['-m','cadctl',...args],{cwd:q.root,encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});let envelope;try{envelope=JSON.parse(result.stdout)}catch{throw Error(result.stderr||'参数预览格式错误')}if(result.error||result.status!==0||!envelope.ok)throw Error(envelope.payload?.error||result.stderr||result.error?.message||'参数预览失败');return envelope}
          run(['build','--source',source,'--output',output,'--parameters-json',JSON.stringify(q.values),'--force']);
          const mesh=run(['mesh','--artifact',output]);if(hash()!==q.sourceSHA)throw Error('预览时源码已变化');if(!Array.isArray(mesh.payload?.parts))throw Error('参数预览没有模型数据');console.log(JSON.stringify(mesh.payload));
        }catch(error){console.error(error.message);process.exitCode=1}finally{if(tmp)fs.rmSync(tmp,{recursive:true,force:true})}});
        """#
        let output = try await bridge.exec(["/opt/reify/node/bin/node", "-e", script], input: String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self), timeoutMs: 245000)
        let data = Data(output.utf8); _ = try MeshModel.read(data); return data
    }
    public func applyParameters(_ selected: StoredParameterManifest, updates: [String: JSONValue]) async throws {
        guard sessionID != nil else { throw CloudError("请先在当前对话开始工作流") }
        let values = try selected.values(updates), current = try await freshManifest(selected)
        var workflow: JSONValue = try await request("workflow-current")
        if workflow == .null || !["active", "ready"].contains(workflow["status"]?.stringValue ?? "") {
            workflow = try await request("workflow-start", fields: ["id": "mechanical.naked", "interactionMode": "headless"])
        }
        guard workflow["operations"]?.arrayValue?.contains(where: { $0["capability"]?.stringValue == "cad_build_step" }) == true else { throw CloudError("请先完成当前工作流阶段，再修改参数") }
        var definitions: [String: Any] = [:]
        for parameter in current.manifest.parameters {
            let data = try JSONEncoder().encode(parameter)
            var definition = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            definition.removeValue(forKey: "id"); definition["value"] = values[parameter.id]?.foundationValue
            definitions[parameter.id] = definition
        }
        let result: JSONValue = try await request("model-build", fields: ["source": current.manifest.source.path, "output": current.manifest.output.path, "force": true, "parameters": definitions], timeoutMs: 180000)
        guard result["build"]?["ok"]?.boolValue == true else { throw CloudError(result["build"]?["payload"]?["error"]?.stringValue ?? "参数应用失败，原预览已保留") }
    }
}
