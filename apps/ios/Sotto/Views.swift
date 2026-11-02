import SwiftUI
import UIKit
import SottoCore

/// Pairing until this iPhone holds a computer, then Threads, Computers and Settings.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        let _ = BenchProbe.body("RootView")
        // The whole screen, safe areas included, for Glass's backdrop on every page, pairing included.
        GeometryReader { frame in
            let insets = frame.safeAreaInsets
            Group { if model.computers.isEmpty { PairFlow() } else { MainTabs() } }
                .environment(\.sottoScreen, CGSize(width: frame.size.width + insets.leading + insets.trailing,
                                                    height: frame.size.height + insets.top + insets.bottom))
        }
    }
}

/// The tabs: Threads, Watcher when a paired computer runs it, Computers and Settings. The system's tab bar is hidden
/// for `TabsBar`, which sits on the page with no glass behind it (ADR-0051, amended).
struct MainTabs: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = Tab.threads
    @State private var threadPath = NavigationPath()
    @State private var watcherPath = NavigationPath()
    @State private var covered = Set<UUID>()
    @State private var keyboard = false
    /// Each tab's count of presses asking its first page to scroll to the top.
    @State private var tops: [Tab: Int] = [:]
    /// The sidebar brought over an upright unfolded Duo's page, by a thumb's drag or the rail's sidebar button.
    @State private var drawer = false
    /// Where a thumb has the upright sidebar while it drags it, read by the drawer alone so a drag redraws nothing else.
    @State private var pull = SidebarPull()
    /// Held sideways, the sidebar beside a page that isn't a thread: hidden until the rail's button or a drag brings it.
    @State private var sidebarElse = false
    /// New thread, opened from the Duo's rail.
    @State private var creating = false
    /// The Duo was last folded, on the Threads list, so unfolding it opens the list's top row (`openTopRow`).
    @State private var foldedOnList = false
    /// How much of the page shows: below one while a change that isn't a push or a pop fades it (`crossfade`, `fadeIn`).
    @State private var pageShown = 1.0
    enum Tab: Hashable { case threads, watcher, computers, settings }
    @Environment(\.horizontalSizeClass) private var width
    @Environment(\.verticalSizeClass) private var height
    @Environment(\.sottoGlass) private var glass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(PhonePreferenceKey.duoTabsSide) private var railSide = DuoTabsSide.right.rawValue
    @AppStorage(PhonePreferenceKey.duoSidebarHidden) private var sidebarHidden = false
    var body: some View {
        let _ = BenchProbe.body("MainTabs")
        GeometryReader { frame in
            let duo = duoLayout(frame.safeAreaInsets)
            tabs(duo: duo).environment(\.duoLayout, duo)
        }
    }
    /// Which of the iPhone Duo's screens this is (ADR-0151, amended). Its cover screen leaves a strip down its right
    /// edge, under the clock and battery, outside the safe area but inside the window, and unfolded and held sideways
    /// the clock keeps such a strip. An upright iPhone has no side insets, and one held sideways has two alike, so neither
    /// has a strip; a Max held sideways is regular width but compact height, which the Duo unfolded and upright is not.
    /// The app is always left to right, so a strip on the right is the trailing inset.
    private func duoLayout(_ insets: EdgeInsets) -> DuoLayout {
        let side = insets.trailing - insets.leading
        if width == .compact { return side >= 60 ? .folded(strip: insets.trailing) : .none }
        if abs(side) >= 60 { return .sideways(strip: max(insets.leading, insets.trailing), stripTrailing: side > 0) }
        return height == .regular ? .upright : .none
    }
    /// Where the tabs stand: along the bottom; as a rail in the Duo's strip, where the pages get the whole height; or, in
    /// a column of the strip's width: down the right edge of the unfolded Duo held upright, where the right thumb rests
    /// (Zach's pick, November 1, 2026), or held sideways with the rail on the side away from the clock.
    private enum RailPlace: Equatable { case bottom, strip(trailing: Bool, width: CGFloat), column(leading: Bool, width: CGFloat) }
    private func railPlace(_ duo: DuoLayout) -> RailPlace {
        switch duo {
        case .none: return .bottom
        case .upright: return .column(leading: false, width: DuoLayout.uprightRail)
        case .folded(let strip): return .strip(trailing: true, width: strip)
        case .sideways(let strip, let stripTrailing):
            let right = DuoTabsSide(rawValue: railSide) != .left
            return right == stripTrailing ? .strip(trailing: stripTrailing, width: strip) : .column(leading: !right, width: strip)
        }
    }
    /// A thread is open on the tab that shows.
    private var threadOpen: Bool {
        switch tab {
        case .threads: return !threadPath.isEmpty
        case .watcher: return !watcherPath.isEmpty
        case .computers, .settings: return false
        }
    }
    private func tabs(duo: DuoLayout) -> some View {
        let place = railPlace(duo)
        let opened = duo.sideways || duo == .upright
        let upright = duo == .upright
        // A thread and the keyboard cover the tabs, except on the unfolded Duo, where the rail stays in its place beside
        // the page (Zach's picks of October 30 and November 1, 2026): sideways it is the way out of a thread, and upright
        // it holds the sidebar and the tabs where the right thumb rests, so the keyboard draws over its foot rather than
        // taking it away.
        let shown = opened || threadRail(duo) || (!keyboard && covered.isEmpty)
        let sidebar = duo.sideways && sidebarShown
        // The bar sits under the pages rather than in their safe area, which a NavigationStack doesn't pass on to its
        // pages: they end above it, as they did above the system's.
        return HStack(spacing: 0) {
            if case .column(leading: true, width: let strip) = place { rail(shown, top: Space.s4, duo: duo).frame(width: strip) }
            if sidebar {
                ThreadSidebar(open: openFromSidebar).equatable()
                    // With Reduce Motion it fades in on its own, so nothing of the page beside it moves.
                    .modifier(FadeOnAppear(enabled: reduceMotion))
                    .transition(reduceMotion ? .identity : .move(edge: .leading).combined(with: .opacity))
            }
            VStack(spacing: 0) {
                // The theme's ground stays behind the page as it fades in, so no other colour shows through.
                pages.opacity(pageShown).background { if glass == nil { PageGround().ignoresSafeArea().accessibilityHidden(true) } }
                if place == .bottom && covered.isEmpty && !keyboard {
                    TabsBar(tab: tabChoice, threadsBadge: model.threadsBadge, watcher: model.watcherHostID == nil ? nil : model.watcherTab,
                            style: .bar, reselect: reselect)
                }
            }
            // Upright, the sidebar comes over the page from its left edge and stops at the rail, which stays in reach.
            .overlay {
                if upright && sidebarAvailable {
                    SidebarDrawer(shown: $drawer, pull: pull, open: openFromSidebar).equatable()
                }
            }
            if case .column(leading: false, width: let strip) = place {
                // Upright it starts just under the status bar; sideways, in a column of its own, a step down from the top.
                rail(shown, top: upright ? Space.s3 : Space.s4, duo: duo).frame(width: strip)
            }
        }
        // A thumb's drag moves the sidebar: upright it follows the thumb in and out from anywhere on a page; sideways a
        // drag right brings it beside the page and a drag left puts it away (Zach's picks, November 1, 2026).
        .background {
            SidebarSwipe(enabled: opened && sidebarAvailable, follows: upright, shown: upright ? drawer : sidebarShown,
                         pull: pull, settle: { settleSidebar($0, upright: upright) })
                .accessibilityHidden(true)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: sidebar)
        // Folding or unfolding the Duo reshapes the page into its new place rather than jumping there; with Reduce
        // Motion the page fades in instead (Zach, TestFlight build 45, point 6).
        .animation(reduceMotion ? nil : .spring(response: 0.48, dampingFraction: 0.9), value: duo)
        .overlay(alignment: .trailing) {
            if case .strip(trailing: true, width: let strip) = place {
                Group {
                    // Folded, an open thread's controls take the strip in place of its bar and the tabs (Zach's pick A),
                    // crossfading with them as the thread comes and goes.
                    if threadRail(duo) { FoldedThreadRail(ref: model.selected, clear: duo.clockClearance, back: popThread).equatable().transition(.opacity) }
                    else { rail(shown, top: duo.clockClearance, duo: duo).transition(.opacity) }
                }
                .animation(.easeInOut(duration: reduceMotion ? 0.2 : 0.25), value: threadRail(duo))
                .frame(width: strip).offset(x: strip)
            }
        }
        .overlay(alignment: .leading) {
            if case .strip(trailing: false, width: let strip) = place { rail(shown, top: duo.clockClearance, duo: duo).frame(width: strip).offset(x: -strip) }
        }
        .sheet(isPresented: $creating, onDismiss: { model.newThreadClosed() }) {
            NewThreadSheet(opened: { ref in
                model.newThreadOpened(ref)
                tab = .threads
                threadPath = NavigationPath([ThreadRoute(ref: ref)])
            })
        }
        .onChange(of: sidebarAvailable) { _, available in if !available { drawer = false } }
        .onChange(of: duo, initial: true) { before, now in
            drawer = false
            if reduceMotion, before != now { fadeIn() }
            unfolded(to: now)
        }
        .onChange(of: threadPath) { _, path in if case .folded = duo { foldedOnList = path.isEmpty && tab == .threads } }
        .onChange(of: tab) { _, chosen in if case .folded = duo { foldedOnList = threadPath.isEmpty && chosen == .threads } }
        // The page's ground runs on under the Duo's strip and rail, so the rail stands on the page's own ground and the
        // page reaches every edge of the screen, with no band at the top (Zach, November 1, 2026).
        .background { PageGround().ignoresSafeArea().accessibilityHidden(true) }
        .environment(\.tabsCovered, $covered)
        // The bar goes under the keyboard, as the system's did; a hardware keyboard's slim bar leaves it.
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { note in
            keyboard = ((note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.height ?? 0) > 120
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
        .sheet(isPresented: $model.adding, onDismiss: { model.closeAdding() }) { AddComputerSheet() }
        // A tapped alert opens its thread on Threads (ADR-0051), and Watcher's own opens the Watcher tab.
        .onChange(of: model.alertOpened) { _, ref in openAlerted(ref) }
        .onChange(of: model.watcherAlertOpened) { _, hostID in openWatcher(hostID) }
        // Something shared to Sotto opens where it went: Watcher, or Threads, whose new thread's sheet takes it (ADR-0157).
        .onChange(of: model.shareOpened) { _, destination in openShared(destination) }
        .onAppear {
            openAlerted(model.alertOpened); openWatcher(model.watcherAlertOpened); openShared(model.shareOpened)
            #if DEBUG
            openForCapture()
            #endif
        }
        // A confirmation belongs to the page that showed it (ADR-0051): another tab or page clears it.
        .onChange(of: tab) { model.pageLeft() }
        .onChange(of: threadPath) { model.pageLeft() }
        .onChange(of: watcherPath) { model.pageLeft() }
        // A computer that stops offering Watcher takes its tab with it.
        .onChange(of: model.watcherHostID) { _, hostID in
            if hostID == nil, tab == .watcher { tab = .threads; watcherPath = NavigationPath() }
        }
    }
    /// The sidebar has a page to stand beside: every page but the Threads list, which is the same list.
    private var sidebarAvailable: Bool { !(tab == .threads && threadPath.isEmpty) }
    /// Whether the sidebar shows held sideways: beside a thread unless the user hid it there, beside another page only
    /// once they bring it.
    private var sidebarShown: Bool {
        guard sidebarAvailable else { return false }
        return threadOpen ? !sidebarHidden : sidebarElse
    }
    /// The rail's sidebar button and a drag both land here: upright the sidebar comes over the page or goes, sideways it
    /// stands beside the page or goes.
    private func settleSidebar(_ show: Bool, upright: Bool) {
        guard sidebarAvailable || !show else { return }
        let motion: Animation = reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.3, dampingFraction: 0.9)
        withAnimation(motion) {
            if upright { drawer = show } else if threadOpen { sidebarHidden = !show } else { sidebarElse = show }
        }
    }
    /// The rail: on the unfolded Duo the sidebar's button, then New thread, under the clock and battery and apart from
    /// the tabs, on every tab; and the tabs in one pill at the foot, where the thumb rests (Zach's picks, October 30 and
    /// November 1, 2026). In the Duo's strip the page beside it, wash and all, shows under it and the strip reads as the
    /// page's own (ADR-0151, amended).
    @ViewBuilder private func rail(_ shown: Bool, top: CGFloat, duo: DuoLayout) -> some View {
        if shown {
            VStack(spacing: Space.s3) {
                if duo.sideways || duo == .upright { sidebarButton(upright: duo == .upright) }
                newThread
                Spacer(minLength: Space.s3)
                TabsBar(tab: tabChoice, threadsBadge: model.threadsBadge, watcher: model.watcherHostID == nil ? nil : model.watcherTab,
                        style: .rail, reselect: reselect)
            }
            .padding(.top, top)
            .padding(.bottom, Space.s5)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea(.keyboard)
        } else {
            Color.clear
        }
    }
    /// Shows or hides the threads' sidebar, as a drag does. On the Threads list the list is the page, so it rests there.
    private func sidebarButton(upright: Bool) -> some View {
        let showing = upright ? drawer : sidebarShown
        return Button { settleSidebar(!showing, upright: upright) } label: { Image(systemName: "sidebar.left") }
            .buttonStyle(GlassCircleStyle())
            .disabled(!sidebarAvailable)
            .accessibilityLabel(showing ? String(localized: "Hide the threads", comment: "Hides the list of threads beside the open thread on the iPhone Duo unfolded")
                                : String(localized: "Show the threads", comment: "Shows the list of threads beside the open thread on the iPhone Duo unfolded"))
            .accessibilityIdentifier("duo-sidebar")
    }
    /// Unfolding the Duo from the Threads list and holding it sideways opens the list's top row beside the sidebar, marked
    /// there, as if it were tapped: Needs you first, then Working now, then Recent, so a question waiting rises as its
    /// sheet (Zach, TestFlight build 45). Upright keeps the list. The window can pass through other sizes as the Duo
    /// opens, so the fold is remembered until it lands.
    private func unfolded(to now: DuoLayout) {
        switch now {
        case .folded: foldedOnList = tab == .threads && threadPath.isEmpty
        case .sideways:
            if foldedOnList, tab == .threads, threadPath.isEmpty { openTopRow() }
            foldedOnList = false
        case .upright: foldedOnList = false
        case .none: break
        }
    }
    /// The top row of the list as shown, search and all, opened as a press on it opens it: a delegated thread that asks opens
    /// over the one that delegated. A search that finds nothing opens nothing.
    private func openTopRow() {
        let groups = model.focusThreads(show: model.show, query: model.listQuery)
        guard let row = groups.questions.first ?? groups.working.first ?? groups.recent.first else { return }
        var routes = [ThreadRoute(ref: row.ref)]
        let asking = groups.asking(row)
        if asking.ref != row.ref { routes.append(ThreadRoute(ref: asking.ref)) }
        // It comes in with the unfolding, beside the sidebar sliding in, rather than pushing across the new screen.
        quietly { threadPath = NavigationPath(routes) }
        fadeIn()
    }
    /// Whether the folded Duo's strip holds an open thread's controls rather than the tabs.
    private func threadRail(_ duo: DuoLayout) -> Bool {
        if case .folded = duo { return threadOpen } else { return false }
    }
    /// Back from the folded thread rail: the thread showing goes back itself, since a delegated thread opened from Agents
    /// sits on its page rather than on the tab's path. With no thread read yet, the tab's path goes back one.
    private func popThread() {
        if let ref = model.selected { model.railAsked = RailAsk(ref: ref, action: .back); return }
        if tab == .watcher, !watcherPath.isEmpty { watcherPath.removeLast() } else if !threadPath.isEmpty { threadPath.removeLast() }
    }
    /// New thread on the Duo's rail or row, the round button the Threads page heading has on every other iPhone.
    private var newThread: some View {
        Button { creating = true } label: { Image(systemName: "plus") }
            .buttonStyle(GlassCircleStyle())
            .accessibilityLabel("New thread")
            .accessibilityIdentifier("new-thread")
    }
    private var pages: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $threadPath) {
                ThreadsView(open: { ref in threadPath.append(ThreadRoute(ref: ref)) }).threadDestination()
            }
                .environment(\.pageTop, tops[.threads, default: 0])
                .toolbar(.hidden, for: .tabBar)
                .tag(Tab.threads)
            // Watcher's tab (1B), only for a computer that runs Watcher and shows it to this iPhone.
            if let hostID = model.watcherHostID {
                NavigationStack(path: $watcherPath) { WatcherView(hostID: hostID).threadDestination() }
                    .toolbar(.hidden, for: .tabBar)
                    .tag(Tab.watcher)
            }
            NavigationStack { ComputersView() }
                .environment(\.pageTop, tops[.computers, default: 0])
                .toolbar(.hidden, for: .tabBar)
                .tag(Tab.computers)
            NavigationStack { SettingsView() }
                .environment(\.pageTop, tops[.settings, default: 0])
                .toolbar(.hidden, for: .tabBar)
                .tag(Tab.settings)
        }
    }
    /// A page change that isn't a push or a pop, as the prototype draws it (Zach, TestFlight build 45, point 6): the page
    /// fades out to the theme's ground, changes with nothing moving, and fades in, in about a quarter of a second, a little
    /// slower with Reduce Motion. A push and a pop stay iOS's own, with its swipe back, and with Reduce Motion they follow
    /// iOS's Prefer Cross-Fade Transitions. Another tab and another thread from the sidebar go this way.
    private func crossfade(_ change: @escaping () -> Void) {
        withAnimation(.easeIn(duration: reduceMotion ? 0.12 : 0.08)) { pageShown = 0 } completion: {
            quietly(change)
            withAnimation(.easeOut(duration: reduceMotion ? 0.2 : 0.14)) { pageShown = 1 }
        }
    }
    /// The page fades in where it already stands, for a change the window made, such as the Duo unfolding onto the list's
    /// top row, or folding with Reduce Motion.
    private func fadeIn() {
        quietly { pageShown = 0 }
        // The next turn of the run loop, so the page draws clear before it fades in.
        DispatchQueue.main.async { withAnimation(.easeOut(duration: reduceMotion ? 0.2 : 0.16)) { pageShown = 1 } }
    }
    /// Changes something with nothing moving.
    private func quietly(_ change: () -> Void) {
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still, change)
    }
    /// The tab the tabs choose: another one crossfades in.
    private var tabChoice: Binding<Tab> {
        Binding(get: { tab }, set: { chosen in
            guard chosen != tab else { return }
            crossfade { tab = chosen }
        })
    }
    /// A thread chosen in the sidebar opens in place of the one showing, on the tab that shows it, with a quick fade
    /// rather than a push: the sidebar stays where it is.
    private func openFromSidebar(_ ref: ThreadRef) {
        drawer = false
        guard ref != model.selected else { return }
        crossfade {
            if tab == .watcher, !watcherPath.isEmpty {
                watcherPath.removeLast()
                watcherPath.append(ThreadRoute(ref: ref))
            } else {
                tab = .threads
                threadPath = NavigationPath([ThreadRoute(ref: ref)])
            }
        }
    }
    #if DEBUG
    /// Captures of the UI fixture open a page at launch: `--ui-open-thread <id>` opens one of the laptop's threads, and
    /// `--ui-open-watcher` the Watcher tab and `--ui-open-settings` Settings.
    private func openForCapture() {
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--ui-open-thread"), index + 1 < arguments.count {
            threadPath = NavigationPath([ThreadRoute(ref: ThreadRef(hostID: "11111111-1111-4111-8111-111111111111", threadID: arguments[index + 1]))])
        }
        if arguments.contains("--ui-open-watcher"), model.watcherHostID != nil { tab = .watcher }
        if arguments.contains("--ui-open-settings") { tab = .settings }
        // `--ui-orientation portrait|landscapeLeft|landscapeRight` turns the window, to capture the unfolded Duo upright
        // and sideways; `--ui-open-sidebar` then brings an upright thread's sidebar over it, once the turn has settled.
        if let index = arguments.firstIndex(of: "--ui-orientation"), index + 1 < arguments.count,
           let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            let turns: [String: UIInterfaceOrientationMask] = ["portrait": .portrait, "landscapeLeft": .landscapeLeft, "landscapeRight": .landscapeRight]
            if let mask = turns[arguments[index + 1]] { scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) }
        }
        if arguments.contains("--ui-open-sidebar") { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { drawer = true } }
    }
    #endif
    /// A press on the tab already chosen goes back to its first page, as the system's tab bar did; a press with the
    /// first page showing scrolls it to its top.
    private func reselect(_ chosen: Tab) {
        switch chosen {
        case .threads where !threadPath.isEmpty: threadPath = NavigationPath()
        case .watcher where !watcherPath.isEmpty: watcherPath = NavigationPath()
        default: tops[chosen, default: 0] += 1
        }
    }
    private func openAlerted(_ ref: ThreadRef?) {
        guard let ref else { return }
        model.alertOpened = nil
        tab = .threads
        threadPath = NavigationPath([ThreadRoute(ref: ref)])
    }
    private func openShared(_ destination: ShareDestination?) {
        switch destination {
        case .watcher?:
            model.shareOpened = nil
            guard model.watcherHostID != nil else { return }
            tab = .watcher; watcherPath = NavigationPath()
        case .newThread?:
            tab = .threads; threadPath = NavigationPath()
        case nil: return
        }
    }
    private func openWatcher(_ hostID: String?) {
        guard hostID != nil else { return }
        model.watcherAlertOpened = nil
        guard model.watcherHostID != nil else { return }
        tab = .watcher
        watcherPath = NavigationPath()
    }
}

/// The tabs' bar: icons and names straight on the canvas, the chosen tab in the accent, with no shape behind them. Under
/// Glass they float on a capsule of Liquid Glass instead. On the iPhone Duo they are a rail of icons alone in one rounded
/// pill, the chosen one filled on a round tile of the accent (Zach's picks of October 30 and November 1, 2026): every
/// icon one optical size and weight in the same 50-point tile, the owl drawn a little smaller since it is solid where
/// the system's symbols are lines. Watcher's owl carries a dot while Watcher works, and its badge counts what needs the
/// user that only Watcher's page shows; VoiceOver reads both after its name ("Working, 1 needs you").
struct TabsBar: View {
    @Binding var tab: MainTabs.Tab
    let threadsBadge: Int
    let watcher: WatcherTabState?
    /// The bar along the bottom of every other iPhone, or the Duo's pill of icons down its rail.
    enum Style { case bar, rail }
    var style = Style.bar
    /// A press on the tab already chosen.
    var reselect: (MainTabs.Tab) -> Void = { _ in }
    /// A tab's icon: one of the system's symbols, or an image of Sotto's own, the owl.
    enum Icon { case symbol(String), asset(String) }
    private var rail: Bool { style == .rail }
    var body: some View {
        let layout = rail ? AnyLayout(VStackLayout(spacing: DuoRailMetrics.tileGap)) : AnyLayout(HStackLayout(spacing: 0))
        layout {
            item(.threads, .symbol("bubble.left"), Text("Threads"), badge: threadsBadge, spoken: threadsBadge > 0 ? "\(threadsBadge)" : "")
            if let watcher {
                item(.watcher, .asset(watcher.working ? "WatcherTabWorking" : "WatcherTab"), Text("Watcher"), badge: watcher.needs, spoken: watcher.spoken)
            }
            item(.computers, .symbol("desktopcomputer"), Text("Computers"), badge: 0, spoken: "")
            item(.settings, .symbol("slider.horizontal.3"), Text("Settings"), badge: 0, spoken: "")
        }
        .padding(rail ? .all : .horizontal, rail ? DuoRailMetrics.pillInset : Space.s2)
        .padding(.top, rail ? 0 : Space.s1)
        .background {
            if rail {
                Capsule().fill(Palette.surface)
                    .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
                    .accessibilityHidden(true)
            }
        }
        // The names stay at the size the system's tab bar keeps; at the accessibility sizes a long press shows the
        // large content viewer instead. Grown with the text, four names ran together on a small iPhone.
        .dynamicTypeSize(...DynamicTypeSize.large)
        .modifier(TabsGlass(shown: !rail))
        // The bar stands on the page's ground; the rail's pill has its own.
        .background { if !rail { PageGround().ignoresSafeArea().accessibilityHidden(true) } }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
        .accessibilityIdentifier("tabs")
    }
    @ViewBuilder private func glyph(_ icon: Icon, chosen: Bool) -> some View {
        switch icon {
        case .symbol(let name):
            if rail {
                // Drawn as type rather than stretched to a box, so every symbol keeps the system's own margins and weight.
                Image(systemName: name).font(.system(size: DuoRailMetrics.symbol, weight: .medium))
                    .symbolVariant(chosen ? .fill : .none)
                    .frame(width: DuoRailMetrics.icon, height: DuoRailMetrics.icon)
            } else {
                Image(systemName: name).renderingMode(.template).resizable().scaledToFit().frame(width: 24, height: 24)
            }
        case .asset(let name):
            let size: CGFloat = rail ? DuoRailMetrics.owl : 24
            Image(name).renderingMode(.template).resizable().scaledToFit()
                .frame(width: size, height: size)
                .frame(width: rail ? DuoRailMetrics.icon : 24, height: rail ? DuoRailMetrics.icon : 24)
        }
    }
    private func largeIcon(_ icon: Icon) -> Image {
        switch icon {
        case .symbol(let name): return Image(systemName: name)
        case .asset(let name): return Image(name)
        }
    }
    private func item(_ id: MainTabs.Tab, _ icon: Icon, _ title: Text, badge: Int, spoken: String) -> some View {
        let chosen = tab == id
        return Button { if chosen { reselect(id) } else { tab = id } } label: {
            VStack(spacing: 3) {
                glyph(icon, chosen: chosen)
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 {
                            Text(verbatim: "\(badge)").font(.sotto(.caption, .semibold)).monospacedDigit()
                                .foregroundStyle(Palette.canvas).environment(\.colorScheme, .dark)
                                .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
                                .background(Palette.warning, in: Capsule())
                                .offset(x: 12, y: -6)
                        }
                    }
                if !rail { title.font(.sotto(.caption, .medium)).lineLimit(1).minimumScaleFactor(0.8) }
            }
            .foregroundStyle(chosen ? Palette.accentText : Palette.muted)
            .frame(width: rail ? DuoRailMetrics.tile : nil, height: rail ? DuoRailMetrics.tile : nil)
            .background { if rail && chosen { Circle().fill(ThemeRole(.accentSurface)) } }
            .frame(maxWidth: rail ? nil : .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(Text(verbatim: spoken))
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityShowsLargeContentViewer { Label { title } icon: { largeIcon(icon).renderingMode(.template) } }
        .accessibilityIdentifier("tab-\(id)")
    }
}

/// The Duo rail's measures (Zach's pick, November 1, 2026): a pill of 50-point tiles, each icon in a 28-point frame, the
/// system's symbols drawn as 21-point type and the solid owl at 23 points so its ink matches theirs.
enum DuoRailMetrics {
    static let tile: CGFloat = 50
    static let tileGap: CGFloat = 2
    static let pillInset: CGFloat = 5
    static let icon: CGFloat = 28
    static let symbol: CGFloat = 21
    static let owl: CGFloat = 23
}

// The capsule of Liquid Glass the bottom bar floats on under Glass, on iOS 26 and later. The Duo's icons have none.
private struct TabsGlass: ViewModifier {
    let shown: Bool
    @Environment(\.sottoGlass) private var glass
    @ViewBuilder func body(content: Content) -> some View {
        if shown, glass != nil, #available(iOS 26, *) {
            content
                .padding(.bottom, Space.s1)
                .glassEffect(.regular, in: Capsule())
                .padding(.horizontal, Space.s3)
        } else {
            content
        }
    }
}

/// How many times a tab's first page has been asked to scroll to its top, by a press on its tab while it shows. Set for
/// each tab's stack by `MainTabs`; `SheetPage` scrolls whenever it changes.
private struct PageTopKey: EnvironmentKey { static let defaultValue = 0 }
extension EnvironmentValues {
    var pageTop: Int {
        get { self[PageTopKey.self] }
        set { self[PageTopKey.self] = newValue }
    }
}

/// The open threads covering the tabs' bar. A thread joins while it is on screen and leaves when it goes, a press
/// on another tab included, so the bar shows wherever no thread is open.
private struct TabsCoveredKey: EnvironmentKey { static let defaultValue: Binding<Set<UUID>> = .constant([]) }
extension EnvironmentValues {
    var tabsCovered: Binding<Set<UUID>> {
        get { self[TabsCoveredKey.self] }
        set { self[TabsCoveredKey.self] = newValue }
    }
}
private struct CoversTabs: ViewModifier {
    @Environment(\.tabsCovered) private var covered
    @State private var id = UUID()
    func body(content: Content) -> some View {
        content
            .onAppear { covered.wrappedValue.insert(id) }
            .onDisappear { covered.wrappedValue.remove(id) }
    }
}
extension View {
    /// Hides the tabs' bar while this view is on screen, as a thread does.
    func coversTabs() -> some View { modifier(CoversTabs()) }
}

/// Fades a view in when it first shows, while `enabled`: the sidebar with Reduce Motion, which then neither slides nor
/// moves the page beside it.
private struct FadeOnAppear: ViewModifier {
    let enabled: Bool
    @State private var shown = false
    func body(content: Content) -> some View {
        content
            .opacity(!enabled || shown ? 1 : 0)
            .onAppear { if enabled { withAnimation(.easeOut(duration: 0.2)) { shown = true } } }
    }
}

/// A thread, named with its computer: two computers can hold the same thread ID.
struct ThreadRoute: Hashable { let ref: ThreadRef }
extension View {
    func threadDestination() -> some View {
        navigationDestination(for: ThreadRoute.self) { ThreadView(ref: $0.ref).duoThreadBar() }
    }
    /// A thread's bar on the unfolded Duo. A delegated thread opened from Agents is `nested`: its Back goes to the thread
    /// it came from, not the list, so it keeps that.
    func duoThreadBar(nested: Bool = false) -> some View { modifier(DuoThreadBar(nested: nested)) }
}

// MARK: - The iPhone Duo

/// Which of the iPhone Duo's screens the app fills, as `MainTabs` reads it from the window (ADR-0151, amended). Every
/// other iPhone is `.none`.
enum DuoLayout: Equatable {
    case none
    /// The cover screen: the tabs stand in the strip down its right edge.
    case folded(strip: CGFloat)
    /// Unfolded and held sideways: the clock's strip runs down one edge, the right one when `stripTrailing`.
    case sideways(strip: CGFloat, stripTrailing: Bool)
    /// Unfolded and held upright: the rail stands in a column down the right edge, `uprightRail` wide.
    case upright
    var sideways: Bool { if case .sideways = self { return true } else { return false } }
    /// How wide the upright rail's column is: room for the tabs' pill and the round buttons, with a margin each side.
    static let uprightRail: CGFloat = 80
    /// How far down the strip New thread, or a thread's Back, sits: under the clock, battery and page dots, lower on the
    /// cover screen than unfolded. On Zach's Duo the + overlapped the battery at 156 and 108 points (TestFlight build 45),
    /// so both moved down a step and a half.
    var clockClearance: CGFloat { if case .folded = self { return 176 } else { return 124 } }
    /// How wide the strip is on each side of the window, where a page that reaches it carries its ground on under it.
    var strip: (leading: CGFloat, trailing: CGFloat) {
        switch self {
        case .folded(let strip): return (0, strip)
        case .sideways(let strip, let trailing): return trailing ? (0, strip) : (strip, 0)
        // Upright the rail's column is the app's own, not the system's, but the page's ground runs on under it the same.
        case .upright: return (0, Self.uprightRail)
        case .none: return (0, 0)
        }
    }
}
private struct DuoLayoutKey: EnvironmentKey { static let defaultValue = DuoLayout.none }
extension EnvironmentValues {
    var duoLayout: DuoLayout {
        get { self[DuoLayoutKey.self] }
        set { self[DuoLayoutKey.self] = newValue }
    }
}

/// A thread's bar on the unfolded Duo (Zach's picks, October 30 and November 1, 2026). Sideways it has no Back: the rail
/// stays beside the thread, its Threads tab goes back to the list, and the sidebar's button stands on the rail. Upright,
/// Back is the thread's own button, since a thumb's drag right anywhere on the page brings the sidebar rather than going
/// back. A nested thread keeps iOS's Back both ways.
private struct DuoThreadBar: ViewModifier {
    let nested: Bool
    @Environment(\.duoLayout) private var duo
    @Environment(\.dismiss) private var dismiss
    func body(content: Content) -> some View {
        // One subtree whatever the screen, so folding or turning the Duo never resets the thread's own state.
        let sideways = duo.sideways, upright = duo == .upright && !nested
        return content
            .navigationBarBackButtonHidden((sideways && !nested) || upright)
            .toolbar {
                if upright {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { dismiss() } label: { Image(systemName: "chevron.backward") }
                            .accessibilityLabel(String(localized: "Back"))
                            .accessibilityIdentifier("duo-back")
                    }
                    .horizontalOnly()
                }
            }
    }
}

/// The threads beside an open thread on the unfolded Duo, as on the desktop (Zach's picks, October 30, 2026): the
/// thread list, the open thread on the chip the chosen tab wears. A press opens another thread in place of the one
/// showing. The settled shelf stays on the Threads page.
struct ThreadSidebar: View, Equatable {
    @EnvironmentObject var model: AppModel
    let open: (ThreadRef) -> Void
    var width: CGFloat = 280
    /// Upright, over the thread, the sidebar has New thread of its own; sideways the rail beside it has one.
    var newThread = false
    @State private var creating = false
    var body: some View {
        let groups = model.focusThreads(show: model.show, opened: model.selected)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Space.s3) {
                    Text("Threads").font(.sotto(.title, .bold)).foregroundStyle(Palette.ink).accessibilityAddTraits(.isHeader)
                    Spacer(minLength: Space.s2)
                    if newThread {
                        Button { creating = true } label: { Image(systemName: "plus") }
                            .buttonStyle(GlassCircleStyle())
                            .accessibilityLabel("New thread")
                            .accessibilityIdentifier("sidebar-new-thread")
                    }
                }
                .frame(minHeight: 44)
                .padding(.horizontal, Space.s2)
                .padding(.top, Space.s3)
                ThreadListSections(groups: groups, chosen: model.selected, identifier: "sidebar-thread-", open: open).equatable()
            }
            .padding(.horizontal, Space.s2)
            .padding(.bottom, Space.s6)
        }
        .frame(width: width)
        .background(Palette.surface.opacity(0.7))
        .overlay(alignment: .trailing) { Rectangle().fill(Palette.hairline).frame(width: 1) }
        .accessibilityIdentifier("duo-sidebar-list")
        .sheet(isPresented: $creating, onDismiss: { model.newThreadClosed() }) {
            NewThreadSheet(opened: { ref in model.newThreadOpened(ref); open(ref) })
        }
    }
    /// It draws from the model it watches, its width and whether it has New thread; the closure never changes what it draws.
    static func == (lhs: ThreadSidebar, rhs: ThreadSidebar) -> Bool { lhs.width == rhs.width && lhs.newThread == rhs.newThread }
}

/// The thread list (CONTEXT.md): Needs you, Working now and Recent, a row each, as the desktop's sidebar lists them
/// (Zach's pick A, rows only, October 30, 2026). The Threads page shows it on every iPhone but the unfolded Duo, and the
/// unfolded Duo's sidebar shows it beside a thread. A Needs you row is a row like the others: its thread opens on its
/// question.
struct ThreadListSections: View, Equatable {
    @EnvironmentObject var model: AppModel
    let groups: FocusThreads
    /// The thread showing beside the list, on the accent's soft chip.
    var chosen: ThreadRef? = nil
    /// Each row's identifier starts with this: `thread-` on the Threads page, `sidebar-thread-` beside a thread.
    var identifier = "thread-"
    let open: (ThreadRef) -> Void
    var body: some View {
        let _ = BenchProbe.body("ThreadListSections")
        let watched = model.watchedThreadIDs
        VStack(alignment: .leading, spacing: 0) {
            section(String(localized: "Needs you", comment: "The heading over threads waiting on the user's answer."), "needs", groups.questions) { row in
                rowView(row, .needs, watched, asking: groups.asking(row))
            }
            section(String(localized: "Working now"), "working", groups.working) { row in rowView(row, .working, watched) }
            section(String(localized: "Recent", comment: "The heading over threads that finished lately."), "recent", groups.recent) { row in
                rowView(row, .recent(unread: groups.isUnreadFinish(row)), watched)
            }
        }
    }
    /// A Needs you row can stand for a delegated thread that asks (ADR-0081): a press opens the row's thread and then
    /// the one that asks, so its question opens there and Back returns to the thread that delegated it.
    private func rowView(_ row: HostedThread, _ kind: ThreadListRow.Kind, _ watched: Set<String>, asking: HostedThread? = nil) -> some View {
        let isWatched = watched.contains(row.id)
        let delegated = asking.flatMap { $0.ref == row.ref ? nil : $0 }
        // A delegated thread has no row of its own: the row its delegation is reached from is marked while it shows.
        let marked = chosen.map { groups.rowID(for: $0) == row.id } ?? false
        return ThreadListRow(row: row, kind: kind, asking: delegated, watched: isWatched, chosen: marked,
                             canWatch: model.canChangeWatch(row.ref), identifier: identifier,
                             open: { open(row.ref); if let delegated { open(delegated.ref) } },
                             setWatched: { on in Task { await model.setWatched(row.ref, on, title: row.thread.title) } })
            .equatable()
    }
    /// It draws from the model it watches and these: the rows' threads, which section each is in, who asks, the chosen
    /// one and its identifiers. The closure never changes what it draws.
    static func == (lhs: ThreadListSections, rhs: ThreadListSections) -> Bool {
        lhs.identifier == rhs.identifier && lhs.chosen == rhs.chosen && drawn(lhs.groups) == drawn(rhs.groups)
    }
    private static func drawn(_ groups: FocusThreads) -> [String] {
        func rows(_ section: String, _ rows: [HostedThread]) -> [String] {
            rows.map { row in
                let thread = row.thread
                return [section, row.id, thread.title, thread.status, "\(thread.requests.count)", thread.providerId ?? "", row.project ?? "",
                        row.computer, "\(row.status)", thread.summary?.runningTurnStartedAt ?? "", thread.summary?.lastMessageAt ?? "",
                        groups.asking(row).id, "\(groups.isUnreadFinish(row))", "\(row.failed)"].joined(separator: "|")
            }
        }
        return rows("needs", groups.questions) + rows("working", groups.working) + rows("recent", groups.recent)
    }
    @ViewBuilder private func section<Row: View>(_ title: String, _ id: String, _ rows: [HostedThread],
                                                 @ViewBuilder row: @escaping (HostedThread) -> Row) -> some View {
        if !rows.isEmpty {
            ThreadListHeading(title: title, count: rows.count, id: id)
            ForEach(rows) { row($0) }
        }
    }
}

/// A section's quiet heading in the thread list: its name and how many threads it holds.
struct ThreadListHeading: View {
    let title: String
    let count: Int
    let id: String
    var body: some View {
        HStack(spacing: Space.s2) {
            Text(title).font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
            Text("\(count)").font(.sotto(.small)).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, Space.s3)
        .padding(.top, Space.s5)
        .padding(.bottom, Space.s1)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("threads-heading-\(id)")
    }
}

/// One thread in the thread list: its light, title and line, and how long ago, on the accent's soft chip while it is
/// open beside the list. A thread Watcher can keep going offers Watch or Stop watching on a long press.
struct ThreadListRow: View, Equatable {
    /// Which section it is in; a recent or settled thread that finished while nothing showed it is `unread`.
    enum Kind: Equatable { case needs, working, recent(unread: Bool) }
    let row: HostedThread
    let kind: Kind
    /// The delegated thread whose request a Needs you row stands for, when it isn't the row's own.
    var asking: HostedThread? = nil
    let watched: Bool
    let chosen: Bool
    let canWatch: Bool
    let identifier: String
    let open: () -> Void
    let setWatched: (Bool) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    /// What the row draws: the thread's title, state, place and times, its section, light and chip.
    static func == (lhs: ThreadListRow, rhs: ThreadListRow) -> Bool {
        lhs.row.id == rhs.row.id && lhs.kind == rhs.kind && lhs.asking?.id == rhs.asking?.id && lhs.watched == rhs.watched && lhs.chosen == rhs.chosen
            && lhs.canWatch == rhs.canWatch && lhs.identifier == rhs.identifier && lhs.line == rhs.line && lhs.label == rhs.label
            && lhs.row.thread.summary?.runningTurnStartedAt == rhs.row.thread.summary?.runningTurnStartedAt
            && lhs.row.thread.summary?.lastMessageAt == rhs.row.thread.summary?.lastMessageAt
    }
    private var state: ThreadState { ThreadState(row.thread) }
    private var unread: Bool { if case .recent(true) = kind { return true } else { return false } }
    private var tone: Light.Tone {
        switch kind {
        case .needs: return .warning
        case .working: return .accent
        case .recent(let unread): return unread ? .accent : row.failed ? .danger : .off
        }
    }
    /// What the row says under its title: the request it waits on, where a working thread lives, or for a recent one
    /// just finished, can't be reached, failed, or where it lives, as the Threads page always wrote it.
    private var line: String {
        switch kind {
        case .needs:
            if let asking {
                let provider = Words.provider(row.thread.providerId)
                return String(localized: "\(provider) on \(row.computer) · Waiting in \(asking.thread.title)",
                              comment: "First %@ is the agent's name, such as Codex; second is the computer's name; third is the title of the delegated thread the request waits in.")
            }
            return "\(state.words) · \(row.computer)"
        case .working: return Words.place(row)
        case .recent(let unread):
            if unread { return String(localized: "Just finished · \(row.computer)", comment: "%@ is the computer's name.") }
            if !row.reachable { return "\(row.status.words) · \(row.computer)" }
            if row.failed { return "\(state.words) · \(row.computer)" }
            return Words.place(row)
        }
    }
    /// The row as VoiceOver reads it: its title, then its state where that matters, then where it runs.
    private var label: String {
        let place = Words.place(row)
        let spoken: String
        switch kind {
        case .needs: spoken = "\(row.thread.title), \(ThreadState((asking ?? row).thread).words), \(asking.map { _ in line } ?? place)"
        case .working: spoken = "\(row.thread.title), \(state.words), \(place)"
        case .recent(let unread):
            if unread {
                spoken = String(localized: "\(row.thread.title), just finished, not opened yet, \(place)",
                                comment: "First %@ is the thread's title; second is where it runs: its agent, project and computer.")
            } else if !row.reachable { spoken = "\(row.thread.title), \(row.status.words), \(place)" }
            else if row.failed { spoken = "\(row.thread.title), \(state.words), \(place)" }
            else { spoken = "\(row.thread.title), \(place)" }
        }
        return watched ? String(localized: "\(spoken), watched by Watcher", comment: "%@ is what VoiceOver reads of the thread before this: its title and where it runs.") : spoken
    }
    var body: some View {
        let _ = BenchProbe.body("ThreadListRow")
        if canWatch {
            button.contextMenu {
                Button { setWatched(!watched) } label: {
                    Label(watched ? String(localized: "Stop watching", comment: "Context menu: Watcher stops watching this thread") : String(localized: "Watch", comment: "Context menu: Watcher keeps this thread going"), systemImage: watched ? "eye.slash" : "eye")
                }
            }
        } else {
            button
        }
    }
    private var button: some View {
        // At the accessibility text sizes a title can't hold one line: titles and lines wrap and the age goes under them.
        let large = typeSize.isAccessibilitySize
        let ago = Words.ago(row.thread.summary?.runningTurnStartedAt ?? row.thread.summary?.lastMessageAt)
        return Button(action: open) {
            HStack(alignment: .top, spacing: Space.s3) {
                Light(tone: tone, breathing: kind == .working).padding(.top, 6)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.thread.title).font(.sotto(.body, unread ? .bold : .semibold))
                        .foregroundStyle(chosen ? Palette.accentText : Palette.ink).lineLimit(large ? 4 : 1)
                    PlaceLine(providerID: row.thread.providerId, watched: watched, text: line,
                              tone: row.failed ? Palette.dangerText : Palette.muted, lines: large ? 3 : 1)
                    if large, let ago { Text(ago).font(.sotto(.caption)).foregroundStyle(Palette.muted) }
                }
                Spacer(minLength: Space.s1)
                if !large, let ago {
                    Text(ago).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1).padding(.top, 3)
                }
            }
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.s2 + 2)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background { if chosen { RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(ThemeRole(.accentSurface)) } }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: label))
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint("Opens the thread")
        .accessibilityIdentifier("\(identifier)\(row.id)")
    }
}

/// Where a thumb has the upright sidebar while it drags it: 0 out of sight, 1 all the way in, nil while nothing holds it.
/// Only the drawer reads it, so a drag redraws the drawer and nothing else.
@Observable final class SidebarPull {
    var progress: CGFloat?
}

/// Upright, the unfolded Duo's page has the screen, and the sidebar comes over it from the left edge (Zach's picks,
/// October 30 and November 1, 2026): a thumb's drag right anywhere on the page pulls it in, following the thumb, and a
/// drag left pushes it out the same way (`SidebarSwipe`); the rail's sidebar button does both too. A press beside it,
/// Escape or a chosen thread puts it away. The handle at the left edge is a button for VoiceOver and a press.
private struct SidebarDrawer: View, Equatable {
    @Binding var shown: Bool
    let pull: SidebarPull
    let open: (ThreadRef) -> Void
    static let width: CGFloat = 320
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    static func == (lhs: SidebarDrawer, rhs: SidebarDrawer) -> Bool { lhs.shown == rhs.shown && lhs.pull === rhs.pull }
    var body: some View {
        let held = pull.progress
        let fraction = held ?? (shown ? 1 : 0)
        ZStack(alignment: .leading) {
            if shown || held != nil {
                Color.black.opacity(0.35 * fraction)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { shown = false }
                    .allowsHitTesting(shown && held == nil)
                    .accessibilityHidden(true)
                    .transition(.opacity)
                ThreadSidebar(open: open, width: Self.width, newThread: true).equatable()
                    .background { PageGround().ignoresSafeArea() }
                    // Escape on a hardware keyboard puts it away, as VoiceOver's escape gesture does.
                    .background {
                        Button(String(localized: "Hide the threads", comment: "Hides the list of threads beside the open thread on the iPhone Duo unfolded")) { shown = false }
                            .keyboardShortcut(.cancelAction)
                            .opacity(0)
                            .accessibilityHidden(true)
                    }
                    .offset(x: (fraction - 1) * (Self.width + Space.s6))
                    .accessibilityAction(.escape) { shown = false }
                    // VoiceOver stays in the sidebar while it is over the page.
                    .accessibilityAddTraits(.isModal)
                    .transition(reduceMotion ? .opacity : .move(edge: .leading))
            } else {
                Button { shown = true } label: {
                    Capsule().fill(Palette.muted.opacity(0.45)).frame(width: 4, height: 44)
                        .frame(width: 32, height: 88)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Show the threads", comment: "Shows the list of threads beside the open thread on the iPhone Duo unfolded"))
                .accessibilityIdentifier("duo-sidebar-edge")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.3, dampingFraction: 0.9), value: shown)
    }
}

/// A thumb's sideways drag anywhere over the unfolded Duo's pages moves the threads' sidebar (Zach's picks, November 1,
/// 2026). Upright, it `follows` the thumb in and out through `SidebarPull` and settles where the thumb lets go, or where
/// a flick sends it; sideways, a drag right brings the sidebar beside the page and a drag left puts it away. The drag is
/// UIKit's, on the window, so it starts anywhere and never takes a press: it begins only for a drag that is mostly
/// sideways and towards where the sidebar would go, leaves a row or a block of code that scrolls sideways to scroll
/// while it isn't at its start, and stays out of sheets. Once it begins, the page under it stops scrolling.
private struct SidebarSwipe: UIViewRepresentable {
    let enabled: Bool
    let follows: Bool
    let shown: Bool
    let pull: SidebarPull
    let settle: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Anchor {
        let anchor = Anchor()
        anchor.isUserInteractionEnabled = false
        anchor.coordinator = context.coordinator
        context.coordinator.anchor = anchor
        return anchor
    }
    func updateUIView(_ anchor: Anchor, context: Context) {
        let coordinator = context.coordinator
        coordinator.enabled = enabled
        coordinator.follows = follows
        coordinator.shown = shown
        coordinator.pull = pull
        coordinator.settle = settle
    }
    static func dismantleUIView(_ anchor: Anchor, coordinator: Coordinator) { coordinator.detach() }

    /// Where the drag may start, the size of the pages; it puts the drag on its window.
    final class Anchor: UIView {
        weak var coordinator: Coordinator?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            coordinator?.attach(to: window)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var enabled = false
        var follows = false
        var shown = false
        var pull: SidebarPull?
        var settle: (Bool) -> Void = { _ in }
        weak var anchor: UIView?
        private weak var host: UIView?
        private var from = false
        private lazy var pan: UIPanGestureRecognizer = {
            let pan = UIPanGestureRecognizer(target: self, action: #selector(moved(_:)))
            pan.delegate = self
            return pan
        }()

        func attach(to window: UIWindow?) {
            detach()
            guard let window else { return }
            window.addGestureRecognizer(pan)
            host = window
        }
        func detach() {
            host?.removeGestureRecognizer(pan)
            host = nil
        }

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard gestureRecognizer === pan, enabled, let anchor, let window = anchor.window else { return false }
            // Nothing presented over the page, such as a sheet, moves the sidebar under it.
            if window.rootViewController?.presentedViewController != nil { return false }
            guard anchor.bounds.contains(pan.location(in: anchor)) else { return false }
            let velocity = pan.velocity(in: anchor)
            guard abs(velocity.x) > abs(velocity.y) * 1.2, shown ? velocity.x < 0 : velocity.x > 0 else { return false }
            guard let touched = window.hitTest(pan.location(in: window), with: nil) else { return true }
            if (touched as? UITextInput) != nil, touched.isFirstResponder { return false }
            return shown || !scrollsAway(touched)
        }
        /// A row or block under the thumb that scrolls sideways and isn't at its start keeps the drag to scroll back.
        private func scrollsAway(_ view: UIView) -> Bool {
            var next: UIView? = view
            while let current = next {
                if let scroll = current as? UIScrollView, scroll.contentSize.width > scroll.bounds.width + 1,
                   scroll.contentOffset.x > -scroll.adjustedContentInset.left + 1 {
                    return true
                }
                next = current.superview
            }
            return false
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        @objc private func moved(_ recognizer: UIPanGestureRecognizer) {
            guard let anchor else { return }
            let dx = recognizer.translation(in: anchor).x
            switch recognizer.state {
            case .began:
                from = shown
                stopScrolling(under: recognizer)
                if follows { pull?.progress = progress(dx) }
            case .changed:
                if follows { pull?.progress = progress(dx) }
            case .ended, .cancelled, .failed:
                let speed = recognizer.velocity(in: anchor).x
                var show: Bool
                if follows {
                    show = abs(speed) > 400 ? speed > 0 : progress(dx) > 0.5
                } else {
                    show = from ? !(dx < -60 || speed < -400) : (dx > 60 || speed > 400)
                }
                if recognizer.state != .ended { show = from }
                withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) { pull?.progress = nil }
                settle(show)
            default:
                break
            }
        }
        private func progress(_ dx: CGFloat) -> CGFloat {
            min(1, max(0, (from ? 1 : 0) + dx / SidebarDrawer.width))
        }
        /// The page under the thumb stops scrolling once the drag is the sidebar's: its pan is turned off and on, which
        /// ends it.
        private func stopScrolling(under recognizer: UIPanGestureRecognizer) {
            guard let window = anchor?.window, let touched = window.hitTest(recognizer.location(in: window), with: nil) else { return }
            var next: UIView? = touched
            while let current = next {
                if let scroll = current as? UIScrollView, scroll.panGestureRecognizer.isEnabled {
                    scroll.panGestureRecognizer.isEnabled = false
                    scroll.panGestureRecognizer.isEnabled = true
                }
                next = current.superview
            }
        }
    }
}

enum Words {
    static func provider(_ id: String?) -> String {
        AgentNames.name(id)
    }
    private static let stamp: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static let plainStamp = ISO8601DateFormatter()
    private static let relative: RelativeDateTimeFormatter = { let f = RelativeDateTimeFormatter(); f.unitsStyle = .abbreviated; return f }()
    static func date(_ iso: String?) -> Date? { iso.flatMap { stamp.date(from: $0) ?? plainStamp.date(from: $0) } }
    /// "4 min. ago", or nothing when the host did not say.
    static func ago(_ iso: String?) -> String? { date(iso).map { relative.localizedString(for: $0, relativeTo: Date()) } }
    /// A card's or row's second line: the agent, the project and the computer.
    static func place(_ row: HostedThread) -> String {
        [provider(row.thread.providerId), row.project, row.computer].compactMap { $0 }.joined(separator: " · ")
    }
    static func duration(_ ms: Double?) -> String? {
        guard let ms, ms >= 1000 else { return nil }
        let seconds = Int(ms / 1000)
        return StepRun.clock(seconds)
    }
}

/// Says what just happened, above whatever page is open: a problem until dismissed, a confirmation for a few seconds.
struct FeedbackBanner: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        Group {
            if let feedback = model.feedback {
                HStack(alignment: .top, spacing: Space.s2) {
                    Text(feedback).font(.sotto(.small)).foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, Space.s3)
                        .paragraphDirection()
                    Button { model.feedback = nil } label: {
                        Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityLabel("Dismiss message")
                }
                .padding(.leading, Space.s4)
                .glass(in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                .accessibilityAddTraits(.updatesFrequently)
                .transition(.opacity)
                .task(id: model.passing) {
                    if let id = model.passing, model.confirmationShown(id) { UIAccessibility.post(notification: .announcement, argument: feedback) }
                }
            }
        }
        .sensoryFeedback(trigger: model.feedback) { _, now in now == nil || model.passing != nil ? nil : .warning }
    }
}

/// In a thread: says when its computer can't be reached, that it is reconnecting under the thread as last read, or
/// else what just went wrong.
struct ComputerBanner: View {
    @EnvironmentObject var model: AppModel
    /// Watched so the reconnecting line follows the thread's held copy.
    @EnvironmentObject var detailStore: DetailStore
    let ref: ThreadRef
    private var hostID: String { ref.hostID }
    var body: some View {
        if model.status(hostID) == .connecting && model.shown(for: ref) != nil {
            HStack(spacing: Space.s3) {
                ProgressView().controlSize(.small)
                Text("Reconnecting to \(model.name(hostID))…").font(.sotto(.small)).foregroundStyle(Palette.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s4)
            .padding(.vertical, Space.s3)
            .glass(in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .accessibilityElement(children: .combine)
        } else if model.status(hostID) == .unreachable {
            HStack(spacing: Space.s3) {
                Light(tone: .danger)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Can’t reach \(model.name(hostID))").font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                    Text("Work carries on there. Your drafts are kept.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                        .paragraphDirection()
                }
                Spacer(minLength: 0)
                Button("Reconnect") { Task { await model.connect(hostID) } }.buttonStyle(PlainStyle(compact: true))
                    .accessibilityLabel("Reconnect to \(model.name(hostID))")
            }
            .padding(Space.s3)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
        } else {
            FeedbackBanner()
        }
    }
}
