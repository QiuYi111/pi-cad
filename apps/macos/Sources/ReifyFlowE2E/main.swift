import Foundation
import ReifyCloud

@main struct FlowE2E {
    @MainActor static func wait(_ condition: () -> Bool, _ label: String) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(for: .milliseconds(50)) }
        fatalError("Timed out: \(label)")
    }
    @MainActor static func waitReleaseCheck(_ server: String, count: Int) async throws {
        for _ in 0..<200 {
            let (data, _) = try await URLSession.shared.data(from: URL(string: server + "/__test/release-checks")!)
            if (try JSONSerialization.jsonObject(with: data) as? [String: Int])?["checks"] ?? 0 >= count { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        fatalError("Timed out waiting for original desktop release approval callback")
    }
    @MainActor static func main() async throws {
        let scope = ProcessInfo.processInfo.environment["REIFY_PREFERENCES_SCOPE"]!
        AppPreferences.current.removePersistentDomain(forName: scope)
        defer { AppPreferences.current.removePersistentDomain(forName: scope) }
        let app = AppModel()
        try await app.api.logout()
        await app.login(email: "e2e@reify.test", password: "fixture-password", server: app.api.baseURL)
        precondition(app.user != nil && app.error == nil)
        let approvalRootAtLogin = app.approvalRoot
        defer { try? FileManager.default.removeItem(at: approvalRootAtLogin) }
        guard let testSettingsPath = ProcessInfo.processInfo.environment["REIFY_DESKTOP_SETTINGS_PATH"] else { fatalError("A disposable desktop policy path is required") }
        let testPolicyURL = URL(fileURLWithPath: testSettingsPath)
        defer { try? FileManager.default.removeItem(at: testPolicyURL) }
        guard let project = app.projects.first else { fatalError("Missing fixture project") }
        let loadingSettings = Task { await app.loadCloudModels() }
        try await Task.sleep(for: .milliseconds(50))
        await app.open(project)
        await loadingSettings.value
        guard app.connected && app.catalog.providers.count == 3 && app.engineeringError == nil else { fatalError("Open failed: \(app.error ?? app.engineeringError ?? app.configError ?? app.status)") }
        if ProcessInfo.processInfo.environment["REIFY_E2E_ONLY"] == "fusion" {
            var choice = app.settingsDraft; choice.provider = "zai"; choice.model = "glm-5.3-flash"; choice.thinking = "high"
            guard await app.applySettings(choice) else { fatalError("Could not select fixture GLM") }
            try await fusionE2E(app)
            await app.shutdown(); try await app.api.logout()
            return
        }
        let original = app.settingsDraft
        var changed = original; changed.provider = "zai"; changed.model = "glm-5.3-flash"; changed.thinking = "high"
        let applied = await app.applySettings(changed)
        precondition(applied && app.model == "glm-5.3-flash" && app.thinking == "high")
        var invalid = changed; invalid.thinking = "max"
        let rejected = await app.applySettings(invalid)
        precondition(!rejected && app.settingsDraft == changed, "invalid settings changed actual model")
        var authorDefault = changed
        authorDefault.provider = "openai-codex"; authorDefault.model = "gpt-5.6-sol"; authorDefault.thinking = "max"
        authorDefault.permission = "read-only"; authorDefault.reviewer = ReviewerSelection(mode: "fixed", provider: "custom", model: "custom-chat", thinking: "off")
        let sessionBeforeDefault = app.sessionID
        let defaultSaved = await app.saveCloudDefault(authorDefault)
        let defaultState = try await app.bridge.rpc("get_state")
        precondition(defaultSaved && app.provider == "openai-codex" && app.thinking == "max" && app.catalog.defaults.modelId == app.model && app.catalog.defaults.thinkingLevel == app.thinking, "saved cloud default did not update current selection")
        precondition((defaultState["model"] as? [String: Any])?["id"] as? String == app.model && defaultState["thinkingLevel"] as? String == app.thinking && app.sessionID == sessionBeforeDefault, "cloud default lost current conversation or runtime model")
        precondition(app.permission == changed.permission && app.reviewer == changed.reviewer && AppPreferences.current.string(forKey: "model") == app.model, "saving author default saved unrelated drafts or lost persisted model")
        let loadedModels = app.modelsConfig
        app.modelsConfig = "未保存的自定义配置"
        await app.loadCloudModels(readModels: false)
        precondition(app.modelsConfig == "未保存的自定义配置", "refreshing model catalog replaced custom configuration content")
        app.modelsConfig = loadedModels
        try await fixture("/__test/settings-failure", ["mode": "save-default-error"])
        let oldDefault = app.catalog.defaults, oldSelection = app.settingsDraft
        let cloudRejected = await app.saveCloudDefault(changed)
        precondition(!cloudRejected && app.settingsDraft == oldSelection && app.catalog.defaults == oldDefault && app.configError != nil, "failed cloud save changed current model")
        try await fixture("/__test/settings-failure", ["mode": "model-switch-error"])
        let switchRejected = await app.saveCloudDefault(changed)
        let failedSwitchState = try await app.bridge.rpc("get_state")
        let savedDespiteSwitchFailure = try await app.configuration.catalog()
        precondition(!switchRejected && app.settingsDraft == oldSelection && (failedSwitchState["model"] as? [String: Any])?["id"] as? String == oldSelection.model && savedDespiteSwitchFailure.defaults.modelId == changed.model && app.catalog.defaults == savedDespiteSwitchFailure.defaults && app.configError?.contains("云端默认已保存，当前模型切换失败") == true, "runtime failure silently diverged from saved cloud default")
        try await fixture("/__test/settings-failure", ["mode": "normal"])
        let glmDefaultSaved = await app.saveCloudDefault(changed)
        precondition(glmDefaultSaved && app.settingsDraft == changed && app.catalog.defaults.modelId == changed.model)
        let unsupportedDefault = await app.saveCloudDefault(invalid)
        precondition(!unsupportedDefault && app.settingsDraft == changed && app.catalog.defaults.modelId == changed.model, "unsupported default changed cloud or local selection")
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
        let historicalBytes = try await app.bridge.download(oldModel.path)
        try await app.bridge.upload(historicalBytes, name: "history/bracket.step")
        await app.refreshFiles()
        guard let duplicateName = app.files.first(where: { $0.path == "history/bracket.step" }) else { fatalError("Missing same-name historical STEP") }
        await app.showFile(duplicateName)
        precondition(app.files.first(where: { $0.name == app.previewName })?.path == "bracket.step", "same-name export regression not exercised")
        let exactExport = try await app.currentModelExportData()
        precondition(exactExport.data == historicalBytes && WorkspaceBridge.hash(exactExport.data) != currentModel.sha256, "canvas export selected current file by basename instead of displayed path")
        let displayedOldModel = app.preview
        try await app.bridge.upload(Data("replaced historical STEP".utf8), name: duplicateName.path)
        do { _ = try await app.currentModelExportData(); fatalError("canvas exported replacement instead of refusing changed displayed revision") } catch { precondition(error.localizedDescription.contains("所看模型的文件已变化")) }
        precondition(app.preview == displayedOldModel, "failed export changed visible historical model")
        guard let stlFile = app.files.first(where: { $0.path == "bracket.stl" }) else { fatalError("Missing STL") }
        await app.showFile(stlFile)
        let displayedSTL = app.preview!
        try await app.bridge.upload(Data("replaced STL".utf8), name: stlFile.path)
        let stlExport = try await app.currentModelExportData()
        precondition(stlExport.data == displayedSTL, "STL export lost the exact displayed bytes")
        try await app.bridge.upload(displayedSTL, name: stlFile.path)
        await app.showArtifact(currentModel); await app.compareArtifact(oldModel)
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
        await app.refreshEngineering()
        try await fixture("/__test/rebuild-mode", ["mode": "match"])
        await app.refreshEngineering()
        guard let historicalVersion = app.engineeringCatalog?.commits.first(where: { $0.id == "history-80" }), let historicalManifest = app.rebuildManifest(for: historicalVersion) else { fatalError("Missing preserved source fixture") }
        app.selectVersion(historicalVersion.id); await app.showArtifact(historicalVersion.artifacts[0])
        let canvasBeforeRebuild = app.preview, draftBeforeRebuild = app.draft
        await app.rebuildVersion(historicalVersion)
        guard let rebuilt = app.rebuildResult, app.rebuildError == nil else { fatalError("Source rebuild failed: \(app.rebuildError ?? "unknown")") }
        precondition(rebuilt.sourceRevision == historicalVersion.sourceRevision && rebuilt.byteMatch && rebuilt.geometryMatch == true && rebuilt.parameters["width"] == .number(80), "historical rebuild lost saved source/parameters or compared another artifact")
        precondition(app.preview == canvasBeforeRebuild && app.draft == draftBeforeRebuild, "rebuild changed live preview or unsent draft")
        await app.showRebuiltVersion()
        precondition(app.selectedArtifact?.sha256 == rebuilt.actualSha256 && app.error == nil, "verified rebuilt output did not open")
        for scenario in ["byte-diff", "geometry-diff", "old-replaced"] {
            try await fixture("/__test/rebuild-mode", ["mode": scenario])
            await app.rebuildVersion(historicalVersion)
            guard let result = app.rebuildResult, app.rebuildError == nil else { fatalError("Rebuild scenario failed: \(scenario) \(app.rebuildError ?? "unknown")") }
            if scenario == "byte-diff" { precondition(!result.byteMatch && result.geometryMatch == true, "byte difference was called geometry difference") }
            if scenario == "geometry-diff" { precondition(!result.byteMatch && result.geometryMatch == false, "different dimensions were reported equal") }
            if scenario == "old-replaced" { precondition(result.byteMatch && result.geometryMatch == nil, "replaced historical file supported a geometry equivalence claim") }
        }
        for scenario in ["stale-manifest", "stale-version", "download-corrupt", "build-failure"] {
            try await fixture("/__test/rebuild-mode", ["mode": scenario])
            await app.rebuildVersion(historicalVersion)
            precondition(app.rebuildResult == nil && app.rebuildError != nil, "rebuild accepted stale/corrupt/failed result: \(scenario)")
        }
        for scenario in ["source-mismatch", "missing-source"] {
            try await fixture("/__test/rebuild-mode", ["mode": scenario]); await app.refreshEngineering()
            let version = app.engineeringCatalog!.commits.first { $0.id == "history-80" }!
            await app.rebuildVersion(version)
            precondition(app.rebuildResult == nil && app.rebuildError != nil, "rebuild used missing or mismatched recorded Git source: \(scenario)")
        }
        do { _ = try await EngineeringService(bridge: app.bridge, sessionID: "unbound-rebuild-conversation").rebuild(historicalVersion, manifest: historicalManifest); fatalError("Unbound conversation rebuilt another conversation's version") } catch { precondition(error.localizedDescription.contains("Conversation has no workflow")) }
        try await fixture("/__test/rebuild-mode", ["mode": "off"])
        app.selectVersion(nil)
        precondition(app.rebuildResult == nil && app.rebuildError == nil && !app.rebuildBusy, "switching versions retained another version's rebuild result")
        await app.refreshEngineering()
        guard let reviewModel = app.engineeringCatalog?.currentRun?.artifacts.first,
              let unreviewedVersion = app.engineeringCatalog?.commits.first else { fatalError("Missing review candidate") }
        let deniedApproval = await app.approveVersion(unreviewedVersion.id, scope: "E2E fixture only", reason: "Before review must fail")
        precondition(deniedApproval == nil && app.approvalError != nil && app.approvals.isEmpty, "native approval bypassed independent review prerequisite")
        await app.showArtifact(reviewModel)
        app.draft = "未发送的审查草稿"
        let reviewBytes = try await app.bridge.download(reviewModel.path)
        try await app.bridge.upload(Data("changed candidate".utf8), name: reviewModel.path)
        await app.submitIndependentReview()
        precondition(!app.generating && app.error == "候选模型已变化，请重新读取工程结果" && app.draft == "未发送的审查草稿", "changed candidate submitted for review or lost draft")
        try await app.bridge.upload(reviewBytes, name: reviewModel.path)
        await app.submitIndependentReview()
        try await wait({ !app.generating && app.engineeringCatalog?.commits.first?.acceptanceSummary?.requirements.contains { $0.category == "machine" && $0.status == "verified" } == true }, "independent review updates exact candidate acceptance")
        precondition(app.draft == "未发送的审查草稿", "review submission replaced unsent draft")
        guard let reviewedVersion = app.engineeringCatalog?.commits.first,
              let evidenceRecord = reviewedVersion.acceptanceSummary?.requirements.first?.evidence,
              let evidenceRun = app.workflowRun else { fatalError("Missing review evidence") }
        await app.readEvidence(evidenceRecord)
        precondition(app.evidenceError == nil && app.evidence?.sha256 == evidenceRecord.sha256 && app.evidence?.value["result"]?["verdict"]?.stringValue == "pass" && app.evidence?.bindingVerified == true, "native evidence did not validate exact immutable transaction bytes")
        let savedEvidence = app.evidence
        try await fixture("/__test/evidence-tamper", ["enabled": "true"])
        await app.readEvidence(evidenceRecord)
        precondition(app.evidenceError != nil && app.evidence?.sha256 == savedEvidence?.sha256, "corrupt transaction substituted unverified evidence")
        try await fixture("/__test/evidence-tamper", ["enabled": "false"])
        var wrongRun = try JSONSerialization.jsonObject(with: JSONEncoder().encode(evidenceRun)) as! [String: Any]
        wrongRun["workflowHash"] = "wrong-workflow"
        do { _ = try await app.engineering.evidence(evidenceRecord, run: JSONDecoder().decode(WorkflowRun.self, from: JSONSerialization.data(withJSONObject: wrongRun))); fatalError("Evidence escaped pinned workflow") } catch { precondition(error.localizedDescription.contains("工作流已变化")) }
        do { _ = try await EngineeringService(bridge: app.bridge, sessionID: nil).evidence(evidenceRecord, run: evidenceRun); fatalError("Unbound conversation read another run's evidence") } catch { precondition(error.localizedDescription.contains("工作流已变化") || (error as? AuthorityError)?.code == "CONVERSATION_UNBOUND") }
        await app.readEvidence(evidenceRecord)
        precondition(app.evidenceError == nil)
        let legacyEvidence = try JSONDecoder().decode(AcceptanceSummary.Requirement.Evidence.self, from: JSONSerialization.data(withJSONObject: ["path": evidenceRecord.path]))
        let legacyRead = try await app.engineering.evidence(legacyEvidence, run: evidenceRun)
        precondition(!legacyRead.bindingVerified && legacyRead.declaredSHA256 == nil && legacyRead.contentSHA256.count == 64, "legacy review fabricated a version digest or skipped transaction verification")
        let geometryEnvelope: [String: Any] = ["schema": 1, "ok": true, "payload": ["bbox": ["x": 80, "y": 40, "z": 30], "volume": 9600], "artifacts": []]
        // Obtain the real stored geometry record; its declared digest covers the
        // canonical envelope, not the wrapper bytes shown in the evidence view.
        let geometryRecord: JSONValue = try await app.engineering.request("evidence-read", fields: ["path": "evidence/geometry/fixture.json"])
        precondition(geometryRecord["envelope"]?.foundationValue as? NSDictionary == geometryEnvelope as NSDictionary)
        let geometryEvidence = try JSONDecoder().decode(AcceptanceSummary.Requirement.Evidence.self, from: JSONSerialization.data(withJSONObject: ["path": "evidence/geometry/fixture.json", "sha256": geometryRecord["evidence"]?["sha256"]!.stringValue!]))
        let geometryRead = try await app.engineering.evidence(geometryEvidence, run: evidenceRun)
        precondition(geometryRead.bindingVerified && geometryRead.sha256 == geometryEvidence.sha256 && geometryRead.sha256 != geometryRead.contentSHA256, "geometry envelope digest was mistaken for wrapper file digest")
        let wrongEvidence = try JSONDecoder().decode(AcceptanceSummary.Requirement.Evidence.self, from: JSONSerialization.data(withJSONObject: ["path": geometryEvidence.path, "sha256": String(repeating: "0", count: 64)]))
        do { _ = try await app.engineering.evidence(wrongEvidence, run: evidenceRun); fatalError("Evidence accepted a different saved version digest") } catch { precondition(error.localizedDescription.contains("证据内容与此版本记录不一致")) }
        let emptyApproval = await app.approveVersion(reviewedVersion.id, scope: "", reason: "")
        precondition(emptyApproval == nil && app.approvalError != nil && app.approvals.isEmpty, "approval omitted scope or rationale")
        guard let approval = await app.approveVersion(reviewedVersion.id, scope: "E2E fixture only", reason: "Test the native store; no manufacturing approval") else { fatalError("Approval failed: \(app.approvalError ?? "unknown")") }
        precondition(approval.valid && approval.commitId == reviewedVersion.id && approval.workflowHash == reviewedVersion.workflowHash && approval.sourceRevision == reviewedVersion.sourceRevision && approval.approver.id == NSUserName() && approval.approver.type == "local-os-user", "approval lost local OS identity or exact version binding")
        let approvalFiles = try FileManager.default.contentsOfDirectory(at: app.approvalRoot, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        precondition(approvalFiles.count == 1)
        let permissions = try FileManager.default.attributesOfItem(atPath: approvalFiles[0].path)[.posixPermissions] as! NSNumber
        precondition(permissions.intValue == 0o600, "approval file not private to OS user")
        let catalogForReload = try await app.engineering.requestEnvelope("viewer-catalog")
        let reloadedApprovals: [HumanApprovalRecord] = try await NativeApprovals().request("list", catalogEnvelope: catalogForReload, root: app.approvalRoot)
        precondition(reloadedApprovals.contains { $0.id == approval.id && $0.valid }, "approval did not survive a fresh native component")
        let releaseFolder = FileManager.default.temporaryDirectory.appendingPathComponent("reify-release-flow-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: releaseFolder, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: releaseFolder) }
        await app.releaseVersion(approval, to: releaseFolder)
        guard let savedRelease = app.releaseURL, app.releaseError == nil else { fatalError("Native release failed: \(app.releaseError ?? "unknown")") }
        let packageManifest = try JSONSerialization.jsonObject(with: Data(contentsOf: savedRelease.appendingPathComponent("release-manifest.json"))) as! [String: Any]
        precondition(packageManifest["approvalId"] as? String == approval.id && packageManifest["commitId"] as? String == reviewedVersion.id)
        let releasedStep = try Data(contentsOf: savedRelease.appendingPathComponent("files/bracket.step"))
        precondition(releasedStep == reviewBytes, "release downloaded different candidate bytes")
        let packageFiles = packageManifest["files"] as! [[String: String]]
        for file in packageFiles { let bytes = try Data(contentsOf: savedRelease.appendingPathComponent(file["path"]!)); precondition(WorkspaceBridge.hash(bytes) == file["sha256"]!) }
        await app.releaseVersion(approval, to: releaseFolder)
        precondition(app.releaseError == nil && app.releaseURL == savedRelease, "same approved release could not reuse exact saved package")
        try Data("changed local package".utf8).write(to: savedRelease.appendingPathComponent("files/bracket.step"))
        await app.releaseVersion(approval, to: releaseFolder)
        precondition(app.releaseURL == nil && app.releaseError == "已保存的文件包被修改，未覆盖", "release overwrote modified local package")
        try reviewBytes.write(to: savedRelease.appendingPathComponent("files/bracket.step"))
        let writableProject = app.selected
        var readOnlyRelease = try JSONSerialization.jsonObject(with: JSONEncoder().encode(app.selected!)) as! [String: Any]; readOnlyRelease["role"] = "viewer"
        app.selected = try JSONDecoder().decode(Project.self, from: JSONSerialization.data(withJSONObject: readOnlyRelease))
        await app.releaseVersion(approval, to: releaseFolder)
        precondition(!app.releaseBusy && app.releaseURL == nil, "read-only project started release")
        app.selected = writableProject
        try await fixture("/__test/release-mode", ["mode": "delay-validation"])
        let cancelledRelease = Task { await app.releaseVersion(approval, to: releaseFolder) }
        try await waitReleaseCheck(app.api.baseURL, count: 2)
        await app.cancelRelease(); await cancelledRelease.value
        precondition(app.releaseURL == nil && !app.releaseBusy && app.releaseError == "已取消发布", "cancelled package completed")
        try await fixture("/__test/release-mode", ["mode": "corrupt-final"])
        await app.releaseVersion(approval, to: releaseFolder)
        precondition(app.releaseURL == nil && app.releaseError?.contains("发布文件校验失败") == true, "reused cloud package accepted corrupt file bytes")
        try await fixture("/__test/release-mode", ["mode": "rewritten-manifest"])
        await app.releaseVersion(approval, to: releaseFolder)
        precondition(app.releaseURL == nil && app.releaseError == "文件包与批准版本不一致", "rewritten cloud manifest substituted another artifact under an unchanged approval")
        try await fixture("/__test/release-mode", ["mode": "normal"])
        try await fixture("/__test/approval-version", ["version": "2"])
        await app.refreshEngineering()
        precondition(app.approvals.first { $0.id == approval.id }?.valid == false, "changed source version kept prior approval valid")
        let staleApproval = await app.approveVersion(reviewedVersion.id, scope: "E2E fixture only", reason: "Stale form must fail", expected: reviewedVersion)
        precondition(staleApproval == nil && app.approvalError == "版本已变化，请重新打开批准窗口" && app.approvals.count == 1, "stale form approved a different version")
        try await fixture("/__test/approval-version", ["version": "1"])
        await app.refreshEngineering()
        await app.revokeApproval(approval.id, reason: "")
        precondition(app.approvalError != nil && app.approvals.first { $0.id == approval.id }?.revokedAt == nil, "revocation omitted reason")
        try await fixture("/__test/release-mode", ["mode": "delay-validation"])
        let revokedRelease = Task { await app.releaseVersion(approval, to: releaseFolder) }
        try await waitReleaseCheck(app.api.baseURL, count: 2)
        await app.revokeApproval(approval.id, reason: "E2E revoke this test-only approval")
        await revokedRelease.value
        precondition(app.releaseURL == nil && app.releaseError != nil, "approval revoked during preparation still completed a release")
        precondition(app.approvalError == nil && app.approvals.first { $0.id == approval.id }?.valid == false && app.approvals.first { $0.id == approval.id }?.revokedAt != nil, "approval revocation did not persist")
        // Model a record made by another OS user within this disposable test store.
        var records = try JSONSerialization.jsonObject(with: Data(contentsOf: approvalFiles[0])) as! [[String: Any]]
        var another = records[0]; another["id"] = "other-os-user-record"; another["approver"] = ["type": "local-os-user", "id": "fixture-other-user"]; another.removeValue(forKey: "revokedAt"); another.removeValue(forKey: "revocationReason"); another["valid"] = true; records.append(another)
        try JSONSerialization.data(withJSONObject: records).write(to: approvalFiles[0], options: .atomic)
        await app.revokeApproval("other-os-user-record", reason: "Must refuse another OS user's approval")
        precondition(app.approvalError?.contains("Only the verified approving OS user") == true, "native component revoked another OS user's approval")
        await app.refreshApprovals()
        precondition(app.approvals.first { $0.id == "other-os-user-record" }?.revokedAt == nil)
        let spawnAfterRelease = app.bridge.spawnID, sessionAfterRelease = app.sessionID
        try await fixture("/__test/drop")
        try await wait({ app.reconnecting || !app.connected }, "release process reconnect begins")
        try await wait({ app.connected && !app.reconnecting && app.bridge.spawnID == spawnAfterRelease && app.sessionID == sessionAfterRelease }, "release jobs leave the original conversation process alive")
        let repliesAfterRelease = app.messages.filter { $0.role == "assistant" }.count
        await app.send("发布检查后继续对话")
        try await wait({ !app.generating && app.messages.filter { $0.role == "assistant" }.count > repliesAfterRelease }, "conversation continues after cancelled and rejected release jobs")
        // Publish only to a disposable bare Git repository. No external remote.
        try await wait({ !app.engineeringLoading }, "last turn engineering refresh completes before changing the test source version")
        try await fixture("/__test/release-mode", ["mode": "normal"])
        try await fixture("/__test/publish-mode", ["mode": "normal", "projectId": project.id])
        await app.refreshEngineering()
        let gitCatalog = try await app.engineering.catalog()
        guard let gitVersion = gitCatalog.commits.first,
              let gitApproval = await app.approveVersion(gitVersion.id, scope: "Disposable E2E repository only", reason: "Verify tags; no manufacturing or real repository publication", expected: gitVersion) else { fatalError("Missing Git-backed test approval: \(app.approvalError ?? "unknown")") }
        let gitPackageFolder = FileManager.default.temporaryDirectory.appendingPathComponent("reify-git-package-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: gitPackageFolder, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: gitPackageFolder) }
        await app.releaseVersion(gitApproval, to: gitPackageFolder)
        guard let gitPackage = app.releaseURL, let gitRelease = app.savedRelease, app.releaseError == nil else { fatalError("Git test package failed: \(app.releaseError ?? "unknown")") }
        func policy(enabled: Bool, server: String? = nil, remotes: [String] = ["origin"]) throws {
            let value: [String: Any] = ["mode": "cloud", "cloud": ["baseUrl": server ?? app.api.baseURL], "remotePublish": ["enabled": enabled, "allowedRemotes": remotes]]
            try JSONSerialization.data(withJSONObject: value).write(to: testPolicyURL, options: .atomic)
        }
        try policy(enabled: false)
        await app.publishRelease(remote: "origin", tag: "reify/disabled")
        precondition(app.publishedTag == nil && app.publishError == "管理员未启用 Git 标签发布" && app.releaseURL == gitPackage)
        try policy(enabled: true, server: "https://another.reify.test")
        await app.publishRelease(remote: "origin", tag: "reify/wrong-server")
        precondition(app.publishError == "发布配置属于另一台服务器" && app.releaseURL == gitPackage)
        try policy(enabled: true)
        await app.publishRelease(remote: "not-allowed", tag: "reify/wrong-remote")
        precondition(app.publishError == "管理员未允许此远程仓库" && app.releaseURL == gitPackage)
        for tag in ["bad tag", "../wrong", "-wrong", "reify/"] {
            await app.publishRelease(remote: "origin", tag: tag)
            precondition(app.publishedTag == nil && app.publishError != nil && app.releaseURL == gitPackage, "invalid tag published or removed complete local package")
        }
        await app.publishRelease(remote: "origin", tag: "reify/e2e")
        guard let published = app.publishedTag, app.publishError == nil else { fatalError("Real Git tag publish failed: \(app.publishError ?? "unknown")") }
        precondition(published.sourceRevision == gitVersion.sourceRevision && !published.reused && !published.packageUploaded && app.releaseURL == gitPackage)
        await app.publishRelease(remote: "origin", tag: "reify/e2e")
        precondition(app.publishedTag?.reused == true && app.publishError == nil && app.releaseURL == gitPackage, "same exact remote tag was not reused")
        for tag in ["reify/remote-conflict", "reify/local-conflict"] {
            await app.publishRelease(remote: "origin", tag: tag)
            precondition(app.publishedTag == nil && app.publishError?.contains("already exists") == true && app.releaseURL == gitPackage, "conflicting Git tag overwritten or package lost")
        }
        try await fixture("/__test/publish-mode", ["mode": "manifest-changed"])
        await app.publishRelease(remote: "origin", tag: "reify/changed-manifest")
        precondition(app.publishedTag == nil && app.publishError?.contains("云端文件包清单已变化") == true && app.releaseURL == gitPackage)
        try await fixture("/__test/publish-mode", ["mode": "push-failure"])
        await app.publishRelease(remote: "origin", tag: "reify/push-failed")
        precondition(app.publishedTag == nil && app.publishError != nil && app.releaseURL == gitPackage, "failed Git push lost complete local package")
        try await fixture("/__test/publish-mode", ["mode": "normal"])
        await app.publishRelease(remote: "origin", tag: "reify/push-failed")
        precondition(app.publishedTag != nil && app.publishError == nil && app.releaseURL == gitPackage, "retry after rejected push did not use saved source version")
        let packageStepURL = gitPackage.appendingPathComponent("files/bracket.step"), packageStep = try Data(contentsOf: gitPackage.appendingPathComponent("files/bracket.step"))
        try Data("changed local package".utf8).write(to: packageStepURL)
        await app.publishRelease(remote: "origin", tag: "reify/corrupt-local")
        precondition(app.publishedTag == nil && app.publishError == "本机文件包已变化，未发布标签" && app.releaseURL == gitPackage)
        try packageStep.write(to: packageStepURL)
        app.permission = "read-only"; app.publishError = nil
        await app.publishRelease(remote: "origin", tag: "reify/read-only")
        precondition(app.publishedTag == nil && !app.publishBusy && app.publishError == nil && app.releaseURL == gitPackage)
        app.permission = "workspace"
        do { _ = try await EngineeringService(bridge: app.bridge, sessionID: "unbound-tag-conversation").publishTag(gitRelease, remote: "origin", tag: "reify/unbound", policy: JSONEncoder().encode(app.publishPolicy), manifestSHA: WorkspaceBridge.hash(try Data(contentsOf: gitPackage.appendingPathComponent("release-manifest.json"))), sourceRevision: gitApproval.sourceRevision); fatalError("Unbound conversation published another version") } catch { precondition(error.localizedDescription.contains("Conversation has no workflow")) }
        await app.revokeApproval(gitApproval.id, reason: "Revoke disposable Git publication approval")
        await app.publishRelease(remote: "origin", tag: "reify/revoked")
        precondition(app.publishedTag == nil && app.publishError?.contains("批准已撤销") == true && app.releaseURL == gitPackage)
        try await tracesE2E(app)
        try await fusionE2E(app)
        try await fixture("/__test/expire")
        await app.refreshProjects()
        precondition(app.user == nil && app.api.session == nil && !app.connected && app.error == "登录已失效，请重新登录。" && app.messages.isEmpty && app.projects.isEmpty && app.catalog.providers.isEmpty, "expired session stayed signed in")
        await app.shutdown()
        try await app.api.logout()
        print("PASS: native cloud defaults synchronize catalog/current/persisted/runtime model without saving unrelated drafts; configuration refresh preserves content; cloud and runtime failures are explicit; canvas exports exact same-name historical STEP and refuses replaced revisions, STL retains displayed bytes")
        print("PASS: original desktop Git tag publisher over native HTTP/WebSocket, real disposable Git/bare remote, saved source revision, default-disabled/server-bound/allowed-remote policy, invalid tags, reuse, local/remote conflicts, manifest/package tamper refusal, push failure/retry, read-only/unbound/revoked approval refusal and complete local package preservation")
        print("PASS: original desktop historical rebuild over native HTTP/WebSocket, real isolated Git worktrees and recorded source hashes/parameters, byte and bounding-box/solid comparisons, replaced-original refusal, stale manifests/versions, missing/mismatched source, failed build, corrupt download and unbound conversation refusal")
        print("PASS: original desktop cloud release backend with live native approval callbacks, exact manifest/file downloads, same-package reuse, local/cloud corruption refusal, read-only refusal, cancellation and revoke during preparation")
        print("PASS: exact-candidate independent review prompt, original desktop approval store in native JavaScriptCore, machine prerequisite, scope/reason, OS identity, private atomic persistence, reload, stale-version invalidation, reasoned revoke and other-user refusal, immutable transaction evidence verification/tamper/pinned-workflow/unbound refusal; generated/uploaded concept board state, exact-image and region/note/full-image prompt payload, outdated/invalid-region refusal, preserved draft and conversation isolation; native desktop STEP importer reuse/conflict, filtered current/shared/history catalog, exact-revision comparison and parameter differences, verified Finder cache, new model notification and completed-turn auto preview; compiled native AppModel over HTTP/WebSocket, native GLM model settings and unsupported thinking rollback, editable queue drains exactly once, local notes, new/switch conversation draft and engineering isolation, image upload and prompt payload")
        print("PASS: settings load cannot close a newly selected project bridge, workspace queue position, startup failure and retry, expired login clears native account and connection")
        print("PASS: disconnect during a live task resumes it, suspends queued input, allows abort, and never restarts an idle-paused workspace")
        print("PASS: automatic native reconnect reattaches the same process/session, preserves drafts and never repeats prompts or starts the workspace")
        print("PASS: live and restored desktop tool cards, image deduplication, simulation metrics, sandbox artifact paths, stable note identity, retry/thinking phases and terminal failure")
        print("PASS: generated artifact selects its parameter manifest, native parameter preview/restore, failed apply restores original preview, successful apply refreshes model and values")
    }
}
