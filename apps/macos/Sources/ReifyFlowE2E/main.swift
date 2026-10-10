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
        guard app.connected && app.catalog.providers.count == 3 && app.engineeringError == nil else { fatalError("Open failed: \(app.error ?? app.engineeringError ?? app.configError ?? app.status)") }
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
        await app.refreshEngineering()
        guard let artifact = app.engineeringArtifacts.first else { fatalError("Missing generated artifact") }
        await app.showArtifact(artifact)
        guard let manifest = app.selectedParameters else { fatalError("Missing selected model parameters") }
        let savedPreview = app.preview
        await app.previewParameters(manifest, values: ["width": .number(120)])
        precondition(app.parameterPreviewActive && app.parameterError == nil && app.preview != savedPreview)
        app.restoreParameterPreview()
        precondition(!app.parameterPreviewActive && app.preview == savedPreview)
        await app.previewParameters(manifest, values: ["width": .number(110)])
        guard let savedFile = app.files.first(where: { $0.path == "bracket.step" }) else { fatalError("Missing saved model file") }
        await app.showFile(savedFile)
        precondition(!app.parameterPreviewActive && app.parameterOriginal == nil && app.selectedArtifact == nil, "manual file retained stale preview state")
        await app.showArtifact(artifact)
        await app.previewParameters(manifest, values: ["width": .number(110)])
        await app.applyParameters(manifest, values: ["width": .number(66)])
        precondition(!app.parameterPreviewActive && app.parameterError != nil && app.preview == savedPreview, "failed apply did not restore saved preview")
        await app.applyParameters(manifest, values: ["width": .number(120)])
        precondition(app.parameterError == nil && !app.parameterPreviewActive && app.selectedParameters?.manifest.parameters.first?.value == .number(120), "parameter apply did not refresh selected result")
        let noteIDs = app.messages.filter { $0.role == "note" }.map(\.id)
        app.draft = "工具卡片验收"; await app.submitDraft()
        try await wait({ app.messages.contains { $0.activity?.stage == "检查模型" } }, "tool progress")
        precondition(app.presentation.turn()?.phase == "running_tool")
        precondition(app.extensionNotice == "工具通知" && app.extensionStatuses["cad"] == "工作流已就绪" && app.uiRequest == nil, "notice/status were lost or became a dialog")
        try await wait({ !app.generating && app.messages.contains { $0.text.hasPrefix("工具卡片测试完成") } }, "tool result and saved history")
        try await app.loadMessages()
        let build = app.messages.first { $0.activity?.id == "flow-build" }?.activity
        let simulation = app.messages.first { $0.activity?.id == "flow-sim" }?.activity
        precondition(build?.kind == "build" && build?.state == "success" && build?.media?.count == 1 && build?.artifactPath == "/workspace/bracket.step", "tool history lost identity or duplicate images")
        precondition(simulation?.kind == "simulation" && simulation?.metrics?.first?.value == "12 MPa" && simulation?.details != nil && simulation?.artifactPath == "stress.vtk", "simulation result lost metrics or details")
        let markdown = try app.presentation.markdown(app.messages.first { $0.text.hasPrefix("工具卡片测试完成") }!.text)
        precondition(markdown.nodes.contains { $0.type == "table" } && markdown.nodes.contains { $0.type == "code" && $0.lang == "python" } && markdown.nodes.filter { $0.type == "list" }.count == 2, "desktop Markdown grammar missing table/code/list")
        precondition(app.messages.filter { $0.role == "note" }.map(\.id) == noteIDs, "note identity changed while streaming")
        let mappedPath = try app.bridge.relativeProjectPath(build!.artifactPath!)
        precondition(mappedPath == "bracket.step")
        await app.openToolArtifact(build!.artifactPath!)
        precondition(app.previewName == "bracket.step" && app.error == nil)
        app.draft = "重试状态验收"; await app.submitDraft()
        try await wait({ app.presentation.turn()?.phase == "retrying" }, "retry phase")
        try await wait({ app.presentation.turn()?.phase == "thinking" }, "retry resumed")
        try await wait({ !app.generating }, "retry completed")
        app.draft = "模拟模型错误"; await app.submitDraft()
        try await wait({ !app.generating }, "failed turn completed")
        try await Task.sleep(for: .milliseconds(1600))
        precondition(app.presentation.turn()?.terminal == true && app.presentation.turn()?.phase == "failed" && app.presentation.turn()?.reason == "provider_error", "lost terminal failure")
        app.draft = "拒绝请求验收"; await app.submitDraft()
        precondition(!app.generating && app.presentation.turn()?.terminal == true && app.presentation.turn()?.reason == "rpc_rejected", "rejected prompt stayed running")
        precondition(b != a)
        await app.shutdown()
        try await app.api.logout()
        print("PASS: compiled native AppModel over HTTP/WebSocket, actual GLM settings and unsupported thinking rollback, editable queue drains exactly once, local notes, new/switch conversation draft and engineering isolation, image upload and prompt payload")
        print("PASS: live and restored desktop tool cards, image deduplication, simulation metrics, sandbox artifact paths, stable note identity, retry/thinking phases and terminal failure")
        print("PASS: generated artifact selects its parameter manifest, native parameter preview/restore, failed apply restores original preview, successful apply refreshes model and values")
    }
}
