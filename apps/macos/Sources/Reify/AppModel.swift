import SwiftUI
import ReifyCloud

@MainActor final class AppModel: ObservableObject {
    @Published var user: User?
    @Published var projects: [Project] = []
    @Published var selected: Project?
    @Published var messages: [ChatMessage] = []
    @Published var files: [CloudFile] = []
    @Published var error: String?
    @Published var status = "未连接"
    @Published var busy = false
    @Published var generating = false
    @Published var connected = false
    @Published var activity: String?
    @Published var reclaimAt: String?
    @Published var preview: Data?
    @Published var previewName = ""
    @Published var uiRequest: [String: Any]?
    @Published var settingsPresented = false
    @Published var newProjectPresented = false
    @Published var canvasMode = false
    @Published var sidebarOpen = true
    @Published var filesOpen = false
    @Published var draft = ""
    @Published var cloudModels: [CloudModelChoice] = []
    @Published var modelCatalogMessage = ""
    @Published var composerX = 0.5
    @Published var composerY = 0.82
    private var uiKey: String { "reify.native.\(api.session?.user.id ?? "signed-out").\(selected?.id ?? "projects")" }
    func saveLayout() {
        UserDefaults.standard.set([composerX, composerY], forKey: "\(uiKey).composer")
        UserDefaults.standard.set(sidebarOpen, forKey: "\(uiKey).sidebar")
        UserDefaults.standard.set(canvasMode, forKey: "\(uiKey).canvas")
        UserDefaults.standard.set(draft, forKey: "\(uiKey).draft")
        UserDefaults.standard.set(previewName, forKey: "\(uiKey).preview")
    }
    private func restoreLayout() {
        let position = UserDefaults.standard.array(forKey: "\(uiKey).composer") as? [Double]
        composerX = position?.count == 2 && position![0].isFinite ? position![0] : 0.5
        composerY = position?.count == 2 && position![1].isFinite ? position![1] : 0.82
        sidebarOpen = UserDefaults.standard.object(forKey: "\(uiKey).sidebar") as? Bool ?? true
        canvasMode = UserDefaults.standard.bool(forKey: "\(uiKey).canvas")
        draft = UserDefaults.standard.string(forKey: "\(uiKey).draft") ?? ""
        previewName = UserDefaults.standard.string(forKey: "\(uiKey).preview") ?? ""
        filesOpen = false
    }
    @Published var provider = UserDefaults.standard.string(forKey: "provider") ?? "openai-codex"
    @Published var model = UserDefaults.standard.string(forKey: "model") ?? "gpt-5.6-sol"
    @Published var thinking = UserDefaults.standard.string(forKey: "thinking") ?? "minimal"
    let api: CloudAPI
    let bridge = WorkspaceBridge()
    private var events: URLSessionWebSocketTask?
    private var eventReader: Task<Void, Never>?
    private var generation = 0
    private var turnSequence = 0
    private var streamingID: String?
    init() {
        let env = ProcessInfo.processInfo.environment
        api = CloudAPI(baseURL: env["REIFY_CLOUD_URL"] ?? CloudAPI.defaultURL, scope: env["REIFY_SESSION_SCOPE"] ?? "production")
        bridge.onEvent = { [weak self] event in self?.handle(event) }
        bridge.onDisconnect = { [weak self] error in
            self?.connected = false; self?.generating = false; self?.activity = nil
            self?.status = "连接已断开"; self?.error = "云端连接已断开，请重连。"
        }
    }
    func boot() async {
        do {
            try api.restore()
            user = api.session?.user
            if user != nil { projects = try await api.projects(); watchEvents() }
        } catch { fail(error) }
    }
    func fail(_ failure: Error) {
        if failure is CancellationError { return }
        error = failure is URLError ? "无法连接服务器，请检查网络。" : failure.localizedDescription
        if api.session == nil && user != nil {
            generation += 1; user = nil; selected = nil; connected = false
            bridge.close(); eventReader?.cancel(); events?.cancel(with: .goingAway, reason: nil)
        }
    }
    func login(email: String, password: String, server: String) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            try await api.login(email: email, password: password, server: server)
            user = api.session?.user
            projects = try await api.projects(); watchEvents()
        } catch { fail(error) }
    }
    func refreshProjects() async {
        do { projects = try await api.projects() } catch { fail(error) }
    }
    func createProject(_ name: String) async {
        guard !busy, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        busy = true; error = nil
        do {
            let project = try await api.createProject(name.trimmingCharacters(in: .whitespacesAndNewlines))
            projects = try await api.projects(); newProjectPresented = false; busy = false
            await open(project)
        } catch { busy = false; fail(error) }
    }
    func open(_ project: Project) async {
        guard !busy else { return }
        guard !generating else { error = "请先停止当前任务，再切换项目。"; return }
        saveLayout()
        let switchingProject = selected?.id != project.id
        let wasConnected = connected
        generation += 1; let current = generation
        busy = true; connected = false; generating = false; error = nil
        if selected?.id != project.id || wasConnected || bridge.spawnID == nil { await bridge.stop(api: api) }
        guard current == generation else { return }
        selected = project; streamingID = nil; activity = nil; uiRequest = nil
        if switchingProject {
            messages = []; files = []; preview = nil; previewName = ""
            restoreLayout()
        }
        status = "启动云端工作区"
        defer { if current == generation { busy = false } }
        do {
            var workspace: Workspace
            do { workspace = try await api.workspace("start") }
            catch let error as CloudError where error.status == 409 && error.code == "capacity_full" {
                workspace = try await api.workspace()
            }
            let deadline = Date().addingTimeInterval(600)
            while workspace.state != "running" {
                guard current == generation else { return }
                if workspace.state == "failed" { throw CloudError(workspace.lastError ?? "工作区启动失败") }
                guard Date() < deadline else { throw CloudError("工作区启动超时") }
                status = workspace.queuePosition.map { "排队第 \($0) 位" } ?? "启动云端工作区"
                try await Task.sleep(for: .seconds(2))
                workspace = try await api.workspace()
            }
            guard current == generation else { return }
            status = "连接助手"
            try await bridge.connect(api: api, project: project, provider: provider, model: model, thinking: thinking)
            let state = try await bridge.rpc("get_state")
            generating = state["isStreaming"] as? Bool ?? false
            try await loadMessages()
            files = try await bridge.files()
            if switchingProject, !previewName.isEmpty, let file = files.first(where: { $0.name == previewName }) {
                let restoredMode = canvasMode
                await showFile(file)
                canvasMode = restoredMode
            }
            connected = true; status = "云端已连接"
        } catch { if current == generation { fail(error); status = "连接失败" } }
    }
    func loadMessages() async throws {
        let result = try await bridge.rpc("get_messages")
        messages = ChatMessage.decode(result["messages"] as? [[String: Any]] ?? [])
        streamingID = nil
    }
    func send(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, connected, !generating, selected?.role != "viewer" else { return }
        turnSequence += 1
        generating = true; error = nil; streamingID = nil
        messages.append(ChatMessage(role: "user", text: text))
        do { _ = try await bridge.rpc("prompt", payload: ["message": text]) }
        catch { generating = false; fail(error) }
    }
    func abort() async {
        let current = generation
        let currentTurn = turnSequence
        do {
            _ = try await bridge.rpc("abort")
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(8))
                if current == generation && currentTurn == turnSequence && generating {
                    await bridge.stop(api: api); generating = false; connected = false; status = "助手已停止，请重连"
                }
            }
        } catch { generating = false; fail(error) }
    }
    func newConversation() async {
        guard connected, !generating else { return }
        do { _ = try await bridge.rpc("new_session"); try await loadMessages(); draft = ""; canvasMode = false; saveLayout() } catch { fail(error) }
    }
    private func handle(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "agent_start": generating = true
        case "message_update":
            guard let update = event["assistantMessageEvent"] as? [String: Any], update["type"] as? String == "text_delta", let delta = update["delta"] as? String else { return }
            if let id = streamingID, let i = messages.firstIndex(where: { $0.id == id }) { messages[i].text += delta }
            else { let message = ChatMessage(role: "assistant", text: delta); streamingID = message.id; messages.append(message) }
        case "message_end":
            if let row = event["message"] as? [String: Any], let message = ChatMessage.decode([row]).first, message.role == "assistant" {
                if let id = streamingID, let i = messages.firstIndex(where: { $0.id == id }) { messages[i].text = message.text }
                else { messages.append(message) }
            }
            streamingID = nil
        case "tool_execution_start": activity = event["toolName"] as? String == nil ? "正在处理" : "正在制作模型"
        case "tool_execution_end": activity = nil
        case "agent_end":
            generating = false; activity = nil
            Task { @MainActor in
                do { try await loadMessages(); files = try await bridge.files() } catch { fail(error) }
            }
        case "extension_ui_request":
            if ["confirm", "select", "input"].contains(event["method"] as? String ?? "") { uiRequest = event }
            else if event["method"] as? String == "notify" { activity = event["message"] as? String }
        default: break
        }
    }
    func answer(_ response: [String: Any]) async {
        guard let id = uiRequest?["id"] as? String else { return }
        do { try await bridge.respond(id, response: response); uiRequest = nil } catch { fail(error) }
    }
    func refreshFiles() async { do { files = try await bridge.files() } catch { fail(error) } }
    func showFile(_ file: CloudFile) async {
        error = nil
        do {
            let ext = (file.name as NSString).pathExtension.lowercased()
            if ["step", "stp"].contains(ext) {
                preview = try await bridge.previewStep(file.path); previewName = file.name
            } else {
                let data = try await bridge.download(file.path)
                if ext == "stl" { preview = data; previewName = file.name }
                else { save(data, name: file.name) }
            }
            if ["step", "stp", "stl"].contains(ext) { canvasMode = true; filesOpen = false; saveLayout() }
        } catch { fail(error) }
    }
    func export(_ file: CloudFile) async {
        do { save(try await bridge.download(file.path), name: file.name) } catch { fail(error) }
    }
    private func save(_ data: Data, name: String) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = name; panel.title = "保存文件"
        if panel.runModal() == .OK, let url = panel.url {
            do { try data.write(to: url, options: .atomic) } catch { fail(error) }
        }
    }
    func upload() async {
        guard connected, selected?.role != "viewer" else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            do {
                let values = try url.resourceValues(forKeys: [.fileSizeKey])
                guard (values.fileSize ?? 0) <= 64 * 1024 * 1024 else { throw CloudError("文件超过 64 MB") }
                if files.contains(where: { $0.path == url.lastPathComponent }) { throw CloudError("已有同名文件，请先改名") }
                try await bridge.upload(Data(contentsOf: url), name: url.lastPathComponent)
                files = try await bridge.files()
            } catch { fail(error) }
        }
    }
    func stopWorkspace() async {
        generation += 1; busy = true
        defer { busy = false }
        do {
            _ = try await api.workspace("stop"); await bridge.stop(api: api)
            connected = false; generating = false; status = "云端已暂停"
        } catch { fail(error) }
    }
    func keepalive() async {
        do { _ = try await api.workspace("keepalive"); reclaimAt = nil } catch { fail(error) }
    }
    func logout() async {
        saveLayout()
        generation += 1
        await bridge.stop(api: api); eventReader?.cancel(); events?.cancel(with: .goingAway, reason: nil)
        do {
            try await api.logout(); user = nil; selected = nil; projects = []; messages = []; files = []
            preview = nil; busy = false; connected = false; generating = false; error = nil; reclaimAt = nil; status = "未连接"
        } catch { fail(error) }
    }
    func shutdown() async {
        saveLayout()
        generation += 1
        eventReader?.cancel(); events?.cancel(with: .goingAway, reason: nil)
        await bridge.stop(api: api)
    }
    func saveSettings() {
        UserDefaults.standard.set(provider, forKey: "provider"); UserDefaults.standard.set(model, forKey: "model")
        UserDefaults.standard.set(thinking, forKey: "thinking"); settingsPresented = false
        if let selected { Task { await open(selected) } }
    }
    private func watchEvents() {
        eventReader?.cancel()
        eventReader = Task { @MainActor in
            while !Task.isCancelled, user != nil {
                do {
                    let socket = try await api.socket("/v1/events"); events = socket
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        if case .string(let text) = message,
                           let row = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] {
                            if row["type"] as? String == "idle_warning" { reclaimAt = row["reclaimAt"] as? String }
                            if row["type"] as? String == "reclaimed" || (row["type"] as? String == "workspace_state" && ["stopped", "failed"].contains(row["state"] as? String ?? "")) {
                                bridge.close(); connected = false; generating = false; status = "云端已暂停"
                            }
                        }
                    }
                } catch {
                    if Task.isCancelled { return }
                    if api.session == nil { fail(error); return }
                    try? await Task.sleep(for: .seconds(5))
                }
            }
        }
    }
}
