import Foundation

/// The Settled shelf's older threads (`settled-threads-on-request`, ADR-0028's November 1 amendment, part 2). A computer
/// that offers the feature sends this phone its open threads and those settled this week, which the shelf shows at once
/// under This week, and says in `Shell.settledHeldBack` how many it left out. The shelf reads those a page at a time with
/// `settled-threads` when the user asks for them, and Threads' search reads the ones that match as the user types.

/// One page of the settled threads a computer left out of its list, newest settled first, and the cursor for the next.
public struct SettledThreadsPage: Decodable, Equatable, Sendable {
    public let threads: [ThreadSummary]; public let next: String?
}

public extension Wire {
    static let settledThreadsFeature = "settled-threads-on-request"
    /// The next page of older settled threads after `after`, or the first; with `query`, only those that match it.
    static func settledThreads(after: String? = nil, query: String? = nil) -> [String: JSONValue] {
        var operation: [String: JSONValue] = ["op": .string("settled-threads")]
        if let after { operation["after"] = .string(after) }
        if let query, !query.isEmpty { operation["query"] = .string(String(query.prefix(200))) }
        return operation
    }
}

/// The older settled threads read from one computer so far, in the order it sent them, and where the next page starts.
public struct OlderSettled: Equatable, Sendable {
    public private(set) var threads: [ThreadSummary] = []
    public private(set) var next: String?
    public private(set) var read = false
    public init() {}
    /// A store read from the start again, which keeps `thread`, the older thread open on this iPhone, so a new connection
    /// never closes it before the computer's list carries it.
    public init(keeping thread: ThreadSummary?) { threads = thread.map { [$0] } ?? [] }
    /// Whether the computer has more to send: nothing read yet, or a page that named the next.
    public var more: Bool { !read || next != nil }
    /// Adds a page, leaving out any thread already held, which a thread settled again since can repeat.
    public mutating func add(_ page: SettledThreadsPage) {
        let held = Set(threads.map(\.id))
        threads += page.threads.filter { !held.contains($0.id) }
        next = page.next; read = true
    }
}

/// What Threads' search last asked the computers for among their older settled threads, what each found by computer,
/// whether it is still being read, whether a computer's read failed, so no match is never mistaken for no answer, and
/// where each computer's next matches start.
public struct SettledSearch: Equatable, Sendable {
    public let query: String; public let found: [String: [ThreadSummary]]; public let reading: Bool; public let failed: Bool
    public let next: [String: String]
    public init(query: String = "", found: [String: [ThreadSummary]] = [:], reading: Bool = false, failed: Bool = false, next: [String: String] = [:]) {
        self.query = query; self.found = found; self.reading = reading; self.failed = failed; self.next = next
    }
}

public extension ThreadGroups {
    /// Settled threads read from the computers, as the shelf's rows: newest settled first, on the computers the strip
    /// admits. A thread the computer's own list now carries, because it was restored or settled again this week, is left
    /// out: its row is the list's.
    static func older(_ computers: [ComputerThreads], read: [String: [ThreadSummary]], show: ComputerFilter = .all) -> [HostedThread] {
        let rows = computers.filter { show.admits($0.hostID) }.flatMap { computer -> [HostedThread] in
            guard let threads = read[computer.hostID], !threads.isEmpty else { return [] }
            let listed = Set(computer.threads.map(\.id))
            let projects = Dictionary(computer.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            return threads.filter { !listed.contains($0.id) }.map { thread in
                HostedThread(ref: ThreadRef(hostID: computer.hostID, threadID: thread.id), computer: computer.name, status: computer.status,
                             project: projects[thread.projectId]?.title, thread: thread, settled: true)
            }
        }
        return newestSettledFirst(rows)
    }
    /// How long a settled thread stays in a phone's list, as its computer keeps it (`SETTLED_KEPT_MS` on the host).
    static let settledKept: TimeInterval = 7 * 24 * 60 * 60
    /// The settled rows a computer's list carries, split into This week and Older by when each was settled: a thread the
    /// list carries because it is open here, or asks something, can be older. One that names no time counts as this
    /// week, since its computer listed it.
    static func thisWeek(_ rows: [HostedThread], now: Date = Date()) -> (thisWeek: [HostedThread], older: [HostedThread]) {
        var split: (thisWeek: [HostedThread], older: [HostedThread]) = ([], [])
        for row in rows {
            if let date = settledDate(row.thread), date < now.addingTimeInterval(-settledKept) { split.older.append(row) }
            else { split.thisWeek.append(row) }
        }
        return split
    }
    /// `rows`, newest settled first, keeping their order where they were settled at the same time.
    static func newestSettledFirst(_ rows: [HostedThread]) -> [HostedThread] {
        let dated = rows.enumerated().map { (row: $0.element, offset: $0.offset, date: settledDate($0.element.thread) ?? .distantPast) }
        return dated.sorted { $0.date != $1.date ? $0.date > $1.date : $0.offset < $1.offset }.map(\.row)
    }
    /// When a thread was settled: the latest time any of its settlements names.
    static func settledDate(_ thread: ThreadSummary) -> Date? {
        [thread.workspaceSettledAt, thread.archivedAt, thread.settledAt].compactMap { $0.flatMap(Stamp.date) }.max()
    }
}
