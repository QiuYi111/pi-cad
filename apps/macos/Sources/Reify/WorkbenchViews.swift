import SwiftUI
import ReifyCloud

struct RootView: View {
    @EnvironmentObject var app: AppModel
    @State private var projectsPage = false
    var body: some View {
        VStack(spacing: 0) {
            if app.user == nil { LoginView() }
            else {
                AppHeader(projectsPage: $projectsPage)
                if let error = app.error { NoticeView(text: error, error: true) { app.error = nil } }
                if app.reclaimAt != nil {
                    HStack { Label("云端即将因闲置暂停", systemImage: "clock"); Spacer(); Button("继续使用") { Task { await app.keepalive() } } }
                        .padding(12).background(ReifyDesign.panel)
                }
                if projectsPage || app.selected == nil { ProjectsView(onOpen: { projectsPage = false }) }
                else { WorkbenchView() }
            }
        }
        .font(ReifyDesign.font(12)).foregroundStyle(ReifyDesign.ink).tint(ReifyDesign.green)
        .background(ReifyDesign.paper).preferredColorScheme(.light)
        .onReceive(NotificationCenter.default.publisher(for: .reifyShowProjects)) { _ in projectsPage = true }
        .onChange(of: app.connected) { _, connected in if connected { projectsPage = false } }
        .sheet(isPresented: $app.newProjectPresented) { NewProjectView() }
        .sheet(isPresented: $app.settingsPresented) { SettingsView() }
        .sheet(isPresented: Binding(get: { app.uiRequest != nil }, set: { if !$0 { Task { await app.answer(["cancelled": true]) } } })) { ApprovalView() }
    }
}

struct AppHeader: View {
    @EnvironmentObject var app: AppModel
    @Binding var projectsPage: Bool
    var body: some View {
        HStack {
            ReifyWordmark().frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 4) {
                nav("工作台", active: !projectsPage && app.selected != nil, id: "nav.workbench") { projectsPage = false }
                nav("项目", active: projectsPage || app.selected == nil, id: "nav.projects") { projectsPage = true }
                nav("设置", active: false, id: "nav.settings") { app.settingsPresented = true }
            }
            HStack {
                Spacer()
                Button(app.selected?.name ?? "选择云端项目") { projectsPage = true }
                    .buttonStyle(.plain).foregroundStyle(ReifyDesign.muted).lineLimit(1)
                Menu {
                    Text(app.user?.email ?? "")
                    Button("暂停云端") { Task { await app.stopWorkspace() } }.disabled(app.selected == nil || app.busy)
                    Button("退出登录") { Task { await app.logout() } }
                } label: { Image(systemName: "person.crop.circle") }
                .menuStyle(.borderlessButton).frame(width: 24).accessibilityIdentifier("account.menu")
            }.frame(maxWidth: .infinity)
        }.padding(.leading, 80).padding(.trailing, 18).frame(height: 58)
            .background(ReifyDesign.paper).overlay(alignment: .bottom) { Divider() }
    }
    private func nav(_ title: String, active: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action).buttonStyle(.plain).padding(.horizontal, 15).padding(.vertical, 8)
            .background(active ? ReifyDesign.darkGreen : .clear, in: Capsule())
            .foregroundStyle(active ? .white : ReifyDesign.muted).accessibilityIdentifier(id)
    }
}

struct LoginView: View {
    @EnvironmentObject var app: AppModel
    @State private var email = ""
    @State private var password = ""
    @State private var server = ""
    @State private var showServer = false
    @State private var forgot = false
    var body: some View {
        VStack(spacing: 0) {
            HStack { ReifyWordmark(); Spacer(); Text("Reify 云端").foregroundStyle(ReifyDesign.muted) }
                .padding(.leading, 80).padding(.trailing, 18).frame(height: 58).overlay(alignment: .bottom) { Divider() }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("登录 Reify 云端").font(ReifyDesign.font(24, .medium))
                    Text("使用管理员为你开通的账户登录。工程文件保存在你的云端工作区。")
                        .foregroundStyle(ReifyDesign.muted).lineSpacing(4)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("邮箱").foregroundStyle(ReifyDesign.muted)
                        TextField("邮箱", text: $email).textContentType(.username).accessibilityIdentifier("login.email")
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("密码").foregroundStyle(ReifyDesign.muted)
                        SecureField("密码", text: $password).textContentType(.password).onSubmit(signIn).accessibilityIdentifier("login.password")
                    }
                    if let error = app.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("error") }
                    HStack(spacing: 18) {
                        Button(action: signIn) { HStack { Text(app.busy ? "正在登录…" : "登录"); Image(systemName: "chevron.right") } }
                            .buttonStyle(ReifyButtonStyle(primary: true)).disabled(app.busy || email.isEmpty || password.isEmpty).accessibilityIdentifier("login.submit")
                        Button(showServer ? "收起高级设置" : "高级设置") { showServer.toggle() }
                            .buttonStyle(.plain).foregroundStyle(ReifyDesign.muted).accessibilityIdentifier("login.advanced")
                    }
                    if showServer {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("服务器地址").foregroundStyle(ReifyDesign.muted)
                            TextField("HTTPS 地址", text: $server).accessibilityIdentifier("login.server")
                        }
                    }
                    Button("忘记密码？") { forgot.toggle() }.buttonStyle(.plain).foregroundStyle(ReifyDesign.muted)
                    if forgot { Text("请联系管理员获取重置链接。").foregroundStyle(ReifyDesign.muted) }
                }.textFieldStyle(.roundedBorder).controlSize(.large).frame(width: 400).padding(.top, 56).padding(.bottom, 32)
                    .disabled(app.busy)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }.onAppear { server = app.api.baseURL }
    }
    private func signIn() { Task { await app.login(email: email, password: password, server: server); password = "" } }
}

struct ProjectsView: View {
    @EnvironmentObject var app: AppModel
    let onOpen: () -> Void
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("云端项目").font(ReifyDesign.font(26, .medium))
                        Text("打开项目，继续设计。").foregroundStyle(ReifyDesign.muted)
                    }
                    Spacer()
                    Button { Task { await app.refreshProjects() } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.plain)
                    Button("新建项目") { app.newProjectPresented = true }.buttonStyle(ReifyButtonStyle(primary: true)).accessibilityIdentifier("project.new")
                }
                ForEach(app.projects) { project in
                    HStack(spacing: 14) {
                        Image(systemName: "folder").foregroundStyle(ReifyDesign.green)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.name).font(ReifyDesign.font(14, .medium))
                            Text(project.role == "viewer" ? "只读" : "可编辑").foregroundStyle(ReifyDesign.muted)
                        }
                        Spacer()
                        Button(app.selected?.id == project.id && app.connected ? "继续" : "打开") {
                            Task { await app.open(project); if app.connected { onOpen() } }
                        }.buttonStyle(ReifyButtonStyle()).disabled(app.busy || app.generating).accessibilityIdentifier("project.\(project.id)")
                    }.padding(16).background(ReifyDesign.paper, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(ReifyDesign.line))
                }
                if app.busy { HStack { ProgressView().controlSize(.small); Text(app.status) } }
            }.frame(maxWidth: 760).padding(32).frame(maxWidth: .infinity)
        }.background(ReifyDesign.canvas)
    }
}

struct WorkbenchView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { geometry in
                ZStack {
                    CanvasView().opacity(app.canvasMode ? 1 : 0).allowsHitTesting(app.canvasMode).accessibilityHidden(!app.canvasMode)
                    HStack(spacing: 0) {
                        if app.sidebarOpen { ConversationSidebar().frame(width: max(210, min(252, geometry.size.width * 0.19))) }
                        ConversationView()
                    }.background(ReifyDesign.paper.opacity(0.97)).opacity(app.canvasMode ? 0 : 1)
                        .allowsHitTesting(!app.canvasMode).accessibilityHidden(app.canvasMode)
                    ComposerView(size: geometry.size)
                    if app.filesOpen {
                        FilesView().frame(width: 280).frame(maxHeight: .infinity)
                            .background(ReifyDesign.paper).overlay(alignment: .leading) { Divider() }
                            .frame(maxWidth: .infinity, alignment: .trailing).transition(.move(edge: .trailing))
                    }
                }
            }
            StatusBarView()
        }.background(ReifyDesign.canvas)
            .onChange(of: app.draft) { _, _ in app.saveLayout() }
            .onChange(of: app.canvasMode) { _, _ in app.saveLayout() }
            .onChange(of: app.sidebarOpen) { _, _ in app.saveLayout() }
    }
}

struct ConversationSidebar: View {
    @EnvironmentObject var app: AppModel
    @State private var query = ""
    private var title: String { app.messages.first(where: { $0.role == "user" })?.text ?? "新对话" }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Button { Task { await app.newConversation() } } label: { Label("新对话", systemImage: "plus").frame(maxWidth: .infinity, alignment: .leading) }
                    .buttonStyle(ReifyButtonStyle()).disabled(!app.connected || app.generating).accessibilityIdentifier("chat.new")
                Button { app.sidebarOpen = false } label: { Image(systemName: "sidebar.left") }
                    .buttonStyle(.plain).accessibilityIdentifier("sidebar.collapse").help("收起侧栏")
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("项目").foregroundStyle(ReifyDesign.muted)
                HStack { Image(systemName: "folder"); Text(app.selected?.name ?? "").lineLimit(1); Spacer() }
                HStack {
                    Button("打开项目") { NotificationCenter.default.post(name: .reifyShowProjects, object: nil) }
                    Button("新建项目") { app.newProjectPresented = true }.accessibilityIdentifier("project.new")
                }.buttonStyle(ReifyButtonStyle()).font(ReifyDesign.font(10))
                ForEach(app.projects.filter { $0.id != app.selected?.id }.prefix(6)) { project in
                    Button(project.name) { Task { await app.open(project) } }.buttonStyle(.plain)
                        .disabled(app.busy || app.generating).accessibilityIdentifier("project.\(project.id)")
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("对话").foregroundStyle(ReifyDesign.muted)
                TextField("搜索对话", text: $query).textFieldStyle(.roundedBorder).accessibilityIdentifier("chat.search")
                if query.isEmpty || title.localizedCaseInsensitiveContains(query) {
                    Button { app.canvasMode = false } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(title).lineLimit(2)
                            Text("当前对话").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                            .background(ReifyDesign.line.opacity(0.4), in: RoundedRectangle(cornerRadius: 9))
                    }.buttonStyle(.plain)
                } else { Text("没有匹配的对话。").foregroundStyle(ReifyDesign.muted) }
            }
            Spacer()
            Button("设置") { app.settingsPresented = true }.buttonStyle(.plain).foregroundStyle(ReifyDesign.muted)
        }.padding(14).frame(maxHeight: .infinity).background(ReifyDesign.panel)
            .overlay(alignment: .trailing) { Divider() }
    }
}

extension Notification.Name { static let reifyShowProjects = Notification.Name("ReifyShowProjects") }

struct ConversationView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                if !app.sidebarOpen { Button { app.sidebarOpen = true } label: { Image(systemName: "sidebar.left") }.accessibilityIdentifier("sidebar.expand") }
                VStack(alignment: .leading, spacing: 3) {
                    Text("Design agent").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
                    Text(app.selected?.name ?? "").font(ReifyDesign.font(13, .medium))
                }
                Spacer()
                Button { app.filesOpen.toggle() } label: { Label("项目文件", systemImage: "folder") }.accessibilityIdentifier("file.toggle")
                Button { Task { await app.upload() } } label: { Label("导入文件", systemImage: "plus") }
                    .disabled(!app.connected || app.selected?.role == "viewer").accessibilityIdentifier("file.import")
            }.buttonStyle(.plain).padding(.horizontal, 24).frame(height: 58).overlay(alignment: .bottom) { Divider() }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 26) {
                        if app.messages.isEmpty {
                            VStack(alignment: .leading, spacing: 14) {
                                ReifyMark(size: 32)
                                Text("你想做什么？").font(ReifyDesign.font(24, .medium))
                                Text("描述形状、尺寸和用途。").foregroundStyle(ReifyDesign.muted)
                            }.padding(.top, 45)
                        }
                        ForEach(app.messages) { message in
                            MessageView(message: message).id(message.id)
                        }
                        if app.generating { HStack { ProgressView().controlSize(.mini); Text(app.activity ?? "正在思考").foregroundStyle(ReifyDesign.muted) } }
                        Color.clear.frame(height: 1).id("bottom")
                    }.frame(maxWidth: 744).padding(.horizontal, 24).padding(.top, 28).padding(.bottom, 220).frame(maxWidth: .infinity)
                }.onChange(of: app.messages.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                 .onChange(of: app.generating) { _, running in if !running { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
        }
    }
}

private struct MessageView: View {
    let message: ChatMessage
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if message.role != "user" { ReifyMark(size: 18).padding(.top, 3) }
            VStack(alignment: .leading, spacing: 8) {
                Text(message.role == "user" ? "你" : "Reify").font(ReifyDesign.font(10, .medium)).foregroundStyle(ReifyDesign.muted)
                Text(LocalizedStringKey(message.text)).font(ReifyDesign.font(14)).lineSpacing(5).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }.padding(message.role == "user" ? 14 : 0)
                .background(message.role == "user" ? ReifyDesign.panel : .clear, in: RoundedRectangle(cornerRadius: 12))
                .frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
        }
    }
}

struct CanvasView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) { Text("当前项目").font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted); Text(app.selected?.name ?? "").font(ReifyDesign.font(13, .medium)) }
                Divider().frame(height: 26).padding(.horizontal, 10)
                Label(app.previewName.isEmpty ? "当前模型" : app.previewName, systemImage: "cube").accessibilityIdentifier("model.name")
                Spacer()
                Button { app.filesOpen.toggle() } label: { Label("项目文件", systemImage: "folder") }.accessibilityIdentifier("file.toggle")
                if let file = app.files.first(where: { $0.name == app.previewName }) {
                    Button("导出") { Task { await app.export(file) } }.accessibilityIdentifier("model.export")
                }
            }.buttonStyle(ReifyButtonStyle()).padding(.horizontal, 18).frame(height: 58).background(ReifyDesign.paper).overlay(alignment: .bottom) { Divider() }
            Group {
                if let data = app.preview { ModelPreview(data: data).accessibilityIdentifier("model.preview") }
                else {
                    VStack(spacing: 14) {
                        ReifyMark(size: 50)
                        Text("模型会出现在这里").font(ReifyDesign.font(17, .medium))
                        Text("从项目文件打开 STEP 或 STL。").foregroundStyle(ReifyDesign.muted)
                        Button("打开项目文件") { app.filesOpen = true }.buttonStyle(ReifyButtonStyle())
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }.background(ReifyDesign.canvas)
    }
}

struct ComposerView: View {
    @EnvironmentObject var app: AppModel
    let size: CGSize
    @State private var dragOrigin: CGPoint?
    private var width: CGFloat { min(760, max(390, size.width * 0.56)) }
    private var center: CGPoint {
        CGPoint(x: max(width / 2 + 18, min(size.width - width / 2 - 18, app.composerX * size.width)),
                y: max(120, min(size.height - 78, app.composerY * size.height)))
    }
    var body: some View {
        VStack(spacing: 0) {
            TextField("描述你的设计…", text: $app.draft, axis: .vertical).lineLimit(2...3).textFieldStyle(.plain)
                .font(ReifyDesign.font(13)).padding(.horizontal, 17).padding(.top, 16).padding(.bottom, 6)
                .onSubmit(send).accessibilityIdentifier("chat.draft")
            HStack(spacing: 8) {
                Button { Task { await app.upload() } } label: { Image(systemName: "plus") }
                    .disabled(!app.connected || app.selected?.role == "viewer").accessibilityIdentifier("file.upload").help("上传文件")
                Label(app.selected?.role == "viewer" ? "只读" : "工作区", systemImage: "checkmark.shield")
                Button { app.settingsPresented = true } label: { Label(app.model, systemImage: "cube") }
                Button { app.settingsPresented = true } label: { Label(app.thinking, systemImage: "sparkles") }
                Spacer(minLength: 0)
                if app.generating {
                    Button { Task { await app.abort() } } label: { Image(systemName: "stop.fill").frame(width: 17, height: 17) }
                        .accessibilityIdentifier("chat.stop").help("停止")
                } else {
                    Button(action: send) { Image(systemName: "arrow.up").frame(width: 17, height: 17) }
                        .disabled(!app.connected || app.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || app.selected?.role == "viewer")
                        .accessibilityIdentifier("chat.send").help("发送")
                }
            }.buttonStyle(ReifyButtonStyle()).font(ReifyDesign.font(10)).padding(.horizontal, 10).padding(.bottom, 10)
        }.frame(width: width).background(ReifyDesign.paper.opacity(0.97), in: RoundedRectangle(cornerRadius: 17))
            .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(ReifyDesign.color(0xcbc7be)))
            .shadow(color: ReifyDesign.darkGreen.opacity(0.15), radius: 22, y: 15)
            .overlay(alignment: .top) { handle.offset(y: -12) }
            .position(center)
            .onChange(of: size) { _, _ in clampAndSave() }
            .onAppear { clampAndSave() }
    }
    private var handle: some View {
        Button { toggle() } label: {
            Capsule().fill(app.canvasMode ? ReifyDesign.green : ReifyDesign.color(0xc9b89f)).frame(width: 42, height: 3)
                .frame(width: 70, height: 24).contentShape(Rectangle())
        }.buttonStyle(.plain).help("点击切换 · 拖动移动 · 双击复位")
            .accessibilityLabel(app.canvasMode ? "展开对话" : "切换到画布").accessibilityIdentifier("composer.toggle")
            .highPriorityGesture(TapGesture(count: 2).onEnded { reset() })
            .simultaneousGesture(DragGesture(minimumDistance: 4, coordinateSpace: .global).onChanged { value in
                if dragOrigin == nil { dragOrigin = center }
                if let origin = dragOrigin {
                    app.composerX = (origin.x + value.translation.width) / size.width
                    app.composerY = (origin.y + value.translation.height) / size.height
                }
            }.onEnded { _ in dragOrigin = nil; clampAndSave() })
            .contextMenu { Button("复位输入框", action: reset) }
    }
    private func toggle() { withAnimation(.easeInOut(duration: 0.25)) { app.canvasMode.toggle() }; app.filesOpen = false }
    private func reset() { app.composerX = 0.5; app.composerY = 0.82; clampAndSave() }
    private func clampAndSave() {
        guard size.width > 0, size.height > 0 else { return }
        app.composerX = center.x / size.width; app.composerY = center.y / size.height; app.saveLayout()
    }
    private func send() {
        guard app.connected, !app.generating, app.selected?.role != "viewer", !app.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let text = app.draft; app.draft = ""; Task { await app.send(text) }
    }
}

struct FilesView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        VStack(spacing: 0) {
            HStack { Text("项目文件").font(ReifyDesign.font(13, .medium)); Spacer()
                Button { Task { await app.refreshFiles() } } label: { Image(systemName: "arrow.clockwise") }.disabled(!app.connected).accessibilityIdentifier("file.refresh")
                Button { app.filesOpen = false } label: { Image(systemName: "xmark") }.accessibilityIdentifier("file.close")
            }.buttonStyle(.plain).padding(18).frame(height: 58).overlay(alignment: .bottom) { Divider() }
            ScrollView {
                LazyVStack(spacing: 5) {
                    ForEach(app.files) { file in
                        HStack(spacing: 9) {
                            Image(systemName: "doc").foregroundStyle(ReifyDesign.green)
                            Button { Task { await app.showFile(file) } } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(file.name).lineLimit(1)
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)).font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.accessibilityIdentifier("file.\(file.path)")
                            Button { Task { await app.export(file) } } label: { Image(systemName: "arrow.down.to.line") }.accessibilityIdentifier("download.\(file.path)").help("保存 \(file.name)")
                        }.buttonStyle(.plain).padding(12).background(ReifyDesign.panel, in: RoundedRectangle(cornerRadius: 9))
                    }
                }.padding(12)
            }
        }
    }
}

struct StatusBarView: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        HStack(spacing: 18) {
            Label("\(app.model) · \(app.thinking)", systemImage: "cube")
            Divider().frame(height: 16)
            HStack(spacing: 6) { Circle().fill(app.connected ? ReifyDesign.green : ReifyDesign.muted).frame(width: 6, height: 6); Text(app.status) }.accessibilityIdentifier("workspace.status")
            if app.busy { ProgressView().controlSize(.mini) }
            if app.selected != nil && !app.connected && !app.busy {
                Button("重连") { if let project = app.selected { Task { await app.open(project) } } }.accessibilityIdentifier("workspace.reconnect")
            }
            Spacer()
            Text(app.generating ? "任务进行中" : "就绪")
        }.font(ReifyDesign.font(10)).foregroundStyle(ReifyDesign.muted).padding(.horizontal, 18).frame(height: 40)
            .background(ReifyDesign.paper).overlay(alignment: .top) { Divider() }
    }
}

private struct NoticeView: View {
    let text: String
    var error = false
    let dismiss: () -> Void
    var body: some View {
        HStack { Text(text); Spacer(); Button(action: dismiss) { Image(systemName: "xmark") }.buttonStyle(.plain) }
            .padding(12).foregroundStyle(error ? .red : ReifyDesign.ink).background(ReifyDesign.panel).accessibilityIdentifier("error")
    }
}
