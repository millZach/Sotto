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
    case invalidHost, invalidProtocol, invalidIdentity, invalidRequest, disconnected, uncertain, connectionTimedOut, readTimedOut, rateLimited, rejected(String)
    case hostNotFound(String), hostUnreachable(String), notASottoHost(String), sottoNotRunning(String), invalidCode
    /// A computer that keeps this iPhone's pairing refused it for now, in its own words, such as a host with phone
    /// access off. Unlike `rejected`, the pairing stays, and Try again or Reconnect reaches it once access is back.
    case hostRefused(String)
    public var errorDescription: String? {
        switch self {
        case .invalidHost: return "Enter the computer's name on your tailnet, such as forge, or its full address ending in .ts.net."
        case .hostNotFound(let name): return "Couldn't find \(name) on your tailnet. Check that Tailscale is connected on this iPhone and MagicDNS is on for your tailnet, or enter the full address ending in .ts.net."
        case .hostUnreachable(let name): return "Couldn't reach \(name). Check that it's on and that Tailscale is connected on this iPhone."
        case .notASottoHost(let name): return "\(name) answered, but Sotto isn't listening there. If \(name) has no screen, turn on Let phones reach \(name) in Sotto on your main computer: Settings > Hosts, then Phones on its row. Otherwise, in Sotto on \(name), turn on phone access in Settings > Phones."
        case .sottoNotRunning(let name): return "\(name) answered, but Sotto isn't running there. Nothing was lost. Open Sotto on \(name) and try again."
        case .invalidCode: return "A pairing code is eight letters and numbers. Check the code on that computer."
        case .invalidProtocol: return "This computer uses a different connection format. Update Sotto before connecting."
        case .invalidIdentity: return "A different computer answered at this address. Remove it and add it again if you meant to change computers."
        case .invalidRequest: return "This request changed or is not supported on this iPhone. Refresh the thread or answer on the computer."
        case .disconnected: return "Connection lost. Work carries on on the computer. Reconnect to check the thread."
        case .connectionTimedOut: return "The computer didn't finish connecting. Work carries on there. Try connecting again."
        case .readTimedOut: return "Sotto did not answer in time. Try again."
        case .rateLimited: return "Too many connection attempts. Wait a minute and try again."
        case .uncertain: return "Delivery is unconfirmed. Check the thread before sending again."
        case .rejected(let message): return message
        case .hostRefused(let message): return message
        }
    }
}

/// A computer's private HTTPS origin on the tailnet: `https://<machine>.<tailnet>.ts.net`, on port 443,
/// 8443 or 10000 only. Phone access serves its host through Tailscale Serve on 8443, or on 10000 when
/// another app holds 8443, so 443 stays free for other apps; a host run by hand is usually on 443.
/// Certificate validation is the platform's.
public struct HostEndpoint: Equatable, Sendable {
    public static let ports: Set<Int> = [443, 8443, 10000]
    public let url: URL
    public init(_ input: String) throws {
        guard var c = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme?.lowercased() == "https", let host = c.host?.lowercased(),
              host.hasSuffix(".ts.net"), host.count > 7, c.user == nil, c.password == nil,
              c.query == nil, c.fragment == nil, Self.ports.contains(c.port ?? 443),
              c.path.isEmpty || c.path == "/" else { throw ClientError.invalidHost }
        // One spelling per origin, so the same computer typed two ways is the same endpoint.
        c.scheme = "https"; c.host = host; c.path = ""
        if c.port == 443 { c.port = nil }
        guard let url = c.url else { throw ClientError.invalidHost }
        self.url = url
    }
    /// The full name on the tailnet: `forge.tail5c2e.ts.net`.
    public var host: String { url.host ?? "" }
    public var port: Int { url.port ?? 443 }
    /// The machine's name, the first label of its address: `forge`.
    public var machine: String { String(host.split(separator: ".").first ?? "") }
    /// How the address reads on screen: the full name, with the port when it isn't 443.
    public var address: String { port == 443 ? host : "\(host):\(port)" }
    public func route(_ path: String, socket: Bool = false) -> URL {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.path = path; c.scheme = socket ? "wss" : "https"
        return c.url!
    }
}

public struct Pairing: Codable, Equatable, Sendable {
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
/// `GET /v1/health`: read before pairing, so the phone knows it found a Sotto host and which one.
/// `name` is the computer's own name, which the desktop sends and older hosts don't.
public struct Health: Decodable, Equatable, Sendable {
    public let v: Int; public let status: String; public let hostId: String
    public let sottoVersion: String?; public let features: [String]?; public let name: String?
    /// The name to show for the computer, when it gave one that reads as a name.
    public var computerName: String? { ComputerName.cleaned(name) }
    public func validate() throws {
        guard v == 1 else { throw ClientError.invalidProtocol }
        guard UUID(uuidString: hostId) != nil else { throw ClientError.invalidIdentity }
        guard status == "ready" else { throw ClientError.rejected("Sotto on that computer is still starting. Try again in a moment.") }
    }
}
public struct WireFailure: Decodable, Sendable { public let code: String; public let message: String }
public struct Receipt: Decodable, Sendable {
    public let status: String; public let error: WireFailure?; public let answerDelivered: Bool?
    /// Older hosts record transport completion only; it cannot confirm the phone's answer.
    public var confirmsAnswer: Bool { status == "completed" && error == nil && answerDelivered == true }
    /// The computer has the command and is still carrying it out: a slow provider, not a lost command.
    public var stillWorking: Bool { status == "pending" }
}
public struct Hello: Decodable, Sendable {
    /// `shell` is a `var` only so the connection can put back a catalog the host named by revision (`ModelCatalogCache`).
    public let hostId: String; public let clientId: String; public var shell: Shell; public let capabilities: Capabilities
    public let features: [String]?
    public struct Capabilities: Decodable, Equatable, Sendable { public let mayAnswer: Bool }
}
public struct Shell: Decodable, Equatable, Sendable {
    /// `host` is a `var` only so the connection can put back a catalog the host named by revision (`ModelCatalogCache`).
    public let hostId: String?; public var host: HostSnapshot; public let deliveries: [Delivery]?; public let deliveredDrafts: [DeliveryReceipt]?
    public let globalLaneBusy: Bool?; public let busyThreadIds: [String]?; public let error: String?
    /// Authority for this paired client, refreshed with the shell. Older hosts send it only in hello.
    public let clientCapabilities: Hello.Capabilities?
    public let configuration: ThreadStartPreferences?
    /// Terminal-mode rows only, from a host offering `terminals` after this phone opts in. No screen text.
    public var terminals: [TerminalSummary]? = nil
    /// Local decoding evidence only. Omitted unreadable rows cannot prove a pending approval left.
    public var terminalsComplete = false
    private enum Keys: String, CodingKey { case hostId, host, deliveries, deliveredDrafts, globalLaneBusy, busyThreadIds, error, clientCapabilities, configuration, terminals }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        hostId = try c.decodeIfPresent(String.self, forKey: .hostId)
        host = try c.decode(HostSnapshot.self, forKey: .host)
        deliveries = try c.decodeIfPresent([Delivery].self, forKey: .deliveries)
        deliveredDrafts = try c.decodeIfPresent([DeliveryReceipt].self, forKey: .deliveredDrafts)
        globalLaneBusy = try c.decodeIfPresent(Bool.self, forKey: .globalLaneBusy)
        busyThreadIds = try c.decodeIfPresent([String].self, forKey: .busyThreadIds)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        clientCapabilities = try c.decodeIfPresent(Hello.Capabilities.self, forKey: .clientCapabilities)
        configuration = try c.decodeIfPresent(ThreadStartPreferences.self, forKey: .configuration)
        // A newer or malformed terminal is omitted without losing the computer's threads.
        let rows = c.tolerant(TerminalRows.self, .terminals)
        terminals = rows?.values
        terminalsComplete = rows?.complete ?? false
    }
    public func validate(hostID: String) throws {
        guard hostId == hostID, host.hostId == hostID,
              host.threads.allSatisfy({ $0.hostId == nil || $0.hostId == hostID }) else { throw ClientError.invalidIdentity }
    }
}
public struct HostSnapshot: Decodable, Equatable, Sendable {
    public let hostId: String?; public let name: String; public let threads: [ThreadSummary]
    public let projects: [Project]; public let providers: [Provider]?
    /// Always whole once a shell leaves `HostConnection`: a catalog the host named by revision is put back there.
    public var models: [ThreadModel]?
    /// The catalog's revision, from a host that offers `model-catalog-revision`. Such a host leaves `models` out
    /// of a shell when this connection was already sent that revision whole.
    public let modelsRevision: Int?
    public let capabilities: ProviderCapabilities
}
public struct Project: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let title: String; public let workspaceSettledAt: String?
    public let path: String?; public let providerId: String?
}
public struct Provider: Decodable, Equatable, Sendable { public let id: String; public let connection: String; public let capabilities: ProviderCapabilities }
public struct ProviderCapabilities: Decodable, Equatable, Sendable {
    public let submit: Bool; public let interrupt: Bool; public let questions: Bool; public let permissions: Bool
    public let projects: Bool?; public let threads: Bool?
}
public struct ThreadSummary: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let hostId: String?; public let projectId: String; public let title: String
    public let providerId: String?; public let status: String; public let requests: [AgentRequest]
    /// The thread's model in its computer's catalog (`host.models`), which says whether it takes photos.
    public let modelId: String?
    public let earlierAvailable: Bool?; public let archivedAt: String?; public let summary: Summary?
    public let workspaceSettledAt: String?; public let settledAt: String?; public let settledOverride: String?
    public let backgroundWork: [BackgroundWork]?; public let compaction: Compaction?
    /// The computer's word that the thread finished while nothing showed it and has not been opened since, on
    /// this iPhone or the desktop (ADR-0046). Older computers never send it.
    public let finishedUnread: Bool?
    /// The thread's working copy as its computer last read it, for the branch, changes and pull request chips on
    /// the thread page. Read tolerantly: a record this build can't read is absent and never fails the thread.
    public let worktree: ThreadWorktree?
    /// Current provider-confirmed work only; never infer it from retained activity or messages.
    public struct BackgroundWork: Decodable, Equatable, Sendable { public let type: String }
    public struct Compaction: Decodable, Equatable, Sendable { public let status: String }
    /// What a row reads about the thread's history without holding it.
    public struct Summary: Decodable, Equatable, Sendable {
        public let lastMessageAt: String?; public let runningTurnStartedAt: String?
    }
}
/// What the thread page reads from a thread's worktree record (`agentWorktreeSchema` in src/shared/agents.ts): its
/// mode, its branch and the Git status the host last read there (`gitStatusSchema` in src/shared/gitStatus.ts).
/// Every field is optional and read on its own, so one missing or of another type reads as absent.
public struct ThreadWorktree: Decodable, Equatable, Sendable {
    /// `independent` for the thread's own worktree, `shared` for the project's folder.
    public let mode: String?
    public let branch: String?
    public let git: GitStatus?
    private enum Keys: String, CodingKey { case mode, branch, git }
    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: Keys.self)
        mode = c?.tolerant(String.self, .mode)
        branch = c?.tolerant(String.self, .branch)
        git = c?.tolerant(GitStatus.self, .git)
    }
    /// The folder's branch, its uncommitted changes, its distance from its upstream and its pull request.
    public struct GitStatus: Decodable, Equatable, Sendable {
        public let branch: String?
        public let changedFiles: Int?
        public let insertions: Int?
        public let deletions: Int?
        public let ahead: Int?
        public let behind: Int?
        public let dirty: Bool?
        public let pullRequest: PullRequest?
        private enum Keys: String, CodingKey { case branch, changedFiles, insertions, deletions, ahead, behind, dirty, pullRequest }
        public init(from decoder: Decoder) throws {
            let c = try? decoder.container(keyedBy: Keys.self)
            branch = c?.tolerant(String.self, .branch)
            changedFiles = c?.tolerant(Int.self, .changedFiles)
            insertions = c?.tolerant(Int.self, .insertions)
            deletions = c?.tolerant(Int.self, .deletions)
            ahead = c?.tolerant(Int.self, .ahead)
            behind = c?.tolerant(Int.self, .behind)
            dirty = c?.tolerant(Bool.self, .dirty)
            pullRequest = c?.tolerant(PullRequest.self, .pullRequest)
        }
    }
    /// The branch's pull request as the host last heard from GitHub. `state` is `open`, `closed` or `merged`.
    public struct PullRequest: Decodable, Equatable, Sendable {
        public let number: Int?
        public let title: String?
        public let url: String?
        public let state: String?
        public let draft: Bool?
        private enum Keys: String, CodingKey { case number, title, url, state, draft }
        public init(from decoder: Decoder) throws {
            let c = try? decoder.container(keyedBy: Keys.self)
            number = c?.tolerant(Int.self, .number)
            title = c?.tolerant(String.self, .title)
            url = c?.tolerant(String.self, .url)
            state = c?.tolerant(String.self, .state)
            draft = c?.tolerant(Bool.self, .draft)
        }
    }
}

private extension KeyedDecodingContainer {
    /// The value at `key`, or nil when it is missing, null or of another type.
    func tolerant<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        guard let value = try? decodeIfPresent(type, forKey: key) else { return nil }
        return value
    }
}

public struct ThreadDetail: Decodable, Sendable {
    public let threadId: String; public let revision: Int; public let messages: [Message]; public let earlierAvailable: Bool?
    public let activities: [Activity]?
}
/// Provider-reported work beside a thread's messages. Observational only: nothing here is an answer or a grant.
/// `kind` and `status` stay strings so a kind this build does not know still shows, by its title.
public struct Activity: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let sequence: Int; public let kind: String; public let status: String; public let title: String
    public let command: String?; public let exitCode: Int?; public let durationMs: Double?
    public let startedAt: String?; public let changes: [Change]?
    /// The message this step came after, when the host says. Hosts that send activity summaries leave it out.
    public let afterMessageId: String?
    public struct Change: Decodable, Equatable, Sendable { public let path: String; public let kind: String }
    /// The line under the title: the command it ran, or the files it changed.
    public var subject: String? {
        if let command, !command.isEmpty { return command }
        guard let changes, let first = changes.first else { return nil }
        return changes.count == 1 ? first.path : "\(first.path) and \(changes.count - 1) more"
    }
}
public struct Message: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let role: String; public let text: String; public let commandId: String?
    public let attachments: [Attachment]?
    /// When the message was written, as the host sends it (ISO 8601). The thread page places steps by it.
    public var createdAt: String? = nil
}
/// An image a message carries. Its bytes stay on the computer; `preview` says the computer keeps a copy
/// it will hand back by message and attachment ID (the `preview` request).
public struct Attachment: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let name: String; public let mimeType: String?; public let sizeBytes: Int?
    public let preview: Preview?
    /// Only the marker is read: the computer never puts a preview's bytes in a thread it sends a client.
    public struct Preview: Decodable, Equatable, Sendable { public let available: Bool? }
    public var hasPreview: Bool { preview != nil }
}
public struct DeliveryReceipt: Decodable, Equatable, Sendable { public let threadId: String; public let draftId: String }
public struct Delivery: Decodable, Equatable, Sendable { public let threadId: String; public let draftId: String; public let status: String }
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
        // A staged image is base64, which is full of slashes; escaped, they would only make the frame larger.
        let encoder = JSONEncoder(); encoder.outputFormatting = .withoutEscapingSlashes
        return try encoder.encode(JSONValue.object(fields))
    }
    /// `request` as the text a socket frame carries, made off the main actor: a staged image makes a frame of up
    /// to 14 MB, too much to encode where the interface draws. Nonisolated async functions run on the generic
    /// executor in Swift 5 mode.
    public static func requestTextInBackground(id: String, session: String, operation: [String: JSONValue]) async throws -> String {
        String(decoding: try request(id: id, session: session, operation: operation), as: UTF8.self)
    }
}
