import CoreGraphics
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
    /// The standing watch on this thread: Watcher keeps it going until the user stops it (ADR-0073, amended October 13,
    /// 2026). Nil from a computer that keeps none.
    func standingWatch(_ ref: ThreadRef) -> StandingWatch? { standingWatches?.first { $0.target.ref == ref } }
    /// The mark for a reply in which Watcher changed files itself, as its computer read it from the provider's own record
    /// of file changes in that turn.
    func ownChange(for replyID: String) -> OwnChange? { ownChanges?.first { $0.replyMessageId == replyID } }
    /// What Watcher may do without asking: the choice its computer keeps for Watcher, which a new Watcher starts on, or
    /// from a computer that keeps none, the current Watcher's own. The first Watcher ever asks first.
    var permission: String { runtimeMode ?? current?.runtimeMode ?? WatcherPermissions.first }
    /// The card, if it is still waiting.
    func card(_ ref: ThreadRef, requestID: String) -> RequestCard? {
        needsYou.first { $0.target.ref == ref && $0.request.id == requestID }
    }
    /// Where Watcher's computer says a draft this iPhone sent stands: `queued`, `submitting`, `accepted`, `uncertain` or
    /// `failed`, or nil when it says nothing of it.
    func delivery(of draftID: String) -> String? {
        draftDeliveries?.first { $0.draftId.lowercased() == draftID.lowercased() }?.status
    }
    /// The follow-up a draft this iPhone sent became, while it waits in Watcher's queue to go next (#1229).
    func followup(of draftID: String) -> Followup? {
        followups?.first { $0.draftId.lowercased() == draftID.lowercased() }
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
    /// Lets go of the drafts a page says Watcher took, or that wait in its queue to go next, and returns them, oldest
    /// first. With `proof`, the drafts whose send
    /// had ended when the page was asked for (`endedSends`), it also lets go of those it no longer shows on their way,
    /// unless they have been sent again since. Watcher's computer lists
    /// a draft from the moment it reads its send until Watcher took it or it failed, and won't take again one whose result
    /// it doesn't know, so a draft such a page shows neither queued, submitting nor uncertain was taken, failed or never
    /// reached it: the same words sent again can't arrive twice. A page pushed with a shell is no proof, since the computer
    /// may have made it before it read the send, and a page that says nothing of drafts is no proof either.
    mutating func retire(after page: WatcherPage, proof: [String: Int]) -> [Sent] {
        guard page.draftDeliveries != nil else { return [] }
        let taken = unresolved.filter { page.delivery(of: $0.draftID) == "accepted" || page.followup(of: $0.draftID) != nil }
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
    /// Watched threads where the user's own turn runs, which Watcher can only steer until it ends.
    let paused: Set<String>
    /// Watched threads under a standing watch, which lasts until the user stops it. The rest are watched for a Watcher
    /// request, which the user's own send there takes over.
    let standing: Set<String>
    init(_ page: WatcherPage) {
        working = page.working
        waiting = page.needsYou.map(\.target.ref)
        watched = Set(page.watched.map(\.target.ref.id))
        paused = Set(page.watched.filter { $0.paused == true }.map(\.target.ref.id))
        standing = Set(page.watched.filter { page.standingWatch($0.target.ref) != nil }.map(\.target.ref.id))
    }
}

/// What the last Watch or Stop watching press did, said for a few seconds with Undo (watch B). Nothing was asked first.
struct WatchNotice: Equatable, Sendable {
    let id: UUID
    /// The computer whose Watcher took the press.
    let hostID: String
    let target: ThreadRef
    let title: String
    /// What the press asked for: watched, or no longer.
    let watched: Bool
    var words: String { WatcherWords.watching(title, watched) }
    /// What Undo does, for VoiceOver.
    var undo: String { watched ? "Undo: stop watching \(title)" : "Undo: watch \(title) again" }
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

/// A message in Watcher's conversation, what Watcher did for one of its replies, or the line saying it changed files
/// itself in one.
enum WatcherItem: Identifiable, Equatable {
    case message(Message)
    case receipts(WatcherPage.ReceiptGroup, attached: Bool)
    case ownChange(WatcherPage.OwnChange)
    var id: String {
        switch self {
        case .message(let message): return "message/" + message.id
        case .receipts(let group, _): return "receipts/" + group.key
        case .ownChange(let change): return "own/" + change.replyMessageId
        }
    }
}

enum WatcherConversation {
    /// Messages in order, each reply followed by what Watcher did for it (2B), then by the line saying it changed files
    /// itself, when it did (mark B). A group whose reply isn't in the conversation is never attached to another reply: it
    /// stands alone, placed by when it happened. A mark whose reply isn't there is left out: it says nothing on its own.
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
            if message.role == "assistant", let change = page.ownChange(for: message.id), max(change.fileCount, change.files.count) > 0 {
                items.append(.ownChange(change))
            }
            items += (after[index] ?? []).map { .receipts($0, attached: false) }
        }
        return items + trailing.map { .receipts($0, attached: false) }
    }
}

/// Where the reader of Watcher's conversation stands, worked out from frames in one coordinate space where they let go of
/// the page or the box moves. Cards waiting on the user sit after the conversation, so following Watcher's new words
/// would push a card under the box; a reader on a card is held on it instead, and nothing but the reader moves it away
/// (#1277).
struct WatcherReaderPlace: Equatable {
    /// How near the box, or the header, the newest words or the page's end must be to count as in view, and how much of
    /// a card must show above the box for the reader to be on it.
    static let slack: CGFloat = 56
    /// The key of the card the reader is on: the lowest one they see whole, or with none whole, the one they see most of,
    /// as long as they see enough of it to read. A whole card wins over a lower one cut off by the box: keeping the
    /// cut-off one whole above the box would push the whole one under the header. Keeping the lowest whole one where it
    /// is keeps any above it where they are too.
    let heldCard: String?
    /// The reader sees the newest words, or the page's end, and is on no card, so the page follows Watcher's new words.
    let following: Bool

    /// - Parameters:
    ///   - newest: the bottom of the newest words; `end`, the bottom of the page.
    ///   - top: the top of what the reader sees: the bottom of the bar, or of the status bar while the bar is away
    ///     (#1278); `dockTop`, the top of the box.
    ///   - cards: each waiting card's frame, by its key.
    init(newest: CGFloat, end: CGFloat, top: CGFloat, dockTop: CGFloat, cards: [String: CGRect]) {
        let slack = Self.slack
        let seen = cards.filter { $0.value.minY < dockTop - slack && $0.value.maxY > top }
        let whole = seen.filter { $0.value.minY >= top - 1 && $0.value.maxY <= dockTop + 1 }
        func shown(_ card: CGRect) -> CGFloat { min(card.maxY, dockTop) - max(card.minY, top) }
        if whole.isEmpty {
            heldCard = seen.max(by: { shown($0.value) < shown($1.value) })?.key
        } else {
            heldCard = whole.max(by: { $0.value.minY < $1.value.minY })?.key
        }
        let seesNewest = newest >= top - slack && newest <= dockTop + slack
        following = heldCard == nil && (seesNewest || end <= dockTop + slack)
    }

    /// Where the card the reader is on goes when the page changes around it: `offset` below the top of what the reader
    /// sees, where they left it, but no lower than keeps it whole above the box and never above that top. A card taller
    /// than the room between them stays where the reader left it as long as it fills that room. Cards removed or added
    /// below it, the user's follow-ups coming and going and Watcher's words growing all move the page's end, and the page
    /// keeps its end where it was, which would carry the card off with it (#1277).
    ///
    /// Returns the point, as a fraction of the scroll view's visible page, that `ScrollViewProxy.scrollTo` lines the card's
    /// top up with, or nil when it is already within a point of where it goes. The page scrolls to a mark with no height at
    /// the card's top rather than to the card, so the point is the same for a card of any height, even one exactly as tall
    /// as the visible page. That page starts at `viewTop`, the bottom of the bar's place, even while the bar is away
    /// (#1278). The bar comes back once the reader is on a card (#1288), so the card goes back within that page, and
    /// only a card taller than the room, its top above the bar, lines up at a point above it, a fraction below 0.
    /// - Parameters:
    ///   - card: the card's frame now; `offset`, its top's distance below `top` where the reader left it.
    ///   - top: the top of what the reader sees: the bottom of the bar, or of the status bar while the bar is away;
    ///     `dockTop`, the top of the box.
    ///   - viewTop: the top of the scroll view's visible page, which `scrollTo` lines up within; `top` when nil.
    static func anchor(card: CGRect, offset: CGFloat, top: CGFloat, dockTop: CGFloat, viewTop: CGFloat? = nil) -> CGFloat? {
        let wanted = top + kept(offset, height: card.height, top: top, dockTop: dockTop)
        guard abs(card.minY - wanted) > 1 else { return nil }
        let viewTop = viewTop ?? top
        let page = dockTop - viewTop
        guard page > 1 else { return nil }
        return (wanted - viewTop) / page
    }

    /// The held card's offset once the top of what the reader sees moves from `before` to `top`, as it does when the bar
    /// slides away or comes back (#1278), and when the reader stops on a card with the bar away, which brings it back
    /// (#1288): the card stays where it is on the screen, measured from the new top, unless that puts it under the bar
    /// that came back or under the box, where it comes only as far as keeps it in view.
    /// - Parameters:
    ///   - offset: the card's top's distance below `before` where the reader left it; `height`, the card's.
    ///   - top: the new top of what the reader sees; `dockTop`, the top of the box.
    static func offset(_ offset: CGFloat, from before: CGFloat, height: CGFloat, top: CGFloat, dockTop: CGFloat) -> CGFloat {
        kept(before + offset - top, height: height, top: top, dockTop: dockTop)
    }

    /// `offset` below `top`, kept so a card `height` tall stays whole between `top` and the box or, taller than the room
    /// between them, fills that room.
    private static func kept(_ offset: CGFloat, height: CGFloat, top: CGFloat, dockTop: CGFloat) -> CGFloat {
        let spare = dockTop - top - height
        return min(max(offset, min(0, spare)), max(0, spare))
    }
}

/// Which way the user moves one of Watcher's pages, so its bar slides away as they read down and comes back as they go
/// up, as Safari's does (#1278, pick A). Near the page's top the bar always shows, and so it does while the reader is on
/// a card waiting on them (#1288): with no strip uncovered over a held card, nothing has to keep the card in a place the
/// scroll view can't line it up with. iOS 17 can't say when the reader lets go, so there a card doesn't keep the bar
/// (`holding(card:userScrolling:seesLetGo:)`). Moves the user didn't make (the page following Watcher's words, keeping a
/// card, going to the top, or changing height) don't count, and start the count again.
struct WatcherBarSlide: Equatable {
    /// How near the page's top the bar always shows.
    static let near: CGFloat = 12
    /// How far the user must move the page one way before the bar follows.
    static let travel: CGFloat = 14
    private var last: CGFloat?
    private var moved: CGFloat = 0

    /// Whether the card the reader is on keeps the bar shown, which brings it back over the card when they stop there
    /// with it away, and moves the card down below it. Only once they let go: while they move the page, the card they
    /// are on is decided again where they let go, and the page never moves under them. iOS 17 can't say when they let
    /// go, so there no card keeps the bar: it slides as it does with none held, and a card the reader stops on in the
    /// strip it uncovered stays in view there, rather than under a bar come back over it that nothing moves it out from.
    /// - Parameters:
    ///   - card: whether the reader is on a card; `userScrolling`, whether they are moving the page.
    ///   - seesLetGo: whether this iOS says when the reader lets go of the page, as iOS 18 and later do.
    static func holding(card: Bool, userScrolling: Bool, seesLetGo: Bool) -> Bool {
        seesLetGo && card && !userScrolling
    }

    /// - Parameters:
    ///   - offset: how far the page has scrolled from its top.
    ///   - counts: whether this move was the user's.
    ///   - holding: whether the reader is on a card, which keeps the bar.
    /// - Returns: true to slide the bar away, false to bring it back, nil to leave it.
    mutating func moved(to offset: CGFloat, counts: Bool, holding: Bool = false) -> Bool? {
        defer { last = offset }
        guard let last else { return nil }
        if offset < Self.near || holding { moved = 0; return false }
        guard counts else { moved = 0; return nil }
        let step = offset - last
        guard step != 0 else { return nil }
        moved = (step > 0) == (moved > 0) ? moved + step : step
        if moved > Self.travel { return true }
        if moved < -Self.travel { return false }
        return nil
    }
}

// MARK: - Words

enum WatcherWords {
    /// The bar's owl, which goes to the top of Watcher's page.
    static let toTop = "Go to the top, where Watcher’s state and permissions are"
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

    // Watching (watch B, Zach's pick on October 13, 2026): a thread stays watched until the user stops it, with no limit.

    /// The line over Watched's cards, from a computer whose watches last until the user stops them. `standing` of the
    /// `count` have a standing watch; the rest are watched for a Watcher request, which the user's own send there ends,
    /// so the line promises only what holds for each, word for word as on the desktop.
    static func watchedLead(_ count: Int, standing: Int? = nil) -> String {
        let standing = standing ?? count
        if count == 0 { return "Watcher watches no threads yet. Watch one here or from its page, and Watcher keeps it going until you stop it." }
        let keeps = count == 1 ? "Watcher keeps this thread going on its own and brings you its questions and permissions."
            : "Watcher keeps these \(count) threads going on its own and brings you their questions and permissions."
        if standing == count { return keeps + (count == 1 ? " It stays" : " Each stays") + " watched until you stop it." }
        if standing == 0 {
            return keeps + (count == 1 ? " It is watched for a request: if you send to it yourself, Watcher stops sending to it."
                : " They are watched for a request: if you send to one yourself, Watcher stops sending to it.")
        }
        return keeps + " A thread you watch stays watched until you stop it. One watched for a request stops when you send to it yourself."
    }
    /// What Watcher last did with a watched thread, from its computer's own records and never from anyone's words: waiting
    /// while the user's own turn runs, its latest action and how that went, or how long it has watched with nothing sent.
    static func doing(_ thread: WatcherPage.WatchedThread, in page: WatcherPage) -> String? {
        if thread.paused == true { return "You sent here yourself. Until that turn ends, Watcher can only steer it." }
        let rows = page.receiptGroups.flatMap(\.rows).filter { $0.target == thread.target }
        if let last = rows.max(by: { (Stamp.date($0.updatedAt) ?? .distantPast) < (Stamp.date($1.updatedAt) ?? .distantPast) }) {
            let at = clock(last.updatedAt).map { " at " + $0 } ?? ""
            switch last.deliveryState {
            case "accepted": return "Watcher \(verb(last.action))\(at)."
            case "failed": return "Watcher’s last try\(at) didn’t reach it."
            case "uncertain": return "Watcher’s last try\(at) isn’t confirmed."
            default: return "Watcher is sending to it now."
            }
        }
        guard let watch = page.standingWatch(thread.target.ref) else { return nil }
        return (clock(watch.createdAt).map { "Watching since \($0)." } ?? "Watching.") + " Nothing sent yet."
    }
    private static func verb(_ action: String) -> String {
        switch action {
        case "start": return "started it"
        case "send": return "last sent to it"
        case "stop": return "stopped it"
        case "settle": return "settled it"
        default: return "last changed it"
        }
    }
    /// "10:15 AM", in this iPhone's own format.
    static func clock(_ stamp: String) -> String? { Stamp.date(stamp)?.formatted(date: .omitted, time: .shortened) }
    /// What a Watch or Stop watching press did.
    static func watching(_ title: String, _ watched: Bool) -> String {
        watched ? "Watcher is watching \(title)." : "Watcher stopped watching \(title)."
    }
    static func watchUnconfirmed(_ title: String, watched: Bool, computer: String) -> String {
        (watched ? "\(computer) didn’t confirm that Watcher is watching \(title)." : "\(computer) didn’t confirm that Watcher stopped watching \(title).")
            + " Check Watched before you try again."
    }
    static func permissionUnconfirmed(_ computer: String) -> String {
        "\(computer) didn’t confirm the change to Watcher’s permissions. Check what they say before you change them again."
    }

    // Steering Watcher while it works (#1229, Zach's pick B): Send steers into Watcher's turn, or the words go next.

    /// A computer on an older Sotto refuses a message while Watcher works. The words stay in the box.
    static func updateToSteer(_ computer: String) -> String {
        "Update Sotto on \(computer) to send to Watcher while it works. Your message is still here."
    }
    static func removeUnconfirmed(_ computer: String) -> String {
        "\(computer) didn’t confirm that your message was removed. Check Watcher’s conversation before you send it again."
    }
    /// What a follow-up waiting for Watcher says over its words.
    static func followup(_ status: String) -> String {
        switch status {
        case "dispatching": return "Going to Watcher now"
        case "uncertain": return "Watcher didn’t confirm this message"
        case "failed": return "Didn’t reach Watcher"
        case "paused": return "Held after a stop"
        default: return "Goes next, after this turn"
        }
    }
    /// The line under its words, when there's more to say: why it didn't steer, or what to do next.
    static func followupNote(_ status: String, page: WatcherPage, computer: String) -> String? {
        switch status {
        case "queued":
            guard let current = page.current, current.steers == false else { return nil }
            return "\(AgentNames.name(current.provider)) can’t take a steer."
        case "uncertain": return "Check the conversation before you send it again."
        case "failed": return "Remove it, then send it again."
        case "paused": return "Resume Watcher’s queue in Sotto on \(computer), or remove it."
        default: return nil
        }
    }

    // Watcher's own changes (mark B): Sotto's count of what the provider changed, and Watcher's reason in its own words.

    static func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count) files" }
    static func ownChangeHeadline(_ count: Int) -> String { "Watcher changed \(files(count)) itself." }
    /// The press that shows the file names, and folds them again.
    static func ownChangeToggle(_ count: Int, open: Bool) -> String {
        let what = count == 1 ? "the file" : "the \(files(count))"
        return (open ? "Hide " : "Show ") + what
    }
}

/// What Watcher may do without asking (control A, Zach's pick on October 13, 2026): the four modes a thread has, with the
/// names this iPhone's new-thread sheet gives them and a line for each. The computer that runs Watcher keeps the choice,
/// and a new Watcher starts on it. Lasting grants stay refused in every mode.
enum WatcherPermissions {
    /// What the first Watcher ever starts on.
    static let first = "approval-required"
    static let modes = ["approval-required", "auto-accept-edits", "auto", "full-access"]
    static let title = "What Watcher may do without asking"
    /// What stays true in every mode, under the list.
    static let foot = "When Watcher asks, you can allow it once, not for good. Its instructions still tell it to hand changes to a thread."
    static func name(_ mode: String) -> String {
        switch mode {
        case "approval-required": return "Ask before actions"
        case "auto-accept-edits": return "Allow edits"
        case "auto": return "Allow actions"
        case "full-access": return "Full access"
        default: return mode
        }
    }
    /// What Watcher does under a mode, in one line. Under Allow actions the provider decides, so the line names it.
    static func line(_ mode: String, provider: String, computer: String) -> String {
        switch mode {
        case "auto-accept-edits": return "Edits files without asking. Asks before a command that changes something."
        case "auto": return "\(provider) decides what to ask you about."
        case "full-access": return "Edits files and runs any command without asking, anywhere on \(computer)."
        default: return "Asks you before it edits a file or runs a command that changes something."
        }
    }
    /// Whether a mode lets Watcher act without asking, which only an iPhone that may answer there can choose.
    static func grants(_ mode: String) -> Bool { mode != first }
    /// The modes Watcher's model offers, in Sotto's order; a model that names none, or no model yet, offers all four.
    static func offered(_ model: ThreadModel?) -> [String] {
        let listed = (model?.runtimeModes ?? []).filter { modes.contains($0) }
        return listed.isEmpty ? modes : modes.filter { listed.contains($0) }
    }
    /// Why the chip can't be pressed while Watcher works, as on the desktop: beside the chip, and when, as its hint.
    static let fixed = "Fixed while Watcher works."
    static let fixedHint = "It can change once Watcher finishes and nothing waits on you."
    /// What stays in force while Watcher's provider hasn't confirmed the mode just chosen.
    static func inForce(_ mode: String, provider: String) -> String { "\(provider) stays on \(name(mode)) until it confirms." }
    /// Why the wider modes can't be chosen from this iPhone.
    static func asksOnly(_ computer: String) -> String {
        "This iPhone can’t answer on \(computer), so it can only keep Watcher asking first."
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
    /// What a watched thread's reply box says on a computer whose watching a send takes over: one that keeps no
    /// standing watches.
    static let takeover = "Watched by Watcher. If you send here, Watcher stops sending to it."
    /// What it says where Watcher keeps the thread watched until the user stops it, word for word as on the desktop, and
    /// while the user's own turn there runs.
    static let standing = "Watched by Watcher. It keeps this thread going and brings you its questions and permissions."
    static let paused = "Watched by Watcher. While your own turn here runs, it can only steer that turn."
    /// The words a row or card adds for VoiceOver after where the thread runs.
    static func spoken(_ watched: Bool) -> String { watched ? ", watched by Watcher" : "" }
}
