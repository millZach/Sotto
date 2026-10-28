import SwiftUI
import UIKit
import SafariServices
import SottoCore

/// One thread, as thread page B draws it (ADR-0051): only a slim bar stays pinned (back, the thread's state, and its
/// title once the big one has scrolled off). The big title, where the thread runs and its branch chips scroll away with
/// the conversation, and the agent's steps sit between the messages in time order, each run folded into one line that
/// opens in place. A waiting question or permission opens as a sheet; dismissed, the reply box offers it again.
/// Everything here goes to the thread's own computer.
struct ThreadView: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    @State private var open: AgentRequest?
    @State private var setAside: Set<String> = []
    /// The request the sheet was opened for, set aside when the sheet closes without an answer.
    @State private var shown: String?
    /// The conversation has moved under the bar, so the bar turns to glass.
    @State private var stuck = false
    /// The big title has scrolled off, so the bar shows it.
    @State private var titled = false
    /// The Agents sheet is up, or a delegated thread it opened is on top (ADR-0103): no request sheet is offered then.
    @State private var agentsOpen = false
    @State private var agentsCovered = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var thread: ThreadSummary? { model.thread(ref) }

    var body: some View {
        Conversation(ref: ref, stuck: $stuck, titled: $titled) { request in
            shown = request.id
            open = request
        }
        .background(Palette.canvas)
        .navigationTitle(thread?.title ?? String(localized: "Thread", comment: "Title for a thread that has no title yet"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { barTitle }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: Space.s1) {
                    if let agents = model.agentsCount(ref) { AgentsButton(count: agents) { agentsOpen = true } }
                    barPill
                    if model.watchHost(for: ref) != nil { WatchToggle(ref: ref, title: thread?.title) }
                    if model.compactionOffered(ref) || model.shelfAction(ref) != nil { ThreadMenu(ref: ref) }
                }
            }
        }
        .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
        .toolbarBackground(stuck ? .visible : .hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .coversTabs()
        // While a request sheet is up its keyboard never squeezes the page behind it, so the conversation keeps its
        // size and its place.
        .ignoresSafeArea(open != nil ? SafeAreaRegions.keyboard : [], edges: .bottom)
        .task(id: ref) { await model.select(ref); offer() }
        .onDisappear { Task { if model.selected == ref { await model.select(nil) } } }
        .onChange(of: thread?.requests.map(\.id)) { _, _ in offer() }
        .sheet(item: $open, onDismiss: { if let shown { setAside.insert(shown) }; shown = nil; offer() }) { request in
            RequestSheet(ref: ref, request: request).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .agentsSheet(ref: ref, open: $agentsOpen, covered: $agentsCovered) { offer() }
    }

    private var barTitle: some View {
        Text(thread?.title ?? String(localized: "Thread", comment: "Title for a thread that has no title yet"))
            .font(.sotto(.body, .semibold))
            .foregroundStyle(Palette.ink)
            .lineLimit(1)
            .opacity(titled ? 1 : 0)
            .offset(y: titled || reduceMotion ? 0 : 8)
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .easeOut(duration: 0.3), value: titled)
            .accessibilityHidden(!titled)
    }

    private var barPill: some View {
        ThreadStatePill(state: thread.map { ThreadState($0) } ?? .done,
                        since: Words.date(thread?.summary?.runningTurnStartedAt),
                        reachable: model.status(ref.hostID) != .unreachable)
    }

    /// Opens the thread's waiting request once; after "Not now" it waits in the reply box.
    private func offer() {
        guard open == nil, !agentsOpen, !agentsCovered, let request = thread?.requests.first(where: { !setAside.contains($0.id) }) else { return }
        shown = request.id
        open = request
    }
}

/// The thread's state in the bar, in a word: a light, the word and, while it works, how long it has been at it.
private struct ThreadStatePill: View {
    let state: ThreadState
    let since: Date?
    let reachable: Bool
    var body: some View {
        HStack(spacing: 6) {
            if reachable { StatusDot(state: state, size: 7) } else { Light(tone: .off, size: 7) }
            Text(word)
            if reachable, state.workInProgress, let since { ElapsedText(since: since) }
        }
        .font(.sotto(.caption, .semibold).monospacedDigit())
        .lineLimit(1)
        .padding(.leading, Space.s3)
        .padding(.trailing, 10)
        .frame(minHeight: 28)
        .foregroundStyle(foreground)
        .background(background, in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(reachable ? state.words : String(localized: "Can’t reach this computer"))
    }
    private var word: String {
        guard reachable else { return String(localized: "Can’t reach it", comment: "A thread's state in its bar: its computer can't be reached") }
        switch state {
        case .needsAnswer, .asked: return String(localized: "Needs you", comment: "A thread's state in its bar: it waits on the user")
        case .working: return String(localized: "Working", comment: "A thread's state in its bar")
        case .waiting: return String(localized: "Waiting", comment: "A thread's state in its bar")
        case .compacting: return String(localized: "thread-state.compacting", defaultValue: "Compacting", comment: "A thread's state in its bar: its context is being compacted")
        case .failed: return String(localized: "Failed", comment: "A thread's state in its bar")
        case .done: return String(localized: "Done", comment: "A thread's state in its bar")
        }
    }
    private var foreground: ThemeRole {
        guard reachable else { return Palette.muted }
        if state.workInProgress { return Palette.accentText }
        if state == .failed { return Palette.dangerText }
        if state.waitsOnYou { return Palette.warningText }
        return Palette.muted
    }
    private var background: ThemeRole {
        guard reachable else { return Palette.fillSoft }
        if state.workInProgress { return Palette.accent.opacity(Tint.accentPill) }
        if state == .failed { return Palette.danger.opacity(0.12) }
        return Palette.fillSoft
    }
}

/// Watch beside the thread's state (watch B, Zach's pick on October 13, 2026): pressed while Watcher watches the thread,
/// which then lasts until the user stops it here or on Watched, with no limit on how many. A press asks nothing first;
/// what it did is said over the reply box with Undo. Its name stays Watch and its value says whether it is on. Only where
/// a computer that runs Watcher takes it from this iPhone; at the largest text sizes it is the owl alone.
private struct WatchToggle: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let title: String?
    @State private var presses = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let watched = model.watchedByWatcher(ref)
        let compact = typeSize.isAccessibilitySize
        Button { presses += 1; Task { await model.setWatched(ref, !watched, title: title) } } label: {
            HStack(spacing: 6) {
                if model.changingWatch(ref) { ProgressView().controlSize(.mini) } else { WatcherOwlMark(size: 17).accessibilityHidden(true) }
                if !compact { Text("Watch").lineLimit(1) }
            }
            .font(.sotto(.small, .semibold))
            .foregroundStyle(watched ? Palette.accentText : Palette.ink)
            .padding(.horizontal, compact ? 0 : Space.s3)
            .frame(minWidth: 32, minHeight: 32)
            .background(watched ? Palette.accent.opacity(Tint.accentPill) : Palette.fillSoft, in: Capsule())
            .overlay(Capsule().strokeBorder(watched ? Palette.accent.opacity(0.6) : Palette.hairline, lineWidth: 1))
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: watched)
        .sensoryFeedback(.selection, trigger: presses)
        .disabled(!model.canChangeWatch(ref))
        .accessibilityLabel("Watch")
        .accessibilityValue(watched ? String(localized: "On", comment: "Whether Watcher watches this thread") : String(localized: "Off", comment: "Whether Watcher watches this thread"))
        .accessibilityHint(watched ? String(localized: "Stops Watcher watching this thread") : String(localized: "Watcher keeps this thread going until you stop it"))
        .accessibilityIdentifier("thread-watch")
    }
}

/// The thread's actions behind ••• beside its state: Compact context, while the thread's provider offers it, and Settle
/// or Restore, as on the desktop. A press asks the thread's computer; one that can't go now says why under its name.
/// Compacting shows its progress in the bar, and a confirmed Settle or Restore says so in the banner.
private struct ThreadMenu: View {
    @EnvironmentObject var model: AppModel
    /// Watched so whether there is history to compact follows the thread as it is read.
    @EnvironmentObject var detailStore: DetailStore
    let ref: ThreadRef
    @State private var acted = 0
    var body: some View {
        Menu {
            if model.compactionOffered(ref) {
                let held = model.compactionHeld(ref)
                Button { acted += 1; Task { await model.compact(ref) } } label: {
                    Text("Compact context")
                    Text(held ?? String(localized: "Summarize earlier messages to free room"))
                }
                .disabled(held != nil)
            }
            if let action = model.shelfAction(ref) {
                let held = model.actionHeld(ref)
                Button { acted += 1; Task { await model.shelve(ref, action) } } label: {
                    Text(action == .settle ? String(localized: "Settle", comment: "Settle the thread: put it away on the Settled shelf.")
                         : String(localized: "Restore", comment: "Restore a settled thread to open work."))
                    if let held { Text(held) }
                }
                .disabled(held != nil)
                .accessibilityIdentifier(action == .settle ? "thread-settle" : "thread-restore")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.ink)
                .frame(width: 32, height: 32)
                .background(Palette.fillSoft, in: Circle())
                .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 1))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Show thread actions")
        .accessibilityIdentifier("thread-actions")
        .sensoryFeedback(.impact(weight: .medium), trigger: acted)
    }
}

// MARK: - Conversation

/// Where the page stands, kept outside SwiftUI's state so scrolling never redraws it. Frames are global.
private final class FollowBox {
    /// How near the reply box the end of the conversation must be to count as reading at the bottom.
    static let slack: CGFloat = 56
    var sentinel: CGFloat = 0
    var dockTop: CGFloat = .greatestFiniteMagnitude
    var barBottom: CGFloat = 0
    var heroTop: CGFloat = .greatestFiniteMagnitude
    var titleBottom: CGFloat = .greatestFiniteMagnitude
    /// The user is reading at the bottom, so the page follows the conversation as it grows or the reply box moves.
    var atBottom = true
    /// The user is dragging the page or letting a flick run out, so it never moves under them.
    var userScrolling = false
    /// The page was asked to follow while the user moved it, and owes that once they let go.
    var missedFollow = false
    /// Counts requests to follow, so requests made in the same moment scroll once.
    var followRequests = 0
    func settle() { atBottom = sentinel <= dockTop + Self.slack }
}

/// A message, or a run of steps, as the conversation draws it.
private struct ConversationRow: Identifiable {
    let item: TimelineItem
    /// The provider's name heads an answer that doesn't follow another answer.
    let showsWho: Bool
    /// How long a run of steps took, for its folded line; nil for a message or when nothing says.
    var seconds: TimeInterval? = nil
    var id: String { item.id }

    static func make(_ items: [TimelineItem], date: (String) -> Date?) -> [ConversationRow] {
        var lastRole: String?
        return items.map { item -> ConversationRow in
            switch item {
            case .message(let message):
                let shows = message.role == "assistant" && lastRole != "assistant"
                lastRole = message.role
                return ConversationRow(item: item, showsWho: shows)
            case .steps(let steps):
                return ConversationRow(item: item, showsWho: false, seconds: StepRun.seconds(steps, date: date))
            }
        }
    }
}

/// The conversation's rows for the detail on screen, worked out once per revision. Timestamps are read once each.
private final class TimelineCache {
    private var key: String?
    private var cached: [ConversationRow] = []
    private var dates: [String: Date] = [:]
    /// `held` marks the copy kept on screen while the thread is read again. A fresh copy can carry the same revision, from
    /// a computer whose Sotto restarted, so it is always drawn anew.
    func rows(for detail: ThreadDetail?, held: Bool = false) -> [ConversationRow] {
        guard let detail else {
            key = nil
            cached = []
            return []
        }
        let next = detail.threadId + "#" + String(detail.revision) + (held ? "#held" : "")
        if next == key { return cached }
        key = next
        if dates.count > 10_000 { dates = [:] }
        let items = ThreadTimeline.items(messages: detail.messages, activities: detail.activities ?? [],
                                         earlierAvailable: detail.earlierAvailable == true, date: { self.date($0) })
        cached = ConversationRow.make(items, date: { self.date($0) })
        return cached
    }
    private func date(_ stamp: String) -> Date? {
        if let known = dates[stamp] { return known }
        guard let parsed = Stamp.date(stamp) else { return nil }
        dates[stamp] = parsed
        return parsed
    }
}

/// What, when it changes at the end of the conversation, the page follows if the user is reading at the bottom.
private struct Tail: Equatable {
    let revision: Int?
    let rows: Int
    let last: String?
    let pending: [String]
    let failed: Bool
}

/// The scrolling page: the wash, the big title and its chips, then messages and steps, with the reply box in glass
/// over the bottom edge. The page keeps its place: while the user reads at the bottom it stays at the bottom when the
/// reply box changes height, the keyboard opens or closes, a request is answered or new content arrives; once they
/// have scrolled up to read, nothing moves them.
private struct Conversation: View {
    @EnvironmentObject var model: AppModel
    /// Watched so each new revision of the thread redraws the conversation; it is read through `model.shown(for:)`.
    @EnvironmentObject var detailStore: DetailStore
    let ref: ThreadRef
    @Binding var stuck: Bool
    @Binding var titled: Bool
    let openRequest: (AgentRequest) -> Void
    @State private var dismissMarker: PendingOperation?
    @State private var viewing: OpenPhotos?
    @State private var follow = FollowBox()
    @State private var timeline = TimelineCache()
    /// The height between the bar and the reply box, so a short conversation still fills it from the top.
    @State private var visible: CGFloat = 0
    /// The runs of steps opened on this page, by run, kept while the thread is on screen.
    @State private var openRuns: Set<String> = []
    @Environment(\.sottoDensity) private var density
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let end = "thread-end"

    var body: some View {
        let detail = model.shown(for: ref)
        let rows = timeline.rows(for: detail, held: detail != nil && model.detail(for: ref) == nil)
        let pending = model.pending(for: ref)
        let tail = Tail(revision: detail?.revision, rows: rows.count, last: rows.last?.id, pending: pending.map(\.id),
                        failed: model.failedReplies[ref.id] != nil)
        ScrollViewReader { proxy in
            ScrollView {
                page(detail: detail, rows: rows, pending: pending, scroll: proxy).readingWidth()
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onUserScrolling { scrolling in
                follow.userScrolling = scrolling
                guard !scrolling, follow.missedFollow else { return }
                follow.missedFollow = false
                // What arrived while they moved the page is followed once they let go at the bottom. A page that
                // only moved is left where they put it.
                follow.settle()
                if follow.atBottom { toBottom(proxy) }
            }
            .background(barReader)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ReplyDock(ref: ref, openRequest: openRequest)
                    .equatable()
                    .readingWidth()
                    .background(dockReader(proxy))
            }
            .onChange(of: tail) { _, _ in
                if follow.atBottom { toBottom(proxy) }
            }
        }
        .fullScreenCover(item: $viewing) { PhotoViewer(opened: $0) }
        .confirmationDialog("Stop waiting for confirmation?", isPresented: Binding(get: { dismissMarker != nil }, set: { if !$0 { dismissMarker = nil } }), titleVisibility: .visible) {
            Button("I checked the thread") { if let item = dismissMarker { model.acknowledgeUnknown(item.id) }; dismissMarker = nil }
            Button("Cancel", role: .cancel) { dismissMarker = nil }
        } message: { Text("It may already have reached \(model.name(ref.hostID)). Nothing is sent again.") }
    }

    /// The pull request chip's sheet and dot, where the thread's computer offers the sheet (ADR-0102); nil keeps the chip
    /// as it was.
    private func pullRequestChip(_ thread: ThreadSummary?) -> PullRequestChip? {
        guard model.offersPullRequestSheet(ref.hostID), let url = GitChips(thread?.worktree).pullRequestURL else { return nil }
        let last = model.lastPullRequest(ref, url: url)
        return PullRequestChip(url: url, dot: last.flatMap(PullRequests.dot), rollup: last.map { PullRequests.rollup($0.checks) })
    }
    private func page(detail: ThreadDetail?, rows: [ConversationRow], pending: [PendingOperation], scroll: ScrollViewProxy) -> some View {
        let thread = model.thread(ref)
        let state = thread.map { ThreadState($0) } ?? .done
        return VStack(alignment: .leading, spacing: 0) {
            ThreadHero(ref: ref, thread: thread, watched: model.watchedByWatcher(ref), pullRequest: pullRequestChip(thread),
                       topMoved: { top in follow.heroTop = top; refreshBar() },
                       titleMoved: { bottom in follow.titleBottom = bottom; refreshBar() })
                .equatable()
            entries(thread: thread, state: state, detail: detail, rows: rows, pending: pending, scroll: scroll)
            Color.clear.frame(height: 1).id(Self.end).background(sentinelReader)
        }
        .frame(maxWidth: .infinity, minHeight: max(0, visible - Space.s4), alignment: .topLeading)
        .padding(.horizontal, Space.s4)
        .padding(.bottom, Space.s4)
        .background(alignment: .top) {
            // Reaches up under the bar, so at rest the wash meets the top edge; it scrolls away with the title.
            Wash(warm: state.waitsOnYou, tone: washTone(state), height: 720).offset(y: -200)
        }
    }

    private func washTone(_ state: ThreadState) -> Wash.Tone {
        if state.workInProgress { return .normal }
        return state == .failed ? .failed : .quiet
    }

    private func entries(thread: ThreadSummary?, state: ThreadState, detail: ThreadDetail?, rows: [ConversationRow],
                         pending: [PendingOperation], scroll: ScrollViewProxy) -> some View {
        let online = model.online(ref.hostID)
        let provider = Words.provider(thread?.providerId)
        let working = workingRun(rows, state)
        // The row the conversation ends on, when nothing waits under it.
        let last = pending.isEmpty && model.failedReplies[ref.id] == nil ? rows.last?.id : nil
        return VStack(alignment: .leading, spacing: Space.dense(Space.s5, density)) {
            if detail?.earlierAvailable == true || thread?.earlierAvailable == true {
                Button("Show earlier messages") { Task { await model.earlier(ref) } }
                    .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                    .frame(maxWidth: .infinity)
                    .disabled(!online)
            }
            if detail != nil {
                if rows.isEmpty && pending.isEmpty {
                    Text("This thread is open on \(model.name(ref.hostID)). Write the first message below.")
                        .font(.sotto(.body)).foregroundStyle(Palette.muted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.s7)
                        .paragraphDirection()
                }
                ForEach(rows) { row in
                    rowView(row, provider: provider, working: row.id == working, last: row.id == last, scroll: scroll)
                }
            } else if model.detailProblem == nil || !online {
                (model.status(ref.hostID) == .unreachable ? Text("Reconnect to read this thread.") : Text("Reading this thread…"))
                    .font(.sotto(.body)).foregroundStyle(Palette.muted)
                    .padding(.vertical, Space.s6)
                    .paragraphDirection()
            }
            ForEach(pending) { item in
                UnconfirmedRow(item: item, text: model.submitted[item.id], photos: model.submittedPhotos[item.id] ?? [],
                               files: model.submittedFiles[item.id] ?? [], sending: model.isSending(item)) { dismissMarker = item }
            }
            if let text = model.failedReplies[ref.id] {
                FailedReplyCard(ref: ref, text: text)
            }
        }
        .padding(.top, Space.s3)
    }

    @ViewBuilder private func rowView(_ row: ConversationRow, provider: String, working: Bool, last: Bool,
                                      scroll: ScrollViewProxy) -> some View {
        switch row.item {
        case .message(let message):
            MessageView(message: message, provider: provider, showsWho: row.showsWho, ref: ref,
                        opensFiles: model.opensSentFiles(ref.hostID)) { viewing = $0 }.equatable()
        case .steps(let steps):
            FoldedRun(runID: steps.first?.id ?? row.id, steps: steps, seconds: row.seconds, working: working,
                      open: openRuns.contains(row.id), last: last) { toggleRun(row.id, scroll) }
                .equatable()
        }
    }

    /// The run the thread is working through now: the run the conversation ends on, while the thread works, whether or
    /// not one of its steps is running at this moment (between tool calls it is thinking).
    private func workingRun(_ rows: [ConversationRow], _ state: ThreadState) -> String? {
        guard state.workInProgress, let last = rows.last, case .steps = last.item else { return nil }
        return last.id
    }

    /// Opens or folds a run in place with a spring. A reader at the bottom stays at the bottom; one who has scrolled up
    /// is left where they are.
    private func toggleRun(_ run: String, _ scroll: ScrollViewProxy) {
        let wasAtBottom = follow.atBottom
        withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.82)) {
            openRuns.formSymmetricDifference([run])
        }
        if wasAtBottom { toBottom(scroll) }
    }

    // MARK: Keeping the user's place

    /// The bottom of the bar: the top of what the conversation shows.
    private var barReader: some View {
        GeometryReader { proxy in
            let bottom = proxy.frame(in: .global).minY + proxy.safeAreaInsets.top
            Color.clear
                .onAppear { barMoved(bottom) }
                .onChange(of: bottom) { _, value in barMoved(value) }
        }
    }

    /// The end of the conversation.
    private var sentinelReader: some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { follow.sentinel = proxy.frame(in: .global).maxY; follow.settle() }
                .onChange(of: proxy.frame(in: .global).maxY) { _, value in follow.sentinel = value; follow.settle() }
        }
    }

    /// The top of the reply box, which moves when it changes height or the keyboard opens or closes.
    private func dockReader(_ scroll: ScrollViewProxy) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { dockMoved(proxy.frame(in: .global).minY, scroll) }
                .onChange(of: proxy.frame(in: .global).minY) { _, value in dockMoved(value, scroll) }
        }
    }

    private func barMoved(_ bottom: CGFloat) {
        follow.barBottom = bottom
        updateVisible()
        refreshBar()
    }

    /// Decided on where the user stood before the reply box moved: at the bottom, the page follows it there.
    private func dockMoved(_ top: CGFloat, _ scroll: ScrollViewProxy) {
        let wasAtBottom = follow.atBottom
        follow.dockTop = top
        updateVisible()
        if wasAtBottom { toBottom(scroll) } else { follow.settle() }
    }

    private func updateVisible() {
        guard follow.dockTop < .greatestFiniteMagnitude / 2 else { return }
        let next = max(0, follow.dockTop - follow.barBottom)
        if abs(next - visible) > 0.5 { visible = next }
    }

    private func refreshBar() {
        let nowStuck = follow.heroTop < follow.barBottom - 2
        let nowTitled = follow.titleBottom < follow.barBottom + 2
        if nowStuck != stuck { stuck = nowStuck }
        if nowTitled != titled { titled = nowTitled }
    }

    /// Scrolls to the end once the new layout is in, and once more a moment later, after photos have settled their height.
    /// Requests made in the same moment scroll once, and only the latest looks again. None scrolls while the user moves
    /// the page; the page owes it to them for when they let go.
    private func toBottom(_ scroll: ScrollViewProxy) {
        let box = follow
        guard !box.userScrolling else { box.missedFollow = true; return }
        box.followRequests += 1
        let request = box.followRequests
        Task { @MainActor in
            await Task.yield()
            guard box.followRequests == request else { return }
            guard !box.userScrolling else { box.missedFollow = true; return }
            scroll.scrollTo(Self.end, anchor: .bottom)
            try? await Task.sleep(nanoseconds: 120_000_000)
            if box.followRequests == request, box.atBottom, !box.userScrolling { scroll.scrollTo(Self.end, anchor: .bottom) }
        }
    }
}

extension View {
    /// Says whether the user is moving the page: dragging it or letting a flick run out. A finger that rests or taps is
    /// not moving it, so pressing a run of steps at the bottom still keeps the page there. iOS 17 can't say, so there the
    /// page follows as it did before.
    @ViewBuilder func onUserScrolling(_ changed: @escaping (Bool) -> Void) -> some View {
        if #available(iOS 18.0, *) {
            onScrollPhaseChange { _, phase in changed(phase == .interacting || phase == .decelerating) }
        } else {
            self
        }
    }
}

// MARK: - Title block

/// The big title, where the thread runs with its provider's logo and, while Watcher works with it, the owl, and its
/// branch chips, at the top of the conversation.
private struct ThreadHero: View, Equatable {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let thread: ThreadSummary?
    let watched: Bool
    /// The pull request chip's sheet and dot, where the computer offers the sheet.
    let pullRequest: PullRequestChip?
    let topMoved: (CGFloat) -> Void
    let titleMoved: (CGFloat) -> Void
    @State private var showingPullRequest = false
    /// Drawn again only when its thread changes, not for each new revision of the conversation under it; its readers
    /// report to the same page every time.
    static func == (a: Self, b: Self) -> Bool {
        a.ref == b.ref && a.thread == b.thread && a.watched == b.watched && a.pullRequest == b.pullRequest
    }
    var body: some View {
        let chips = GitChips(thread?.worktree)
        VStack(alignment: .leading, spacing: 0) {
            Text(thread?.title ?? String(localized: "Thread", comment: "Title for a thread that has no title yet"))
                .font(.sotto(.display, .bold))
                .headingTracking(-0.6)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("thread-title")
                .background(edgeReader(\.maxY, titleMoved))
            HStack(spacing: 5) {
                ProviderMarks(providerID: thread?.providerId, watched: watched)
                Text(place).lineLimit(1).truncationMode(.middle)
            }
            .font(.sotto(.small))
            .foregroundStyle(Palette.muted)
            .padding(.top, Space.s2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(place + WatchedWords.spoken(watched))
            if !chips.isEmpty {
                GitChipRow(chips: chips, sheet: pullRequest) { showingPullRequest = true }.padding(.top, Space.s3)
            }
        }
        .padding(.top, Space.s1)
        .padding(.bottom, Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(edgeReader(\.minY, topMoved))
        .sheet(isPresented: $showingPullRequest) {
            if let pullRequest, let number = chips.pullRequest?.number {
                PullRequestSheet(ref: ref, url: pullRequest.url, number: number)
            }
        }
    }

    /// Where it runs: the agent, the computer and the project.
    private var place: String {
        let base = String(localized: "\(Words.provider(thread?.providerId)) on \(model.name(ref.hostID))", comment: "Where a thread runs: the first %@ is the agent's name, the second the computer's name")
        let project = model.lists.first(where: { $0.hostID == ref.hostID })?.projects.first(where: { $0.id == thread?.projectId })?.title
        guard let project else { return base }
        return base + " · " + project
    }

    private func edgeReader(_ edge: KeyPath<CGRect, CGFloat>, _ moved: @escaping (CGFloat) -> Void) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { moved(proxy.frame(in: .global)[keyPath: edge]) }
                .onChange(of: proxy.frame(in: .global)[keyPath: edge]) { _, value in moved(value) }
        }
    }
}

/// The pull request chip where the computer offers the pull request sheet (ADR-0102): the pull request it opens, and the
/// checks' dot and roll-up from this iPhone's last read of it, nil before its sheet has opened.
struct PullRequestChip: Equatable {
    let url: String
    let dot: PullRequests.Tone?
    let rollup: String?
}

/// Branch, changed lines and pull request, from the worktree's Git status. The row reads as one sentence; where the
/// computer offers the pull request sheet, the pull request chip is a button of its own that opens it.
private struct GitChipRow: View {
    let chips: GitChips
    var sheet: PullRequestChip? = nil
    var open: () -> Void = {}
    var body: some View {
        if let sheet, let pullRequest = chips.pullRequest {
            HStack(spacing: Space.s2) {
                if chips.branch != nil || chips.changes != nil {
                    HStack(spacing: Space.s2) { branchAndChanges }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(chips.spoken(includingPullRequest: false))
                }
                Button(action: open) {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.triangle.pull").font(.system(size: 11, weight: .semibold))
                        Text("#\(String(pullRequest.number)) \(pullRequest.stateWord)", comment: "A pull request chip: its number, then its state, such as #721 open")
                        if let dot = sheet.dot { ChecksDot(tone: dot) }
                        Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold))
                    }
                    .font(.sotto(.caption, .semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .padding(.horizontal, Space.s3)
                    .frame(minHeight: 44)
                    .background(Palette.surface.opacity(0.7), in: Capsule())
                    .overlay(Capsule().strokeBorder(Palette.accent.opacity(0.35), lineWidth: 1))
                    .contentShape(Capsule())
                }
                .buttonStyle(PressStyle())
                .fixedSize()
                .accessibilityLabel(Self.spokenPullRequest(pullRequest, rollup: sheet.rollup))
                .accessibilityIdentifier("pull-request-chip")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            plain
        }
    }

    /// The pull request chip as VoiceOver reads it, with the checks' roll-up once its sheet has read them.
    private static func spokenPullRequest(_ pullRequest: GitChips.PullRequest, rollup: String?) -> String {
        let number: String = String(pullRequest.number)
        let state: String = pullRequest.stateWord
        guard let rollup else {
            return String(localized: "Show pull request \(number), \(state)", comment: "The first %@ is the pull request's number, the second its state")
        }
        return String(localized: "Show pull request \(number), \(state). Checks: \(rollup)", comment: "The first %@ is the pull request's number, the second its state, the third its checks' roll-up")
    }

    @ViewBuilder private var branchAndChanges: some View {
        if let branch = chips.branch {
            GitChip {
                Image(systemName: "arrow.triangle.branch").font(.system(size: 11, weight: .semibold))
                Text(verbatim: branch)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Palette.ink)
                    .truncationMode(.middle)
            }
        }
        if let changes = chips.changes {
            GitChip {
                Text("+\(changes.insertions)").foregroundStyle(Palette.accentText)
                Text("−\(changes.deletions)").foregroundStyle(Palette.dangerText)
                (changes.files == 1 ? Text("1 file") : Text("\(changes.files) files"))
            }
            .fixedSize()
        }
    }

    /// The row as it is without the sheet: every chip one sentence.
    private var plain: some View {
        HStack(spacing: Space.s2) {
            branchAndChanges
            if let pullRequest = chips.pullRequest {
                GitChip {
                    Image(systemName: "arrow.triangle.pull").font(.system(size: 11, weight: .semibold))
                    Text("#\(String(pullRequest.number)) \(pullRequest.stateWord)", comment: "A pull request chip: its number, then its state, such as #721 open")
                }
                .fixedSize()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(chips.spoken)
    }
}

private struct GitChip<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        HStack(spacing: 5) { content }
            .font(.sotto(.caption, .semibold))
            .foregroundStyle(Palette.muted)
            .lineLimit(1)
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.s1)
            .frame(minHeight: 30)
            .background(Palette.surface.opacity(0.7), in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
    }
}

// MARK: - Messages

private struct MessageView: View, Equatable {
    let message: Message
    let provider: String
    let showsWho: Bool
    let ref: ThreadRef
    /// Whether its computer hands sent files back to open in Quick Look (`attachment-files`).
    let opensFiles: Bool
    let open: (OpenPhotos) -> Void
    @Environment(\.sottoDensity) private var density
    /// Drawn again only when what it shows changes; opening a photo is the same action for every message.
    static func == (a: Self, b: Self) -> Bool {
        a.message == b.message && a.provider == b.provider && a.showsWho == b.showsWho && a.ref == b.ref && a.opensFiles == b.opensFiles
    }
    var body: some View {
        if message.role == "user" {
            userMessage
        } else if message.role == "assistant" {
            assistantMessage
        } else {
            Text(verbatim: message.text).font(.sotto(.small)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity)
        }
    }

    private var bubble: UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous)
    }

    /// The user's words in a bubble at the trailing edge, with their photos standing on their own above, as in Messages,
    /// and under the photos their files, each a pill that opens it in Quick Look where the computer hands files back.
    private var userMessage: some View {
        let attachments = message.attachments ?? []
        let photos = attachments.filter(\.hasPreview)
        let files = opensFiles ? attachments.filter { !$0.hasPreview && Files.isFile($0) } : []
        return VStack(alignment: .trailing, spacing: Space.s1) {
            SentPhotoButtons(ref: ref, messageID: message.id, photos: photos, open: open)
            if !files.isEmpty { SentFilePills(ref: ref, messageID: message.id, attachments: files) }
            if !message.text.isEmpty || photos.count + files.count != attachments.count {
                content(ink: Palette.bubbleInk, drawn: Set(files.map(\.id)))
                    .padding(.horizontal, Space.s4)
                    .padding(.vertical, Space.dense(Space.s3, density))
                    .background(Palette.bubble, in: bubble)
                    .overlay(bubble.stroke(Palette.accent.opacity(0.12), lineWidth: 1))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }

    /// The agent's words plain on the canvas, headed by its name when it starts answering.
    private var assistantMessage: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if showsWho {
                HStack(spacing: Space.s2) {
                    Text(String(provider.prefix(1)))
                        .font(.figtree(10, .caption2, .bold))
                        .foregroundStyle(Palette.accentText)
                        .frame(width: 18, height: 18)
                        .background(Palette.accent.opacity(0.22), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .accessibilityHidden(true)
                    Text(provider).font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                }
            }
            content(ink: Palette.ink)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// `drawn`: the files already drawn as pills above.
    private func content(ink: ThemeRole, drawn: Set<String> = []) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if !message.text.isEmpty {
                MarkdownText(text: message.text).equatable().foregroundStyle(ink)
            }
            // A user's photo its computer keeps is drawn above; any other photo is named, and so is a file, with a
            // document symbol (ADR-0131). Only the four photo types are photos: an SVG or a HEIC is a file here.
            ForEach((message.attachments ?? []).filter { (message.role != "user" || !$0.hasPreview) && !drawn.contains($0.id) }) { attachment in
                Label("\(attachment.name) (open on the desktop)", systemImage: attachment.mimeType.map { PhotoLimits.mimeTypes.contains($0) } == false ? "doc" : "photo")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted)
            }
        }
    }
}

// MARK: Markdown

/// A message as blocks (headings, lists, code, quotes, paragraphs), each with its inline Markdown, as the desktop
/// draws it. A stray backtick can't reach past its own block, and a key chord such as Ctrl+` reads as a key.
/// Drawn again only when its words change; a message streaming in draws again only the blocks its new words changed.
struct MarkdownText: View, Equatable {
    let text: String
    @Environment(\.sottoDensity) private var density
    static func == (a: Self, b: Self) -> Bool { a.text == b.text }
    var body: some View {
        let blocks = SottoCore.Markdown.cachedBlocks(text)
        VStack(alignment: .leading, spacing: Space.dense(Space.s3, density)) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block, first: index == 0).equatable()
            }
        }
    }
}

private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownBlock
    let first: Bool
    static func == (a: Self, b: Self) -> Bool { a.first == b.first && a.block == b.block }
    @Environment(\.sottoTheme) private var theme
    @Environment(\.sottoDensity) private var density
    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(InlineStyle.render(text, theme: theme))
                .font(.sotto(level <= 2 ? .lead : .body, .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, first ? 0 : Space.dense(Space.s2, density))
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(InlineStyle.render(text, theme: theme))
                .font(.sotto(.body))
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        case .list(let items):
            MarkdownListView(items: items)
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .quote(let text):
            Text(InlineStyle.render(text, theme: theme))
                .font(.sotto(.body))
                .foregroundStyle(Palette.muted)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .padding(.leading, Space.s3)
                .overlay(alignment: .leading) { Capsule().fill(Palette.border).frame(width: 3) }
        case .rule:
            Rectangle().fill(Palette.hairline).frame(height: 1).padding(.vertical, Space.s1)
        case .table(let table):
            MarkdownTableView(table: table)
        }
    }
}

/// A table on the code surface: a grid when its columns fit the message's width, and one card per row when they
/// don't, with the first column as the card's title and every other column a label and its value (#902). Nothing
/// scrolls sideways. A column its separator row sets trailing keeps its numbers at the trailing edge.
private struct MarkdownTableView: View {
    let table: MarkdownTable
    @Environment(\.sottoTheme) private var theme
    @Environment(\.sottoDensity) private var density
    /// The widest a grid cell's words run before they wrap, so the grid's width says whether it fits.
    @ScaledMetric(relativeTo: .footnote) private var cellWidth: CGFloat = 180
    /// The widest a card's labels run before they wrap, leaving the rest of the row to the value.
    @ScaledMetric(relativeTo: .footnote) private var labelWidth: CGFloat = 140
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        ViewThatFits(in: .horizontal) {
            grid
            cards
        }
        .background(Palette.code, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
    }

    private var columns: Range<Int> { 0..<table.header.count }

    private var grid: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(columns, id: \.self) { column in
                    cell(table.header[column], column: column, header: true)
                }
            }
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                Rectangle().fill(Palette.hairline).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                GridRow {
                    ForEach(columns, id: \.self) { column in
                        cell(row[column], column: column, header: false)
                    }
                }
            }
        }
    }

    /// The first column takes the room the grid has to spare, so the others sit together at the trailing edge.
    private func cell(_ text: MarkdownInline, column: Int, header: Bool) -> some View {
        let layout = table.alignments[column].layout
        return CappedWidth(width: cellWidth) {
            Text(InlineStyle.render(text, theme: theme))
                .font((header ? Font.sotto(.caption, .semibold) : Font.sotto(.small)).monospacedDigit())
                .foregroundStyle(header ? Palette.muted : Palette.ink)
                .multilineTextAlignment(layout.text)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: column == 0 ? .infinity : nil, alignment: layout.frame)
        .padding(.horizontal, Space.s3)
        .padding(.vertical, Space.dense(Space.s2, density))
        .gridColumnAlignment(layout.column)
    }

    @ViewBuilder private var cards: some View {
        if table.rows.isEmpty {
            // A table still being written has only its header so far.
            Text(headerLine)
                .font(.sotto(.caption, .semibold))
                .foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.dense(Space.s3, density))
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) }
                    card(row)
                }
            }
        }
    }

    /// The header cells on one line, each with its inline Markdown.
    private var headerLine: AttributedString {
        var line = AttributedString()
        for (index, cell) in table.header.enumerated() {
            if index > 0 { line.append(AttributedString(" · ")) }
            line.append(InlineStyle.render(cell, theme: theme))
        }
        return line
    }

    /// A card titled by the row's first cell, at the trailing edge when its column is set there.
    private func card(_ row: [MarkdownInline]) -> some View {
        let trailing = table.alignments[0] == .trailing
        return VStack(alignment: .leading, spacing: Space.s2) {
            VStack(alignment: trailing ? .trailing : .leading, spacing: Space.s1) {
                if !table.header[0].source.isEmpty {
                    Text(InlineStyle.render(table.header[0], theme: theme))
                        .font(.sotto(.caption, .semibold))
                        .foregroundStyle(Palette.muted)
                }
                Text(InlineStyle.render(row[0], theme: theme))
                    .font(.sotto(.body, .semibold).monospacedDigit())
                    .multilineTextAlignment(trailing ? .trailing : .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
            if row.count > 1 {
                Grid(alignment: .topLeading, horizontalSpacing: Space.s3, verticalSpacing: Space.s1) {
                    ForEach(1..<row.count, id: \.self) { column in
                        GridRow {
                            CappedWidth(width: labelWidth) {
                                Text(InlineStyle.render(table.header[column], theme: theme))
                                    .foregroundStyle(Palette.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            value(row[column], trailing: table.alignments[column] == .trailing)
                        }
                    }
                }
                .font(.sotto(.small))
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.dense(Space.s3, density))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// A card's value; a centred column reads as leading, since a card has no column to centre it in.
    private func value(_ text: MarkdownInline, trailing: Bool) -> some View {
        Text(InlineStyle.render(text, theme: theme))
            .font(.sotto(.small).monospacedDigit())
            .multilineTextAlignment(trailing ? .trailing : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
    }
}

private extension MarkdownTable.Alignment {
    /// The column's alignment as a grid cell's text, its frame and its grid column each take it.
    var layout: (text: TextAlignment, frame: Alignment, column: HorizontalAlignment) {
        switch self {
        case .leading: return (.leading, .topLeading, .leading)
        case .center: return (.center, .top, .center)
        case .trailing: return (.trailing, .topTrailing, .trailing)
        }
    }
}

/// Offers its one view no more than `width`, so a cell's ideal width is its words on one line or `width`, whichever
/// is less, and longer words wrap at `width`.
private struct CappedWidth: Layout {
    let width: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        return view.sizeThatFits(ProposedViewSize(width: min(proposal.width ?? width, width), height: nil))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// A list with hanging indents: the marker in its own column, muted, and the words aligned after it.
private struct MarkdownListView: View {
    let items: [MarkdownListItem]
    @Environment(\.sottoTheme) private var theme
    @Environment(\.sottoDensity) private var density
    @ScaledMetric(relativeTo: .body) private var digit: CGFloat = 9
    var body: some View {
        let width = markerWidth
        VStack(alignment: .leading, spacing: Space.dense(Space.s2, density)) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                    marker(item.marker, width: width)
                    Text(InlineStyle.render(item.text, theme: theme))
                        .font(.sotto(.body))
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .padding(.leading, CGFloat(item.depth) * (width + Space.s2))
            }
        }
    }
    /// Wide enough for the longest number in the list, so every item's words start at one edge.
    private var markerWidth: CGFloat {
        let widest = items.map { item -> Int in
            if case .number(let number) = item.marker { return String(number).count + 1 }
            return 1
        }.max() ?? 1
        return digit * CGFloat(max(widest, 2))
    }
    @ViewBuilder private func marker(_ marker: MarkdownListItem.Marker, width: CGFloat) -> some View {
        switch marker {
        case .bullet:
            Text("•").font(.sotto(.body, .bold)).foregroundStyle(Palette.muted)
                .frame(width: width, alignment: .center)
                .accessibilityHidden(true)
        case .number(let number):
            Text("\(number).").font(.sotto(.body).monospacedDigit()).foregroundStyle(Palette.muted)
                .frame(width: width, alignment: .trailing)
        }
    }
}

/// Code on the code surface, its language above it and Copy beside that; long lines scroll sideways.
private struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s2) {
                Text(language ?? String(localized: "code", comment: "Label over a code block whose language is not named")).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1)
                Spacer(minLength: Space.s2)
                Button { copy() } label: {
                    (copied ? Text("Copied", comment: "A code block's copy control, just after a press") : Text("Copy", comment: "A code block's copy control"))
                        .font(.sotto(.caption, .semibold))
                        .foregroundStyle(Palette.accentText)
                        .padding(.horizontal, Space.s3)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityLabel(copied ? String(localized: "Copied", comment: "A code block's copy control, just after a press") : String(localized: "Copy this code"))
            }
            .padding(.leading, Space.s3)
            .padding(.trailing, Space.s1)
            Rectangle().fill(Palette.hairline).frame(height: 1)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Palette.codeInk)
                    .lineSpacing(3)
                    .fixedSize()
                    .padding(Space.s3)
                    .textSelection(.enabled)
            }
        }
        .background(Palette.code, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
    }
    private func copy() {
        UIPasteboard.general.string = code
        copied = true
        Task {
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            copied = false
        }
    }
}

/// Styles a block's inline Markdown: code spans in monospace on the code surface, key chords as keys.
private enum InlineStyle {
    static func render(_ inline: MarkdownInline, theme: ThemeSwatch) -> AttributedString {
        let parsed = inline.cachedAttributed()
        guard !inline.keys.isEmpty || inline.source.contains("`") else { return parsed }
        var out = AttributedString()
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            if run.attributes[KeyChordAttribute.self] == true {
                // Narrow spaces either side give the key a little room inside its background.
                var key = AttributedString("\u{202F}")
                key.append(piece)
                key.append(AttributedString("\u{202F}"))
                key.mergeAttributes(keyStyle(theme))
                out.append(key)
            } else if run.inlinePresentationIntent?.contains(.code) == true {
                piece.mergeAttributes(codeStyle(theme))
                out.append(piece)
            } else {
                out.append(piece)
            }
        }
        return out
    }
    private static func codeStyle(_ theme: ThemeSwatch) -> AttributeContainer {
        var style = AttributeContainer()
        style[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = Font.system(.footnote, design: .monospaced)
        style[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = theme.color(.codeInk)
        style[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = theme.color(.code)
        return style
    }
    private static func keyStyle(_ theme: ThemeSwatch) -> AttributeContainer {
        var style = AttributeContainer()
        style[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = Font.figtree(12.5, .footnote, .semibold)
        style[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = theme.color(.ink)
        style[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = theme.color(.raised)
        return style
    }
}

// MARK: - Steps

/// A run of steps between two messages, folded into one line (ADR-0051, October 5 amendment). While the thread works
/// through it, the line shows the working words with a slow light crossing them, and VoiceOver hears the step running
/// now; once it has ended, how many steps it had and how long they took, quietly. A press opens the steps in place
/// under their guide, and another folds them.
private struct FoldedRun: View, Equatable {
    let runID: String
    let steps: [Activity]
    let seconds: TimeInterval?
    let working: Bool
    let open: Bool
    /// The conversation ends on this run, so the line's reach stays inside the page's end.
    let last: Bool
    let toggle: () -> Void
    /// Drawn again only when what it shows changes; a press does the same for its run every time.
    static func == (a: Self, b: Self) -> Bool {
        a.runID == b.runID && a.steps == b.steps && a.seconds == b.seconds && a.working == b.working && a.open == b.open
            && a.last == b.last
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                if working {
                    WorkingLine(open: open)
                } else {
                    summaryLine
                }
            }
            .buttonStyle(FoldLineStyle())
            .accessibilityLabel(StepRun.press(count: steps.count, open: open))
            .accessibilityValue(spoken)
            .accessibilityAddTraits(open ? .isSelected : [])
            .accessibilityIdentifier("steps-run-\(runID)")
            if open {
                StepTrail(steps: steps)
                    .padding(.top, working ? Space.s2 : Space.s1)
                    .padding(.bottom, Space.s3 + Space.s1)
                    .transition(trailTransition)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The line is 44 points tall for the finger; its words sit closer to the messages than that.
        .padding(.top, -Space.s3)
        .padding(.bottom, last ? 0 : -Space.s3)
    }

    /// What the line says to VoiceOver: "Working: Running npm test, 12 steps so far", or "14 steps, 1 minute 32 seconds".
    private var spoken: String {
        guard working else { return StepRun.spokenSummary(count: steps.count, seconds: seconds) }
        return StepRun.spokenWorking(StepRun.now(steps), count: steps.count)
    }

    /// "14 steps · 1m 32s", muted, and in ink while its steps are open.
    private var summaryLine: some View {
        HStack(spacing: Space.s2) {
            Text(StepRun.summary(count: steps.count, seconds: seconds))
                .font(.sotto(.small, .semibold).monospacedDigit())
                .foregroundStyle(open ? Palette.ink : Palette.muted)
                .lineLimit(1)
            FoldChevron(open: open)
        }
    }

    /// The steps spring open from under the line; under Reduce Motion they fade in.
    private var trailTransition: AnyTransition {
        if reduceMotion { return .opacity }
        return AnyTransition.opacity
            .combined(with: .scale(scale: 0.97, anchor: .topLeading))
            .combined(with: .offset(y: -8))
    }
}

/// The working run's line: the working words in the muted ink with a slow band of the accent light crossing them, then
/// the chevron. The words and the light run in UIKit and Core Animation, so nothing here is drawn again while they
/// change or move. Under Reduce Motion a still accent light stands before the words, and they change without the fade.
private struct WorkingLine: View {
    let open: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sottoTheme) private var theme
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: Space.s2) {
            if still {
                Light(tone: .accent, size: 7, breathing: false)
                    .frame(width: 16, height: 16)
            }
            GlowingWords(ink: theme.rgb(.muted), light: theme.rgb(.accentText), typeSize: typeSize, still: still)
                .accessibilityHidden(true)
            FoldChevron(open: open)
        }
    }

    private var still: Bool { reduceMotion || DebugFlags.still }
}

/// The working words as UIKit draws them, so a new word or a pass of the light never asks SwiftUI to redraw.
private struct GlowingWords: UIViewRepresentable {
    let ink: ThemeRGB
    let light: ThemeRGB
    let typeSize: DynamicTypeSize
    let still: Bool
    func makeUIView(context: Context) -> GlowWordsView { GlowWordsView(frame: .zero) }
    func updateUIView(_ view: GlowWordsView, context: Context) {
        view.paint(ink: ink, light: light)
        view.scale(to: typeSize)
        view.still = still
        view.running = !still
    }
}

/// Two labels with the same word in Figtree semibold at the small step: the lower in the muted ink, the upper in the
/// accent text colour, seen only through a soft band that its mask sweeps across the words. The band peaks in its
/// middle and spans 0.72 of the words' width; it crosses from half the words' width before them to half past them in
/// 72% of a 4.2 second cycle, easing in and out, and rests off the words for the rest, as the prototype's
/// `words-glow` does. It is laid out in the mask's unit space, so a new word of another width never restarts it. The
/// word changes on a timer of its own every 3.8 seconds, fading in over 0.22 seconds unless `still`.
final class GlowWordsView: LoopingView {
    private let ink = UILabel()
    private let lit = UILabel()
    private let band = CAGradientLayer()
    private var word = 0
    private var timer: Timer?
    /// No moving light and no fade, for Reduce Motion.
    var still = false {
        didSet { if still != oldValue { lit.isHidden = still } }
    }

    /// The band's middle, as a fraction of the words' width, where a pass starts and ends.
    private static let from: CGFloat = -0.5
    private static let to: CGFloat = 1.5
    /// Half the band's width, as a fraction of the words' width.
    private static let reach: CGFloat = 0.36

    override init(frame: CGRect) {
        super.init(frame: frame)
        for label in [ink, lit] {
            label.text = WorkingWords.all[0]
            label.numberOfLines = 1
            label.lineBreakMode = .byTruncatingTail
            label.backgroundColor = .clear
            stage.addSubview(label)
        }
        band.colors = [UIColor.clear.cgColor, UIColor.white.cgColor, UIColor.clear.cgColor]
        band.locations = [NSNumber(value: 0.0), NSNumber(value: 0.5), NSNumber(value: 1.0)]
        // At rest the band waits off the words' leading edge, so the accent shows only while a pass crosses them.
        band.startPoint = CGPoint(x: Self.from - Self.reach, y: 0.5)
        band.endPoint = CGPoint(x: Self.from + Self.reach, y: 0.5)
        lit.layer.mask = band
        setContentHuggingPriority(.required, for: .horizontal)
        setContentHuggingPriority(.required, for: .vertical)
        // A long word at the largest text sizes ends in an ellipsis rather than pushing the chevron off the line.
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        scale(to: .large)
    }
    required init?(coder: NSCoder) { fatalError("GlowWordsView is made in code") }

    override var intrinsicContentSize: CGSize {
        let size = ink.intrinsicContentSize
        return CGSize(width: ceil(size.width), height: ceil(size.height))
    }

    private var painted: (ThemeRGB, ThemeRGB)?
    func paint(ink inkColor: ThemeRGB, light: ThemeRGB) {
        // A label given its colour again, even the same one, is drawn again; the view around it redraws far more often.
        if let painted, painted == (inkColor, light) { return }
        painted = (inkColor, light)
        ink.textColor = inkColor.uiColor(1)
        lit.textColor = light.uiColor(1)
    }

    private var scaledFor: DynamicTypeSize?
    /// Figtree semibold at the small step, scaled with the footnote style as `Font.sotto(.small, .semibold)` is, for
    /// the text size in effect here (the iPhone's own, moved by this app's text size step).
    func scale(to typeSize: DynamicTypeSize) {
        guard typeSize != scaledFor else { return }
        scaledFor = typeSize
        let size = TextScale.small.size
        let face = UIFont(name: "Figtree-SemiBold", size: size) ?? UIFont.systemFont(ofSize: size, weight: .semibold)
        let traits = UITraitCollection(preferredContentSizeCategory: Self.category(typeSize))
        let font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: face, compatibleWith: traits)
        ink.font = font
        lit.font = font
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }

    private static func category(_ size: DynamicTypeSize) -> UIContentSizeCategory {
        switch size {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        default: return .large
        }
    }

    override func layoutStage() {
        ink.frame = stage.bounds
        lit.frame = stage.bounds
        band.frame = lit.bounds
    }

    override var loopLayer: CALayer { band }
    override func makeLoops() -> [String: CAAnimation] {
        [
            "glow-start": Self.pass("startPoint", by: -Self.reach),
            "glow-end": Self.pass("endPoint", by: Self.reach)
        ]
    }

    /// One edge of the band crossing the words and resting past them. The two edges start together, so they move as one.
    private static func pass(_ keyPath: String, by offset: CGFloat) -> CAKeyframeAnimation {
        let start = NSValue(cgPoint: CGPoint(x: from + offset, y: 0.5))
        let end = NSValue(cgPoint: CGPoint(x: to + offset, y: 0.5))
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = [start, end, end]
        animation.keyTimes = [NSNumber(value: 0.0), NSNumber(value: 0.72), NSNumber(value: 1.0)]
        animation.timingFunctions = [CAMediaTimingFunction(controlPoints: 0.45, 0, 0.55, 1), CAMediaTimingFunction(name: .linear)]
        animation.duration = 4.2
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        return animation
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            timer?.invalidate()
            timer = nil
        } else if timer == nil {
            // The timer holds this view until it leaves the window, where it stops.
            let next = Timer(timeInterval: WorkingWords.seconds, target: self, selector: #selector(nextWord), userInfo: nil, repeats: true)
            next.tolerance = 0.2
            RunLoop.main.add(next, forMode: .common)
            timer = next
        }
    }

    @objc private func nextWord() {
        word = WorkingWords.next(after: word)
        let text = WorkingWords.all[word]
        ink.text = text
        lit.text = text
        invalidateIntrinsicContentSize()
        setNeedsLayout()
        guard !still else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = NSNumber(value: 0.0)
        fade.toValue = NSNumber(value: 1.0)
        fade.duration = WorkingWords.fade
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        stage.layer.add(fade, forKey: "word-fade")
    }
}

/// The small chevron at the end of a folded line, turned down while its steps are open.
private struct FoldChevron: View {
    let open: Bool
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Palette.muted)
            .rotationEffect(.degrees(open ? 90 : 0))
            .accessibilityHidden(true)
    }
}

/// A folded line's press: 44 points tall, with a soft highlight that reaches a little past its words on both sides.
private struct FoldLineStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return configuration.label
            .padding(.horizontal, Space.s2)
            .frame(minHeight: 44)
            .background(shape.fill(configuration.isPressed ? Palette.fillSofter : ThemeRole.clear))
            .contentShape(shape)
            .padding(.horizontal, -Space.s2)
    }
}

/// A run of steps between two messages: small muted lines under a faint guide, quieter than the messages.
private struct StepTrail: View {
    let steps: [Activity]
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(steps) { record in
                StepLine(record: record)
            }
        }
        .padding(.vertical, 2)
        .padding(.leading, Space.s4)
        .overlay(alignment: .leading) {
            Capsule().fill(theme.color(.ink).opacity(0.14)).frame(width: 1.5).padding(.vertical, 7)
        }
        .padding(.leading, Space.s2)
        .padding(.vertical, -Space.s1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Steps")
    }
}

/// One step: what kind it is, what it did, the file or command in monospace, and how long it took. The running step
/// has a spinner and its time ticks.
private struct StepLine: View {
    let record: Activity
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 7) {
            mark.frame(width: 16, height: 16)
            Text(verbatim: record.title)
                .font(.sotto(.caption, .semibold))
                .foregroundStyle(verbStyle)
                .lineLimit(1)
                .layoutPriority(1)
            if let subject {
                Text(subject)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: Space.s2)
            meta
        }
        .frame(minHeight: 26)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("step-\(record.id)")
    }

    private var running: Bool { record.status == "running" }

    @ViewBuilder private var mark: some View {
        if running {
            if reduceMotion {
                Light(tone: .accent, size: 6)
            } else {
                ProgressView().controlSize(.mini).tint(Palette.accentText).accessibilityHidden(true)
            }
        } else {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(iconStyle)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder private var meta: some View {
        if running, let since = Words.date(record.startedAt) {
            ElapsedText(since: since)
                .font(.sotto(.caption).monospacedDigit())
                .foregroundStyle(Palette.accentText)
                .lineLimit(1)
        } else if let words = metaWords {
            Text(words)
                .font(.sotto(.caption).monospacedDigit())
                .foregroundStyle(record.status == "failed" ? Palette.dangerText : Palette.muted)
                .lineLimit(1)
        }
    }

    private var metaWords: String? {
        if record.status == "failed" { return record.exitCode.map { code in String(localized: "Failed (\(String(code)))", comment: "A step's outcome; %@ is the exit code it failed with, as the command gave it") } ?? String(localized: "Failed", comment: "A step's outcome") }
        if record.status == "interrupted" { return String(localized: "Stopped", comment: "A step's outcome: it was interrupted") }
        return Words.duration(record.durationMs)
    }

    /// The command it ran, or the file it changed by name.
    private var subject: String? {
        if let command = record.command?.trimmingCharacters(in: .whitespacesAndNewlines), !command.isEmpty {
            return command == record.title ? nil : command
        }
        guard let changes = record.changes, let first = changes.first else { return nil }
        let name = first.path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map { String($0) } ?? first.path
        guard changes.count > 1 else { return name }
        let others = changes.count - 1
        let more = others == 1
            ? String(localized: "1 more", comment: "How many other files a step changed, after the first file's name")
            : String(localized: "\(others) more", comment: "How many other files a step changed, after the first file's name")
        return String(localized: "\(Interface.isolated(name)) and \(more)", comment: "The first %@ is the name of a file a step changed, the second how many more it changed, such as “2 more”")
    }

    private var icon: String {
        switch record.kind {
        case "command": return "terminal"
        case "file-change": return "pencil"
        case "tool": return "wrench.and.screwdriver"
        case "reasoning": return "sparkles"
        case "plan": return "checklist"
        case "subagent": return "person.2"
        case "compaction": return "arrow.down.right.and.arrow.up.left"
        default: return "info.circle"
        }
    }

    private var verbStyle: ThemeRole {
        if running { return Palette.accentText }
        if record.status == "failed" { return Palette.dangerText }
        if record.kind == "reasoning" { return Palette.muted }
        return Palette.ink
    }

    private var iconStyle: ThemeRole {
        if record.status == "failed" { return Palette.dangerText }
        if record.kind == "file-change" { return Palette.accentText }
        return Palette.muted
    }
}

// MARK: - Unconfirmed and failed replies

/// A reply, answer or stop on its way to the thread's computer, or one it hasn't confirmed. While the computer
/// hasn't answered, or says it is still carrying it out, it reads as sending and asks nothing of the user.
/// Only one it couldn't confirm is marked, with what to do. It is never sent again on its own.
private struct UnconfirmedRow: View {
    @EnvironmentObject var model: AppModel
    let item: PendingOperation
    let text: String?
    let photos: [DraftPhoto]
    let files: [DraftFile]
    let sending: Bool
    let dismiss: () -> Void
    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ForEach(photos) { photo in
                if let thumbnail = photo.prepared?.thumbnail {
                    Image(decorative: thumbnail, scale: 1).resizable().scaledToFit().frame(maxWidth: 220, maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous)).opacity(0.6).padding(.leading, 48)
                }
            }
            ForEach(files) { file in
                FilePill(name: file.name, sizeBytes: file.sizeBytes).opacity(0.6).padding(.leading, 48)
            }
            if let text, !text.isEmpty {
                Text(verbatim: text).font(.sotto(.body)).foregroundStyle(Palette.bubbleInk)
                    .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
                    .background(Palette.bubble.opacity(0.6), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .padding(.leading, 48)
            }
            if sending {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(words.sending)
                }
                .font(.sotto(.caption)).foregroundStyle(Palette.muted)
                .accessibilityElement(children: .combine)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                    Text(words.unconfirmed).fixedSize(horizontal: false, vertical: true).paragraphDirection()
                }
                .font(.sotto(.small)).foregroundStyle(Palette.warningText)
                HStack(spacing: Space.s2) {
                    Button("I checked", action: dismiss).buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                    Button("Check again") { Task { await model.checkDelivery(item.hostID) } }
                        .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                        .disabled(!model.online(item.hostID))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    /// What the row says for its kind: on its way, and unconfirmed.
    private var words: (sending: String, unconfirmed: String) {
        switch item.kind {
        case "answer", "watcher-answer": return (String(localized: "Sending your answer…"), String(localized: "Your answer isn’t confirmed. Check the thread before you answer again."))
        case "interrupt": return (String(localized: "Stopping…", comment: "A stop on its way to the thread's computer"), String(localized: "Stop isn’t confirmed. Check whether the thread is still working."))
        case "queue": return (String(localized: "Queuing…", comment: "A reply on its way to the thread's queue"), String(localized: "Queuing isn’t confirmed. Check the thread’s queue before you send it again."))
        case "steer": return (String(localized: "Steering…", comment: "A queued message being sent into the running turn"), String(localized: "Steer isn’t confirmed. Check the thread before you steer again."))
        case "remove": return (String(localized: "Removing…", comment: "A queued message being taken out of the queue"), String(localized: "Removing isn’t confirmed. Check the thread’s queue before you remove it again."))
        case "compact": return (String(localized: "Compacting…", comment: "A request to compact the thread's context on its way"), String(localized: "Compacting isn’t confirmed. Check the thread before you compact it again."))
        case "settle": return (String(localized: "Settling…", comment: "A request to settle the thread on its way"), String(localized: "Settling isn’t confirmed. Check the thread before you settle it again."))
        case "restore": return (String(localized: "Restoring…", comment: "A request to take the thread off the Settled shelf on its way"), String(localized: "Restoring isn’t confirmed. Check the thread before you restore it again."))
        case "babysit": return (String(localized: "Starting babysitting…", comment: "A request to babysit a pull request on its way"), String(localized: "Babysitting isn’t confirmed. Check the pull request before you press it again."))
        case "stop-babysitting": return (String(localized: "Stopping babysitting…", comment: "A request to stop babysitting a pull request on its way"), String(localized: "Stopping babysitting isn’t confirmed. Check the pull request before you press it again."))
        default: return (String(localized: "Sending…", comment: "A reply on its way to the thread's computer"), String(localized: "Not confirmed. Check the thread before you send it again."))
        }
    }
}

/// A reply the computer refused, with a way to put it back in the reply box.
private struct FailedReplyCard: View {
    @EnvironmentObject var model: AppModel
    /// Watched so Put it back follows what the reply box holds; typing publishes here, not on the model.
    @EnvironmentObject var draftStore: DraftStore
    let ref: ThreadRef
    let text: String
    var body: some View {
        let photos = model.failedPhotos[ref.id] ?? [], files = model.failedFiles[ref.id] ?? []
        VStack(alignment: .leading, spacing: Space.s3) {
            Text("Your reply wasn’t sent").font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
            if !text.isEmpty {
                Text(verbatim: text).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
            }
            if !photos.isEmpty || !files.isEmpty {
                Text(Self.carried(photos: photos.count, files: files.count)).font(.sotto(.small)).foregroundStyle(Palette.muted)
            }
            Button("Put it back in the reply box") { model.restoreReply(ref) }
                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                .disabled(!(model.drafts[ref.id] ?? "").isEmpty || !model.photos(ref).isEmpty || !model.files(ref).isEmpty)
        }
        .card()
    }
    /// What went with the reply: "With 2 photos", "With 1 file", "With 2 photos and 1 file".
    private static func carried(photos: Int, files: Int) -> String {
        if files == 0 { return photos == 1 ? String(localized: "With 1 photo") : String(localized: "With \(photos) photos") }
        if photos == 0 { return files == 1 ? String(localized: "With 1 file") : String(localized: "With \(files) files") }
        let photoWords = photos == 1 ? String(localized: "1 photo") : String(localized: "\(photos) photos")
        let fileWords = files == 1 ? String(localized: "1 file") : String(localized: "\(files) files")
        return String(localized: "With \(photoWords) and \(fileWords)",
                      comment: "What went with a reply that wasn't sent; the first %@ counts its photos, such as 2 photos, the second its files, such as 1 file")
    }
}

// MARK: - Reply box

/// The reply box in glass over the bottom of the page, with what the computer or the thread needs said above it.
/// While a request waits, the box offers it instead of the field.
private struct ReplyDock: View, Equatable {
    @EnvironmentObject var model: AppModel
    /// The reply box's words, watched here alone: a keystroke redraws the reply box and nothing else.
    @EnvironmentObject var draftStore: DraftStore
    let ref: ThreadRef
    let openRequest: (AgentRequest) -> Void
    /// Drawn again for what it watches itself, not for each new revision of the conversation above it; a request it
    /// offers opens the same way every time.
    static func == (a: Self, b: Self) -> Bool { a.ref == b.ref }
    @FocusState private var focused: Bool
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sent = 0
    @State private var stopped = 0

    var body: some View {
        VStack(spacing: Space.s2) {
            ComputerBanner(ref: ref)
            if let problem = model.detailProblem, model.online(ref.hostID) {
                problemNote(problem)
            }
            FollowupStack(ref: ref)
            // What a Watch press just did, with Undo, in place of what watching means here.
            if model.watchNotice?.target == ref { WatchToast(scope: ref) }
            else if let line = model.watchedLine(ref) { watchedLine(line) }
            dock
        }
        .padding(.horizontal, Space.s3)
        .padding(.top, Space.s2)
        .padding(.bottom, Space.s2)
    }

    /// What watching means here: Watcher keeps the thread going, and only steers while the user's own turn runs; or, on a
    /// computer that keeps no standing watches, that a direct instruction here takes the thread over from Watcher.
    /// Opening the thread or answering its card changes neither.
    private func watchedLine(_ words: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            WatcherOwlMark(size: 13).accessibilityHidden(true)
            Text(words).fixedSize(horizontal: false, vertical: true).paragraphDirection()
        }
        .font(.sotto(.small))
        .foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s2)
        .glass(in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("watched-takeover")
    }

    private func problemNote(_ problem: String) -> some View {
        HStack(spacing: Space.s3) {
            Text(problem).font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true).paragraphDirection()
            Spacer(minLength: Space.s2)
            Button("Try again") { Task { await model.select(ref) } }
                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
        }
        .padding(.leading, Space.s4)
        .padding(.trailing, Space.s2)
        .padding(.vertical, Space.s2)
        .glass(in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
    }

    @ViewBuilder private var dock: some View {
        let requests = model.thread(ref)?.requests ?? []
        if let request = requests.first {
            requestButton(request, requests)
                .padding(6)
                .glass(in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .softShadow(RoundedRectangle(cornerRadius: 26, style: .continuous), color: Color.black.opacity(0.22), radius: 16, y: 8)
        } else {
            replyField
        }
    }

    @ViewBuilder private func requestButton(_ request: AgentRequest, _ requests: [AgentRequest]) -> some View {
        if requests.count > 1 {
            Menu {
                ForEach(requests) { pending in
                    Button(pending.questions?.first?.question ?? pending.text) { openRequest(pending) }
                }
            } label: {
                Label("Review \(requests.count) requests", systemImage: "questionmark.bubble")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(ActionStyle(wide: true))
            .accessibilityIdentifier("thread-requests")
        } else {
            let permission = request.kind == "permission"
            Button { openRequest(request) } label: {
                Label(permission ? String(localized: "Review the permission") : String(localized: "Answer the question"), systemImage: permission ? "lock.shield" : "questionmark.bubble")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ActionStyle(wide: true))
        }
    }

    private var draft: Binding<String> {
        Binding(get: { model.drafts[ref.id] ?? "" }, set: { model.drafts[ref.id] = $0 })
    }

    private var replyField: some View {
        let photos = model.photos(ref), files = model.files(ref)
        let shape = RoundedRectangle(cornerRadius: photos.isEmpty && files.isEmpty ? 26 : 22, style: .continuous)
        let placeholder = model.thread(ref)?.status == "running" ? String(localized: "Reply while it works") : String(localized: "Reply to this thread")
        return HStack(alignment: .bottom, spacing: Space.s2) {
            AttachPhotosButton(box: .thread(ref))
            // Photos wait inside the reply box, above the words, as in Messages, and files under them as pills.
            VStack(alignment: .leading, spacing: Space.s2) {
                if !photos.isEmpty { DraftPhotoStrip(box: .thread(ref)).padding(.top, Space.s1) }
                if !files.isEmpty { DraftFilePills(ref: ref).padding(.top, photos.isEmpty ? Space.s1 : 0) }
                if let notice = model.photoNotices[ref.id] {
                    Text(notice).font(.sotto(.small)).foregroundStyle(Palette.dangerText).fixedSize(horizontal: false, vertical: true).paragraphDirection()
                        .accessibilityAddTraits(.updatesFrequently)
                }
                TextField("Reply", text: draft, prompt: Text(placeholder).foregroundStyle(Palette.placeholder), axis: .vertical)
                    .font(.sotto(.body))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.vertical, 11)
                    .accessibilityLabel("Reply to this thread")
                    .accessibilityIdentifier("thread-reply")
                    // Locked while the reply's photos are staged, so nothing typed now joins it.
                    .disabled(model.preparingSends.contains(ref.id))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailingButtons
        }
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: model.canInterrupt(ref))
        .padding(6)
        .glass(in: shape)
        .overlay(shape.strokeBorder(theme.color(.accent).opacity(focused ? 0.55 : 0), lineWidth: 1))
        // Two shadows drawn once each and crossfaded, rather than one live shadow redrawn as the conversation moves under it.
        .background {
            ZStack {
                SoftShadow(shape: shape, color: Color.black.opacity(0.22), radius: 16, y: 8).opacity(focused ? 0 : 1)
                SoftShadow(shape: shape, color: theme.color(.accent).opacity(0.35), radius: 18).opacity(focused ? 1 : 0)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.4), value: focused)
    }

    /// Stop while the turn can be stopped, and beside it, once the box holds something, the button that queues it for
    /// after the turn. Otherwise Send, as before.
    @ViewBuilder private var trailingButtons: some View {
        let stops = model.canInterrupt(ref)
        let written = !(model.drafts[ref.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.photos(ref).isEmpty
            || !model.files(ref).isEmpty
        if stops { stopButton.transition(.scale(scale: 0.8).combined(with: .opacity)) }
        if !stops || written { sendButton.transition(.scale(scale: 0.8).combined(with: .opacity)) }
    }

    private var stopButton: some View {
        Button { stopped += 1; Task { await model.interrupt(ref) } } label: {
            RoundedRectangle(cornerRadius: 3.5, style: .continuous)
                .frame(width: 13, height: 13)
                .frame(width: 44, height: 44)
                .foregroundStyle(Palette.ink)
                .background(Palette.fillSoft, in: Circle())
                .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(PressStyle())
        .sensoryFeedback(.impact(weight: .medium), trigger: stopped)
        .accessibilityLabel("Stop this turn")
    }

    /// Sends the reply now, or while the thread works, queues it to go when the turn ends.
    private var sendButton: some View {
        let preparing = model.preparingSends.contains(ref.id)
        let canSend = model.canSendReply(ref)
        let queues = model.queuesReply(ref)
        return Button { sent += 1; Task { await model.send(ref) } } label: {
            Group {
                if preparing { ProgressView().tint(Palette.onAccent) }
                else { Image(systemName: queues ? "text.badge.plus" : "arrow.up").font(.system(size: 17, weight: .semibold)) }
            }
            .frame(width: 44, height: 44)
            .foregroundStyle(canSend || preparing ? Palette.onAccent : Palette.muted)
            .background(canSend || preparing ? Palette.accent : Palette.fillSoft, in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(PressStyle())
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: canSend)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: queues)
        .sensoryFeedback(.impact(flexibility: .soft), trigger: sent)
        .disabled(!canSend)
        .accessibilityLabel(queues ? (preparing ? String(localized: "Queuing reply") : String(localized: "Queue for after this turn")) : (preparing ? String(localized: "Sending reply") : String(localized: "Send reply")))
    }
}

/// The thread's queued messages over the reply box, in order: two, and a press on the count of the rest shows them all.
private struct FollowupStack: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    @State private var all = false
    var body: some View {
        let items = model.followups(ref)
        if !items.isEmpty {
            let hidden = items.count - FollowupQueue.shownCards
            VStack(alignment: .leading, spacing: Space.s2) {
                ForEach(Array(all ? items[...] : items.prefix(FollowupQueue.shownCards))) { item in
                    FollowupCard(ref: ref, item: item)
                }
                if hidden > 0 {
                    Button(all ? String(localized: "Show fewer", comment: "Shows only the first queued messages again") : (hidden == 1 ? String(localized: "1 more queued", comment: "Shows the rest of the queued messages") : String(localized: "\(hidden) more queued", comment: "Shows the rest of the queued messages"))) { all.toggle() }
                        .font(.sotto(.small, .semibold))
                        .foregroundStyle(Palette.accentText)
                        .frame(minHeight: 44)
                        .padding(.horizontal, Space.s4)
                        .accessibilityLabel(all ? String(localized: "Show fewer queued messages") : (hidden == 1 ? String(localized: "Show 1 more queued message") : String(localized: "Show \(hidden) more queued messages")))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// One queued message: where it stands, its words on one line, and what can be done with it. Steer now sends it at once
/// instead of after the running turn, where the provider takes that; Remove takes it out unsent. Neither answers
/// anything for the user, and neither is sent again on its own.
private struct FollowupCard: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let item: Followup
    @State private var steerPresses = 0
    @State private var removePresses = 0
    var body: some View {
        let steers = model.steerOffered(item, in: ref)
        let removable = FollowupQueue.removable(item)
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: 6) {
                Image(systemName: symbol).accessibilityHidden(true)
                Text(FollowupQueue.state(item))
            }
            .font(.sotto(.caption, .semibold))
            .foregroundStyle(tone)
            if item.status == "failed", let error = item.error, !error.isEmpty {
                Text(verbatim: error).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            Text(words)
                .font(.sotto(.body))
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .truncationMode(.tail)
            if steers || removable {
                HStack(spacing: Space.s2) {
                    if steers {
                        Button {
                            steerPresses += 1
                            Task { await model.steer(item, in: ref) }
                        } label: {
                            Label("Steer now", systemImage: "arrow.turn.up.right")
                        }
                        .buttonStyle(PillButtonStyle(kind: .primary))
                        .sensoryFeedback(.impact(flexibility: .soft), trigger: steerPresses)
                        .disabled(!model.canSteer(item, in: ref))
                        .accessibilityHint("Sends this message now instead of after the turn.")
                    }
                    if removable {
                        Button("Remove") {
                            removePresses += 1
                            Task { await model.removeFollowup(item, in: ref) }
                        }
                        .buttonStyle(PillButtonStyle(kind: .ghost))
                        .sensoryFeedback(.impact(flexibility: .soft), trigger: removePresses)
                        .disabled(!model.canRemove(item, in: ref))
                            .accessibilityLabel(item.wakeUp == true ? String(localized: "Remove the wake-up from the queue") : String(localized: "Remove this message from the queue"))
                    }
                }
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass(in: RoundedRectangle(cornerRadius: Radius.lg, style: .continuous))
        .accessibilityElement(children: .contain)
    }
    /// The message on one line, and how many photos go with it.
    private var words: String {
        let photos = item.attachmentCount == 1 ? String(localized: "1 photo") : String(localized: "\(item.attachmentCount) photos")
        let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if item.attachmentCount == 0 { return text }
        return text.isEmpty ? photos : text + " · " + photos
    }
    private var symbol: String {
        switch item.status {
        case "dispatching": return "arrow.up.circle"
        case "uncertain": return "exclamationmark.triangle"
        case "failed": return "exclamationmark.circle"
        case "paused": return "pause.circle"
        default: return "text.badge.plus"
        }
    }
    private var tone: ThemeRole {
        switch item.status {
        case "failed": return Palette.dangerText
        case "uncertain": return Palette.warningText
        default: return Palette.muted
        }
    }
}

// MARK: - Question and permission sheet

/// The whole request: its context and every choice, on glass with a warm wash. Nothing is chosen for the user, and a
/// question is sent only when they press Send answer. It answers the request where it waits: in its own thread, or as a
/// card in Watcher's page (4B), where the answer is still the user's own, to the thread that asked.
struct RequestSheet: View {
    @EnvironmentObject var model: AppModel
    /// Watched so the agent's message, and the links the sheet lifts from it, show when the thread's history arrives
    /// after the sheet opens: the history publishes on its own store, not on the model.
    @EnvironmentObject var detailStore: DetailStore
    /// Watched so a card in Watcher's page that is answered or changes elsewhere shows here: Watcher's page publishes on
    /// its own store.
    @EnvironmentObject var watcherStore: WatcherStore
    @Environment(\.dismiss) var dismiss
    let place: RequestPlace
    let request: AgentRequest
    @State private var answers: [String: QuestionAnswer] = [:]
    @State private var choice: String?
    @State private var text = ""
    @State private var answered = 0
    /// Questions whose own-answer box is open.
    @State private var writing: Set<String> = []
    /// The question's page open in the in-app browser over the sheet (ADR-0085).
    @State private var opening: PageRow?
    @FocusState private var focus: String?
    init(place: RequestPlace, request: AgentRequest) { self.place = place; self.request = request }
    init(ref: ThreadRef, request: AgentRequest) { self.init(place: .thread(ref), request: request) }
    /// The asking thread's title and provider.
    private var owner: (title: String, providerID: String?)? { model.requestOwner(place) }
    private var computer: String { model.name(place.hostID) }
    /// The request as the computer holds it now; nil once it is answered or replaced.
    private var current: AgentRequest? { model.waitingRequest(request.id, at: place) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let current, let owner {
                    content(current, threadTitle: owner.title, providerID: owner.providerID)
                } else {
                    Text("This request was answered or changed.").font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink).paragraphDirection()
                    Button("Close") { dismiss() }.buttonStyle(PillButtonStyle(kind: .soft, wide: true)).padding(.top, Space.s4)
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s5)
            .padding(.bottom, Space.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .presentationBackground { SheetBackdrop(wash: true) }
        .presentationCornerRadius(Radius.xl)
        .onChange(of: current == nil && !model.hasPending(at: place)) { _, gone in if gone { dismiss() } }
        .sheet(item: $opening) { row in SafariPage(url: row.url).ignoresSafeArea() }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: answered)
    }

    @ViewBuilder private func content(_ current: AgentRequest, threadTitle: String, providerID: String?) -> some View {
        let provider = Words.provider(providerID)
        let permission = current.kind == "permission"
        let count = current.questions?.count ?? 0
        let from = Self.from(permission: permission, count: count, provider: provider, threadTitle: threadTitle)
        HStack(spacing: Space.s2) {
            Light(tone: .warning)
            Text(from).font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(2)
        }
        .accessibilityElement(children: .combine)
        // Several questions have no headline: each carries its own, and the text a provider built from them would only
        // repeat them.
        if let headline = title(current, provider) {
            Text(headline)
                .font(.sotto(.title, .semibold))
                .headingTracking(-0.4)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s3)
                .accessibilityAddTraits(.isHeader)
        }
        if !permission, count > 0, let explanation = RequestText.explanation(current) {
            Text(explanation).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s3)
        }
        // The question's pages, then every link in it and in the agent's message the sheet covers, together above its
        // choices. Opening one answers nothing, so they show on an iPhone that can't answer too. A page is served by the
        // computer that runs the asking thread and opens in the browser over the sheet (ADR-0085); a loopback address it
        // already opens has no row of its own.
        if !permission {
            let endpoint = model.pageEndpoint(place.asker.hostID)
            let pages = current.pages.compactMap { page in endpoint.flatMap(page.url(on:)).map { PageRow(page: page, url: $0) } }
            let links = WebLinks.withoutPages(WebLinks.find(in: current, after: model.shown(for: place.asker)?.messages ?? []), current.pages)
            if !pages.isEmpty || !links.isEmpty {
                LinkRows(pages: pages, links: links) { opening = $0 }.padding(.top, Space.s4)
            }
        }
        if let context = current.context {
            if let command = context.command { PermissionCommand(command: command).padding(.top, Space.s5) }
            if let cwd = context.cwd { runsIn(cwd) }
            if let details = context.details {
                Text(details).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
            }
        }
        if permission && current.context?.command == nil {
            Text(verbatim: current.text).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
        }
        if !current.supported {
            note(String(localized: "This request can’t be answered here. Check the thread, or answer it on \(computer).", comment: "%@ is the computer's name"))
            Button("Not now") { dismiss() }.buttonStyle(PillButtonStyle(kind: .soft, wide: true)).padding(.top, Space.s5)
        } else if !model.mayAnswer(at: place) {
            note(String(localized: "This iPhone can’t answer on \(computer) yet. Turn on Can answer for it in Sotto on \(computer), or answer there.", comment: "Both %@ are the computer's name; Can answer is a setting's name in Sotto on the computer"))
            Button("Not now") { dismiss() }.buttonStyle(PillButtonStyle(kind: .soft, wide: true)).padding(.top, Space.s5)
        } else if permission {
            permissionChoices(current)
        } else {
            question(current)
        }
        if let feedback = model.feedback {
            Text(feedback).font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s4)
                .paragraphDirection()
                .accessibilityAddTraits(.updatesFrequently)
        }
    }

    /// Who asks, and in which thread, over the headline.
    private static func from(permission: Bool, count: Int, provider: String, threadTitle: String) -> String {
        if permission {
            return String(localized: "Permission for \(provider) in \(threadTitle)", comment: "The first %@ is the agent's name, the second the thread's title")
        }
        if count > 1 {
            let questions = count == 1
                ? String(localized: "1 question", comment: "How many questions a request asks")
                : String(localized: "\(count) questions", comment: "How many questions a request asks")
            return String(localized: "\(questions) from \(provider) in \(threadTitle)", comment: "The first %@ is how many questions, such as “2 questions”, the second the agent's name, the third the thread's title")
        }
        return String(localized: "Question from \(provider) in \(threadTitle)", comment: "The first %@ is the agent's name, the second the thread's title")
    }

    /// The sheet's headline: what a permission is for, a lone question, or a request's own words when it has no
    /// structured questions. Nil for several questions.
    private func title(_ request: AgentRequest, _ provider: String) -> String? {
        if request.kind == "permission" {
            return request.context?.command != nil
                ? String(localized: "\(provider) wants to run a command", comment: "%@ is the agent's name")
                : String(localized: "\(provider) is asking permission", comment: "%@ is the agent's name")
        }
        if let questions = request.questions, !questions.isEmpty { return questions.count == 1 ? questions[0].question : nil }
        return request.text
    }

    private func note(_ words: String) -> some View {
        Text(words).font(.sotto(.body)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
            .paragraphDirection()
    }

    private func runsIn(_ cwd: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("It runs in", comment: "Starts a sentence split over three lines: “It runs in”, then a folder's path, then “on <computer>.”").font(.sotto(.small)).foregroundStyle(Palette.muted)
            Text(verbatim: cwd).font(.system(.footnote, design: .monospaced)).foregroundStyle(Palette.ink).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text(String(localized: "thread-folder.on-computer", defaultValue: "on \(computer).", comment: "Ends the sentence “It runs in <folder> on <computer>.”, under the folder's path; %@ is the computer's name")).font(.sotto(.small)).foregroundStyle(Palette.muted)
        }
        .padding(.top, Space.s4)
        .accessibilityElement(children: .combine)
    }

    /// The answer this iPhone sent for the request, while its computer hasn't confirmed it.
    @ViewBuilder private func sendingLine(_ current: AgentRequest) -> some View {
        if let marker = model.answerMarker(current.id, at: place) {
            let sending = model.isSending(marker)
            HStack(spacing: Space.s2) {
                if sending { ProgressView().controlSize(.small) }
                (sending ? Text("Sending your answer…") : Text("Not confirmed yet. Check the thread before answering again."))
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .paragraphDirection()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: Permission

    @ViewBuilder private func permissionChoices(_ current: AgentRequest) -> some View {
        let enabled = model.canAnswer(current, at: place)
        VStack(spacing: Space.s2) {
            sendingLine(current)
            Group {
                if let choices = current.permissionChoices {
                    let ordered: [PermissionChoice] = choices.sorted { Self.rank($0) < Self.rank($1) }
                    ForEach(ordered) { option in
                        Button { send(current, choice: option.id) } label: { choiceLabel(option) }
                            .buttonStyle(PillButtonStyle(kind: Self.kind(option), wide: true))
                    }
                } else {
                    Button { send(current, choice: "allow") } label: { Text("Allow").frame(maxWidth: .infinity) }
                        .buttonStyle(PillButtonStyle(kind: .primary, wide: true))
                    Button { send(current, choice: "deny") } label: { Text("Deny").frame(maxWidth: .infinity) }
                        .buttonStyle(PillButtonStyle(kind: .danger, wide: true))
                }
            }
            .disabled(!enabled)
            Button("Not now") { dismiss() }.buttonStyle(PillButtonStyle(kind: .ghost, wide: true))
        }
        .padding(.top, Space.s6)
    }

    /// Sends against the request as the computer holds it now, never the copy the sheet opened with.
    private func send(_ current: AgentRequest, choice: String) {
        answered += 1
        Task { await model.answer(current, at: place, choice: choice) }
    }

    /// Allow once first, then the other allows, then deny and the rest.
    private static func rank(_ choice: PermissionChoice) -> Int {
        if choice.kind == "allow-once" { return 0 }
        return choice.kind.hasPrefix("allow-") ? 1 : 2
    }

    private static func kind(_ choice: PermissionChoice) -> PillKind {
        if choice.kind == "allow-once" { return .primary }
        if choice.kind == "deny" { return .danger }
        return .soft
    }

    private func choiceLabel(_ option: PermissionChoice) -> some View {
        VStack(spacing: 2) {
            Text(verbatim: option.label)
            if let description = option.description { Text(verbatim: description).font(.sotto(.small)).fontWeight(.regular) }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Question

    /// The choices wait while the answer can't be sent; the links above them still open.
    @ViewBuilder private func question(_ current: AgentRequest) -> some View {
        let enabled = model.canAnswer(current, at: place)
        VStack(alignment: .leading, spacing: Space.s5) {
            if let questions = current.questions, !questions.isEmpty {
                ForEach(questions) { item in questionField(item, showsTitle: questions.count > 1, enabled: enabled) }
            } else {
                Group {
                    if !current.options.isEmpty {
                        VStack(spacing: Space.s2) {
                            ForEach(current.options) { option in
                                Button { choice = option.id } label: {
                                    OptionLabel(title: option.label, detail: option.description, chosen: choice == option.id)
                                }
                                .buttonStyle(ChoiceStyle(chosen: choice == option.id))
                                .accessibilityAddTraits(choice == option.id ? .isSelected : [])
                                .accessibilityIdentifier("request-option-\(option.id)")
                            }
                        }
                    } else {
                        answerField(text: $text, id: "answer", label: String(localized: "Your answer"))
                    }
                }
                .disabled(!enabled)
            }
        }
        .padding(.top, Space.s5)
    }

    private func questionField(_ item: Question, showsTitle: Bool, enabled: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if showsTitle {
                Text(verbatim: item.question).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
            }
            if let reason = item.unavailableReason {
                Text(verbatim: reason).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            choices(item).disabled(!enabled)
        }
    }

    /// A question's choices and its own-answer box.
    @ViewBuilder private func choices(_ item: Question) -> some View {
        ForEach(item.options) { option in
            let chosen = answers[item.id]?.optionIds.contains(option.id) == true
            Button { pick(option, in: item, chosen: chosen) } label: {
                OptionLabel(title: option.label, detail: option.description, chosen: chosen, multiple: item.multiSelect)
            }
            .buttonStyle(ChoiceStyle(chosen: chosen))
            .accessibilityAddTraits(chosen ? .isSelected : [])
            .accessibilityIdentifier("request-option-\(option.id)")
            .disabled(item.unavailableReason != nil)
        }
        if item.allowFreeText {
            if item.options.isEmpty {
                ownAnswer(item)
            } else {
                let open = writingOwn(item)
                Button { toggleOwn(item) } label: {
                    OptionLabel(title: String(localized: "Write your own answer"), detail: String(localized: "Say it in your own words."), chosen: open, multiple: item.multiSelect)
                }
                .buttonStyle(ChoiceStyle(chosen: open))
                .accessibilityAddTraits(open ? .isSelected : [])
                .disabled(item.unavailableReason != nil)
                if open { ownAnswer(item) }
            }
        }
    }

    private func pick(_ option: RequestOption, in item: Question, chosen: Bool) {
        var answer = answers[item.id] ?? QuestionAnswer()
        if item.multiSelect {
            if chosen { answer.optionIds.removeAll { $0 == option.id } } else { answer.optionIds.append(option.id) }
        } else {
            answer.optionIds = chosen && item.required == false ? [] : [option.id]
            answer.text = nil
            writing.remove(item.id)
            if focus == item.id { focus = nil }
        }
        answers[item.id] = answer
    }

    private func writingOwn(_ item: Question) -> Bool {
        writing.contains(item.id) || !(answers[item.id]?.text ?? "").isEmpty
    }

    /// Opens the box for the user's own words. For a single choice it takes the place of the option chosen; for
    /// several it sits beside them, and closing it takes its words back out.
    private func toggleOwn(_ item: Question) {
        var answer = answers[item.id] ?? QuestionAnswer()
        if item.multiSelect && writingOwn(item) {
            writing.remove(item.id)
            answer.text = nil
            answers[item.id] = answer
            if focus == item.id { focus = nil }
            return
        }
        writing.insert(item.id)
        if !item.multiSelect {
            answer.optionIds = []
            answers[item.id] = answer
        }
        focus = item.id
    }

    private func ownAnswer(_ item: Question) -> some View {
        answerField(text: Binding(get: { answers[item.id]?.text ?? "" }, set: { value in
            var answer = answers[item.id] ?? QuestionAnswer()
            answer.text = value
            if !item.multiSelect && !value.isEmpty { answer.optionIds = [] }
            answers[item.id] = answer
        }), id: item.id, label: String(localized: "Your own answer to: \(item.question)", comment: "%@ is the question's own words"))
        .disabled(item.unavailableReason != nil)
    }

    private func answerField(text: Binding<String>, id: String, label: String) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        return TextField("Your answer", text: text, prompt: Text("Type your answer").foregroundStyle(Palette.placeholder), axis: .vertical)
            .font(.sotto(.body))
            .foregroundStyle(Palette.ink)
            .lineLimit(3...8)
            .focused($focus, equals: id)
            .padding(Space.s3)
            .frame(maxWidth: .infinity, minHeight: 76, alignment: .topLeading)
            .background(Palette.code, in: shape)
            .overlay(shape.strokeBorder(focus == id ? Palette.accent.opacity(0.6) : Palette.hairline, lineWidth: 1))
            .accessibilityLabel(label)
    }

    private func ready(_ request: AgentRequest) -> Bool {
        if let questions = request.questions, !questions.isEmpty {
            return questions.allSatisfy { q in
                // A required question this iPhone can't answer blocks sending; its reason says why.
                if q.unavailableReason != nil { return q.required == false }
                let chosen = !(answers[q.id]?.optionIds.isEmpty ?? true)
                let written = !(answers[q.id]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                return q.required == false || chosen || written
            }
        }
        if !request.options.isEmpty { return choice != nil }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func sendAnswer(_ current: AgentRequest) {
        answered += 1
        focus = nil
        Task {
            if current.questions?.isEmpty == false { await model.answer(current, at: place, answers: answers) }
            else if !current.options.isEmpty { await model.answer(current, at: place, choice: choice) }
            else { await model.answer(current, at: place, text: text) }
        }
    }

    /// Not now and Send answer stay in reach under a question, whatever its length.
    @ViewBuilder private var footer: some View {
        if let current, current.kind != "permission", current.supported, model.mayAnswer(at: place) {
            VStack(spacing: Space.s2) {
                sendingLine(current)
                HStack(spacing: Space.s2) {
                    Button("Not now") { dismiss() }.buttonStyle(PillButtonStyle(kind: .soft, wide: true))
                    Button("Send answer") { sendAnswer(current) }
                        .buttonStyle(PillButtonStyle(kind: .primary, wide: true))
                        .disabled(!model.canAnswer(current, at: place) || !ready(current))
                        .accessibilityIdentifier("request-send-answer")
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s3)
            .padding(.bottom, Space.s2)
            .background { SheetBackdrop(wash: false) }
            .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
        }
    }
}

/// The web links in a question, each a row of its own above the choices: a tap opens the page in Safari and never picks
/// a choice. The question's own words stay as the agent wrote them.
/// One of a question's pages and where it opens on the computer that runs the thread (ADR-0085).
private struct PageRow: Identifiable {
    let page: RequestPage
    let url: URL
    var id: String { page.token }
}

/// The question's pages and links, a row each. A page opens in the browser over the sheet; a link opens in Safari.
private struct LinkRows: View {
    let pages: [PageRow]
    let links: [URL]
    let openPage: (PageRow) -> Void
    @Environment(\.openURL) private var openURL
    var body: some View {
        VStack(spacing: Space.s2) {
            ForEach(pages) { row in
                Button { openPage(row) } label: { label(icon: "macwindow", title: String(localized: "Open the prototype"), place: row.page.name) }
                    .buttonStyle(PressStyle())
                    .accessibilityLabel("Open the prototype, \(row.page.name)")
            }
            ForEach(links, id: \.absoluteString) { url in
                Button { openURL(url) } label: { label(icon: "link", title: String(localized: "Open the link"), place: WebLinks.place(url)) }
                    .buttonStyle(PressStyle())
                    .accessibilityLabel("Open the link, \(url.host ?? WebLinks.place(url))")
            }
        }
    }
    private func label(icon: String, title: String, place: String) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        return HStack(spacing: Space.s3) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.accentText)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                Text(verbatim: place)
                    .font(.sotto(.small))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right.square")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s3)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .background(Palette.fillSofter, in: shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
        .contentShape(shape)
    }
}

/// Safari's own in-app browser, for a question's page (ADR-0085). It shares nothing with Sotto's connection: the page's
/// token is all it needs, over the tailnet the phone is already on. Done closes it and leaves the question as it was.
private struct SafariPage: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.dismissButtonStyle = .done
        return controller
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// A choice's mark, its words and what it means. The button's style draws the row around it.
private struct OptionLabel: View {
    let title: String
    let detail: String?
    let chosen: Bool
    var multiple = false
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        HStack(alignment: .top, spacing: Space.s3) {
            mark.padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                if let detail { Text(detail).font(.sotto(.small)).foregroundStyle(Palette.muted) }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
    private var mark: some View {
        let shape = RoundedRectangle(cornerRadius: multiple ? 6 : 11, style: .continuous)
        return ZStack {
            shape.fill(chosen ? theme.color(.accent) : Color.clear)
            shape.strokeBorder(chosen ? Color.clear : theme.color(.border), lineWidth: 1.5)
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Palette.onAccent)
                .opacity(chosen ? 1 : 0)
        }
        .frame(width: 22, height: 22)
        .softShadow(Circle(), color: theme.color(.accent).opacity(0.6), radius: 6, showing: chosen)
        .animation(.easeInOut(duration: 0.25), value: chosen)
        .accessibilityHidden(true)
    }
}

/// The command a permission would run, on the code surface with a warm edge.
private struct PermissionCommand: View {
    let command: String
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("$").foregroundStyle(Palette.muted).accessibilityHidden(true)
            Text(verbatim: command).foregroundStyle(Palette.codeInk).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(.callout, design: .monospaced))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.s4)
        .background(Palette.code, in: shape)
        .overlay(shape.strokeBorder(theme.color(.warning).opacity(0.3), lineWidth: 1))
        .softShadow(shape, color: theme.color(.warning).opacity(0.3), radius: 16, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Command: \(command)")
    }
}

/// The request sheet's glass, solid under Reduce Transparency, with a warm wash at the top. Watcher's sheets use it too.
struct SheetBackdrop: View {
    let wash: Bool
    @Environment(\.sottoTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        let fill = theme.color(scheme == .dark ? .raised : .surface)
        ZStack(alignment: .top) {
            if reduceTransparency {
                fill
            } else {
                Rectangle().fill(.ultraThinMaterial)
                fill.opacity(0.86)
            }
            if wash { Wash(warm: true, height: 300, drifts: false) }
        }
        .ignoresSafeArea()
    }
}
