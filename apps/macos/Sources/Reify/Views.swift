import SwiftUI
import ReifyCloud

struct NewProjectView: View {
    @EnvironmentObject var app: AppModel
    @State var name = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("新建项目").font(.title2.weight(.semibold))
            TextField("项目名称", text: $name).textFieldStyle(.roundedBorder).controlSize(.large).accessibilityIdentifier("project.name").onSubmit { create() }
            if let error = app.error { Text(error).foregroundStyle(.red).font(.callout) }
            HStack { Spacer(); Button("取消") { app.newProjectPresented = false }.keyboardShortcut(.cancelAction); Button(app.busy ? "创建中" : "创建") { create() }.buttonStyle(.borderedProminent).disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 100 || app.busy).accessibilityIdentifier("project.create") }
        }.padding(28).frame(width: 380)
    }
    func create() { Task { await app.createProject(name) } }
}

struct ApprovalView: View {
    @EnvironmentObject var app: AppModel
    @State private var input = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(app.uiRequest?["title"] as? String ?? "需要你的确认").font(.title2)
            Text(app.uiRequest?["message"] as? String ?? "")
            if ["input", "editor"].contains(app.uiRequest?["method"] as? String ?? "") {
                if app.uiRequest?["method"] as? String == "editor" {
                    TextEditor(text: $input).frame(height: 180).border(ReifyDesign.line).accessibilityIdentifier("approval.input")
                } else {
                    TextField(app.uiRequest?["placeholder"] as? String ?? "填写内容", text: $input).textFieldStyle(.roundedBorder).accessibilityIdentifier("approval.input")
                }
                Button("提交") { Task { await app.answer(["value": input]) } }.buttonStyle(.borderedProminent).accessibilityIdentifier("approval.submit")
            } else if app.uiRequest?["method"] as? String == "select" {
                ForEach(app.uiRequest?["options"] as? [String] ?? [], id: \.self) { value in Button(value) { Task { await app.answer(["value": value]) } } }
            } else {
                HStack { Button("否") { Task { await app.answer(["value": false]) } }.accessibilityIdentifier("approval.no")
                    Button("确认") { Task { await app.answer(["value": true]) } }.buttonStyle(.borderedProminent).accessibilityIdentifier("approval.confirm") }
            }
            Button("取消") { Task { await app.answer(["cancelled": true]) } }.accessibilityIdentifier("approval.cancel")
        }.padding(28).frame(width: 440).onAppear { input = app.uiRequest?["prefill"] as? String ?? "" }
            .onChange(of: app.uiRequest?["id"] as? String) { _, _ in input = app.uiRequest?["prefill"] as? String ?? "" }
    }
}
