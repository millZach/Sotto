import SwiftUI
import UIKit
import SottoCore

/// Pairing until this iPhone holds a computer, then Threads, Computers and Settings.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
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
    /// The sidebar brought over an upright unfolded Duo's thread by a swipe in from the left edge.
    @State private var drawer = false
    /// New thread, opened from the Duo's rail.
    @State private var creating = false
    enum Tab: Hashable { case threads, watcher, computers, settings }
    @Environment(\.horizontalSizeClass) private var width
    @Environment(\.verticalSizeClass) private var height
    @Environment(\.sottoGlass) private var glass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(PhonePreferenceKey.duoTabsSide) private var railSide = DuoTabsSide.right.rawValue
    @AppStorage(PhonePreferenceKey.duoSidebarHidden) private var sidebarHidden = false
    var body: some View {
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
    /// Where the tabs stand: along the bottom; as a rail in the Duo's strip, where the pages get the whole height; or,
    /// on the unfolded Duo held sideways with the rail on the side away from the clock, in a column of the strip's width.
    private enum RailPlace: Equatable { case bottom, strip(trailing: Bool, width: CGFloat), column(leading: Bool, width: CGFloat) }
    private func railPlace(_ duo: DuoLayout) -> RailPlace {
        switch duo {
        case .none, .upright: return .bottom
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
        // A thread and the keyboard cover the tabs, except on the unfolded Duo held sideways, where the rail stays in its
        // place beside the thread and its sidebar (Zach's pick A on October 30, 2026): with no Back there, it is the way
        // out of a thread, so the keyboard draws over its foot rather than taking it away.
        let shown = duo.sideways || (!keyboard && covered.isEmpty)
        let sidebar = duo.sideways && threadOpen && !sidebarHidden
        // The bar sits under the pages rather than in their safe area, which a NavigationStack doesn't pass on to its
        // pages: they end above it, as they did above the system's.
        return HStack(spacing: 0) {
            if case .column(leading: true, width: let strip) = place { rail(shown, clear: Space.s4).frame(width: strip) }
            if sidebar {
                ThreadSidebar(open: openFromSidebar).equatable()
                    .transition(reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))
            }
            VStack(spacing: 0) {
                pages
                if place == .bottom && covered.isEmpty && !keyboard {
                    TabsBar(tab: $tab, threadsBadge: model.threadsBadge, watcher: model.watcherHostID == nil ? nil : model.watcherTab,
                            style: duo == .upright ? .row : .bar, reselect: reselect)
                        // Upright, New thread ends the row, away from the reply box's + at its start (Zach's pick).
                        .overlay(alignment: .trailing) { if duo == .upright { newThread.padding(.trailing, Space.s5) } }
                }
            }
            if case .column(leading: false, width: let strip) = place { rail(shown, clear: Space.s4).frame(width: strip) }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: sidebar)
        .overlay(alignment: .trailing) {
            if case .strip(trailing: true, width: let strip) = place { rail(shown, clear: clockClearance(duo)).frame(width: strip).offset(x: strip) }
        }
        .overlay(alignment: .leading) {
            if case .strip(trailing: false, width: let strip) = place { rail(shown, clear: clockClearance(duo)).frame(width: strip).offset(x: -strip) }
        }
        .overlay { if duo == .upright && threadOpen { ThreadDrawer(shown: $drawer, open: openFromSidebar).equatable() } }
        .sheet(isPresented: $creating, onDismiss: { model.newThreadClosed() }) {
            NewThreadSheet(opened: { ref in
                model.newThreadOpened(ref)
                tab = .threads
                threadPath = NavigationPath([ThreadRoute(ref: ref)])
            })
        }
        .onChange(of: threadOpen) { _, open in if !open { drawer = false } }
        .onChange(of: duo) { _, _ in drawer = false }
        // Under Glass the backdrop reaches the Duo's strip too, so the rail stands on the same ground.
        .background { if glass != nil { PageGround().ignoresSafeArea() } }
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
    /// The tabs stood in a column: in the Duo's strip, or down the edge of the unfolded Duo held sideways. New thread
    /// tops it, just under the clock and battery and apart from the tabs, on every tab (Zach's picks, October 30, 2026),
    /// and the tabs are centred in the height under it.
    @ViewBuilder private func rail(_ shown: Bool, clear: CGFloat) -> some View {
        if shown {
            VStack(spacing: 0) {
                newThread.padding(.top, clear)
                TabsBar(tab: $tab, threadsBadge: model.threadsBadge, watcher: model.watcherHostID == nil ? nil : model.watcherTab,
                        style: .rail, reselect: reselect)
                    .frame(maxHeight: .infinity)
            }
            .ignoresSafeArea(.keyboard)
        } else {
            Color.clear
        }
    }
    /// How far down the strip the clock, battery and page dots reach: lower on the cover screen than unfolded, as the
    /// iPhone Duo simulator draws them (iOS 27.1).
    private func clockClearance(_ duo: DuoLayout) -> CGFloat {
        if case .folded = duo { return 156 } else { return 108 }
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
    /// A thread chosen in the sidebar opens in place of the one showing, on the tab that shows it.
    private func openFromSidebar(_ ref: ThreadRef) {
        drawer = false
        guard ref != model.selected else { return }
        var swap = Transaction()
        swap.disablesAnimations = true
        withTransaction(swap) {
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
/// Glass they float on a capsule of Liquid Glass instead. On the iPhone Duo they are icons alone, in a rail down its strip
/// or along the bottom unfolded and upright, the chosen one filled on a soft chip of the accent, with no glass under any
/// theme (Zach's pick A at 28 points, October 30, 2026). Watcher's owl carries a dot while Watcher works, and its badge
/// counts what needs the user that only Watcher's page shows; VoiceOver reads both after its name ("Working, 1 needs you").
struct TabsBar: View {
    @Binding var tab: MainTabs.Tab
    let threadsBadge: Int
    let watcher: WatcherTabState?
    /// The bar along the bottom of every other iPhone, or the Duo's icons: a rail stacked down a strip, or a row.
    enum Style { case bar, rail, row }
    var style = Style.bar
    /// A press on the tab already chosen.
    var reselect: (MainTabs.Tab) -> Void = { _ in }
    private var duo: Bool { style != .bar }
    var body: some View {
        let layout = style == .rail ? AnyLayout(VStackLayout(spacing: Space.s2))
            : style == .row ? AnyLayout(HStackLayout(spacing: Space.s7)) : AnyLayout(HStackLayout(spacing: 0))
        layout {
            item(.threads, Image(systemName: "bubble.left"), Text("Threads"), badge: threadsBadge, spoken: threadsBadge > 0 ? "\(threadsBadge)" : "")
            if let watcher {
                item(.watcher, Image(watcher.working ? "WatcherTabWorking" : "WatcherTab"), Text("Watcher"), badge: watcher.needs, spoken: watcher.spoken)
            }
            item(.computers, Image(systemName: "desktopcomputer"), Text("Computers"), badge: 0, spoken: "")
            item(.settings, Image(systemName: "slider.horizontal.3"), Text("Settings"), badge: 0, spoken: "")
        }
        .padding(style == .rail ? .vertical : .horizontal, Space.s2)
        .padding(.top, style == .bar ? Space.s1 : 0)
        .padding(.bottom, style == .row ? Space.s1 : 0)
        .frame(maxWidth: style == .row ? .infinity : nil)
        // The names stay at the size the system's tab bar keeps; at the accessibility sizes a long press shows the
        // large content viewer instead. Grown with the text, four names ran together on a small iPhone.
        .dynamicTypeSize(...DynamicTypeSize.large)
        .modifier(TabsGlass(shown: style == .bar))
        .pageGround()
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
        .accessibilityIdentifier("tabs")
    }
    private func item(_ id: MainTabs.Tab, _ icon: Image, _ title: Text, badge: Int, spoken: String) -> some View {
        let chosen = tab == id
        let size: CGFloat = duo ? 28 : 24
        return Button { if chosen { reselect(id) } else { tab = id } } label: {
            VStack(spacing: 3) {
                icon.renderingMode(.template).resizable().scaledToFit()
                    .symbolVariant(duo && chosen ? .fill : .none)
                    .frame(width: size, height: size)
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 {
                            Text(verbatim: "\(badge)").font(.sotto(.caption, .semibold)).monospacedDigit()
                                .foregroundStyle(Palette.canvas).environment(\.colorScheme, .dark)
                                .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18)
                                .background(Palette.warning, in: Capsule())
                                .offset(x: duo ? 14 : 12, y: -6)
                        }
                    }
                if !duo { title.font(.sotto(.caption, .medium)).lineLimit(1).minimumScaleFactor(0.8) }
            }
            .foregroundStyle(chosen ? Palette.accentText : Palette.muted)
            .frame(width: duo ? 60 : nil, height: duo ? 50 : nil)
            .background { if duo && chosen { RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(ThemeRole(.accentSurface)) } }
            .frame(maxWidth: style == .row ? nil : .infinity, minHeight: duo ? 62 : 44)
            .frame(width: style == .row ? 72 : nil)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(Text(verbatim: spoken))
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityShowsLargeContentViewer { Label { title } icon: { icon.renderingMode(.template) } }
        .accessibilityIdentifier("tab-\(id)")
    }
}

/// The capsule of Liquid Glass the bottom bar floats on under Glass, on iOS 26 and later. The Duo's icons have none.
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
    /// Unfolded and held upright: the tabs run along the bottom.
    case upright
    var sideways: Bool { if case .sideways = self { return true } else { return false } }
}
private struct DuoLayoutKey: EnvironmentKey { static let defaultValue = DuoLayout.none }
extension EnvironmentValues {
    var duoLayout: DuoLayout {
        get { self[DuoLayoutKey.self] }
        set { self[DuoLayoutKey.self] = newValue }
    }
}

/// A thread's bar on the unfolded Duo (Zach's picks, October 30, 2026). Sideways, Back gives way to the button that hides
/// or shows the sidebar: the rail stays beside the thread, and its Threads tab goes back to the list. Upright, Back is
/// the thread's own button, which leaves the swipe in from the left edge to bring the sidebar. A nested thread keeps
/// iOS's Back both ways and, sideways, gets the sidebar button beside it.
private struct DuoThreadBar: ViewModifier {
    let nested: Bool
    @Environment(\.duoLayout) private var duo
    @Environment(\.dismiss) private var dismiss
    @AppStorage(PhonePreferenceKey.duoSidebarHidden) private var sidebarHidden = false
    func body(content: Content) -> some View {
        // One subtree whatever the screen, so folding or turning the Duo never resets the thread's own state.
        let sideways = duo.sideways, upright = duo == .upright && !nested
        return content
            .navigationBarBackButtonHidden((sideways && !nested) || upright)
            .toolbar {
                if sideways {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { sidebarHidden.toggle() } label: { Image(systemName: "sidebar.left") }
                            .accessibilityLabel(sidebarHidden ? String(localized: "Show the threads", comment: "Shows the list of threads beside the open thread on the iPhone Duo unfolded") : String(localized: "Hide the threads", comment: "Hides the list of threads beside the open thread on the iPhone Duo unfolded"))
                            .accessibilityIdentifier("duo-sidebar")
                    }
                    .horizontalOnly()
                }
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
                ThreadListSections(groups: groups, chosen: model.selected, identifier: "sidebar-thread-", open: open)
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
struct ThreadListSections: View {
    @EnvironmentObject var model: AppModel
    let groups: FocusThreads
    /// The thread showing beside the list, on the accent's soft chip.
    var chosen: ThreadRef? = nil
    /// Each row's identifier starts with this: `thread-` on the Threads page, `sidebar-thread-` beside a thread.
    var identifier = "thread-"
    let open: (ThreadRef) -> Void
    var body: some View {
        let watched = model.watchedThreadIDs
        VStack(alignment: .leading, spacing: 0) {
            section(String(localized: "Needs you", comment: "The heading over threads waiting on the user's answer."), "needs", groups.questions) { row in
                rowView(row, .needs, watched)
            }
            section(String(localized: "Working now"), "working", groups.working) { row in rowView(row, .working, watched) }
            section(String(localized: "Recent", comment: "The heading over threads that finished lately."), "recent", groups.recent) { row in
                rowView(row, .recent(unread: groups.isUnreadFinish(row)), watched)
            }
        }
    }
    private func rowView(_ row: HostedThread, _ kind: ThreadListRow.Kind, _ watched: Set<String>) -> some View {
        let isWatched = watched.contains(row.id)
        return ThreadListRow(row: row, kind: kind, watched: isWatched, chosen: row.ref == chosen,
                             canWatch: model.canChangeWatch(row.ref), identifier: identifier,
                             open: { open(row.ref) },
                             setWatched: { on in Task { await model.setWatched(row.ref, on, title: row.thread.title) } })
            .equatable()
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
    let watched: Bool
    let chosen: Bool
    let canWatch: Bool
    let identifier: String
    let open: () -> Void
    let setWatched: (Bool) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    /// What the row draws: the thread's title, state, place and times, its section, light and chip.
    static func == (lhs: ThreadListRow, rhs: ThreadListRow) -> Bool {
        lhs.row.id == rhs.row.id && lhs.kind == rhs.kind && lhs.watched == rhs.watched && lhs.chosen == rhs.chosen
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
        case .needs: return "\(state.words) · \(row.computer)"
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
        case .needs, .working: spoken = "\(row.thread.title), \(state.words), \(place)"
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
                              tone: row.failed ? Palette.dangerText : Palette.muted)
                        .lineLimit(large ? 3 : 1)
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

/// Upright, the unfolded Duo's thread has the screen, and a swipe in from its left edge brings the sidebar over it (Zach's
/// pick, October 30, 2026). The swipe takes the place of the system's swipe back there, which is why the thread's bar
/// keeps a Back button of its own. A swipe back, a press beside the sidebar, Escape or a chosen thread puts it away.
/// VoiceOver finds the edge as a button.
private struct ThreadDrawer: View, Equatable {
    @Binding var shown: Bool
    let open: (ThreadRef) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    static func == (lhs: ThreadDrawer, rhs: ThreadDrawer) -> Bool { lhs.shown == rhs.shown }
    var body: some View {
        ZStack(alignment: .leading) {
            if shown {
                Color.black.opacity(0.35)
                    .ignoresSafeArea()
                    .onTapGesture { shown = false }
                    .accessibilityHidden(true)
                    .transition(.opacity)
                ThreadSidebar(open: open, width: 320, newThread: true)
                    .background { PageGround().ignoresSafeArea() }
                    // Escape on a hardware keyboard puts it away, as VoiceOver's escape gesture does.
                    .background {
                        Button(String(localized: "Hide the threads", comment: "Hides the list of threads beside the open thread on the iPhone Duo unfolded")) { shown = false }
                            .keyboardShortcut(.cancelAction)
                            .opacity(0)
                            .accessibilityHidden(true)
                    }
                    .gesture(DragGesture(minimumDistance: 20).onEnded { if $0.translation.width < -40 { shown = false } })
                    .accessibilityAction(.escape) { shown = false }
                    // VoiceOver stays in the sidebar while it is over the thread.
                    .accessibilityAddTraits(.isModal)
                    .transition(reduceMotion ? .opacity : .move(edge: .leading))
            } else {
                // A swipe in anywhere down the edge, clear of the bar's Back above and the reply box's + below so a press on
                // either still lands, and a handle in the middle that a press opens too.
                Color.clear
                    .frame(width: 16)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .padding(.vertical, 72)
                    .gesture(DragGesture(minimumDistance: 10).onEnded { if $0.translation.width > 40 { shown = true } })
                    .accessibilityHidden(true)
                Button { shown = true } label: {
                    Capsule().fill(Palette.muted.opacity(0.45)).frame(width: 4, height: 44)
                        .frame(width: 32, height: 88)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .simultaneousGesture(DragGesture(minimumDistance: 10).onEnded { if $0.translation.width > 40 { shown = true } })
                .accessibilityLabel(String(localized: "Show the threads", comment: "Shows the list of threads beside the open thread on the iPhone Duo unfolded"))
                .accessibilityIdentifier("duo-sidebar-edge")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.3, dampingFraction: 0.9), value: shown)
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
            .failedEdge(tint: 0.09)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
        } else {
            FeedbackBanner()
        }
    }
}
