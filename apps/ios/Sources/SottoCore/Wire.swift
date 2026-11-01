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
        case .invalidHost: return String(localized: "Enter the computer's name on your tailnet, such as forge, or its full address ending in .ts.net.", bundle: .module)
        case .hostNotFound(let name): return String(localized: "Couldn't find \(name) on your tailnet. Check that Tailscale is connected on this iPhone and MagicDNS is on for your tailnet, or enter the full address ending in .ts.net.", bundle: .module,
                                     comment: "%@ is the computer's name as typed, such as forge")
        case .hostUnreachable(let name): return String(localized: "Couldn't reach \(name). Check that it's on and that Tailscale is connected on this iPhone.", bundle: .module,
                                     comment: "%@ is the computer's name, such as forge")
        case .notASottoHost(let name): return String(localized: "\(name) answered, but Sotto isn't listening there. If \(name) has no screen, turn on Let phones reach \(name) in Sotto on your main computer: Settings > Hosts & phones, then Phones on its row. Otherwise, in Sotto on \(name), turn on phone access in Settings > Hosts & phones.", bundle: .module,
                                     comment: "Every %@ is the computer's name, such as forge")
        case .sottoNotRunning(let name): return String(localized: "\(name) answered, but Sotto isn't running there. Nothing was lost. Open Sotto on \(name) and try again.", bundle: .module,
                                     comment: "Every %@ is the computer's name, such as forge")
        case .invalidCode: return String(localized: "A pairing code is eight letters and numbers. Check the code on that computer.", bundle: .module)
        case .invalidProtocol: return String(localized: "This computer uses a different connection format. Update Sotto before connecting.", bundle: .module)
        case .invalidIdentity: return String(localized: "A different computer answered at this address. Remove it and add it again if you meant to change computers.", bundle: .module)
        case .invalidRequest: return String(localized: "This request changed or is not supported on this iPhone. Refresh the thread or answer on the computer.", bundle: .module)
        case .disconnected: return String(localized: "Connection lost. Work carries on on the computer. Reconnect to check the thread.", bundle: .module)
        case .connectionTimedOut: return String(localized: "The computer didn't finish connecting. Work carries on there. Try connecting again.", bundle: .module)
        case .readTimedOut: return String(localized: "Sotto did not answer in time. Try again.", bundle: .module)
        case .rateLimited: return String(localized: "Too many connection attempts. Wait a minute and try again.", bundle: .module)
        case .uncertain: return String(localized: "Delivery is unconfirmed. Check the thread before sending again.", bundle: .module)
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
        guard status == "ready" else { throw ClientError.rejected(String(localized: "Sotto on that computer is still starting. Try again in a moment.", bundle: .module)) }
    }
}
public struct WireFailure: Decodable, Sendable {
    public let code: String; public let message: String
    /// Why a pull request read was refused (`gh-missing`, `gh-signed-out`, `offline`, `unreadable`), from a host since
    /// #1290; nil on every other refusal and from an older host.
    public let reason: String?
}
public struct Receipt: Decodable, Sendable {
    public let status: String; public let error: WireFailure?; public let answerDelivered: Bool?
    public let watcherStop: WatcherStopReceipt?
    public let watcherManage: WatcherManageReceipt?
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
    /// Present only after accepting watcher-phone from the Owl desktop running it.
    public var watcher: WatcherPhoneState? = nil
    /// Every thread's follow-up queue, in order. Older hosts send none.
    public let followups: [Followup]?
    /// Queued replies the queue has taken from their delivery, by draft. Older hosts send none.
    public let followupReceipts: [DeliveryReceipt]?
    /// Thread settings changes the provider never gave a result for, which the computer keeps (ADR-0166). Read item by item.
    public var unconfirmedSettings: ThreadList<UnconfirmedSetting>? = nil
    /// The thread records a shell push carried beside a state whose own list is empty, from a host that sends this
    /// connection only the ones that changed (`changed-thread-records`). Always nil once a shell leaves `HostConnection`,
    /// which puts the whole list back (`ThreadRecordsCache`).
    public var threadRecords: ChangedThreadRecords? = nil
    /// How many settled threads the computer's list leaves out, from a host that sends this phone only the threads settled
    /// this week (`settled-threads-on-request`): the Settled shelf reads them with `settled-threads`. Nil from any other.
    public let settledHeldBack: Int?
    private enum Keys: String, CodingKey { case hostId, host, deliveries, deliveredDrafts, globalLaneBusy, busyThreadIds, error, clientCapabilities, configuration, followups, followupReceipts, watcher, unconfirmedSettings, settledHeldBack }
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
        followups = try c.decodeIfPresent([Followup].self, forKey: .followups)
        followupReceipts = try c.decodeIfPresent([DeliveryReceipt].self, forKey: .followupReceipts)
        watcher = c.tolerant(WatcherPhoneState.self, .watcher)
        unconfirmedSettings = c.tolerant(ThreadList<UnconfirmedSetting>.self, .unconfirmedSettings)
        settledHeldBack = try c.decodeIfPresent(Int.self, forKey: .settledHeldBack)
    }
    public func validate(hostID: String) throws {
        guard hostId == hostID, host.hostId == hostID,
              host.threads.allSatisfy({ $0.hostId == nil || $0.hostId == hostID }) else { throw ClientError.invalidIdentity }
    }
}
public struct HostSnapshot: Decodable, Equatable, Sendable {
    /// `threads` is a `var` only so the connection can put back the records a push left out (`ThreadRecordsCache`).
    public let hostId: String?; public let name: String; public var threads: [ThreadSummary]
    public let projects: [Project]; public let providers: [Provider]?
    /// Always whole once a shell leaves `HostConnection`: a catalog the host named by revision is put back there.
    public var models: [ThreadModel]?
    /// The catalog's revision, from a host that offers `model-catalog-revision`. Such a host leaves `models` out
    /// of a shell when this connection was already sent that revision whole.
    public let modelsRevision: Int?
    public let capabilities: ProviderCapabilities
    /// From a host that offers `provider-mode-lists`, each distinct list of provider modes in `models`, which a model names
    /// by its place here. Nil once a shell leaves `HostConnection`, its lists put back on each model.
    public var providerModeLists: [[ThreadModel.ProviderMode]]? = nil
}
public struct Project: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let title: String; public let workspaceSettledAt: String?
    public let path: String?; public let providerId: String?
}
public struct Provider: Decodable, Equatable, Sendable { public let id: String; public let connection: String; public let capabilities: ProviderCapabilities }
public struct ProviderCapabilities: Decodable, Equatable, Sendable {
    public let submit: Bool; public let interrupt: Bool; public let questions: Bool; public let permissions: Bool
    public let projects: Bool?; public let threads: Bool?
    /// Whether the provider takes a message into a running turn, and compacts a thread's context when asked.
    public let steer: Bool?; public let compact: Bool?
    /// Whether a thread's settings change in place, and whether a started thread's model and effort do too, or only its
    /// permissions. Older computers send neither, and their threads' chips stay off the reply box (ADR-0166).
    public var configureThread: Bool? = nil
    public var configureThreadModel: Bool? = nil
}
public struct ThreadSummary: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let hostId: String?; public let projectId: String; public let title: String
    public let providerId: String?; public let status: String; public let requests: [AgentRequest]
    /// The thread's model in its computer's catalog (`host.models`), which says whether it takes photos.
    public let modelId: String?
    /// What the thread runs with besides its model, for the reply box's chips (ADR-0166): its effort, Sotto's permission
    /// mode or its provider's own, and its speed (`speed`, null at Standard, or the older `fastMode`). Older computers
    /// may send none of them.
    public var reasoningEffort: String? = nil
    public var runtimeMode: String? = nil
    public var providerMode: String? = nil
    public var speed: String? = nil
    public var fastMode: Bool? = nil
    public let earlierAvailable: Bool?; public let archivedAt: String?; public let summary: Summary?
    public let workspaceSettledAt: String?; public let settledAt: String?; public let settledOverride: String?
    public let backgroundWork: [BackgroundWork]?; public let compaction: Compaction?
    /// The computer's word that the thread finished while nothing showed it and has not been opened since, on
    /// this iPhone or the desktop (ADR-0046). Older computers never send it.
    public var kind: String? = nil
    public var watchedByWatcher: Bool? = nil
    /// `default` while the thread keeps the name it opened with, `user` or `generated` once renamed. Older computers may not send it.
    public var titleSource: String? = nil
    /// The thread on the same computer that delegated to this one, by its Sotto thread ID (ADR-0081). Only a computer
    /// with delegation on sends it, and never for a delegating thread this iPhone can't read.
    public var delegatedBy: String? = nil
    /// How many sub-agents the thread's provider reports, and how many work (ADR-0103). Read tolerantly.
    public var subagentSummary: SubagentSummary? = nil
    /// The computer's word that the thread's last turn failed and a client has shown it since, or Dismiss all named it
    /// (ADR-0092). Only a computer that lists `failure-seen` sends it; the Agents view reads it (ADR-0103).
    public var failureSeen: Bool? = nil
    /// How many monitors the thread's provider runs. Never work on its own (`ThreadState`), but its end can move a
    /// delegated thread's outcome from Background work to Answered, so the Agents sheet reads again (ADR-0103).
    public var monitoring: MonitorCount? = nil
    /// Sotto moved the thread off a model its provider stopped offering (ADR-0171). Older computers never send it.
    public var modelMoved: ModelMoved? = nil
    public let finishedUnread: Bool?
    /// The thread's working copy as its computer last read it, for the branch, changes and pull request chips on
    /// the thread page. Read tolerantly: a record this build can't read is absent and never fails the thread.
    public let worktree: ThreadWorktree?
    /// False when the thread's provider says it can't compact this thread, or its native session hasn't started yet.
    /// Absent means not known, as from an older computer.
    public let manualCompactionSupported: Bool?; public let nativeSessionStarted: Bool?
    /// Current provider-confirmed work only; never infer it from retained activity or messages.
    public struct BackgroundWork: Decodable, Equatable, Sendable { public let type: String }
    public struct Compaction: Decodable, Equatable, Sendable { public let status: String }
    /// What a row reads about the thread's history without holding it.
    public struct Summary: Decodable, Equatable, Sendable {
        public let lastMessageAt: String?; public let runningTurnStartedAt: String?
        /// How many messages the thread holds. Absent from older computers.
        public var messageCount: Int? = nil
    }
    /// The pull requests the thread babysits, and why babysitting each last ended on its own (ADR-0061), for the pull
    /// request sheet (ADR-0102). Read item by item, so a later host's record never fails the thread. Older hosts send none.
    public var babysitting: ThreadList<ThreadBabysitting>? = nil
    public var babysitEnded: ThreadList<ThreadBabysitEnded>? = nil
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

/// A message in a thread's follow-up queue (`agentFollowupSchema` in src/shared/agents.ts): one of the user's, waiting
/// for the running turn to end, or Sotto's one wake-up (ADR-0061), which is removable and never steered. `status` is
/// `queued`, `dispatching`, `uncertain`, `failed` or `paused`, kept a string so a status this build doesn't know still
/// shows. Only the fields the queue's cards read; the optional ones are read on their own.
public struct Followup: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let threadId: String; public let draftId: String; public let text: String
    public let status: String
    public let createdAt: String?; public let updatedAt: String?
    public let error: String?
    /// The message it became, once it was dispatched.
    public let messageId: String?
    public let wakeUp: Bool?
    /// How many photos it carries. Their handles stay on the computer.
    public let attachmentCount: Int
    private enum Keys: String, CodingKey { case id, threadId, draftId, text, status, createdAt, updatedAt, error, messageId, wakeUp, attachments }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        threadId = try c.decode(String.self, forKey: .threadId)
        draftId = try c.decode(String.self, forKey: .draftId)
        text = try c.decode(String.self, forKey: .text)
        status = try c.decode(String.self, forKey: .status)
        createdAt = c.tolerant(String.self, .createdAt)
        updatedAt = c.tolerant(String.self, .updatedAt)
        error = c.tolerant(String.self, .error)
        messageId = c.tolerant(String.self, .messageId)
        wakeUp = c.tolerant(Bool.self, .wakeUp)
        attachmentCount = c.tolerant([JSONValue].self, .attachments)?.count ?? 0
    }
}

private extension KeyedDecodingContainer {
    /// The value at `key`, or nil when it is missing, null or of another type.
    func tolerant<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        guard let value = try? decodeIfPresent(type, forKey: key) else { return nil }
        return value
    }
}

/// Sotto moved a thread off a model its provider stopped offering (ADR-0171): the two models' names and when. The thread's
/// page draws one line after the last message written before then.
public struct ModelMoved: Decodable, Equatable, Sendable {
    public let from: String; public let to: String; public let at: String
    public init(from: String, to: String, at: String) { self.from = from; self.to = to; self.at = at }
    /// The message the line follows: the last one written at or before the move. Nil when none was, so the line leads.
    public func anchor(in messages: [Message], date: (String) -> Date? = Stamp.date) -> String? {
        guard let moment = date(at) else { return messages.last?.id }
        return messages.last(where: { message in message.createdAt.flatMap(date).map { $0 <= moment } ?? false })?.id
    }
    /// The line's words, with the thread's provider named: "Claude Code no longer offers …, so this thread now uses …."
    public func words(provider: String) -> String {
        String(localized: "\(provider) no longer offers \(from), so this thread now uses \(to).", bundle: .module,
               comment: "A note in a thread: its model was retired by the provider (first), and Sotto moved it to another (third).")
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
    /// The pictures this step made or looked at (ADR-0170): handles only. A tile reads one's bytes with `thread-media`
    /// when it shows, from a computer that lists that feature.
    public var media: [Media]? = nil
    /// "image" when the step makes an image (ADR-0170): while it runs with no picture yet, its tile plays the owl at the
    /// easel. Older computers never send it.
    public var generates: String? = nil
    /// Whether the step is making an image that has not landed: it runs and holds no picture yet.
    public var makingImage: Bool { generates == "image" && status == "running" && (media ?? []).isEmpty }
    public struct Change: Decodable, Equatable, Sendable { public let path: String; public let kind: String }
    /// One picture's handle: its place in the step, its type, and its size when the computer read it.
    public struct Media: Decodable, Identifiable, Equatable, Sendable {
        public let id: String; public let kind: String; public let mimeType: String
        public let width: Int?; public let height: Int?; public let name: String; public let source: String
    }
    /// The line under the title: the command it ran, or the files it changed.
    public var subject: String? {
        if let command, !command.isEmpty { return command }
        guard let changes, let first = changes.first else { return nil }
        return changes.count == 1 ? first.path : StepRun.andMore(first.path, more: changes.count - 1)
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
public struct Delivery: Decodable, Equatable, Sendable {
    public let threadId: String; public let draftId: String; public let status: String
    /// A delivery the user set aside, which no longer waits to go. Older computers never send it.
    public var setAside: Bool? = nil
}
public struct AgentRequest: Decodable, Equatable, Identifiable, Sendable {
    public let id: String; public let kind: String; public let text: String; public let options: [RequestOption]
    public let questions: [Question]?; public let permissionChoices: [PermissionChoice]?; public let context: RequestContext?; public let delivery: String?
    /// The pages the computer found for a question (ADR-0085), each one the sheet offers to open. An older computer sends
    /// none, and a page this build cannot read is left out rather than losing the request.
    public var pages: [RequestPage] = []
    /// Whether this asks what `other` asks, leaving the pages out: the computer adds those beside the provider's request a
    /// moment after it arrives, so a request read before they came is still the same request to answer. Equality keeps
    /// them, so the pages arriving is a change the sheet shows.
    public func asksTheSame(as other: AgentRequest) -> Bool {
        id == other.id && kind == other.kind && text == other.text && options == other.options && questions == other.questions
            && permissionChoices == other.permissionChoices && context == other.context && delivery == other.delivery
    }
    public var supported: Bool {
        guard delivery != "uncertain" else { return false }
        if kind == "question" { return true }
        if kind == "permission" && permissionChoices == nil { return true }
        return kind == "permission" && !(permissionChoices ?? []).isEmpty &&
            (permissionChoices ?? []).allSatisfy { ["allow-once", "allow-session", "allow-always", "deny", "cancel"].contains($0.kind) }
    }
}
extension AgentRequest {
    private enum Keys: String, CodingKey { case id, kind, text, options, questions, permissionChoices, context, delivery, pages }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        text = try c.decode(String.self, forKey: .text)
        options = try c.decode([RequestOption].self, forKey: .options)
        questions = try c.decodeIfPresent([Question].self, forKey: .questions)
        permissionChoices = try c.decodeIfPresent([PermissionChoice].self, forKey: .permissionChoices)
        context = try c.decodeIfPresent(RequestContext.self, forKey: .context)
        delivery = try c.decodeIfPresent(String.self, forKey: .delivery)
        pages = (c.tolerant([Lossy<RequestPage>].self, .pages) ?? []).compactMap(\.value)
    }
}
/// One element of a list read on its own: nil when it cannot be read, so the rest of the list still is.
private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}
/// A page the computer found for a question, in its words or the agent's message before it (ADR-0085): an HTML file in
/// the thread's folder, or a page the agent serves on that computer. The computer that runs the thread serves it at
/// `/page/<token>/<start>`; `name` is what its row shows. `kind` stays a string, as `file` or `server`.
public struct RequestPage: Decodable, Equatable, Identifiable, Sendable {
    public let token: String; public let kind: String; public let name: String; public let start: String
    public var id: String { token }
    /// Where the page opens on the computer's own tailnet address, or nil when its token or start could not make one.
    public func url(on endpoint: HostEndpoint) -> URL? {
        guard token.range(of: #"^[A-Za-z0-9_-]{32}$"#, options: .regularExpression) != nil,
              // The endpoint is an origin with no path, so the page's path follows it directly.
              let url = URL(string: "\(endpoint.url.absoluteString)/page/\(token)/\(start)"),
              url.host == endpoint.host, url.path.hasPrefix("/page/\(token)/") else { return nil }
        return url
    }
}
public struct RequestOption: Decodable, Equatable, Identifiable, Sendable { public let id: String; public let label: String; public let description: String? }
public struct Question: Decodable, Equatable, Identifiable, Sendable {
    public let id: String; public let question: String; public let header: String?; public let options: [RequestOption]
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
