import Foundation

// The Agents view (ADR-0101, an Owl feature): a thread's top bar counts its delegated threads (ADR-0081) and its
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
    /// Provider · kind of work · model, before the start time.
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

    /// Provider · kind of work · model · start time, each only where it is known.
    public func meta(clock: (Date) -> String) -> String {
        (facts + (startedAt.map { [clock($0)] } ?? [])).joined(separator: " · ")
    }
    /// What the row says to VoiceOver: what it is, what it is doing, and what a press does.
    public var spokenLabel: String {
        switch kind {
        case .thread:
            let provider = providerID.map { ", delegated thread on \(AgentNames.name($0))" } ?? ", delegated thread"
            return title + provider + (status.map { ", \($0)" } ?? "") + (waitingFor != nil ? ". Opens it to answer" : ". Opens it")
        case .agent:
            return title + (workflow ? ", workflow" : ", agent") + (status.map { ", \($0)" } ?? "")
        }
    }
}

public enum AgentsRoster {
    /// The host feature that offers the view.
    public static let feature = "agents-view"

    /// The kind of work a delegation is for, as the desktop names it (`DELEGATION_WORK_TITLES`).
    public static func workTitle(_ work: String?) -> String? {
        ["building": "Building", "ui": "UI work", "code-review": "Code review", "research": "Research", "computer-use": "Computer use"][work ?? ""]
    }
    /// A delegation's outcome in the glossary's words (`DELEGATION_OUTCOME_WORDS`).
    public static func outcomeWord(_ outcome: String) -> String {
        ["working": "Working", "background": "Background work", "answered": "Answered", "failed": "Failed", "stopped": "Stopped",
         "paused": "Paused", "unknown": "Unknown", "refused": "Refused"][outcome] ?? "Unknown"
    }
    /// A sub-agent's status as Tools › Agents words it.
    public static func agentWord(_ status: String) -> String {
        ["running": "Working", "completed": "Finished", "failed": "Failed", "interrupted": "Interrupted"][status] ?? "Last seen working"
    }
    /// The heading over an opened agent's latest words, by its run's status, as Tools › Agents heads them.
    public static func resultHeading(_ status: String) -> String {
        switch status {
        case "running": return "Latest update"
        case "unknown": return "Last update"
        case "failed": return "What happened"
        default: return "Result"
        }
    }
    /// An opened agent's latest words, or what to say when it reported none.
    public static func resultWords(_ assignment: SubagentAssignment) -> String {
        if let result = assignment.result, !result.isEmpty { return result }
        return assignment.status == "running" ? "No result reported yet." : "No result was reported."
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

    /// What the thread list says of a thread's agents, as one value: when it changes, the sheet reads them again. Each
    /// delegated thread's status, requests, background work, monitors and own agents are in it, so one whose outcome moves
    /// from Background work to Answered while it stays idle and asks nothing is read again, as when its last monitor
    /// ends (`watcherTurnOutcome` in src/main/agents/watcherOutcomes.ts). The thread's own agent counts are in it too.
    public static func refreshSignal(_ owner: ThreadSummary, in threads: [ThreadSummary]) -> String {
        func agents(_ summary: SubagentSummary?) -> String { summary.map { "\($0.total)/\($0.working)/\($0.unknown)" } ?? "" }
        let below = delegated(below: owner.id, in: threads).map { item in
            let thread = item.thread
            let background = (thread.backgroundWork ?? []).map(\.type).joined(separator: ",")
            return [thread.id, thread.status, String(thread.requests.count), background, String(thread.monitoring?.count ?? 0),
                    agents(thread.subagentSummary)].joined(separator: ":")
        }
        return (below + [agents(owner.subagentSummary)]).joined(separator: "|")
    }

    /// The top bar's count, from the thread list alone: delegated threads, both levels, and the provider's sub-agents.
    /// Nil when the thread has neither, so the control is not there.
    public static func count(_ owner: ThreadSummary, in threads: [ThreadSummary], failuresSeen: Bool = true) -> AgentsCount? {
        let below = delegated(below: owner.id, in: threads)
        let total = below.count + (owner.subagentSummary?.total ?? 0)
        guard total > 0 else { return nil }
        return AgentsCount(total: total, needs: below.filter { needsYou($0.thread, failuresSeen: failuresSeen) }.count)
    }

    /// The sheet's rows: the delegated threads and the sub-agents in one list, newest start first. Each delegated thread
    /// is followed by its own, newest first, and each sub-agent by the agents reported under it. `delegations` is the
    /// computer's answer, nil until it comes; a row it says nothing of shows what the thread list says.
    public static func rows(owner: ThreadSummary, threads: [ThreadSummary], delegations: [DelegatedThreadRecord]?, agents: [SubagentRow],
                            models: [ThreadModel] = [], failuresSeen: Bool = true) -> [AgentsRow] {
        let quiet = ThreadGroups.isSettled(owner)
        let records = Dictionary((delegations ?? []).map { ($0.thread, $0) }, uniquingKeysWith: { first, _ in first })
        // Each block is a delegated thread with its own, or a sub-agent with the agents under it, and keeps its order.
        var blocks: [Block] = []
        var family: [AgentsRow] = []
        func closeFamily() {
            guard let head = family.first else { return }
            let below = family.dropFirst().sorted { newer($0.startedAt, $1.startedAt) }
            blocks.append(Block(start: head.startedAt, index: blocks.count, rows: [head] + below))
            family = []
        }
        for item in delegated(below: owner.id, in: threads) {
            if item.level == 1 { closeFamily() }
            family.append(threadRow(item.thread, level: item.level, by: item.by, record: records[item.thread.id], read: delegations != nil, quiet: quiet,
                                    models: models, failuresSeen: failuresSeen))
        }
        closeFamily()
        var agentBlock: [AgentsRow] = []
        var agentStart: Date? = nil
        for entry in nested(agents) {
            if entry.depth == 0 {
                if !agentBlock.isEmpty { blocks.append(Block(start: agentStart, index: blocks.count, rows: agentBlock)) }
                agentBlock = []
                // An agent whose start was not reported goes by when it was last seen.
                agentStart = entry.row.startedAt.flatMap { Stamp.date($0) } ?? entry.row.lastObservedAt.flatMap { Stamp.date($0) }
            }
            agentBlock.append(agentRow(entry.row, depth: entry.depth, quiet: quiet))
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
        let title = [threads.isEmpty ? nil : plural(threads.count, "delegated thread"), agents == 0 ? nil : plural(agents, "agent")]
            .compactMap { $0 }.joined(separator: " · ")
        let needs = threads.filter { $0.tone == .needs }.count
        let working = threads.filter { $0.tone == .working }.count + max(summary?.working ?? 0, agentRows.filter { $0.tone == .working }.count)
        let detail = [needs > 0 ? "\(needs) needs you" : nil, working > 0 ? "\(working) working" : nil].compactMap { $0 }.joined(separator: " · ")
        return (title.isEmpty ? "Agents" : title, detail.isEmpty ? ((summary?.unknown ?? 0) > 0 ? "Activity not confirmed" : "None working") : detail)
    }

    /// Reported agents in the order they started, each followed by the agents reported under it. A row whose parent is
    /// missing, or a loop of parents, still shows once, at the top (`nestedSubagents` in AgentsSurface.tsx).
    public static func nested(_ rows: [SubagentRow]) -> [(row: SubagentRow, depth: Int)] {
        let ids = Set(rows.map(\.id))
        var children: [String: [SubagentRow]] = [:]
        var roots: [SubagentRow] = []
        for row in rows {
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
        for row in rows { visit(row, 0) }
        return result
    }

    static func threadRow(_ thread: ThreadSummary, level: Int, by: ThreadSummary?, record: DelegatedThreadRecord?, read: Bool, quiet: Bool,
                          models: [ThreadModel], failuresSeen: Bool = true) -> AgentsRow {
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
        if let waiting { status = waiting == "question" ? "Needs your answer" : "Needs your approval" }
        else if attention { status = "Needs attention" }
        else if thread.finishedUnread == true && !working && !settled { status = "Just finished" }
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
        let facts = [AgentNames.known(thread.providerId), workTitle(record?.work), model].compactMap { $0 }.filter { !$0.isEmpty }
        return AgentsRow(id: "thread:" + thread.id, kind: .thread, level: level, title: thread.title, threadID: thread.id, agentID: nil,
                         providerID: thread.providerId, delegatedBy: by?.title, preview: record?.brief, facts: facts, startedAt: start,
                         elapsed: elapsed, status: status, tone: tone, waitingFor: waiting)
    }

    static func agentRow(_ row: SubagentRow, depth: Int, quiet: Bool) -> AgentsRow {
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
        let title = row.title.isEmpty ? (row.kind == "workflow" ? "Workflow" : "Agent task") : row.title
        let preview: String? = row.description.isEmpty || row.description == row.title ? nil : row.description
        let model = row.model ?? ""
        var result = AgentsRow(id: "agent:" + row.id, kind: .agent, level: depth + 1, title: title, threadID: nil, agentID: row.id, providerID: nil,
                               delegatedBy: nil, preview: preview, facts: [model.isEmpty ? "Model not reported" : model],
                               startedAt: start, elapsed: elapsed, status: agentWord(row.status), tone: tone, waitingFor: nil)
        result.workflow = row.kind == "workflow"
        result.detailsKey = [row.assignmentId ?? "", row.revision.map { String($0) } ?? "", row.status].joined(separator: "#")
        return result
    }

    /// Newest start first; a row whose start isn't known goes last.
    static func newer(_ first: Date?, _ second: Date?) -> Bool {
        (first ?? .distantPast) > (second ?? .distantPast)
    }
    static func plural(_ count: Int, _ noun: String) -> String { "\(count) \(noun)\(count == 1 ? "" : "s")" }
}

public extension AgentNames {
    /// A provider's name, or nil for one Sotto doesn't know.
    static func known(_ providerID: String?) -> String? {
        let name = Self.name(providerID)
        return name == "The agent" ? nil : name
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
