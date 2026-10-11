import SwiftUI
import ReifyCloud

struct SettingsView: View {
    @EnvironmentObject var app: AppModel
    @State private var draft = SettingsDraft(provider: "", model: "", thinking: "off", reviewer: ReviewerSelection(), permission: "workspace")
    @State private var secret = ""
    @State private var code = ""
    @State private var search = ""
    @State private var custom = ""
    @State private var oldPassword = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var passwordBusy = false
    @State private var saving = false
    @State private var removeCredential = false
    private var provider: CatalogProvider? { app.catalog.providers.first { $0.id == draft.provider } }
    private var searchResults: [CatalogModel] {
        guard !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return Array(app.catalog.models.filter { "\($0.key) \($0.name)".localizedCaseInsensitiveContains(search) }.prefix(50))
    }
    var body: some View {
        ScrollViewReader { scroll in
            VStack(spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("偏好设置").foregroundStyle(ReifyDesign.muted)
                        Text("服务商与账户").font(ReifyDesign.font(26, .medium))
                    }
                    Spacer()
                    Button("关闭") { app.settingsPresented = false }.accessibilityIdentifier("model.close")
                    Button(saving ? "保存中…" : "保存设置") { Task { await save() } }
                        .buttonStyle(ReifyButtonStyle(primary: true)).disabled(saving || app.configWorking || app.generating).accessibilityIdentifier("model.save")
                }.padding(24)
                HStack(spacing: 16) {
                    ForEach([("project", "项目"), ("account", "账户与模型"), ("favorites", "收藏"), ("advanced", "自定义服务商"), ("cad-exports", "CAD 导出"), ("installation", "版本")], id: \.0) { id, title in
                        Button(title) { withAnimation { scroll.scrollTo(id, anchor: .top) } }.buttonStyle(.plain).foregroundStyle(ReifyDesign.muted)
                    }
                    Spacer()
                    if app.configWorking { ProgressView().controlSize(.small) }
                    Button("刷新") { Task { await app.loadCloudModels(readModels: false) } }.accessibilityIdentifier("settings.refresh")
                }.padding(.horizontal, 24).padding(.bottom, 18)
                if let error = app.configError { Text(error).foregroundStyle(.red).textSelection(.enabled).padding(12).accessibilityIdentifier("settings.error") }
                if !app.configNotice.isEmpty { Text(app.configNotice).foregroundStyle(ReifyDesign.green).padding(8).accessibilityIdentifier("settings.notice") }
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        card("项目", id: "project") {
                            HStack { Text(app.selected?.name ?? "尚未选择项目"); Spacer(); Button("选择云端项目") { app.settingsPresented = false; NotificationCenter.default.post(name: .reifyShowProjects, object: nil) } }
                            Picker("任务权限", selection: $draft.permission) { Text("工作区").tag("workspace"); Text("只读").tag("read-only") }.accessibilityIdentifier("settings.permission")
                            if app.selected?.role == "viewer" { Text("此项目为只读。") .foregroundStyle(ReifyDesign.muted) }
                        }
                        card("云端账户", id: "account") {
                            Text(app.user?.email ?? "未登录").accessibilityIdentifier("settings.account")
                            HStack {
                                SecureField("当前密码", text: $oldPassword).accessibilityIdentifier("account.old-password")
                                SecureField("新密码（至少 10 个字符）", text: $newPassword).accessibilityIdentifier("account.new-password")
                                SecureField("确认新密码", text: $confirmPassword).accessibilityIdentifier("account.confirm-password")
                            }
                            HStack {
                                Button(passwordBusy ? "修改中…" : "修改密码") { Task { await changePassword() } }
                                    .disabled(passwordBusy || oldPassword.isEmpty || newPassword.isEmpty || confirmPassword.isEmpty).accessibilityIdentifier("account.change-password")
                                Button("退出登录") { Task { await app.logout() } }.disabled(passwordBusy).accessibilityIdentifier("account.logout")
                            }
                        }
                        HStack(alignment: .top, spacing: 18) {
                            card("生成模型", id: "author") {
                                ModelSelectionFields(catalog: app.catalog, provider: $draft.provider, model: $draft.model, thinking: $draft.thinking, prefix: "model")
                                Button("设为云端默认") { Task { _ = await app.saveCloudDefault(draft) } }
                                    .disabled(app.configWorking || app.generating || app.reconnecting || app.catalog.model(provider: draft.provider, id: draft.model)?.available != true).accessibilityIdentifier("model.default")
                                if let provider {
                                    Text("\(provider.auth.message ?? provider.auth.state)\(provider.auth.source.map { " · " + $0 } ?? "")").foregroundStyle(ReifyDesign.muted).accessibilityIdentifier("provider.status")
                                    HStack {
                                        if provider.oauth { Button("登录服务商") { Task { await app.signInProvider(provider.id) } }.disabled(app.oauthProvider != nil).accessibilityIdentifier("provider.login") }
                                        if provider.auth.configured == true { Button("移除凭据") { removeCredential = true }.accessibilityIdentifier("provider.remove") }
                                    }
                                    if !["openai-codex", "github-copilot"].contains(provider.id) {
                                        SecureField("API 密钥", text: $secret).accessibilityIdentifier("provider.key")
                                        Button(provider.auth.configured == true ? "替换密钥" : "保存密钥") {
                                            let key = secret; let source = provider.id
                                            Task { await app.configure({ _ = try await app.configuration.setKey(provider: source, key: key) }, notice: "密钥已保存到云端"); if app.configError == nil { secret = "" } }
                                        }.disabled(secret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || app.configWorking).accessibilityIdentifier("provider.save-key")
                                    }
                                }
                            }
                            card("独立审查模型", id: "reviewer") {
                                Picker("使用方式", selection: $draft.reviewer.mode) { Text("继承生成模型").tag("inherit"); Text("单独选择模型").tag("fixed") }.accessibilityIdentifier("reviewer.mode")
                                if draft.reviewer.mode == "fixed" {
                                    ModelSelectionFields(catalog: app.catalog, provider: $draft.reviewer.provider, model: $draft.reviewer.model, thinking: $draft.reviewer.thinking, prefix: "reviewer")
                                }
                                Text("使用同一份云端模型目录和账户。更改审查模型或权限后重新连接当前项目。") .foregroundStyle(ReifyDesign.muted)
                            }
                        }
                        if app.oauthProvider != nil || !app.oauthMessage.isEmpty {
                            card("服务商登录", id: "oauth") {
                                Text(app.oauthMessage).textSelection(.enabled).accessibilityIdentifier("provider.login-status")
                                if app.oauthURL != nil { Button("打开登录页面") { app.openProviderURL() }.accessibilityIdentifier("provider.open-login") }
                                if let input = app.oauthInput {
                                    if let options = input["options"] as? [[String: Any]] {
                                        Picker("选择", selection: $code) { Text("请选择").tag(""); ForEach(options.indices, id: \.self) { i in Text(options[i]["label"] as? String ?? options[i]["name"] as? String ?? "").tag(options[i]["id"] as? String ?? "") } }
                                    } else { TextField(input["placeholder"] as? String ?? "回调地址或授权码", text: $code).accessibilityIdentifier("provider.code") }
                                    Button("继续登录") { let value = code; Task { await app.submitProviderCode(value); code = "" } }.disabled(code.isEmpty).accessibilityIdentifier("provider.submit-code")
                                }
                                if app.oauthProvider != nil { Button("取消登录") { Task { await app.cancelProviderLogin() } }.accessibilityIdentifier("provider.cancel-login") }
                            }
                        }
                        card("收藏模型", id: "favorites") {
                            TextField("搜索服务商、模型名称或 ID", text: $search).accessibilityIdentifier("favorites.search")
                            ForEach(searchResults, id: \.key) { model in
                                HStack { Text(model.name); Text(model.provider).foregroundStyle(ReifyDesign.muted); Spacer()
                                    Button(app.catalog.favorites.contains { $0.id == model.key } ? "取消收藏" : "收藏") { Task { await toggleFavorite(model) } }.accessibilityIdentifier("favorite.\(model.key)") }
                            }
                            if app.catalog.favorites.isEmpty { Text("尚未收藏模型").foregroundStyle(ReifyDesign.muted) }
                            ForEach(app.catalog.favorites.filter { $0.provider != nil && $0.modelId != nil }) { favorite in
                                HStack { Text(favorite.id); Text(favorite.thinkingLevel ?? "").foregroundStyle(ReifyDesign.muted); Spacer()
                                    Button("移除") { Task { await app.configure({ try await app.configuration.saveFavorites(app.catalog.favorites.filter { $0.id != favorite.id }) }, notice: "收藏已保存") } }.accessibilityIdentifier("favorite.remove.\(favorite.id)") }
                            }
                        }
                        card("自定义服务商", id: "advanced") {
                            Text("云端 models.json").foregroundStyle(ReifyDesign.muted)
                            TextEditor(text: $custom).font(.system(size: 12, design: .monospaced)).frame(minHeight: 200).border(ReifyDesign.line).accessibilityIdentifier("providers.config")
                            Button("校验并保存") { Task { await app.configure({ custom = try await app.configuration.writeModels(custom); app.modelsConfig = custom }, notice: "自定义服务商已保存") } }.disabled(app.configWorking).accessibilityIdentifier("providers.save")
                        }
                        card("CAD 导出", id: "cad-exports") { FusionSettingsView() }
                        card("版本", id: "installation") {
                            Text("Reify \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "开发版") · \(Bundle.main.infoDictionary?["ReifyInstallationChannel"] as? String == "dmg" ? "DMG 安装包" : "开发版")").accessibilityIdentifier("settings.installation")
                            Text("服务器：\(app.api.baseURL)").textSelection(.enabled)
                            Text(app.publishPolicy.message).font(ReifyDesign.font(12)).foregroundStyle(ReifyDesign.muted)
                        }
                    }.padding(24)
                }
            }.frame(maxWidth: 1100).frame(maxWidth: .infinity).background(ReifyDesign.canvas)
                .textFieldStyle(.roundedBorder).buttonStyle(ReifyButtonStyle())
                .task { app.refreshPublishPolicy(); draft = app.settingsDraft; await app.loadCloudModels(); custom = app.modelsConfig }
                .onChange(of: draft.provider) { _, _ in secret = "" }
                .onChange(of: draft.reviewer.mode) { _, mode in
                    if mode == "fixed" && draft.reviewer.provider.isEmpty { draft.reviewer.provider = draft.provider; draft.reviewer.model = draft.model; draft.reviewer.thinking = draft.thinking }
                }
                .confirmationDialog("移除 \(provider?.name ?? draft.provider) 的云端凭据？", isPresented: $removeCredential) {
                    Button("移除凭据", role: .destructive) { let source = draft.provider; Task { await app.configure({ try await app.configuration.removeCredential(provider: source) }, notice: "凭据已移除") } }
                }
        }
    }
    private func card<Content: View>(_ title: String, id: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) { Text(title).font(ReifyDesign.font(16, .medium)); content() }
            .frame(maxWidth: .infinity, alignment: .leading).padding(20).background(ReifyDesign.paper, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(ReifyDesign.line)).id(id)
    }
    private func save() async {
        saving = true; defer { saving = false }
        if await app.applySettings(draft) { app.settingsPresented = false }
    }
    private func changePassword() async {
        guard newPassword == confirmPassword else { app.configError = "两次输入的新密码不一致"; return }
        passwordBusy = true; app.configError = nil; defer { passwordBusy = false }
        do { try await app.api.changePassword(old: oldPassword, new: newPassword); oldPassword = ""; newPassword = ""; confirmPassword = ""; app.configNotice = "密码已修改，其他设备需要重新登录" }
        catch { app.configError = error.localizedDescription }
    }
    private func toggleFavorite(_ model: CatalogModel) async {
        var next = app.catalog.favorites
        if next.contains(where: { $0.id == model.key }) { next.removeAll { $0.id == model.key } }
        else { next.append(ModelFavorite(provider: model.provider, modelId: model.id, thinkingLevel: model.normalized(draft.thinking))) }
        await app.configure({ try await app.configuration.saveFavorites(next) }, notice: "收藏已保存")
    }
}

struct ModelSelectionFields: View {
    let catalog: ModelCatalog
    @Binding var provider: String
    @Binding var model: String
    @Binding var thinking: String
    let prefix: String
    private var source: CatalogProvider? { catalog.providers.first { $0.id == provider } }
    private var choice: CatalogModel? { catalog.model(provider: provider, id: model) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                TextField("服务商 ID", text: $provider).accessibilityIdentifier("\(prefix).provider")
                Menu("选择服务商") { ForEach(catalog.providers) { source in Button("\(source.name) · \(source.auth.configured == true ? "已连接" : "未配置")") {
                    provider = source.id; if let first = source.models.first(where: { $0.available == true }) ?? source.models.first { model = first.id; thinking = first.normalized(thinking) }
                } } }.accessibilityIdentifier("\(prefix).providers")
            }
            HStack {
                TextField("模型 ID", text: $model).accessibilityIdentifier("\(prefix).name")
                Menu("选择模型") { ForEach(source?.models ?? []) { candidate in Button("\(candidate.name)\(candidate.available == true ? "" : " · 需配置账户")\(candidate.input?.contains("image") == true ? " · 图片" : "")") {
                    model = candidate.id; thinking = candidate.normalized(thinking)
                } } }.accessibilityIdentifier("\(prefix).catalog")
            }
            Picker("思考深度", selection: $thinking) { ForEach(choice?.levels ?? [thinking], id: \.self) { level in Text(level == "off" ? "关闭" : level).tag(level) } }.accessibilityIdentifier("\(prefix).thinking")
            if let choice { Text("\(choice.name) · \(choice.available == true ? "可用" : "请配置账户")\(choice.input?.contains("image") == true ? " · 支持图片" : "")").foregroundStyle(ReifyDesign.muted).accessibilityIdentifier("\(prefix).availability") }
        }.onChange(of: model) { _, _ in normalize() }
            .onChange(of: provider) { _, _ in normalize() }
            .onChange(of: catalog) { _, _ in normalize() }
            .onAppear { normalize() }
    }
    private func normalize() { if let choice { thinking = choice.normalized(thinking) } }
}
