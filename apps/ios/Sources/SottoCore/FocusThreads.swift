import Foundation

/// One pass over the lightweight host list. Live requests outrank settlement, and settlement outranks work: a settled
/// thread that still runs sits quietly on the Settled shelf, while one that asks the user something stays in Needs you,
/// since only the user can answer it. Stale snapshots remain readable but never claim to be current work or answerable
/// requests. A delegated thread has no row of its own (ADR-0081): the thread its delegation is reached from says when it
/// waits on the user.
public struct FocusThreads {
    public private(set) var questions: [HostedThread] = []
    public private(set) var working: [HostedThread] = []
    public private(set) var recent: [HostedThread] = []
    public private(set) var settled: [HostedThread] = []
    /// Each Needs you row that stands for a delegated thread waiting on the user, by the row's ID: that delegated
    /// thread, whose requests the row shows. A row that waits on the user itself is not here.
    public private(set) var waitingIn: [String: HostedThread] = [:]
    public let searching: Bool
    /// The thread open on this iPhone. It reads as opened at once, before its computer's next list says so.
    public let opened: ThreadRef?
    public var isEmpty: Bool { questions.isEmpty && working.isEmpty && recent.isEmpty && settled.isEmpty }
    /// The requests Needs you shows: each row's own, or those of the delegated thread it stands for.
    public var requestCount: Int { questions.reduce(0) { $0 + asking($1).thread.requests.count } }
    /// Recent threads that finished while nothing showed them and have not been opened since: the Threads tab's count.
    /// A settled thread is never marked, so the Settled shelf has nothing to count.
    public var unreadFinishedCount: Int { recent.filter { isUnreadFinish($0) }.count }

    public init(_ computers: [ComputerThreads], show: ComputerFilter = .all, query: String = "", opened: ThreadRef? = nil) {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searching = !query.isEmpty
        self.opened = opened
        let rows = ThreadGroups.merged(computers, show: show)
        let tops = ThreadGroups.delegationTops(rows)
        // The delegated thread each listed thread stands for in Needs you: a permission ahead of a question, then the
        // most recent, as the desktop's sidebar orders them. Only a computer this iPhone can reach has requests to answer.
        var below: [String: HostedThread] = [:]
        if !tops.isEmpty {
            for row in rows {
                guard let top = tops[row.id], row.reachable, ThreadState(row.thread).waitsOnYou else { continue }
                if let held = below[top], Self.rank(held) >= Self.rank(row) { continue }
                below[top] = row
            }
        }
        for row in rows where tops[row.id] == nil {
            let delegated = below[row.id]
            let searchable = [row.thread.title, row.project ?? "", row.computer, row.thread.providerId ?? "",
                              row.thread.requests.map(\.text).joined(separator: " "),
                              delegated?.thread.requests.map(\.text).joined(separator: " ") ?? ""].joined(separator: " ")
            guard query.isEmpty || searchable.localizedStandardContains(query) else { continue }
            let state = ThreadState(row.thread)
            if row.reachable && state.waitsOnYou { questions.append(row) }
            else if let delegated, row.reachable { waitingIn[row.id] = delegated; questions.append(row) }
            else if row.settled { settled.append(row) }
            else if row.reachable && state.workInProgress { working.append(row) }
            else { recent.append(row) }
        }
    }

    /// The thread whose requests a Needs you row shows and answers: the delegated thread it stands for, or its own.
    public func asking(_ row: HostedThread) -> HostedThread { waitingIn[row.id] ?? row }

    /// The request a Needs you row's card shows and answers: the first one waiting in the thread that asks.
    public func asked(_ row: HostedThread) -> AskedRequest? {
        let thread = self.asking(row)
        return thread.thread.requests.first.map { AskedRequest(thread: thread.ref, requestID: $0.id) }
    }

    /// Whether a row shows the finished-unread mark: its computer says so and it is not the thread open here (ADR-0046).
    public func isUnreadFinish(_ row: HostedThread) -> Bool { row.finishedUnread && row.ref != opened }

    /// A permission holds an agent still until it is answered, so it outranks a question.
    private static func rank(_ row: HostedThread) -> Int { ThreadState(row.thread) == .needsAnswer ? 2 : 1 }
}

/// The request a Needs you card shows: the thread that asks and the request's ID there. A request ID is only unique in
/// its own thread, and a row that stands for delegated threads can show one thread's request and then another's, so a
/// card's choice and the answer it sent belong to this pair rather than to the card's row.
public struct AskedRequest: Hashable, Sendable {
    public let thread: ThreadRef
    public let requestID: String
    public init(thread: ThreadRef, requestID: String) { self.thread = thread; self.requestID = requestID }
}

/// A choice picked on a Needs you card and not sent yet, kept with the request it was picked for. Once the card shows
/// another request, the choice is gone, so Send answer can never send it to a thread that did not ask it.
public struct CardChoice: Equatable, Sendable {
    public let asked: AskedRequest
    public let option: String
    public init(asked: AskedRequest, option: String) { self.asked = asked; self.option = option }
    /// The picked option while the card still shows the request it was picked for, and nothing otherwise.
    public func chosen(for shown: AskedRequest) -> String? { asked == shown ? option : nil }
}
