import Foundation
import AppKit
import ReifyCloud

struct SettingsDraft: Equatable {
    var provider: String
    var model: String
    var thinking: String
    var reviewer: ReviewerSelection
    var permission: String
}

extension AppModel {
    var configuration: PrimeConfiguration { PrimeConfiguration(bridge: bridge) }
    var settingsDraft: SettingsDraft {
        SettingsDraft(provider: provider, model: model, thinking: thinking, reviewer: reviewer, permission: permission)
    }
    func prepareConfiguration() async throws {
        guard user != nil else { throw CloudError("请先登录云端") }
        if bridge.isOpen { return }
        let current = generation, identity = user?.id
        var workspace = try await api.workspace("start")
        let deadline = Date().addingTimeInterval(600)
        while workspace.state != "running" {
            guard current == generation, user?.id == identity else { throw CancellationError() }
            if workspace.state == "failed" { throw CloudError(workspace.lastError ?? "工作区启动失败") }
            if Date() > deadline { throw CloudError("工作区启动超时") }
            try await Task.sleep(for: .seconds(2)); workspace = try await api.workspace()
        }
        guard current == generation, user?.id == identity else { throw CancellationError() }
        if bridge.isOpen { return }
        try await bridge.openServices(api: api, projectID: selected?.id)
    }
    func loadCloudModels() async {
        guard !configWorking else { return }
        let current = generation, identity = user?.id
        configWorking = true; configError = nil
        defer { configWorking = false }
        do {
            try await prepareConfiguration()
            let nextCatalog = try await configuration.catalog()
            let nextModels = try await configuration.readModels()
            guard current == generation, user?.id == identity else { return }
            catalog = nextCatalog; modelsConfig = nextModels
        } catch { if current == generation, !(error is CancellationError) { configError = error.localizedDescription } }
    }
    func configure(_ action: () async throws -> Void, notice: String) async {
        guard !configWorking else { return }
        let current = generation, identity = user?.id
        configWorking = true; configError = nil; configNotice = ""
        defer { configWorking = false }
        do {
            try await prepareConfiguration()
            guard current == generation, user?.id == identity else { return }
            try await action()
            guard current == generation, user?.id == identity else { return }
            let next = try await configuration.catalog()
            guard current == generation, user?.id == identity else { return }
            catalog = next; configNotice = notice
        } catch { if current == generation, !(error is CancellationError) { configError = error.localizedDescription } }
    }
    func applySettings(_ draft: SettingsDraft) async -> Bool {
        guard !reconnecting else { configError = "正在重连，请连接恢复后保存设置"; return false }
        guard !generating else { configError = "请先停止当前任务"; return false }
        configError = nil; configNotice = ""
        let old = settingsDraft
        do {
            guard let author = catalog.model(provider: draft.provider, id: draft.model), author.available == true else { throw CloudError("请先配置所选模型的账户") }
            guard author.levels.contains(draft.thinking) else { throw CloudError("所选模型不支持这个思考档位") }
            if draft.reviewer.mode == "fixed" {
                guard let reviewModel = catalog.model(provider: draft.reviewer.provider, id: draft.reviewer.model), reviewModel.available == true,
                      reviewModel.levels.contains(draft.reviewer.thinking) else { throw CloudError("请配置可用的审查模型和思考档位") }
            }
            if connected {
                if old.provider != draft.provider || old.model != draft.model {
                    _ = try await bridge.rpc("set_model", payload: ["provider": draft.provider, "modelId": draft.model])
                }
                do { _ = try await bridge.rpc("set_thinking_level", payload: ["level": draft.thinking]) }
                catch {
                    if old.provider != draft.provider || old.model != draft.model {
                        _ = try? await bridge.rpc("set_model", payload: ["provider": old.provider, "modelId": old.model])
                        _ = try? await bridge.rpc("set_thinking_level", payload: ["level": old.thinking])
                    }
                    throw error
                }
            }
            provider = draft.provider; model = draft.model; thinking = draft.thinking; reviewer = draft.reviewer; permission = draft.permission
            persistSettings()
            if connected && (old.reviewer != draft.reviewer || old.permission != draft.permission), let project = selected {
                await open(project)
                guard connected else { throw CloudError(error ?? "重新连接失败，设置已保存，请重试") }
            }
            configNotice = "设置已保存"; return true
        } catch { configError = error.localizedDescription; return false }
    }
    func persistSettings() {
        AppPreferences.current.set(provider, forKey: "provider"); AppPreferences.current.set(model, forKey: "model")
        AppPreferences.current.set(thinking, forKey: "thinking"); AppPreferences.current.set(permission, forKey: "permission")
        AppPreferences.current.set(try? JSONEncoder().encode(reviewer), forKey: "reviewer")
    }
    func signInProvider(_ source: String) async {
        guard oauthProcess == nil else { return }
        oauthProvider = source; oauthMessage = "正在启动登录…"; oauthURL = nil; oauthInput = nil; configError = nil
        do {
            try await prepareConfiguration()
            oauthProcess = try await bridge.startProcess([
                "/opt/reify/node/bin/node", "--use-env-proxy", "/opt/reify/pi-cad/scripts/desktop-openai-oauth.mjs",
                "/opt/reify/prime-agent", "/workspace/home/.prime/agent", source
            ], onEvent: { [weak self] in self?.handleProviderLogin($0) }, onExit: { [weak self] code in
                guard let self else { return }
                self.oauthProcess = nil
                if code != 0 && self.oauthProvider != nil { self.configError = "云端登录未完成，请重试" }
                self.oauthProvider = nil; self.oauthInput = nil; self.oauthURL = nil
            })
            if oauthProcess?.finished == true { oauthProcess = nil }
        } catch { configError = error.localizedDescription; oauthProvider = nil }
    }
    private func handleProviderLogin(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "auth_url", "auth_device_code":
            oauthURL = (event["url"] ?? event["verificationUri"]) as? String
            oauthMessage = event["instructions"] as? String ?? event["userCode"] as? String ?? "请在浏览器完成登录，再粘贴完整回调地址或授权码。"
            oauthInput = ["placeholder": "回调地址或授权码"]
        case "auth_input", "auth_select": oauthInput = event; oauthMessage = event["message"] as? String ?? "请继续登录"
        case "auth_progress": oauthMessage = event["message"] as? String ?? ""
        case "auth_complete":
            oauthProvider = nil; oauthURL = nil; oauthInput = nil; oauthMessage = "登录完成"
            Task { await loadCloudModels() }
        case "auth_error": configError = event["message"] as? String ?? "登录失败"; oauthProvider = nil; oauthInput = nil
        default: break
        }
    }
    func submitProviderCode(_ code: String) async {
        do { guard let oauthProcess else { throw CloudError("没有等待输入的登录") }; try await oauthProcess.write(code) }
        catch { configError = error.localizedDescription }
    }
    func cancelProviderLogin() async {
        oauthProvider = nil; await oauthProcess?.stop(); oauthProcess = nil; oauthURL = nil; oauthInput = nil; oauthMessage = "登录已取消"
    }
    func openProviderURL() {
        if let address = oauthURL, let url = URL(string: address), ["https", "http"].contains(url.scheme) { NSWorkspace.shared.open(url) }
    }
    func renameProject(_ project: Project, name: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let updated = try await api.renameProject(project.id, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
            projects = try await api.projects(); if selected?.id == project.id { selected = updated }
        } catch { fail(error) }
    }
    func deleteProject(_ project: Project) async {
        guard !busy, !generating else { return }; busy = true; defer { busy = false }
        do {
            try await api.deleteProject(project.id)
            if selected?.id == project.id {
                saveLayout(); await bridge.stop(api: api); selected = nil; messages = []; files = []; preview = nil; previewName = ""; connected = false
            }
            projects = try await api.projects()
        } catch { fail(error) }
    }
}
