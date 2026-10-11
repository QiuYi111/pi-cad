import SwiftUI
import ReifyCloud

struct ParameterPanel: View {
    @EnvironmentObject var app: AppModel
    let manifest: StoredParameterManifest
    @State private var values: [String: JSONValue] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("模型参数").font(ReifyDesign.font(14, .medium))
            if app.parameterPreviewActive { Text("临时预览，尚未保存").foregroundStyle(ReifyDesign.green) }
            ForEach(manifest.manifest.parameters) { parameter in
                VStack(alignment: .leading, spacing: 6) {
                    HStack { Text(parameter.label ?? parameter.id); Spacer(); if let unit = parameter.unit { Text(unit).foregroundStyle(ReifyDesign.muted) } }
                    field(parameter)
                    if let description = parameter.description { Text(description).font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted) }
                }
            }
            if let error = app.parameterError {
                Text(error).foregroundStyle(.red).textSelection(.enabled)
                Button("让 Agent 修复") { app.draft = "请检查参数应用失败，保留原模型。\n模型：\(manifest.manifest.output.path)\n版本：\(manifest.manifest.output.sha256)\n错误：\(error)"; app.canvasMode = false; app.saveConversationDraft() }.accessibilityIdentifier("parameters.ask-repair")
            }
            HStack {
                Button(app.parameterBusy ? "处理中…" : "预览") { Task { await app.previewParameters(manifest, values: values) } }.accessibilityIdentifier("parameters.preview")
                Button("应用") { Task { await app.applyParameters(manifest, values: values) } }.disabled(app.selected?.role == "viewer" || app.permission == "read-only").accessibilityIdentifier("parameters.apply")
            }.buttonStyle(ReifyButtonStyle()).disabled(app.parameterBusy || app.generating)
            Button("恢复已保存参数") { reset(); app.restoreParameterPreview(); app.parameterError = nil }.disabled(app.parameterBusy).accessibilityIdentifier("parameters.restore")
            if app.generating { Text("先停止当前任务，再预览或应用参数").foregroundStyle(ReifyDesign.muted) }
        }.font(ReifyDesign.font(11)).onAppear { reset() }.onChange(of: manifest.sha256) { _, _ in reset() }
    }
    @ViewBuilder private func field(_ parameter: ModelParameter) -> some View {
        if parameter.type == "boolean" {
            Toggle(parameter.label ?? parameter.id, isOn: Binding(get: { values[parameter.id]?.boolValue ?? parameter.value.boolValue ?? false }, set: { values[parameter.id] = .bool($0) })).labelsHidden().accessibilityIdentifier("parameter.\(parameter.id)")
        } else if parameter.type == "enum" {
            Picker(parameter.label ?? parameter.id, selection: Binding(get: { values[parameter.id]?.stringValue ?? parameter.value.stringValue ?? "" }, set: { values[parameter.id] = .string($0) })) {
                ForEach(parameter.options ?? [], id: \.value) { Text($0.label ?? $0.value).tag($0.value) }
            }.labelsHidden().accessibilityIdentifier("parameter.\(parameter.id)")
        } else {
            TextField(parameter.label ?? parameter.id, text: Binding(get: { text(values[parameter.id] ?? parameter.value) }, set: { values[parameter.id] = Double($0).map(JSONValue.number) ?? .string($0) })).textFieldStyle(.roundedBorder).accessibilityIdentifier("parameter.\(parameter.id)")
            if let min = parameter.min, let max = parameter.max, min.isFinite, max.isFinite, min < max {
                Slider(value: Binding(get: { if case .number(let value) = values[parameter.id] ?? parameter.value { return value }; return min }, set: { values[parameter.id] = .number(parameter.type == "integer" ? $0.rounded() : $0) }), in: min...max, step: parameter.step.flatMap { $0 > 0 && $0.isFinite ? $0 : nil } ?? (parameter.type == "integer" ? 1 : 0.1))
                Text("\(text(.number(min))) – \(text(.number(max)))").font(ReifyDesign.font(9)).foregroundStyle(ReifyDesign.muted)
            }
        }
    }
    private func text(_ value: JSONValue) -> String {
        switch value { case .number(let number): return number.rounded() == number ? String(format: "%.0f", number) : String(number); case .string(let text): return text; default: return "" }
    }
    private func reset() { values = manifest.manifest.parameters.reduce(into: [:]) { $0[$1.id] = $1.value } }
}
