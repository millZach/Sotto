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
    /// Whether Watcher's computer says it took this draft, or holds it in Watcher's queue to go next: either way it has
    /// the words.
    func holds(_ draftID: String) -> Bool { delivery(of: draftID) == "accepted" || followup(of: draftID) != nil }
    /// Older than `other`, by when the computer read it. A page read before another one already shown is left unshown.
    func isOlder(than other: WatcherPhoneState) -> Bool {
        guard let mine = Stamp.date(observedAt), let theirs = Stamp.date(other.observedAt) else { return false }
        return mine < theirs
    }
}

// MARK: - Asking Watcher

/// A message on its way to Watcher: its words, its draft ID, and the messages Watcher's conversation held when it left.
struct WatcherSending: Equatable, Sendable {
    let text: String
    let draftID: String
    let before: Set<String>
    /// Whether this page shows the message itself: the computer holds its draft, or the user's own message with its words
    /// has joined the conversation since it left.
    func shown(in page: WatcherPage) -> Bool {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return page.holds(draftID) || page.conversation.messages.contains {
            $0.role == "user" && !before.contains($0.id) && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == words
        }
    }
}

/// The draft IDs the Watcher box sent with that its computer may still deliver, each with its exact words. The same
/// words go with the same ID until a page asked for after their send ended says where that draft stands, even after
/// other words were sent in between: a message whose acknowledgement was lost keeps its ID through any edits, so sending
/// it again can't deliver it twice. Once such a page shows it is no longer on its way, the same words are a new message.
struct WatcherDrafts: Equatable, Sendable {
    struct Sent: Equatable, Sendable {
        let text: String
        /// The staged handles of the photos that went with the words, by ID, in order: the same words with other photos, or
        /// with the same photos staged again, are another message, as the host holds a draft ID to one packet.
        var photos: [String] = []
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
    /// The ID these exact words and photos go with: the one they last went with, or a new one.
    mutating func id(for text: String, photos: [String] = [], minting: () -> String = { UUID().uuidString.lowercased() }) -> String {
        if let index = unresolved.firstIndex(where: { $0.text == text && $0.photos == photos }) {
            unresolved[index].ended = false
            unresolved[index].sends += 1
            return unresolved[index].draftID
        }
        let draftID = minting()
        unresolved.append(Sent(text: text, photos: photos, draftID: draftID))
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
    var undo: String {
        watched ? String(localized: "Undo: stop watching \(title)", comment: "%@ is a thread's title")
            : String(localized: "Undo: watch \(title) again", comment: "%@ is a thread's title")
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
        if working { parts.append(String(localized: "Working", comment: "Watcher's state: it is taking a turn")) }
        if needs > 0 {
            parts.append(needs == 1 ? String(localized: "1 needs you", comment: "How many requests wait on the user, on the Watcher tab")
                : String(localized: "\(needs) need you", comment: "How many requests wait on the user, on the Watcher tab"))
        }
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
    ///   - top: the bottom of the header; `dockTop`, the top of the box.
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

    /// Where the card the reader is on goes when the page changes around it: `offset` below the header, where the reader
    /// left it, but no lower than keeps it whole above the box and never under the header. A card taller than the room
    /// between them stays where the reader left it as long as it fills that room. Cards removed or added below it, the
    /// user's follow-ups coming and going and Watcher's words growing all move the page's end, and the page keeps its end
    /// where it was, which would carry the card off with it (#1277).
    ///
    /// Returns the point, as a fraction of the card's height and of the visible page's, that `ScrollViewProxy.scrollTo`
    /// lines up to put the card's top there, or nil when it is already within a point of there.
    /// - Parameters:
    ///   - card: the card's frame now; `offset`, its top's distance below the header where the reader left it.
    ///   - top: the bottom of the header; `dockTop`, the top of the box.
    static func anchor(card: CGRect, offset: CGFloat, top: CGFloat, dockTop: CGFloat) -> CGFloat? {
        let spare = dockTop - top - card.height
        let wanted = min(max(top + offset, min(top, top + spare)), max(top, top + spare))
        guard abs(card.minY - wanted) > 1 else { return nil }
        // A card as tall as the room between the header and the box has its top at the header.
        guard abs(spare) > 1 else { return 0 }
        return min(max((wanted - top) / spare, 0), 1)
    }
}

/// Which way the user moves one of Watcher's pages, so its bar slides away as they read down and comes back as they go
/// up, as Safari's does (#1278, pick A). Near the page's top the bar always shows, and so it does while a card waits on
/// the user in the conversation, Watcher's own or a thread's (#1288): the page keeps a card the reader is on where they
/// left it, and with the bar fixed it never has to keep it clear of a bar that moves. Moves the user didn't make (the
/// page following Watcher's words, keeping a card, going to the top, or changing height) don't count, and start the
/// count again.
struct WatcherBarSlide: Equatable {
    /// How near the page's top the bar always shows.
    static let near: CGFloat = 12
    /// How far the user must move the page one way before the bar follows.
    static let travel: CGFloat = 14
    private var last: CGFloat?
    private var moved: CGFloat = 0

    /// - Parameters:
    ///   - offset: how far the page has scrolled from its top.
    ///   - counts: whether this move was the user's.
    ///   - pinned: whether a card waits on the user, which keeps the bar where it is.
    /// - Returns: true to slide the bar away, false to bring it back, nil to leave it.
    mutating func moved(to offset: CGFloat, counts: Bool, pinned: Bool = false) -> Bool? {
        defer { last = offset }
        guard let last else { return nil }
        if offset < Self.near || pinned { moved = 0; return false }
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
    static let toTop = String(localized: "Go to the top, where Watcher’s state and permissions are")
    /// What Watcher did, in a word or two.
    static func action(_ action: String) -> String {
        switch action {
        case "start": return String(localized: "Started", comment: "What Watcher did: it started a thread")
        case "send": return String(localized: "Sent a message", comment: "What Watcher did: it sent a message to a thread")
        case "stop": return String(localized: "Stopped", comment: "What Watcher did: it stopped a thread")
        case "settle": return String(localized: "Settled", comment: "What Watcher did: it settled a thread")
        default: return String(localized: "Changed", comment: "What Watcher did: it changed a thread")
        }
    }
    /// Where Watcher's action stands, when the thread hasn't simply taken it.
    static func delivery(_ receipt: WatcherPage.Receipt) -> String? {
        switch receipt.deliveryState {
        case "queued": return String(localized: "Waiting to go", comment: "Where Watcher's action stands: queued")
        case "dispatching": return String(localized: "watcher-action.sending", defaultValue: "Sending", comment: "Where Watcher's action stands: on its way")
        case "failed": return String(localized: "Didn’t reach it", comment: "Where Watcher's action stands: it didn't reach the thread")
        case "uncertain": return String(localized: "Not confirmed", comment: "Where Watcher's action stands: the computer didn't confirm it")
        default: return nil
        }
    }
    /// A watched thread's state, as Threads words it.
    static func status(_ thread: WatcherPage.WatchedThread) -> String {
        if !thread.connected || thread.status == "unavailable" {
            return String(localized: "Can’t reach it", comment: "A thread's state: its computer or provider can't be reached")
        }
        switch thread.status {
        case "running": return String(localized: "Working", comment: "A thread's state: its turn is running")
        case "error": return String(localized: "Turn failed", comment: "A thread's state: its last turn failed")
        default:
            return thread.backgroundWorkCount > 0 ? String(localized: "Working", comment: "A thread's state: its turn is running")
                : String(localized: "Idle", comment: "A thread's state: nothing is running")
        }
    }
    /// Whether a watched thread works now, as `status` says Working: read from its values, never from the words.
    static func working(_ thread: WatcherPage.WatchedThread) -> Bool {
        guard thread.connected, thread.status != "unavailable" else { return false }
        return thread.status == "running" || (thread.status != "error" && thread.backgroundWorkCount > 0)
    }
    /// Why a thread left Watched.
    static func left(_ thread: WatcherPage.WatchedThread) -> String {
        thread.takenOver ? String(localized: "You took it over", comment: "Why a thread left Watched")
            : String(localized: "No longer watched", comment: "Why a thread left Watched")
    }
    /// The meter beside Stop all: "3 of 4 watched".
    static func meter(_ page: WatcherPage) -> String {
        String(localized: "\(page.inFlight) of \(page.inFlightLimit) watched",
               comment: "The first number is how many threads Watcher works with now; the second is the most it may")
    }
    /// The line under Watched's cards.
    static func room(_ page: WatcherPage) -> String {
        let room = page.inFlightLimit - page.inFlight
        if room <= 0 { return String(localized: "Watcher starts nothing new until one of these finishes or stops. A thread waiting on you still counts.") }
        return (room == 1 ? String(localized: "1 more can start.", comment: "How many more threads Watcher may start")
            : String(localized: "\(room) more can start.", comment: "How many more threads Watcher may start"))
            + " " + String(localized: "A thread waiting on you still counts.")
    }
    /// Stop all's question.
    static func stopQuestion(_ count: Int) -> String {
        count == 1 ? String(localized: "Stop the thread Watcher started?") : String(localized: "Stop the \(count) threads Watcher started?")
    }
    static func stopButton(_ count: Int) -> String {
        count == 1 ? String(localized: "Stop 1 thread") : String(localized: "Stop \(count) threads")
    }
    /// What Stop all did, thread by thread when not everything stopped. `titles` are by `ThreadRef.id`.
    static func stopped(_ results: [WatcherStopResult.StoppedTarget], titles: [String: String]) -> String {
        if results.isEmpty { return String(localized: "Watcher had no threads to stop. Nothing was stopped.") }
        let done = results.filter { $0.status == "stopped" || $0.status == "requested" }
        if done.count == results.count {
            return done.count == 1 ? String(localized: "Stopped 1 thread Watcher started.")
                : String(localized: "Stopped \(done.count) threads Watcher started.")
        }
        let rest = results.filter { $0.status != "stopped" && $0.status != "requested" }.map { outcome in
            let title = titles[outcome.target.ref.id] ?? String(localized: "A thread", comment: "Stands in for a thread whose title isn't known")
            return outcome.status == "uncertain" ? String(localized: "\(title) isn’t confirmed.", comment: "%@ is a thread's title")
                : String(localized: "\(title): \(outcome.message)", comment: "The first %@ is a thread's title; the second is what its computer said about stopping it")
        }
        return String(localized: "Stopped \(done.count) of \(results.count).", comment: "The first number is how many threads stopped; the second is how many Stop all tried")
            + " " + rest.joined(separator: " ")
    }

    // Watching (watch B, Zach's pick on October 13, 2026): a thread stays watched until the user stops it, with no limit.

    /// The line over Watched's cards, from a computer whose watches last until the user stops them. `standing` of the
    /// `count` have a standing watch; the rest are watched for a Watcher request, which the user's own send there ends,
    /// so the line promises only what holds for each, word for word as on the desktop.
    static func watchedLead(_ count: Int, standing: Int? = nil) -> String {
        let standing = standing ?? count
        if count == 0 { return String(localized: "Watcher watches no threads yet. Watch one here or from its page, and Watcher keeps it going until you stop it.") }
        let keeps = count == 1 ? String(localized: "Watcher keeps this thread going on its own and brings you its questions and permissions.")
            : String(localized: "Watcher keeps these \(count) threads going on its own and brings you their questions and permissions.")
        if standing == count {
            return keeps + " " + (count == 1 ? String(localized: "It stays watched until you stop it.", comment: "Said of one watched thread")
                : String(localized: "Each stays watched until you stop it.", comment: "Said of several watched threads"))
        }
        if standing == 0 {
            return keeps + " " + (count == 1 ? String(localized: "It is watched for a request: if you send to it yourself, Watcher stops sending to it.")
                : String(localized: "They are watched for a request: if you send to one yourself, Watcher stops sending to it."))
        }
        return keeps + " " + String(localized: "A thread you watch stays watched until you stop it. One watched for a request stops when you send to it yourself.")
    }
    /// What Watcher last did with a watched thread, from its computer's own records and never from anyone's words: waiting
    /// while the user's own turn runs, its latest action and how that went, or how long it has watched with nothing sent.
    static func doing(_ thread: WatcherPage.WatchedThread, in page: WatcherPage) -> String? {
        if thread.paused == true { return String(localized: "You sent here yourself. Until that turn ends, Watcher can only steer it.") }
        let rows = page.receiptGroups.flatMap(\.rows).filter { $0.target == thread.target }
        if let last = rows.max(by: { (Stamp.date($0.updatedAt) ?? .distantPast) < (Stamp.date($1.updatedAt) ?? .distantPast) }) {
            let at = clock(last.updatedAt)
            switch last.deliveryState {
            case "accepted": return did(last.action, at: at)
            case "failed":
                if let at { return String(localized: "Watcher’s last try at \(at) didn’t reach it.", comment: "%@ is a time of day") }
                return String(localized: "Watcher’s last try didn’t reach it.")
            case "uncertain":
                if let at { return String(localized: "Watcher’s last try at \(at) isn’t confirmed.", comment: "%@ is a time of day") }
                return String(localized: "Watcher’s last try isn’t confirmed.")
            default: return String(localized: "Watcher is sending to it now.")
            }
        }
        guard let watch = page.standingWatch(thread.target.ref) else { return nil }
        let since: String
        if let at = clock(watch.createdAt) { since = String(localized: "Watching since \(at).", comment: "%@ is a time of day") }
        else { since = String(localized: "Watching.", comment: "Watcher has a standing watch on this thread") }
        return since + " " + String(localized: "Nothing sent yet.", comment: "Watcher hasn't sent anything to this thread")
    }
    /// What Watcher last did with a thread, as one sentence, with the time when its computer gave one.
    private static func did(_ action: String, at time: String?) -> String {
        if let time {
            switch action {
            case "start": return String(localized: "Watcher started it at \(time).", comment: "%@ is a time of day")
            case "send": return String(localized: "Watcher last sent to it at \(time).", comment: "%@ is a time of day")
            case "stop": return String(localized: "Watcher stopped it at \(time).", comment: "%@ is a time of day")
            case "settle": return String(localized: "Watcher settled it at \(time).", comment: "%@ is a time of day")
            default: return String(localized: "Watcher last changed it at \(time).", comment: "%@ is a time of day")
            }
        }
        switch action {
        case "start": return String(localized: "Watcher started it.")
        case "send": return String(localized: "Watcher last sent to it.")
        case "stop": return String(localized: "Watcher stopped it.")
        case "settle": return String(localized: "Watcher settled it.")
        default: return String(localized: "Watcher last changed it.")
        }
    }
    /// "10:15 AM", in this iPhone's own format.
    static func clock(_ stamp: String) -> String? { Stamp.date(stamp)?.formatted(date: .omitted, time: .shortened) }
    /// What a Watch or Stop watching press did.
    static func watching(_ title: String, _ watched: Bool) -> String {
        watched ? String(localized: "Watcher is watching \(title).", comment: "%@ is a thread's title")
            : String(localized: "Watcher stopped watching \(title).", comment: "%@ is a thread's title")
    }
    static func watchUnconfirmed(_ title: String, watched: Bool, computer: String) -> String {
        (watched ? String(localized: "\(computer) didn’t confirm that Watcher is watching \(title).", comment: "The first %@ is the computer's name; the second is a thread's title")
            : String(localized: "\(computer) didn’t confirm that Watcher stopped watching \(title).", comment: "The first %@ is the computer's name; the second is a thread's title"))
            + " " + String(localized: "Check Watched before you try again.")
    }
    static func permissionUnconfirmed(_ computer: String) -> String {
        String(localized: "\(computer) didn’t confirm the change to Watcher’s permissions. Check what they say before you change them again.", comment: "%@ is the computer's name")
    }

    // Steering Watcher while it works (#1229, Zach's pick B): Send steers into Watcher's turn, or the words go next.

    /// A computer on an older Sotto refuses a message while Watcher works. The words stay in the box.
    static func updateToSteer(_ computer: String) -> String {
        String(localized: "Update Sotto on \(computer) to send to Watcher while it works. Your message is still here.", comment: "%@ is the computer's name")
    }
    static func removeUnconfirmed(_ computer: String) -> String {
        String(localized: "\(computer) didn’t confirm that your message was removed. Check Watcher’s conversation before you send it again.", comment: "%@ is the computer's name")
    }
    /// What a follow-up waiting for Watcher says over its words.
    static func followup(_ status: String) -> String {
        switch status {
        case "dispatching": return String(localized: "Going to Watcher now")
        case "uncertain": return String(localized: "Watcher didn’t confirm this message")
        case "failed": return String(localized: "Didn’t reach Watcher")
        case "paused": return String(localized: "Held after a stop", comment: "A follow-up message held in Watcher's queue after the user stopped Watcher")
        default: return String(localized: "Goes next, after this turn")
        }
    }
    /// The line under its words, when there's more to say: why it didn't steer, or what to do next.
    static func followupNote(_ status: String, page: WatcherPage, computer: String) -> String? {
        switch status {
        case "queued":
            if page.needsYou.contains(where: { page.isOwn($0) }) { return nil }
            guard let current = page.current, current.steers == false else { return nil }
            return String(localized: "\(AgentNames.name(current.provider)) can’t take a steer.", comment: "%@ is the provider's name, such as Claude Code")
        case "uncertain": return String(localized: "Check the conversation before you send it again.")
        case "failed": return String(localized: "Remove it, then send it again.")
        case "paused": return String(localized: "Resume Watcher’s queue in Sotto on \(computer), or remove it.", comment: "%@ is the computer's name")
        default: return nil
        }
    }

    // Watcher's own changes (mark B): Sotto's count of what the provider changed, and Watcher's reason in its own words.

    static func files(_ count: Int) -> String { count == 1 ? String(localized: "1 file") : String(localized: "\(count) files") }
    static func ownChangeHeadline(_ count: Int) -> String {
        count == 1 ? String(localized: "Watcher changed 1 file itself.") : String(localized: "Watcher changed \(count) files itself.")
    }
    /// The press that shows the file names, and folds them again.
    static func ownChangeToggle(_ count: Int, open: Bool) -> String {
        if open { return count == 1 ? String(localized: "Hide the file") : String(localized: "Hide the \(count) files") }
        return count == 1 ? String(localized: "Show the file") : String(localized: "Show the \(count) files")
    }
}

/// What Watcher may do without asking (control A, Zach's pick on October 13, 2026): the four modes a thread has, with the
/// names this iPhone's new-thread sheet gives them and a line for each. The computer that runs Watcher keeps the choice,
/// and a new Watcher starts on it. Lasting grants stay refused in every mode.
enum WatcherPermissions {
    /// What the first Watcher ever starts on.
    static let first = "approval-required"
    static let modes = ["approval-required", "auto-accept-edits", "auto", "full-access"]
    static let title = String(localized: "What Watcher may do without asking")
    /// What stays true in every mode, under the list.
    static let foot = String(localized: "When Watcher asks, you can allow it once, not for good. Its instructions still tell it to hand changes to a thread.")
    static func name(_ mode: String) -> String {
        switch mode {
        case "approval-required": return String(localized: "Ask before actions", comment: "A permission mode's name")
        case "auto-accept-edits": return String(localized: "Allow edits", comment: "A permission mode's name")
        case "auto": return String(localized: "Allow actions", comment: "A permission mode's name")
        case "full-access": return String(localized: "Full access", comment: "A permission mode's name")
        default: return mode
        }
    }
    /// What Watcher does under a mode, in one line. Under Allow actions the provider decides, so the line names it.
    static func line(_ mode: String, provider: String, computer: String) -> String {
        switch mode {
        case "auto-accept-edits": return String(localized: "Edits files without asking. Asks before a command that changes something.")
        case "auto": return String(localized: "\(provider) decides what to ask you about.", comment: "%@ is the provider's name, such as Claude Code, or “The provider”")
        case "full-access": return String(localized: "Edits files and runs any command without asking, anywhere on \(computer).", comment: "%@ is the computer's name")
        default: return String(localized: "Asks you before it edits a file or runs a command that changes something.")
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
    static let fixed = String(localized: "Fixed while Watcher works.", comment: "Why Watcher's permission mode can't be changed now")
    static let fixedHint = String(localized: "It can change once Watcher finishes and nothing waits on you.")
    /// What stays in force while Watcher's provider hasn't confirmed the mode just chosen.
    static func inForce(_ mode: String, provider: String) -> String {
        String(localized: "\(provider) stays on \(name(mode)) until it confirms.",
               comment: "The first %@ is the provider's name, such as Claude Code; the second is a permission mode's name, such as Allow edits")
    }
    /// Why the wider modes can't be chosen from this iPhone.
    static func asksOnly(_ computer: String) -> String {
        String(localized: "This iPhone can’t answer on \(computer), so it can only keep Watcher asking first.", comment: "%@ is the computer's name")
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
                                      body: permission ? String(localized: "Watcher is asking for permission on \(computer).", comment: "%@ is the computer's name")
                                          : String(localized: "Watcher is asking a question on \(computer).", comment: "%@ is the computer's name"),
                                      id: Self.alertPrefix + ref.id + "/request/" + card.request.id))
        }
        if nowFailed && !failed && !first && !onScreen && switches.failed {
            alerts.append(ThreadAlert(ref: ref, kind: .failed, title: "Watcher", body: String(localized: "Watcher stopped with an error on \(computer).", comment: "%@ is the computer's name"),
                                      id: Self.alertPrefix + ref.id + "/failed/" + UUID().uuidString))
        }
        if known.count > 500 { known = known.intersection(own.map(\.request.id)) }
        return alerts
    }
}

/// The words a watched thread carries, shared by its rows, cards and reply box.
enum WatchedWords {
    static let label = String(localized: "Watched by Watcher")
    /// What a watched thread's reply box says on a computer whose watching a send takes over: one that keeps no
    /// standing watches.
    static let takeover = String(localized: "Watched by Watcher. If you send here, Watcher stops sending to it.")
    /// What it says where Watcher keeps the thread watched until the user stops it, word for word as on the desktop, and
    /// while the user's own turn there runs.
    static let standing = String(localized: "Watched by Watcher. It keeps this thread going and brings you its questions and permissions.")
    static let paused = String(localized: "Watched by Watcher. While your own turn here runs, it can only steer that turn.")
    /// The words a row or card adds for VoiceOver after where the thread runs.
    static func spoken(_ watched: Bool) -> String {
        watched ? ", " + String(localized: "thread-label.watched-by-watcher", defaultValue: "watched by Watcher", comment: "Added for VoiceOver after a thread's title and where it runs") : ""
    }
}
