import Foundation
import Security

// Only tokens and identity go in Keychain. Passwords are never persisted.
public struct SessionStore {
    private let service: String
    public init(scope: String = "production") { service = "app.reify.mac.session.\(scope)" }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "cloud"]
    }
    public func load() throws -> Session? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let code = SecItemCopyMatching(q as CFDictionary, &value)
        if code == errSecItemNotFound { return nil }
        guard code == errSecSuccess, let data = value as? Data else { throw CloudError("无法读取钥匙串（\(code)）") }
        return try JSONDecoder().decode(Session.self, from: data)
    }
    public func save(_ session: Session) throws {
        let data = try JSONEncoder().encode(session)
        let code = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if code == errSecItemNotFound {
            var q = query
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let added = SecItemAdd(q as CFDictionary, nil)
            guard added == errSecSuccess else { throw CloudError("无法保存登录（\(added)）") }
        } else if code != errSecSuccess { throw CloudError("无法保存登录（\(code)）") }
    }
    public func clear() throws {
        let code = SecItemDelete(query as CFDictionary)
        guard code == errSecSuccess || code == errSecItemNotFound else { throw CloudError("无法清除登录（\(code)）") }
    }
}
