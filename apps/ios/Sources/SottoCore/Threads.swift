import Foundation

/// How the phone words and sorts a thread. Pure, so the list, the tabs and the tests read one answer.
public enum ThreadState: String, Sendable {
    case needsAnswer, asked, working, waiting, compacting, failed, done

    public init(_ thread: ThreadSummary) {
        if let request = thread.requests.first { self = request.kind == "permission" ? .needsAnswer : .asked }
        else if thread.status == "error" { self = .failed }
        else if thread.compaction?.status == "running" { self = .compacting }
        else if thread.status == "running" { self = .working }
        else if let work = thread.backgroundWork, !work.isEmpty {
            self = work.allSatisfy { $0.type == "command" } ? .waiting : .working
        } else { self = .done }
    }
    public var words: String {
        switch self {
        case .needsAnswer: return "Needs your answer"
        case .asked: return "Asked you a question"
        case .working: return "Working"
        case .waiting: return "Waiting"
        case .compacting: return "Compacting context"
        case .failed: return "Turn failed"
        case .done: return "Done"
        }
    }
    public var workInProgress: Bool { self == .working || self == .waiting || self == .compacting }
    public var waitsOnYou: Bool { self == .needsAnswer || self == .asked }
}

public enum ThreadFilter: String, CaseIterable, Identifiable, Sendable {
    case all = "All", working = "Working", done = "Done"
    public var id: String { rawValue }
    public func admits(_ thread: ThreadSummary) -> Bool {
        switch self {
        case .all: return true
        case .working: return ThreadState(thread) != .done
        case .done: return ThreadState(thread) == .done
        }
    }
}

/// A thread as the phone names it. Two computers can hold the same thread ID, so the computer's
/// host ID is part of every thread's identity: routes, drafts, markers and answers all carry both.
public struct ThreadRef: Hashable, Codable, Sendable {
    public let hostID: String; public let threadID: String
    public init(hostID: String, threadID: String) { self.hostID = hostID; self.threadID = threadID }
    public var id: String { hostID + "/" + threadID }
}

/// Whether this iPhone is talking to a paired computer right now.
public enum ComputerStatus: String, Sendable {
    case connecting, online, unreachable
    public var words: String {
        switch self {
        case .connecting: return "Connecting…"
        case .online: return "Online"
        case .unreachable: return "Can’t reach it"
        }
    }
}

/// One paired computer as the lists read it: its name, whether it can be reached, and the threads
/// it last shared. A computer shares only its own threads.
public struct ComputerThreads: Sendable {
    public let hostID: String; public let name: String; public let status: ComputerStatus
    public let threads: [ThreadSummary]; public let projects: [Project]
    public init(hostID: String, name: String, status: ComputerStatus, threads: [ThreadSummary], projects: [Project] = []) {
        self.hostID = hostID; self.name = name; self.status = status; self.threads = threads; self.projects = projects
    }
}

/// A thread with the computer it lives on, used by Focus rows and request counts.
public struct HostedThread: Identifiable, Sendable {
    public let ref: ThreadRef; public let computer: String; public let status: ComputerStatus
    public let project: String?; public let thread: ThreadSummary
    public let settled: Bool
    public var id: String { ref.id }
    public var reachable: Bool { status == .online }
    /// Finished while nothing showed it, and not opened since on either device, by its computer's word (ADR-0046).
    /// Only a computer this iPhone can reach says it now, and only of a thread with nothing left running or asked.
    public var finishedUnread: Bool { reachable && thread.finishedUnread == true && ThreadState(thread) == .done }
}

/// One request waiting on the user, with the thread and computer it belongs to.
public struct Waiting: Identifiable, Sendable {
    public let thread: HostedThread; public let request: AgentRequest
    public var id: String { thread.id + "/" + request.id }
}

/// The computer menu on Threads: every computer, or one.
public enum ComputerFilter: Hashable, Sendable {
    case all, only(String)
    public func admits(_ hostID: String) -> Bool {
        if case .only(let chosen) = self { return chosen == hostID }
        return true
    }
}

public enum ThreadGroups {
    /// Every open thread on the computers the strip admits, as one list: most recent first, and the
    /// threads of a computer that can't be reached after the rest, as it last shared them.
    public static func merged(_ computers: [ComputerThreads], show: ComputerFilter = .all, filter: ThreadFilter = .all) -> [HostedThread] {
        let rows = computers.filter { show.admits($0.hostID) }.flatMap(hosted).filter { filter.admits($0.thread) }
        // Parse each timestamp once, not twice on every comparison. Lists refresh while agents work.
        let dated = rows.enumerated().map { (row: $0.element, offset: $0.offset, date: latest($0.element.thread) ?? .distantPast) }
        return dated.sorted { a, b in
            if a.row.reachable != b.row.reachable { return a.row.reachable }
            if a.date != b.date { return a.date > b.date }
            return a.offset < b.offset
        }.map(\.row)
    }
    /// Each open request with its thread, on computers that can be reached: a request on a computer
    /// that can't be reached can't be answered, so it waits there until the computer is back.
    public static func waiting(_ computers: [ComputerThreads], show: ComputerFilter = .all) -> [Waiting] {
        merged(computers, show: show).filter(\.reachable).flatMap { row in row.thread.requests.map { Waiting(thread: row, request: $0) } }
    }
    /// Foreground, confirmed background and compaction work with nothing asked, on reachable computers.
    public static func working(_ computers: [ComputerThreads], show: ComputerFilter = .all) -> [HostedThread] {
        merged(computers, show: show).filter { $0.reachable && ThreadState($0.thread).workInProgress }
    }
    /// The computers the strip admits that this iPhone can't reach.
    public static func unreachable(_ computers: [ComputerThreads], show: ComputerFilter = .all) -> [ComputerThreads] {
        computers.filter { show.admits($0.hostID) && $0.status == .unreachable }
    }
    static func hosted(_ computer: ComputerThreads) -> [HostedThread] {
        let projects = Dictionary(computer.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return computer.threads.map { thread in
            HostedThread(ref: ThreadRef(hostID: computer.hostID, threadID: thread.id), computer: computer.name,
                         status: computer.status, project: projects[thread.projectId]?.title, thread: thread,
                         settled: isSettled(thread, project: projects[thread.projectId]))
        }
    }
    /// Match shared/threadActivity.ts: workspace settlement is inherited, while an explicit active
    /// provider override clears provider settlement but never an archive or workspace grouping.
    public static func isSettled(_ thread: ThreadSummary, project: Project? = nil) -> Bool {
        func present(_ value: String?) -> Bool { value?.isEmpty == false }
        return present(thread.workspaceSettledAt) || present(project?.workspaceSettledAt) || present(thread.archivedAt)
            || (thread.settledOverride != "active" && (thread.settledOverride == "settled" || present(thread.settledAt)))
    }
    /// When the thread last moved: its last message or the start of its running turn, whichever is later.
    static func latest(_ thread: ThreadSummary) -> Date? {
        [thread.summary?.lastMessageAt, thread.summary?.runningTurnStartedAt].compactMap { $0.flatMap(Stamp.date) }.max()
    }
}

/// ISO 8601 times as the host writes them, with or without fractional seconds.
public enum Stamp {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let plain = ISO8601DateFormatter()
    public static func date(_ iso: String) -> Date? { fractional.date(from: iso) ?? plain.date(from: iso) }
}

public extension AgentRequest {
    /// A question answered by one tap on its card: one single-choice question, or plain options.
    /// Anything else (several questions, several choices, words) opens the full answer sheet.
    var oneTapOptions: [RequestOption]? {
        guard kind == "question", supported else { return nil }
        if let questions, !questions.isEmpty {
            guard questions.count == 1, let q = questions.first, !q.multiSelect, !q.options.isEmpty, q.unavailableReason == nil else { return nil }
            return q.options
        }
        return options.isEmpty ? nil : options
    }
    /// The permission choices a card offers in place: allow once and deny. Others live in the sheet.
    var cardPermissionChoices: [PermissionChoice]? {
        guard kind == "permission", supported, let choices = permissionChoices else { return nil }
        let picked = choices.filter { $0.kind == "allow-once" || $0.kind == "deny" }
        return picked.isEmpty ? nil : picked
    }
}
