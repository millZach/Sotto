import Foundation

/// Wire v1 mirrors src/shared/hostProtocol.ts. Unknown display fields are ignored;
/// unknown protocol versions, request kinds and permission variants fail closed.
public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    public func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
}

public enum ClientError: Error, LocalizedError, Equatable {
    case invalidHost, invalidProtocol, invalidIdentity, invalidRequest, disconnected, uncertain, rejected(String)
    public var errorDescription: String? {
        switch self {
        case .invalidHost: return "Enter the private HTTPS address ending in .ts.net, without a path or sign-in details."
        case .invalidProtocol: return "This host uses a different connection format. Update Sotto before connecting."
        case .invalidIdentity: return "This address belongs to a different host. Forget it and pair again if you intended to change hosts."
        case .invalidRequest: return "This request changed or is not supported on this iPhone. Refresh the thread or answer on the desktop."
        case .disconnected: return "Connection lost. Work continues on the host. Reconnect to check the thread."
        case .uncertain: return "Delivery is unconfirmed. Check the thread before sending again."
        case .rejected(let message): return message
        }
    }
}

public struct HostEndpoint: Equatable, Sendable {
    public let url: URL
    public init(_ input: String) throws {
        guard let c = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme?.lowercased() == "https", let host = c.host?.lowercased(),
              host.hasSuffix(".ts.net"), host.count > 7, c.user == nil, c.password == nil,
              c.query == nil, c.fragment == nil, c.port == nil || c.port == 443,
              c.path.isEmpty || c.path == "/", let url = c.url else { throw ClientError.invalidHost }
        self.url = url
    }
    public func route(_ path: String, socket: Bool = false) -> URL {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.path = path; c.scheme = socket ? "wss" : "https"
        return c.url!
    }
}

public struct Pairing: Codable, Sendable {
    public let v: Int; public let hostId: String; public let clientId: String; public let token: String
    public func validate() throws {
        guard v == 1 else { throw ClientError.invalidProtocol }
        guard UUID(uuidString: hostId) != nil, !clientId.isEmpty, !token.isEmpty else { throw ClientError.invalidIdentity }
    }
}
public struct HostSession: Decodable, Sendable {
    public let v: Int; public let hostId: String; public let clientId: String; public let session: String; public let expiresAt: String
    public func validate(pairing: Pairing) throws {
        guard v == 1 else { throw ClientError.invalidProtocol }
        guard hostId == pairing.hostId, clientId == pairing.clientId, !session.isEmpty else { throw ClientError.invalidIdentity }
    }
}
public struct WireFailure: Decodable, Sendable { public let code: String; public let message: String }
public struct Receipt: Decodable, Sendable { public let status: String; public let error: WireFailure? }
public struct Hello: Decodable, Sendable {
    public let hostId: String; public let clientId: String; public let shell: Shell; public let capabilities: Capabilities
    public struct Capabilities: Decodable, Sendable { public let mayAnswer: Bool }
}
public struct Shell: Decodable, Sendable {
    public let hostId: String?; public let host: HostSnapshot; public let deliveries: [Delivery]?; public let deliveredDrafts: [DeliveryReceipt]?
    public let globalLaneBusy: Bool?; public let busyThreadIds: [String]?; public let error: String?
    public func validate(hostID: String) throws {
        guard hostId == hostID, host.hostId == hostID,
              host.threads.allSatisfy({ $0.hostId == nil || $0.hostId == hostID }) else { throw ClientError.invalidIdentity }
    }
}
public struct HostSnapshot: Decodable, Sendable {
    public let hostId: String?; public let name: String; public let threads: [ThreadSummary]
    public let projects: [Project]; public let providers: [Provider]?
    public let capabilities: ProviderCapabilities
}
public struct Project: Decodable, Sendable { public let id: String; public let title: String }
public struct Provider: Decodable, Sendable { public let id: String; public let connection: String; public let capabilities: ProviderCapabilities }
public struct ProviderCapabilities: Decodable, Sendable { public let submit: Bool; public let interrupt: Bool; public let questions: Bool; public let permissions: Bool }
public struct ThreadSummary: Decodable, Identifiable, Sendable {
    public let id: String; public let hostId: String?; public let projectId: String; public let title: String
    public let providerId: String?; public let status: String; public let requests: [AgentRequest]
    public let earlierAvailable: Bool?; public let archivedAt: String?
}
public struct ThreadDetail: Decodable, Sendable {
    public let threadId: String; public let revision: Int; public let messages: [Message]; public let earlierAvailable: Bool?
}
public struct Message: Decodable, Identifiable, Sendable {
    public let id: String; public let role: String; public let text: String; public let commandId: String?
    public let attachments: [Attachment]?
}
public struct Attachment: Decodable, Identifiable, Sendable { public let id: String; public let name: String }
public struct DeliveryReceipt: Decodable, Sendable { public let threadId: String; public let draftId: String }
public struct Delivery: Decodable, Sendable { public let threadId: String; public let draftId: String; public let status: String }
public struct AgentRequest: Decodable, Equatable, Identifiable, Sendable {
    public let id: String; public let kind: String; public let text: String; public let options: [RequestOption]
    public let questions: [Question]?; public let permissionChoices: [PermissionChoice]?; public let context: RequestContext?; public let delivery: String?
    public var supported: Bool {
        guard delivery != "uncertain" else { return false }
        if kind == "question" { return true }
        if kind == "permission" && permissionChoices == nil { return true }
        return kind == "permission" && !(permissionChoices ?? []).isEmpty &&
            (permissionChoices ?? []).allSatisfy { ["allow-once", "allow-session", "allow-always", "deny", "cancel"].contains($0.kind) }
    }
}
public struct RequestOption: Decodable, Equatable, Identifiable, Sendable { public let id: String; public let label: String; public let description: String? }
public struct Question: Decodable, Equatable, Identifiable, Sendable {
    public let id: String; public let question: String; public let options: [RequestOption]
    public let multiSelect: Bool; public let allowFreeText: Bool; public let required: Bool?; public let unavailableReason: String?
}
public struct PermissionChoice: Decodable, Equatable, Identifiable, Sendable { public let id: String; public let label: String; public let kind: String; public let description: String? }
public struct RequestContext: Decodable, Equatable, Sendable { public let toolName: String?; public let command: String?; public let cwd: String?; public let details: String? }

public enum Wire {
    public static let maximumFrameBytes = 16 * 1024 * 1024
    public static func decode(_ data: Data) throws -> JSONValue {
        guard data.count <= maximumFrameBytes else { throw ClientError.invalidProtocol }
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        guard value["v"] == .number(1) else { throw ClientError.invalidProtocol }
        return value
    }
    public static func request(id: String, session: String, operation: [String: JSONValue]) throws -> Data {
        var fields = operation; fields["v"] = .number(1); fields["id"] = .string(id); fields["session"] = .string(session)
        return try JSONEncoder().encode(JSONValue.object(fields))
    }
}
