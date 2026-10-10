import SwiftUI
import AppKit
import UniformTypeIdentifiers
import ReifyCloud

struct ImageAttachment: Identifiable, Codable, Equatable {
    let id: String
    let name: String
    let data: Data
    let mimeType: String
    let remotePath: String
    var promptImage: [String: Any] { ["data": data.base64EncodedString(), "mimeType": mimeType] }
}
struct QueuedRequest: Identifiable, Codable, Equatable {
    let id: String
    var text: String
    let images: [ImageAttachment]
}

extension AppModel {
    func restorePending() {
        pending = AppPreferences.current.data(forKey: "\(conversationKey).pending").flatMap { try? JSONDecoder().decode([QueuedRequest].self, from: $0) } ?? []
        attachments = attachmentsByConversation[conversationKey] ?? []
    }
    func savePending() { AppPreferences.current.set(try? JSONEncoder().encode(pending), forKey: "\(conversationKey).pending") }
    func attachImages() async {
        guard connected else { return }
        if catalog.model(provider: provider, id: model)?.input?.contains("image") == false { error = "当前模型不支持图片，请先选择支持图片的模型"; return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.image]; panel.allowsMultipleSelection = true; panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }
        let current = generation
        do {
            for url in panel.urls {
                let data = try Data(contentsOf: url)
                guard data.count <= 8 * 1024 * 1024, attachments.reduce(data.count, { $0 + $1.data.count }) <= 12 * 1024 * 1024 else { throw CloudError("单张图片最多 8 MB，每条消息的图片最多 12 MB") }
                guard NSImage(data: data) != nil else { throw CloudError("图片无法读取") }
                let contentType = try url.resourceValues(forKeys: [.contentTypeKey]).contentType
                let mime = contentType?.preferredMIMEType ?? "image/png"
                let name = "attachments/\(UUID().uuidString)-\(url.lastPathComponent)"
                try await bridge.upload(data, name: name)
                guard current == generation else { return }
                attachments.append(ImageAttachment(id: UUID().uuidString, name: url.lastPathComponent, data: data, mimeType: mime, remotePath: name))
            }
            files = try await bridge.files()
        } catch { if current == generation { fail(error) } }
    }
    func submitDraft() async {
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, connected else { return }
        let images = attachments
        if generating {
            if runningIntent == "note" {
                notes.append(value); messages.append(noteMessages.last!)
                AppPreferences.current.set(notes, forKey: "\(conversationKey).notes")
                draft = ""; attachments = []; saveConversationDraft(); return
            }
            pending.append(QueuedRequest(id: UUID().uuidString, text: value, images: images))
            draft = ""; attachments = []; saveConversationDraft(); savePending()
            if runningIntent == "replace" { await abort() }
            return
        }
        draft = ""; attachments = []; saveConversationDraft()
        await send(value, images: images)
        if error != nil { draft = value; attachments = images; saveConversationDraft() }
    }
    func drainQueue() async {
        guard !generating, !busy, !drainingQueue, connected, let request = pending.first else { return }
        drainingQueue = true
        defer { drainingQueue = false }
        let current = generation
        await send(request.text, images: request.images)
        guard current == generation else { return }
        if error == nil {
            pending.removeAll { $0.id == request.id }; savePending()
            if !generating { Task { @MainActor in await self.drainQueue() } }
        }
    }
    func quickModel(_ choice: CatalogModel) async {
        guard connected else { return }
        do {
            _ = try await bridge.rpc("set_model", payload: ["provider": choice.provider, "modelId": choice.id])
            let nextThinking = choice.normalized(thinking)
            _ = try await bridge.rpc("set_thinking_level", payload: ["level": nextThinking])
            let state = try await bridge.rpc("get_state"); syncRuntimeModel(state)
        } catch {
            fail(error)
            if let state = try? await bridge.rpc("get_state") { syncRuntimeModel(state) }
        }
    }
    func quickThinking(_ level: String) async {
        do { _ = try await bridge.rpc("set_thinking_level", payload: ["level": level]); thinking = level; persistSettings() }
        catch { fail(error) }
    }
    func changePermission(_ value: String) async {
        guard !generating else { error = "请先停止当前任务"; return }
        permission = value; persistSettings()
        if let selected { await open(selected) }
    }
    var quickModels: [CatalogModel] {
        let available = catalog.models.filter { $0.available == true }
        let favorites = available.filter { model in catalog.favorites.contains { $0.id == model.key } }
        return favorites.isEmpty ? available : favorites
    }
}
