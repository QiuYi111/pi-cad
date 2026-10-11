import Foundation

public struct GeometryInspection: Codable {
    public let source: String
    public let sha256: String
    public let units: String
    public struct Bounds: Codable { public let x: Double; public let y: Double; public let z: Double }
    public let bbox: Bounds?
    public let solidCount: Int?
    public let axis: String?
    public let position: Double?
    public let totalArea: Double?
    public let faceCount: Int?
    public var reference: String {
        if let bbox { return "Read-only geometry check: artifact=\(source); stepSha256=\(sha256); units=\(units); bbox x=\(bbox.x), y=\(bbox.y), z=\(bbox.z); solids=\(solidCount ?? 0). Keep this exact artifact revision." }
        return "Read-only section check: artifact=\(source); stepSha256=\(sha256); axis=\(axis ?? ""); position=\(position ?? 0) mm; area=\(totalArea ?? 0) mm²; faces=\(faceCount ?? 0). Keep this exact artifact revision."
    }
}
extension WorkspaceBridge {
    public func inspectGeometry(_ path: String, expectedSHA: String, axis: String? = nil) async throws -> GeometryInspection {
        guard axis == nil || ["x", "y", "z"].contains(axis!) else { throw CloudError("截面方向无效") }
        let relative = try relativeProjectPath(path)
        guard let root = projectRoot else { throw CloudError("请先打开项目") }
        let script = #"""
        // REIFY_GEOMETRY_INSPECTION
        const fs=require('fs'),p=require('path'),c=require('crypto'),cp=require('child_process'),[root,relative,expected,axis]=process.argv.slice(1),source=fs.realpathSync(p.join(root,relative));
        if(!source.startsWith(fs.realpathSync(root)+p.sep))throw Error('文件不属于当前项目');const hash=()=>c.createHash('sha256').update(fs.readFileSync(source)).digest('hex');if(hash()!==expected)throw Error('文件已变化，请重新读取工程结果');
        const args=axis?['scan-sections','--artifact',source,'--axis',axis,'--count','3']:['inspect','--artifact',source];
        const run=cp.spawnSync('/opt/reify/pi-cad/python/.venv/bin/python',['-m','cadctl',...args],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
        let envelope;try{envelope=JSON.parse(run.stdout)}catch{throw Error(run.stderr||'工程检查格式错误')}
        if(run.error||run.status!==0||!envelope.ok)throw Error(envelope.payload?.error||run.stderr||run.error?.message||'工程检查失败');
        if(envelope.inputHashes?.artifact!==expected||hash()!==expected)throw Error('检查结果与所选模型版本不一致');
        const value=envelope.payload;if(axis){const section=value.sections?.[1]||value.sections?.[0];if(!section)throw Error('检查没有返回截面');console.log(JSON.stringify({source:relative,sha256:expected,units:'mm',axis,position:section.position,totalArea:section.totalArea,faceCount:section.faceCount}))}
        else console.log(JSON.stringify({source:relative,sha256:expected,units:value.units||'mm',bbox:value.bbox,solidCount:value.solidCount}));
        """#
        let output = try await exec(["/opt/reify/node/bin/node", "-e", script, root, relative, expectedSHA, axis ?? ""], timeoutMs: 125000)
        let result = try JSONDecoder().decode(GeometryInspection.self, from: Data(output.utf8))
        guard result.sha256 == expectedSHA, result.source == relative, result.units == "mm" else { throw CloudError("检查结果与所选模型不一致") }
        if let axis {
            guard result.axis == axis, let position = result.position, position.isFinite, let area = result.totalArea, area.isFinite, area >= 0, let faces = result.faceCount, faces >= 0 else { throw CloudError("截面数据无效") }
        } else {
            guard let bbox = result.bbox, [bbox.x, bbox.y, bbox.z].allSatisfy({ $0.isFinite && $0 >= 0 }), let solids = result.solidCount, solids >= 0 else { throw CloudError("尺寸数据无效") }
        }
        return result
    }
}
