import Foundation

public struct MeshPart: Codable {
    public let id: String?
    public let partId: String?
    public let occurrenceId: String?
    public let solidId: String?
    public let semanticId: String?
    public let name: String?
    public let color: String?
    public let features: [JSONValue]?
    public let datums: [JSONValue]?
    public let positions: [Float]
    public let indices: [Int32]
    public func groupID(_ index: Int) -> String { occurrenceId ?? partId ?? solidId ?? id ?? "anonymous-\(index)" }
}
public struct MeshModel: Decodable {
    public let source: String?
    public let sha256: String?
    public let identityManifestSha256: String?
    public let identityBound: Bool?
    public let identitySource: String?
    public let parts: [MeshPart]
    public struct AssemblyItem: Identifiable {
        public let id: String
        public let name: String
        public let semanticID: String?
        public let solidIDs: [String]
        public let count: Int
    }
    public var assembly: [AssemblyItem] {
        var order: [String] = [], grouped: [String: [MeshPart]] = [:]
        for (index, part) in parts.enumerated() { let key = part.groupID(index); if grouped[key] == nil { order.append(key) }; grouped[key, default: []].append(part) }
        return order.map { key in let values = grouped[key]!; return AssemblyItem(id: key, name: values.first?.name ?? "零件", semanticID: values.first?.semanticId, solidIDs: values.compactMap { $0.solidId ?? $0.id }, count: values.count) }
    }
    public func reference(_ item: AssemblyItem) -> String {
        "Selected model object: \(item.name); occurrenceId=\(item.id); semanticId=\(item.semanticID ?? "unknown"); solidIds=\(item.solidIDs.joined(separator: ",")); artifact=\(source ?? "unknown"); stepSha256=\(sha256 ?? "unknown"); identityManifestSha256=\(identityManifestSha256 ?? "unavailable"); identitySource=\(identitySource ?? "anonymous"); semanticIdentityBound=\(identityBound == true). Keep this exact artifact revision and object identity."
    }
    public static func read(_ data: Data) throws -> MeshModel {
        guard data.count <= 64 * 1024 * 1024 else { throw CloudError("模型过大") }
        let model: MeshModel
        if data.first(where: { ![9,10,13,32].contains($0) }) == 123 {
            model = try JSONDecoder().decode(MeshModel.self, from: data)
        } else {
            var positions: [Float] = []
            func float(_ at: Int) -> Float { Float(bitPattern: data[at..<(at + 4)].enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) }) }
            if data.count >= 84 {
                let count = Int(data[80..<84].enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) })
                if count > 0, count <= 1_000_000, 84 + count * 50 == data.count {
                    positions.reserveCapacity(count * 9)
                    for i in 0..<count { for j in 0..<3 { let at = 84 + i * 50 + 12 + j * 12; positions += [float(at), float(at + 4), float(at + 8)] } }
                }
            }
            if positions.isEmpty, let text = String(data: data, encoding: .utf8) {
                for line in text.split(separator: "\n") {
                    let values = line.split(whereSeparator: { $0.isWhitespace })
                    if values.first == "vertex", values.count == 4, let x = Float(values[1]), let y = Float(values[2]), let z = Float(values[3]) { positions += [x,y,z] }
                    guard positions.count <= 9_000_000 else { throw CloudError("模型过大") }
                }
            }
            let part = MeshPart(id: nil, partId: nil, occurrenceId: nil, solidId: nil, semanticId: nil, name: "STL 模型", color: nil, features: nil, datums: nil, positions: positions, indices: Array(0..<Int32(positions.count / 3)))
            model = MeshModel(source: nil, sha256: nil, identityManifestSha256: nil, identityBound: false, identitySource: "anonymous", parts: [part])
        }
        var triangles = 0
        guard !model.parts.isEmpty else { throw CloudError("模型没有零件") }
        for part in model.parts {
            triangles += part.indices.count / 3
            guard !part.positions.isEmpty, part.positions.count % 3 == 0, !part.indices.isEmpty, part.indices.count % 3 == 0,
                  triangles <= 1_000_000, part.positions.allSatisfy(\.isFinite), part.indices.allSatisfy({ $0 >= 0 && Int($0) < part.positions.count / 3 }) else { throw CloudError("模型过大或数据无效") }
        }
        return model
    }
}
