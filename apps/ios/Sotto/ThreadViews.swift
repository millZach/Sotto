import SwiftUI
import UIKit
import SafariServices
import SottoCore

/// One thread, as thread page B draws it (ADR-0051): only a slim bar stays pinned (back, the thread's state, and its
/// title once the big one has scrolled off). The big title, where the thread runs and its branch chips scroll away with
/// the conversation, and the agent's steps sit between the messages in time order, each run folded into one line that
/// opens in place. A waiting question or permission opens as a sheet; dismissed, the reply box offers it again.
/// Everything here goes to the thread's own computer. The iPhone Duo has neither the bar nor the big title: the thread's
/// controls stand on its rail, and its name and chips behind ••• (Zach's picks, November 3, 2026).
struct ThreadView: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    /// A delegated thread opened from Agents, on the page of the thread that delegated it: Back goes to that thread.
    var nested = false
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
    @Environment(\.duoLayout) private var duo
    @Environment(\.dismiss) private var dismiss
    private var thread: ThreadSummary? { model.thread(ref) }
    /// The folded Duo's cover screen, where the rail's thread controls take the tabs' place (`FoldedThreadRail`).
    private var folded: Bool { if case .folded = duo { return true } else { return false } }
    /// The iPhone Duo, folded or unfolded, where a thread has no bar (ADR-0151, November 3 amendment): its controls stand
    /// on the rail. Every other iPhone keeps its bar.
    private var barless: Bool { duo != .none }

    var body: some View {
        let _ = BenchProbe.body("ThreadView")
        Conversation(ref: ref, stuck: $stuck, titled: $titled) { request in
            shown = request.id
            open = request
        }
        .pageGround()
        // With no bar over it, the page's own ground keeps its words from the clock and battery.
        .overlay(alignment: .top) { if barless { StatusBarFade() } }
        .navigationTitle(thread?.title ?? String(localized: "Thread", comment: "Title for a thread that has no title yet"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { barTitle }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: Space.s1) {
                    if let agents = model.agentsCount(ref) { AgentsButton(count: agents) { agentsOpen = true } }
                    barPill
                    if model.watchHost(for: ref) != nil, thread.map(ThreadGroups.offersWatch) ?? true { WatchToggle(ref: ref, title: thread?.title) }
                    if model.compactionOffered(ref) || model.shelfAction(ref) != nil { ThreadMenu(ref: ref) }
                }
                // Where the bar is short, iOS gives the group its smallest size, which squeezed Agents' and Watch's words
                // to nothing; held at its own size, the title gives way instead.
                .fixedSize()
            }
            .horizontalOnly()
        }
        .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
        .toolbarBackground(stuck ? .visible : .hidden, for: .navigationBar)
        .toolbar(barless ? .hidden : .automatic, for: .navigationBar)
        // With no bar, iOS's own swipe back is kept where nothing else takes the drag: on the cover screen, and for a
        // delegated thread, which goes back to its thread. Unfolded, a drag on any other thread moves the sidebar.
        .background { InteractivePop(enabled: folded || (barless && nested)).frame(width: 0, height: 0).accessibilityHidden(true) }
        .toolbar(.hidden, for: .tabBar)
        .coversTabs()
        .onChange(of: model.railAsked) { _, asked in
            guard let asked, asked.ref == ref else { return }
            model.railAsked = nil
            switch asked.action {
            case .back: dismiss()
            case .agents: agentsOpen = true
            }
        }
        // While a request sheet is up its keyboard never squeezes the page behind it, so the conversation keeps its
        // size and its place.
        .ignoresSafeArea(open != nil ? SafeAreaRegions.keyboard : [], edges: .bottom)
        .task(id: ref) { await model.select(ref); offer() }
        .onAppear { if nested { model.railNested = ref } }
        .onDisappear {
            if nested, model.railNested == ref { model.railNested = nil }
            Task { if model.selected == ref { await model.select(nil) } }
        }
        .onChange(of: thread?.requests.map(\.id)) { _, _ in offer() }
        .duoSheet(item: $open, wash: true, onDismiss: { if let shown { setAside.insert(shown) }; shown = nil; offer() }) { request in
            RequestSheet(ref: ref, request: request).requestSheetDetents().overThread()
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

/// A thread's controls in the folded Duo's strip, in place of the tabs (ADR-0151, amended): Back where New thread stands
/// on the other pages, under the clock and battery, and low down the thread's pill where the tabs' pill stands. The tabs
/// come back with the list, and a swipe in from the left edge goes back too.
struct FoldedThreadRail: View, Equatable {
    /// The thread showing, once its page has read it.
    let ref: ThreadRef?
    let clear: CGFloat
    let back: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            RailBackButton(back: back)
            Spacer(minLength: Space.s3)
            if let ref { ThreadRailPill(ref: ref) }
        }
        .padding(.top, clear)
        .padding(.bottom, Space.s5)
        // No lower limit on the height: with the keyboard up, a rail taller than the page would rise past the clock.
        .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        .ignoresSafeArea(.keyboard)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("duo-thread-rail")
    }
    /// It draws the thread and its place under the clock; Back never changes what it draws.
    static func == (lhs: FoldedThreadRail, rhs: FoldedThreadRail) -> Bool { lhs.ref == rhs.ref && lhs.clear == rhs.clear }
}

/// Back on the Duo's rail, the same round button as New thread. The thread showing goes back itself (`popThread`).
struct RailBackButton: View {
    let back: () -> Void
    var body: some View {
        Button(action: back) { Image(systemName: "chevron.backward") }
            .buttonStyle(GlassCircleStyle(flatOnDuo: true))
            .accessibilityLabel(String(localized: "Back"))
            .accessibilityIdentifier("duo-rail-back")
    }
}

/// A thread's state, Agents, Watch and ••• in one pill on the Duo's rail, the same pill and tiles as the tabs (Zach's pick
/// A, November 3, 2026). Folded it stands in the tabs' place; unfolded it stands over them, and its state says how long
/// the thread has been at it.
struct ThreadRailPill: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    var body: some View {
        let thread = model.thread(ref)
        VStack(spacing: DuoRailMetrics.tileGap) {
            Group {
                ThreadStatePill(state: thread.map { ThreadState($0) } ?? .done, since: Words.date(thread?.summary?.runningTurnStartedAt),
                                reachable: model.status(ref.hostID) != .unreachable, vertical: true)
                if let agents = model.agentsCount(ref) { AgentsButton(count: agents, tile: true) { model.railAsked = RailAsk(ref: ref, action: .agents) } }
                if model.watchHost(for: ref) != nil, thread.map(ThreadGroups.offersWatch) ?? true { WatchToggle(ref: ref, title: thread?.title, tile: true) }
            }
            // As the tabs' names do, they stay at this size; a tile has no room to grow. ••• is left out, since its icon
            // doesn't grow and the pull request's sheet it opens takes the user's own text size.
            .dynamicTypeSize(...DynamicTypeSize.large)
            ThreadMenu(ref: ref, onRail: true)
        }
        .padding(DuoRailMetrics.pillInset)
        .background { DuoRailPillGround().accessibilityHidden(true) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("duo-thread-pill")
    }
}

/// Keeps iOS's swipe back on a page whose navigation bar is hidden, which otherwise loses it, while `enabled`. It answers
/// the stack's swipe only while there is a page to go back to, and gives the swipe back to iOS when the page goes.
struct InteractivePop: UIViewControllerRepresentable {
    let enabled: Bool
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) { controller.enabled = enabled; controller.apply() }
    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        var enabled = false
        private weak var kept: UIGestureRecognizerDelegate?
        private var holding = false
        override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); apply() }
        override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); release() }
        func apply() {
            guard let pop = navigationController?.interactivePopGestureRecognizer else { return }
            guard enabled else { release(); return }
            if !holding { kept = pop.delegate; pop.delegate = self; holding = true }
            pop.isEnabled = true
        }
        private func release() {
            guard holding, let pop = navigationController?.interactivePopGestureRecognizer else { return }
            pop.delegate = kept
            holding = false
        }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            (navigationController?.viewControllers.count ?? 0) > 1
        }
    }
}

extension View {
    /// Counts this sheet as standing over a thread while it shows (`AppModel.sheetsOverThread`).
    func overThread() -> some View { modifier(OverThread()) }
}
private struct OverThread: ViewModifier {
    @EnvironmentObject var model: AppModel
    func body(content: Content) -> some View {
        content
            .onAppear { model.sheetsOverThread += 1 }
            .onDisappear { model.sheetsOverThread = max(0, model.sheetsOverThread - 1) }
    }
}

extension ToolbarContent {
    /// Keeps an item in the bar over the page. Where iOS 27.1 stands a vertical bar beside the page, as in the iPhone
    /// Duo cover screen's strip, it would otherwise move the item there, where only an icon fits (ADR-0151, amended).
    /// CI's Xcode 26.6 has no iOS 27.1 SDK, hence the compiler check (Swift 6.4 came with Xcode 27).
    @ToolbarContentBuilder func horizontalOnly() -> some ToolbarContent {
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) { axisBehavior(.horizontalOnly) } else { self }
        #else
        self
        #endif
    }
}

/// The thread's state in the bar, in a word: a light, the word and, while it works, how long it has been at it, except at
/// compact width, where the bar's room goes to the thread's title.
struct ThreadStatePill: View {
    let state: ThreadState
    let since: Date?
    let reachable: Bool
    /// Stacked in one tile of the Duo's rail: the light and the word.
    var vertical = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.duoLayout) private var duo
    var body: some View {
        if vertical, duo != .upright {
            // Folded and sideways, the light and the word alone, the word at the sidebar row's second-line size where it
            // had been the smallest words on the page. The tile keeps its width, so Needs you takes two lines, centred,
            // and a single word shrinks rather than breaking. How long it has been at it goes to VoiceOver only (Zach's
            // round 7 pick B, November 10, 2026). A point under that size and tracked a little tighter, Working keeps
            // about 7 points each side of it in the tile, where it had nearly touched both (his round 8 pick A, November
            // 10, 2026).
            TimelineView(.periodic(from: Date(), by: 15)) { context in
                VStack(spacing: 2) {
                    light
                    Text(railWord).font(.sotto(.small, .semibold, times: 12.5 / TextScale.small.size)).tracking(-0.3)
                        .lineLimit(railWord.contains(" ") ? 2 : 1).multilineTextAlignment(.center).minimumScaleFactor(0.6)
                }
                .frame(width: DuoRailMetrics.tile, height: DuoRailMetrics.tile)
                .foregroundStyle(foreground)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(railLabel(at: context.date))
                .accessibilityIdentifier("thread-state")
            }
        } else {
            pill
        }
    }
    private var pill: some View {
        Group {
            if vertical {
                VStack(spacing: 2) {
                    light
                    // Upright, every state word stays on one line, Needs you too, a little tighter and shrinking rather
                    // than breaking, with room either side inside the tile (the Duo design climb's round 6). Only Can't
                    // reach it, a phrase, may take two lines.
                    Text(railWord).tracking(-0.2).lineLimit(reachable ? 1 : 2).multilineTextAlignment(.center).minimumScaleFactor(0.6)
                        .padding(.horizontal, Space.s1)
                    // How long it has been at it, in minutes, "12m", where "12m 14s" filled the tile to its edges (Zach's
                    // pick B, round 4). VoiceOver reads the state alone, as before.
                    if reachable, state.workInProgress, let since {
                        TimelineView(.periodic(from: Date(), by: 15)) { context in
                            Text(Words.runShort(context.date.timeIntervalSince(since))).lineLimit(1).minimumScaleFactor(0.6)
                        }
                    }
                }
                .frame(width: DuoRailMetrics.tile, height: DuoRailMetrics.tile)
                .foregroundStyle(foreground)
            } else {
                HStack(spacing: 6) {
                    light
                    Text(word)
                    if reachable, state.workInProgress, sizeClass == .regular, let since { ElapsedText(since: since) }
                }
                .lineLimit(1)
                .padding(.leading, Space.s3)
                .padding(.trailing, 10)
                .frame(minHeight: 28)
                .foregroundStyle(foreground)
                .background(background, in: Capsule())
                .fixedSize()
            }
        }
        .font(.sotto(.caption, .semibold).monospacedDigit())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenState)
        .accessibilityIdentifier("thread-state")
    }
    private var spokenState: String { reachable ? state.words : String(localized: "Can’t reach this computer") }
    /// The rail's tile no longer shows how long the thread has been at it, so VoiceOver says it after the state.
    private func railLabel(at now: Date) -> String {
        guard reachable, state.workInProgress, let since else { return spokenState }
        return "\(spokenState), \(Words.runSpoken(now.timeIntervalSince(since)))"
    }
    @ViewBuilder private var light: some View {
        if reachable { StatusDot(state: state, size: 7) } else { Light(tone: .off, size: 7) }
    }
    /// On the rail a finished thread says Finished, the Agents sheet's word, where Done read like the teal Done that
    /// closes every sheet (Zach's pick A, November 9, 2026).
    private var railWord: String {
        reachable && state == .done ? String(localized: "Finished", comment: "The heading over delegated threads and agents that have stopped working.") : word
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
/// what it did is said over the reply box with Undo. Its name stays Watch and its value says whether it is on; its hint
/// says what the lit owl can't, where a send here takes the thread over or Watcher only steers. Only where
/// a computer that runs Watcher takes it from this iPhone; at compact width, where the bar's room goes to the thread's
/// title, and at the largest text sizes it is the owl alone.
struct WatchToggle: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let title: String?
    /// Drawn as a tile of the Duo's rail: the owl alone, on the accent's soft tile while Watcher watches.
    var tile = false
    @State private var presses = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        let watched = model.watchedByWatcher(ref)
        let compact = typeSize.isAccessibilitySize || sizeClass != .regular
        Button { presses += 1; Task { await model.setWatched(ref, !watched, title: title) } } label: {
            if tile {
                // A smaller owl with a + at its corner, a check once on, so Watch reads as a switch and can't pass for
                // the Watcher tab's owl a thumb below it (Zach's pick B, November 9, 2026).
                Group {
                    if model.changingWatch(ref) { ProgressView().controlSize(.mini) } else {
                        WatcherOwlMark(size: DuoRailMetrics.owl - 4).accessibilityHidden(true)
                            .overlay(alignment: .bottomTrailing) {
                                Image(systemName: watched ? "checkmark" : "plus")
                                    .font(.system(size: 7, weight: .heavy))
                                    .foregroundStyle(watched ? theme.color(.onAccent) : theme.color(.ink))
                                    .frame(width: 14, height: 14)
                                    .background(Circle().fill(watched ? theme.color(.accent) : theme.color(.fillSoft)))
                                    .overlay(Circle().strokeBorder(watched ? theme.color(.accentSurface) : theme.color(.canvas), lineWidth: 1.5))
                                    .offset(x: 6, y: 5)
                                    .accessibilityHidden(true)
                            }
                    }
                }
                .foregroundStyle(watched ? Palette.accentText : Palette.muted)
                .frame(width: DuoRailMetrics.tile, height: DuoRailMetrics.tile)
                .background { if watched { Circle().fill(Palette.accent.opacity(Tint.accentPill)) } }
                .contentShape(Circle())
            } else {
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
        }
        .buttonStyle(PressStyle())
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: watched)
        .sensoryFeedback(.selection, trigger: presses)
        .disabled(!model.canChangeWatch(ref))
        .accessibilityLabel("Watch")
        .accessibilityValue(watched ? String(localized: "On", comment: "Whether Watcher watches this thread") : String(localized: "Off", comment: "Whether Watcher watches this thread"))
        // What the line over the reply box said goes here, ahead of what a press does (ADR-0073, October 31 amendment).
        .accessibilityHint(watched ? [model.watchFact(ref), String(localized: "Stops Watcher watching this thread")].compactMap { $0 }.joined(separator: " ")
                           : String(localized: "Watcher keeps this thread going until you stop it"))
        .accessibilityIdentifier("thread-watch")
    }
}

/// The thread's actions behind ••• beside its state: Compact context, while the thread's provider offers it, and Settle
/// or Restore, as on the desktop. A press asks the thread's computer; one that can't go now says why under its name.
/// Compacting shows its progress in the bar, and a confirmed Settle or Restore says so in the banner. On the Duo's rail,
/// where a thread has no bar or big title, it also holds what they said: the thread's name, where it runs, its branch and
/// changes, and its pull request, which opens as the chip does elsewhere (Zach's pick, November 3, 2026).
struct ThreadMenu: View {
    @EnvironmentObject var model: AppModel
    /// Watched so whether there is history to compact follows the thread as it is read.
    @EnvironmentObject var detailStore: DetailStore
    let ref: ThreadRef
    /// On the Duo's rail: a tile, with the thread's name and chips at the top of the menu.
    var onRail = false
    @State private var acted = 0
    @State private var showingPullRequest = false
    @State private var showingCard = false
    /// Whether the rail stands on the left, as Settings can put it sideways, so the card opens toward the page.
    @State private var railOnLeft = false
    @Environment(\.sottoTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let chips = GitChips(model.thread(ref)?.worktree)
        Group {
            if onRail {
                Button { showingCard = true } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: DuoRailMetrics.symbol, weight: .medium))
                        .foregroundStyle(Palette.muted)
                        .frame(width: DuoRailMetrics.tile, height: DuoRailMetrics.tile)
                        .contentShape(Circle())
                }
                .buttonStyle(PressStyle())
                .onGeometryChange(for: Bool.self, of: { $0.frame(in: .global).midX < 240 }) { railOnLeft = $0 }
                .popover(isPresented: $showingCard, attachmentAnchor: .rect(.bounds), arrowEdge: railOnLeft ? .leading : .trailing) {
                    // A solid card a step off the sheets, like Sotto's cards, where iOS's glass showed a moving light that
                    // read as a smudge, and the thread's reply box steps away while it is open, as it does beside a sheet
                    // (Zach's pick A, November 9, 2026, round 4). Its fill is the overlay surface, a step past a card's,
                    // so its edge reads against the words it covers rather than the page running into it (his round 6
                    // pick A, November 10, 2026). A 1-point hairline and a soft shadow give it an edge against the
                    // running text it cuts, with the page under it still undimmed (his round 8 pick A, November 10, 2026).
                    railCard(chips).presentationCompactAdaptation(.popover)
                        .background { PopoverEdge(ink: theme.rgb(.ink), dark: scheme == .dark).accessibilityHidden(true) }
                        .presentationBackground(Palette.overlay)
                        .overThread()
                }
            } else {
                Menu { actions } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.ink)
                        .frame(width: 32, height: 32)
                        .background(Palette.fillSoft, in: Circle())
                        .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 1))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
            }
        }
        .accessibilityLabel("Show thread actions")
        .accessibilityIdentifier("thread-actions")
        .sensoryFeedback(.impact(weight: .medium), trigger: acted)
        .duoSheet(isPresented: $showingPullRequest, toFoot: true) {
            if let url = chips.pullRequestURL, let number = chips.pullRequest?.number {
                PullRequestSheet(ref: ref, url: url, number: number).overThread()
            }
        }
    }

    /// What the thread can do: compact its context, and settle or restore it.
    @ViewBuilder private var actions: some View {
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
    }

    /// On the rail: Sotto's own card, because iOS dims a menu's heading too far to read and this is the only place these
    /// show (Zach's pick B, November 8, 2026). The name at full strength, each fact on its own line with its mark, the pull
    /// request as a row where this computer offers its sheet (where it doesn't, it reads with the facts, as its chip does),
    /// and the actions.
    private func railCard(_ chips: GitChips) -> some View {
        let thread = model.thread(ref)
        let opens = model.offersPullRequestSheet(ref.hostID) && chips.pullRequestURL != nil
        let place = model.placeLine(ref, provider: Words.provider(thread?.providerId), computer: model.name(ref.hostID))
        let card = VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: Space.s1) {
                Text(verbatim: thread?.title ?? String(localized: "Thread", comment: "Title for a thread that has no title yet"))
                    .font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, Space.s1)
                    .accessibilityAddTraits(.isHeader)
                fact("laptopcomputer") { Text(verbatim: place) }
                if let branch = chips.branch { fact("arrow.triangle.branch") { Text(verbatim: Self.breaksAtSlashes(branch)) } }
                if let changes = chips.changes {
                    // Its plus and minus are small and thin beside the other marks, so it is drawn a step larger and
                    // heavier to read as strongly as they do (the Duo design climb's round 6).
                    fact("plus.forwardslash.minus", size: 14, weight: .bold) {
                        HStack(spacing: Space.s1) {
                            Text(verbatim: "+\(changes.insertions)").foregroundStyle(Palette.accentText)
                            Text(verbatim: "−\(changes.deletions)").foregroundStyle(Palette.dangerText)
                        }
                    }
                }
                if !opens, let pullRequest = chips.pullRequest { fact("arrow.triangle.pull") { Text(verbatim: caption(pullRequest)) } }
            }
            .padding(.horizontal, Space.s4)
            .padding(.vertical, Space.s3)
            if opens, let pullRequest = chips.pullRequest, let url = chips.pullRequestURL {
                let checks = model.lastPullRequest(ref, url: url).map { PullRequests.rollup($0.checks) }
                Rectangle().fill(Palette.hairline).frame(height: 1)
                cardRow(caption(pullRequest), detail: checks, icon: "arrow.triangle.pull", chevron: true, identifier: "thread-menu-pull-request") {
                    // The sheet can't rise while the card is still going.
                    Task { try? await Task.sleep(nanoseconds: 350_000_000); showingPullRequest = true }
                }
                .accessibilityLabel(GitChipRow.spokenPullRequest(pullRequest, rollup: checks))
            }
            if model.compactionOffered(ref) || model.shelfAction(ref) != nil { Rectangle().fill(Palette.hairline).frame(height: 1) }
            cardActions
        }
        .frame(width: 292, alignment: .leading)
        // At the largest text sizes the card can outgrow the screen; then it scrolls.
        return ViewThatFits(in: .vertical) { card; ScrollView { card } }
    }

    /// A branch's name for a line that wraps: it may break after a slash, never after a hyphen, so
    /// "feat/frosted-window-and-pane-terminal" no longer reads as a hyphenated word cut in two. A zero-width space after
    /// each slash offers the break, and a word joiner after each hyphen holds it (Zach's pick A, round 4).
    static func breaksAtSlashes(_ branch: String) -> String {
        branch.replacingOccurrences(of: "/", with: "/\u{200B}").replacingOccurrences(of: "-", with: "-\u{2060}")
    }

    private func fact<Content: View>(_ icon: String, size: CGFloat = 12, weight: Font.Weight = .medium,
                                     @ViewBuilder words: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
            Image(systemName: icon).iconFont(size, weight: weight).foregroundStyle(Palette.muted).frame(width: 18).accessibilityHidden(true)
            words().font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    /// The same actions as `actions`, as the card's rows.
    @ViewBuilder private var cardActions: some View {
        if model.compactionOffered(ref) {
            let held = model.compactionHeld(ref)
            cardRow(String(localized: "Compact context"), detail: held ?? String(localized: "Summarize earlier messages to free room"), enabled: held == nil) {
                acted += 1
                Task { await model.compact(ref) }
            }
        }
        if let action = model.shelfAction(ref) {
            let held = model.actionHeld(ref)
            cardRow(action == .settle ? String(localized: "Settle", comment: "Settle the thread: put it away on the Settled shelf.")
                    : String(localized: "Restore", comment: "Restore a settled thread to open work."),
                    detail: held, identifier: action == .settle ? "thread-settle" : "thread-restore", enabled: held == nil) {
                acted += 1
                Task { await model.shelve(ref, action) }
            }
        }
    }

    private func cardRow(_ title: String, detail: String?, icon: String? = nil, chevron: Bool = false, identifier: String = "",
                         enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button {
            showingCard = false
            action()
        } label: {
            // The marks stand in one column with the facts' above, and every row's words start at one edge with theirs,
            // a row without a mark included (round 5).
            HStack(spacing: Space.s2) {
                Group {
                    if let icon { Image(systemName: icon).iconFont(14, weight: .medium).foregroundStyle(Palette.muted) } else { Color.clear.frame(height: 1) }
                }
                .frame(width: 18)
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: title).font(.sotto(.body)).foregroundStyle(enabled ? Palette.ink : Palette.muted)
                    if let detail { Text(verbatim: detail).font(.sotto(.caption)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true) }
                }
                Spacer(minLength: 0)
                if chevron { Image(systemName: "chevron.right").iconFont(12, weight: .semibold).foregroundStyle(Palette.muted).accessibilityHidden(true) }
            }
            .padding(.horizontal, Space.s4)
            .padding(.vertical, Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .disabled(!enabled)
        .accessibilityIdentifier(identifier)
    }

    private func caption(_ pullRequest: GitChips.PullRequest) -> String {
        String(localized: "#\(String(pullRequest.number)) \(pullRequest.stateWord)", comment: "A pull request chip: its number, then its state, such as #721 open")
    }
}

/// The ••• card's edge: a 1-point hairline round the card and a soft shadow under it. iOS draws a popover's frame itself,
/// so this reaches the views it drew from inside the card: the shadow goes on the popover as a whole, so it follows the
/// arrow too, and the hairline on the rounded view that clips the card, so it follows the card's corners. Where no such
/// view is found the hairline goes on the card's own view at a sheet card's corner.
private struct PopoverEdge: UIViewRepresentable {
    /// The theme's text colour, which the hairline is a wash of.
    let ink: ThemeRGB
    let dark: Bool
    func makeUIView(context: Context) -> EdgeView { EdgeView(frame: .zero) }
    func updateUIView(_ view: EdgeView, context: Context) {
        view.hairline = ink.uiColor(dark ? 0.17 : 0.14).cgColor
        view.shadow = (opacity: dark ? 0.55 : 0.16, radius: dark ? 16 : 15)
        view.apply()
    }
    final class EdgeView: UIView {
        var hairline: CGColor?
        var shadow: (opacity: Float, radius: CGFloat) = (0, 0)
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { fatalError("PopoverEdge is made in code") }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }
        override func layoutSubviews() {
            super.layoutSubviews()
            apply()
        }
        func apply() {
            guard window != nil, let presented = presentedController, let content = presented.view,
                  let container = presented.presentationController?.containerView,
                  let popover = container.subviews.first(where: { isDescendant(of: $0) }) else { return }
            popover.clipsToBounds = false
            popover.layer.shadowColor = UIColor.black.cgColor
            popover.layer.shadowOpacity = shadow.opacity
            popover.layer.shadowRadius = shadow.radius
            popover.layer.shadowOffset = CGSize(width: 0, height: 10)
            var rounded: UIView?
            var view: UIView? = content
            while let step = view, step !== container {
                if step.layer.cornerRadius > 0 { rounded = step; break }
                view = step.superview
            }
            let edge = rounded ?? content
            if rounded == nil {
                edge.layer.cornerRadius = Radius.lg
                edge.layer.cornerCurve = .continuous
            }
            edge.layer.borderWidth = 1
            edge.layer.borderColor = hairline
        }
        /// The controller iOS presented as the popover: the topmost parent of the controller this view is in.
        private var presentedController: UIViewController? {
            var responder: UIResponder? = self
            while let next = responder, !(next is UIViewController) { responder = next.next }
            var controller = responder as? UIViewController
            while let parent = controller?.parent { controller = parent }
            return controller
        }
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
    /// Where the end sits within the page itself, which only what the page holds moves; scrolling moves `sentinel` alone.
    var endInPage: CGFloat = 0
    func settle() { atBottom = sentinel <= dockTop + Self.slack }
}

/// A message, or a run of steps, as the conversation draws it.
/// A rule across the conversation naming the model a thread moved from and to (ADR-0171), as quiet as a step's line.
private struct ModelMovedLine: View {
    let words: String
    var body: some View {
        HStack(spacing: Space.s2) {
            Rectangle().fill(Palette.hairline).frame(height: 1)
            Text(verbatim: words).font(.sotto(.caption)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                .layoutPriority(1)
            Rectangle().fill(Palette.hairline).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-model-moved")
    }
}

private struct ConversationRow: Identifiable, Equatable {
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
    /// The index of the first row of the latest turns, which the page lays out whole; the rows before it are made as
    /// they scroll into view. Set with the rows.
    private(set) var latestTurnsStart = 0
    /// That row's identity, so a split held for a selection can be found again in the next revision's rows.
    private var latestTurnsStartID: String?
    private var dates: [String: Date] = [:]
    /// `held` marks the copy kept on screen while the thread is read again. A fresh copy can carry the same revision, from
    /// a computer whose Sotto restarted, so it is always drawn anew.
    func rows(for detail: ThreadDetail?, held: Bool = false) -> [ConversationRow] {
        guard let detail else {
            key = nil
            cached = []
            latestTurnsStart = 0
            latestTurnsStartID = nil
            return []
        }
        let next = detail.threadId + "#" + String(detail.revision) + (held ? "#held" : "")
        if next == key { return cached }
        key = next
        if dates.count > 10_000 { dates = [:] }
        cached = BenchProbe.time("timeline.rows") {
            let items = ThreadTimeline.items(messages: detail.messages, activities: detail.activities ?? [],
                                             earlierAvailable: detail.earlierAvailable == true, date: { self.date($0) })
            var start = ThreadTimeline.latestTurnsStart(items)
            // A new turn moves the oldest whole turn into the lazy stack, which makes its rows again. While words in a
            // reply are selected the split stays where it was, so the selection and its Add to prompt survive (ADR-0129).
            if !ReplySelection.views.isEmpty, let held = self.latestTurnsStartID,
               let index = items.firstIndex(where: { $0.id == held }), index < start {
                start = index
            }
            self.latestTurnsStart = start
            self.latestTurnsStartID = start < items.count ? items[start].id : nil
            return ConversationRow.make(items, date: { self.date($0) })
        }
        return cached
    }
    private func date(_ stamp: String) -> Date? {
        if let known = dates[stamp] { return known }
        guard let parsed = Stamp.date(stamp) else { return nil }
        dates[stamp] = parsed
        return parsed
    }
}

/// Everything besides their rows that the turns before the latest are drawn from.
private struct OlderTurnsInputs: Equatable {
    let ref: ThreadRef
    let provider: String
    let working: String?
    let last: String?
    let movedAfter: String?
    let movedWords: String?
    let openRuns: Set<String>
    let showsPictures: Bool
    let opensFiles: Bool
    let spacing: CGFloat
}

/// The turns before the latest, made as they scroll into view. They are drawn again only when they or what they are
/// drawn from change, not for each word streamed into the latest turn: given its rows again, the lazy stack guessed
/// the heights of the rows it hadn't made afresh each time, the page's height swung by tens of thousands of points
/// under a reply, and a reader at the end was thrown far above it and back.
private struct OlderTurns<Row: View>: View, Equatable {
    let rows: ArraySlice<ConversationRow>
    let inputs: OlderTurnsInputs
    @ViewBuilder let row: (ConversationRow) -> Row
    static func == (a: Self, b: Self) -> Bool { a.inputs == b.inputs && a.rows == b.rows }
    var body: some View {
        LazyVStack(alignment: .leading, spacing: inputs.spacing) {
            ForEach(rows) { row($0) }
        }
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

/// The scrolling page: the wash, the big title and its chips, then messages and steps, with the reply box floating over
/// the bottom edge. The page keeps its place: while the user reads at the bottom it stays at the bottom when the
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
    @Environment(\.duoLayout) private var duo
    private static let end = "thread-end"
    private static let pageSpace = "thread-page"
    #if DEBUG
    /// The simulator journeys that pass `--ui-end-probe` read where the conversation's end sits from `EndProbe`.
    private static let probesEnd = ProcessInfo.processInfo.arguments.contains("--ui-end-probe")
    #endif

    var body: some View {
        let _ = BenchProbe.body("Conversation")
        let detail = model.shown(for: ref)
        let rows = timeline.rows(for: detail, held: detail != nil && model.detail(for: ref) == nil)
        let pending = model.replyRows(for: ref)
        let tail = Tail(revision: detail?.revision, rows: rows.count, last: rows.last?.id, pending: pending.map(\.id),
                        failed: model.failedReplies[ref.id] != nil)
        ScrollViewReader { proxy in
            ScrollView {
                page(detail: detail, rows: rows, pending: pending, scroll: proxy).readingWidth()
                    // Held sideways, the conversation's words are a step larger, so its broad lines are easier to follow
                    // from one to the next; folded is unchanged (Zach's pick A, November 9, 2026, round 5).
                    .environment(\.proseScale, duo.sideways ? 1.065 : 1)
                    .environment(\.replyQuoteBox, ReplyQuoteBox(key: ref.id) { [model, ref] in model.quoteReply($0, into: ref.id) })
                    .tapPutsAwayKeyboard { [model, ref] in !model.replyHoldsAnything(ref) }
                    .benchEnvironment("EnvironmentUnderThread")
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
            #if DEBUG
            .overlay(alignment: .topLeading) { if Self.probesEnd { EndProbe(follow: follow) } }
            #endif
            .safeAreaInset(edge: .bottom, spacing: 0) {
                // It floats, as the desktop's composer does: the conversation runs on under it with no ground behind
                // the box, and the inset still lets the last message scroll clear of it (Zach, October 31, 2026).
                // Only a new empty thread keeps the box full. One still opening goes by whether it has had a message.
                ReplyDock(ref: ref, goesSmall: !rows.isEmpty || !pending.isEmpty || detail?.earlierAvailable == true
                            || model.thread(ref)?.status == "running" || (detail == nil && model.thread(ref)?.summary?.lastMessageAt != nil),
                          openRequest: openRequest)
                    .equatable()
                    .readingWidth()
                    // On the Duo the box steps away while a sheet stands over the thread, where unfolded it showed past
                    // the sheet's edge (Zach's pick B, November 9, 2026).
                    .opacity(duo != .none && model.sheetsOverThread > 0 ? 0 : 1)
                    .animation(.easeInOut(duration: 0.2), value: model.sheetsOverThread > 0)
                    .background(dockReader(proxy))
                    .sendWatchDock()
            }
            .onChange(of: tail) { _, _ in
                if follow.atBottom { toBottom(proxy) }
            }
        }
        .fullScreenCover(item: $viewing) { PhotoViewer(opened: $0, box: .thread(ref)) }
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
    private func page(detail: ThreadDetail?, rows: [ConversationRow], pending: [ReplyRow], scroll: ScrollViewProxy) -> some View {
        let thread = model.thread(ref)
        let state = thread.map { ThreadState($0) } ?? .done
        return VStack(alignment: .leading, spacing: 0) {
            if duo == .none {
                ThreadHero(ref: ref, thread: thread, watched: model.watchedByWatcher(ref), pullRequest: pullRequestChip(thread),
                           topMoved: { top in follow.heroTop = top; refreshBar() },
                           titleMoved: { bottom in follow.titleBottom = bottom; refreshBar() })
                    .equatable()
            } else if case .folded = duo {
                // Folded, with no sidebar beside it to say which thread is open, the thread's name heads its conversation,
                // quiet and one line long, and scrolls away with it: still no bar (Zach's pick A, November 9, 2026, round 5).
                Text(verbatim: thread?.title ?? String(localized: "Thread", comment: "Title for a thread that has no title yet"))
                    .font(.sotto(.body, .semibold))
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Space.s3)
                    .padding(.bottom, Space.s1)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("thread-title")
            } else {
                // Unfolded, the Duo draws no title (`ThreadMenu` holds it, and the sidebar marks the thread), but VoiceOver
                // still reads the page's name first.
                Color.clear
                    .frame(height: Space.s3)
                    .accessibilityElement()
                    .accessibilityLabel(thread?.title ?? String(localized: "Thread", comment: "Title for a thread that has no title yet"))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("thread-title")
            }
            entries(thread: thread, state: state, detail: detail, rows: rows, pending: pending, scroll: scroll)
            Color.clear.frame(height: 1).id(Self.end).background(sentinelReader(scroll))
            #if DEBUG
            if SendWatch.isOn { SendWatchAnchor().frame(width: 0, height: 0) }
            #endif
        }
        .frame(maxWidth: .infinity, minHeight: max(0, visible - Space.s4), alignment: .topLeading)
        .padding(.horizontal, Space.s4)
        .padding(.bottom, Space.s4)
        .coordinateSpace(.named(Self.pageSpace))
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
                         pending: [ReplyRow], scroll: ScrollViewProxy) -> some View {
        let online = model.online(ref.hostID)
        let provider = Words.provider(thread?.providerId)
        let working = workingRun(rows, state)
        // The row the conversation ends on, when nothing waits under it.
        let last = pending.isEmpty && model.failedReplies[ref.id] == nil ? rows.last?.id : nil
        return VStack(alignment: .leading, spacing: Space.dense(Space.s5, density)) {
            if detail?.earlierAvailable == true || thread?.earlierAvailable == true {
                // Under a step window, how many steps lie above it (ADR-0194): a picture thread's few long turns hold most of them.
                Button { Task { await model.earlier(ref) } } label: {
                    VStack(spacing: 2) {
                        Text("Show earlier messages")
                        if let steps = detail?.earlierSteps, steps > 0 {
                            Text(verbatim: StepRun.count(steps)).font(.sotto(.caption)).foregroundStyle(Palette.muted)
                        }
                    }
                }
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
                // Where Sotto moved the thread off a model its provider stopped offering (ADR-0171).
                let moved = thread?.modelMoved
                let movedAfter = moved.flatMap { $0.anchor(in: detail?.messages ?? []) }.map { "message-" + $0 }
                if let moved, movedAfter == nil, !rows.isEmpty { ModelMovedLine(words: moved.words(provider: provider)) }
                // The latest turns, as many as a thread opens with, are laid out whole, so the page's jump to its end
                // always lands on rows already made: a lazy stack under that jump once left a thread black until it was
                // scrolled (#749). The turns before them, from Show earlier messages or a long stay on the thread, are
                // made as they scroll into view. Laid out whole, every row of a long thread was updated and placed again
                // for each streamed word, and opening one took seconds (#1702).
                let split = min(timeline.latestTurnsStart, rows.count)
                if split > 0 {
                    let inputs = OlderTurnsInputs(ref: ref, provider: provider, working: working, last: last,
                                                  movedAfter: movedAfter, movedWords: moved?.words(provider: provider),
                                                  openRuns: openRuns, showsPictures: model.showsAgentPictures(ref.hostID),
                                                  opensFiles: model.opensSentFiles(ref.hostID),
                                                  spacing: Space.dense(Space.s5, density))
                    OlderTurns(rows: rows[..<split], inputs: inputs) { row in
                        entry(row, provider: provider, working: working, last: last, moved: moved, movedAfter: movedAfter,
                              scroll: scroll)
                    }
                    .equatable()
                }
                ForEach(rows[split...]) { row in
                    entry(row, provider: provider, working: working, last: last, moved: moved, movedAfter: movedAfter, scroll: scroll)
                }
            } else if model.detailProblem == nil || !online {
                (model.status(ref.hostID) == .unreachable ? Text("Reconnect to read this thread.") : Text("Reading this thread…"))
                    .font(.sotto(.body)).foregroundStyle(Palette.muted)
                    .padding(.vertical, Space.s6)
                    .paragraphDirection()
            }
            ForEach(pending) { row in
                UnconfirmedRow(item: row.item, text: row.text, photos: row.photos, files: row.files, sending: row.sending) {
                    dismissMarker = row.item
                }
            }
            if let text = model.failedReplies[ref.id] {
                FailedReplyCard(ref: ref, text: text)
            }
        }
        .padding(.top, Space.s3)
    }

    /// A row, and under it the line saying Sotto moved the thread off its model, where that happened.
    @ViewBuilder private func entry(_ row: ConversationRow, provider: String, working: String?, last: String?, moved: ModelMoved?,
                                    movedAfter: String?, scroll: ScrollViewProxy) -> some View {
        rowView(row, provider: provider, working: row.id == working, last: row.id == last, scroll: scroll)
        if let moved, row.id == movedAfter { ModelMovedLine(words: moved.words(provider: provider)) }
    }

    @ViewBuilder private func rowView(_ row: ConversationRow, provider: String, working: Bool, last: Bool,
                                      scroll: ScrollViewProxy) -> some View {
        switch row.item {
        case .message(let message):
            MessageView(message: message, provider: provider, showsWho: row.showsWho, ref: ref,
                        opensFiles: model.opensSentFiles(ref.hostID), providerID: model.thread(ref)?.providerId,
                        showsVideos: model.stagesVideos(ref.hostID)) { viewing = $0 }.equatable()
                .benchRowFrame("message", row.id, in: .named(Self.pageSpace))
        case .steps(let steps):
            FoldedRun(runID: steps.first?.id ?? row.id, steps: steps, seconds: row.seconds, working: working,
                      open: openRuns.contains(row.id), last: last,
                      pictures: model.showsAgentPictures(ref.hostID) ? RunPictures(ref: ref, by: provider) { viewing = $0 } : nil) { toggleRun(row.id, scroll) }
                .equatable()
                .benchRowFrame("run", row.id, in: .named(Self.pageSpace))
            // The pictures that stand in the thread stay in view whether the run is open or folded (ADR-0170); the rest sit
            // in its lines.
            if model.showsAgentPictures(ref.hostID) {
                AgentPictures(ref: ref, steps: steps, by: provider) { viewing = $0 }
                    .benchRowFrame("pictures", row.id, in: .named(Self.pageSpace))
            }
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
    private func sentinelReader(_ scroll: ScrollViewProxy) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { endMoved(proxy.frame(in: .global).maxY, inPage: proxy.frame(in: .named(Self.pageSpace)).maxY, scroll) }
                .onChange(of: proxy.frame(in: .global).maxY) { _, value in
                    endMoved(value, inPage: proxy.frame(in: .named(Self.pageSpace)).maxY, scroll)
                }
                // The reading column grew or shrank, as it does held sideways when the sidebar comes or goes, and every
                // line wrapped anew. A reader at the end stays there, with the last turn and its working line above the
                // reply box, rather than trusting the scroll view to keep a page whose height changed under it at its end
                // (the Duo design climb's round 6).
                .onChange(of: proxy.size.width) { _, _ in
                    if follow.atBottom { toBottom(scroll) }
                }
        }
    }

    /// An end pushed away from a reader at it by what the page holds is followed: something above it grew, a photo taking
    /// its own shape or a picture's tile being made, and the reader never left. Taken for the reader leaving, it once
    /// stranded them short of the end, where the page stopped following (November 1, 2026). An end that moved only on
    /// the screen moved because the page scrolled, by the user's hand or the status bar, and decides where they stand.
    /// Any growth that slips the end under the reply box is followed, even less than the slack: a photo a little taller
    /// than its placeholder would otherwise leave the end's last lines covered with nothing to bring them back.
    private func endMoved(_ end: CGFloat, inPage: CGFloat, _ scroll: ScrollViewProxy) {
        let wasAtBottom = follow.atBottom
        let grew = abs(inPage - follow.endInPage) > 0.5
        follow.sentinel = end
        follow.endInPage = inPage
        if wasAtBottom, grew, end > follow.dockTop + 1 {
            toBottom(scroll)
        } else {
            follow.settle()
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

#if DEBUG
/// The conversation's end, the reply box's top and the bar's bottom, in points from the top of the screen, as one label
/// the simulator journeys read: in a long page an element's accessibility frame can lag its layout by thousands of
/// points. It reads the page's place ten times a second and holds no state of the page's, so the page draws as it would
/// without it. Drawn all but invisibly, so it stays in the accessibility tree.
private struct EndProbe: View {
    let follow: FollowBox
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { _ in
            let words = [follow.sentinel, min(follow.dockTop, 99_999), follow.barBottom].map { String(Int($0.rounded())) }
                .joined(separator: " ")
            Text(verbatim: words).font(.system(size: 2)).opacity(0.02).allowsHitTesting(false)
                .accessibilityIdentifier("thread-end-probe").accessibilityLabel(Text(verbatim: words))
        }
    }
}
#endif

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
        let _ = BenchProbe.body("ThreadHero")
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
        .duoSheet(isPresented: $showingPullRequest, toFoot: true) {
            if let pullRequest, let number = chips.pullRequest?.number {
                PullRequestSheet(ref: ref, url: pullRequest.url, number: number).overThread()
            }
        }
    }

    /// Where it runs: the agent, the project and the computer, in the order every thread's line reads (#1861).
    private var place: String {
        model.placeLine(ref, provider: Words.provider(thread?.providerId), computer: model.name(ref.hostID))
    }

    private func edgeReader(_ edge: KeyPath<CGRect, CGFloat>, _ moved: @escaping (CGFloat) -> Void) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { moved(proxy.frame(in: .global)[keyPath: edge]) }
                .onChange(of: proxy.frame(in: .global)[keyPath: edge]) { _, value in moved(value) }
        }
    }
}

extension AppModel {
    /// Every project a computer shares, settled ones too: a thread in a settled project still names it.
    func projectsListed(_ hostID: String) -> [Project] { live[hostID]?.shell?.host.projects ?? [] }
    /// The name of the project a thread belongs to, where this iPhone lists the thread.
    func projectTitle(_ ref: ThreadRef) -> String? {
        guard let id = thread(ref)?.projectId else { return nil }
        return projectsListed(ref.hostID).first { $0.id == id }?.title
    }
    /// Where a thread runs, as every row and card says it (#1861): provider · project · computer, the project only where
    /// this iPhone lists the thread. The caller names the provider and computer, since Watcher's records name them for
    /// threads this iPhone may not list.
    func placeLine(_ ref: ThreadRef, provider: String, computer: String) -> String {
        [provider, projectTitle(ref), computer].compactMap { $0 }.joined(separator: " · ")
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
/// computer offers the pull request sheet, the pull request chip is a button of its own that opens it. The chips wrap
/// onto a second line when they don't fit: at the largest text sizes a row that couldn't wrap pushed the whole thread
/// wider than a small iPhone's screen, cutting the first letters off every line (#1848).
private struct GitChipRow: View {
    let chips: GitChips
    var sheet: PullRequestChip? = nil
    var open: () -> Void = {}
    var body: some View {
        if let sheet, let pullRequest = chips.pullRequest {
            ChipLine(squeezesFirst: chips.branch != nil) {
                // The branch and changes still read as one sentence: the branch chip says both, and the changes chip
                // speaks only when there is no branch.
                if let branch = chips.branch {
                    branchChip(branch)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(chips.spoken(includingPullRequest: false))
                }
                if let changes = chips.changes {
                    changesChip(changes)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(chips.spoken(includingPullRequest: false))
                        .accessibilityHidden(chips.branch != nil)
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
                .accessibilityLabel(Self.spokenPullRequest(pullRequest, rollup: sheet.rollup))
                .accessibilityIdentifier("pull-request-chip")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            plain
        }
    }

    /// The pull request chip as VoiceOver reads it, with the checks' roll-up once its sheet has read them.
    static func spokenPullRequest(_ pullRequest: GitChips.PullRequest, rollup: String?) -> String {
        let number: String = String(pullRequest.number)
        let state: String = pullRequest.stateWord
        guard let rollup else {
            return String(localized: "Show pull request \(number), \(state)", comment: "The first %@ is the pull request's number, the second its state")
        }
        return String(localized: "Show pull request \(number), \(state). Checks: \(rollup)", comment: "The first %@ is the pull request's number, the second its state, the third its checks' roll-up")
    }

    private func branchChip(_ branch: String) -> some View {
        GitChip {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 11, weight: .semibold))
            Text(verbatim: branch)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(Palette.ink)
                .truncationMode(.middle)
        }
    }

    private func changesChip(_ changes: GitChips.Changes) -> some View {
        GitChip {
            Text("+\(changes.insertions)").foregroundStyle(Palette.accentText)
            Text("−\(changes.deletions)").foregroundStyle(Palette.dangerText)
            (changes.files == 1 ? Text("1 file") : Text("\(changes.files) files"))
        }
    }

    /// The row as it is without the sheet: every chip one sentence.
    private var plain: some View {
        ChipLine(squeezesFirst: chips.branch != nil) {
            if let branch = chips.branch { branchChip(branch) }
            if let changes = chips.changes { changesChip(changes) }
            if let pullRequest = chips.pullRequest {
                GitChip {
                    Image(systemName: "arrow.triangle.pull").font(.system(size: 11, weight: .semibold))
                    Text("#\(String(pullRequest.number)) \(pullRequest.stateWord)", comment: "A pull request chip: its number, then its state, such as #721 open")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(chips.spoken)
    }
}

/// The Git chips on one line while they fit, the first (the branch) giving up width before anything wraps, as the row
/// always did; when even a squeezed branch leaves no room, as many lines as it takes, each chip no wider than the row.
/// Chips of different heights share a line's middle.
private struct ChipLine: Layout {
    var spacing: CGFloat = Space.s2
    var squeezesFirst = false
    /// The narrowest the first chip gets before the row wraps instead: its icon and a few letters of the branch.
    private static let narrowest: CGFloat = 96

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let frames = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? (frames.map(\.maxX).max() ?? 0), height: frames.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, arrange(width: bounds.width, subviews: subviews)) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), anchor: .topLeading,
                          proposal: ProposedViewSize(width: frame.width, height: frame.height))
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [CGRect] {
        var sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        guard let first = sizes.first else { return [] }
        let others = sizes.dropFirst().reduce(CGFloat(0)) { $0 + spacing + $1.width }
        var rows: [[Int]] = [[]]
        if squeezesFirst, others + min(first.width, Self.narrowest) <= width {
            if first.width + others > width {
                sizes[0] = subviews[0].sizeThatFits(ProposedViewSize(width: width - others, height: nil))
            }
            rows = [Array(sizes.indices)]
        } else {
            var x: CGFloat = 0
            for index in sizes.indices {
                if sizes[index].width > width {
                    sizes[index] = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
                }
                if x > 0 && x + sizes[index].width > width {
                    rows.append([])
                    x = 0
                }
                rows[rows.count - 1].append(index)
                x += sizes[index].width + spacing
            }
        }
        var frames = Array(repeating: CGRect.zero, count: sizes.count)
        var y: CGFloat = 0
        for row in rows {
            let height = row.map { sizes[$0].height }.max() ?? 0
            var x: CGFloat = 0
            for index in row {
                let size = sizes[index]
                frames[index] = CGRect(x: x, y: y + (height - size.height) / 2, width: size.width, height: size.height)
                x += size.width + spacing
            }
            y += height + spacing
        }
        return frames
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
    /// The provider's ID, for its mark beside its name on the Duo.
    var providerID: String? = nil
    /// Whether its computer takes videos (`video-staging`, with `attach-any-file`), so sent videos are tiles; elsewhere a
    /// sent video is the file it was before.
    var showsVideos = false
    let open: (OpenPhotos) -> Void
    @Environment(\.sottoDensity) private var density
    @Environment(\.duoLayout) private var duo
    /// Drawn again only when what it shows changes; opening a photo is the same action for every message.
    static func == (a: Self, b: Self) -> Bool {
        a.message == b.message && a.provider == b.provider && a.showsWho == b.showsWho && a.ref == b.ref && a.opensFiles == b.opensFiles
            && a.providerID == b.providerID && a.showsVideos == b.showsVideos
    }
    var body: some View {
        let _ = BenchProbe.body("MessageView")
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
    /// then their videos as tiles that say where the video is (ADR-0131, November 9 amendment), and under them their files,
    /// each a pill that opens it in Quick Look where the computer hands files back.
    private var userMessage: some View {
        let attachments = message.attachments ?? []
        let photos = attachments.filter(\.hasPreview)
        let videos = showsVideos ? attachments.filter { !$0.hasPreview && Videos.isVideo($0) } : []
        let files = opensFiles ? attachments.filter { !$0.hasPreview && Files.isFile($0) && !(showsVideos && Videos.isVideo($0)) } : []
        return VStack(alignment: .trailing, spacing: Space.s1) {
            SentPhotoButtons(ref: ref, messageID: message.id, photos: photos, open: open)
            if !videos.isEmpty { SentVideoTiles(ref: ref, videos: videos) }
            if !files.isEmpty { SentFilePills(ref: ref, messageID: message.id, attachments: files) }
            if !message.text.isEmpty || photos.count + videos.count + files.count != attachments.count {
                content(ink: Palette.bubbleInk, drawn: Set((videos + files).map(\.id)))
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
                    // On the Duo the provider's own mark stands beside its name, as on the rows, cards and Agents, where
                    // a lettered tile read like a placeholder (Zach's pick, November 9, 2026, round 4).
                    if duo != .none, ProviderLogo.asset(providerID) != nil {
                        ProviderLogo(providerID: providerID)
                            .foregroundStyle(Palette.ink)
                            .frame(width: 18, height: 18)
                    } else {
                        Text(String(provider.prefix(1)))
                            .font(.figtree(10, .caption2, .bold))
                            .foregroundStyle(Palette.accentText)
                            .frame(width: 18, height: 18)
                            .background(Palette.accent.opacity(0.22), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .accessibilityHidden(true)
                    }
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
                MarkdownText(text: message.text, quotable: message.role == "assistant").equatable().foregroundStyle(ink)
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
    /// An agent's reply, whose selected words offer Add to prompt when the page has a reply box (ADR-0129).
    var quotable = false
    @Environment(\.sottoDensity) private var density
    static func == (a: Self, b: Self) -> Bool { a.text == b.text && a.quotable == b.quotable }
    var body: some View {
        let _ = BenchProbe.body("MarkdownText")
        let blocks = SottoCore.Markdown.cachedBlocks(text)
        VStack(alignment: .leading, spacing: Space.dense(Space.s3, density)) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                MarkdownBlockView(block: block, first: index == 0, quotable: quotable).equatable()
            }
        }
    }
}

private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownBlock
    let first: Bool
    let quotable: Bool
    static func == (a: Self, b: Self) -> Bool { a.first == b.first && a.block == b.block && a.quotable == b.quotable }
    @Environment(\.replyQuoteBox) private var quoteBox
    @Environment(\.sottoTheme) private var theme
    @Environment(\.sottoDensity) private var density
    @Environment(\.proseScale) private var scale
    var body: some View {
        let _ = BenchProbe.body("MarkdownBlockView")
        switch block {
        case .heading(let level, let text):
            Text(InlineStyle.render(text, theme: theme))
                .font(.sotto(level <= 2 ? .lead : .body, .semibold, times: scale))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, first ? 0 : Space.dense(Space.s2, density))
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            if quotable, let quoteBox {
                ReplyText(inline: text, ink: .ink, box: quoteBox)
            } else {
                Text(InlineStyle.render(text, theme: theme))
                    .font(.sotto(.body, times: scale))
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        case .list(let items):
            MarkdownListView(items: items, quoteBox: quotable ? quoteBox : nil)
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .quote(let text):
            Group {
                if quotable, let quoteBox {
                    ReplyText(inline: text, ink: .muted, box: quoteBox)
                } else {
                    Text(InlineStyle.render(text, theme: theme))
                        .font(.sotto(.body, times: scale))
                        .foregroundStyle(Palette.muted)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
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
    /// On the Duo held sideways, a column whose words run no wider than this keeps them on one line.
    @ScaledMetric(relativeTo: .footnote) private var shortColumn: CGFloat = 120
    @Environment(\.duoLayout) private var duo
    @Environment(\.dynamicTypeSize) private var typeSize
    /// How wide the cards stand, so a folded card can tell which of its values fit on one line (`shortFields`).
    @State private var cardsWidth: CGFloat = 0
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        ViewThatFits(in: .horizontal) {
            wide
            cards
        }
        .background(Palette.code, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
    }

    private var columns: Range<Int> { 0..<table.header.count }

    /// The Duo held sideways sizes each column by its words (`ProportionalColumns`); every other phone keeps the grid.
    @ViewBuilder private var wide: some View {
        if duo.sideways { proportionalGrid } else { grid }
    }

    private var proportionalGrid: some View {
        ProportionalColumns(columns: table.header.count, cap: cellWidth, shortColumn: shortColumn) {
            ForEach(columns, id: \.self) { column in
                proportionalCell(table.header[column], column: column, header: true)
            }
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                ForEach(columns, id: \.self) { column in
                    proportionalCell(row[column], column: column, header: false)
                }
            }
        }
    }

    /// A cell of the proportional grid; a row under the header carries the hairline above it.
    private func proportionalCell(_ text: MarkdownInline, column: Int, header: Bool) -> some View {
        let layout = table.alignments[column].layout
        return cellText(text, column: column, header: header)
            .frame(maxWidth: .infinity, alignment: layout.frame)
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.dense(Space.s2, density))
            .frame(maxHeight: .infinity, alignment: .top)
            .padding(.top, header ? 0 : 1)
            .overlay(alignment: .top) {
                if !header { Rectangle().fill(Palette.hairline).frame(height: 1) }
            }
    }

    private func cellText(_ text: MarkdownInline, column: Int, header: Bool) -> some View {
        Text(InlineStyle.render(text, theme: theme))
            .font((header ? Font.sotto(.caption, .semibold) : Font.sotto(.small)).monospacedDigit())
            .foregroundStyle(header ? Palette.muted : Palette.ink)
            .multilineTextAlignment(table.alignments[column].layout.text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

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
            cellText(text, column: column, header: header)
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
            // Folded, once any row has a short field the table's cards take the shorter form (`shortCard`).
            let short = duo.isFolded && table.rows.contains { !shortFields($0).isEmpty }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) }
                    if short { shortCard(row) } else { card(row) }
                }
            }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { cardsWidth = $0 }
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

    /// A card's title: the row's first cell under its column's small label, at the trailing edge when its column is set
    /// there.
    private func cardTitle(_ row: [MarkdownInline]) -> some View {
        let trailing = table.alignments[0] == .trailing
        return VStack(alignment: trailing ? .trailing : .leading, spacing: Space.s1) {
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
    }

    /// A card titled by the row's first cell, with every other column a label and its value.
    private func card(_ row: [MarkdownInline]) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            cardTitle(row)
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

    /// Folded, a card whose label and value lines made a tall form of every record: its title as before, then its short
    /// fields on one quiet line joined with " · ", in the table's own words, and each other field under its own small
    /// label at the card's full width (Zach's round 8 pick A, November 10, 2026). VoiceOver still hears each short field's
    /// label with its value.
    private func shortCard(_ row: [MarkdownInline]) -> some View {
        let short = shortFields(row)
        let rest = row.indices.dropFirst().filter { !short.contains($0) && !row[$0].source.isEmpty }
        return VStack(alignment: .leading, spacing: Space.s2) {
            VStack(alignment: .leading, spacing: 2) {
                cardTitle(row)
                if !short.isEmpty {
                    Text(joined(short, of: row))
                        .font(.sotto(.small).monospacedDigit())
                        .foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .accessibilityLabel(short.map { "\(table.header[$0].text), \(row[$0].text)" }.joined(separator: ", "))
                }
            }
            ForEach(rest, id: \.self) { column in
                VStack(alignment: .leading, spacing: 2) {
                    if !table.header[column].source.isEmpty {
                        Text(InlineStyle.render(table.header[column], theme: theme))
                            .font(.sotto(.caption, .semibold))
                            .foregroundStyle(Palette.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    value(row[column], trailing: table.alignments[column] == .trailing)
                }
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.dense(Space.s3, density))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// The columns between a row's first and last whose values fit on one line of the card, empty ones left out.
    private func shortFields(_ row: [MarkdownInline]) -> [Int] {
        guard row.count > 2, cardsWidth > 0 else { return [] }
        let traits = UITraitCollection(preferredContentSizeCategory: FilledLines.category(typeSize))
        let font = UIFont.figtree(TextScale.small.size, .footnote, .regular, traits: traits)
        let room = cardsWidth - Space.s4 * 2
        return (1..<(row.count - 1)).filter { column in
            let words = row[column].text
            guard !words.isEmpty, !words.contains("\n") else { return false }
            return ceil((words as NSString).size(withAttributes: [.font: font]).width) <= room
        }
    }

    /// A row's cells on one line, each with its inline Markdown, joined with " · ". A value that can't say what it is on
    /// its own, a bare yes or no, a number or a mark, keeps its column's name before it ("Fixed: No"), where the pick's
    /// "Not fixed" named itself.
    private func joined(_ columns: [Int], of row: [MarkdownInline]) -> AttributedString {
        var line = AttributedString()
        for (index, column) in columns.enumerated() {
            if index > 0 { line.append(AttributedString(" · ")) }
            let header = table.header[column]
            if !header.source.isEmpty, !DuoWords.namesItself(row[column].text) {
                line.append(InlineStyle.render(header, theme: theme))
                line.append(AttributedString(": "))
            }
            line.append(InlineStyle.render(row[column], theme: theme))
        }
        return line
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

/// A table's cells, row by row, `columns` to a row, on the Duo held sideways (the Duo design climb's round 6): each
/// column takes the width in proportion to how wide its words run on one line, so a short column doesn't stand wide while
/// a long one wraps narrow. A column whose words fit `shortColumn` keeps them on one line. Its ideal width is the grid's,
/// each column's words up to `cap`, so the table takes the grid's place, or the cards', under the same test.
private struct ProportionalColumns: Layout {
    let columns: Int
    let cap: CGFloat
    let shortColumn: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard columns > 0 else { return .zero }
        let natural = naturalWidths(subviews)
        let width = proposal.width ?? natural.reduce(CGFloat(0)) { $0 + min($1, cap) }
        let heights = rowHeights(subviews, widths: shares(natural, in: width))
        return CGSize(width: width, height: heights.reduce(0, +))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard columns > 0 else { return }
        let widths = shares(naturalWidths(subviews), in: bounds.width)
        var y = bounds.minY
        for (row, height) in rowHeights(subviews, widths: widths).enumerated() {
            var x = bounds.minX
            for column in 0..<columns where row * columns + column < subviews.count {
                subviews[row * columns + column].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: widths[column], height: height))
                x += widths[column]
            }
            y += height
        }
    }
    /// Each column's widest cell with its words on one line.
    private func naturalWidths(_ subviews: Subviews) -> [CGFloat] {
        var widths = Array(repeating: CGFloat(0), count: columns)
        for (index, view) in subviews.enumerated() {
            widths[index % columns] = max(widths[index % columns], view.sizeThatFits(.unspecified).width)
        }
        return widths
    }
    /// The width shared in proportion to the columns' words; a column whose share would wrap words that fit
    /// `shortColumn` keeps that width instead, and the rest share what is left.
    private func shares(_ natural: [CGFloat], in width: CGFloat) -> [CGFloat] {
        let floors = natural.map { min($0, shortColumn) }
        var held = Set<Int>()
        while true {
            let open = natural.indices.filter { !held.contains($0) }
            let room = width - held.reduce(CGFloat(0)) { $0 + floors[$1] }
            let words = open.reduce(CGFloat(0)) { $0 + natural[$1] }
            guard words > 0 else { return floors }
            let short = open.filter { natural[$0] * room / words < floors[$0] }
            if short.isEmpty { return natural.indices.map { held.contains($0) ? floors[$0] : natural[$0] * room / words } }
            held.formUnion(short)
        }
    }
    /// Each row as tall as its tallest cell at its column's width.
    private func rowHeights(_ subviews: Subviews, widths: [CGFloat]) -> [CGFloat] {
        stride(from: 0, to: subviews.count, by: columns).map { start in
            (start..<min(start + columns, subviews.count)).reduce(CGFloat(0)) { tallest, index in
                max(tallest, subviews[index].sizeThatFits(ProposedViewSize(width: widths[index - start], height: nil)).height)
            }
        }
    }
}

/// A list with hanging indents: the marker in its own column, muted, and the words aligned after it.
private struct MarkdownListView: View {
    let items: [MarkdownListItem]
    /// Set when the list is in an agent's reply on a page with a reply box (ADR-0129).
    let quoteBox: ReplyQuoteBox?
    @Environment(\.sottoTheme) private var theme
    @Environment(\.sottoDensity) private var density
    @Environment(\.proseScale) private var scale
    @ScaledMetric(relativeTo: .body) private var digit: CGFloat = 9
    var body: some View {
        let width = markerWidth
        VStack(alignment: .leading, spacing: Space.dense(Space.s2, density)) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                    marker(item.marker, width: width)
                    if let quoteBox {
                        ReplyText(inline: item.text, ink: .ink, box: quoteBox)
                    } else {
                        Text(InlineStyle.render(item.text, theme: theme))
                            .font(.sotto(.body, times: scale))
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
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
            Text("•").font(.sotto(.body, .bold, times: scale)).foregroundStyle(Palette.muted)
                .frame(width: width, alignment: .center)
                .accessibilityHidden(true)
        case .number(let number):
            Text("\(number).").font(.sotto(.body, times: scale).monospacedDigit()).foregroundStyle(Palette.muted)
                .frame(width: width, alignment: .trailing)
        }
    }
}

/// Code that wraps at the block's edge, on the Duo in every posture (Zach, November 9, 2026, the Duo design climb's round
/// 2): each line that runs past the edge goes on under a ↪, so a wrapped line can't pass for two, and Copy still copies
/// the code as written. The font is monospaced, so a column is one measured character wide and the breaks are worked out
/// here, at a space where one falls in the last half of the line.
private struct WrappedCode: View {
    let code: String
    /// The code block's ink; a running step's command takes the conversation's.
    var ink = Palette.codeInk
    @State private var width: CGFloat = 0
    @State private var advance: CGFloat = 0
    @Environment(\.sottoTheme) private var theme
    struct Line: Hashable { let text: String; let continued: Bool }
    var body: some View {
        let columns = advance > 0 && width > 0 ? max(12, Int((width / advance).rounded(.down))) : Int.max
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(Self.lines(code, columns: columns).enumerated()), id: \.offset) { _, line in
                Group {
                    if line.continued {
                        Text(verbatim: "↪ ").foregroundStyle(theme.color(.muted)) + Text(verbatim: line.text)
                    } else {
                        Text(verbatim: line.text.isEmpty ? " " : line.text)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.system(.footnote, design: .monospaced))
        .foregroundStyle(ink)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
        .background(alignment: .topLeading) {
            Text(verbatim: "MMMMMMMMMM").font(.system(.footnote, design: .monospaced)).fixedSize().hidden()
                .onGeometryChange(for: CGFloat.self, of: { $0.size.width / 10 }) { advance = $0 }
        }
        .textSelection(.enabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: code))
    }
    /// The code's lines cut to `columns`, a continuation two columns shorter for its ↪.
    static func lines(_ code: String, columns: Int) -> [Line] {
        var out: [Line] = []
        for raw in code.replacingOccurrences(of: "\t", with: "    ").components(separatedBy: "\n") {
            var rest = Substring(raw)
            var continued = false
            repeat {
                let room = continued ? columns - 2 : columns
                if rest.count <= room { out.append(Line(text: String(rest), continued: continued)); break }
                var cut = rest.index(rest.startIndex, offsetBy: room)
                // A break goes after a space or a path's slash in the line's second half, so a name isn't split in its
                // middle ("terminal" / "Drawer.test.ts"); only a run with neither is cut at the edge.
                if let space = rest[..<cut].lastIndex(where: { $0 == " " || $0 == "/" }), rest.distance(from: rest.startIndex, to: space) >= room / 2 {
                    cut = rest.index(after: space)
                }
                out.append(Line(text: String(rest[..<cut]), continued: continued))
                rest = rest[cut...]
                continued = true
            } while !rest.isEmpty
        }
        return out
    }
}

/// Code on the code surface, its language above it and Copy beside that; long lines scroll sideways. On the Duo they wrap
/// in every posture instead, each break marked ↪ (`WrappedCode`). Folded or sideways, a block of one or two lines has no
/// header: Copy stands at the code's right end on its first line and the language goes, where the header had stood as
/// tall as the code (Zach's round 6 pick A, November 10, 2026).
private struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false
    @Environment(\.duoLayout) private var duo
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            if short {
                HStack(alignment: .firstTextBaseline, spacing: Space.s1) {
                    WrappedCode(code: code).padding(.vertical, Space.s3)
                    copyButton
                }
                .padding(.leading, Space.s3)
                .padding(.trailing, Space.s1)
            } else {
                HStack(spacing: Space.s2) {
                    Text(language ?? String(localized: "code", comment: "Label over a code block whose language is not named")).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1)
                    Spacer(minLength: Space.s2)
                    copyButton
                }
                .padding(.leading, Space.s3)
                .padding(.trailing, Space.s1)
                Rectangle().fill(Palette.hairline).frame(height: 1)
                if duo != .none {
                    WrappedCode(code: code).padding(Space.s3)
                } else {
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
            }
        }
        .background(Palette.code, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
    }
    /// Folded or sideways on the Duo, a block of one or two lines as written, however they wrap.
    private var short: Bool {
        guard duo != .none, duo != .upright else { return false }
        let lines = code.trimmingCharacters(in: .newlines).components(separatedBy: "\n")
        return lines.count <= 2
    }
    private var copyButton: some View {
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
    /// The words as `render` draws them at the body step, for a text view: Figtree in the ink given, code on the code
    /// surface, a key chord on the raised one, scaled to the text size in `traits`.
    static func attributed(_ inline: MarkdownInline, ink: ThemeRoleName, theme: ThemeSwatch, traits: UITraitCollection,
                           scale: CGFloat = 1) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        let regular = UIFont.figtree(TextScale.body.size * scale, .body, traits: traits)
        let bold = UIFont.figtree(TextScale.body.size * scale, .body, .bold, traits: traits)
        let parsed = inline.cachedAttributed()
        let out = NSMutableAttributedString()
        for run in parsed.runs {
            var words = String(parsed[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            var style: [NSAttributedString.Key: Any] = [.paragraphStyle: paragraph, .foregroundColor: UIColor(theme.color(ink)),
                                                        .font: intent.contains(.stronglyEmphasized) ? bold : regular]
            if run.attributes[KeyChordAttribute.self] == true {
                words = "\u{202F}" + words + "\u{202F}"
                style[.font] = UIFont.figtree(12.5, .footnote, .semibold, traits: traits)
                style[.foregroundColor] = UIColor(theme.color(.ink))
                style[.backgroundColor] = UIColor(theme.color(.raised))
            } else if intent.contains(.code) {
                style[.font] = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: traits).pointSize, weight: .regular)
                style[.foregroundColor] = UIColor(theme.color(.codeInk))
                style[.backgroundColor] = UIColor(theme.color(.code))
            }
            // Figtree has no italic face; the slant stands in for it.
            if intent.contains(.emphasized) { style[.obliqueness] = 0.18 }
            if intent.contains(.strikethrough) { style[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { style[.link] = link }
            out.append(NSAttributedString(string: words, attributes: style))
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

// MARK: - Reply quotes

/// Where words quoted from an agent's reply go: the reply box on the reply's page, by its draft key (ADR-0129). Nil
/// where no box takes them. Equal by the box, so a page drawing again draws no reply again.
struct ReplyQuoteBox: Equatable {
    let key: String
    /// Adds the words to the box and focuses it; false when they are only white space.
    let add: @MainActor (String) -> Bool
    static func == (a: Self, b: Self) -> Bool { a.key == b.key }
}

private struct ReplyQuoteBoxKey: EnvironmentKey { static let defaultValue: ReplyQuoteBox? = nil }

extension EnvironmentValues {
    var replyQuoteBox: ReplyQuoteBox? {
        get { self[ReplyQuoteBoxKey.self] }
        set { self[ReplyQuoteBoxKey.self] = newValue }
    }
}

/// A block of an agent's reply in a read-only text view, so a selection of any part of it offers **Add to prompt**
/// before Copy, as the desktop's button above a selection does (ADR-0129). SwiftUI's selectable `Text` takes no action
/// of the app's own. The words are drawn as `InlineStyle` draws them.
private struct ReplyText: UIViewRepresentable {
    let inline: MarkdownInline
    let ink: ThemeRoleName
    let box: ReplyQuoteBox
    @Environment(\.sottoTheme) private var theme
    /// Read so a change of text size draws the words again.
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.proseScale) private var scale

    func makeCoordinator() -> Coordinator { Coordinator(box: box) }

    func makeUIView(context: Context) -> UITextView {
        BenchProbe.count("textview.make")
        let view = Words()
        view.isEditable = false
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.dataDetectorTypes = []
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        BenchProbe.count("textview.update")
        context.coordinator.box = box
        // Set only when the words or their look change, so a selection survives the page drawing again.
        let words = InlineStyle.attributed(inline, ink: ink, theme: theme, traits: view.traitCollection, scale: scale)
        if view.attributedText != words { BenchProbe.count("textview.set"); view.attributedText = words }
        context.coordinator.installed = MeasuredWords.Words(inline: inline, traits: view.traitCollection, scale: scale)
        view.linkTextAttributes = [.foregroundColor: UIColor(theme.color(.accentText))]
        view.tintColor = UIColor(theme.color(.accent))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        // Asked without a width, or with an unbounded one, it answers as Text does: its words on one line.
        let bounded = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        // Laying words out is the costly part of a text view, and SwiftUI asks for the same size several times while
        // a row is made, and again when a row scrolled away is made again. The same words at the same width measure
        // the same, so each is measured once.
        let words = MeasuredWords.Words(inline: inline, traits: uiView.traitCollection, scale: scale)
        let key = MeasuredWords.Key(words: words, width: bounded ?? -1)
        let fitted: CGSize
        if let known = MeasuredWords.size(for: key) {
            fitted = known
        } else {
            fitted = BenchProbe.time("textview.measure") {
                uiView.sizeThatFits(CGSize(width: bounded ?? .greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
            }
            // Kept only when the view holds these words: asked before its update, it measured what it held before.
            if context.coordinator.installed == words { MeasuredWords.keep(fitted, for: key) }
        }
        return CGSize(width: bounded ?? ceil(fitted.width), height: fitted.height)
    }

    /// Reads to VoiceOver, and to the UI journeys, as the words themselves, the way a selectable `Text` does.
    final class Words: UITextView {
        override var accessibilityLabel: String? { get { text } set {} }
        override var accessibilityValue: String? { get { nil } set {} }
        override var accessibilityTraits: UIAccessibilityTraits { get { .staticText } set {} }
    }

    static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) {
        ReplySelection.views.remove(ObjectIdentifier(view))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var box: ReplyQuoteBox
        /// The words the view holds since its last update, which its measured size is kept for.
        var installed: MeasuredWords.Words?
        init(box: ReplyQuoteBox) { self.box = box }

        func textViewDidChangeSelection(_ textView: UITextView) {
            if textView.selectedRange.length > 0 {
                ReplySelection.views.insert(ObjectIdentifier(textView))
            } else {
                ReplySelection.views.remove(ObjectIdentifier(textView))
            }
        }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            // A key chord's narrow spaces are drawing, not words.
            let words = (textView.text as NSString).substring(with: range).replacingOccurrences(of: "\u{202F}", with: "")
            guard !words.allSatisfy(\.isWhitespace) else { return nil }
            let box = box
            let add = UIAction(title: String(localized: "Add to prompt", comment: "Edit menu action on words selected in an agent's reply: adds them to the reply box as a quote"),
                               image: UIImage(systemName: "text.quote")) { _ in
                guard box.add(words) else { return }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                textView.selectedRange = NSRange(location: 0, length: 0)
            }
            return UIMenu(children: [add] + suggestedActions)
        }
    }
}

/// Reply text views' measured sizes, by everything that sizes their words: the Markdown, the text size and Bold Text
/// that pick `InlineStyle`'s fonts, and the width they were measured at. Colour, from the theme and the ink, sizes nothing.
@MainActor private enum MeasuredWords {
    struct Words: Equatable, Hashable {
        let inline: MarkdownInline
        let size: UIContentSizeCategory
        let weight: UILegibilityWeight
        let scale: CGFloat
        init(inline: MarkdownInline, traits: UITraitCollection, scale: CGFloat) {
            self.inline = inline
            size = traits.preferredContentSizeCategory
            weight = traits.legibilityWeight
            self.scale = scale
        }
    }
    struct Key: Hashable {
        let words: Words
        let width: CGFloat
    }
    private static var sizes: [Key: CGSize] = [:]
    private static var bytes = 0
    static func size(for key: Key) -> CGSize? { sizes[key] }
    static func keep(_ size: CGSize, for key: Key) {
        // A reply streaming in is a new entry with every word, so the Markdown the entries hold is what bounds them: the
        // cache starts again rather than growing past 4,000 entries or 2 MB of Markdown.
        let cost = key.words.inline.source.utf8.count
        if sizes.count >= 4_000 || bytes + cost > 2_000_000 { sizes = [:]; bytes = 0 }
        sizes[key] = size
        bytes += cost
    }
}

/// The reply text views holding a selection, so the page keeps their rows where they are while words are selected.
private enum ReplySelection {
    static var views: Set<ObjectIdentifier> = []
}

// MARK: - Steps

/// A run of steps between two messages, folded into one line (ADR-0051, October 5 amendment). While the thread works
/// through it, the line shows the working words with a slow light crossing them, and VoiceOver hears the step running
/// now; once it has ended, how many steps it had and how long they took, quietly. A press opens the steps in place
/// under their guide, and another folds them.
/// What a run needs to show its steps' pictures in their lines (ADR-0170, pictures in steps): the thread they are read
/// from, who made them, for the viewer's callouts, and how the viewer opens. Nil where a computer keeps no pictures.
struct RunPictures {
    let ref: ThreadRef
    let by: String?
    let open: (OpenPhotos) -> Void
}

private struct FoldedRun: View, Equatable {
    let runID: String
    let steps: [Activity]
    let seconds: TimeInterval?
    let working: Bool
    let open: Bool
    /// The conversation ends on this run, so the line's reach stays inside the page's end.
    let last: Bool
    var pictures: RunPictures? = nil
    let toggle: () -> Void
    /// Drawn again only when what it shows changes; a press does the same for its run every time.
    static func == (a: Self, b: Self) -> Bool {
        a.runID == b.runID && a.steps == b.steps && a.seconds == b.seconds && a.working == b.working && a.open == b.open
            && a.last == b.last && a.pictures?.ref == b.pictures?.ref && a.pictures?.by == b.pictures?.by
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The video the folded line's strip set playing under it.
    @State private var playing: String?

    var body: some View {
        let _ = BenchProbe.body("FoldedRun")
        // Folded, the line shows the newest pictures of all its steps at its end; open, each step shows its own.
        let items = pictures == nil || open ? [] : StepPictures.inSteps(steps)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s2) {
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
                if let pictures, !items.isEmpty {
                    Spacer(minLength: Space.s2)
                    StepPictureStrip(ref: pictures.ref, items: items, run: steps, by: pictures.by, playing: $playing, open: pictures.open)
                }
            }
            if let pictures, !items.isEmpty { StepPictureVideo(ref: pictures.ref, items: items, playing: playing) }
            if open {
                StepTrail(steps: steps, pictures: pictures)
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
        let _ = BenchProbe.body("WorkingLine")
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
        } else if timer == nil, !DebugFlags.still {
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
            .iconFont(11, weight: .semibold)
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
    var pictures: RunPictures? = nil
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(steps) { record in
                StepLine(record: record, run: steps, pictures: pictures)
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
    /// The run the step is in, which a viewer opened from its pictures steps through.
    var run: [Activity] = []
    var pictures: RunPictures? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The mark's room, which grows with the step's words so a sub-agent's Bot, which grows too, keeps clear of them.
    @ScaledMetric(relativeTo: .caption) private var markRoom: CGFloat = 16
    @Environment(\.duoLayout) private var duo
    /// The video the step's strip set playing under its line.
    @State private var playing: String?
    var body: some View {
        let _ = BenchProbe.body("StepLine")
        // The step's pictures sit at its line's end, before its time (ADR-0170, pictures in steps).
        let items = pictures == nil ? [] : StepPictures.inSteps([record])
        VStack(alignment: .leading, spacing: 0) {
            Group {
                if duo == .none {
                    line(items, whole: false)
                } else if running {
                    // On the Duo the running step's command always stands on its own line under Running and its timer, a
                    // size larger and at the conversation's full strength, where beside them it was a fine grey strand
                    // (Zach's pick A, November 9, 2026, round 5).
                    stacked(items, strong: true)
                } else {
                    // On the Duo a command that doesn't fit beside its step goes whole on a line under it, rather than cut
                    // in the middle (Zach, November 9, 2026, the Duo design climb's round 2).
                    ViewThatFits(in: .horizontal) {
                        line(items, whole: true)
                        stacked(items, strong: false)
                    }
                }
            }
            // A line with pictures keeps them apart, so each opens on its own.
            .accessibilityElement(children: items.isEmpty ? .combine : .contain)
            .accessibilityIdentifier("step-\(record.id)")
            if let pictures, !items.isEmpty { StepPictureVideo(ref: pictures.ref, items: items, playing: playing) }
        }
    }

    /// The step over two lines: its kind, its pictures and time, then its command whole under them, `strong` a size
    /// larger in ink.
    private func stacked(_ items: [StepPictures.Item], strong: Bool) -> some View {
        VStack(alignment: .leading, spacing: strong ? 3 : 1) {
            HStack(spacing: 7) {
                mark.frame(width: markRoom, height: markRoom)
                verb
                Spacer(minLength: Space.s2)
                strip(items)
                meta
            }
            .frame(minHeight: 26)
            if let subject {
                Group {
                    if strong {
                        // A command that runs past the edge wraps as a code block's line does, under a ↪.
                        WrappedCode(code: subject, ink: Palette.ink)
                    } else {
                        subjectText(subject).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.leading, markRoom + 7)
            }
        }
    }

    /// The step on one line; `whole` keeps the command whole, so it fits or doesn't, where elsewhere it is cut.
    private func line(_ items: [StepPictures.Item], whole: Bool) -> some View {
        HStack(spacing: 7) {
            mark.frame(width: markRoom, height: markRoom)
            verb
            if let subject {
                if whole { subjectText(subject).fixedSize() } else { subjectText(subject).lineLimit(1).truncationMode(.middle) }
            }
            Spacer(minLength: Space.s2)
            strip(items)
            meta
        }
        .frame(minHeight: 26)
    }

    @ViewBuilder private func strip(_ items: [StepPictures.Item]) -> some View {
        if let pictures, !items.isEmpty {
            StepPictureStrip(ref: pictures.ref, items: items, run: run, by: pictures.by, playing: $playing, open: pictures.open)
        }
    }
    private var verb: some View {
        Text(verbatim: record.title)
            .font(.sotto(.caption, .semibold))
            .foregroundStyle(verbStyle)
            .lineLimit(1)
            .layoutPriority(1)
    }
    private func subjectText(_ subject: String) -> some View {
        Text(subject)
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(Palette.muted)
    }

    private var running: Bool { record.status == "running" }

    @ViewBuilder private var mark: some View {
        if running {
            if reduceMotion {
                Light(tone: .accent, size: 6)
            } else {
                ProgressView().controlSize(.mini).tint(Palette.accentText).accessibilityHidden(true)
            }
        } else if record.kind == "subagent" {
            // One agent, as the Agents button and the Agents sheet draw it.
            AgentMark(size: 13, relativeTo: .caption).foregroundStyle(iconStyle)
        } else {
            Image(systemName: icon)
                .iconFont(11, weight: .semibold, relativeTo: .footnote)
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

extension View {
    /// Words on their way: a small spinner in the gutter to the left of their faint bubble, on its line and taking no room,
    /// so the row is exactly as tall as the message it becomes and nothing on the page moves when the words land. A line
    /// saying so under the bubble went when they landed and dropped everything above it by its height, 20.5 points
    /// (Zach, November 4, 2026: "jumps up then back down after the send"; his pick A). VoiceOver reads the words, then
    /// that they are sending.
    @ViewBuilder func sendingBeside(_ words: String?) -> some View {
        if let words {
            overlay(alignment: .leading) {
                ProgressView().controlSize(.mini)
                    .alignmentGuide(.leading) { $0[.trailing] + Space.s2 }
                    .accessibilityHidden(true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityValue(Text(words))
        } else {
            self
        }
    }
}

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
            let hasWords = !(text ?? "").isEmpty
            if let text, hasWords {
                Text(verbatim: text).font(.sotto(.body)).foregroundStyle(Palette.bubbleInk)
                    .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
                    .background(Palette.bubble.opacity(0.6), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .sendingBeside(sending ? words.sending : nil)
                    .padding(.leading, 48)
            }
            if sending {
                // With no words to sit beside, the spinner keeps its own line.
                if !hasWords {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text(words.sending)
                    }
                    .font(.sotto(.caption)).foregroundStyle(Palette.muted)
                    .accessibilityElement(children: .combine)
                }
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

/// The reply box floating over the bottom of the page, with what the computer or the thread needs said above it.
/// While a request waits, the box offers it instead of the field.
private struct ReplyDock: View, Equatable {
    @EnvironmentObject var model: AppModel
    /// The reply box's words, watched here alone: a keystroke redraws the reply box and nothing else.
    @EnvironmentObject var draftStore: DraftStore
    let ref: ThreadRef
    /// Whether the thread has content or is running, so the box goes small while nothing is being written (ADR-0184).
    let goesSmall: Bool
    let openRequest: (AgentRequest) -> Void
    /// Drawn again for what it watches itself, not for each new revision of the conversation above it; a request it
    /// offers opens the same way every time.
    static func == (a: Self, b: Self) -> Bool { a.ref == b.ref && a.goesSmall == b.goesSmall }
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var sent = 0
    @State private var stopped = 0
    /// Watched for which box listens, which changes only as dictation starts and stops.
    @ObservedObject private var dictation = Dictation.shared

    var body: some View {
        let _ = BenchProbe.body("ReplyDock")
        VStack(spacing: Space.s2) {
            ComputerBanner(ref: ref)
            if let problem = model.detailProblem, model.online(ref.hostID) {
                problemNote(problem)
            }
            FollowupStack(ref: ref)
            // What a Watch press just did, with Undo. What watching means is the lit owl's to say, not a line here
            // (Zach, October 31, 2026).
            if model.watchNotice?.target == ref { WatchToast(scope: ref) }
            dock
        }
        .padding(.horizontal, Space.s3)
        .padding(.top, Space.s2)
        .padding(.bottom, Space.s2)
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
        let placeholder = model.thread(ref)?.status == "running" ? String(localized: "Reply while it works") : String(localized: "Reply to this thread")
        let settings = model.threadSettings(ref)
        let listening = dictation.key == ref.id
        // Small unless the user is writing here, or the settings have something to say over the box. The accessibility
        // text sizes stay full: one row can't hold the prompt at those sizes.
        let small = goesSmall && !DebugFlags.replyBoxStaysFull && !typeSize.isAccessibilitySize && !focused && !written && !listening
            && !model.preparingSends.contains(ref.id) && settings?.caption == nil && settings?.notices.isEmpty != false
        // As in Claude's iPhone app (Zach's pick A, November 1, 2026): photos and files wait inside the card above the
        // words, and the row under them holds the +, the thread's settings as one pill (ADR-0166), the mic and Send.
        // What the settings still wait on sits above the card.
        return VStack(alignment: .leading, spacing: Space.s2) {
            if let settings { ThreadSettingsLines(ref: ref, panel: settings) }
            // The trace round the card at the top level of the thread's model, and at Max on Claude under Ultracode
            // (ADR-0019).
            ComposerCard(small: small, lit: settings?.atTopEffort == true, focus: { focused = true }) {
                DraftAttachments(box: .thread(ref))
            } words: {
                words(placeholder, small: small)
            } plus: {
                if listening { ListeningLine() } else { AttachPhotosButton(box: .thread(ref)) }
            } pill: {
                if let settings, !listening { ThreadSettingsPill(ref: ref, panel: settings) }
            } trailing: {
                trailingButtons()
            }
        }
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: model.canInterrupt(ref))
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: written)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: listening)
    }

    private func words(_ placeholder: String, small: Bool) -> some View {
        TextField("Reply", text: draft, prompt: Text(placeholder).foregroundStyle(Palette.placeholder), axis: .vertical)
            .font(.sotto(.body))
            .foregroundStyle(Palette.ink)
            .lineLimit(small ? 1...1 : 1...6)
            .focused($focused)
            // Words added from a reply put the caret after them, here (ADR-0129).
            .onChange(of: draftStore.focus) { _, focus in if focus?.key == ref.id { focused = true } }
            .accessibilityLabel("Reply to this thread")
            .accessibilityIdentifier("thread-reply")
            .pasteAttaches(to: .thread(ref))
            .onChange(of: model.focusRequest, initial: true) { if model.focusRequest == ref.id { model.focusRequest = nil; focused = true } }
            // Locked while the reply's photos are staged, so nothing typed now joins it, and while the mic writes in it.
            .disabled(model.preparingSends.contains(ref.id) || dictation.key == ref.id)
    }

    /// Whether the box holds something to send: words, photos or files.
    private var written: Bool { model.replyHoldsAnything(ref) }

    /// The mic, then Send, which is always there: the accent once the box holds something, dim while it's empty. While
    /// the turn can be stopped, Stop takes Send's place until something is written; then Stop and Send sit side by side,
    /// and Send queues for after the turn. Sending while the mic listens stops it. The mic waits while a send's photos are
    /// made ready.
    @ViewBuilder private func trailingButtons() -> some View {
        let interrupts = model.canInterrupt(ref)
        let preparing = model.preparingSends.contains(ref.id)
        let ready = written || preparing
        HStack(spacing: ComposerMetrics.gap) {
            DictateButton(key: ref.id, words: draft).disabled(preparing)
            if interrupts { stopButton.transition(.scale(scale: 0.6).combined(with: .opacity)) }
            if ready || !interrupts { sendButton.transition(.scale(scale: 0.6).combined(with: .opacity)) }
        }
    }

    /// A solid disc the size of Send, with a larger square: on the soft fill it read as a dot (Zach, October 31, 2026).
    private var stopButton: some View {
        Button { stopped += 1; Task { await model.interrupt(ref) } } label: {
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .frame(width: 12, height: 12)
                .foregroundStyle(Palette.canvas)
                .composerDisc(Palette.ink)
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
        return Button { SendWatch.press(); sent += 1; dictation.cancel(ref.id); Task { await model.send(ref) } } label: {
            Group {
                if preparing { ProgressView().controlSize(.small).tint(Palette.onAccent) }
                else { Image(systemName: queues ? "text.badge.plus" : "arrow.up").font(.system(size: 15, weight: .bold)) }
            }
            .foregroundStyle(canSend || preparing ? Palette.onAccent : Palette.muted)
            .composerDisc(canSend || preparing ? AnyShapeStyle(Palette.accent) : AnyShapeStyle(Palette.fillSoft))
        }
        .buttonStyle(PressStyle())
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: canSend)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: queues)
        .sensoryFeedback(.impact(flexibility: .soft), trigger: sent)
        .disabled(!canSend)
        .accessibilityLabel(queues ? (preparing ? String(localized: "Queuing reply") : String(localized: "Queue for after this turn")) : (preparing ? String(localized: "Sending reply") : String(localized: "Send reply")))
        .accessibilityIdentifier("thread-send")
    }
}

/// The thread's model, effort, speed and permissions as one pill in the reply box's row (ADR-0166, amended November 1,
/// 2026: Zach's picks A and C). It shows the model with its provider's logo and the effort dimmer after it, and opens the
/// settings sheet: the model in use, the models starred on this iPhone that the thread's provider offers, the provider
/// closed until pressed, then Effort, Speed and Permissions, each a row saying what it is set to. What the agent would
/// refuse is held as the chips were: the whole pill during a turn, while the thread waits on the user and while a
/// permission change goes unconfirmed, its hint saying why; the model and effort alone where the provider changes only a
/// started thread's permissions.
private struct ThreadSettingsPill: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let panel: ThreadSettingsPanel
    @State private var picks = 0
    @State private var open = false

    var body: some View {
        let pressable = ThreadSettingKind.allCases.contains { panel.pressable($0) }
        let speedName = panel.speeds.isEmpty ? nil : ThreadSettings.speedName(panel.speed, offered: panel.speeds)
        Button { open = true } label: {
            ComposerPill(providerID: panel.providerID, model: panel.model?.name ?? "", effort: effortName, speed: panel.speed,
                         shield: panel.permission == "full-access" ? .full : panel.permissionGrants ? .grants : .asks,
                         pending: panel.permissionPending)
        }
        .buttonStyle(PressStyle())
        .disabled(!pressable)
        .opacity(pressable ? 1 : 0.55)
        .sensoryFeedback(.selection, trigger: picks)
        .accessibilityLabel(String(localized: "Thread settings"))
        .accessibilityValue([panel.model?.name, effortName, speedName, panel.permissionName].compactMap { $0 }.joined(separator: ", "))
        .accessibilityHint(panel.fixed?.hint ?? String(localized: "Opens this thread’s model, effort, speed and permissions"))
        .accessibilityIdentifier("thread-settings")
        .sheet(isPresented: $open) { sheet }
    }

    private var sheet: some View {
        ComposerSettingsSheet(title: String(localized: "Thread settings"), current: panel.model,
                              groups: [ModelGroup(id: panel.providerID ?? panel.provider, name: panel.provider, models: panel.models)],
                              modelsEnabled: panel.pressable(.model), choose: { choose(.model, $0.id) }) {
            if panel.modelFixed {
                Text("\(panel.provider) changes only a started thread’s permissions.", comment: "%@ is the agent's name, such as Devin.")
            }
        } foot: {
            EmptyView()
        } settings: {
            effortRow
            speedRow
            permissionRow
        }
    }

    private var effortName: String? {
        guard !panel.efforts.isEmpty else { return nil }
        return panel.effort.isEmpty ? String(localized: "Default effort") : EffortWords.name(panel.effort)
    }

    /// Chooses a value for the thread, with the light tap a choice makes, and puts the sheet away.
    private func choose(_ kind: ThreadSettingKind, _ value: String) {
        picks += 1
        open = false
        model.chooseSetting(kind, value, in: ref)
    }

    private func option(_ name: String, line: String? = nil, chosen: Bool, action: @escaping () -> Void) -> some View {
        SettingOption(name: name, line: line, chosen: chosen, action: action)
    }

    @ViewBuilder private var effortRow: some View {
        if let effortName, let reason = panel.effortFixedReason {
            FixedSettingRow(name: Text("Effort", comment: "The field for how hard a new thread's model reasons."), value: effortName, reason: reason)
        } else if let effortName {
            Menu {
                ForEach(Array(panel.efforts.enumerated()), id: \.element) { index, level in
                    option(EffortWords.name(level), line: EffortWords.line(level, index: index, count: panel.efforts.count), chosen: level == panel.effort) {
                        choose(.effort, level)
                    }
                }
            } label: {
                SettingRow(name: Text("Effort", comment: "The field for how hard a new thread's model reasons."), value: effortName)
            }
            .disabled(!panel.pressable(.effort))
        }
    }

    @ViewBuilder private var speedRow: some View {
        if !panel.speeds.isEmpty {
            SpeedMenu(speeds: panel.speeds, speed: panel.speed, providerID: panel.providerID) { choose(.speed, $0) }
                .disabled(!panel.pressable(.speed))
        }
    }

    @ViewBuilder private var permissionRow: some View {
        if !panel.permissions.isEmpty {
            Menu {
                ForEach(panel.permissions) { mode in
                    option(mode.name, line: mode.asks ?? ThreadSettingWords.permissionLine(mode.id, provider: panel.provider, providerID: panel.providerID, computer: model.name(ref.hostID)), chosen: mode.id == panel.permission) {
                        choose(.permissions, mode.id)
                    }
                    .disabled(!panel.mayChoose(mode))
                }
                if !panel.mayAnswer {
                    Text("This iPhone can’t answer on \(model.name(ref.hostID)), so it can only keep this thread asking first.", comment: "%@ is the computer's name.")
                }
            } label: {
                SettingRow(name: Text("Permissions", comment: "The field for the permission mode a new thread starts in."), value: panel.permissionName ?? "")
            }
            .disabled(!panel.pressable(.permissions))
        }
    }
}

/// One choice in a setting chip's menu, in a thread's box and in Watcher's. A toggle, so iOS marks the one in force by its
/// state, which it keeps at the accessibility text sizes where it drops a menu item's images; the line is the item's
/// second text, its subtitle.
struct SettingOption: View {
    let name: String
    var line: String? = nil
    let chosen: Bool
    let action: () -> Void
    var body: some View {
        let isOn = Binding(get: { chosen }, set: { if $0 { action() } })
        if let line {
            Toggle(isOn: isOn) {
                Text(verbatim: name)
                Text(verbatim: line)
            }
        } else {
            Toggle(isOn: isOn) { Text(verbatim: name) }
        }
    }
}

/// A text button in the reply box's row, where Watcher's box offers only its permissions: its value and a small chevron,
/// no fill at rest (ADR-0113). Drawn 32 points tall and pressed across 44. A change the agent hasn't confirmed draws a
/// still dot; nothing in the box draws an edge.
struct SettingChip<Content: View>: View {
    var pending = false
    @ViewBuilder let content: Content
    var body: some View {
        HStack(spacing: 5) {
            content
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).accessibilityHidden(true)
            if pending { Circle().fill(Palette.warning).frame(width: 6, height: 6).accessibilityHidden(true) }
        }
        .font(.sotto(.small, .medium))
        .foregroundStyle(Palette.muted)
        .padding(.horizontal, Space.s2)
        .frame(minHeight: 32)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .padding(.vertical, -6)
    }
}

/// Above the reply box: while a permission change waits, what is still in force; after a change the agent refused, why,
/// with Try again; and a change it never confirmed, with what comes next.
private struct ThreadSettingsLines: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let panel: ThreadSettingsPanel
    var body: some View {
        if panel.caption != nil || !panel.notices.isEmpty {
            VStack(alignment: .leading, spacing: Space.s2) {
                if let caption = panel.caption {
                    Text(caption).font(.sotto(.caption)).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true).paragraphDirection()
                        .accessibilityIdentifier("thread-settings-in-force")
                }
                ForEach(panel.notices) { notice in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                        Text(notice.text).font(.sotto(.small)).foregroundStyle(Palette.warningText)
                            .fixedSize(horizontal: false, vertical: true).paragraphDirection()
                        if notice.retry {
                            Spacer(minLength: 0)
                            Button("Try again") { model.retrySetting(notice.kind, in: ref) }
                                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                                .disabled(!panel.canRetry(notice.kind, wanted: model.threadSettingsPending[ref.id]?.refusals[notice.kind]?.wanted ?? ""))
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("thread-settings-notice-\(notice.kind.rawValue)")
                }
            }
            .padding(.horizontal, Space.s3)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The thread's queued messages over the reply box, in order: two, and a press on the count of the rest shows them all.
private struct FollowupStack: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    @State private var all = false
    var body: some View {
        let _ = BenchProbe.body("FollowupStack")
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

extension View {
    /// A request sheet's heights: half or full, and only full at the accessibility text sizes, where half the screen cut
    /// the sheet's words off and hid its buttons on a small iPhone.
    func requestSheetDetents() -> some View { modifier(RequestSheetDetents()) }
}

private struct RequestSheetDetents: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    /// How tall the request says it needs to be, on the Duo.
    @State private var fit: CGFloat?
    @State private var chosen = PresentationDetent.medium
    func body(content: Content) -> some View {
        let heights: Set<PresentationDetent>
        if typeSize.isAccessibilitySize { heights = [.large] }
        else if let fit { heights = [.height(fit), .large] }
        else { heights = [.medium, .large] }
        return content
            .onPreferenceChange(RequestSheetFit.self) { height in
                guard let height, height != fit else { return }
                if chosen != .large { chosen = .height(height) }
                fit = height
            }
            .presentationDetents(heights, selection: Binding(get: { typeSize.isAccessibilitySize ? .large : chosen }, set: { chosen = $0 }))
            .presentationDragIndicator(.visible)
    }
}

/// How tall a request sheet's words, choices and buttons stand. On the Duo half the screen cut the third choice off with
/// a band of nothing under the buttons, so the sheet opens exactly this tall (Zach's pick A, November 8, 2026).
struct RequestSheetFit: PreferenceKey {
    static let defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}

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
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.sheetClose) private var sheetClose
    @Environment(\.duoLayout) private var duo
    @Environment(\.colorScheme) private var scheme
    let place: RequestPlace
    let request: AgentRequest
    /// Closes the sheet: Sotto's own over the page on the Duo held sideways, iOS's anywhere else.
    private func dismiss() { if let sheetClose { sheetClose() } else { systemDismiss() } }
    /// The height of what scrolls and of the buttons under it, for the Duo's fit.
    @State private var wordsHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
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
    /// Folded, how wide the strip under the clock is. Only the heading keeps clear of it; the choices and the buttons run
    /// to the sheet's own margin below the clock, where the strip was 95 points of nothing (Zach's pick A, November 9,
    /// 2026, round 4).
    private var foldedStrip: CGFloat { if case .folded(let strip) = duo { return strip } else { return 0 } }

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
            .padding(.bottom, choicesMeetFooter ? Space.s2 : Space.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { wordsHeight = $0 }
        }
        .scrollDismissesKeyboard(.interactively)
        .ignoresSafeArea(.container, edges: foldedStrip > 0 ? .trailing : [])
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) { footer }.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { footerHeight = $0 }
                .ignoresSafeArea(.container, edges: foldedStrip > 0 ? .trailing : [])
        }
        // iOS adds the bottom safe area to a height detent itself, so it isn't counted here.
        .preference(key: RequestSheetFit.self, value: duo == .none || wordsHeight == 0 ? nil : wordsHeight + footerHeight)
        .presentationBackground { SheetBackdrop(wash: true) }
        .environment(\.sottoOnSheet, true)
        .presentationCornerRadius(Radius.xl)
        .onChange(of: current == nil && !model.hasPending(at: place)) { _, gone in if gone { dismiss() } }
        .sheet(item: $opening) { row in SafariPage(url: row.url).ignoresSafeArea() }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: answered)
    }

    @ViewBuilder private func content(_ current: AgentRequest, threadTitle: String, providerID: String?) -> some View {
        let provider = Words.provider(providerID)
        let permission = current.kind == "permission"
        let count = current.questions?.count ?? 0
        let from = Self.from(count: count, provider: provider, threadTitle: threadTitle)
        // Who asks and where is one quiet line over the request, and VoiceOver reads the request first (#1855).
        VStack(alignment: .leading, spacing: 0) {
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
                    .accessibilitySortPriority(1)
                    .accessibilityIdentifier("request-headline")
            }
        }
        .padding(.trailing, foldedStrip)
        .accessibilityElement(children: .contain)
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
        if permission {
            permissionBody(current, provider: provider)
        } else if let context = current.context {
            if let command = context.command { PermissionCommand(command: command).padding(.top, Space.s5) }
            if let cwd = context.cwd { runsIn(cwd) }
            if let details = context.details {
                Text(details).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
            }
        }
        if !current.supported {
            note(String(localized: "This request can’t be answered here. Check the thread, or answer it on \(computer).", comment: "%@ is the computer's name"))
            Button("Not now") { dismiss() }.buttonStyle(PillButtonStyle(kind: .soft, wide: true)).padding(.top, Space.s5)
        } else if !model.mayAnswer(at: place) {
            // Pairing lets this iPhone answer (ADR-0033, October 30 amendment), so only a computer from before that says no.
            note(String(localized: "This request can’t be answered here. Check the thread, or answer it on \(computer).", comment: "%@ is the computer's name"))
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

    /// What a permission asks: a command under the model's summary of it, or what another request does, on what, with
    /// every other field in readable lines. The summary is the model's own words, so it is marked as theirs (ADR-0185).
    @ViewBuilder private func permissionBody(_ current: AgentRequest, provider: String) -> some View {
        let context = current.context
        if let command = context?.command {
            if let context, let summary = context.summary {
                ModelSummary(heading: RequestText.summaryHeading(context, provider: provider), summary: summary).padding(.top, Space.s3)
            } else if let context {
                Text(RequestText.noSummary(context, provider: provider)).font(.sotto(.body)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true).paragraphDirection().padding(.top, Space.s3)
            }
            PermissionCommand(command: command).padding(.top, Space.s4)
            ForEach(Array((context?.details ?? "").split(separator: "\n").enumerated()), id: \.offset) { _, line in
                HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                    Light(tone: .warning)
                    Text(verbatim: String(line)).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .padding(.top, Space.s3)
            }
            if let cwd = context?.cwd { runsIn(cwd) }
        } else {
            if let context, let summary = context.summary {
                ModelSummary(heading: RequestText.summaryHeading(context, provider: provider), summary: summary).padding(.top, Space.s3)
            }
            // The rest of its words, where its first line is the headline.
            if let rest = RequestText.permissionLead(current).rest {
                Text(verbatim: rest).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
            }
            if let target = context?.target {
                Text(verbatim: target).font(.mono).foregroundStyle(Palette.muted).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, Space.s1)
            }
            if let details = context?.details { PermissionDetails(details: details).padding(.top, Space.s3) }
            if let cwd = context?.cwd { runsIn(cwd) }
        }
    }

    /// Who asks, and in which thread, over the headline: "Claude Code · Choose the release target", the same on a
    /// permission and a question (#1855). Several questions have no headline, so the line counts them first.
    private static func from(count: Int, provider: String, threadTitle: String) -> String {
        let place = "\(provider) · \(threadTitle)"
        guard count > 1 else { return place }
        let questions = String(localized: "\(count) questions", comment: "How many questions a request asks")
        return "\(questions) · \(place)"
    }

    /// The sheet's headline: what a permission asks, a lone question, or a request's own words when it has no
    /// structured questions. Nil for several questions.
    private func title(_ request: AgentRequest, _ provider: String) -> String? {
        if request.kind == "permission" {
            if let headline = RequestText.permissionLead(request).headline { return headline }
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
            if showsTitle && isSkipped(item) {
                skippedRow(item, enabled: enabled)
            } else {
                if showsTitle {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                        Text(verbatim: item.question).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        // A question of several its provider lets the user skip on its own has a Skip of its own (ADR-0135).
                        if skipsOnItsOwn(item) {
                            Button("Skip") { answers[item.id] = .skip; if focus == item.id { focus = nil } }
                                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                                .accessibilityLabel(String(localized: "Skip this question: \(item.question)", comment: "%@ is the question's own words"))
                                .accessibilityIdentifier("request-skip-\(item.id)")
                                .disabled(!enabled)
                        }
                    }
                }
                if let reason = item.unavailableReason {
                    Text(verbatim: reason).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
                choices(item).disabled(!enabled)
            }
        }
    }

    /// A question skipped on its own folds to one row saying the agent decides, with a way back to answering it (Zach's
    /// pick, November 6, 2026).
    private func skippedRow(_ item: Question, enabled: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        let provider = Words.provider(owner?.providerID)
        return HStack(alignment: .center, spacing: Space.s3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.question).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                Text(String(localized: "Skipped. \(provider) will use its own judgement.", comment: "Under a skipped question. %@ is the agent's name, such as Claude Code."))
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            Button("Answer it") { answers[item.id] = nil }
                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                .accessibilityIdentifier("request-unskip-\(item.id)")
                .disabled(!enabled)
        }
        .padding(Space.s3)
        .background(Palette.code, in: shape)
        .accessibilityIdentifier("request-skipped-\(item.id)")
    }

    private func isSkipped(_ item: Question) -> Bool { answers[item.id]?.skipped == true }
    /// One question of several that its provider lets the user skip while answering the rest.
    private func skipsOnItsOwn(_ item: Question) -> Bool {
        (current?.questions?.count ?? 0) > 1 && item.skippable == true && item.unavailableReason == nil
    }
    /// What the user has chosen or written for a question, starting again when it was skipped.
    private func draft(_ item: Question) -> QuestionAnswer {
        answers[item.id].flatMap { $0.skipped == true ? nil : $0 } ?? QuestionAnswer()
    }
    private func hasAnswer(_ item: Question) -> Bool {
        guard !isSkipped(item) else { return false }
        return !(answers[item.id]?.optionIds.isEmpty ?? true) || !(answers[item.id]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    /// Every question at once: the request's own skip where the provider takes one, or each question skipped where only
    /// that is offered.
    private func skipsAll(_ request: AgentRequest) -> Bool {
        guard let questions = request.questions, !questions.isEmpty else { return false }
        return request.skippable == true || questions.allSatisfy { $0.skippable == true && $0.unavailableReason == nil }
    }
    /// The questions Skip the rest would skip: those still open, once another has an answer.
    private func rest(_ request: AgentRequest) -> [Question] {
        let questions = request.questions ?? []
        guard questions.contains(where: hasAnswer) else { return [] }
        return questions.filter { skipsOnItsOwn($0) && !isSkipped($0) && !hasAnswer($0) }
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
        var answer = draft(item)
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
        var answer = draft(item)
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
        let text = Binding(get: { answers[item.id]?.text ?? "" }, set: { value in
            var answer = draft(item)
            answer.text = value
            if !item.multiSelect && !value.isEmpty { answer.optionIds = [] }
            answers[item.id] = answer
        })
        let label = String(localized: "Your own answer to: \(item.question)", comment: "%@ is the question's own words")
        return Group {
            if item.secret == true {
                secretField(text: text, id: item.id, label: label)
            } else {
                answerField(text: text, id: item.id, label: label)
            }
        }
        .disabled(item.unavailableReason != nil)
    }

    /// A secret answer's box (#2153): one masked line the keyboard neither learns from nor suggests into, held only in
    /// this view's state like every answer here, with a line saying who keeps the words.
    private func secretField(text: Binding<String>, id: String, label: String) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        let provider = Words.provider(owner?.providerID)
        return VStack(alignment: .leading, spacing: Space.s2) {
            SecureField("Your answer", text: text, prompt: Text("Type your answer").foregroundStyle(Palette.placeholder))
                .font(.sotto(.body))
                .foregroundStyle(Palette.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .privacySensitive()
                .focused($focus, equals: id)
                .padding(Space.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.code, in: shape)
                .overlay(shape.strokeBorder(focus == id ? Palette.accent.opacity(0.6) : Palette.hairline, lineWidth: 1))
                .accessibilityLabel(label)
            Text(verbatim: String(localized: "\(provider) will see this and keep it in its own session file. Sotto does not save it.",
                                  comment: "Under a masked answer box. %@ is the agent's name, such as Codex."))
                .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
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
                if answers[q.id]?.skipped == true { return q.skippable == true || request.skippable == true }
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

    /// Skip the rest, once a question has an answer, and the request's whole Skip (ADR-0135, November 6, 2026). Skip sends
    /// at once, as on the computer; Skip the rest only marks the open questions skipped, for Send answer to send.
    @ViewBuilder private func skipLine(_ current: AgentRequest) -> some View {
        let unanswered = rest(current)
        let all = skipsAll(current) && !(current.questions ?? []).allSatisfy(isSkipped)
        if !unanswered.isEmpty || all {
            HStack(spacing: Space.s2) {
                if !unanswered.isEmpty {
                    Button("Skip the rest") { for item in unanswered { answers[item.id] = .skip }; focus = nil }
                        .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                        .accessibilityIdentifier("request-skip-rest")
                }
                Spacer(minLength: 0)
                if all {
                    Group {
                        if (current.questions?.count ?? 0) > 1 { Button("Skip all") { skipAll(current) } } else { Button("Skip") { skipAll(current) } }
                    }
                    .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                    .accessibilityIdentifier("request-skip-all")
                }
            }
            .disabled(!model.canAnswer(current, at: place))
        }
    }

    private func skipAll(_ current: AgentRequest) {
        for item in current.questions ?? [] { answers[item.id] = .skip }
        sendAnswer(current)
    }

    /// Whether Not now and Send answer stand in the footer under the question, rather than in what scrolls.
    private var hasFooter: Bool {
        guard let current else { return false }
        return current.kind != "permission" && current.supported && model.mayAnswer(at: place)
    }
    /// Folded or sideways, the last choice stands as far above the footer's rule as the choices stand from each other,
    /// where the page's own 20 points left a band over the footer in a sheet that opens exactly tall enough for its
    /// choices and its buttons (the Duo design climb's round 8).
    private var choicesMeetFooter: Bool { duo != .none && duo != .upright && hasFooter }
    /// Whether Not now is the outline pill: on the Duo in light, and folded or sideways in dark as well.
    private var notNowRing: Bool { duo != .none && (scheme == .light || duo != .upright) }

    /// Not now and Send answer stay in reach under a question, whatever its length.
    @ViewBuilder private var footer: some View {
        if let current, hasFooter {
            VStack(spacing: Space.s2) {
                sendingLine(current)
                skipLine(current)
                HStack(spacing: Space.s2) {
                    // On the Duo in light, Not now is a ring on the sheet's own fill, so it can't read as the greyed Send
                    // answer beside it (Zach's round 6 pick A, November 10, 2026). Folded and sideways it is the ring in
                    // dark too, where the two had been the same grey pill and Not now's brighter label read as the
                    // primary (his round 8 pick A, November 10, 2026).
                    Button("Not now") { dismiss() }
                        .buttonStyle(PillButtonStyle(kind: notNowRing ? .outline : .soft, wide: true))
                    // Every question skipped sends a skip, so the button says so (ADR-0135).
                    Group {
                        if let questions = current.questions, !questions.isEmpty, questions.allSatisfy(isSkipped) {
                            if questions.count > 1 { Button("Skip all") { sendAnswer(current) } } else { Button("Skip") { sendAnswer(current) } }
                        } else {
                            Button("Send answer") { sendAnswer(current) }
                        }
                    }
                        .buttonStyle(PillButtonStyle(kind: .primary, wide: true))
                        .disabled(!model.canAnswer(current, at: place) || !ready(current))
                        .accessibilityIdentifier("request-send-answer")
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s3)
            .padding(.bottom, Space.s2)
            .background { SheetBackdrop(wash: false) }
            // The line runs under the folded Duo's strip too, to the sheet's edge, rather than stopping where the strip starts.
            .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1).ignoresSafeArea(.container, edges: .horizontal) }
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
                .iconFont(16, weight: .semibold)
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
                .iconFont(16, weight: .semibold)
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
    @Environment(\.duoLayout) private var duo
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
            // On the Duo an empty mark is a thicker ring in the words' muted grey, where the thin border sank into the
            // choice's fill (Zach's pick A, November 9, 2026, round 5).
            shape.strokeBorder(chosen ? Color.clear : theme.color(duo != .none ? .muted : .border), lineWidth: duo != .none ? 2.25 : 1.5)
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Palette.onAccent)
                .opacity(chosen ? 1 : 0)
        }
        .frame(width: 22, height: 22)
        .glow(Circle(), color: theme.color(.accent), alpha: 0.6, radius: 6, showing: chosen)
        .animation(.easeInOut(duration: 0.25), value: chosen)
        .accessibilityHidden(true)
    }
}

/// What a short permission card, which can answer, shows beyond its words: a setting beside a command, or the opening of a
/// request's change and fields. **Details** opens the whole of it.
struct CompactPermissionDetails: View {
    let context: RequestContext?
    var body: some View {
        if let details = context?.details, !details.isEmpty {
            if context?.command != nil {
                Text(verbatim: details).font(.sotto(.small)).foregroundStyle(Palette.ink).lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Space.s2)
            } else {
                Text(verbatim: details).font(.mono).foregroundStyle(Palette.codeInk).lineLimit(4)
                    .padding(.horizontal, Space.s3).padding(.vertical, Space.s2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.code, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
                    .padding(.top, Space.s2)
            }
        }
    }
}

/// A summary, under whose words it is: never a headline, since Sotto checked none of them.
private struct ModelSummary: View {
    let heading: String
    let summary: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(heading).font(.sotto(.small)).foregroundStyle(Palette.muted)
            Text(verbatim: summary).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The rest of what a permission that is not a command asks: its change and every other field, on the code surface.
private struct PermissionDetails: View {
    let details: String
    var body: some View {
        Text(verbatim: details).font(.mono).foregroundStyle(Palette.codeInk).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.s3)
            .background(Palette.code, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
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
        .glow(shape, color: theme.color(.warning), alpha: 0.3, radius: 16, y: 8)
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

/// The thread page's first use, paid once a second after launch rather than by the first thread opened: a short made-up
/// thread, read from wire bytes, laid out hidden for a moment and let go. The page's view types, its text views, its date
/// reader and its decoder are then ready. Opening a long thread took about a fifth less time with it, for about 0.6 s of
/// work after launch (#1702). It waits while a finger drags or a list glides, so a scroll already under way keeps its
/// frames; one that starts in the frame its rows are laid out can still meet them.
struct ThreadPageWarmUp: View {
    @MainActor private static var done = false
    @State private var detail: ThreadDetail?
    var body: some View {
        Color.clear.overlay(alignment: .topLeading) { if let detail { WarmRows(detail: detail) } }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .task {
                guard !Self.done else { return }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                let data = await Task.detached(priority: .utility) { BenchWire.longDetailFrame(turns: 3, now: Date()) }.value
                guard case .detail(_, let value)? = try? await Wire.readFrame(data), !Task.isCancelled else { return }
                // The rows go in during a turn of the main run loop in its default mode, which it leaves while a finger
                // drags or a list glides, so they aren't set while a scroll is under way.
                await withCheckedContinuation { (laid: CheckedContinuation<Void, Never>) in
                    CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue) {
                        MainActor.assumeIsolated { detail = value }
                        laid.resume()
                    }
                    CFRunLoopWakeUp(CFRunLoopGetMain())
                }
                try? await Task.sleep(nanoseconds: 300_000_000)
                // Cancelled while it waited, the page went out of sight and the rows may never have been laid out.
                if !Task.isCancelled { Self.done = true }
                detail = nil
            }
    }
}

private struct WarmRows: View {
    let detail: ThreadDetail
    var body: some View {
        let ref = ThreadRef(hostID: "warm-up", threadID: detail.threadId)
        let rows = ConversationRow.make(ThreadTimeline.items(messages: detail.messages, activities: detail.activities ?? []), date: Stamp.date)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
                switch row.item {
                case .message(let message):
                    MessageView(message: message, provider: "Codex", showsWho: row.showsWho, ref: ref, opensFiles: false) { _ in }.equatable()
                case .steps(let steps):
                    FoldedRun(runID: steps.first?.id ?? row.id, steps: steps, seconds: row.seconds, working: false, open: false, last: false) {}
                        .equatable()
                }
            }
        }
        .hidden()
    }
}
