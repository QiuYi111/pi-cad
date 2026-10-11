import Foundation
import ReifyCloud

/// The desktop administrator setting remains the authority. The native client
/// reads it for the matching cloud server; it never enables publication itself.
struct DesktopPublishPolicy: Codable {
    let enabled: Bool
    let allowedRemotes: [String]
    let message: String
    static let disabled = DesktopPublishPolicy(enabled: false, allowedRemotes: [], message: "管理员未启用 Git 标签发布")
    static var settingsURL: URL {
        if let path = ProcessInfo.processInfo.environment["REIFY_DESKTOP_SETTINGS_PATH"] { return URL(fileURLWithPath: path) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pi-CAD/settings.json")
    }
    @MainActor static func read(server: String) -> DesktopPublishPolicy {
        do {
            guard FileManager.default.fileExists(atPath: settingsURL.path) else { return .disabled }
            let value = try JSONSerialization.jsonObject(with: Data(contentsOf: settingsURL)) as? [String: Any]
            guard value?["mode"] as? String == "cloud", let cloud = value?["cloud"] as? [String: Any], let base = cloud["baseUrl"] as? String,
                  try CloudAPI.validatedURL(base) == CloudAPI.validatedURL(server) else { return DesktopPublishPolicy(enabled: false, allowedRemotes: [], message: "发布配置属于另一台服务器") }
            guard let policy = value?["remotePublish"] as? [String: Any], policy["enabled"] as? Bool == true else { return .disabled }
            let names = policy["allowedRemotes"] as? [String] ?? ["origin"] // Same original desktop default.
            guard names.allSatisfy({ !$0.isEmpty && !$0.contains("\0") }) else { return DesktopPublishPolicy(enabled: false, allowedRemotes: [], message: "允许的仓库名称无效") }
            return DesktopPublishPolicy(enabled: true, allowedRemotes: Array(Set(names)).sorted(), message: names.isEmpty ? "未允许任何远程仓库" : "允许的仓库：\(names.joined(separator: "、"))")
        } catch { return DesktopPublishPolicy(enabled: false, allowedRemotes: [], message: "无法读取管理员发布配置") }
    }
}
