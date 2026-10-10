import Foundation
import ReifyCloud

extension AppModel {
    func cancelReconnect() {
        reconnectSequence += 1
        reconnectTask?.cancel(); reconnectTask = nil
        reconnecting = false
    }
    func scheduleReconnect() {
        guard reconnectTask == nil, user != nil, let project = selected else { return }
        let sequence = reconnectSequence, userID = user?.id
        reconnecting = true
        reconnectTask = Task { @MainActor in
            defer { if sequence == reconnectSequence { reconnectTask = nil; reconnecting = false } }
            var attempt = 0
            while !Task.isCancelled, sequence == reconnectSequence, user?.id == userID, selected?.id == project.id {
                attempt += 1
                status = "正在重连（第 \(attempt) 次）"
                do {
                    try await Task.sleep(for: .seconds(min(30, pow(2, Double(min(attempt - 1, 5))))))
                    guard !Task.isCancelled, sequence == reconnectSequence else { return }
                    // A lost bridge does not authorize restarting an idle-paused workspace.
                    let workspace = try await api.workspace()
                    guard !Task.isCancelled, sequence == reconnectSequence else { return }
                    if workspace.state == "stopped" || workspace.state == "failed" {
                        status = workspace.state == "failed" ? "工作区启动失败" : "云端已暂停"
                        if workspace.state == "failed" { error = workspace.lastError ?? "工作区启动失败，请重试" }
                        return
                    }
                    if busy { continue }
                    await open(selected ?? project, reconnect: true)
                    guard !Task.isCancelled, sequence == reconnectSequence else { return }
                    if connected { error = nil; status = "云端已连接"; return }
                } catch {
                    if Task.isCancelled || sequence != reconnectSequence { return }
                    if api.session == nil { fail(error); return }
                    self.error = "连接尚未恢复，将自动重试。"
                }
            }
        }
    }
}
