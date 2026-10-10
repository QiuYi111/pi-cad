import SwiftUI
import SceneKit
import ReifyCloud

struct ModelPreview: View {
    let data: Data
    @State private var scene: SCNScene? = nil
    @State private var error: String? = nil
    var body: some View {
        Group {
            if let scene { SceneView(scene: scene, options: [.allowsCameraControl, .autoenablesDefaultLighting]).overlay(alignment: .bottomLeading) { Text("拖动旋转 · 滚动缩放").font(.caption).foregroundStyle(.secondary).padding(14).allowsHitTesting(false) } }
            else if let error { Text(error).font(.callout).foregroundStyle(.secondary).padding(20) }
            else { ProgressView() }
        }.task(id: data) {
            do { scene = try ModelScene.make(data); error = nil }
            catch { scene = nil; self.error = error.localizedDescription }
        }
    }
}

private enum ModelScene {
    static func make(_ data: Data) throws -> SCNScene {
        var vertices: [SCNVector3] = []
        func float(_ at: Int) -> Float {
            Float(bitPattern: data[at..<(at + 4)].enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) })
        }
        struct Part: Decodable { let positions: [Float]; let indices: [Int] }
        struct Mesh: Decodable { let parts: [Part] }
        if data.first == 123 {
            let mesh = try JSONDecoder().decode(Mesh.self, from: data)
            for part in mesh.parts {
                guard part.positions.count % 3 == 0, part.indices.count % 3 == 0,
                      vertices.count + part.indices.count <= 3_000_000 else { throw CloudError("模型过大或数据无效") }
                for index in part.indices {
                    guard index >= 0, index < part.positions.count / 3 else { throw CloudError("模型数据无效") }
                    vertices.append(SCNVector3(part.positions[index * 3], part.positions[index * 3 + 1], part.positions[index * 3 + 2]))
                }
            }
        }
        if vertices.isEmpty, data.count >= 84 {
            let count = Int(data[80..<84].enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << ($1.offset * 8) })
            if count > 0, count <= 1_000_000, 84 + count * 50 == data.count {
                vertices.reserveCapacity(count * 3)
                for i in 0..<count {
                    for j in 0..<3 { let at = 84 + i * 50 + 12 + j * 12; vertices.append(SCNVector3(float(at), float(at + 4), float(at + 8))) }
                }
            }
        }
        if vertices.isEmpty, let text = String(data: data, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                let parts = line.split(whereSeparator: { $0.isWhitespace })
                if parts.first == "vertex", parts.count == 4, let x = Float(parts[1]), let y = Float(parts[2]), let z = Float(parts[3]) { vertices.append(SCNVector3(x, y, z)) }
                if vertices.count > 3_000_000 { throw CloudError("模型过大") }
            }
        }
        guard !vertices.isEmpty, vertices.count % 3 == 0, vertices.allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }) else { throw CloudError("无法预览此模型") }
        let indices = Array(0..<Int32(vertices.count))
        let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices)], elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
        let material = SCNMaterial(); material.diffuse.contents = ReifyDesign.nsColor(0x9fa69b)
        material.lightingModel = .physicallyBased; material.metalness.contents = 0.25; material.roughness.contents = 0.55; material.isDoubleSided = true
        geometry.materials = [material]
        let node = SCNNode(geometry: geometry)
        let (lo, hi) = node.boundingBox
        let size = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
        guard size.isFinite, size > 0 else { throw CloudError("模型尺寸无效") }
        node.position = SCNVector3(-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -(lo.z + hi.z) / 2)
        let scene = SCNScene(); scene.rootNode.addChildNode(node)
        scene.background.contents = ReifyDesign.nsColor(0xe8e6e1)
        let camera = SCNNode(); camera.camera = SCNCamera(); camera.camera?.zNear = Double(size) / 1000; camera.camera?.zFar = Double(size) * 100
        camera.position = SCNVector3(size * 1.5, size * 1.1, size * 1.8); camera.look(at: SCNVector3Zero); scene.rootNode.addChildNode(camera)
        let light = SCNNode(); light.light = SCNLight(); light.light?.type = .omni; light.light?.intensity = 1200; light.position = camera.position; scene.rootNode.addChildNode(light)
        return scene
    }
}
