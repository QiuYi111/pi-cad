import Foundation
import JavaScriptCore
import ReifyCloud

struct TurnPhaseView: Decodable {
    let phase: String
    let label: String
    let terminal: Bool
    let reason: String?
    let turnSeconds: Double
    let phaseSeconds: Double
    let silentSeconds: Double
    let showSilent: Bool
    struct Retry: Decodable { let attempt: Int; let maxAttempts: Int }
    let retry: Retry?
}

/// The existing desktop reducers run locally; SwiftUI renders their data.
@MainActor final class DesktopPresentation {
    private let context = JSContext()!
    private var error: String?
    init() {
        context.exceptionHandler = { [weak self] _, failure in self?.error = failure?.toString() ?? "消息组件错误" }
        let uuid: @convention(block) () -> String = { UUID().uuidString }
        context.setObject(uuid, forKeyedSubscript: "nativeUUID" as NSString)
        let fallback = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("DesktopPresentation.js")
        let path = Bundle.main.url(forResource: "DesktopPresentation", withExtension: "js") ?? fallback
        do { context.evaluateScript(try String(contentsOf: path, encoding: .utf8)) }
        catch { self.error = "消息组件缺失，请重新安装客户端" }
    }
    func reset(sessionID: String?, thinking: String) throws { _ = try call("reifyReset", [sessionID.map { $0 as Any } ?? NSNull(), thinking]) }
    func load(_ rows: [[String: Any]]) throws -> [ChatMessage] { try decode("reifyLoad", [rows]) }
    func resume(generating: Bool) throws { _ = try call("reifyResume", [generating]) }
    func reduce(_ event: [String: Any]) throws -> [ChatMessage] { try decode("reifyReduce", [event]) }
    func begin() { _ = try? call("reifyBegin") }
    func stopping() { _ = try? call("reifyStopping") }
    func failed(_ command: String, _ message: String, timeout: Bool = false) { _ = try? call("reifyCommandFailed", [command, message, timeout]) }
    func exited() { _ = try? call("reifyExited") }
    func turn() -> TurnPhaseView? { try? decode("reifyTurn", [Date().timeIntervalSince1970 * 1000]) as TurnPhaseView? }
    func markdown(_ text: String) throws -> MarkdownNode { try decode("reifyMarkdown", [text]) }
    private func call(_ name: String, _ arguments: [Any] = []) throws -> JSValue {
        if let error { throw CloudError(error) }
        guard let function = context.objectForKeyedSubscript(name), !function.isUndefined,
              let result = function.call(withArguments: arguments) else { throw CloudError("消息组件无法运行") }
        if let error { throw CloudError(error) }
        return result
    }
    private func decode<T: Decodable>(_ name: String, _ arguments: [Any]) throws -> T {
        guard let json = try call(name, arguments).toString() else { throw CloudError("消息数据格式错误") }
        return try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
