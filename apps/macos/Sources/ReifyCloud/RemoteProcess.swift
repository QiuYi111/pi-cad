import Foundation

/// A workspace process with a separate channel; used for provider sign-in and
/// streamed jobs. Its output never enters the Agent conversation channel.
@MainActor public final class RemoteProcess {
    public var onEvent: (([String: Any]) -> Void)?
    public var onExit: ((Int) -> Void)?
    public private(set) var stderr = ""
    public private(set) var finished = false
    public private(set) var spawnID: String?
    let channel: Int
    private weak var bridge: WorkspaceBridge?
    private var buffer = Data()
    init(channel: Int, bridge: WorkspaceBridge) { self.channel = channel; self.bridge = bridge }
    func spawned(_ id: String?) { spawnID = id }
    func receive(_ data: Data) {
        buffer.append(data)
        if buffer.count > 8 * 1024 * 1024 { buffer.removeAll(); onEvent?(["type": "auth_error", "message": "云端输出过大"]); return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
            if let event = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { onEvent?(event) }
        }
    }
    func control(_ message: [String: Any]) {
        if message["type"] as? String == "stderr" { stderr += message["data"] as? String ?? "" }
        if message["type"] as? String == "exit" { end(message["code"] as? Int ?? -1) }
    }
    func end(_ code: Int) { guard !finished else { return }; finished = true; onExit?(code) }
    public func write(_ value: String) async throws {
        guard let bridge else { throw CloudError("云端连接已关闭") }
        try await bridge.writeProcess(channel, value: value)
    }
    public func stop() async { await bridge?.stopProcess(channel) }
}
