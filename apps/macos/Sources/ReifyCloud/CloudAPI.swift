import Foundation

@MainActor public final class CloudAPI {
    nonisolated public static let defaultURL = "https://desktop-pkr2go0.tailb53649.ts.net"
    public private(set) var session: Session?
    public var baseURL: String
    private let store: SessionStore
    private let transport: URLSession
    private var refreshing: Task<Void, Error>?
    public init(baseURL: String = CloudAPI.defaultURL, scope: String = "production") {
        self.baseURL = baseURL
        store = SessionStore(scope: scope)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        transport = URLSession(configuration: config)
    }
    public func restore() throws {
        session = try store.load()
        if let session { baseURL = session.baseURL }
    }
    public static func validatedURL(_ value: String) throws -> String {
        guard let u = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = u.host, u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
              (u.scheme == "https" || (u.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host))) else {
            throw CloudError("请填写 HTTPS 服务器地址")
        }
        return u.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    public func login(email: String, password: String, server: String) async throws {
        baseURL = try Self.validatedURL(server)
        let data = try await raw("POST", "/v1/auth/login", body: ["email": email, "password": password, "deviceLabel": "Reify macOS"], token: nil)
        try accept(data)
    }
    private struct Tokens: Decodable { let accessToken: String; let refreshToken: String; let expiresIn: Double?; let user: User }
    private func accept(_ data: Data) throws {
        let t = try JSONDecoder().decode(Tokens.self, from: data)
        let next = Session(baseURL: baseURL, accessToken: t.accessToken, refreshToken: t.refreshToken,
                           expiresAt: Date().addingTimeInterval(t.expiresIn ?? 900), user: t.user)
        do { try store.save(next); session = next }
        catch { session = nil; try? store.clear(); throw error }
    }
    public func logout() async throws {
        let token = session?.refreshToken
        try store.clear()
        session = nil
        refreshing?.cancel(); refreshing = nil
        if let token { _ = try? await raw("POST", "/v1/auth/logout", body: ["refreshToken": token], token: nil) }
    }
    private func refresh() async throws {
        if let refreshing { return try await refreshing.value }
        guard let current = session else { throw CloudError("请先登录", status: 401) }
        let task = Task { @MainActor in
            do {
                let data = try await self.raw("POST", "/v1/auth/refresh", body: ["refreshToken": current.refreshToken], token: nil)
                guard self.session?.refreshToken == current.refreshToken else { throw CancellationError() }
                try self.accept(data)
            } catch let error as CloudError where error.status == 401 {
                self.session = nil; try self.store.clear(); throw error
            }
        }
        refreshing = task
        defer { refreshing = nil }
        try await task.value
    }
    public func token() async throws -> String {
        guard let session else { throw CloudError("请先登录", status: 401) }
        if session.expiresAt.timeIntervalSinceNow < 120 { try await refresh() }
        guard let token = self.session?.accessToken else { throw CloudError("登录已失效", status: 401) }
        return token
    }
    public func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        do { return try await raw(method, path, body: body, token: token()) }
        catch let error as CloudError where error.status == 401 {
            try await refresh()
            return try await raw(method, path, body: body, token: token())
        }
    }
    private func raw(_ method: String, _ path: String, body: [String: Any]?, token: String?) async throws -> Data {
        guard let url = URL(string: baseURL + path) else { throw CloudError("服务器地址无效") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CloudError("服务器没有响应") }
        guard (200..<300).contains(http.statusCode) else {
            let fields = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            var message = fields?["message"] as? String ?? "请求失败（\(http.statusCode)）"
            if let position = fields?["position"] as? Int { message += "，排队第 \(position) 位" }
            throw CloudError(message, status: http.statusCode, code: fields?["code"] as? String)
        }
        return data
    }
    public func projects() async throws -> [Project] {
        struct List: Decodable { let projects: [Project] }
        return try JSONDecoder().decode(List.self, from: await request("GET", "/v1/projects")).projects
    }
    public func createProject(_ name: String) async throws -> Project {
        try JSONDecoder().decode(Project.self, from: await request("POST", "/v1/projects", body: ["name": name]))
    }
    public func renameProject(_ id: String, name: String) async throws -> Project {
        try JSONDecoder().decode(Project.self, from: await request("PATCH", "/v1/projects/\(id)", body: ["name": name]))
    }
    public func deleteProject(_ id: String) async throws { _ = try await request("DELETE", "/v1/projects/\(id)") }
    public func changePassword(old: String, new: String) async throws {
        guard new.count >= 10 else { throw CloudError("新密码至少 10 个字符") }
        _ = try await request("POST", "/v1/auth/password", body: ["oldPassword": old, "newPassword": new, "refreshToken": session?.refreshToken ?? ""])
    }
    public func workspace(_ action: String? = nil) async throws -> Workspace {
        try JSONDecoder().decode(Workspace.self, from: await request(action == nil ? "GET" : "POST", "/v1/workspace" + (action.map { "/\($0)" } ?? "")))
    }
    public func socket(_ path: String) async throws -> URLSessionWebSocketTask {
        let token = try await token()
        guard var parts = URLComponents(string: baseURL + path) else { throw CloudError("服务器地址无效") }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        guard let url = parts.url else { throw CloudError("服务器地址无效") }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let socket = transport.webSocketTask(with: request)
        socket.maximumMessageSize = 8 * 1024 * 1024
        socket.resume()
        return socket
    }
}
