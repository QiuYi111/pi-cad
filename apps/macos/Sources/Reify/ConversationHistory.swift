import Foundation
import ReifyCloud

extension AppModel {
    var conversationKey: String { "reify.native.\(api.session?.user.id ?? "").\(selected?.id ?? "").conversation.\(sessionID ?? "new")" }
    func saveConversationDraft() {
        AppPreferences.current.set(draft, forKey: "\(conversationKey).draft"); savePending()
        attachmentsByConversation[conversationKey] = attachments
    }
    func restoreConversationDraft() {
        draft = AppPreferences.current.string(forKey: "\(conversationKey).draft") ?? ""
        notes = AppPreferences.current.stringArray(forKey: "\(conversationKey).notes") ?? []
        attachments = attachmentsByConversation[conversationKey] ?? []
    }
    func refreshConversations() async {
        guard connected else { return }
        let project = selected?.id
        historyLoading = true; historyError = nil
        defer { historyLoading = false }
        do { let list = try await bridge.conversations(); if selected?.id == project { conversations = list } }
        catch { if selected?.id == project { historyError = error.localizedDescription } }
    }
    func switchConversation(_ conversation: ConversationSummary) async {
        guard !generating, !busy, connected else { return }
        generation += 1
        clearEngineering()
        saveConversationDraft(); busy = true; error = nil
        defer { busy = false }
        do {
            try await bridge.switchConversation(conversation.path)
            let state = try await bridge.rpc("get_state"); sessionID = state["sessionId"] as? String
            syncRuntimeModel(state); try await loadMessages(); restoreConversationDraft(); restorePending()
            preview = nil; previewName = ""; canvasMode = false
            if let selected { AppPreferences.current.set(conversation.path, forKey: "reify.native.active-session.\(api.baseURL).\(user?.id ?? "").\(selected.id)") }
            await refreshEngineering()
        } catch { fail(error) }
    }
}
