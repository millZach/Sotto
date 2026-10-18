import SwiftUI
import UIKit
import SottoCore

// The Watcher tab (1B, ADR-0073 amended October 11, 2026): Watcher on the computer that runs it, with its Conversation
// and the threads it Watches. Zach's picks: one card of what Watcher did for each reply, a row per thread (2B); provider
// logos with the quiet owl (3B); a thread's own question or permission card answered here, as the user's own answer to
// that thread (4B); the keyboard's own microphone key for dictation (7A).

/// A card in Watcher's page opened in the request sheet, with where its answer goes.
struct ReviewedCard: Identifiable {
    let place: RequestPlace
    let request: AgentRequest
    let id: String
}

struct WatcherView: View {
    @EnvironmentObject var model: AppModel
    let hostID: String
    @State private var section = Pane.conversation
    @State private var stopPreview: WatcherStopPreview?
    @State private var reviewing: ReviewedCard?
    enum Pane: Hashable { case conversation, watched }

    var body: some View {
        Group {
            switch section {
            case .conversation: WatcherConversationPane(hostID: hostID) { reviewing = $0 }
            case .watched: WatchedPane(hostID: hostID, stopAll: prepareStop)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { WatcherHeader(hostID: hostID, section: $section) }
        .background(Palette.canvas)
        .background(TabItemAccessibility(title: "Watcher", value: model.watcherTab.spoken))
        .navigationTitle("Watcher")
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { model.watcherOnScreen = true }
        .onDisappear { model.watcherOnScreen = false }
        // Another computer's Watcher opens on its own Conversation, with nothing of this one's open over it.
        .onChange(of: hostID) { _, _ in section = .conversation; stopPreview = nil; reviewing = nil }
        .sheet(item: $reviewing) { card in
            RequestSheet(place: card.place, request: card.request)
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        // Stop all asks in the middle of the screen, with Cancel beside Stop, as the design draws it. iOS 26 draws a
        // confirmation dialog as a menu from the page and leaves its Cancel out, so this is an alert.
        .alert(WatcherWords.stopQuestion(stopPreview?.targets.count ?? 0),
               isPresented: Binding(get: { stopPreview != nil }, set: { if !$0 { stopPreview = nil } }),
               presenting: stopPreview) { preview in
            Button(WatcherWords.stopButton(preview.targets.count), role: .destructive) {
                Task { await model.confirmWatcherStop(preview, on: hostID) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { preview in
            Text(stopMessage(preview))
        }
    }

    /// What stays, then each thread Stop all would stop and where it runs: "Fix login test, Claude Code on Laptop".
    private func stopMessage(_ preview: WatcherStopPreview) -> String {
        let threads = preview.targets.map { target in
            "\(target.title), \(AgentNames.name(target.provider)) on \(model.computerName(target.hostId) ?? "another computer")"
        }
        return (["Threads you started or took over keep going, and so does Watcher.", ""] + threads).joined(separator: "\n")
    }

    /// Stop all asks first: the computer says which threads it would stop, and nothing stops until the user confirms.
    private func prepareStop() {
        Task {
            guard let preview = await model.prepareWatcherStop(hostID) else { return }
            if preview.targets.isEmpty { model.feedback = "Watcher has no threads of its own to stop. Nothing was stopped." }
            else { stopPreview = preview }
        }
    }
}

// MARK: - Header

/// Watcher's name, its model and computer, its state, and Conversation | Watched, pinned over the page in glass.
private struct WatcherHeader: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    @Environment(\.dynamicTypeSize) private var typeSize
    let hostID: String
    @Binding var section: WatcherView.Pane
    var body: some View {
        let page = model.watcherPage(hostID)
        VStack(alignment: .leading, spacing: Space.s3) {
            // The state sits beside the name, as the design draws it, and a long model line wraps under the name rather
            // than push the state onto a row of its own. At accessibility sizes the state goes under the name.
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Space.s2) {
                    title
                    WatcherStatePill(hostID: hostID)
                }
            } else {
                HStack(spacing: Space.s3) {
                    title
                    Spacer(minLength: 0)
                    WatcherStatePill(hostID: hostID)
                }
            }
            SectionSwitch(section: $section, watched: page?.watched.count ?? 0)
        }
        .padding(.horizontal, Space.gutter)
        .padding(.top, Space.s2)
        .padding(.bottom, Space.s3)
        .background {
            // Glass that reaches up under the status bar, rounded where it meets the page.
            Color.clear
                .glass(in: UnevenRoundedRectangle(bottomLeadingRadius: Radius.xl, bottomTrailingRadius: Radius.xl, style: .continuous))
                .ignoresSafeArea(edges: .top)
        }
    }
    private var title: some View {
        HStack(spacing: Space.s3) {
            WatcherOwlMark(size: 24)
                .foregroundStyle(Palette.ink)
                .frame(width: 40, height: 40)
                .background(Palette.raised, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Watcher").font(.sotto(.title, .bold)).tracking(-0.4).foregroundStyle(Palette.ink)
                    .accessibilityAddTraits(.isHeader)
                // Caption size, as the design draws it: at the small one the line pushed the state off the name's row on
                // an iPhone SE.
                if model.watcherHostIDs.count > 1 { computerMenu } else { subtitleText }
            }
        }
    }
    private var subtitleText: some View {
        Text(subtitle).font(.sotto(.caption)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
    }
    /// With Watcher on more than one paired computer, the line naming the computer opens a menu of them.
    private var computerMenu: some View {
        Menu {
            ForEach(model.watcherHostIDs, id: \.self) { id in
                Button { model.chooseWatcher(id) } label: {
                    if id == hostID { Label(model.name(id), systemImage: "checkmark") } else { Text(model.name(id)) }
                }
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                subtitleText
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.muted)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityLabel("Choose Watcher's computer")
        .accessibilityValue(model.name(hostID))
        .accessibilityIdentifier("watcher-computer-menu")
    }
    /// "Codex · GPT-6.1 Sol on Laptop".
    private var subtitle: String {
        let computer = model.name(hostID)
        guard let running = model.watcherModel(hostID) else { return "On \(computer)" }
        return running + " on " + computer
    }
}

/// Watcher's state in a word, as a thread's bar says its own.
private struct WatcherStatePill: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    var body: some View {
        let state = self.state
        HStack(spacing: 6) {
            Light(tone: state.tone, size: 7, breathing: state.tone == .accent)
            Text(state.word)
        }
        .font(.sotto(.caption, .semibold))
        .lineLimit(1)
        .padding(.leading, Space.s3)
        .padding(.trailing, 10)
        .frame(minHeight: 28)
        .foregroundStyle(state.ink)
        .background(state.fill, in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Watcher, " + state.word)
        .accessibilityIdentifier("watcher-state")
    }
    private var state: (word: String, tone: Light.Tone, ink: ThemeRole, fill: ThemeRole) {
        guard model.online(hostID) else { return ("Can’t reach it", .off, Palette.muted, Palette.fillSoft) }
        guard let page = model.watcherPage(hostID), let current = page.current else { return ("Not started", .off, Palette.muted, Palette.fillSoft) }
        if page.needsYou.contains(where: { page.isOwn($0) }) { return ("Needs you", .warning, Palette.warningText, Palette.warning.opacity(Tint.accentPill)) }
        if current.status == "error" { return ("Failed", .danger, Palette.dangerText, Palette.danger.opacity(0.12)) }
        if page.working { return ("Working", .accent, Palette.accentText, Palette.accent.opacity(Tint.accentPill)) }
        return ("Idle", .off, Palette.muted, Palette.fillSoft)
    }
}

/// Conversation | Watched: two halves of one capsule, the chosen one raised.
private struct SectionSwitch: View {
    @Binding var section: WatcherView.Pane
    let watched: Int
    var body: some View {
        HStack(spacing: 4) {
            option(.conversation, "Conversation", count: nil, id: "watcher-section-conversation")
            option(.watched, "Watched", count: watched, id: "watcher-section-watched")
        }
        .padding(4)
        .background(Palette.fillSoft, in: Capsule())
        .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
    }
    private func option(_ value: WatcherView.Pane, _ title: String, count: Int?, id: String) -> some View {
        let chosen = section == value
        return Button { section = value } label: {
            HStack(spacing: 6) {
                Text(title).font(.sotto(.body, .semibold))
                if let count { Text("\(count)").font(.sotto(.body)).foregroundStyle(Palette.muted) }
            }
            .lineLimit(1)
            .foregroundStyle(chosen ? Palette.ink : Palette.muted)
            .padding(.horizontal, Space.s3)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background {
                if chosen {
                    Capsule().fill(Palette.surface).overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(count.map { "\(title), \($0) \($0 == 1 ? "thread" : "threads")" } ?? title)
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
        .accessibilityIdentifier(id)
    }
}

// MARK: - Conversation

/// Where Watcher's conversation stands, kept outside SwiftUI's state so scrolling never redraws it. Frames are global.
private final class WatcherFollow {
    /// How near the box, or the header, the newest words must be to count as in view.
    static let slack: CGFloat = 56
    /// The bottom of the newest words, and of the page.
    var newest: CGFloat = 0
    var end: CGFloat = 0
    /// The bottom of the header, and the top of the box.
    var top: CGFloat = 0
    var dockTop: CGFloat = .greatestFiniteMagnitude
    /// The reader sees the newest words, or the page's end where it opens, so the page follows Watcher's new words.
    /// Decided where the user lets go of the page, or the box moves, never as the content grows: new words judged by
    /// where they pushed the page would stop it following them.
    var following = true
    /// The user is dragging the page or letting a flick run out, so it never moves under them.
    var userScrolling = false
    /// New words came while the user moved the page; followed once they let go, if they let go where it follows.
    var missedFollow = false
    /// Counts requests to follow, so requests made in the same moment scroll once.
    var followRequests = 0
    func settle() {
        let seesNewest = newest >= top - Self.slack && newest <= dockTop + Self.slack
        following = seesNewest || end <= dockTop + Self.slack
    }
}

private extension View {
    /// Opens at the page's end, and sits a short conversation at the bottom, as a chat does. On iOS 18 and later that is
    /// all the anchor does, so a page that grows keeps a reader's place and follows new words only for a reader who sees
    /// them (`WatcherFollow`). iOS 17 can't separate the anchor's roles, so there it does as it did before.
    @ViewBuilder func watcherScrollAnchor() -> some View {
        if #available(iOS 18.0, *) {
            defaultScrollAnchor(.bottom, for: .initialOffset).defaultScrollAnchor(.bottom, for: .alignment)
        } else {
            defaultScrollAnchor(.bottom)
        }
    }
}

/// What the conversation follows: the page's revision, and words of the user's own on their way.
private struct WatcherTail: Equatable {
    let revision: Int
    let sending: Bool
}

private struct WatcherConversationPane: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    let review: (ReviewedCard) -> Void
    @Environment(\.sottoDensity) private var density
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var follow = WatcherFollow()
    private static let end = "watcher-end"
    private static let sendingID = "watcher-sending"

    var body: some View {
        let page = model.watcherPage(hostID)
        let sending = model.watcherSending[hostID]
        let items = page.map { WatcherConversation.items($0) } ?? []
        let newest = sending != nil ? Self.sendingID : items.last?.id ?? Self.end
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Space.dense(Space.s5, density)) {
                    notes(page)
                    if !items.isEmpty || sending != nil {
                        // The conversation and the words on their way, whose bottom is the newest words.
                        VStack(alignment: .leading, spacing: Space.dense(Space.s5, density)) {
                            ForEach(items) { item in
                                Group {
                                    switch item {
                                    case .message(let message): WatcherMessage(message: message)
                                    case .receipts(let group, _): ReceiptCard(hostID: hostID, group: group)
                                    case .ownChange(let change): WatcherOwnChangeLine(change: change)
                                    }
                                }
                                .id(item.id)
                            }
                            if let sending { SendingBubble(text: sending).id(Self.sendingID) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(reader { follow.newest = $0.maxY })
                    }
                    ForEach(Array((model.watcherSetAside[hostID] ?? []).enumerated()), id: \.offset) { _, words in
                        SetAsideCard(hostID: hostID, words: words)
                    }
                    if let page { cards(page) }
                    if model.online(hostID), page?.working == true {
                        HStack(spacing: Space.s2) {
                            Light(tone: .accent, breathing: true)
                            Text("Watcher is working").font(.sotto(.small, .semibold)).foregroundStyle(Palette.accentText)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    Color.clear.frame(height: 1).id(Self.end)
                        .background(reader { follow.end = $0.maxY })
                }
                .padding(.horizontal, Space.s4)
                .padding(.top, Space.s4)
                .padding(.bottom, Space.s4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .watcherScrollAnchor()
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.readWatcher(hostID) }
            .onUserScrolling { scrolling in
                let wasScrolling = follow.userScrolling
                follow.userScrolling = scrolling
                guard wasScrolling && !scrolling else { return }
                // Where they let go decides whether the page follows. What arrived while they moved it is followed then,
                // if they let go where it follows; a page moved to earlier messages is left where they put it.
                follow.settle()
                guard follow.missedFollow else { return }
                follow.missedFollow = false
                if follow.following { toNewest(proxy, to: newest) }
            }
            .background(barReader)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                WatcherDock(hostID: hostID, willSend: {
                    // A fast send can begin and end before SwiftUI renders its sending state. The press itself
                    // resumes following, before the keyboard and the conversation change their layout.
                    follow.following = true
                }).background(dockReader(proxy, newest: newest))
            }
            // New words, the user's own or Watcher's, are scrolled to just above the box, for a reader who sees the newest
            // words or the page's end. Cards waiting on the user sit after the whole conversation, where the page opens,
            // so scrolling to the end would leave the new words under the header on a small phone. A reader of earlier
            // messages is left there, and the user's own words are always shown as they send them (ADR-0051).
            .onChange(of: WatcherTail(revision: page?.conversation.revision ?? 0, sending: sending != nil)) { before, after in
                if after.sending && !before.sending { follow.following = true }
                if follow.following { toNewest(proxy, to: newest) }
            }
        }
    }

    /// Reads a frame, in global coordinates, as it moves. Nothing redraws for it, and nothing is decided by it.
    private func reader(_ moved: @escaping (CGRect) -> Void) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { moved(proxy.frame(in: .global)) }
                .onChange(of: proxy.frame(in: .global)) { _, frame in moved(frame) }
        }
    }
    /// The bottom of the header, which sits over the page's top.
    private var barReader: some View {
        GeometryReader { proxy in
            let bottom = proxy.frame(in: .global).minY + proxy.safeAreaInsets.top
            Color.clear
                .onAppear { follow.top = bottom; follow.settle() }
                .onChange(of: bottom) { _, value in follow.top = value; follow.settle() }
        }
    }
    /// The top of the box, which moves when it changes height or the keyboard opens or closes. A reader who saw the newest
    /// words before it moved still sees them after.
    private func dockReader(_ scroll: ScrollViewProxy, newest: String) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { follow.dockTop = proxy.frame(in: .global).minY }
                .onChange(of: proxy.frame(in: .global).minY) { _, value in
                    let wasFollowing = follow.following
                    follow.dockTop = value
                    if wasFollowing { toNewest(scroll, to: newest) } else { follow.settle() }
                }
        }
    }
    /// Scrolls the newest words, `target`, to just above the box once the new layout is in, and once more after that
    /// scroll has run, for words whose height settled after it. Requests made in the same moment scroll once, and only the
    /// latest looks again. None scrolls while the user moves the page; the page owes it to them for when they let go.
    private func toNewest(_ scroll: ScrollViewProxy, to target: String) {
        let box = follow
        guard !box.userScrolling else { box.missedFollow = true; return }
        box.followRequests += 1
        let request = box.followRequests
        let still = reduceMotion
        Task { @MainActor in
            await Task.yield()
            guard box.followRequests == request else { return }
            guard !box.userScrolling else { box.missedFollow = true; return }
            withAnimation(still ? nil : .easeOut(duration: 0.3)) { scroll.scrollTo(target, anchor: .bottom) }
            try? await Task.sleep(nanoseconds: still ? 120_000_000 : 360_000_000)
            if box.followRequests == request, box.following, !box.userScrolling { scroll.scrollTo(target, anchor: .bottom) }
        }
    }

    @ViewBuilder private func notes(_ page: WatcherPage?) -> some View {
        // A read that failed while a page is shown says so over the page it left.
        if page != nil, model.online(hostID), let problem = model.watcherReadProblems[hostID] { note(problem) }
        if let notice = page?.recoveryNotice, !notice.isEmpty { note(notice) }
        if page?.conversation.earlierAvailable == true { note("Earlier messages are in Sotto on \(model.name(hostID)).") }
        if let page, page.current == nil {
            note("Watcher isn’t running on \(model.name(hostID)). Start it in Sotto on \(model.name(hostID)), then ask it here.")
        } else if let page, page.conversation.messages.isEmpty, model.watcherSending[hostID] == nil {
            note("Ask Watcher to start, check on or stop your threads. It answers nothing for you.")
        } else if page == nil {
            note(model.online(hostID) ? model.watcherReadProblems[hostID] ?? "Reading Watcher on \(model.name(hostID))…"
                 : "Reconnect to \(model.name(hostID)) to read Watcher.")
        }
    }
    private func note(_ words: String) -> some View {
        Text(words).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .center).multilineTextAlignment(.center)
    }

    /// What waits on the user: workers' own cards, each saying where its answer goes, then Watcher's own.
    @ViewBuilder private func cards(_ page: WatcherPage) -> some View {
        let workers = page.needsYou.filter { !page.isOwn($0) }
        let own = page.needsYou.filter { page.isOwn($0) }
        ForEach(workers, id: \.key) { card in
            VStack(alignment: .leading, spacing: Space.s2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    WatcherOwlMark(size: 12).foregroundStyle(Palette.muted).accessibilityHidden(true)
                    Text("The thread’s own card. Your answer goes to \(card.title), not to Watcher.")
                        .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                WatcherRequestCard(hostID: hostID, card: card, own: false, review: review)
            }
        }
        ForEach(own, id: \.key) { card in
            WatcherRequestCard(hostID: hostID, card: card, own: true, review: review)
        }
    }
}

/// A message in Watcher's conversation: the user's in a bubble at the trailing edge, Watcher's on the canvas under the
/// owl, its name and the time.
private struct WatcherMessage: View {
    let message: Message
    @Environment(\.sottoDensity) private var density
    var body: some View {
        if message.role == "user" {
            MarkdownText(text: message.text)
                .foregroundStyle(Palette.bubbleInk)
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.dense(Space.s3, density))
                .background(Palette.bubble, in: bubble)
                .overlay(bubble.stroke(Palette.accent.opacity(0.12), lineWidth: 1))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 48)
        } else {
            VStack(alignment: .leading, spacing: Space.s2) {
                HStack(spacing: Space.s2) {
                    WatcherOwlMark(size: 12)
                        .foregroundStyle(Palette.accentText)
                        .frame(width: 18, height: 18)
                        .background(Palette.accent.opacity(0.22), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .accessibilityHidden(true)
                    Text(time.map { "Watcher · \($0)" } ?? "Watcher").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                }
                MarkdownText(text: message.text).foregroundStyle(Palette.ink)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var bubble: UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous)
    }
    private var time: String? { Words.date(message.createdAt)?.formatted(date: .omitted, time: .shortened) }
}

/// Words on their way to Watcher.
private struct SendingBubble: View {
    let text: String
    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(text).font(.sotto(.body)).foregroundStyle(Palette.bubbleInk)
                .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
                .background(Palette.bubble.opacity(0.6), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Sending to Watcher…") }
                .font(.sotto(.caption)).foregroundStyle(Palette.muted)
                .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }
}

/// Words that didn't reach Watcher, or that it didn't confirm, kept here while newer words are in the box, as a thread
/// keeps a reply that wasn't sent. Put back, they go with the draft ID they went with before.
private struct SetAsideCard: View {
    @EnvironmentObject var model: AppModel
    /// Watched so Put it back follows what the box holds; typing publishes here, not on the model.
    @EnvironmentObject var draftStore: DraftStore
    let hostID: String
    let words: WatcherSetAside
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            Text(words.unconfirmed ? "Watcher didn’t confirm this message" : "Your message to Watcher wasn’t sent")
                .font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
            Text(words.text).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
            if words.unconfirmed {
                Text("Check the conversation before you send it again.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Put it back in the box") { model.restoreWatcherWords(words, on: hostID) }
                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                .disabled(!(model.drafts[model.watcherDraftKey(hostID)] ?? "").isEmpty)
                .accessibilityHint("Once the box is empty")
        }
        .card()
        .accessibilityIdentifier("watcher-set-aside")
    }
}

// MARK: - What Watcher did (2B)

/// One card for what Watcher did for a reply, a row per thread. Each row opens its thread where this iPhone has it.
private struct ReceiptCard: View {
    @EnvironmentObject var model: AppModel
    let hostID: String
    let group: WatcherPage.ReceiptGroup
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s2) {
                Text("What Watcher did").font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
                Spacer(minLength: Space.s2)
                if let time { Text(time).font(.sotto(.caption)).foregroundStyle(Palette.muted) }
            }
            .padding(.horizontal, Space.s4)
            .padding(.top, Space.s3)
            .padding(.bottom, Space.s1)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4 + 44) }
                ReceiptRow(row: row, computer: model.computerName(row.target.hostId) ?? "another computer",
                           thread: model.thread(row.target.ref), watched: model.watchedByWatcher(row.target.ref))
            }
        }
        .padding(.bottom, Space.s1)
        .sottoCard(.plain)
    }
    private var time: String? {
        group.rows.compactMap { Words.date($0.createdAt) }.max()?.formatted(date: .omitted, time: .shortened)
    }
}

private struct ReceiptRow: View {
    let row: WatcherPage.Receipt
    let computer: String
    /// The thread as this iPhone's list has it; nil when it isn't listed here, so the row doesn't open it.
    let thread: ThreadSummary?
    let watched: Bool
    var body: some View {
        if thread != nil {
            NavigationLink(value: ThreadRoute(ref: row.target.ref)) { content(opens: true) }
                .buttonStyle(PressStyle())
                .accessibilityLabel(spoken)
                .accessibilityHint("Opens the thread")
                .accessibilityIdentifier("watcher-receipt-\(row.target.ref.id)")
        } else {
            content(opens: false)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spoken)
        }
    }
    private func content(opens: Bool) -> some View {
        HStack(alignment: .top, spacing: Space.s3) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(row.deliveryState == "failed" ? Palette.dangerText : Palette.accentText)
                .frame(width: 32, height: 32)
                .background(Palette.fillSoft, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(WatcherWords.action(row.action)).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                PlaceLine(providerID: row.provider, watched: watched, text: "\(AgentNames.name(row.provider)) on \(computer)")
                if let words = WatcherWords.delivery(row) {
                    Text(words).font(.sotto(.small, .semibold))
                        .foregroundStyle(row.deliveryState == "failed" ? Palette.dangerText : Palette.warningText)
                } else if let thread {
                    let state = ThreadState(thread)
                    HStack(spacing: 6) {
                        StatusDot(state: state, size: 7)
                        Text(state.words).font(.sotto(.small, .semibold))
                            .foregroundStyle(state.workInProgress ? Palette.accentText : Palette.muted)
                    }
                }
            }
            Spacer(minLength: Space.s2)
            if opens {
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                    .padding(.top, 8).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s3)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
    private var icon: String {
        switch row.action {
        case "start": return "plus"
        case "send": return "arrow.up.right"
        case "stop": return "stop.fill"
        case "settle": return "checkmark"
        default: return "circle"
        }
    }
    private var spoken: String {
        var words = "\(row.title), \(WatcherWords.action(row.action)), \(AgentNames.name(row.provider)) on \(computer)" + WatchedWords.spoken(watched)
        if let delivery = WatcherWords.delivery(row) { words += ", " + delivery }
        else if let thread { words += ", " + ThreadState(thread).words }
        return words
    }
}

// MARK: - What Watcher changed itself (mark B)

/// One quiet line under a reply in which Watcher changed files itself (Zach's pick on October 13, 2026, mark B): how many,
/// from the provider's own record of file changes in that turn, so it is there whatever the reply says; then Watcher's
/// reason in its own words, or that it gave none, in the needs-you ink, since Watcher is meant to hand changes to a
/// thread. The file names show on request.
private struct WatcherOwnChangeLine: View {
    let change: WatcherPage.OwnChange
    @State private var open = false
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .footnote) private var indent: CGFloat = 21
    private var count: Int { max(change.fileCount, change.files.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.warningText)
                    .accessibilityHidden(true)
                words.fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("watcher-own-change")
            if !change.files.isEmpty {
                Button { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { open.toggle() } } label: {
                    HStack(spacing: 4) {
                        Text(WatcherWords.ownChangeToggle(count, open: open))
                        Image(systemName: open ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .semibold))
                            .accessibilityHidden(true)
                    }
                    .font(.sotto(.small, .semibold))
                    .foregroundStyle(Palette.accentText)
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .padding(.leading, indent)
                .accessibilityIdentifier("watcher-own-change-files")
                if open { files.padding(.leading, indent) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// "Watcher changed 2 files itself." and its reason, or that it gave none, as one run of words.
    private var words: Text {
        let head: Text = Text(WatcherWords.ownChangeHeadline(count) + " ").font(.sotto(.small, .semibold)).foregroundStyle(theme.color(.ink))
        guard let reason = change.reason else {
            let none: Text = Text("It gave no reason.").font(.sotto(.small)).foregroundStyle(theme.color(.warningText))
            return head + none
        }
        let said: Text = Text("Its reason: ").font(.sotto(.small)).foregroundStyle(theme.color(.muted))
        let words: Text = Text("“\(reason)”").font(.sotto(.small)).foregroundStyle(theme.color(.ink))
        return head + said + words
    }

    /// The files, as the provider named them, and how many more it changed without naming them.
    private var files: some View {
        HStack(alignment: .top, spacing: Space.s3) {
            Rectangle().fill(Palette.hairline).frame(width: 2).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.s1) {
                ForEach(change.files, id: \.self) { file in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "doc").font(.system(size: 12)).foregroundStyle(Palette.muted).accessibilityHidden(true)
                        Text(file).font(.mono).foregroundStyle(Palette.ink).lineLimit(2).truncationMode(.middle)
                            .textSelection(.enabled)
                    }
                }
                if count > change.files.count {
                    Text("and \(WatcherWords.files(count - change.files.count)) more").font(.sotto(.small)).foregroundStyle(Palette.muted)
                }
            }
        }
        .padding(.vertical, Space.s1)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Files Watcher changed")
        .accessibilityIdentifier("watcher-own-change-list")
    }
}

// MARK: - Cards that wait on the user (4B)

/// A question or permission in Watcher's page: a worker's own card, or Watcher's own. One-tap answers are made here and go
/// to the thread that asked, as the user's own answer under this iPhone's Can answer: through the computer that runs
/// Watcher for its own threads, or, for a thread on another computer this iPhone is paired with, to that computer, as
/// the thread's own page would send it. Anything more opens the request sheet. Watcher answers nothing.
private struct WatcherRequestCard: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    let card: WatcherPage.RequestCard
    let own: Bool
    let review: (ReviewedCard) -> Void
    @State private var picked: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            summary
            actions
                .padding(.horizontal, Space.s4)
                .padding(.top, Space.s1)
                .padding(.bottom, Space.s3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sottoCard(.needsYou)
    }

    /// Where the answer goes, or nil for a thread on a computer this iPhone isn't paired with.
    private var place: RequestPlace? { model.watcherCardPlace(card, on: hostID) }
    /// Whether it can be answered from here now: only while the computer that holds the request still has it.
    private var route: WatcherCardRoute { model.watcherCardRoute(card, on: hostID) }
    /// The request as its computer holds it now, or as Watcher's page shows it when this iPhone can't read that.
    private var request: AgentRequest {
        if case .answer(_, let current) = route { return current }
        return card.request
    }
    private var isPermission: Bool { request.kind == "permission" }
    private var tag: String { isPermission ? "Permission" : "Question" }
    private var ask: String { isPermission ? request.text : (request.questions?.first?.question ?? request.text) }
    private var computer: String { model.name(hostID) }
    /// "Claude Code on Laptop": the thread's provider and computer.
    private var whereItRuns: String { "\(AgentNames.name(card.provider)) on \(model.computerName(card.target.hostId) ?? "another computer")" }
    private var reviewWords: String { isPermission ? "Review permission" : "Review question" }
    /// Watcher's own permissions are asked each time: it can't be given one that lasts.
    private var asksEachTime: Bool {
        own && isPermission && !(request.permissionChoices ?? []).contains { $0.kind == "allow-session" || $0.kind == "allow-always" }
    }
    private func openReview() {
        guard let place else { return }
        review(ReviewedCard(place: place, request: request, id: card.key))
    }
    private func send(choice: String?, answers: [String: QuestionAnswer] = [:]) {
        guard let place else { return }
        let current = request
        Task { await model.answer(current, at: place, choice: choice, answers: answers) }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s2) {
                Light(tone: .warning)
                Text(tag).font(.sotto(.caption, .semibold)).foregroundStyle(Palette.warningText)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 18)
            Group {
                if own {
                    HStack(spacing: Space.s2) {
                        WatcherOwlMark(size: 18).foregroundStyle(Palette.ink).accessibilityHidden(true)
                        Text("Watcher")
                    }
                } else {
                    Text(card.title)
                }
            }
            .font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, Space.s2)
            PlaceLine(providerID: card.provider, watched: !own && model.watchedByWatcher(card.target.ref), text: whereItRuns)
                .padding(.top, Space.s1)
            Text(ask).font(.sotto(.body)).foregroundStyle(Palette.ink).lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s3)
            if let command = request.context?.command, !command.isEmpty {
                Text(command).font(.mono).foregroundStyle(Palette.codeInk).lineLimit(3)
                    .padding(.horizontal, Space.s3).padding(.vertical, Space.s2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.code, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
                    .padding(.top, Space.s2)
                    .accessibilityLabel("Command: \(command)")
            }
            if asksEachTime {
                Text("Watcher asks each time. It can’t be given lasting permission.")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Space.s2)
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s4)
        .padding(.bottom, Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(own ? "watcher-own-card" : "watcher-card-\(card.target.threadId)")
    }

    @ViewBuilder private var actions: some View {
        if let place, let marker = model.answerMarker(card.request.id, at: place) {
            if model.isSending(marker) {
                HStack(spacing: Space.s2) { Spacer(minLength: 0); ProgressView().controlSize(.small); Text("Sending your answer…") }
                    .font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted).frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
            } else {
                VStack(alignment: .leading, spacing: Space.s2) {
                    Text("Not confirmed yet. Check the thread before answering again.")
                        .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    Button("Check again") { Task { await model.checkDelivery(place.hostID) } }
                        .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                        .disabled(!model.online(place.hostID))
                        .accessibilityHint("Checks this answer’s receipt without sending it again")
                }
            }
        } else {
            idleActions
        }
    }

    /// Answers are offered only once the computer that holds the request has it, as the card shows it; otherwise the card
    /// says why there are none.
    @ViewBuilder private var idleActions: some View {
        switch route {
        case .note(let words):
            note(words, reviews: false)
        case .answer(let place, let current):
            if !current.supported {
                note("Answer this one in Sotto on \(model.name(place.hostID)).", reviews: false)
            } else if !model.mayAnswer(at: place) {
                note("This iPhone can’t answer on \(model.name(place.hostID)) yet.", reviews: true)
            } else if !card.connected {
                note("\(AgentNames.name(card.provider)) isn’t connected on \(model.computerName(card.target.hostId) ?? computer). Answer once it’s back.", reviews: false)
            } else if isPermission {
                permissionActions(enabled: model.canAnswer(current, at: place) && !model.answering(place.hostID))
            } else if let options = current.oneTapOptions {
                questionActions(options, enabled: model.canAnswer(current, at: place) && !model.answering(place.hostID))
            } else {
                note(nil, reviews: true)
            }
        }
    }

    private func note(_ words: String?, reviews: Bool) -> some View {
        HStack(spacing: Space.s3) {
            if let words {
                Text(words).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if reviews {
                Button(reviewWords, action: openReview)
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                    .accessibilityIdentifier("watcher-card-review")
            }
        }
    }

    private func questionActions(_ options: [RequestOption], enabled: Bool) -> some View {
        OneTapQuestion(options: options, enabled: enabled, picked: $picked, sendID: "watcher-card-send") { choice in
            send(choice: choice, answers: ThreadsView.oneTapAnswers(request, choice: choice))
        } more: {
            Button(request.questions?.first?.allowFreeText == true ? "Write your own" : reviewWords, action: openReview)
                .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
        }
    }

    private func permissionActions(enabled: Bool) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.s2) {
                Button(moreWords, action: openReview).buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                Spacer(minLength: 0)
                permissionButtons(enabled: enabled)
            }
            VStack(alignment: .trailing, spacing: Space.s2) {
                HStack(spacing: Space.s2) { permissionButtons(enabled: enabled) }
                Button(moreWords, action: openReview).buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
    /// More choices when the request has choices the card doesn't show; otherwise Details opens the whole request.
    private var moreWords: String {
        let shown = request.cardPermissionChoices?.count ?? 0
        return (request.permissionChoices?.count ?? 0) > shown ? "More choices" : "Details"
    }

    /// Deny, then Allow once, in the provider's own words. A request with no choices of its own takes Deny and Allow.
    private func permissionButtons(enabled: Bool) -> some View {
        CardPermissionButtons(request: request, enabled: enabled) { choice, _ in send(choice: choice) }
    }
}

// MARK: - Reply box

/// Asking Watcher: the box in glass over the conversation's end. The keyboard's own microphone key dictates into it.
private struct WatcherDock: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    /// The box's words, watched here alone, so a keystroke redraws the box and nothing else.
    @EnvironmentObject var draftStore: DraftStore
    let hostID: String
    let willSend: () -> Void
    @FocusState private var focused: Bool
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: Space.s2) {
            banner
            if let held = model.watcherSendHeld(hostID) {
                Text(held).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
                    .glass(in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                    .accessibilityIdentifier("watcher-send-held")
            }
            // Put away while the box is being written in, so a small phone keeps room for the conversation over the keyboard.
            if model.offersWatcherManage(hostID), model.watcherPage(hostID) != nil, !focused { WatcherPermissionChip(hostID: hostID) }
            field
        }
        .padding(.horizontal, Space.s3)
        .padding(.top, Space.s2)
        .padding(.bottom, Space.s2)
    }

    @ViewBuilder private var banner: some View {
        if model.status(hostID) == .unreachable {
            HStack(spacing: Space.s3) {
                Light(tone: .danger)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Can’t reach \(model.name(hostID))").font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                    Text("Watcher carries on there. Your words are kept.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                }
                Spacer(minLength: 0)
                Button("Reconnect") { Task { await model.connect(hostID) } }.buttonStyle(PlainStyle(compact: true))
                    .accessibilityLabel("Reconnect to \(model.name(hostID))")
            }
            .padding(Space.s3)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
        } else if model.status(hostID) == .connecting {
            HStack(spacing: Space.s3) {
                ProgressView().controlSize(.small)
                Text("Reconnecting to \(model.name(hostID))…").font(.sotto(.small)).foregroundStyle(Palette.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
            .glass(in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .accessibilityElement(children: .combine)
        } else {
            FeedbackBanner()
        }
    }

    private var draft: Binding<String> {
        let key = model.watcherDraftKey(hostID)
        return Binding(get: { model.drafts[key] ?? "" }, set: { model.drafts[key] = $0 })
    }

    private var field: some View {
        let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        let working = model.watcherPage(hostID)?.working == true
        let canSend = model.canSendToWatcher(hostID)
        return HStack(alignment: .bottom, spacing: Space.s2) {
            TextField("Ask Watcher", text: draft, prompt: Text(working ? "Ask Watcher while it works" : "Ask Watcher").foregroundStyle(Palette.placeholder), axis: .vertical)
                .font(.sotto(.body))
                .foregroundStyle(Palette.ink)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.vertical, 11)
                .padding(.leading, Space.s3)
                .accessibilityLabel("Ask Watcher")
                .accessibilityIdentifier("watcher-reply")
            // Sending puts the keyboard away, as the design does, so Watcher's answer has room on a small phone.
            Button { willSend(); focused = false; Task { await model.sendToWatcher(hostID) } } label: {
                Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .foregroundStyle(canSend ? Palette.onAccent : Palette.muted)
                    .background(canSend ? Palette.accent : Palette.fillSoft, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(PressStyle())
            .disabled(!canSend)
            .accessibilityLabel("Send to Watcher")
            .accessibilityIdentifier("watcher-send")
        }
        .padding(6)
        .glass(in: shape)
        .overlay(shape.strokeBorder(theme.color(.accent).opacity(focused ? 0.55 : 0), lineWidth: 1))
        .background {
            ZStack {
                SoftShadow(shape: shape, color: Color.black.opacity(0.22), radius: 16, y: 8).opacity(focused ? 0 : 1)
                SoftShadow(shape: shape, color: theme.color(.accent).opacity(0.35), radius: 18).opacity(focused ? 1 : 0)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.4), value: focused)
    }
}

// MARK: - What Watcher may do without asking (control A)

/// Watcher's permissions over the Ask Watcher box: a chip in this iPhone's own words, after the Threads composer's, that
/// opens the four modes. A choice shows at once; until Watcher's provider confirms it, the chip's edge is dashed and the
/// words beside it say what is still in force. A computer that refuses says why in its own words.
private struct WatcherPermissionChip: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    @State private var choosing = false
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let caption = model.watcherPermissionInForce(hostID)
        let fixed = model.watcherPermissionFixed(hostID)
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Space.s1) { chip(pending: caption != nil, fixed: fixed); captionText(caption); fixedText(fixed && caption == nil) }
            } else {
                HStack(spacing: Space.s3) { chip(pending: caption != nil, fixed: fixed); captionText(caption); fixedText(fixed && caption == nil) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $choosing) {
            WatcherPermissionSheet(hostID: hostID) { mode in
                choosing = false
                Task { await model.setWatcherPermission(mode, on: hostID) }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private func chip(pending: Bool, fixed: Bool) -> some View {
        let mode = model.watcherPermission(hostID)
        let busy = model.watcherManaging.contains(AppModel.permissionKey(hostID))
        let edge = StrokeStyle(lineWidth: 1, dash: pending ? [4, 3] : [])
        return Button { choosing = true } label: {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.mini) }
                Text(WatcherPermissions.name(mode)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).accessibilityHidden(true)
            }
            .font(.sotto(.small, .semibold))
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, Space.s4)
            .frame(minHeight: 44)
            .glass(in: Capsule())
            .overlay(Capsule().strokeBorder(pending ? Palette.accent.opacity(0.7) : Palette.hairline, style: edge))
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .disabled(!model.canChangeWatcherPermission(hostID))
        .accessibilityLabel("Watcher’s permissions")
        .accessibilityValue(WatcherPermissions.name(mode))
        .accessibilityHint(fixed ? WatcherPermissions.fixedHint : "Opens what Watcher may do without asking")
        .opacity(fixed ? 0.55 : 1)
        .accessibilityIdentifier("watcher-permissions")
    }

    @ViewBuilder private func captionText(_ caption: String?) -> some View {
        if let caption {
            Text(caption).font(.sotto(.caption)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("watcher-permissions-in-force")
        }
    }

    /// Beside the chip while Watcher works; the chip's hint says when it can change.
    @ViewBuilder private func fixedText(_ shown: Bool) -> some View {
        if shown {
            Text(WatcherPermissions.fixed).font(.sotto(.caption)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("watcher-permissions-fixed")
        }
    }
}

/// The four modes, each with what Watcher does under it, the chosen one ticked; then what stays true in every mode. An
/// iPhone without Can answer on that computer can choose only to keep Watcher asking first, and the sheet says so.
private struct WatcherPermissionSheet: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    @Environment(\.dismiss) private var dismiss
    let hostID: String
    let choose: (String) -> Void

    var body: some View {
        let computer = model.name(hostID)
        let provider = model.watcherPage(hostID)?.current.map { AgentNames.name($0.provider) }
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s3) {
                VStack(alignment: .leading, spacing: Space.s1) {
                    Text(WatcherPermissions.title).font(.sotto(.title, .bold)).tracking(-0.4).foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(provider.map { "Watcher on \(computer), on \($0)" } ?? "Watcher on \(computer)")
                        .font(.sotto(.small)).foregroundStyle(Palette.muted)
                }
                if !model.mayAnswer(hostID) {
                    Text(WatcherPermissions.asksOnly(computer)).font(.sotto(.small)).foregroundStyle(Palette.warningText)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("watcher-permissions-asks-only")
                }
                VStack(spacing: Space.s2) {
                    ForEach(model.watcherPermissionModes(hostID), id: \.self) { mode in
                        option(mode, provider: provider ?? "The provider", computer: computer)
                    }
                }
                .padding(.top, Space.s1)
                Text(WatcherPermissions.foot).font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s6)
            .padding(.bottom, Space.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .presentationBackground { SheetBackdrop(wash: false) }
        .presentationCornerRadius(Radius.xl)
    }

    private func option(_ mode: String, provider: String, computer: String) -> some View {
        let chosen = model.watcherPermission(hostID) == mode
        return Button { if chosen { dismiss() } else { choose(mode) } } label: {
            HStack(alignment: .top, spacing: Space.s3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(WatcherPermissions.name(mode)).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    Text(WatcherPermissions.line(mode, provider: provider, computer: computer)).font(.sotto(.small))
                        .foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: Space.s2)
                if chosen {
                    Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.accentText)
                        .accessibilityHidden(true)
                }
            }
        }
        .buttonStyle(ChoiceStyle(chosen: chosen))
        .disabled(!model.mayChooseWatcherPermission(mode, on: hostID) || !model.canChangeWatcherPermission(hostID))
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
        .accessibilityIdentifier("watcher-permission-\(mode)")
    }
}

// MARK: - Watched

/// The threads Watcher works with: on a computer whose watches last until the user stops them, what watching means,
/// Watch a thread and Stop all, then each thread as a card that opens it, with what Watcher last did and Stop watching;
/// on an older one, how many of how many it may, Stop all and the cards. Then the ones it no longer watches.
private struct WatchedPane: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    let stopAll: () -> Void
    @State private var picking = false
    var body: some View {
        let page = model.watcherPage(hostID)
        let manages = model.offersWatcherManage(hostID)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                FeedbackBanner().padding(.top, Space.s3)
                if let page {
                    if manages { lead(page).padding(.top, Space.s4) } else { meterRow(page).padding(.top, Space.s4) }
                    if page.watched.isEmpty {
                        if !manages {
                            Text("Watcher isn’t working with any threads now.").font(.sotto(.body)).foregroundStyle(Palette.muted)
                                .fixedSize(horizontal: false, vertical: true).padding(.vertical, Space.s6)
                        }
                    } else {
                        VStack(spacing: Space.s3) {
                            ForEach(page.watched, id: \.target.ref.id) { thread in
                                let ref = thread.target.ref
                                let stop: (() -> Void)? = manages ? { stopWatching(thread) } : nil
                                WatchedCard(thread: thread, computer: computer(thread), listed: model.thread(ref),
                                            doing: manages ? WatcherWords.doing(thread, in: page) : nil, stop: stop,
                                            stopping: model.changingWatch(ref), canStop: model.canChangeWatch(ref))
                            }
                        }
                        .padding(.top, Space.s4)
                    }
                    // Where watches last until the user stops them there is no count to fill; Watcher's limit is on
                    // how many new threads it starts at once.
                    if !manages {
                        Text(WatcherWords.room(page)).font(.sotto(.small)).foregroundStyle(Palette.muted)
                            .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s3)
                    }
                    if !page.noLongerWatched.isEmpty {
                        SectionHeading("No longer watched", count: page.noLongerWatched.count)
                        VStack(spacing: 0) {
                            ForEach(Array(page.noLongerWatched.enumerated()), id: \.element.target.ref.id) { index, thread in
                                if index > 0 { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4 + 20) }
                                LeftRow(thread: thread, computer: computer(thread), listed: model.thread(thread.target.ref) != nil)
                            }
                        }
                        .sottoCard(.plain)
                    }
                } else {
                    Text(model.online(hostID) ? model.watcherReadProblems[hostID] ?? "Reading Watcher on \(model.name(hostID))…"
                         : "Reconnect to \(model.name(hostID)) to read Watcher.")
                        .font(.sotto(.body)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, Space.s7)
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.s8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await model.readWatcher(hostID) }
        // What a Stop watching press did, with Undo, over the tab bar.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            WatchToast(scope: nil, margin: EdgeInsets(top: 0, leading: Space.s3, bottom: Space.s2, trailing: Space.s3))
        }
        .sheet(isPresented: $picking) {
            WatchPicker(hostID: hostID).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
    }

    private func computer(_ thread: WatcherPage.WatchedThread) -> String {
        model.computerName(thread.target.hostId) ?? "another computer"
    }

    private func stopWatching(_ thread: WatcherPage.WatchedThread) {
        Task { await model.setWatched(thread.target.ref, false, title: thread.title) }
    }

    /// What watching means here, then Watch a thread, with Stop all beside it while Watcher has threads it started.
    private func lead(_ page: WatcherPage) -> some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            Text(WatcherWords.watchedLead(page.watched.count, standing: page.watched.filter { page.standingWatch($0.target.ref) != nil }.count))
                .font(.sotto(.body)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("watcher-watched-lead")
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.s3) {
                    watchButton
                    stopButton(page)
                }
                VStack(alignment: .leading, spacing: Space.s3) {
                    watchButton
                    stopButton(page)
                }
            }
        }
    }

    private var watchButton: some View {
        Button { picking = true } label: {
            HStack(spacing: Space.s2) {
                WatcherOwlMark(size: 18).foregroundStyle(Palette.accentText).accessibilityHidden(true)
                Text("Watch a thread")
            }
        }
        .buttonStyle(PillButtonStyle(kind: .soft, wide: true))
        .disabled(!model.online(hostID))
        .accessibilityHint("Shows the threads Watcher could watch")
        .accessibilityIdentifier("watcher-watch-a-thread")
    }

    private func meterRow(_ page: WatcherPage) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.s3) {
                meter(page)
                Spacer(minLength: Space.s2)
                stopButton(page)
            }
            VStack(alignment: .leading, spacing: Space.s3) {
                meter(page)
                stopButton(page)
            }
        }
    }

    /// "3 of 4 watched", with a cell for each thread Watcher may work with, from a computer that keeps no standing watches.
    private func meter(_ page: WatcherPage) -> some View {
        HStack(spacing: Space.s2) {
            HStack(spacing: 3) {
                ForEach(0..<max(page.inFlightLimit, 1), id: \.self) { cell in
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(cell < page.inFlight ? Palette.ink : Palette.ink.opacity(0.25))
                        .frame(width: 5, height: 16)
                }
            }
            .accessibilityHidden(true)
            Text(WatcherWords.meter(page)).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink).lineLimit(1)
        }
        .padding(.horizontal, Space.s4)
        .frame(minHeight: 44)
        .background(Palette.fillSoft, in: Capsule())
        .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Watched threads")
        .accessibilityValue(WatcherWords.meter(page))
        .accessibilityIdentifier("watcher-meter")
    }

    @ViewBuilder private func stopButton(_ page: WatcherPage) -> some View {
        if model.offersWatcherStop(hostID) && !page.watched.isEmpty {
            Button(action: stopAll) {
                HStack(spacing: 6) {
                    if model.watcherStopping.contains(hostID) { ProgressView().controlSize(.mini) }
                    Text("Stop all")
                }
            }
            .buttonStyle(PillButtonStyle(kind: .danger))
            .disabled(!model.online(hostID) || model.watcherStopping.contains(hostID))
            .accessibilityHint("Asks first, then stops the threads Watcher started")
            .accessibilityIdentifier("watcher-stop-all")
        }
    }
}

/// A thread Watcher works with, as Threads draws a working card, with what Watcher last did with it. It opens the thread
/// where this iPhone lists it. Where watching lasts until the user stops it, Stop watching sits at its foot.
private struct WatchedCard: View {
    let thread: WatcherPage.WatchedThread
    let computer: String
    let listed: ThreadSummary?
    let doing: String?
    /// Stops watching the thread, on a computer that takes it from this iPhone.
    let stop: (() -> Void)?
    let stopping: Bool
    let canStop: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            opener
            if let stop { foot(stop) }
        }
        .overlay(alignment: .bottom) { if running { Runner() } }
        .sottoCard(running ? .working : .plain)
    }
    @ViewBuilder private var opener: some View {
        if listed != nil {
            NavigationLink(value: ThreadRoute(ref: thread.target.ref)) { summary }
                .buttonStyle(PressStyle())
                .accessibilityLabel(spoken)
                .accessibilityHint("Opens the thread")
                .accessibilityIdentifier("watched-\(thread.target.ref.id)")
        } else {
            summary.accessibilityElement(children: .ignore).accessibilityLabel(spoken)
                .accessibilityIdentifier("watched-\(thread.target.ref.id)")
        }
    }
    private var running: Bool { WatcherWords.status(thread) == "Working" }
    private var summary: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s2) {
                Light(tone: running ? .accent : thread.status == "error" ? .danger : .off, breathing: running)
                Text(WatcherWords.status(thread)).font(.sotto(.caption, .semibold))
                    .foregroundStyle(running ? Palette.accentText : thread.status == "error" ? Palette.dangerText : Palette.muted)
                Spacer(minLength: Space.s2)
                if running, let since = Words.date(listed?.summary?.runningTurnStartedAt) {
                    ElapsedText(since: since).font(.sotto(.caption, .semibold).monospacedDigit()).foregroundStyle(Palette.muted)
                }
            }
            .frame(minHeight: 18)
            Text(thread.title).font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s2)
            PlaceLine(providerID: thread.provider, watched: true, text: "\(AgentNames.name(thread.provider)) on \(computer)")
                .padding(.top, Space.s1)
            if let doing {
                Text(doing).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Space.s2)
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s4)
        .padding(.bottom, stop == nil ? Space.s4 : Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
    private func foot(_ stop: @escaping () -> Void) -> some View {
        HStack(spacing: Space.s2) {
            Spacer(minLength: 0)
            Button(action: stop) {
                HStack(spacing: 6) {
                    if stopping { ProgressView().controlSize(.mini) }
                    Text("Stop watching")
                }
            }
            .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
            .disabled(!canStop)
            .accessibilityLabel("Stop watching \(thread.title)")
            .accessibilityIdentifier("watched-stop-\(thread.target.ref.id)")
        }
        .padding(.horizontal, Space.s4)
        .padding(.bottom, Space.s3)
    }
    private var spoken: String {
        var words = "\(thread.title), \(WatcherWords.status(thread)), \(AgentNames.name(thread.provider)) on \(computer)" + WatchedWords.spoken(true)
        if let doing { words += ". " + doing }
        return words
    }
}

/// Watch a thread: the threads this iPhone lists that Watcher could watch, as Threads orders them. A press watches one at
/// once and closes the list; what it did is said with Undo.
private struct WatchPicker: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    @Environment(\.dismiss) private var dismiss
    let hostID: String
    var body: some View {
        let rows = model.watchableThreads
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s3) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                    Text("Watch a thread").font(.sotto(.title, .bold)).tracking(-0.4).foregroundStyle(Palette.ink)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: Space.s2)
                    Button("Cancel") { dismiss() }
                        .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                        .keyboardShortcut(.cancelAction)
                }
                Text("Watcher on \(model.name(hostID)) keeps it going and brings you its questions and permissions, until you stop it.")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                if rows.isEmpty {
                    Text("Every thread this iPhone can reach is watched already, or settled.").font(.sotto(.body)).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true).padding(.vertical, Space.s6)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4) }
                            pickRow(row)
                        }
                    }
                    .sottoCard(.plain)
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s6)
            .padding(.bottom, Space.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .presentationBackground { SheetBackdrop(wash: false) }
        .presentationCornerRadius(Radius.xl)
    }
    private func pickRow(_ row: HostedThread) -> some View {
        let place = Words.place(row)
        return Button {
            dismiss()
            Task { await model.setWatched(row.ref, true, title: row.thread.title) }
        } label: {
            HStack(alignment: .center, spacing: Space.s3) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.thread.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    PlaceLine(providerID: row.thread.providerId, watched: false, text: place)
                }
                Spacer(minLength: Space.s2)
                WatcherOwlMark(size: 18).foregroundStyle(Palette.accentText).accessibilityHidden(true)
            }
            .padding(.horizontal, Space.s4)
            .padding(.vertical, Space.s3)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .disabled(!model.canChangeWatch(row.ref))
        .accessibilityLabel("Watch \(row.thread.title)")
        .accessibilityValue(place)
        .accessibilityIdentifier("watch-pick-\(row.ref.id)")
    }
}

/// What the last Watch or Stop watching press did, for eight seconds, with Undo; over a thread's reply box for that
/// thread (`scope`), or on Watched for any. It never takes focus: VoiceOver hears it, and Watch or Stop watching where the
/// press was made is the way back once it has gone.
struct WatchToast: View {
    @EnvironmentObject var model: AppModel
    /// The thread whose page shows it; nil shows it for any thread.
    let scope: ThreadRef?
    /// Room around it, only while it shows.
    var margin = EdgeInsets()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        VStack(spacing: 0) {
            if let notice = model.watchNotice, scope == nil || scope == notice.target {
                HStack(spacing: Space.s3) {
                    WatcherOwlMark(size: 18).foregroundStyle(Palette.accentText).accessibilityHidden(true)
                    Text(notice.words).font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Undo") { Task { await model.undoWatch(notice) } }
                        .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                        .disabled(!model.canChangeWatch(notice.target))
                        .accessibilityLabel(notice.undo)
                        .accessibilityIdentifier("watch-undo")
                }
                .padding(.leading, Space.s4)
                .padding(.trailing, Space.s2)
                .padding(.vertical, Space.s1)
                .glass(in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous), strong: true)
                .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .bottom).combined(with: .opacity))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("watch-toast")
                .task(id: notice.id) { UIAccessibility.post(notification: .announcement, argument: notice.words) }
                .padding(margin)
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.85), value: model.watchNotice)
    }
}

/// A thread Watcher no longer works with, and why.
private struct LeftRow: View {
    let thread: WatcherPage.WatchedThread
    let computer: String
    let listed: Bool
    var body: some View {
        if listed {
            NavigationLink(value: ThreadRoute(ref: thread.target.ref)) { row }
                .buttonStyle(PressStyle())
                .accessibilityLabel(spoken)
                .accessibilityHint("Opens the thread")
        } else {
            row.accessibilityElement(children: .ignore).accessibilityLabel(spoken)
        }
    }
    private var row: some View {
        HStack(alignment: .top, spacing: Space.s3) {
            Light(tone: .off).padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                PlaceLine(providerID: thread.provider, watched: false,
                          text: "\(WatcherWords.left(thread)) · \(AgentNames.name(thread.provider)) on \(computer)")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s3 + 2)
        .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
        .contentShape(Rectangle())
    }
    private var spoken: String { "\(thread.title), \(WatcherWords.left(thread)), \(AgentNames.name(thread.provider)) on \(computer)" }
}
