import SwiftUI
import SceneKit
import ReifyCloud

struct ModelPreview: View {
    @EnvironmentObject var app: AppModel
    let data: Data
    @State private var model: MeshModel?
    @State private var scene: SCNScene?
    @State private var error: String?
    @State private var selected = ""
    @State private var hidden = Set<String>()
    @State private var isolated = ""
    @State private var camera = "透视"
    @State private var reset = 0
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("复位") { camera = "透视"; reset += 1 }.accessibilityIdentifier("model.reset")
                Picker("视角", selection: $camera) { ForEach(["透视", "正面", "侧面", "顶面"], id: \.self) { Text($0) } }.frame(width: 125).accessibilityIdentifier("model.camera")
                Spacer()
                Text("拖动旋转 · 滚动缩放").foregroundStyle(ReifyDesign.muted)
            }.font(ReifyDesign.font(10)).buttonStyle(ReifyButtonStyle()).padding(12).background(ReifyDesign.paper)
            if let scene, let model {
                HStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Text("装配"); Spacer(); Button("显示全部") { hidden = []; isolated = "" }.accessibilityIdentifier("assembly.show-all") }
                        ScrollView {
                            VStack(spacing: 8) {
                                ForEach(model.assembly) { item in
                                    VStack(alignment: .leading, spacing: 6) {
                                        Button { selected = item.id } label: {
                                            VStack(alignment: .leading, spacing: 3) { Text(item.name); Text("\(item.id) · \(item.count) 个实体").font(ReifyDesign.font(9)).foregroundStyle(ReifyDesign.muted) }
                                        }.buttonStyle(.plain).accessibilityIdentifier("assembly.select.\(item.id)")
                                        HStack {
                                            Button(hidden.contains(item.id) ? "显示" : "隐藏") { if hidden.contains(item.id) { hidden.remove(item.id) } else { hidden.insert(item.id) } }.accessibilityIdentifier("assembly.hide.\(item.id)")
                                            Button(isolated == item.id ? "取消单独显示" : "单独显示") { isolated = isolated == item.id ? "" : item.id }.accessibilityIdentifier("assembly.isolate.\(item.id)")
                                        }.font(ReifyDesign.font(9)).buttonStyle(.plain)
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                                        .background(selected == item.id ? ReifyDesign.panel : .clear, in: RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                        if let item = model.assembly.first(where: { $0.id == selected }) {
                            Text("已选：\(item.name)").font(ReifyDesign.font(10))
                            Button("让 Agent 修改") { app.draft += (app.draft.isEmpty ? "" : "\n") + model.reference(item); app.canvasMode = false; app.saveConversationDraft() }.buttonStyle(ReifyButtonStyle()).accessibilityIdentifier("assembly.reference")
                            Text(model.identityBound == true ? "身份已绑定" : "身份未绑定").font(ReifyDesign.font(9)).foregroundStyle(ReifyDesign.muted)
                        }
                    }.padding(12).frame(width: 210).background(ReifyDesign.paper)
                    Divider()
                    NativeSceneView(scene: scene, selected: $selected, hidden: hidden, isolated: isolated, camera: camera, reset: reset)
                }
            } else if let error { Text(error).foregroundStyle(.red).padding(20).frame(maxWidth: .infinity, maxHeight: .infinity) }
            else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }.task(id: data) {
            do {
                let mesh = try MeshModel.read(data)
                let next = try ModelScene.make(mesh)
                model = mesh; scene = next; error = nil; selected = ""; hidden = []; isolated = ""; camera = "透视"; reset += 1
            } catch { model = nil; scene = nil; self.error = error.localizedDescription }
        }
    }
}

private struct NativeSceneView: NSViewRepresentable {
    let scene: SCNScene
    @Binding var selected: String
    let hidden: Set<String>
    let isolated: String
    let camera: String
    let reset: Int
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> SCNView {
        let view = SCNView(); view.allowsCameraControl = true; view.autoenablesDefaultLighting = true; view.antialiasingMode = .multisampling4X
        view.addGestureRecognizer(NSClickGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.selectPart(_:))))
        return view
    }
    func updateNSView(_ view: SCNView, context: Context) {
        context.coordinator.parent = self
        if view.scene !== scene { view.scene = scene; view.pointOfView = scene.rootNode.childNode(withName: "camera", recursively: false); context.coordinator.camera = "" }
        scene.rootNode.childNode(withName: "model", recursively: false)?.childNodes.forEach { node in
            let id = node.name ?? ""; node.isHidden = hidden.contains(id) || (!isolated.isEmpty && isolated != id)
            node.geometry?.firstMaterial?.emission.contents = id == selected ? ReifyDesign.nsColor(0x264c39) : NSColor.black
        }
        if context.coordinator.camera != camera || context.coordinator.reset != reset {
            context.coordinator.camera = camera; context.coordinator.reset = reset
            guard let node = view.pointOfView, let bounds = scene.rootNode.childNode(withName: "model", recursively: false)?.boundingBox else { return }
            let size = max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z)
            switch camera {
            case "正面": node.position = SCNVector3(0, -size * 2.6, 0)
            case "侧面": node.position = SCNVector3(size * 2.6, 0, 0)
            case "顶面": node.position = SCNVector3(0, 0, size * 2.6)
            default: node.position = SCNVector3(size * 1.5, -size * 1.8, size * 1.1)
            }
            node.camera?.usesOrthographicProjection = camera != "透视"; node.camera?.orthographicScale = Double(size) * 0.7
            node.look(at: SCNVector3Zero, up: camera == "顶面" ? SCNVector3(0,1,0) : SCNVector3(0,0,1), localFront: SCNVector3(0,0,-1))
            view.defaultCameraController.target = SCNVector3Zero
        }
    }
    final class Coordinator: NSObject {
        var parent: NativeSceneView
        var camera = ""
        var reset = -1
        init(_ parent: NativeSceneView) { self.parent = parent }
        @objc func selectPart(_ gesture: NSClickGestureRecognizer) {
            guard let view = gesture.view as? SCNView, let hit = view.hitTest(gesture.location(in: view), options: [:]).first, let id = hit.node.name else { return }
            parent.selected = id
        }
    }
}

private enum ModelScene {
    static func make(_ mesh: MeshModel) throws -> SCNScene {
        let scene = SCNScene(), root = SCNNode(); root.name = "model"
        for (index, part) in mesh.parts.enumerated() {
            let vertices = stride(from: 0, to: part.positions.count, by: 3).map { SCNVector3(part.positions[$0], part.positions[$0 + 1], part.positions[$0 + 2]) }
            let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices)], elements: [SCNGeometryElement(indices: part.indices, primitiveType: .triangles)])
            let material = SCNMaterial()
            let hex = part.color.flatMap { UInt32($0.replacingOccurrences(of: "#", with: ""), radix: 16) } ?? 0x9fa69b
            material.diffuse.contents = ReifyDesign.nsColor(hex); material.lightingModel = .physicallyBased
            material.metalness.contents = 0.25; material.roughness.contents = 0.55; material.isDoubleSided = true; geometry.materials = [material]
            let node = SCNNode(geometry: geometry); node.name = part.groupID(index); root.addChildNode(node)
        }
        let (lo, hi) = root.boundingBox, size = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
        guard size.isFinite, size > 0 else { throw CloudError("模型尺寸无效") }
        root.position = SCNVector3(-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -(lo.z + hi.z) / 2)
        scene.rootNode.addChildNode(root); scene.background.contents = ReifyDesign.nsColor(0xe8e6e1)
        let camera = SCNNode(); camera.name = "camera"; camera.camera = SCNCamera()
        camera.camera?.zNear = Double(size) / 1000; camera.camera?.zFar = Double(size) * 100; scene.rootNode.addChildNode(camera)
        return scene
    }
}
