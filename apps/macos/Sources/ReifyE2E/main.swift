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
        var workspace = try await api.workspace("start")
        for _ in 0..<20 where workspace.state != "running" {
            try await Task.sleep(for: .milliseconds(100))
            workspace = try await api.workspace()
        }
        precondition(workspace.state == "running")
        let bridge = WorkspaceBridge()
        try await bridge.connect(api: api, project: project, provider: "openai-codex", model: "gpt-5.6-sol", thinking: "minimal")
        _ = try await bridge.rpc("prompt", payload: ["message": "创建一个支架"])
        try await Task.sleep(for: .milliseconds(500))
        let messages = try await bridge.rpc("get_messages")
        precondition(!ChatMessage.decode(messages["messages"] as? [[String: Any]] ?? []).isEmpty)
        let mesh = try await bridge.previewStep("bracket.step")
        let document = try JSONSerialization.jsonObject(with: mesh) as? [String: Any]
        precondition(document?["parts"] != nil)
        let bytes = Data("ISO-10303-21; E2E".utf8)
        try await bridge.upload(bytes, name: "sample.step")
        let files = try await bridge.files()
        precondition(files.contains { $0.name == "sample.step" })
        let downloaded = try await bridge.download("sample.step")
        precondition(downloaded == bytes)
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
        await bridge.stop()
        let stopped = try await api.workspace("stop")
        precondition(["stopped", "stopping"].contains(stopped.state))
        let restored = CloudAPI(scope: "e2e-api")
        try restored.restore()
        precondition(restored.session != nil)
        try await restored.logout()
        print("PASS: wrong password, HTTPS boundary, login, refresh, projects, empty-body workspace actions, RPC, cloud STEP preview, upload, download, checksum, path boundary, reconnect and app relaunch without duplicate processes, stale spawn recovery, exit acknowledgement, saved session resume, model error in history, stop, Keychain restore/logout")
    }
}
