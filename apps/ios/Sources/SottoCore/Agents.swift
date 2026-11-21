import Foundation

// The Agents view (ADR-0103, an Owl feature): a thread's top bar counts its delegated threads (ADR-0081) and its
// provider's own sub-agents, and opens a sheet listing them as the desktop's Tools › Agents does
// (`src/renderer/src/tools/delegatedRoster.ts`). Only a computer that lists `agents-view` offers it. Pure, so the sheet,
// the top bar and the tests read one answer.

/// The counts a thread's shell carries of its provider's own sub-agents (`subagentSummarySchema` in
/// src/shared/subagents.ts). Each is read on its own: one missing or of another type reads as none, and the record
/// never fails its thread.
public struct SubagentSummary: Decodable, Equatable, Sendable {
    public let total: Int; public let working: Int; public let unknown: Int
    public init(total: Int = 0, working: Int = 0, unknown: Int = 0) { self.total = total; self.working = working; self.unknown = unknown }
    private enum Keys: String, CodingKey { case total, working, unknown }
    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: Keys.self)
        total = max(0, c?.readable(Int.self, .total) ?? 0)
        working = max(0, c?.readable(Int.self, .working) ?? 0)
        unknown = max(0, c?.readable(Int.self, .unknown) ?? 0)
    }
}

/// One of a thread's sub-agents as `subagent-page` sends it (`subagentRowSchema`). `status` stays a string: `running`,
/// `completed`, `failed`, `interrupted` or `unknown`. A workflow's row stands for its run, with its agents under it.
public struct SubagentRow: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let parentId: String?
    public let sequence: Int
    public let assignmentId: String?
    public let title: String
    public let description: String
    public let model: String?
    public let status: String
    public let startedAt: String?
    public let completedAt: String?
    public let lastObservedAt: String?
    public let durationMs: Double?
    /// `workflow` for a workflow's run, which stands for its agents and is not one of them.
    public let kind: String?
    /// Goes up each time the computer's record of the agent changes, its latest update or result among them.
    public let revision: Int?
    public init(id: String, parentId: String? = nil, sequence: Int = 1, assignmentId: String? = nil, title: String, description: String = "",
                model: String? = nil, status: String, startedAt: String? = nil, completedAt: String? = nil, lastObservedAt: String? = nil,
                durationMs: Double? = nil, kind: String? = nil, revision: Int? = nil) {
        self.id = id; self.parentId = parentId; self.sequence = sequence; self.assignmentId = assignmentId; self.title = title
        self.description = description; self.model = model; self.status = status; self.startedAt = startedAt
        self.completedAt = completedAt; self.lastObservedAt = lastObservedAt; self.durationMs = durationMs; self.kind = kind
        self.revision = revision
    }
    private enum Keys: String, CodingKey { case id, parentId, sequence, assignmentId, title, description, model, status, startedAt, completedAt, lastObservedAt, durationMs, kind, revision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        parentId = c.readable(String.self, .parentId)
        sequence = c.readable(Int.self, .sequence) ?? 0
        assignmentId = c.readable(String.self, .assignmentId)
        title = c.readable(String.self, .title) ?? ""
        description = c.readable(String.self, .description) ?? ""
        model = c.readable(String.self, .model)
        status = c.readable(String.self, .status) ?? "unknown"
        startedAt = c.readable(String.self, .startedAt)
        completedAt = c.readable(String.self, .completedAt)
        lastObservedAt = c.readable(String.self, .lastObservedAt)
        durationMs = c.readable(Double.self, .durationMs)
        kind = c.readable(String.self, .kind)
        revision = c.readable(Int.self, .revision)
    }
}

/// A page of a thread's sub-agents (`subagent-page`). A row this build can't read is left out; the rest still show.
public struct SubagentPage: Decodable, Sendable {
    public let threadId: String
    public let rows: [SubagentRow]
    public let summary: SubagentSummary
    /// Where the next older page starts, while there is one.
    public let before: Int?
    public init(threadId: String, rows: [SubagentRow], summary: SubagentSummary, before: Int? = nil) {
        self.threadId = threadId; self.rows = rows; self.summary = summary; self.before = before
    }
    private enum Keys: String, CodingKey { case threadId, rows, summary, before }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        rows = (c.readable([Readable<SubagentRow>].self, .rows) ?? []).compactMap(\.value)
        summary = c.readable(SubagentSummary.self, .summary) ?? SubagentSummary()
        before = c.readable(Int.self, .before)
    }
}

/// One run of a sub-agent (`subagent-assignments`): what it was asked, and its latest update or its result.
public struct SubagentAssignment: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let status: String
    public let prompt: String?
    public let result: String?
    public init(id: String, title: String = "", status: String, prompt: String? = nil, result: String? = nil) {
        self.id = id; self.title = title; self.status = status; self.prompt = prompt; self.result = result
    }
    private enum Keys: String, CodingKey { case id, title, status, prompt, result }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.readable(String.self, .title) ?? ""
        status = c.readable(String.self, .status) ?? "unknown"
        prompt = c.readable(String.self, .prompt)
        result = c.readable(String.self, .result)
    }
}

/// One sub-agent's runs, newest first.
public struct SubagentAssignmentsPage: Decodable, Sendable {
    public let threadId: String
    public let agentId: String
    public let assignments: [SubagentAssignment]
    public init(threadId: String, agentId: String, assignments: [SubagentAssignment]) {
        self.threadId = threadId; self.agentId = agentId; self.assignments = assignments
    }
    private enum Keys: String, CodingKey { case threadId, agentId, assignments }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        agentId = try c.decode(String.self, forKey: .agentId)
        assignments = (c.readable([Readable<SubagentAssignment>].self, .assignments) ?? []).compactMap(\.value)
    }
}

/// How many monitors a thread's provider runs (`agentMonitoringSchema` in src/shared/agentMonitoring.ts), counted
/// without reading them. Anything but a list reads as none, and the record never fails its thread.
public struct MonitorCount: Decodable, Equatable, Sendable {
    public let count: Int
    public init(_ count: Int = 0) { self.count = count }
    public init(from decoder: Decoder) throws {
        let list = try? decoder.unkeyedContainer()
        count = list?.count ?? 0
    }
}

/// What delegation's record knows of one delegated thread (`hostDelegatedThreadSchema` in src/shared/agentsView.ts):
/// the thread that delegated to it, the kind of work, when it started, its newest outcome and the start of its brief.
/// Never its reply. `outcome` stays a string, so one this build doesn't know still shows a row.
public struct DelegatedThreadRecord: Decodable, Equatable, Sendable {
    public let thread: String
    public let by: String
    public let work: String?
    public let outcome: String
    public let startedAt: String?
    public let outcomeAt: String?
    public let brief: String?
    public init(thread: String, by: String, work: String? = nil, outcome: String, startedAt: String? = nil, outcomeAt: String? = nil, brief: String? = nil) {
        self.thread = thread; self.by = by; self.work = work; self.outcome = outcome; self.startedAt = startedAt; self.outcomeAt = outcomeAt; self.brief = brief
    }
    private enum Keys: String, CodingKey { case thread, by, work, outcome, startedAt, outcomeAt, brief }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        thread = try c.decode(String.self, forKey: .thread)
        by = try c.decode(String.self, forKey: .by)
        work = c.readable(String.self, .work)
        outcome = c.readable(String.self, .outcome) ?? "unknown"
        startedAt = c.readable(String.self, .startedAt)
        outcomeAt = c.readable(String.self, .outcomeAt)
        brief = c.readable(String.self, .brief)
    }
}

/// A thread's delegated threads as its computer answers `thread-delegations`.
public struct ThreadDelegations: Decodable, Sendable {
    public let threadId: String
    public let threads: [DelegatedThreadRecord]
    public init(threadId: String, threads: [DelegatedThreadRecord]) { self.threadId = threadId; self.threads = threads }
    private enum Keys: String, CodingKey { case threadId, threads }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        threads = (c.readable([Readable<DelegatedThreadRecord>].self, .threads) ?? []).compactMap(\.value)
    }
}

/// What the top bar's Agents control says of a thread: how many delegated threads and sub-agents it has, and how many
/// of its delegated threads wait on the user. Read from the thread list alone, so it needs no request.
public struct AgentsCount: Equatable, Sendable {
    public let total: Int
    public let needs: Int
    public init(total: Int, needs: Int) { self.total = total; self.needs = needs }
}

/// How long a row has worked: counting from its start while it works, the time it took once it ended, or not known.
public enum AgentsElapsed: Equatable, Sendable {
    case since(Date), took(TimeInterval), unknown
}

/// One row of the sheet: a delegated thread, which opens, or a sub-agent, which opens in place to its task and result.
public struct AgentsRow: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case thread, agent }
    /// The row's light and its status word's colour. Settled is quiet: a settled thread's agents, and a settled delegated
    /// thread, show their work without colour; only what needs the user keeps its light.
    public enum Tone: Equatable, Sendable { case needs, working, failed, done, quiet }
    public let id: String
    public let kind: Kind
    /// 1 under the sheet's own thread; 2 and deeper under a delegated thread or a sub-agent.
    public let level: Int
    public let title: String
    /// The delegated thread's ID, for a thread row.
    public let threadID: String?
    /// The sub-agent's ID, for an agent row.
    public let agentID: String?
    public let providerID: String?
    /// The title of the thread that delegated to it, where that is not the sheet's own thread.
    public let delegatedBy: String?
    /// A thread row's brief, or an agent row's description.
    public let preview: String?
    /// Where a delegated thread runs, provider · project · computer, as every thread's line reads, then its kind of work and
    /// model; an agent's model. Before the start time.
    public let facts: [String]
    public let startedAt: Date?
    public let elapsed: AgentsElapsed
    /// What it is doing, in the glossary's words; nil while nothing is known of it.
    public let status: String?
    public let tone: Tone
    /// `approval` or `question` while a delegated thread waits on the user for one.
    public let waitingFor: String?
    /// An agent row that is a workflow's run: it stands for the agents listed under it, and no count includes it.
    public var workflow = false
    /// What an opened agent's task and result were read for: its run, its revision and its status. When it changes, they
    /// are read again.
    public var detailsKey: String? = nil
    /// The computer a delegated thread runs on, where that is not the sheet's own thread's (#2750): its row opens it there.
    public var hostID: String? = nil

    /// Whether the row's "Delegated by" line adds that Watcher watches it through that thread (#1217, Zach's pick B). Only
    /// a row below a thread the sheet's own thread delegated to has the line, and Watcher, which talks only to the thread
    /// at the top, reaches it through them while it watches the sheet's own thread.
    public func watchedThrough(sheetWatched: Bool) -> Bool { delegatedBy != nil && sheetWatched }
    /// Provider · project · computer · kind of work · model · start time, each only where it is known.
    public func meta(clock: (Date) -> String) -> String {
        (facts + (startedAt.map { [clock($0)] } ?? [])).joined(separator: " · ")
    }
    /// What the row says to VoiceOver: what it is, what it is doing, and what a press does.
    public var spokenLabel: String {
        switch kind {
        case .thread:
            let what = providerID.map {
                String(localized: "\(title), delegated thread on \(AgentNames.name($0))", bundle: .module,
                       comment: "A delegated thread's row for VoiceOver; the first %@ is its title, the second its agent's name, such as Codex")
            } ?? String(localized: "\(title), delegated thread", bundle: .module, comment: "A delegated thread's row for VoiceOver; %@ is its title")
            let said = Self.withStatus(what, status)
            return waitingFor != nil
                ? String(localized: "\(said). Opens it to answer", bundle: .module,
                         comment: "A delegated thread's row for VoiceOver; %@ is what the row is and what it is doing")
                : String(localized: "\(said). Opens it", bundle: .module,
                         comment: "A delegated thread's row for VoiceOver; %@ is what the row is and what it is doing")
        case .agent:
            let what = workflow
                ? String(localized: "\(title), workflow", bundle: .module, comment: "A workflow's row for VoiceOver; %@ is its title")
                : String(localized: "\(title), agent", bundle: .module, comment: "A sub-agent's row for VoiceOver; %@ is its title")
            return Self.withStatus(what, status)
        }
    }
    /// What the row is, then what it is doing where that is known.
    private static func withStatus(_ what: String, _ status: String?) -> String {
        guard let status else { return what }
        return String(localized: "\(what), \(status)", bundle: .module,
                      comment: "A row for VoiceOver; the first %@ is what the row is, the second what it is doing, such as Working")
    }
}

public enum AgentsRoster {
    /// The host feature that offers the view.
    public static let feature = "agents-view"

    /// The kind of work a delegation is for, as the desktop names it (`DELEGATION_WORK_TITLES`).
    public static func workTitle(_ work: String?) -> String? {
        let titles: [String: String] = [
            "building": String(localized: "Building", bundle: .module, comment: "A kind of delegated work: writing and changing code"),
            "ui": String(localized: "UI work", bundle: .module, comment: "A kind of delegated work: screens, styles and how they look"),
            "code-review": String(localized: "Code review", bundle: .module, comment: "A kind of delegated work"),
            "research": String(localized: "Research", bundle: .module, comment: "A kind of delegated work: reading and reporting back"),
            "computer-use": String(localized: "Computer use", bundle: .module, comment: "A kind of delegated work: driving apps on the computer"),
        ]
        return titles[work ?? ""]
    }
    /// A delegation's outcome in the glossary's words (`DELEGATION_OUTCOME_WORDS`).
    public static func outcomeWord(_ outcome: String) -> String {
        let unknown = String(localized: "Unknown", bundle: .module, comment: "A delegated thread's outcome when the computer can't say it")
        let words: [String: String] = [
            "working": String(localized: "Working", bundle: .module, comment: "A delegated thread's outcome or a sub-agent's status: it is running"),
            "background": String(localized: "Background work", bundle: .module, comment: "A delegated thread's outcome: work goes on after its turn"),
            "answered": String(localized: "Answered", bundle: .module, comment: "A delegated thread's outcome: it replied"),
            "failed": String(localized: "Failed", bundle: .module, comment: "A delegated thread's outcome or a sub-agent's status"),
            "stopped": String(localized: "Stopped", bundle: .module, comment: "A delegated thread's outcome: it was stopped"),
            "paused": String(localized: "Paused", bundle: .module, comment: "A delegated thread's outcome"),
            "unknown": unknown,
            "refused": String(localized: "Refused", bundle: .module, comment: "A delegated thread's outcome: the delegation was refused"),
        ]
        return words[outcome] ?? unknown
    }
    /// A sub-agent's status as Tools › Agents words it.
    public static func agentWord(_ status: String) -> String {
        let words: [String: String] = [
            "running": String(localized: "Working", bundle: .module, comment: "A delegated thread's outcome or a sub-agent's status: it is running"),
            "completed": String(localized: "Finished", bundle: .module, comment: "A sub-agent's status"),
            "failed": String(localized: "Failed", bundle: .module, comment: "A delegated thread's outcome or a sub-agent's status"),
            "interrupted": String(localized: "Interrupted", bundle: .module, comment: "A sub-agent's status: it was stopped before it finished"),
        ]
        return words[status] ?? String(localized: "Last seen working", bundle: .module,
                                       comment: "A sub-agent's status when the computer can no longer confirm it, last seen running")
    }
    /// The heading over an opened agent's latest words, by its run's status, as Tools › Agents heads them.
    public static func resultHeading(_ status: String) -> String {
        switch status {
        case "running": return String(localized: "Latest update", bundle: .module, comment: "Heads a running agent's newest words")
        case "unknown": return String(localized: "Last update", bundle: .module, comment: "Heads the last words of an agent the computer can no longer confirm")
        case "failed": return String(localized: "What happened", bundle: .module, comment: "Heads a failed agent's last words")
        default: return String(localized: "Result", bundle: .module, comment: "Heads a finished agent's result")
        }
    }
    /// An opened agent's latest words, or what to say when it reported none.
    public static func resultWords(_ assignment: SubagentAssignment) -> String {
        if let result = assignment.result, !result.isEmpty { return result }
        return assignment.status == "running" ? String(localized: "No result reported yet.", bundle: .module)
            : String(localized: "No result was reported.", bundle: .module)
    }
    /// What a delegated thread waits on the user for: a permission ahead of a question. A settled thread still waits, as it
    /// stays in Needs you on the Threads tab: only the user can answer it (ADR-0081 decision 11, ADR-0004).
    public static func waitingFor(_ thread: ThreadSummary) -> String? {
        guard !thread.requests.isEmpty else { return nil }
        if thread.requests.contains(where: { $0.kind == "permission" }) { return "approval" }
        return thread.requests.contains(where: { $0.kind == "question" }) ? "question" : nil
    }
    /// A delegated thread whose last turn failed, that asks nothing and that no client has shown since: it says Needs
    /// attention, as its desktop row does (`failureUnseen` in src/shared/threadFailures.ts, ADR-0092). Settled is quiet,
    /// so a settled one never does. `failuresSeen` is whether its computer publishes `failureSeen` (`failure-seen`):
    /// without that word no failure can be told unseen, so none is.
    public static func failureUnseen(_ thread: ThreadSummary, failuresSeen: Bool = true) -> Bool {
        failuresSeen && thread.status == "error" && thread.requests.isEmpty && thread.failureSeen != true && !ThreadGroups.isSettled(thread)
    }
    /// Whether a delegated thread needs the user: a permission or a question waiting, or a failure no client has shown.
    public static func needsYou(_ thread: ThreadSummary, failuresSeen: Bool = true) -> Bool {
        waitingFor(thread) != nil || failureUnseen(thread, failuresSeen: failuresSeen)
    }

    /// One delegated thread below a thread: 1 under it, 2 under one of its delegated threads, `by`.
    public struct Below: Sendable {
        public let thread: ThreadSummary
        public let level: Int
        public let by: ThreadSummary?
    }
    /// The delegated threads below `owner`, two levels, from the list's own `delegatedBy` links: each first-level one,
    /// then its own.
    public static func delegated(below owner: String, in threads: [ThreadSummary]) -> [Below] {
        var children: [String: [ThreadSummary]] = [:]
        for thread in threads { if let by = thread.delegatedBy, by != thread.id { children[by, default: []].append(thread) } }
        let first = (children[owner] ?? []).filter { $0.id != owner }
        let firstIDs = Set(first.map(\.id))
        var result: [Below] = []
        for thread in first {
            result.append(Below(thread: thread, level: 1, by: nil))
            for child in children[thread.id] ?? [] where child.id != owner && !firstIDs.contains(child.id) {
                result.append(Below(thread: child, level: 2, by: thread))
            }
        }
        return result
    }

    /// One computer's threads as the phone holds them, for delegations that cross computers (#2750).
    public struct ComputerThreads: Sendable {
        public let hostID: String
        public let threads: [ThreadSummary]
        public init(hostID: String, threads: [ThreadSummary]) { self.hostID = hostID; self.threads = threads }
    }
    /// One delegated thread below a thread, on whichever of the phone's computers runs it: 1 under it, 2 under one of its
    /// delegated threads, `by`.
    public struct BelowAcross: Sendable {
        public let thread: ThreadSummary
        public let hostID: String
        public let level: Int
        public let by: ThreadSummary?
        public init(thread: ThreadSummary, hostID: String, level: Int, by: ThreadSummary?) { self.thread = thread; self.hostID = hostID; self.level = level; self.by = by }
    }
    /// What a computer gives a delegated thread's row: its projects and models, and its name.
    public struct Place: Sendable {
        public let projects: [Project]
        public let computer: String?
        public let models: [ThreadModel]
        public init(projects: [Project], computer: String?, models: [ThreadModel]) { self.projects = projects; self.computer = computer; self.models = models }
    }

    /// The delegated threads below `owner`, two levels, on whichever of the phone's computers they run (#2750), as the
    /// desktop's Tools › Agents finds them across machines. A `delegatedBy` link names its thread three ways: a bare ID on
    /// the thread's own computer; `host:<hostId>:<id>`, as a desktop names a paired host's thread that delegated to one of
    /// its own; and `relay:<client>:<caller>`, as a host names a desktop's thread that delegated to one of its own, which is
    /// found by its ID on another of the phone's computers. A link that names nothing the phone holds names no one here.
    public static func delegatedAcross(below owner: ThreadRef, in computers: [ComputerThreads]) -> [BelowAcross] {
        var holders: [String: [String]] = [:]
        for computer in computers { for thread in computer.threads { holders[thread.id, default: []].append(computer.hostID) } }
        var children: [String: [(thread: ThreadSummary, hostID: String)]] = [:]
        for computer in computers {
            for thread in computer.threads {
                guard let link = thread.delegatedBy, let parent = delegatingRef(link, on: computer.hostID, holders: holders),
                      parent != ThreadRef(hostID: computer.hostID, threadID: thread.id) else { continue }
                children[parent.id, default: []].append((thread: thread, hostID: computer.hostID))
            }
        }
        let first = (children[owner.id] ?? []).filter { ThreadRef(hostID: $0.hostID, threadID: $0.thread.id) != owner }
        let firstIDs = Set(first.map { ThreadRef(hostID: $0.hostID, threadID: $0.thread.id).id })
        var result: [BelowAcross] = []
        for item in first {
            result.append(BelowAcross(thread: item.thread, hostID: item.hostID, level: 1, by: nil))
            for child in children[ThreadRef(hostID: item.hostID, threadID: item.thread.id).id] ?? [] {
                let ref = ThreadRef(hostID: child.hostID, threadID: child.thread.id)
                if ref == owner || firstIDs.contains(ref.id) { continue }
                result.append(BelowAcross(thread: child.thread, hostID: child.hostID, level: 2, by: item.thread))
            }
        }
        return result
    }
    /// The thread a `delegatedBy` link names, by the computer that holds it; `holders` lists each thread ID's computers.
    static func delegatingRef(_ link: String, on hostID: String, holders: [String: [String]]) -> ThreadRef? {
        if let keyed = hostKeyed(link) { return keyed }
        guard link.hasPrefix("relay:") else { return ThreadRef(hostID: hostID, threadID: link) }
        let rest = link.dropFirst("relay:".count)
        guard let colon = rest.firstIndex(of: ":") else { return nil }
        let caller = String(rest[rest.index(after: colon)...])
        if let keyed = hostKeyed(caller) { return keyed }
        guard let holder = holders[caller]?.first(where: { $0 != hostID }) else { return nil }
        return ThreadRef(hostID: holder, threadID: caller)
    }
    /// `host:<hostId>:<id>`, a client's key for another computer's thread, as that computer's ID and the thread's own.
    private static func hostKeyed(_ key: String) -> ThreadRef? {
        guard key.hasPrefix("host:") else { return nil }
        let rest = key.dropFirst("host:".count)
        guard let colon = rest.firstIndex(of: ":") else { return nil }
        let host = String(rest[..<colon]), id = String(rest[rest.index(after: colon)...])
        guard UUID(uuidString: host) != nil, !id.isEmpty else { return nil }
        return ThreadRef(hostID: host, threadID: id)
    }

    /// What the thread list says of a thread's agents, as one value: when it changes, the sheet reads them again. Each
    /// delegated thread's status, requests, background work, monitors and own agents are in it, so one whose outcome moves
    /// from Background work to Answered while it stays idle and asks nothing is read again, as when its last monitor
    /// ends (`watcherTurnOutcome` in src/main/agents/watcherOutcomes.ts). The thread's own agent counts are in it too.
    public static func refreshSignal(_ owner: ThreadSummary, in threads: [ThreadSummary]) -> String {
        refreshSignal(owner, below: delegated(below: owner.id, in: threads).map(\.thread))
    }
    /// The same value, with the delegated threads on every one of the phone's computers (#2750).
    public static func refreshSignal(_ owner: ThreadSummary, on hostID: String, in computers: [ComputerThreads]) -> String {
        refreshSignal(owner, below: delegatedAcross(below: ThreadRef(hostID: hostID, threadID: owner.id), in: computers).map(\.thread))
    }
    private static func refreshSignal(_ owner: ThreadSummary, below threads: [ThreadSummary]) -> String {
        func agents(_ summary: SubagentSummary?) -> String { summary.map { "\($0.total)/\($0.working)/\($0.unknown)" } ?? "" }
        let below = threads.map { thread in
            let background = (thread.backgroundWork ?? []).map(\.type).joined(separator: ",")
            return [thread.id, thread.status, String(thread.requests.count), background, String(thread.monitoring?.count ?? 0),
                    agents(thread.subagentSummary)].joined(separator: ":")
        }
        return (below + [agents(owner.subagentSummary)]).joined(separator: "|")
    }

    /// How often an open sheet reads its agents again while one of them runs: five seconds. The computer tells the phone
    /// nothing of an agent's new update or next task until its counts change, so this is how an opened agent shows them.
    public static let followInterval: UInt64 = 5_000_000_000
    /// Whether an open sheet keeps reading its agents again: while any agent it shows is running. One the computer can
    /// no longer confirm is not followed, since it may never change again.
    public static func followsAgents(_ rows: [SubagentRow]) -> Bool {
        rows.contains { $0.status == "running" }
    }

    /// The top bar's count, from the thread list alone: delegated threads, both levels, and the provider's sub-agents.
    /// Nil when the thread has neither, so the control is not there.
    public static func count(_ owner: ThreadSummary, in threads: [ThreadSummary], failuresSeen: Bool = true) -> AgentsCount? {
        count(owner, below: delegated(below: owner.id, in: threads).map(\.thread), failuresSeen: failuresSeen)
    }
    /// The same count, with the delegated threads on every one of the phone's computers (#2750).
    public static func count(_ owner: ThreadSummary, on hostID: String, in computers: [ComputerThreads], failuresSeen: Bool = true) -> AgentsCount? {
        count(owner, below: delegatedAcross(below: ThreadRef(hostID: hostID, threadID: owner.id), in: computers).map(\.thread), failuresSeen: failuresSeen)
    }
    private static func count(_ owner: ThreadSummary, below: [ThreadSummary], failuresSeen: Bool) -> AgentsCount? {
        let total = below.count + (owner.subagentSummary?.total ?? 0)
        guard total > 0 else { return nil }
        return AgentsCount(total: total, needs: below.filter { needsYou($0, failuresSeen: failuresSeen) }.count)
    }

    /// The sheet's rows: the delegated threads and the sub-agents in one list, newest start first. Each delegated thread
    /// is followed by its own, newest first, and each sub-agent by the agents reported under it. `delegations` is the
    /// computer's answer, nil until it comes; a row it says nothing of shows what the thread list says. `projects` are the
    /// computer's and `computer` its name, for where each delegated thread runs.
    public static func rows(owner: ThreadSummary, threads: [ThreadSummary], delegations: [DelegatedThreadRecord]?, agents: [SubagentRow],
                            models: [ThreadModel] = [], failuresSeen: Bool = true, projects: [Project] = [], computer: String? = nil) -> [AgentsRow] {
        let below = delegated(below: owner.id, in: threads).map { BelowAcross(thread: $0.thread, hostID: "", level: $0.level, by: $0.by) }
        return rows(owner: owner, on: "", below: below, delegations: delegations, agents: agents, models: models, failuresSeen: failuresSeen,
                    place: { _ in Place(projects: projects, computer: computer, models: models) })
    }
    /// The same rows, with the delegated threads on whichever of the phone's computers runs them (#2750). Delegation's record
    /// on the sheet's own computer knows only its own threads, so a row on another computer shows what the thread list says
    /// of it, Working while its turn runs, and no outcome otherwise, never a guess; it names its own computer and opens there.
    public static func rows(owner: ThreadSummary, on hostID: String, below: [BelowAcross], delegations: [DelegatedThreadRecord]?, agents: [SubagentRow],
                            models: [ThreadModel] = [], failuresSeen: Bool = true, place: (String) -> Place) -> [AgentsRow] {
        let quiet = ThreadGroups.isSettled(owner)
        let records = Dictionary((delegations ?? []).map { ($0.thread, $0) }, uniquingKeysWith: { first, _ in first })
        var places: [String: (place: Place, titles: [String: String])] = [:]
        func placed(_ host: String) -> (place: Place, titles: [String: String]) {
            if let known = places[host] { return known }
            let found = place(host)
            let made = (place: found, titles: Dictionary(found.projects.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first }))
            places[host] = made
            return made
        }
        // Each block is a delegated thread with its own, or a sub-agent with the agents under it, and keeps its order.
        var blocks: [Block] = []
        var family: [AgentsRow] = []
        func closeFamily() {
            guard let head = family.first else { return }
            let below = family.dropFirst().sorted { newer($0.startedAt, $1.startedAt) }
            blocks.append(Block(start: head.startedAt, index: blocks.count, rows: [head] + below))
            family = []
        }
        for item in below {
            if item.level == 1 { closeFamily() }
            let here = item.hostID == hostID, at = placed(item.hostID)
            var row = threadRow(item.thread, level: item.level, by: item.by, record: here ? records[item.thread.id] : nil, read: here && delegations != nil, quiet: quiet,
                                models: at.place.models, failuresSeen: failuresSeen, project: at.titles[item.thread.projectId], computer: at.place.computer)
            if !here { row.hostID = item.hostID }
            family.append(row)
        }
        closeFamily()
        var agentBlock: [AgentsRow] = []
        var agentStart: Date? = nil
        for entry in nested(agents) {
            if entry.depth == 0 {
                if !agentBlock.isEmpty { blocks.append(Block(start: agentStart, index: blocks.count, rows: agentBlock)) }
                agentBlock = []
                // An agent whose start was not reported goes by when it was last seen.
                agentStart = started(entry.row)
            }
            agentBlock.append(agentRow(entry.row, depth: entry.depth, quiet: quiet, models: models))
        }
        if !agentBlock.isEmpty { blocks.append(Block(start: agentStart, index: blocks.count, rows: agentBlock)) }
        let ordered = blocks.sorted { first, second in
            let one = first.start ?? .distantPast, other = second.start ?? .distantPast
            return one != other ? one > other : first.index < second.index
        }
        return ordered.flatMap { $0.rows }
    }
    private struct Block { let start: Date?; let index: Int; let rows: [AgentsRow] }

    /// The line above the list: "2 delegated threads · 3 agents", and beside it what needs the user and what is working.
    /// A workflow's run is not an agent, so no count includes it; the agents under it are counted (`subagentSummarySchema`).
    public static func countLine(_ rows: [AgentsRow], summary: SubagentSummary?) -> (title: String, detail: String) {
        let threads = rows.filter { $0.kind == .thread }
        let agentRows = rows.filter { $0.kind == .agent && !$0.workflow }
        let agents = max(summary?.total ?? 0, agentRows.count)
        let title = [threads.isEmpty ? nil : delegatedThreads(threads.count), agents == 0 ? nil : agentCount(agents)]
            .compactMap { $0 }.joined(separator: " · ")
        let needs = threads.filter { $0.tone == .needs }.count
        let working = threads.filter { $0.tone == .working }.count + max(summary?.working ?? 0, agentRows.filter { $0.tone == .working }.count)
        let needing = needs == 1 ? String(localized: "1 needs you", bundle: .module, comment: "How many delegated threads need the user")
            : String(localized: "\(needs) needs you", bundle: .module, comment: "How many delegated threads need the user")
        let busy = working == 1 ? String(localized: "1 working", bundle: .module, comment: "How many delegated threads and agents are working")
            : String(localized: "\(working) working", bundle: .module, comment: "How many delegated threads and agents are working")
        let detail = [needs > 0 ? needing : nil, working > 0 ? busy : nil].compactMap { $0 }.joined(separator: " · ")
        let idle = (summary?.unknown ?? 0) > 0
            ? String(localized: "Activity not confirmed", bundle: .module, comment: "The computer can't confirm what its agents are doing")
            : String(localized: "None working", bundle: .module, comment: "No delegated thread or agent is working")
        return (title.isEmpty ? String(localized: "Agents", bundle: .module) : title, detail.isEmpty ? idle : detail)
    }

    /// Reported agents newest start first, each followed by the agents reported under it, newest first too, so a
    /// workflow's latest agent is the first under it. The computer sends them oldest first; agents whose starts are the
    /// same or unknown keep its order. A row whose parent is missing, or a loop of parents, still shows once, at the top
    /// (`nestedSubagents` in AgentsSurface.tsx).
    public static func nested(_ rows: [SubagentRow]) -> [(row: SubagentRow, depth: Int)] {
        let ids = Set(rows.map(\.id))
        let newestFirst = rows.enumerated().sorted { one, other in
            let first = started(one.element) ?? .distantPast, second = started(other.element) ?? .distantPast
            return first != second ? first > second : one.offset < other.offset
        }.map { $0.element }
        var children: [String: [SubagentRow]] = [:]
        var roots: [SubagentRow] = []
        for row in newestFirst {
            if let parent = row.parentId, parent != row.id, ids.contains(parent) { children[parent, default: []].append(row) } else { roots.append(row) }
        }
        var result: [(row: SubagentRow, depth: Int)] = []
        var visited: Set<String> = []
        func visit(_ row: SubagentRow, _ depth: Int) {
            guard visited.insert(row.id).inserted else { return }
            result.append((row: row, depth: depth))
            for child in children[row.id] ?? [] { visit(child, depth + 1) }
        }
        for row in roots { visit(row, 0) }
        for row in newestFirst { visit(row, 0) }
        return result
    }
    /// When an agent started, or when it was last seen where its start was not reported.
    static func started(_ row: SubagentRow) -> Date? {
        row.startedAt.flatMap { Stamp.date($0) } ?? row.lastObservedAt.flatMap { Stamp.date($0) }
    }

    static func threadRow(_ thread: ThreadSummary, level: Int, by: ThreadSummary?, record: DelegatedThreadRecord?, read: Bool, quiet: Bool,
                          models: [ThreadModel], failuresSeen: Bool = true, project: String? = nil, computer: String? = nil) -> AgentsRow {
        let waiting = waitingFor(thread)
        // An unseen failure needs the user too, but asks nothing: it says Needs attention and has no Open to answer.
        let attention = waiting == nil && failureUnseen(thread, failuresSeen: failuresSeen)
        // Settled is quiet, whether the sheet's own thread or this one was settled: only a request or a failure lights it.
        let settled = quiet || ThreadGroups.isSettled(thread)
        let state = ThreadState(thread)
        // Without a record the list stands in: Working while its turn runs. Once the computer has answered without one,
        // its outcome is Unknown, never guessed; before then, nothing is said.
        let outcome: String?
        if let record { outcome = record.outcome }
        else if state.workInProgress { outcome = "working" }
        else { outcome = read ? "unknown" : nil }
        let working = outcome == "working" || outcome == "background"
        let status: String?
        if let waiting {
            status = waiting == "question" ? String(localized: "Needs your answer", bundle: .module)
                : String(localized: "Needs your approval", bundle: .module)
        }
        else if attention { status = String(localized: "Needs attention", bundle: .module) }
        else if thread.finishedUnread == true && !working && !settled { status = String(localized: "Just finished", bundle: .module) }
        else if let outcome { status = outcomeWord(outcome) }
        else { status = nil }
        let tone: AgentsRow.Tone
        if waiting != nil || attention { tone = .needs }
        else if settled { tone = .quiet }
        else if working { tone = .working }
        else if outcome == "failed" { tone = .failed }
        else { tone = .done }
        let start = record?.startedAt.flatMap { Stamp.date($0) }
        let end = record?.outcomeAt.flatMap { Stamp.date($0) }
        let elapsed: AgentsElapsed
        if let start, working || waiting != nil, end == nil { elapsed = .since(start) }
        else if let start, let end { elapsed = .took(max(0, end.timeIntervalSince(start))) }
        else { elapsed = .unknown }
        let model = models.first { $0.id == thread.modelId }?.name
        // Provider · project · computer, as every thread's line reads (#1861), then what this one was delegated for.
        let facts = [AgentNames.known(thread.providerId), project, computer, workTitle(record?.work), model].compactMap { $0 }.filter { !$0.isEmpty }
        return AgentsRow(id: "thread:" + thread.id, kind: .thread, level: level, title: thread.title, threadID: thread.id, agentID: nil,
                         providerID: thread.providerId, delegatedBy: by?.title, preview: record?.brief, facts: facts, startedAt: start,
                         elapsed: elapsed, status: status, tone: tone, waitingFor: waiting)
    }

    static func agentRow(_ row: SubagentRow, depth: Int, quiet: Bool, models: [ThreadModel] = []) -> AgentsRow {
        let running = row.status == "running"
        let start = row.startedAt.flatMap { Stamp.date($0) }
        let end = (row.completedAt ?? row.lastObservedAt).flatMap { Stamp.date($0) }
        let elapsed: AgentsElapsed
        if running, let start { elapsed = .since(start) }
        else if !running, let duration = row.durationMs { elapsed = .took(duration / 1000) }
        else if !running, let start, let end { elapsed = .took(max(0, end.timeIntervalSince(start))) }
        else { elapsed = .unknown }
        let tone: AgentsRow.Tone
        if quiet { tone = .quiet }
        else if running { tone = .working }
        else if row.status == "failed" { tone = .failed }
        else { tone = .done }
        let title = row.title.isEmpty
            ? (row.kind == "workflow" ? String(localized: "Workflow", bundle: .module, comment: "Stands in for a workflow's title when it has none")
                : String(localized: "Agent task", bundle: .module, comment: "Stands in for a sub-agent's title when it has none"))
            : row.title
        let preview: String? = row.description.isEmpty || row.description == row.title ? nil : row.description
        // The model by the name the computer gives it ("GPT-6.1 Sol"), or as reported when the computer lists no such model.
        let model = row.model.map { id in models.first { $0.id == id }?.name ?? id } ?? ""
        var result = AgentsRow(id: "agent:" + row.id, kind: .agent, level: depth + 1, title: title, threadID: nil, agentID: row.id, providerID: nil,
                               delegatedBy: nil, preview: preview, facts: [model.isEmpty ? String(localized: "Model not reported", bundle: .module) : model],
                               startedAt: start, elapsed: elapsed, status: agentWord(row.status), tone: tone, waitingFor: nil)
        result.workflow = row.kind == "workflow"
        result.detailsKey = [row.assignmentId ?? "", row.revision.map { String($0) } ?? "", row.status].joined(separator: "#")
        return result
    }

    /// Newest start first; a row whose start isn't known goes last.
    static func newer(_ first: Date?, _ second: Date?) -> Bool {
        (first ?? .distantPast) > (second ?? .distantPast)
    }
    static func delegatedThreads(_ count: Int) -> String {
        count == 1 ? String(localized: "1 delegated thread", bundle: .module) : String(localized: "\(count) delegated threads", bundle: .module)
    }
    static func agentCount(_ count: Int) -> String {
        count == 1 ? String(localized: "1 agent", bundle: .module) : String(localized: "\(count) agents", bundle: .module)
    }
}

public extension AgentNames {
    /// A provider's name, or nil for one Sotto doesn't know.
    static func known(_ providerID: String?) -> String? {
        let name = Self.name(providerID)
        return name == Self.name(nil) ? nil : name
    }
}

/// One element of a list read on its own: nil when it cannot be read, so the rest of the list still is.
private struct Readable<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}

private extension KeyedDecodingContainer {
    /// The value at `key`, or nil when it is missing, null or of another type.
    func readable<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        guard let value = try? decodeIfPresent(type, forKey: key) else { return nil }
        return value
    }
}
