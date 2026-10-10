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

struct SettingsView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("模型设置").font(.title2.weight(.semibold))
            Form {
                TextField("服务商", text: $app.provider).accessibilityIdentifier("model.provider")
                TextField("模型", text: $app.model).accessibilityIdentifier("model.name")
                Picker("思考深度", selection: $app.thinking) { Text("最低").tag("minimal"); Text("低").tag("low"); Text("中").tag("medium"); Text("高").tag("high") }
            }.textFieldStyle(.roundedBorder)
            Text("模型账户保存在云端。保存后重新连接当前项目。") .font(.caption).foregroundStyle(.secondary)
            if !app.cloudModels.isEmpty {
                Menu("云端可用模型") {
                    ForEach(app.cloudModels) { choice in
                        Button("\(choice.provider) / \(choice.name)") { app.provider = choice.provider; app.model = choice.model }
                    }
                }.accessibilityIdentifier("model.catalog")
            }
            if !app.modelCatalogMessage.isEmpty { Text(app.modelCatalogMessage).font(.caption).foregroundStyle(.secondary) }
            HStack { Spacer(); Button("关闭") { app.settingsPresented = false }.accessibilityIdentifier("model.close"); Button("保存") { app.saveSettings() }.buttonStyle(.borderedProminent).disabled(app.provider.isEmpty || app.model.isEmpty || app.busy || app.generating).accessibilityIdentifier("model.save") }
        }.padding(28).frame(width: 420).task { await app.loadCloudModels() }
    }
}

struct ApprovalView: View {
    @EnvironmentObject var app: AppModel
    @State private var input = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(app.uiRequest?["title"] as? String ?? "需要你的确认").font(.title2)
            Text(app.uiRequest?["message"] as? String ?? "")
            if app.uiRequest?["method"] as? String == "input" {
                TextField("填写内容", text: $input).textFieldStyle(.roundedBorder)
                Button("提交") { Task { await app.answer(["value": input]) } }.buttonStyle(.borderedProminent)
            } else if app.uiRequest?["method"] as? String == "select" {
                ForEach(app.uiRequest?["options"] as? [String] ?? [], id: \.self) { value in Button(value) { Task { await app.answer(["value": value]) } } }
            } else { Button("允许") { Task { await app.answer(["confirmed": true]) } }.buttonStyle(.borderedProminent) }
            Button("取消") { Task { await app.answer(["cancelled": true, "confirmed": false]) } }
        }.padding(28).frame(width: 440)
    }
}
