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
    public private(set) var snoozed: [HostedThread] = []
    /// Each Needs you row that stands for a delegated thread waiting on the user, by the row's ID: that delegated
    /// thread, whose requests the row shows. A row that waits on the user itself is not here.
    public private(set) var waitingIn: [String: HostedThread] = [:]
    /// Each Working now row that works only because a delegated thread below it is working, by the row's ID: that
    /// delegated thread. A row that is working itself is not here.
    public private(set) var workingIn: [String: HostedThread] = [:]
    /// The top of each delegated thread's delegation, by row ID, which has the row the list shows in its place.
    private var tops: [String: String] = [:]
    public let searching: Bool
    /// The rows the search found only by what was said in their threads (`thread-words`), by row ID. Each lists after the
    /// rows of its group the search found by their own words, and shows a quote of its match (Zach's pick A, November 19,
    /// 2026).
    public private(set) var wordOnly: Set<String> = []
    /// The search, trimmed, and while there is one, the threads it found by what was said in them, by row ID.
    private let query: String
    private let words: [String: ThreadWordMatch]
    /// The rows the list holds that the search found by their own words and by what was said in them, which show no quote.
    private var foundOwn: Set<String> = []
    /// The thread open on this iPhone. It reads as opened at once, before its computer's next list says so.
    public let opened: ThreadRef?
    public var isEmpty: Bool { questions.isEmpty && working.isEmpty && recent.isEmpty && settled.isEmpty && snoozed.isEmpty }
    /// The requests Needs you shows: each row's own, or those of the delegated thread it stands for.
    public var requestCount: Int { questions.reduce(0) { $0 + asking($1).thread.requests.count } }
    /// Recent threads that finished while nothing showed them and have not been opened since: the Threads tab's count.
    /// A settled thread is never marked, so the Settled shelf has nothing to count.
    public var unreadFinishedCount: Int { recent.filter { isUnreadFinish($0) }.count }

    /// `holding` names the unsent threads this iPhone holds something for, by row ID. Any other unsent thread has no row
    /// unless it is open here: opening New thread and backing out leaves nothing behind, as on the desktop. `words` names
    /// the threads the computers found by what was said in them, by row ID (`ThreadWordsSearch.matches`), which the search
    /// finds too.
    public init(_ computers: [ComputerThreads], show: ComputerFilter = .all, query: String = "", opened: ThreadRef? = nil,
                holding: Set<String> = [], words: [String: ThreadWordMatch] = [:], now: Date = Date()) {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        searching = !query.isEmpty
        self.query = query
        self.words = query.isEmpty ? [:] : words
        self.opened = opened
        // Resolve delegation across every computer the phone holds so cross-computer delegations fold and roll up even
        // when the computer menu narrows the list to one machine.
        let allRows = ThreadGroups.merged(computers, show: .all)
        let tops = ThreadGroups.delegationTops(allRows)
        self.tops = tops
        let allByID = Dictionary(allRows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // The delegated thread each listed thread stands for in Needs you (a permission ahead of a question, then the
        // most recent, as the desktop's sidebar orders them) and in Working now. Only a computer this iPhone can reach
        // claims live work or answerable requests.
        var below: [String: HostedThread] = [:]
        var workingBelow: [String: HostedThread] = [:]
        if !tops.isEmpty {
            for row in allRows {
                guard let top = tops[row.id], row.reachable else { continue }
                let state = ThreadState(row.thread)
                if state.waitsOnYou {
                    if let held = below[top], Self.rank(held) >= Self.rank(row) { continue }
                    below[top] = row
                } else if state.workInProgress {
                    if workingBelow[top] == nil { workingBelow[top] = row }
                }
            }
        }
        // The rows found only by what was said in their threads, by group, which list after the rest of it.
        var said: [Group: [HostedThread]] = [:]
        for row in allRows where show.admits(row.ref.hostID) {
            if ThreadGroups.isDelegated(row.thread) {
                // A delegated thread has no top-level row of its own (ADR-0081). When its top is visible under this
                // filter, that row stands for it; when its parent is settled/held back, on another computer not shown
                // here, or missing, the delegated thread stays out of Working/Recent/Settled/Snoozed and falls back
                // into Needs you only while it is reachable and waiting on the user, so no request is ever stranded.
                let hasVisibleTop = tops[row.id].flatMap { allByID[$0] }.map { show.admits($0.ref.hostID) } ?? false
                if hasVisibleTop { continue }
                guard row.reachable && ThreadState(row.thread).waitsOnYou else { continue }
                var onlySaid = false
                if !query.isEmpty {
                    let own = Self.searchable(row, nil).localizedStandardContains(query), found = self.words[row.id] != nil
                    guard own || found else { continue }
                    if !own { onlySaid = true } else if found { foundOwn.insert(row.id) }
                }
                if onlySaid { wordOnly.insert(row.id); said[.questions, default: []].append(row) } else { add(row, to: .questions) }
                continue
            }
            let delegated = below[row.id]
            let workingChild = workingBelow[row.id]
            if !row.settled && delegated == nil && workingChild == nil && ThreadGroups.isUnsent(row.thread) && row.ref != opened && !holding.contains(row.id) { continue }
            var onlySaid = false
            if !query.isEmpty {
                let own = Self.searchable(row, delegated).localizedStandardContains(query), found = self.words[row.id] != nil
                guard own || found else { continue }
                if !own { onlySaid = true } else if found { foundOwn.insert(row.id) }
            }
            let state = ThreadState(row.thread)
            let group: Group
            if row.reachable && state.waitsOnYou { group = .questions }
            else if let delegated { waitingIn[row.id] = delegated; group = .questions }
            else if row.settled { group = .settled }
            else if !row.failed, let until = row.thread.snoozedUntil.flatMap(Stamp.date), until > now { group = .snoozed }
            else if row.reachable && state.workInProgress { group = .working }
            else if !row.failed, let workingChild { workingIn[row.id] = workingChild; group = .working }
            else { group = .recent }
            if onlySaid { wordOnly.insert(row.id); said[group, default: []].append(row) } else { add(row, to: group) }
        }
        for (group, later) in said { for row in later { add(row, to: group) } }
    }

    private enum Group: Hashable { case questions, working, recent, settled, snoozed }
    private mutating func add(_ row: HostedThread, to group: Group) {
        switch group {
        case .questions: questions.append(row)
        case .working: working.append(row)
        case .recent: recent.append(row)
        case .settled: settled.append(row)
        case .snoozed: snoozed.append(row)
        }
    }

    /// The quote a row shows under its name: the search found its thread only by what was said in it. A row the list holds
    /// was tested as it was grouped; a settled row read from its computer, which the list leaves out, is tested here the
    /// same way.
    public func quote(_ row: HostedThread) -> ThreadWordQuote? {
        guard let match = words[row.id], !foundOwn.contains(row.id) else { return nil }
        guard wordOnly.contains(row.id) || !Self.searchable(row, nil).localizedStandardContains(query) else { return nil }
        return ThreadWordQuote(match: match, query: query)
    }
    /// `rows` with those the search found by their own words first, then those it found only by what was said in them,
    /// each in its order: the Settled shelf's rows while Threads is searched, with those read from the computers.
    public func ownWordsFirst(_ rows: [HostedThread]) -> [HostedThread] {
        guard !words.isEmpty else { return rows }
        var own: [HostedThread] = [], said: [HostedThread] = []
        for row in rows { if quote(row) == nil { own.append(row) } else { said.append(row) } }
        return own + said
    }

    public struct SnoozedProject: Identifiable {
        public let id: String
        public let title: String
        public var rows: [HostedThread]
        fileprivate let activity: Date
    }
    /// Snoozed projects and their threads, newest activity first, as on the desktop.
    public var snoozedProjects: [SnoozedProject] {
        let dated: [(row: HostedThread, at: Date)] = snoozed.map { row in
            let stamps: [String?] = [row.thread.updatedAt, row.thread.settledAt, row.thread.archivedAt, row.thread.summary?.lastMessageAt]
            let dates = stamps.compactMap { $0 }.compactMap(Stamp.date)
            return (row: row, at: dates.max() ?? Date.distantPast)
        }
        let rows = dated.sorted { $0.at == $1.at ? $0.row.id < $1.row.id : $0.at > $1.at }
        var projects: [SnoozedProject] = []
        var indices: [String: Int] = [:]
        for item in rows {
            let row = item.row
            let key = row.ref.hostID + "/" + row.thread.projectId
            if let index = indices[key] { projects[index].rows.append(row) }
            else {
                indices[key] = projects.count
                projects.append(SnoozedProject(id: key, title: row.project ?? row.computer, rows: [row], activity: item.at))
            }
        }
        // A project's threads the search found only by what was said in them list after the rest of its threads.
        if !wordOnly.isEmpty {
            for index in projects.indices {
                let rows = projects[index].rows
                projects[index].rows = rows.filter { !wordOnly.contains($0.id) } + rows.filter { wordOnly.contains($0.id) }
            }
        }
        return projects.sorted { $0.activity == $1.activity ? $0.id < $1.id : $0.activity > $1.activity }
    }
    /// The next time this grouping changes without a host update, including a cached offline snapshot.
    public var nextSnoozeWake: Date? { snoozed.compactMap { $0.thread.snoozedUntil.flatMap(Stamp.date) }.min() }

    /// The ID of the row that stands for a thread: its own, or for a delegated thread, which has no row of its own, the
    /// row of the thread its delegation is reached from, whether or not it waits on the user now.
    public func rowID(for ref: ThreadRef) -> String { tops[ref.id] ?? ref.id }

    /// The thread whose requests a Needs you row shows and answers: the delegated thread it stands for, or its own.
    public func asking(_ row: HostedThread) -> HostedThread { waitingIn[row.id] ?? row }

    /// The request a Needs you row's card shows and answers: the first one waiting in the thread that asks.
    public func asked(_ row: HostedThread) -> AskedRequest? {
        let thread = self.asking(row)
        return thread.thread.requests.first.map { AskedRequest(thread: thread.ref, requestID: $0.id) }
    }

    /// Whether a row shows the finished-unread mark: its computer says so and it is not the thread open here (ADR-0046).
    public func isUnreadFinish(_ row: HostedThread) -> Bool { row.finishedUnread && row.ref != opened }

    /// The words a search finds a row by, put together only while there is a search: the list is grouped again on
    /// every change, and nearly always with nothing typed.
    private static func searchable(_ row: HostedThread, _ delegated: HostedThread?) -> String {
        [row.thread.title, row.project ?? "", row.computer, row.thread.providerId ?? "",
         row.thread.requests.map(\.text).joined(separator: " "),
         delegated?.thread.requests.map(\.text).joined(separator: " ") ?? ""].joined(separator: " ")
    }

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
