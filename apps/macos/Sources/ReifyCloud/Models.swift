import Foundation

public struct User: Codable, Equatable {
    public let id: String
    public let email: String
    public let displayName: String?
}
public struct Project: Codable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let role: String
    public let createdAt: String
}
public struct Workspace: Codable {
    public let name: String
    public let state: String
    public let lastError: String?
    public let queuePosition: Int?
    public let reclaimAt: String?
}
public struct CloudFile: Codable, Identifiable, Equatable {
    public var id: String { path }
    public let path: String
    public let size: Int
    public var name: String { (path as NSString).lastPathComponent }
}
public struct Session: Codable {
    public var baseURL: String
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date
    public var user: User
}
public struct CloudError: LocalizedError {
    public let message: String
    public let status: Int
    public let code: String?
    public var errorDescription: String? { message }
    public init(_ message: String, status: Int = 0, code: String? = nil) { self.message = message; self.status = status; self.code = code }
}
public struct ChatMedia: Codable, Equatable, Identifiable {
    public let id: String
    public let mimeType: String
    public let role: String
    public let dataUrl: String?
    public let path: String?
    public let label: String?
}
public struct ChatActivity: Codable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let state: String
    public let title: String
    public let summary: String?
    public let stage: String?
    public let progress: Double?
    public let startedAt: Double
    public let finishedAt: Double?
    public struct Metric: Codable, Equatable { public let label: String; public let value: String }
    public let metrics: [Metric]?
    public let media: [ChatMedia]?
    public let artifactPath: String?
    public let details: JSONValue?
}
public struct ChatMessage: Codable, Identifiable, Equatable {
    public let id: String
    public let role: String
    public var text: String
    public var activity: ChatActivity?
    public init(id: String = UUID().uuidString, role: String, text: String) { self.id = id; self.role = role; self.text = text; self.activity = nil }
    public static func decode(_ rows: [[String: Any]]) -> [ChatMessage] {
        rows.enumerated().compactMap { index, row in
            guard let role = row["role"] as? String, ["user", "assistant"].contains(role) else { return nil }
            var text = row["content"] as? String ?? (row["content"] as? [[String: Any]] ?? []).compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }.joined(separator: "\n")
            if role == "assistant", let error = row["errorMessage"] as? String, !error.isEmpty {
                text += (text.isEmpty ? "" : "\n\n") + "云端模型出错：" + error
            }
            guard !text.isEmpty else { return nil }
            return ChatMessage(id: "history-\(index)", role: role, text: text)
        }
    }
}
