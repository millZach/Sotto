import SwiftUI
import UIKit
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var thread: ThreadSummary? { model.thread(ref) }

    var body: some View {
        Conversation(ref: ref, stuck: $stuck, titled: $titled) { request in
            shown = request.id
            open = request
        }
        .background(Palette.canvas)
        .navigationTitle(thread?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { barTitle }
            ToolbarItem(placement: .topBarTrailing) { barPill }
        }
        .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
        .toolbarBackground(stuck ? .visible : .hidden, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        // While a request sheet is up its keyboard never squeezes the page behind it, so the conversation keeps its
        // size and its place.
        .ignoresSafeArea(open != nil ? SafeAreaRegions.keyboard : [], edges: .bottom)
        .task(id: ref) { await model.select(ref); offer() }
        .onDisappear { Task { if model.selected == ref { await model.select(nil) } } }
        .onChange(of: thread?.requests.map(\.id)) { _, _ in offer() }
        .sheet(item: $open, onDismiss: { if let shown { setAside.insert(shown) }; shown = nil; offer() }) { request in
            RequestSheet(ref: ref, request: request).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
    }

    private var barTitle: some View {
        Text(thread?.title ?? "Thread")
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
        guard open == nil, let request = thread?.requests.first(where: { !setAside.contains($0.id) }) else { return }
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
        .accessibilityLabel(reachable ? state.words : "Can’t reach this computer")
    }
    private var word: String {
        guard reachable else { return "Can’t reach it" }
        switch state {
        case .needsAnswer, .asked: return "Needs you"
        case .working: return "Working"
        case .waiting: return "Waiting"
        case .compacting: return "Compacting"
        case .failed: return "Failed"
        case .done: return "Done"
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
    func rows(for detail: ThreadDetail?) -> [ConversationRow] {
        guard let detail else {
            key = nil
            cached = []
            return []
        }
        let next = detail.threadId + "#" + String(detail.revision)
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
        let detail = model.detail(for: ref)
        let rows = timeline.rows(for: detail)
        let pending = model.pending(for: ref)
        let tail = Tail(revision: detail?.revision, rows: rows.count, last: rows.last?.id, pending: pending.map(\.id),
                        failed: model.failedReplies[ref.id] != nil)
        ScrollViewReader { proxy in
            ScrollView {
                page(detail: detail, rows: rows, pending: pending, scroll: proxy)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .background(barReader)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ReplyDock(ref: ref, openRequest: openRequest)
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

    private func page(detail: ThreadDetail?, rows: [ConversationRow], pending: [PendingOperation], scroll: ScrollViewProxy) -> some View {
        let thread = model.thread(ref)
        let state = thread.map { ThreadState($0) } ?? .done
        return VStack(alignment: .leading, spacing: 0) {
            ThreadHero(ref: ref, thread: thread,
                       topMoved: { top in follow.heroTop = top; refreshBar() },
                       titleMoved: { bottom in follow.titleBottom = bottom; refreshBar() })
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
                }
                ForEach(rows) { row in
                    rowView(row, provider: provider, working: row.id == working, last: row.id == last, scroll: scroll)
                }
            } else if model.detailProblem == nil || !online {
                Text(model.status(ref.hostID) == .unreachable ? "Reconnect to read this thread." : "Reading this thread…")
                    .font(.sotto(.body)).foregroundStyle(Palette.muted)
                    .padding(.vertical, Space.s6)
            }
            ForEach(pending) { item in
                UnconfirmedRow(item: item, text: model.submitted[item.id], photos: model.submittedPhotos[item.id] ?? [],
                               sending: model.isSending(item)) { dismissMarker = item }
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
            MessageView(message: message, provider: provider, showsWho: row.showsWho, ref: ref) { viewing = $0 }.equatable()
        case .steps(let steps):
            FoldedRun(runID: steps.first?.id ?? row.id, steps: steps, seconds: row.seconds, working: working,
                      open: openRuns.contains(row.id), last: last) { toggleRun(row.id, scroll) }
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
    private func toBottom(_ scroll: ScrollViewProxy) {
        let box = follow
        Task { @MainActor in
            await Task.yield()
            scroll.scrollTo(Self.end, anchor: .bottom)
            try? await Task.sleep(nanoseconds: 120_000_000)
            if box.atBottom { scroll.scrollTo(Self.end, anchor: .bottom) }
        }
    }
}

// MARK: - Title block

/// The big title, where the thread runs, and its branch chips, at the top of the conversation.
private struct ThreadHero: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let thread: ThreadSummary?
    let topMoved: (CGFloat) -> Void
    let titleMoved: (CGFloat) -> Void
    var body: some View {
        let chips = GitChips(thread?.worktree)
        VStack(alignment: .leading, spacing: 0) {
            Text(thread?.title ?? "Thread")
                .font(.sotto(.display, .bold))
                .tracking(-0.6)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("thread-title")
                .background(edgeReader(\.maxY, titleMoved))
            Text(place)
                .font(.sotto(.small))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
                .truncationMode(.middle)
                .padding(.top, Space.s2)
            if !chips.isEmpty {
                GitChipRow(chips: chips).padding(.top, Space.s3)
            }
        }
        .padding(.top, Space.s1)
        .padding(.bottom, Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(edgeReader(\.minY, topMoved))
    }

    /// Where it runs: the agent, the computer and the project.
    private var place: String {
        let base = "\(Words.provider(thread?.providerId)) on \(model.name(ref.hostID))"
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

/// Branch, changed lines and pull request, from the worktree's Git status. The row reads as one sentence.
private struct GitChipRow: View {
    let chips: GitChips
    var body: some View {
        HStack(spacing: Space.s2) {
            if let branch = chips.branch {
                GitChip {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 11, weight: .semibold))
                    Text(branch)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Palette.ink)
                        .truncationMode(.middle)
                }
            }
            if let changes = chips.changes {
                GitChip {
                    Text("+\(changes.insertions)").foregroundStyle(Palette.accentText)
                    Text("−\(changes.deletions)").foregroundStyle(Palette.dangerText)
                    Text(changes.files == 1 ? "1 file" : "\(changes.files) files")
                }
                .fixedSize()
            }
            if let pullRequest = chips.pullRequest {
                GitChip {
                    Image(systemName: "arrow.triangle.pull").font(.system(size: 11, weight: .semibold))
                    Text("#\(pullRequest.number) \(pullRequest.state)")
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
    let open: (OpenPhotos) -> Void
    @Environment(\.sottoDensity) private var density
    /// Drawn again only when what it shows changes; opening a photo is the same action for every message.
    static func == (a: Self, b: Self) -> Bool {
        a.message == b.message && a.provider == b.provider && a.showsWho == b.showsWho && a.ref == b.ref
    }
    var body: some View {
        if message.role == "user" {
            userMessage
        } else if message.role == "assistant" {
            assistantMessage
        } else {
            Text(message.text).font(.sotto(.small)).foregroundStyle(Palette.muted).frame(maxWidth: .infinity)
        }
    }

    private var bubble: UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous)
    }

    /// The user's words in a bubble at the trailing edge, with their photos standing on their own above, as in Messages.
    private var userMessage: some View {
        let photos = (message.attachments ?? []).filter(\.hasPreview)
        return VStack(alignment: .trailing, spacing: Space.s1) {
            ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                Button { open(OpenPhotos(ref: ref, messageID: message.id, photos: photos, index: index)) } label: {
                    SentPhotoView(key: PhotoPreviews.Key(ref: ref, messageID: message.id, attachmentID: photo.id), name: photo.name)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open photo \(photo.name)")
            }
            if !message.text.isEmpty || photos.count != (message.attachments ?? []).count {
                content(ink: Palette.bubbleInk)
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

    private func content(ink: ThemeRole) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if !message.text.isEmpty {
                MarkdownText(text: message.text).foregroundStyle(ink)
            }
            // A user's photo its computer keeps is drawn above; any other image is named.
            ForEach((message.attachments ?? []).filter { message.role != "user" || !$0.hasPreview }) { attachment in
                Label("\(attachment.name) (open on the desktop)", systemImage: "photo")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted)
            }
        }
    }
}

// MARK: Markdown

/// A message as blocks (headings, lists, code, quotes, paragraphs), each with its inline Markdown, as the desktop
/// draws it. A stray backtick can't reach past its own block, and a key chord such as Ctrl+` reads as a key.
private struct MarkdownText: View {
    let text: String
    @Environment(\.sottoDensity) private var density
    var body: some View {
        let blocks = SottoCore.Markdown.blocks(text)
        VStack(alignment: .leading, spacing: Space.dense(Space.s3, density)) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block, first: index == 0)
            }
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let first: Bool
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
        }
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
                Text(language ?? "code").font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1)
                Spacer(minLength: Space.s2)
                Button { copy() } label: {
                    Text(copied ? "Copied" : "Copy")
                        .font(.sotto(.caption, .semibold))
                        .foregroundStyle(Palette.accentText)
                        .padding(.horizontal, Space.s3)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityLabel(copied ? "Copied" : "Copy this code")
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
        let parsed = inline.attributed()
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
/// through it, the line shows the step running now in the accent; once it has ended, how many steps it had and how
/// long they took, quietly. A press opens the steps in place under their guide, and another folds them.
private struct FoldedRun: View {
    let runID: String
    let steps: [Activity]
    let seconds: TimeInterval?
    let working: Bool
    let open: Bool
    /// The conversation ends on this run, so the line's reach stays inside the page's end.
    let last: Bool
    let toggle: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                if working {
                    WorkingLine(step: StepRun.running(steps), live: StepRun.now(steps), count: steps.count, open: open)
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

/// The working run's line: a breathing light, the step running now in the accent with its command or file in monospace,
/// how long it has run and how many steps so far. Each new step rolls up into place like a ticker and the count ticks
/// with it; under Reduce Motion the light holds still and the words crossfade.
private struct WorkingLine: View {
    /// The step running now; nil between steps, when the line reads Thinking.
    let step: Activity?
    let live: StepRun.Live
    let count: Int
    let open: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: Space.s2) {
            Light(tone: .accent, size: 7, breathing: true)
                .frame(width: 16, height: 16)
            ZStack(alignment: .leading) {
                LiveStepWords(live: live)
                    .id(step?.id ?? "thinking")
                    .transition(roll)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
            .animation(reduceMotion ? .easeInOut(duration: 0.3) : .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.46), value: step?.id)
            if let since = Words.date(step?.startedAt) {
                ElapsedText(since: since)
                    .font(.sotto(.small).monospacedDigit())
                    .foregroundStyle(Palette.accentText)
                    .lineLimit(1)
                    .fixedSize()
            }
            ZStack {
                Text("\(count)")
                    .id(count)
                    .transition(tick)
            }
            .font(.sotto(.caption, .bold).monospacedDigit())
            .foregroundStyle(Palette.accentText)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .frame(minWidth: 26, minHeight: 22)
            .clipped()
            .background(Palette.accent.opacity(Tint.accentPill), in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.accent.opacity(0.24), lineWidth: 1))
            .fixedSize()
            .animation(reduceMotion ? .easeInOut(duration: 0.3) : .spring(response: 0.42, dampingFraction: 0.62), value: count)
            FoldChevron(open: open)
        }
    }

    /// The old step leaves upward as the new one rises into its place.
    private var roll: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(insertion: AnyTransition.move(edge: .bottom).combined(with: .opacity),
                           removal: AnyTransition.move(edge: .top).combined(with: .opacity))
    }

    private var tick: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(insertion: AnyTransition.move(edge: .bottom).combined(with: .opacity), removal: .opacity)
    }
}

/// The running step's verb, then what it works on in monospace, cut in the middle when it is long.
private struct LiveStepWords: View {
    let live: StepRun.Live
    var body: some View {
        HStack(spacing: 5) {
            Text(live.verb)
                .font(.sotto(.small, .semibold))
                .lineLimit(1)
                .layoutPriority(1)
            if let subject = live.subject {
                Text(subject)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .foregroundStyle(Palette.accentText)
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
            Text(record.title)
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
        if record.status == "failed" { return record.exitCode.map { "Failed (\($0))" } ?? "Failed" }
        if record.status == "interrupted" { return "Stopped" }
        return Words.duration(record.durationMs)
    }

    /// The command it ran, or the file it changed by name.
    private var subject: String? {
        if let command = record.command?.trimmingCharacters(in: .whitespacesAndNewlines), !command.isEmpty {
            return command == record.title ? nil : command
        }
        guard let changes = record.changes, let first = changes.first else { return nil }
        let name = first.path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map { String($0) } ?? first.path
        return changes.count == 1 ? name : "\(name) and \(changes.count - 1) more"
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
            if let text, !text.isEmpty {
                Text(text).font(.sotto(.body)).foregroundStyle(Palette.bubbleInk)
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
                    Text(words.unconfirmed).fixedSize(horizontal: false, vertical: true)
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
        case "answer": return ("Sending your answer…", "Your answer isn’t confirmed. Check the thread before you answer again.")
        case "interrupt": return ("Stopping…", "Stop isn’t confirmed. Check whether the thread is still working.")
        default: return ("Sending…", "Not confirmed. Check the thread before you send it again.")
        }
    }
}

/// A reply the computer refused, with a way to put it back in the reply box.
private struct FailedReplyCard: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let text: String
    var body: some View {
        let photos = model.failedPhotos[ref.id] ?? []
        VStack(alignment: .leading, spacing: Space.s3) {
            Text("Your reply wasn’t sent").font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
            if !text.isEmpty {
                Text(text).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
            }
            if !photos.isEmpty {
                Text(photos.count == 1 ? "With 1 photo" : "With \(photos.count) photos").font(.sotto(.small)).foregroundStyle(Palette.muted)
            }
            Button("Put it back in the reply box") { model.restoreReply(ref) }
                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                .disabled(!(model.drafts[ref.id] ?? "").isEmpty || !model.photos(ref).isEmpty)
        }
        .card()
    }
}

// MARK: - Reply box

/// The reply box in glass over the bottom of the page, with what the computer or the thread needs said above it.
/// While a request waits, the box offers it instead of the field.
private struct ReplyDock: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let openRequest: (AgentRequest) -> Void
    @FocusState private var focused: Bool
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: Space.s2) {
            ComputerBanner(hostID: ref.hostID)
            if let problem = model.detailProblem, model.online(ref.hostID) {
                problemNote(problem)
            }
            dock
        }
        .padding(.horizontal, Space.s3)
        .padding(.top, Space.s2)
        .padding(.bottom, Space.s2)
    }

    private func problemNote(_ problem: String) -> some View {
        HStack(spacing: Space.s3) {
            Text(problem).font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
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
                .shadow(color: Color.black.opacity(0.22), radius: 16, x: 0, y: 8)
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
                Label(permission ? "Review the permission" : "Answer the question", systemImage: permission ? "lock.shield" : "questionmark.bubble")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ActionStyle(wide: true))
        }
    }

    private var draft: Binding<String> {
        Binding(get: { model.drafts[ref.id] ?? "" }, set: { model.drafts[ref.id] = $0 })
    }

    private var replyField: some View {
        let photos = model.photos(ref)
        let shape = RoundedRectangle(cornerRadius: photos.isEmpty ? 26 : 22, style: .continuous)
        let placeholder = model.thread(ref)?.status == "running" ? "Reply while it works" : "Reply to this thread"
        return HStack(alignment: .bottom, spacing: Space.s2) {
            AttachPhotosButton(ref: ref)
            // Photos wait inside the reply box, above the words, as in Messages.
            VStack(alignment: .leading, spacing: Space.s2) {
                if !photos.isEmpty { DraftPhotoStrip(ref: ref).padding(.top, Space.s1) }
                if let notice = model.photoNotices[ref.id] {
                    Text(notice).font(.sotto(.small)).foregroundStyle(Palette.dangerText).fixedSize(horizontal: false, vertical: true)
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
            trailingButton
        }
        .padding(6)
        .glass(in: shape)
        .overlay(shape.strokeBorder(theme.color(.accent).opacity(focused ? 0.55 : 0), lineWidth: 1))
        .shadow(color: focused ? theme.color(.accent).opacity(0.35) : Color.black.opacity(0.22), radius: focused ? 18 : 16, x: 0, y: focused ? 0 : 8)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.4), value: focused)
    }

    @ViewBuilder private var trailingButton: some View {
        if model.canInterrupt(ref) {
            Button { Task { await model.interrupt(ref) } } label: {
                RoundedRectangle(cornerRadius: 3.5, style: .continuous)
                    .frame(width: 13, height: 13)
                    .frame(width: 44, height: 44)
                    .foregroundStyle(Palette.ink)
                    .background(Palette.fillSoft, in: Circle())
                    .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 1))
                    .contentShape(Circle())
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel("Stop this turn")
        } else {
            let preparing = model.preparingSends.contains(ref.id)
            let canSend = model.canSendReply(ref)
            Button { Task { await model.send(ref) } } label: {
                Group {
                    if preparing { ProgressView().tint(Palette.onAccent) }
                    else { Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold)) }
                }
                .frame(width: 44, height: 44)
                .foregroundStyle(canSend || preparing ? Palette.onAccent : Palette.muted)
                .background(canSend || preparing ? Palette.accent : Palette.fillSoft, in: Circle())
                .contentShape(Circle())
            }
            .buttonStyle(PressStyle())
            .disabled(!canSend)
            .accessibilityLabel(preparing ? "Sending reply" : "Send reply")
        }
    }
}

// MARK: - Question and permission sheet

/// The whole request: its context and every choice, on glass with a warm wash. Nothing is chosen for the user, and a
/// question is sent only when they press Send answer.
private struct RequestSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let ref: ThreadRef
    let request: AgentRequest
    @State private var answers: [String: QuestionAnswer] = [:]
    @State private var choice: String?
    @State private var text = ""
    /// Questions whose own-answer box is open.
    @State private var writing: Set<String> = []
    @FocusState private var focus: String?
    private var thread: ThreadSummary? { model.thread(ref) }
    private var computer: String { model.name(ref.hostID) }
    /// The request as the computer holds it now; nil once it is answered or replaced.
    private var current: AgentRequest? { thread?.requests.first { $0.id == request.id } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let current, let thread {
                    content(current, thread)
                } else {
                    Text("This request was answered or changed.").font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
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
        .onChange(of: current == nil && model.pending(for: ref).isEmpty) { _, gone in if gone { dismiss() } }
    }

    @ViewBuilder private func content(_ current: AgentRequest, _ thread: ThreadSummary) -> some View {
        let provider = Words.provider(thread.providerId)
        let permission = current.kind == "permission"
        let from = permission ? "Permission for \(provider) in \(thread.title)" : "Question from \(provider) in \(thread.title)"
        HStack(spacing: Space.s2) {
            Light(tone: .warning)
            Text(from).font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(2)
        }
        .accessibilityElement(children: .combine)
        Text(title(current, provider))
            .font(.sotto(.title, .semibold))
            .tracking(-0.4)
            .foregroundStyle(Palette.ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, Space.s3)
            .accessibilityAddTraits(.isHeader)
        if let context = current.context {
            if let command = context.command { PermissionCommand(command: command).padding(.top, Space.s5) }
            if let cwd = context.cwd { runsIn(cwd) }
            if let details = context.details {
                Text(details).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
            }
        }
        if permission && current.context?.command == nil {
            Text(current.text).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
        }
        if !current.supported {
            note("This request can’t be answered here. Check the thread, or answer it on \(computer).")
            Button("Not now") { dismiss() }.buttonStyle(PillButtonStyle(kind: .soft, wide: true)).padding(.top, Space.s5)
        } else if !model.mayAnswer(ref.hostID) {
            note("This iPhone can’t answer on \(computer) yet. Turn on Can answer for it in Sotto on \(computer), or answer there.")
            Button("Not now") { dismiss() }.buttonStyle(PillButtonStyle(kind: .soft, wide: true)).padding(.top, Space.s5)
        } else if permission {
            permissionChoices(current)
        } else {
            question(current)
        }
        if let feedback = model.feedback {
            Text(feedback).font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s4)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }

    private func title(_ request: AgentRequest, _ provider: String) -> String {
        if request.kind == "permission" {
            return request.context?.command != nil ? "\(provider) wants to run a command" : "\(provider) is asking permission"
        }
        if let questions = request.questions, questions.count == 1 { return questions[0].question }
        return request.text
    }

    private func note(_ words: String) -> some View {
        Text(words).font(.sotto(.body)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
    }

    private func runsIn(_ cwd: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("It runs in").font(.sotto(.small)).foregroundStyle(Palette.muted)
            Text(cwd).font(.system(.footnote, design: .monospaced)).foregroundStyle(Palette.ink).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text("on \(computer).").font(.sotto(.small)).foregroundStyle(Palette.muted)
        }
        .padding(.top, Space.s4)
        .accessibilityElement(children: .combine)
    }

    /// The answer this iPhone sent for the request, while its computer hasn't confirmed it.
    @ViewBuilder private func sendingLine(_ current: AgentRequest) -> some View {
        if let marker = model.pending(for: ref).first(where: { $0.kind == "answer" && $0.requestID == current.id }) {
            let sending = model.isSending(marker)
            HStack(spacing: Space.s2) {
                if sending { ProgressView().controlSize(.small) }
                Text(sending ? "Sending your answer…" : "Not confirmed yet. Check the thread before answering again.")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: Permission

    @ViewBuilder private func permissionChoices(_ current: AgentRequest) -> some View {
        let enabled = model.canAnswer(current, in: ref)
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
    private func send(_ current: AgentRequest, choice: String) { Task { await model.answer(current, in: ref, choice: choice) } }

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
            Text(option.label)
            if let description = option.description { Text(description).font(.sotto(.small)).fontWeight(.regular) }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Question

    @ViewBuilder private func question(_ current: AgentRequest) -> some View {
        let enabled = model.canAnswer(current, in: ref)
        VStack(alignment: .leading, spacing: Space.s5) {
            if let questions = current.questions, !questions.isEmpty {
                ForEach(questions) { item in questionField(item, showsTitle: questions.count > 1) }
            } else if !current.options.isEmpty {
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
                answerField(text: $text, id: "answer", label: "Your answer")
            }
        }
        .disabled(!enabled)
        .padding(.top, Space.s5)
    }

    private func questionField(_ item: Question, showsTitle: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            if showsTitle {
                Text(item.question).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
            }
            if let reason = item.unavailableReason {
                Text(reason).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
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
                        OptionLabel(title: "Write your own answer", detail: "Say it in your own words.", chosen: open, multiple: item.multiSelect)
                    }
                    .buttonStyle(ChoiceStyle(chosen: open))
                    .accessibilityAddTraits(open ? .isSelected : [])
                    .disabled(item.unavailableReason != nil)
                    if open { ownAnswer(item) }
                }
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
        }), id: item.id, label: "Your own answer to: \(item.question)")
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
        focus = nil
        Task {
            if current.questions?.isEmpty == false { await model.answer(current, in: ref, answers: answers) }
            else if !current.options.isEmpty { await model.answer(current, in: ref, choice: choice) }
            else { await model.answer(current, in: ref, text: text) }
        }
    }

    /// Not now and Send answer stay in reach under a question, whatever its length.
    @ViewBuilder private var footer: some View {
        if let current, current.kind != "permission", current.supported, model.mayAnswer(ref.hostID) {
            VStack(spacing: Space.s2) {
                sendingLine(current)
                HStack(spacing: Space.s2) {
                    Button("Not now") { dismiss() }.buttonStyle(PillButtonStyle(kind: .soft, wide: true))
                    Button("Send answer") { sendAnswer(current) }
                        .buttonStyle(PillButtonStyle(kind: .primary, wide: true))
                        .disabled(!model.canAnswer(current, in: ref) || !ready(current))
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
        .shadow(color: chosen ? theme.color(.accent).opacity(0.6) : Color.clear, radius: 6)
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
            Text(command).foregroundStyle(Palette.codeInk).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(.callout, design: .monospaced))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.s4)
        .background(Palette.code, in: shape)
        .overlay(shape.strokeBorder(theme.color(.warning).opacity(0.3), lineWidth: 1))
        .shadow(color: theme.color(.warning).opacity(0.3), radius: 16, x: 0, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Command: \(command)")
    }
}

/// The request sheet's glass, solid under Reduce Transparency, with a warm wash at the top.
private struct SheetBackdrop: View {
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
            if wash { Wash(warm: true, height: 300) }
        }
        .ignoresSafeArea()
    }
}
