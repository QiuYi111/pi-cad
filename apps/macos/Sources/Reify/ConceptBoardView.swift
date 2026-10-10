import SwiftUI
import ReifyCloud

struct ConceptBoardView: View {
    @EnvironmentObject var app: AppModel
    @State private var zoom = 1.0
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("概念画板 · \(app.conceptImages.count) 个方向").font(ReifyDesign.font(13, .medium))
                Spacer()
                Button("−") { zoom = max(0.5, zoom - 0.15) }.accessibilityIdentifier("concept.zoom-out")
                Text("\(Int((zoom * 100).rounded()))%")
                Button("+") { zoom = min(2.5, zoom + 0.15) }.accessibilityIdentifier("concept.zoom-in")
                Button("复位") { zoom = 1 }.accessibilityIdentifier("concept.fit")
            }.padding(12).buttonStyle(ReifyButtonStyle()).background(ReifyDesign.paper)
            if app.conceptImages.isEmpty { Text("导入或生成概念图后，在这里选择设计方向").foregroundStyle(ReifyDesign.muted).frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                ScrollView([.horizontal, .vertical]) {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(Array(app.conceptImages.enumerated()), id: \.element.id) { index, image in
                            ConceptCard(image: image, version: index + 1, zoom: zoom)
                        }
                    }.padding(20).frame(minWidth: 340, alignment: .leading)
                }
            }
        }.background(ReifyDesign.canvas).accessibilityIdentifier("concept.board")
    }
}
private struct ConceptCard: View {
    @EnvironmentObject var app: AppModel
    let image: ConceptDirection
    let version: Int
    let zoom: Double
    @State private var dragging: ConceptRegion?
    private var annotation: ConceptAnnotation { app.conceptAnnotations[image.id] ?? ConceptAnnotation() }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("V\(version) · \(image.origin == "uploaded" ? "上传" : "生成")").foregroundStyle(ReifyDesign.muted); Text(image.label).lineLimit(1); Spacer(); if annotation.outdated { Text("已过期").foregroundStyle(.red) } }
            if let source = NSImage(data: image.data) {
                let ratio = max(0.001, source.size.width / max(1, source.size.height))
                let edge = CGFloat(320 * zoom)
                let width = ratio >= 1 ? edge : edge * ratio
                let height = ratio >= 1 ? edge / ratio : edge
                Image(nsImage: source).resizable().scaledToFit().frame(width: width, height: height)
                    .overlay(alignment: .topLeading) {
                        if let region = dragging ?? annotation.region {
                            Rectangle().fill(ReifyDesign.green.opacity(0.15)).overlay { Rectangle().stroke(ReifyDesign.green, lineWidth: 2) }
                                .frame(width: width * region.width, height: height * region.height).offset(x: width * region.x, y: height * region.y)
                        }
                    }
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                        app.selectedConceptID = image.id
                        dragging = region(value, width: width, height: height)
                    }.onEnded { value in
                        let next = region(value, width: width, height: height)
                        if next.valid { var state = annotation; state.region = next; app.setConceptAnnotation(state, id: image.id) }
                        dragging = nil
                    }).accessibilityIdentifier("concept.image.\(image.id)")
            }
            TextField("设计备注", text: Binding(get: { annotation.note }, set: { value in var state = annotation; state.note = value; app.setConceptAnnotation(state, id: image.id) }), axis: .vertical)
                .lineLimit(3...6).textFieldStyle(.roundedBorder).accessibilityIdentifier("concept.note.\(image.id)")
            if let region = annotation.region { Text(region.reference).font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted).textSelection(.enabled) }
            HStack {
                Button(annotation.outdated ? "恢复" : "标记过期") { var state = annotation; state.outdated.toggle(); app.setConceptAnnotation(state, id: image.id) }.accessibilityIdentifier("concept.outdated.\(image.id)")
                if annotation.region != nil { Button("清除框选") { var state = annotation; state.region = nil; app.setConceptAnnotation(state, id: image.id) }.accessibilityIdentifier("concept.clear-region.\(image.id)") }
                Spacer()
                Button(app.conceptBusy ? "发送中…" : "按此图继续设计") { Task { await app.continueConcept(image) } }
                    .disabled(annotation.outdated || app.generating || app.conceptBusy || !app.connected || app.selected?.role == "viewer" || app.permission == "read-only")
                    .accessibilityIdentifier("concept.continue.\(image.id)")
            }.buttonStyle(ReifyButtonStyle())
            Text("图片版本：\(image.sha256.prefix(12))\(app.selectedConceptID == image.id ? " · 已选" : "")").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted).textSelection(.enabled)
        }.padding(16).frame(minWidth: 330, alignment: .leading).background(ReifyDesign.paper, in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).stroke(app.selectedConceptID == image.id ? ReifyDesign.green : ReifyDesign.line, lineWidth: 1) }
            .opacity(annotation.outdated ? 0.65 : 1).accessibilityIdentifier("concept.card.\(image.id)")
    }
    private func region(_ value: DragGesture.Value, width: CGFloat, height: CGFloat) -> ConceptRegion {
        func x(_ point: CGPoint) -> Double { min(1, max(0, point.x / max(1, width))) }
        func y(_ point: CGPoint) -> Double { min(1, max(0, point.y / max(1, height))) }
        let x0 = x(value.startLocation), y0 = y(value.startLocation), x1 = x(value.location), y1 = y(value.location)
        return ConceptRegion(x: min(x0, x1), y: min(y0, y1), width: abs(x1 - x0), height: abs(y1 - y0))
    }
}
