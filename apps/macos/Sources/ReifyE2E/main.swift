import Foundation
import ReifyCloud

@main struct E2E {
    @MainActor static func main() async throws {
        let env = ProcessInfo.processInfo.environment
        let api = CloudAPI(baseURL: env["REIFY_CLOUD_URL"] ?? "http://127.0.0.1:18765", scope: "e2e-api")
        try await api.logout()
        do {
            try await api.login(email: "e2e@reify.test", password: "wrong-password", server: api.baseURL)
            fatalError("wrong password accepted")
        } catch let error as CloudError { precondition(error.status == 401) }
        do { _ = try CloudAPI.validatedURL("http://example.com"); fatalError("insecure remote server accepted") }
        catch let error as CloudError { precondition(error.message == "请填写 HTTPS 服务器地址") }
        try await api.login(email: "e2e@reify.test", password: "fixture-password", server: api.baseURL)
        let projects = try await api.projects()
        precondition(!projects.isEmpty)
        let project = try await api.createProject("Swift E2E")
        let renamed = try await api.renameProject(project.id, name: "Swift E2E renamed")
        precondition(renamed.name == "Swift E2E renamed")
        let disposable = try await api.createProject("Delete fixture only")
        try await api.deleteProject(disposable.id)
        let afterDelete = try await api.projects()
        precondition(!afterDelete.contains { $0.id == disposable.id })
        do { try await api.changePassword(old: "wrong-password", new: "fixture-new-password"); fatalError("wrong old password accepted") }
        catch let error as CloudError { precondition(error.status == 401) }
        try await api.changePassword(old: "fixture-password", new: "fixture-new-password")
        var workspace = try await api.workspace("start")
        for _ in 0..<20 where workspace.state != "running" {
            try await Task.sleep(for: .milliseconds(100))
            workspace = try await api.workspace()
        }
        precondition(workspace.state == "running")
        let bridge = WorkspaceBridge()
        try await bridge.openServices(api: api)
        let library = WorkflowLibrary(bridge: bridge)
        let builtins = try await library.list()
        precondition(builtins.contains { $0.id == "mechanical.naked" && !$0.editable })
        let source = """
        schema: 1
        id: native.e2e
        description: E2E disposable workflow
        tags: [custom]
        version: 1.0.0
        workflow:
          schema: 1
          id: native.e2e
          version: 1.0.0
          parametersSchema: {type: object, additionalProperties: false}
          initialPhase: work
          phases:
            work:
              purpose: Complete test
              actions: [transition]
              grants: [file_read, transition]
              writeScopes: []
              recordObligations: []
              evidenceObligations: []
              contextProviders: [kernel.current-action]
              hooks: []
              transitions: {finished: {target: done}}
            done:
              purpose: Preserve result
              actions: []
              grants: [file_read]
              writeScopes: []
              recordObligations: []
              evidenceObligations: []
              contextProviders: [kernel.current-action]
              hooks: []
              transitions: {}
              terminal: true
        """
        let savedWorkflow = try await library.save(source)
        precondition(savedWorkflow.id == "native.e2e" && savedWorkflow.phases.count == 2 && savedWorkflow.sourceHash != nil)
        do { _ = try await library.save(source); fatalError("duplicate workflow overwritten") } catch {}
        do { _ = try await library.save(source.replacingOccurrences(of: "target: done", with: "target: missing"), original: savedWorkflow); fatalError("invalid transition accepted by desktop validator") } catch {}
        let afterRejectedWorkflow = try await library.list()
        precondition(afterRejectedWorkflow.first { $0.id == savedWorkflow.id }?.raw == source, "validation failure changed workflow")
        let updatedWorkflow = try await library.save(source.replacingOccurrences(of: "version: 1.0.0", with: "version: 1.1.0"), original: savedWorkflow)
        do { _ = try await library.save(source, original: savedWorkflow); fatalError("stale edit overwrote workflow") } catch {}
        do { try await library.delete(builtins.first { $0.id == "mechanical.naked" }!); fatalError("builtin workflow deleted") } catch {}
        try await library.adopt(updatedWorkflow, identity: "fixture-only-user")
        let adoptedWorkflows = try await library.list()
        precondition(adoptedWorkflows.first { $0.id == updatedWorkflow.id }?.adopted == true)
        try await library.delete(updatedWorkflow)
        let afterWorkflowDelete = try await library.list()
        precondition(!afterWorkflowDelete.contains { $0.id == "native.e2e" })
        let config = PrimeConfiguration(bridge: bridge)
        let initialCatalog = try await config.catalog()
        precondition(initialCatalog.providers.contains { $0.id == "custom" && $0.auth.configured == false })
        precondition(initialCatalog.model(provider: "zai", id: "glm-5.3-flash")?.normalized("medium") == "high")
        _ = try await config.setKey(provider: "custom", key: "fixture-only-key")
        let keyed = try await config.catalog()
        precondition(keyed.model(provider: "custom", id: "custom-chat")?.available == true)
        try await config.saveDefault(provider: "custom", model: "custom-chat", thinking: "off")
        try await config.saveFavorites([ModelFavorite(provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: "high")])
        let savedCatalog = try await config.catalog()
        precondition(savedCatalog.defaults.modelId == "custom-chat" && savedCatalog.favorites.first?.id == "zai/glm-5.3-flash")
        let valid = try await config.writeModels("{\"providers\": {}}")
        do { _ = try await config.writeModels("{broken"); fatalError("invalid custom models accepted") } catch {}
        let preservedConfig = try await config.readModels()
        precondition(preservedConfig == valid, "failed validation changed custom providers")
        try await config.removeCredential(provider: "custom")
        let removed = try await config.catalog()
        precondition(removed.model(provider: "custom", id: "custom-chat")?.available == false)
        try await config.removeCredential(provider: "openai-codex")
        var authComplete = false, authNeedsInput = false
        let auth = try await bridge.startProcess(["/opt/reify/node/bin/node", "/opt/reify/pi-cad/scripts/desktop-openai-oauth.mjs", "/opt/reify/prime-agent", "/workspace/home/.prime/agent", "openai-codex"], onEvent: { row in
            if row["type"] as? String == "auth_input" { authNeedsInput = true }
            if row["type"] as? String == "auth_complete" { authComplete = true }
        }, onExit: { _ in })
        for _ in 0..<30 where !authNeedsInput { try await Task.sleep(for: .milliseconds(50)) }
        precondition(authNeedsInput)
        try await auth.write("fixture-code")
        for _ in 0..<30 where !authComplete { try await Task.sleep(for: .milliseconds(50)) }
        precondition(authComplete && auth.finished)
        let loggedIn = try await config.catalog()
        precondition(loggedIn.providers.first { $0.id == "openai-codex" }?.auth.configured == true)
        try await bridge.connect(api: api, project: project, provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal")
        _ = try await bridge.rpc("prompt", payload: ["message": "创建一个支架"])
        try await Task.sleep(for: .milliseconds(500))
        let messages = try await bridge.rpc("get_messages")
        precondition(!ChatMessage.decode(messages["messages"] as? [[String: Any]] ?? []).isEmpty)
        let mesh = try await bridge.previewStep("bracket.step")
        let document = try JSONSerialization.jsonObject(with: mesh) as? [String: Any]
        precondition(document?["parts"] != nil)
        let assembly = try MeshModel.read(mesh)
        precondition(assembly.parts.count == 2 && assembly.assembly.count == 2, "assembly was flattened")
        precondition(assembly.assembly[0].id == "occ-base" && assembly.parts[0].solidId == "solid-base" && assembly.parts[0].features != nil && assembly.parts[0].datums != nil)
        precondition(assembly.identityBound == true && assembly.reference(assembly.assembly[1]).contains("occurrenceId=occ-support") && assembly.reference(assembly.assembly[1]).contains("stepSha256=" + (assembly.sha256 ?? "")))
        let boundMesh = try await bridge.previewStep("bracket.step", expectedSHA: assembly.sha256!)
        let boundModel = try MeshModel.read(boundMesh)
        precondition(boundModel.sha256 == assembly.sha256)
        do { _ = try await bridge.previewStep("bracket.step", expectedSHA: String(repeating: "0", count: 64)); fatalError("changed source preview accepted") } catch {}
        let stl = try await bridge.download("bracket.stl")
        let anonymous = try MeshModel.read(stl)
        precondition(anonymous.identityBound == false && anonymous.parts.count == 1 && anonymous.assembly[0].solidIDs.isEmpty)
        let bytes = Data("ISO-10303-21; E2E".utf8)
        try await bridge.upload(bytes, name: "sample.step")
        let files = try await bridge.files()
        precondition(files.contains { $0.name == "sample.step" })
        let downloaded = try await bridge.download("sample.step")
        precondition(downloaded == bytes)
        let engineeringA = EngineeringService(bridge: bridge, sessionID: "engineering-a")
        let engineeringB = EngineeringService(bridge: bridge, sessionID: "engineering-b")
        let runA = try await engineeringA.workflow(), runB = try await engineeringB.workflow()
        precondition(runA?.runId != runB?.runId && runA?.runId == "run-engineering-a")
        let catalogA = try await engineeringA.catalog(), catalogB = try await engineeringB.catalog()
        precondition(catalogA.commits.first?.id == "commit-engineering-a" && catalogB.commits.first?.id == "commit-engineering-b")
        precondition(catalogA.currentRun?.artifacts.first?.path == "bracket.step" && catalogB.currentRun?.artifacts.first?.path == "sample.step")
        let unbound = EngineeringService(bridge: bridge, sessionID: nil)
        let unboundRun = try await unbound.workflow(), unboundCatalog = try await unbound.catalog()
        precondition(unboundRun == nil && unboundCatalog.currentRun == nil && unboundCatalog.commits.isEmpty, "new conversation inherited another run")
        do { let _: WorkflowRun? = try await EngineeringService(bridge: bridge, sessionID: "authority-error").workflow(); fatalError("authority rejection discarded") }
        catch let failure as AuthorityError { precondition(failure.code == "PHASE_DENIED" && failure.target == "cad_build_step" && failure.hints == ["Open the current workflow"] && failure.message != "node warning") }
        do { _ = try bridge.relativeProjectPath("/workspace/projects/another/secret.step"); fatalError("foreign project path accepted") } catch {}
        do { _ = try await bridge.download("../secret"); fatalError("path traversal accepted") } catch let error as CloudError { precondition(error.message == "文件路径无效") }
        do { _ = try await bridge.download("corrupt.stl"); fatalError("corrupt checksum accepted") } catch let error as CloudError { precondition(error.message == "下载校验失败") }
        let before = bridge.spawnID
        var disconnected = false
        bridge.onDisconnect = { _ in disconnected = true }
        _ = try await URLSession.shared.data(from: URL(string: api.baseURL + "/__test/drop")!)
        for _ in 0..<50 where !disconnected { try await Task.sleep(for: .milliseconds(100)) }
        precondition(disconnected)
        try await bridge.connect(api: api, project: project, provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal")
        precondition(bridge.spawnID == before, "reconnect spawned a duplicate sidecar")
        let resumed = try await bridge.rpc("get_messages")
        precondition(ChatMessage.decode(resumed["messages"] as? [[String: Any]] ?? []).count == ChatMessage.decode(messages["messages"] as? [[String: Any]] ?? []).count)
        bridge.close(preserveSpawn: true)
        let relaunched = WorkspaceBridge()
        try await relaunched.connect(api: api, project: project, provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal")
        precondition(relaunched.spawnID == before, "app relaunch spawned a duplicate sidecar")
        let stoppingAt = Date()
        await relaunched.stop()
        precondition(Date().timeIntervalSince(stoppingAt) >= 0.18, "stop returned before the delayed exit acknowledgement")
        try await bridge.connect(api: api, project: project, provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal")
        precondition(bridge.spawnID != before, "stale spawn identity was reused after exit")
        _ = try await bridge.rpc("abort")
        await bridge.stop()
        try await bridge.connect(api: api, project: project, provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal")
        let restoredMessages = try await bridge.rpc("get_messages")
        precondition(ChatMessage.decode(restoredMessages["messages"] as? [[String: Any]] ?? []).count == ChatMessage.decode(messages["messages"] as? [[String: Any]] ?? []).count)
        _ = try await bridge.rpc("prompt", payload: ["message": "模拟模型错误"])
        let failedMessages = try await bridge.rpc("get_messages")
        precondition(ChatMessage.decode(failedMessages["messages"] as? [[String: Any]] ?? []).last?.text.contains("测试模型服务不可用") == true, "model failures disappeared from conversation")
        let history = try await bridge.conversations()
        precondition(!history.isEmpty)
        _ = try await bridge.rpc("new_session")
        let emptyHistory = try await bridge.rpc("get_messages")
        precondition(ChatMessage.decode(emptyHistory["messages"] as? [[String: Any]] ?? []).isEmpty)
        try await bridge.switchConversation(history[0].path)
        let switched = try await bridge.rpc("get_messages")
        precondition(ChatMessage.decode(switched["messages"] as? [[String: Any]] ?? []).count == ChatMessage.decode(failedMessages["messages"] as? [[String: Any]] ?? []).count)
        _ = try await bridge.rpc("set_model", payload: ["provider": "zai", "modelId": "glm-5.3-flash"])
        _ = try await bridge.rpc("set_thinking_level", payload: ["level": "high"])
        let actual = try await bridge.rpc("get_state")
        precondition((actual["model"] as? [String: Any])?["id"] as? String == "glm-5.3-flash" && actual["thinkingLevel"] as? String == "high")
        var dialogDone = false
        bridge.onEvent = { row in
            if row["type"] as? String == "agent_end" { dialogDone = true }
            guard row["type"] as? String == "extension_ui_request", let id = row["id"] as? String else { return }
            let method = row["method"] as? String
            let response: [String: Any] = method == "confirm" ? ["value": true] : method == "editor" ? ["value": (row["prefill"] as? String ?? "") + "\n补充"] : method == "input" ? ["value": (row["prefill"] as? String ?? "") + "20"] : ["value": "方案二"]
            Task { do { try await bridge.respond(id, response: response) } catch { fatalError("extension UI answer failed: \(error)") } }
        }
        _ = try await bridge.rpc("prompt", payload: ["message": "弹窗协议测试"])
        for _ in 0..<50 where !dialogDone { try await Task.sleep(for: .milliseconds(50)) }
        precondition(dialogDone, "extension UI did not unblock the Agent")
        let answered = try await bridge.rpc("get_messages")
        precondition(ChatMessage.decode(answered["messages"] as? [[String: Any]] ?? []).last?.text == "弹窗协议测试完成")
        await bridge.stop()
        try await bridge.connect(api: api, project: project, provider: "zai", model: "glm-5.3-flash", thinking: "high", reviewer: ReviewerSelection(mode: "fixed", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "max"), permission: "read-only")
        await bridge.stop()
        let stopped = try await api.workspace("stop")
        precondition(["stopped", "stopping"].contains(stopped.state))
        let restored = CloudAPI(scope: "e2e-api")
        try restored.restore()
        precondition(restored.session != nil)
        try await restored.logout()
        print("PASS: wrong password, HTTPS boundary, login, refresh, projects, empty-body workspace actions, RPC, cloud STEP preview, upload, download, checksum, path boundary, reconnect and app relaunch without duplicate processes, stale spawn recovery, exit acknowledgement, saved session resume, model error in history, stop, Keychain restore/logout")
        print("PASS: project rename/delete, password validation, complete catalog and dynamic thinking, API key/remove credential, cloud defaults/favorites, custom providers validation preserves prior config, streamed OAuth/manual input, history list/switch, runtime model/thinking, confirm/editor/input/select answer protocol, independent reviewer and read-only startup")
        print("PASS: real desktop workflow compiler, library save/edit/adopt/delete, invalid transition preserves source, duplicate/stale edit rejection, builtin write boundary, conversation-scoped workflow and artifact catalogs, explicit null remains unbound, structured authority errors survive nonzero exit")
        print("PASS: cloud assembly parts, occurrence/solid identity, feature/datum preservation, revision-bound object reference, changed source preview rejection, anonymous STL retains anonymous identity")
    }
}
