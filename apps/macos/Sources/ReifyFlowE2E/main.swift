import Foundation
import ReifyCloud

@main struct FlowE2E {
    @MainActor static func wait(_ condition: () -> Bool, _ label: String) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(for: .milliseconds(50)) }
        fatalError("Timed out: \(label)")
    }
    @MainActor static func main() async throws {
        let scope = ProcessInfo.processInfo.environment["REIFY_PREFERENCES_SCOPE"]!
        AppPreferences.current.removePersistentDomain(forName: scope)
        defer { AppPreferences.current.removePersistentDomain(forName: scope) }
        let app = AppModel()
        try await app.api.logout()
        await app.login(email: "e2e@reify.test", password: "fixture-password", server: app.api.baseURL)
        precondition(app.user != nil && app.error == nil)
        guard let project = app.projects.first else { fatalError("Missing fixture project") }
        await app.open(project)
        precondition(app.connected && app.catalog.providers.count == 3 && app.engineeringError == nil)
        let original = app.settingsDraft
        var changed = original; changed.provider = "zai"; changed.model = "glm-5.3-flash"; changed.thinking = "high"
        let applied = await app.applySettings(changed)
        precondition(applied && app.model == "glm-5.3-flash" && app.thinking == "high")
        var invalid = changed; invalid.thinking = "max"
        let rejected = await app.applySettings(invalid)
        precondition(!rejected && app.settingsDraft == changed, "invalid settings changed actual model")
        app.configError = nil
        app.draft = "长任务-排队验收"; await app.submitDraft()
        precondition(app.generating)
        app.draft = "排队第一条"; app.runningIntent = "queue"; await app.submitDraft()
        app.draft = "排队第二条"; await app.submitDraft()
        precondition(app.pending.count == 2 && app.draft.isEmpty)
        app.pending[0].text = "已编辑第一条"; app.savePending()
        app.draft = "只保存在对话的笔记"; app.runningIntent = "note"; await app.submitDraft()
        precondition(app.pending.count == 2 && app.notes == ["只保存在对话的笔记"])
        await app.abort()
        try await wait({ !app.generating && app.pending.isEmpty }, "drain both queued requests")
        try await wait({ app.messages.contains { $0.role == "user" && $0.text == "排队第二条" } }, "queue history refreshed")
        let users = app.messages.filter { $0.role == "user" }.map(\.text)
        precondition(users.filter { $0 == "已编辑第一条" }.count == 1 && users.filter { $0 == "排队第二条" }.count == 1, "queue duplicated a request")
        precondition(!users.contains("只保存在对话的笔记") && app.messages.contains { $0.role == "note" }, "local note reached model")
        app.draft = "对话 A 的草稿"; app.saveConversationDraft()
        let a = app.sessionID
        await app.refreshConversations()
        guard let historyA = app.conversations.first(where: { $0.id == a }) else { fatalError("Missing first history") }
        await app.newConversation()
        precondition(app.sessionID != a && app.draft.isEmpty && app.pending.isEmpty && app.notes.isEmpty && app.workflowRun == nil && app.engineeringCatalog?.currentRun == nil)
        app.draft = "对话 B 的草稿"; app.saveConversationDraft()
        let b = app.sessionID
        await app.switchConversation(historyA)
        precondition(app.sessionID == a && app.draft == "对话 A 的草稿" && app.notes == ["只保存在对话的笔记"], "conversation state mixed")
        precondition(app.error == nil && app.engineeringError == nil)
        // The native composer sends the actual image payload through the sidecar.
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=")!
        try await app.bridge.upload(png, name: "attachments/flow-e2e.png")
        app.attachments = [ImageAttachment(id: "e2e-image", name: "flow-e2e.png", data: png, mimeType: "image/png", remotePath: "attachments/flow-e2e.png")]
        app.draft = "图片需求验收"; await app.submitDraft()
        try await wait({ !app.generating }, "image turn completed")
        precondition(app.attachments.isEmpty && app.draft.isEmpty)
        precondition(b != a)
        await app.shutdown()
        try await app.api.logout()
        print("PASS: compiled native AppModel over HTTP/WebSocket, actual GLM settings and unsupported thinking rollback, editable queue drains exactly once, local notes, new/switch conversation draft and engineering isolation, image upload and prompt payload")
    }
}
