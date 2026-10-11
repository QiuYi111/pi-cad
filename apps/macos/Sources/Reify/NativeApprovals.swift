import Foundation
import JavaScriptCore
import Darwin
import ReifyCloud

struct HumanApprovalRecord: Codable, Identifiable {
    let id: String
    let projectId: String
    let commitId: String
    let workflowHash: String
    let sourceRevision: String
    let artifactSetHash: String
    let scope: String
    let rationale: String
    let decision: String
    struct Approver: Codable { let type: String; let id: String }
    let approver: Approver
    let decidedAt: String
    let revokedAt: String?
    let revocationReason: String?
    let valid: Bool
}

/// Execute the desktop approval store unchanged, with the current Mac user's
/// identity and file operations limited to the client's own approval directory.
@MainActor final class NativeApprovals {
    private let context = JSContext()!
    private var failure: String?
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var allowedRoots = Set<URL>()
    init() {
        context.exceptionHandler = { [weak self] _, value in self?.failure = value?.toString() }
        let uuid: @convention(block) () -> String = { UUID().uuidString }
        let identity: @convention(block) () -> String = { NSUserName() }
        let pid: @convention(block) () -> Int = { Int(ProcessInfo.processInfo.processIdentifier) }
        let hash: @convention(block) (String) -> String = { WorkspaceBridge.hash(Data($0.utf8)) }
        let filesystem: @convention(block) (String, String, String, String) -> String = { [weak self] op, path, text, other in
            do {
                guard let self else { throw CloudError("批准记录服务已关闭") }
                let value = try self.file(op, path: path, text: text, other: other)
                return String(decoding: try JSONSerialization.data(withJSONObject: ["ok": true, "value": value]), as: UTF8.self)
            } catch { return String(decoding: (try? JSONSerialization.data(withJSONObject: ["ok": false, "error": error.localizedDescription])) ?? Data(), as: UTF8.self) }
        }
        let complete: @convention(block) (String, String, String) -> Void = { [weak self] id, json, error in
            guard let continuation = self?.pending.removeValue(forKey: id) else { return }
            if error.isEmpty { continuation.resume(returning: Data(json.utf8)) }
            else { continuation.resume(throwing: CloudError(error)) }
        }
        for (name, value) in [("nativeUUID", uuid as Any), ("nativeIdentity", identity as Any), ("nativePID", pid as Any), ("nativeSHA256", hash as Any), ("nativeApprovalFS", filesystem as Any), ("nativeApprovalComplete", complete as Any)] { context.setObject(value, forKeyedSubscript: name as NSString) }
        let fallback = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("DesktopApprovals.js")
        do { context.evaluateScript(try String(contentsOf: Bundle.main.url(forResource: "DesktopApprovals", withExtension: "js") ?? fallback, encoding: .utf8)) }
        catch { failure = "批准组件缺失，请重新安装客户端" }
    }
    func request<T: Decodable>(_ operation: String, catalogEnvelope: String, root: URL, arguments: [String] = []) async throws -> T {
        if let failure { throw CloudError(failure) }
        let root = root.standardizedFileURL.resolvingSymlinksInPath()
        allowedRoots.insert(root)
        let id = UUID().uuidString
        let data = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            pending[id] = continuation
            context.objectForKeyedSubscript("reifyApprovalRequest")?.call(withArguments: [id, operation, catalogEnvelope, root.path, arguments])
            if let failure, let pending = pending.removeValue(forKey: id) { pending.resume(throwing: CloudError(failure)) }
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(15))
                self?.pending.removeValue(forKey: id)?.resume(throwing: CloudError("批准记录操作超时"))
            }
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    private func confined(_ path: String) throws -> URL {
        let url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
        guard allowedRoots.contains(where: { url.path == $0.path || url.path.hasPrefix($0.path + "/") }) else { throw CloudError("批准记录路径不属于当前客户端") }
        return url
    }
    private func file(_ operation: String, path: String, text: String, other: String) throws -> Any {
        let url = try confined(path)
        switch operation {
        case "read": return try String(contentsOf: url, encoding: .utf8)
        case "mkdir": try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        case "write":
            try Data(text.utf8).write(to: url)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        case "rename":
            let target = try confined(other)
            let result = url.withUnsafeFileSystemRepresentation { source in target.withUnsafeFileSystemRepresentation { destination in Darwin.rename(source!, destination!) } }
            guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        default: throw CloudError("未知批准记录操作")
        }
        return NSNull()
    }
}
