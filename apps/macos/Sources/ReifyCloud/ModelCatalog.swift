import Foundation

public let thinkingLevelOrder = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

public struct CatalogModel: Codable, Identifiable, Equatable {
    public let provider: String
    public let id: String
    public let name: String
    public let thinkingLevels: [String]?
    public let input: [String]?
    public let contextWindow: Int?
    public let maxTokens: Int?
    public let available: Bool?
    public var key: String { provider + "/" + id }
    public var levels: [String] { thinkingLevels?.isEmpty == false ? thinkingLevels! : ["off"] }
    public func normalized(_ level: String) -> String {
        if levels.contains(level) { return level }
        let at = thinkingLevelOrder.firstIndex(of: level) ?? 0
        return thinkingLevelOrder[at...].first(where: levels.contains)
            ?? thinkingLevelOrder[..<at].reversed().first(where: levels.contains) ?? levels[0]
    }
}
public struct ProviderAuth: Codable, Equatable {
    public let provider: String
    public let configured: Bool?
    public let state: String
    public let source: String?
    public let message: String?
}
public struct CatalogProvider: Codable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let oauth: Bool
    public let auth: ProviderAuth
    public let models: [CatalogModel]
}
public struct ModelFavorite: Codable, Identifiable, Equatable {
    public var provider: String?
    public var modelId: String?
    public var thinkingLevel: String?
    public var pattern: String?
    public var id: String { pattern ?? "\(provider ?? "")/\(modelId ?? "")" }
    public init(provider: String, modelId: String, thinkingLevel: String) {
        self.provider = provider; self.modelId = modelId; self.thinkingLevel = thinkingLevel
    }
}
public struct ModelDefaults: Codable, Equatable {
    public var provider: String?
    public var modelId: String?
    public var thinkingLevel: String?
    public init() {}
}
public struct ModelCatalog: Codable, Equatable {
    public var providers: [CatalogProvider]
    public var favorites: [ModelFavorite]
    public var defaults: ModelDefaults
    public init() { providers = []; favorites = []; defaults = ModelDefaults() }
    public var models: [CatalogModel] { providers.flatMap(\.models) }
    public func model(provider: String, id: String) -> CatalogModel? {
        providers.first(where: { $0.id == provider })?.models.first(where: { $0.id == id })
    }
}
public struct ReviewerSelection: Codable, Equatable {
    public var mode: String
    public var provider: String
    public var model: String
    public var thinking: String
    public init(mode: String = "inherit", provider: String = "", model: String = "", thinking: String = "medium") {
        self.mode = mode; self.provider = provider; self.model = model; self.thinking = thinking
    }
}

@MainActor public final class PrimeConfiguration {
    private let bridge: WorkspaceBridge
    public init(bridge: WorkspaceBridge) { self.bridge = bridge }
    public func run(_ command: String, input: [String: Any] = [:]) async throws -> Data {
        let inputData = try JSONSerialization.data(withJSONObject: input)
        let output = try await bridge.exec([
            "/opt/reify/node/bin/node", "/opt/reify/pi-cad/scripts/desktop-prime-config.mjs",
            "/opt/reify/prime-agent", "/workspace/home/.prime/agent", bridge.projectRoot ?? "/workspace/home", command
        ], input: String(decoding: inputData, as: UTF8.self), timeoutMs: command == "catalog" ? 60000 : 30000)
        return Data(output.utf8)
    }
    public func catalog() async throws -> ModelCatalog { try JSONDecoder().decode(ModelCatalog.self, from: await run("catalog")) }
    public func setKey(provider: String, key: String) async throws -> ProviderAuth {
        try JSONDecoder().decode(ProviderAuth.self, from: await run("set-api-key", input: ["provider": provider, "key": key]))
    }
    public func removeCredential(provider: String) async throws { _ = try await run("logout", input: ["provider": provider]) }
    public func saveFavorites(_ favorites: [ModelFavorite]) async throws {
        // Match desktop's explicit-model favorites; catalog patterns are not
        // accepted by the existing save-favorites command.
        let encoded = try JSONEncoder().encode(favorites.filter { $0.provider != nil && $0.modelId != nil })
        _ = try await run("save-favorites", input: ["models": JSONSerialization.jsonObject(with: encoded)])
    }
    public func saveDefault(provider: String, model: String, thinking: String) async throws {
        _ = try await run("save-default", input: ["provider": provider, "modelId": model, "thinkingLevel": thinking])
    }
    public func readModels() async throws -> String {
        struct Config: Decodable { let text: String }
        return try JSONDecoder().decode(Config.self, from: await run("read-models-config")).text
    }
    public func writeModels(_ text: String) async throws -> String {
        struct Config: Decodable { let text: String }
        return try JSONDecoder().decode(Config.self, from: await run("write-models-config", input: ["text": text])).text
    }
}
