import SwiftUI
import ReifyCloud

@MainActor final class AppModel: ObservableObject {
    @Published var user: User?
    @Published var projects: [Project] = []
    @Published var selected: Project?
    @Published var messages: [ChatMessage] = []
    @Published var conversations: [ConversationSummary] = []
    @Published var sessionID: String?
    @Published var historyLoading = false
    @Published var historyError: String?
    @Published var files: [CloudFile] = []
    @Published var error: String?
    @Published var status = "未连接"
    @Published var busy = false
    @Published var generating = false
    @Published var connected = false
    @Published var reconnecting = false
    var reconnectTask: Task<Void, Never>?
    var reconnectSequence = 0
    @Published var activity: String?
    @Published var extensionNotice: String?
    @Published var extensionStatuses: [String: String] = [:]
    private var noticeSequence = 0
    @Published var reclaimAt: String?
    @Published var preview: Data?
    @Published var previewName = ""
    @Published var uiRequest: [String: Any]?
    @Published var settingsPresented = false
    @Published var workflowsPresented = false
    @Published var workflowRun: WorkflowRun?
    @Published var engineeringCatalog: EngineeringCatalog?
    @Published var engineeringLoading = false
    var engineeringSequence = 0
    @Published var engineeringError: String?
    @Published var selectedCommitID: String?
    @Published var selectedArtifact: EngineeringArtifact?
    @Published var artifactFilter = "全部"
    @Published var includesHistoricalArtifacts = false
    @Published var comparisonArtifact: EngineeringArtifact?
    @Published var comparisonPreview: Data?
    @Published var comparisonLoading = false
    @Published var comparisonError: String?
    @Published var comparisonReset = 0
    @Published var newResult: EngineeringArtifact?
    @Published var readingHistory = false
    var previewPinned = false
    var previewSequence = 0
    var comparisonSequence = 0
    @Published var parameterBusy = false
    @Published var parameterPreviewActive = false
    @Published var parameterError: String?
    var parameterOriginal: (Data?, String, EngineeringArtifact?)?
    @Published var newProjectPresented = false
    @Published var canvasMode = false
    @Published var sidebarOpen = true
    @Published var filesOpen = false
    @Published var draft = ""
    @Published var attachments: [ImageAttachment] = []
    var attachmentsByConversation: [String: [ImageAttachment]] = [:]
    @Published var pending: [QueuedRequest] = []
    @Published var queueSuspended = false
    var drainingQueue = false
    @Published var runningIntent = "queue"
    @Published var notes: [String] = []
    @Published var catalog = ModelCatalog()
    @Published var modelsConfig = ""
    @Published var configWorking = false
    @Published var configError: String?
    @Published var configNotice = ""
    @Published var oauthProvider: String?
    @Published var oauthMessage = ""
    @Published var oauthURL: String?
    @Published var oauthInput: [String: Any]?
    var oauthProcess: RemoteProcess?
    @Published var composerX = 0.5
    @Published var composerY = 0.82
    private var uiKey: String { "reify.native.\(api.session?.user.id ?? "signed-out").\(selected?.id ?? "projects")" }
    func saveLayout() {
        saveConversationDraft()
        AppPreferences.current.set([composerX, composerY], forKey: "\(uiKey).composer")
        AppPreferences.current.set(sidebarOpen, forKey: "\(uiKey).sidebar")
        AppPreferences.current.set(canvasMode, forKey: "\(uiKey).canvas")
        AppPreferences.current.set(draft, forKey: "\(uiKey).draft")
        AppPreferences.current.set(previewName, forKey: "\(uiKey).preview")
    }
    private func restoreLayout() {
        let position = AppPreferences.current.array(forKey: "\(uiKey).composer") as? [Double]
        composerX = position?.count == 2 && position![0].isFinite ? position![0] : 0.5
        composerY = position?.count == 2 && position![1].isFinite ? position![1] : 0.82
        sidebarOpen = AppPreferences.current.object(forKey: "\(uiKey).sidebar") as? Bool ?? true
        canvasMode = AppPreferences.current.bool(forKey: "\(uiKey).canvas")
        draft = AppPreferences.current.string(forKey: "\(uiKey).draft") ?? ""
        previewName = AppPreferences.current.string(forKey: "\(uiKey).preview") ?? ""
        filesOpen = false
    }
    @Published var provider = AppPreferences.current.string(forKey: "provider") ?? "openai-codex"
    @Published var model = AppPreferences.current.string(forKey: "model") ?? "gpt-5.6-sol"
    @Published var thinking = AppPreferences.current.string(forKey: "thinking") ?? "minimal"
    @Published var reviewer = (AppPreferences.current.data(forKey: "reviewer").flatMap { try? JSONDecoder().decode(ReviewerSelection.self, from: $0) }) ?? ReviewerSelection()
    @Published var permission = AppPreferences.current.string(forKey: "permission") ?? "workspace"
    let api: CloudAPI
    let bridge = WorkspaceBridge()
    let presentation = DesktopPresentation()
    private var events: URLSessionWebSocketTask?
    private var eventReader: Task<Void, Never>?
    var generation = 0
    private var turnSequence = 0
    init() {
        let env = ProcessInfo.processInfo.environment
        api = CloudAPI(baseURL: env["REIFY_CLOUD_URL"] ?? CloudAPI.defaultURL, scope: env["REIFY_SESSION_SCOPE"] ?? "production")
        bridge.onEvent = { [weak self] event in self?.handle(event) }
        bridge.onDisconnect = { [weak self] error in
            self?.connected = false; self?.generating = false; self?.activity = nil
            self?.status = "连接已断开"; self?.error = "连接已断开，正在重连。"
            if let self, !self.pending.isEmpty { self.queueSuspended = true; self.savePending() }
            self?.scheduleReconnect()
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
            cancelReconnect()
            generation += 1; user = nil; selected = nil; connected = false
            bridge.close(); eventReader?.cancel(); events?.cancel(with: .goingAway, reason: nil)
            projects = []; messages = []; files = []; preview = nil; previewName = ""
            conversations = []; sessionID = nil; draft = ""; attachments = []; pending = []; notes = []; queueSuspended = false
            catalog = ModelCatalog(); modelsConfig = ""; settingsPresented = false; workflowsPresented = false; uiRequest = nil
            busy = false; generating = false; reclaimAt = nil; extensionNotice = nil; extensionStatuses = [:]
            clearEngineering()
            error = "登录已失效，请重新登录。"; status = "登录失效"
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
    func open(_ project: Project, reconnect: Bool = false) async {
        guard !busy else { return }
        guard !generating else { error = "请先停止当前任务，再切换项目。"; return }
        if !reconnect { cancelReconnect() }
        saveLayout()
        let switchingProject = selected?.id != project.id
        let wasConnected = connected
        generation += 1; let current = generation
        clearEngineering(preserveViewer: reconnect && !switchingProject)
        busy = true; connected = false; generating = false; error = nil
        if !reconnect && (selected?.id != project.id || wasConnected || bridge.spawnID == nil) { await bridge.stop(api: api) }
        guard current == generation else { return }
        selected = project; activity = nil; uiRequest = nil
        if switchingProject {
            messages = []; files = []; preview = nil; previewName = ""; conversations = []; sessionID = nil
            restoreLayout()
        }
        status = "启动云端工作区"
        defer { if current == generation { busy = false } }
        do {
            var workspace: Workspace
            do { workspace = try await api.workspace(reconnect ? nil : "start") }
            catch let error as CloudError where error.status == 409 && error.code == "capacity_full" {
                workspace = try await api.workspace()
            }
            let deadline = Date().addingTimeInterval(600)
            while workspace.state != "running" {
                guard current == generation else { return }
                if workspace.state == "failed" { throw CloudError(workspace.lastError ?? "工作区启动失败") }
                if reconnect && workspace.state == "stopped" { throw CloudError("云端已暂停") }
                guard Date() < deadline else { throw CloudError("工作区启动超时") }
                status = workspace.queuePosition.map { "排队第 \($0) 位" } ?? "启动云端工作区"
                try await Task.sleep(for: .seconds(2))
                workspace = try await api.workspace()
            }
            guard current == generation else { return }
            status = "连接助手"
            let savedSession = AppPreferences.current.string(forKey: "reify.native.active-session.\(api.baseURL).\(user?.id ?? "").\(project.id)")
            try await bridge.connect(api: api, project: project, provider: provider, model: model, thinking: thinking, reviewer: reviewer, permission: permission, sessionPath: savedSession)
            let state = try await bridge.rpc("get_state")
            generating = state["isStreaming"] as? Bool ?? false
            sessionID = state["sessionId"] as? String
            syncRuntimeModel(state)
            if !reconnect { try resetPresentation() }
            if AppPreferences.current.object(forKey: "\(conversationKey).draft") != nil { restoreConversationDraft() }
            restorePending()
            try await loadMessages()
            if reconnect { try presentation.resume(generating: generating) }
            files = try await bridge.files()
            if switchingProject, !previewName.isEmpty, let file = files.first(where: { $0.name == previewName }) {
                let restoredMode = canvasMode
                await showFile(file)
                canvasMode = restoredMode
            }
            connected = true; status = "云端已连接"
            await refreshEngineering()
            await refreshConversations()
            do { catalog = try await configuration.catalog() } catch { configError = error.localizedDescription }
        } catch { if current == generation { fail(error); status = "连接失败" } }
    }
    func resetPresentation() throws { noticeSequence += 1; extensionNotice = nil; extensionStatuses = [:]; try presentation.reset(sessionID: sessionID, thinking: thinking) }
    var noteMessages: [ChatMessage] { notes.enumerated().map { ChatMessage(id: "\(conversationKey).note.\($0.offset)", role: "note", text: $0.element) } }
    func loadMessages() async throws {
        let current = generation
        let result = try await bridge.rpc("get_messages")
        guard current == generation else { return }
        messages = try presentation.load(result["messages"] as? [[String: Any]] ?? [])
        notes = AppPreferences.current.stringArray(forKey: "\(conversationKey).notes") ?? []
        messages += noteMessages
    }
    func send(_ text: String, images: [ImageAttachment] = []) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, connected, !generating, selected?.role != "viewer" else { return }
        let current = generation
        turnSequence += 1
        let automaticTitle = messages.contains(where: { $0.role == "user" }) ? nil : String(text.replacingOccurrences(of: "\n", with: " ").prefix(80))
        generating = true; error = nil
        presentation.begin()
        do { messages = try presentation.reduce(["type": "desktop_user_message", "id": UUID().uuidString, "text": text]) + noteMessages }
        catch { generating = false; fail(error); return }
        do {
            let outgoing = images.isEmpty ? text : text + "\n\n附件（工作区路径）：\n" + images.map { "- \($0.remotePath)" }.joined(separator: "\n")
            var payload: [String: Any] = ["message": outgoing]
            if !images.isEmpty { payload["images"] = images.map(\.promptImage) }
            _ = try await bridge.rpc("prompt", payload: payload)
            guard current == generation else { return }
            if let automaticTitle { _ = try? await bridge.rpc("set_session_name", payload: ["name": automaticTitle]) }
        }
        catch { if current == generation && connected { presentation.failed("prompt", error.localizedDescription, timeout: (error as? CloudError)?.code == "rpc_timeout"); generating = connected && presentation.turn()?.terminal == false; fail(error) } }
    }
    func abort() async {
        let current = generation
        let currentTurn = turnSequence
        presentation.stopping()
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
        generation += 1
        saveConversationDraft()
        clearEngineering()
        do {
            _ = try await bridge.rpc("new_session")
            let state = try await bridge.rpc("get_state"); sessionID = state["sessionId"] as? String
            try resetPresentation()
            try await loadMessages(); draft = ""; restoreConversationDraft(); restorePending(); canvasMode = false; preview = nil; previewName = ""
            if let selected { AppPreferences.current.removeObject(forKey: "reify.native.active-session.\(api.baseURL).\(user?.id ?? "").\(selected.id)") }
            await refreshConversations(); saveLayout()
            await refreshEngineering()
        } catch { fail(error) }
    }
    private func handle(_ event: [String: Any]) {
        do { messages = try presentation.reduce(event) + noteMessages }
        catch { fail(error) }
        switch event["type"] as? String {
        case "agent_start": generating = true
        case "tool_execution_start": activity = event["toolName"] as? String == nil ? "正在处理" : "正在制作模型"
        case "tool_execution_end": activity = nil
        case "agent_end":
            generating = false; activity = nil
            let current = generation
            Task { @MainActor in
                do {
                    guard current == generation else { return }
                    try await loadMessages()
                    guard current == generation else { return }
                    let nextFiles = try await bridge.files()
                    guard current == generation else { return }
                    files = nextFiles; await refreshConversations(); await refreshEngineering(offerNewResult: true); await drainQueue()
                } catch { if current == generation { fail(error) } }
            }
        case "extension_ui_request":
            if ["confirm", "select", "input", "editor"].contains(event["method"] as? String ?? "") { uiRequest = event }
            else if event["method"] as? String == "notify" {
                noticeSequence += 1; let sequence = noticeSequence
                extensionNotice = event["message"] as? String ?? event["text"] as? String
                Task { @MainActor in try? await Task.sleep(for: .milliseconds(4500)); if sequence == noticeSequence { extensionNotice = nil } }
            } else if event["method"] as? String == "setStatus" {
                let key = event["statusKey"] as? String ?? "status"
                extensionStatuses[key] = event["statusText"] as? String ?? event["text"] as? String ?? event["message"] as? String
            }
        default: break
        }
    }
    func answer(_ response: [String: Any]) async {
        guard let id = uiRequest?["id"] as? String else { return }
        do { try await bridge.respond(id, response: response); if uiRequest?["id"] as? String == id { uiRequest = nil } } catch { fail(error) }
    }
    func refreshFiles() async { do { files = try await bridge.files() } catch { fail(error) } }
    func showFile(_ file: CloudFile) async {
        let current = generation, scope = sessionID
        previewSequence += 1; let sequence = previewSequence
        error = nil
        do {
            let ext = (file.name as NSString).pathExtension.lowercased()
            if ["step", "stp"].contains(ext) {
                let next = try await bridge.previewStep(file.path)
                guard current == generation && scope == sessionID && sequence == previewSequence else { return }
                closeComparison(); previewPinned = true
                preview = next; previewName = file.name; selectedArtifact = nil
                parameterPreviewActive = false; parameterOriginal = nil
            } else {
                let data = try await bridge.download(file.path)
                guard current == generation && scope == sessionID && sequence == previewSequence else { return }
                if ext == "stl" { closeComparison(); previewPinned = true; preview = data; previewName = file.name; selectedArtifact = nil; parameterPreviewActive = false; parameterOriginal = nil }
                else { save(data, name: file.name) }
            }
            if ["step", "stp", "stl"].contains(ext) { canvasMode = true; filesOpen = false; saveLayout() }
        } catch { if current == generation { fail(error) } }
    }
    func export(_ file: CloudFile) async {
        do { save(try await bridge.download(file.path), name: file.name) } catch { fail(error) }
    }
    func save(_ data: Data, name: String) {
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
                if ["step", "stp"].contains(url.pathExtension.lowercased()) {
                    await importStep(try Data(contentsOf: url), fileName: url.lastPathComponent); return
                }
                if files.contains(where: { $0.path == url.lastPathComponent }) { throw CloudError("已有同名文件，请先改名") }
                try await bridge.upload(Data(contentsOf: url), name: url.lastPathComponent)
                files = try await bridge.files()
            } catch { fail(error) }
        }
    }
    func stopWorkspace() async {
        cancelReconnect()
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
        cancelReconnect()
        saveLayout()
        generation += 1
        await bridge.stop(api: api); eventReader?.cancel(); events?.cancel(with: .goingAway, reason: nil)
        do {
            try await api.logout(); user = nil; selected = nil; projects = []; messages = []; files = []
            preview = nil; busy = false; connected = false; generating = false; error = nil; reclaimAt = nil; status = "未连接"
            conversations = []; sessionID = nil; catalog = ModelCatalog(); modelsConfig = ""; settingsPresented = false
            oauthProvider = nil; oauthProcess = nil; oauthInput = nil; oauthURL = nil; oauthMessage = ""
            attachments = []; attachmentsByConversation = [:]; pending = []; notes = []
            clearEngineering(); workflowsPresented = false
        } catch { fail(error) }
    }
    func shutdown() async {
        cancelReconnect()
        saveLayout()
        generation += 1
        eventReader?.cancel(); events?.cancel(with: .goingAway, reason: nil)
        await bridge.stop(api: api)
    }
    func syncRuntimeModel(_ state: [String: Any]) {
        if let actual = state["model"] as? [String: Any] {
            if let provider = actual["provider"] as? String { self.provider = provider }
            if let model = actual["id"] as? String { self.model = model }
        }
        if let level = state["thinkingLevel"] as? String { thinking = level }
        persistSettings()
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
                                cancelReconnect(); bridge.close(); connected = false; generating = false; status = "云端已暂停"
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
