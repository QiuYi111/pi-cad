import Foundation

public struct AuthorityError: Error, LocalizedError {
    public let message: String
    public let code: String?
    public let target: String?
    public let hints: [String]
    public var errorDescription: String? { ([message] + hints).joined(separator: "\n") }
}

/// Every window request names its conversation, including an explicit null for
/// an empty conversation. Never inherit the project's most recently used run.
@MainActor public struct EngineeringService {
    public let bridge: WorkspaceBridge
    public let sessionID: String?
    public init(bridge: WorkspaceBridge, sessionID: String?) { self.bridge = bridge; self.sessionID = sessionID }
    public func request<T: Decodable>(_ operation: String, fields: [String: Any] = [:], timeoutMs: Int = 60000) async throws -> T {
        guard let root = bridge.projectRoot else { throw CloudError("请先打开项目") }
        var body = fields
        body["schema"] = 1; body["op"] = operation; body["sessionId"] = sessionID.map { $0 as Any } ?? NSNull()
        let input = String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
        let execution = try await bridge.execResult(["/opt/reify/node/bin/node", "/opt/reify/pi-cad/scripts/pi-cad-agent-api.mjs", "agent-api", root], input: input, timeoutMs: timeoutMs)
        let output = execution["stdout"] as? String ?? ""
        guard let envelope = (try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any], envelope["schema"] as? Int == 1 else {
            throw CloudError(execution["stderr"] as? String ?? "工程数据格式错误")
        }
        guard envelope["ok"] as? Bool == true else {
            let error = envelope["error"] as? [String: Any] ?? [:]
            throw AuthorityError(message: error["message"] as? String ?? "工程操作失败", code: error["code"] as? String, target: error["target"] as? String, hints: error["hints"] as? [String] ?? [])
        }
        guard execution["code"] as? Int == 0 else { throw CloudError("工程服务返回了异常结果") }
        let bytes = try JSONSerialization.data(withJSONObject: envelope["result"] ?? NSNull(), options: .fragmentsAllowed)
        return try JSONDecoder().decode(T.self, from: bytes)
    }
    public func workflow() async throws -> WorkflowRun? { try await request("workflow-current") }
    public func catalog() async throws -> EngineeringCatalog { try await request("viewer-catalog") }
}

public struct WorkflowTransition: Codable, Identifiable {
    public let event: String
    public let target: String
    public var id: String { event }
}
public struct WorkflowPhase: Codable, Identifiable {
    public let id: String
    public let title: String
    public let purpose: String
    public let status: String
    public let transitions: [WorkflowTransition]
    public let capabilities: [String]
    public let obligations: [String]
}
public struct WorkflowRun: Codable {
    public let runId: String
    public let workflowId: String
    public let workflowVersion: String
    public let workflowHash: String
    public let phase: String
    public let status: String
    public let updatedAt: String?
    public let phaseHistory: [String]
    public let phases: [WorkflowPhase]
}
public struct EngineeringArtifact: Codable, Identifiable {
    public let id: String
    public let path: String
    public let sha256: String
    public let role: String
}
public struct EngineeringCommit: Codable, Identifiable {
    public let id: String
    public let name: String
    public let parent: String?
    public let phase: String
    public let createdAt: String
    public let artifacts: [EngineeringArtifact]
    public let sourceRevision: String?
    public let workflowHash: String?
    public let acceptanceSummary: AcceptanceSummary?
}
public struct AcceptanceSummary: Codable {
    public struct Requirement: Codable, Identifiable {
        public let id: String
        public let category: String
        public let status: String
        public let method: String
        public struct Evidence: Codable { public let path: String; public let sha256: String }
        public let evidence: Evidence?
    }
    public let requirements: [Requirement]
    public let assumptions: [String]
}
public struct EngineeringCatalog: Codable {
    public struct Head: Codable { public let updatedAt: String; public let artifacts: [EngineeringArtifact] }
    public struct Run: Codable { public let id: String; public let phase: String; public let status: String; public let updatedAt: String; public let artifacts: [EngineeringArtifact] }
    public let projectId: String
    public let projectHead: Head
    public let currentRun: Run?
    public let commits: [EngineeringCommit]
    public let simulationRuns: [JSONValue]
    public let parameterManifests: [JSONValue]
}

public enum JSONValue: Codable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(Double.self) { self = .number(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([JSONValue].self) { self = .array(item) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .object(let item): try value.encode(item)
        }
    }
}
