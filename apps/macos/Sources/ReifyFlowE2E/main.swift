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
        let loadingSettings = Task { await app.loadCloudModels() }
        try await Task.sleep(for: .milliseconds(50))
        await app.open(project)
        await loadingSettings.value
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
        app.draft = "断线前保留草稿"; app.saveConversationDraft()
        let beforeDrop = try await URLSession.shared.data(from: URL(string: app.api.baseURL + "/__test/stats")!)
        let statsBefore = (try JSONSerialization.jsonObject(with: beforeDrop.0) as! [String: Any])["stats"] as! [String: Int]
        let spawn = app.bridge.spawnID, conversation = app.sessionID
        let reconnectPreview = app.preview, reconnectArtifact = app.selectedArtifact?.sha256
        app.previewPinned = true
        _ = try await URLSession.shared.data(from: URL(string: app.api.baseURL + "/__test/drop")!)
        try await wait({ app.reconnecting }, "automatic reconnect starts")
        var whileReconnecting = app.settingsDraft; whileReconnecting.permission = "read-only"
        let savingDisconnected = await app.applySettings(whileReconnecting)
        precondition(!savingDisconnected && app.permission == "workspace", "changed permission while the old helper could still run")
        try await wait({ app.connected && !app.reconnecting }, "automatic reconnect completes")
        precondition(app.bridge.spawnID == spawn && app.sessionID == conversation && app.draft == "断线前保留草稿" && app.model == "glm-5.3-flash" && app.thinking == "high", "reconnect replaced process, session, draft or actual model")
        precondition(app.previewPinned && app.preview == reconnectPreview && app.selectedArtifact?.sha256 == reconnectArtifact, "reconnect lost manual model selection")
        let afterDrop = try await URLSession.shared.data(from: URL(string: app.api.baseURL + "/__test/stats")!)
        let statsAfter = (try JSONSerialization.jsonObject(with: afterDrop.0) as! [String: Any])["stats"] as! [String: Int]
        precondition(statsBefore["spawn"] == statsAfter["spawn"] && statsBefore["prompt"] == statsAfter["prompt"] && statsBefore["start"] == statsAfter["start"], "reconnect duplicated a process, prompt or workspace start")
        app.draft = "长任务-断线排队验收"; await app.submitDraft()
        app.draft = "断线暂停的需求"; app.runningIntent = "queue"; await app.submitDraft()
        _ = try await URLSession.shared.data(from: URL(string: app.api.baseURL + "/__test/drop")!)
        try await wait({ app.reconnecting }, "streaming reconnect starts")
        try await wait({ app.connected && !app.reconnecting }, "streaming reconnect completes")
        precondition(app.generating && app.queueSuspended && app.pending.count == 1 && app.bridge.spawnID == spawn, "running task or suspended queue was lost")
        await app.abort()
        try await wait({ !app.generating }, "reconnected live task abort")
        try await Task.sleep(for: .milliseconds(700))
        precondition(app.pending.count == 1 && app.queueSuspended, "queue was replayed after disconnect")
        app.pending = []; app.queueSuspended = false; app.savePending()
        _ = try await URLSession.shared.data(from: URL(string: app.api.baseURL + "/__test/reclaim")!)
        try await wait({ !app.connected && app.status == "云端已暂停" }, "idle pause state")
        try await Task.sleep(for: .milliseconds(1200))
        let pausedWorkspace = try await app.api.workspace()
        precondition(!app.connected && !app.reconnecting && pausedWorkspace.state == "stopped", "idle-paused workspace automatically restarted")
        func fixture(_ path: String, _ body: [String: String] = [:]) async throws {
            var request = URLRequest(url: URL(string: app.api.baseURL + path)!)
            request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            _ = try await URLSession.shared.data(for: request)
        }
        try await fixture("/__test/start-mode", ["mode": "queue"])
        let queuedOpen = Task { await app.open(project) }
        try await wait({ app.status == "排队第 2 位" }, "workspace queue position")
        await queuedOpen.value
        precondition(app.connected && !app.busy)
        try await fixture("/__test/start-mode", ["mode": "fail"])
        await app.open(project)
        precondition(!app.connected && !app.busy && app.error == "测试工作区磁盘不足", "lost workspace startup failure")
        await app.open(project)
        precondition(app.connected && app.error == nil, "failed workspace cannot retry")
        try await fixture("/__test/catalog-parity")
        await app.refreshEngineering()
        app.artifactFilter = "模型"
        precondition(app.engineeringArtifacts.count == 1, "current model duplicated by shared head")
        app.includesHistoricalArtifacts = true
        precondition(app.engineeringArtifacts.count == 2, "history missing from model filter")
        app.artifactFilter = "其他结果"
        precondition(app.engineeringArtifacts.count == 1 && app.engineeringArtifacts.first?.role == "evidence", "non-model filter mixed model results")
        app.artifactFilter = "全部"
        guard let currentModel = app.engineeringArtifacts.first(where: { $0.path == "bracket.step" }),
              let oldModel = app.engineeringArtifacts.first(where: { $0.path == "history/bracket-80.step" }) else { fatalError("Missing comparison sources") }
        await app.showArtifact(currentModel)
        await app.compareArtifact(oldModel)
        precondition(app.comparisonError == nil && app.comparisonPreview != nil && app.comparisonArtifact?.sha256 == oldModel.sha256 && app.selectedArtifact?.sha256 == currentModel.sha256, "comparison replaced primary or lost exact revision")
        precondition(app.parameterDifferences.first?.before == "120" && app.parameterDifferences.first?.after == "80", "comparison lost historical parameter snapshot")
        let primaryMesh = try MeshModel.read(app.preview!), secondaryMesh = try MeshModel.read(app.comparisonPreview!)
        precondition(primaryMesh.sha256 == currentModel.sha256 && secondaryMesh.sha256 == oldModel.sha256 && primaryMesh.parts.first?.positions != secondaryMesh.parts.first?.positions, "comparison used primary model bytes for both views")
        let parameterRecord = app.selectedParameters!
        await app.previewParameters(parameterRecord, values: ["width": .number(110)])
        precondition(app.parameterPreviewActive && app.comparisonPreview == nil, "temporary parameter preview kept historical comparison labels")
        app.restoreParameterPreview()
        await app.compareArtifact(oldModel)
        let cached = try await app.cachedArtifact(currentModel)
        let cachedBytes = try Data(contentsOf: cached)
        precondition(WorkspaceBridge.hash(cachedBytes) == currentModel.sha256, "reveal cache did not match selected revision")
        try? FileManager.default.removeItem(at: cached.deletingLastPathComponent())
        try await app.bridge.upload(Data("changed old model".utf8), name: oldModel.path)
        let previousComparison = app.comparisonPreview
        await app.compareArtifact(oldModel)
        precondition(app.comparisonError != nil && app.comparisonPreview == previousComparison, "changed file masqueraded as historical model")
        app.selectVersion("history-80")
        precondition(app.selectedParameters == nil && app.comparisonPreview == nil, "historical model stayed editable")
        app.selectVersion(nil)
        let importedBytes = Data("ISO-10303-21;\nWIDTH=45;\nEND-ISO-10303-21;".utf8)
        await app.importStep(importedBytes, fileName: "native import.step")
        precondition(app.error == nil && app.canvasMode && app.preview != nil && app.previewName.hasSuffix("native_import.step"), "desktop STEP import did not open the verified model")
        let importedHash = WorkspaceBridge.hash(importedBytes)
        let importedPath = "imports/\(importedHash.prefix(16))-native_import.step"
        let importedFile = try await app.bridge.download(importedPath)
        precondition(importedFile == importedBytes && app.files.contains { $0.path == importedPath }, "STEP import not content-addressed in project")
        await app.importStep(importedBytes, fileName: "native import.step")
        precondition(app.error == nil && app.files.filter { $0.path == importedPath }.count == 1, "reimport duplicated or rejected identical STEP")
        let savedImportPreview = app.preview
        app.permission = "read-only"
        await app.importStep(importedBytes, fileName: "readonly.step")
        precondition(app.error == "当前项目没有写入权限" && app.preview == savedImportPreview, "read-only import changed project or preview")
        app.permission = "workspace"; app.error = nil
        let conflictingBytes = Data("conflicting destination".utf8)
        try await app.bridge.upload(conflictingBytes, name: importedPath)
        await app.importStep(importedBytes, fileName: "native import.step")
        let conflictPreserved = try await app.bridge.download(importedPath)
        precondition(app.error != nil && conflictPreserved == conflictingBytes && app.preview == savedImportPreview, "import overwrote conflict or lost saved canvas")
        app.error = nil; app.draft = "有草稿时不抢画布"; app.previewPinned = false
        try await fixture("/__test/model-width", ["width": "130"])
        await app.refreshEngineering(offerNewResult: true)
        precondition(app.newResult != nil && app.preview == savedImportPreview && app.draft == "有草稿时不抢画布", "new result took over active draft")
        app.draft = ""; app.readingHistory = true
        try await fixture("/__test/model-width", ["width": "140"])
        await app.refreshEngineering(offerNewResult: true)
        precondition(app.newResult != nil && app.preview == savedImportPreview, "new result interrupted history reading")
        app.readingHistory = false; app.previewPinned = true
        try await fixture("/__test/model-width", ["width": "145"])
        await app.refreshEngineering(offerNewResult: true)
        precondition(app.newResult != nil && app.preview == savedImportPreview, "new result replaced manually selected model")
        app.previewPinned = false; app.newResult = nil
        try await fixture("/__test/model-width", ["width": "150"])
        app.draft = "自动展示新结果验收"; await app.submitDraft()
        try await wait({ app.selectedArtifact?.sha256 == app.engineeringCatalog?.currentRun?.artifacts.first?.sha256 && app.preview != savedImportPreview && app.previewName == "bracket.step" && app.newResult == nil }, "automatic current model display after completed turn")
        precondition(app.previewPinned == false && app.draft.isEmpty, "automatic display changed reading preference or draft")
        let modelBeforeConcept = app.preview
        app.draft = "概念图验收"; await app.submitDraft()
        try await wait({ !app.generating && app.newConceptID != nil && !app.conceptImages.isEmpty }, "generated concept enters native board without replacing model")
        precondition(app.preview == modelBeforeConcept && app.canvasContent == "model", "generated concept replaced manually visible model")
        guard let generatedConcept = app.conceptImages.first(where: { $0.origin == "generated" }) else { fatalError("Missing generated concept") }
        app.showConcept(generatedConcept.id)
        precondition(app.canvasContent == "concept" && app.newConceptID == nil && app.selectedConceptID == generatedConcept.id)
        try app.addConcept(png, name: "上传概念图.png", mimeType: "image/png", id: "uploaded-concept-e2e")
        guard let uploadedConcept = app.conceptImages.first(where: { $0.id == "uploaded-concept-e2e" }) else { fatalError("Missing uploaded concept") }
        let annotated = ConceptAnnotation(note: "只修改右上角，保留其他部分", region: ConceptRegion(x: 0.1, y: 0.2, width: 0.3, height: 0.4), outdated: false)
        app.setConceptAnnotation(annotated, id: uploadedConcept.id)
        app.conceptAnnotations = [:]; app.restoreConceptAnnotations()
        precondition(app.conceptAnnotations[uploadedConcept.id] == annotated, "concept notes or normalized region not restored")
        app.draft = "尚未发送的草稿"
        await app.continueConcept(uploadedConcept)
        try await wait({ !app.generating }, "annotated concept turn completed")
        try await app.loadMessages()
        precondition(app.draft == "尚未发送的草稿" && app.messages.contains { $0.role == "user" && $0.text.contains("imageSHA256=" + uploadedConcept.sha256) && $0.text.contains("x=0.100, y=0.200, width=0.300, height=0.400") && $0.text.contains(annotated.note) }, "concept continuation lost exact image, region, note or existing draft")
        var outdated = annotated; outdated.outdated = true
        app.setConceptAnnotation(outdated, id: uploadedConcept.id)
        await app.continueConcept(uploadedConcept)
        precondition(app.error == "此概念图已标记过期" && !app.generating, "outdated concept sent to model")
        var badRegion = annotated; badRegion.region = ConceptRegion(x: 0.9, y: 0.2, width: 0.3, height: 0.4)
        app.setConceptAnnotation(badRegion, id: uploadedConcept.id)
        await app.continueConcept(uploadedConcept)
        precondition(app.error == "框选区域无效，请重新选择" && !app.generating, "invalid region sent to model")
        app.setConceptAnnotation(ConceptAnnotation(note: "使用整张生成图"), id: generatedConcept.id)
        await app.continueConcept(generatedConcept)
        try await wait({ !app.generating }, "full generated concept continuation")
        precondition(app.error == nil && app.messages.contains { $0.role == "user" && $0.text.contains("Use the full image.") && $0.text.contains(generatedConcept.sha256) }, "full-image continuation missing image version")
        await app.refreshConversations()
        guard let conceptHistory = app.conversations.first(where: { $0.id == app.sessionID }) else { fatalError("Missing concept conversation history") }
        await app.newConversation()
        precondition(app.conceptImages.isEmpty && app.conceptAnnotations.isEmpty && app.newConceptID == nil, "concepts or annotations leaked into another conversation")
        app.draft = "概念图自动展示验收"; await app.submitDraft()
        try await wait({ !app.generating && app.canvasMode && app.canvasContent == "concept" && !app.conceptImages.isEmpty }, "unoccupied conversation automatically shows generated concept")
        precondition(app.newConceptID == nil && !app.selectedConceptID.isEmpty, "automatic concept display left a stale notification")
        try app.addConcept(png, name: "另一对话.png", mimeType: "image/png", id: "other-concept-e2e")
        precondition(app.conceptAnnotations[uploadedConcept.id] == nil)
        await app.switchConversation(conceptHistory)
        precondition(app.conceptImages.contains { $0.id == uploadedConcept.id } && app.conceptImages.contains { $0.id == generatedConcept.id } && !app.conceptImages.contains { $0.id == "other-concept-e2e" }, "concept images mixed after restoring conversation")
        precondition(app.conceptAnnotations[uploadedConcept.id]?.region == badRegion.region && app.conceptAnnotations[generatedConcept.id]?.note == "使用整张生成图", "saved concept annotation changed after conversation switch")
        try await fixture("/__test/expire")
        await app.refreshProjects()
        precondition(app.user == nil && app.api.session == nil && !app.connected && app.error == "登录已失效，请重新登录。" && app.messages.isEmpty && app.projects.isEmpty && app.catalog.providers.isEmpty, "expired session stayed signed in")
        await app.shutdown()
        try await app.api.logout()
        print("PASS: generated/uploaded concept board state, exact-image and region/note/full-image prompt payload, outdated/invalid-region refusal, preserved draft and conversation isolation; native desktop STEP importer reuse/conflict, filtered current/shared/history catalog, exact-revision comparison and parameter differences, verified Finder cache, new model notification and completed-turn auto preview; compiled native AppModel over HTTP/WebSocket, native GLM model settings and unsupported thinking rollback, editable queue drains exactly once, local notes, new/switch conversation draft and engineering isolation, image upload and prompt payload")
        print("PASS: settings load cannot close a newly selected project bridge, workspace queue position, startup failure and retry, expired login clears native account and connection")
        print("PASS: disconnect during a live task resumes it, suspends queued input, allows abort, and never restarts an idle-paused workspace")
        print("PASS: automatic native reconnect reattaches the same process/session, preserves drafts and never repeats prompts or starts the workspace")
        print("PASS: live and restored desktop tool cards, image deduplication, simulation metrics, sandbox artifact paths, stable note identity, retry/thinking phases and terminal failure")
        print("PASS: generated artifact selects its parameter manifest, native parameter preview/restore, failed apply restores original preview, successful apply refreshes model and values")
    }
}
