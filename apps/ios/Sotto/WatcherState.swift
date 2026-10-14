import Foundation
import SottoCore

// Watcher on this iPhone (ADR-0073, amended October 11, 2026). The Owl desktop that runs Watcher offers `watcher-phone`
// to a phone that opts in, and hands it Watcher's page with every shell: its conversation, what it did for each reply,
// the threads it works with and the cards waiting on the user. The phone sends the user's own words, answers and Stop
// all back to that computer, which checks each one again. SottoCore decodes the page and builds those operations
// (`WatcherPhoneState`, `WatcherWire`); this is what the Watcher tab reads from them.

/// Watcher's page, as the computer that runs it projects it for a phone. It carries no tool arguments, prompt copies or
/// tokens. A provider the computer can't name is nil, and shows no logo.
typealias WatcherPage = WatcherPhoneState

extension WatcherTarget {
    /// The thread as this iPhone names it.
    var ref: ThreadRef { ThreadRef(hostID: hostId, threadID: threadId) }
}

extension WatcherPhoneState.RequestCard {
    /// A card's identity: its thread and its request.
    var key: String { target.ref.id + "/" + request.id }
}

extension WatcherPhoneState.ReceiptGroup {
    /// A group's identity: Watcher's request and the reply it belongs to, if any.
    var key: String { requestId + "/" + (replyMessageId ?? "unattached") }
}

extension WatcherPhoneState {
    /// Watcher's own thread, as this iPhone names it.
    var ownRef: ThreadRef? { current?.target.ref }
    /// Whether a card is Watcher's own request rather than a worker's.
    func isOwn(_ card: RequestCard) -> Bool { current?.target == card.target }
    /// The threads Watcher works with now, and the ones it no longer does.
    var watched: [WatchedThread] { watchedThreads.filter(\.watched) }
    var noLongerWatched: [WatchedThread] { watchedThreads.filter { !$0.watched } }
    func isWatched(_ ref: ThreadRef) -> Bool { watchedThreads.contains { $0.watched && $0.target.ref == ref } }
    /// The card, if it is still waiting.
    func card(_ ref: ThreadRef, requestID: String) -> RequestCard? {
        needsYou.first { $0.target.ref == ref && $0.request.id == requestID }
    }
    /// Where Watcher's computer says a draft this iPhone sent stands: `queued`, `submitting`, `accepted`, `uncertain` or
    /// `failed`, or nil when it says nothing of it.
    func delivery(of draftID: String) -> String? {
        draftDeliveries?.first { $0.draftId.lowercased() == draftID.lowercased() }?.status
    }
    /// Older than `other`, by when the computer read it. A page read before another one already shown is left unshown.
    func isOlder(than other: WatcherPhoneState) -> Bool {
        guard let mine = Stamp.date(observedAt), let theirs = Stamp.date(other.observedAt) else { return false }
        return mine < theirs
    }
}

// MARK: - Asking Watcher

/// The draft IDs the Watcher box sent with that its computer may still deliver, each with its exact words. The same
/// words go with the same ID until a page asked for after their send ended says where that draft stands, even after
/// other words were sent in between: a message whose acknowledgement was lost keeps its ID through any edits, so sending
/// it again can't deliver it twice. Once such a page shows it is no longer on its way, the same words are a new message.
struct WatcherDrafts: Equatable, Sendable {
    struct Sent: Equatable, Sendable {
        let text: String
        let draftID: String
        /// Its send has ended, so a page asked for from now on says where it stands.
        var ended = false
        /// How many times these words have gone with this ID. A page asked for before the last of them can't speak for it.
        var sends = 1
    }
    /// The most kept for one computer. Past it the oldest is let go, after this many other messages went unconfirmed.
    static let limit = 32
    /// Oldest first.
    private(set) var unresolved: [Sent] = []
    init() {}
    /// The ID these exact words go with: the one they last went with, or a new one.
    mutating func id(for text: String, minting: () -> String = { UUID().uuidString.lowercased() }) -> String {
        if let index = unresolved.firstIndex(where: { $0.text == text }) {
            unresolved[index].ended = false
            unresolved[index].sends += 1
            return unresolved[index].draftID
        }
        let draftID = minting()
        unresolved.append(Sent(text: text, draftID: draftID))
        if unresolved.count > Self.limit { unresolved.removeFirst(unresolved.count - Self.limit) }
        return draftID
    }
    /// Watcher took this draft. Its words get a new ID if they are sent again.
    mutating func resolve(_ draftID: String) {
        unresolved.removeAll { $0.draftID.lowercased() == draftID.lowercased() }
    }
    /// The drafts whose send has ended, by lowercased ID, with how many times each has gone: a page asked for from now on
    /// says where they stand, until one of them is sent again.
    var endedSends: [String: Int] {
        Dictionary(unresolved.filter(\.ended).map { ($0.draftID.lowercased(), $0.sends) }, uniquingKeysWith: { first, _ in first })
    }
    /// This draft's send ended: a page asked for from now on says where it stands.
    mutating func end(_ draftID: String) {
        for index in unresolved.indices where unresolved[index].draftID.lowercased() == draftID.lowercased() {
            unresolved[index].ended = true
        }
    }
    /// Lets go of the drafts a page says Watcher took, and returns them, oldest first. With `proof`, the drafts whose send
    /// had ended when the page was asked for (`endedSends`), it also lets go of those it no longer shows on their way,
    /// unless they have been sent again since. Watcher's computer lists
    /// a draft from the moment it reads its send until Watcher took it or it failed, and won't take again one whose result
    /// it doesn't know, so a draft such a page shows neither queued, submitting nor uncertain was taken, failed or never
    /// reached it: the same words sent again can't arrive twice. A page pushed with a shell is no proof, since the computer
    /// may have made it before it read the send, and a page that says nothing of drafts is no proof either.
    mutating func retire(after page: WatcherPage, proof: [String: Int]) -> [Sent] {
        guard page.draftDeliveries != nil else { return [] }
        let taken = unresolved.filter { page.delivery(of: $0.draftID) == "accepted" }
        let gone = unresolved.filter { sent in
            guard sent.ended, proof[sent.draftID.lowercased()] == sent.sends else { return false }
            switch page.delivery(of: sent.draftID) {
            case "queued", "submitting", "uncertain": return false
            default: return true
            }
        }
        let leaving = Set((taken + gone).map(\.draftID))
        unresolved.removeAll { leaving.contains($0.draftID) }
        return taken
    }
}

/// Words that didn't reach Watcher, or that it didn't confirm, kept while newer words are in its box (CONTEXT.md, Sent
/// message: a refused one is offered back when something newer is written there).
struct WatcherSetAside: Equatable, Sendable {
    let text: String
    /// The computer didn't say: Watcher may have taken them.
    let unconfirmed: Bool
}

// MARK: - The tab

/// What the rest of the app reads of Watcher's page: whether Watcher works, the threads with a card waiting on the user,
/// and the threads Watcher works with, by `ThreadRef.id`. It changes far less often than the page, whose conversation
/// grows with every shell while Watcher answers, so the model publishes it only when it changes (ADR-0051).
struct WatcherSummary: Equatable, Sendable {
    let working: Bool
    let waiting: [ThreadRef]
    let watched: Set<String>
    init(_ page: WatcherPage) {
        working = page.working
        waiting = page.needsYou.map(\.target.ref)
        watched = Set(page.watched.map(\.target.ref.id))
    }
}

/// What the Watcher tab says on its icon: a dot while Watcher works, and a count of what needs the user that only
/// Watcher's page shows: Watcher's own requests, and workers on computers this iPhone doesn't list. A worker's request
/// that Threads already shows is counted there, not twice.
struct WatcherTabState: Equatable {
    let working: Bool
    let needs: Int
    init(working: Bool, needs: Int) { self.working = working; self.needs = needs }
    init(summary: WatcherSummary?, listed: (ThreadRef) -> Bool) {
        working = summary?.working ?? false
        needs = summary?.waiting.filter { !listed($0) }.count ?? 0
    }
    /// What VoiceOver says after the tab's name, for the dot and the badge.
    var spoken: String {
        var parts: [String] = []
        if working { parts.append("Working") }
        if needs > 0 { parts.append(needs == 1 ? "1 needs you" : "\(needs) need you") }
        return parts.joined(separator: ", ")
    }
}

// MARK: - The conversation

/// A message in Watcher's conversation, or what Watcher did for one of its replies.
enum WatcherItem: Identifiable, Equatable {
    case message(Message)
    case receipts(WatcherPage.ReceiptGroup, attached: Bool)
    var id: String {
        switch self {
        case .message(let message): return "message/" + message.id
        case .receipts(let group, _): return "receipts/" + group.key
        }
    }
}

enum WatcherConversation {
    /// Messages in order, each reply followed by what Watcher did for it (2B). A group whose reply isn't in the
    /// conversation is never attached to another reply: it stands alone, placed by when it happened.
    static func items(_ page: WatcherPage) -> [WatcherItem] {
        let messages = page.conversation.messages
        let ids = Set(messages.map(\.id))
        var attached: [String: [WatcherPage.ReceiptGroup]] = [:]
        var loose: [WatcherPage.ReceiptGroup] = []
        for group in page.receiptGroups where !group.rows.isEmpty {
            if let reply = group.replyMessageId, ids.contains(reply) { attached[reply, default: []].append(group) }
            else { loose.append(group) }
        }
        // Each loose group goes after the last message written before it; with no times to go by, at the end.
        var after: [Int: [WatcherPage.ReceiptGroup]] = [:]
        var leading: [WatcherPage.ReceiptGroup] = []
        var trailing: [WatcherPage.ReceiptGroup] = []
        let dated: [(index: Int, date: Date)] = messages.enumerated().compactMap { index, message in
            guard let stamp = message.createdAt, let date = Stamp.date(stamp) else { return nil }
            return (index, date)
        }
        for group in loose {
            guard !dated.isEmpty, let when = group.rows.compactMap({ Stamp.date($0.createdAt) }).min() else {
                trailing.append(group)
                continue
            }
            if let index = dated.last(where: { $0.date <= when })?.index { after[index, default: []].append(group) }
            else { leading.append(group) }
        }
        var items: [WatcherItem] = leading.map { .receipts($0, attached: false) }
        for (index, message) in messages.enumerated() {
            items.append(.message(message))
            items += (attached[message.id] ?? []).map { .receipts($0, attached: true) }
            items += (after[index] ?? []).map { .receipts($0, attached: false) }
        }
        return items + trailing.map { .receipts($0, attached: false) }
    }
}

// MARK: - Words

enum WatcherWords {
    /// What Watcher did, in a word or two.
    static func action(_ action: String) -> String {
        switch action {
        case "start": return "Started"
        case "send": return "Sent a message"
        case "stop": return "Stopped"
        case "settle": return "Settled"
        default: return "Changed"
        }
    }
    /// Where Watcher's action stands, when the thread hasn't simply taken it.
    static func delivery(_ receipt: WatcherPage.Receipt) -> String? {
        switch receipt.deliveryState {
        case "queued": return "Waiting to go"
        case "dispatching": return "Sending"
        case "failed": return "Didn’t reach it"
        case "uncertain": return "Not confirmed"
        default: return nil
        }
    }
    /// A watched thread's state, as Threads words it.
    static func status(_ thread: WatcherPage.WatchedThread) -> String {
        if !thread.connected || thread.status == "unavailable" { return "Can’t reach it" }
        switch thread.status {
        case "running": return "Working"
        case "error": return "Turn failed"
        default: return thread.backgroundWorkCount > 0 ? "Working" : "Idle"
        }
    }
    /// Why a thread left Watched.
    static func left(_ thread: WatcherPage.WatchedThread) -> String {
        thread.takenOver ? "You took it over" : "No longer watched"
    }
    /// The meter beside Stop all: "3 of 4 watched".
    static func meter(_ page: WatcherPage) -> String { "\(page.inFlight) of \(page.inFlightLimit) watched" }
    /// The line under Watched's cards.
    static func room(_ page: WatcherPage) -> String {
        let room = page.inFlightLimit - page.inFlight
        if room <= 0 { return "Watcher starts nothing new until one of these finishes or stops. A thread waiting on you still counts." }
        return (room == 1 ? "1 more can start." : "\(room) more can start.") + " A thread waiting on you still counts."
    }
    /// Stop all's question.
    static func stopQuestion(_ count: Int) -> String {
        count == 1 ? "Stop the thread Watcher started?" : "Stop the \(count) threads Watcher started?"
    }
    static func stopButton(_ count: Int) -> String { count == 1 ? "Stop 1 thread" : "Stop \(count) threads" }
    /// What Stop all did, thread by thread when not everything stopped. `titles` are by `ThreadRef.id`.
    static func stopped(_ results: [WatcherStopResult.StoppedTarget], titles: [String: String]) -> String {
        if results.isEmpty { return "Watcher had no threads to stop. Nothing was stopped." }
        let done = results.filter { $0.status == "stopped" || $0.status == "requested" }
        if done.count == results.count {
            return done.count == 1 ? "Stopped 1 thread Watcher started." : "Stopped \(done.count) threads Watcher started."
        }
        let rest = results.filter { $0.status != "stopped" && $0.status != "requested" }.map { outcome in
            let title = titles[outcome.target.ref.id] ?? "A thread"
            return outcome.status == "uncertain" ? "\(title) isn’t confirmed." : "\(title): \(outcome.message)"
        }
        return "Stopped \(done.count) of \(results.count). " + rest.joined(separator: " ")
    }
}

// MARK: - Alerts

/// Alerts for Watcher's own requests and errors, under the alert switches every thread uses (5A). Never for Watcher's
/// own finished turns: they end after every batch of news. Workers alert from their own computer's thread list. The
/// first page after connecting is not news, and a request alerts once.
struct WatcherWatch: Sendable {
    /// An alert whose ID starts with this is Watcher's, and opens the Watcher tab when tapped.
    static let alertPrefix = "watcher/"
    private var seen: Set<String>?
    private var failed = false
    init() {}
    mutating func observe(_ page: WatcherPage, hostID: String, computer: String, onScreen: Bool, switches: AlertSwitches) -> [ThreadAlert] {
        let first = seen == nil
        var known = seen ?? []
        var alerts: [ThreadAlert] = []
        let own = page.needsYou.filter { page.isOwn($0) }
        let nowFailed = page.current?.status == "error"
        defer { seen = known; failed = nowFailed }
        guard let current = page.current else { return [] }
        let ref = current.target.ref
        for card in own {
            guard known.insert(card.request.id).inserted, !first, !onScreen, switches.needsYou else { continue }
            let permission = card.request.kind == "permission"
            alerts.append(ThreadAlert(ref: ref, kind: permission ? .permission : .question, title: "Watcher",
                                      body: permission ? "Watcher is asking for permission on \(computer)." : "Watcher is asking a question on \(computer).",
                                      id: Self.alertPrefix + ref.id + "/request/" + card.request.id))
        }
        if nowFailed && !failed && !first && !onScreen && switches.failed {
            alerts.append(ThreadAlert(ref: ref, kind: .failed, title: "Watcher", body: "Watcher stopped with an error on \(computer).",
                                      id: Self.alertPrefix + ref.id + "/failed/" + UUID().uuidString))
        }
        if known.count > 500 { known = known.intersection(own.map(\.request.id)) }
        return alerts
    }
}

/// The words a watched thread carries, shared by its rows, cards and reply box.
enum WatchedWords {
    static let label = "Watched by Watcher"
    /// What a watched thread's reply box says, word for word as on the desktop.
    static let takeover = "Watched by Watcher. If you send here, Watcher stops sending to it."
    /// The words a row or card adds for VoiceOver after where the thread runs.
    static func spoken(_ watched: Bool) -> String { watched ? ", watched by Watcher" : "" }
}
