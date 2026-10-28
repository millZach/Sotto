import SwiftUI
import UIKit
import SottoCore

/// Pairing until this iPhone holds a computer, then Threads, Computers and Settings.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if model.computers.isEmpty { PairFlow() } else { MainTabs() }
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
    enum Tab: Hashable { case threads, watcher, computers, settings }
    @Environment(\.horizontalSizeClass) private var width
    var body: some View {
        GeometryReader { frame in tabs(strip: strip(frame.safeAreaInsets)) }
    }
    /// The iPhone Duo's cover screen leaves a strip down its right edge, under the clock and battery, outside the safe
    /// area but inside the window (ADR-0151, amended). There the bar stands in the strip as a rail, as the system's did,
    /// and the pages get the whole height. An upright iPhone has no side insets, and one held sideways has two alike.
    /// The app is always left to right, so the strip is the trailing inset.
    private func strip(_ insets: EdgeInsets) -> CGFloat? {
        width == .compact && insets.trailing - insets.leading >= 60 ? insets.trailing : nil
    }
    private func tabs(strip: CGFloat?) -> some View {
        // The bar sits under the pages rather than in their safe area, which a NavigationStack doesn't pass on to its
        // pages: they end above it, as they did above the system's.
        VStack(spacing: 0) {
            TabView(selection: $tab) {
                NavigationStack(path: $threadPath) {
                    ThreadsView(openCreated: { ref in threadPath.append(ThreadRoute(ref: ref)) }).threadDestination()
                }
                    .toolbar(.hidden, for: .tabBar)
                    .tag(Tab.threads)
                // Watcher's tab (1B), only for a computer that runs Watcher and shows it to this iPhone.
                if let hostID = model.watcherHostID {
                    NavigationStack(path: $watcherPath) { WatcherView(hostID: hostID).threadDestination() }
                        .toolbar(.hidden, for: .tabBar)
                        .tag(Tab.watcher)
                }
                NavigationStack { ComputersView() }
                    .toolbar(.hidden, for: .tabBar)
                    .tag(Tab.computers)
                NavigationStack { SettingsView() }
                    .toolbar(.hidden, for: .tabBar)
                    .tag(Tab.settings)
            }
            if covered.isEmpty && !keyboard && strip == nil {
                TabsBar(tab: $tab, threadsBadge: model.threadsBadge, watcher: model.watcherHostID == nil ? nil : model.watcherTab)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let strip, covered.isEmpty && !keyboard {
                TabsBar(tab: $tab, threadsBadge: model.threadsBadge, watcher: model.watcherHostID == nil ? nil : model.watcherTab, rail: true)
                    .frame(width: strip)
                    .offset(x: strip)
            }
        }
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
        .onAppear {
            openAlerted(model.alertOpened); openWatcher(model.watcherAlertOpened)
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
    #if DEBUG
    /// Captures of the UI fixture open a page at launch: `--ui-open-thread <id>` opens one of the laptop's threads, and
    /// `--ui-open-watcher` the Watcher tab.
    private func openForCapture() {
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--ui-open-thread"), index + 1 < arguments.count {
            threadPath = NavigationPath([ThreadRoute(ref: ThreadRef(hostID: "11111111-1111-4111-8111-111111111111", threadID: arguments[index + 1]))])
        }
        if arguments.contains("--ui-open-watcher"), model.watcherHostID != nil { tab = .watcher }
    }
    #endif
    private func openAlerted(_ ref: ThreadRef?) {
        guard let ref else { return }
        model.alertOpened = nil
        tab = .threads
        threadPath = NavigationPath([ThreadRoute(ref: ref)])
    }
    private func openWatcher(_ hostID: String?) {
        guard hostID != nil else { return }
        model.watcherAlertOpened = nil
        guard model.watcherHostID != nil else { return }
        tab = .watcher
        watcherPath = NavigationPath()
    }
}

/// The tabs' bar: icons and names straight on the canvas, the chosen tab in the accent, with no shape behind them. Watcher's owl carries a dot while Watcher works, and its badge counts what
/// needs the user that only Watcher's page shows; VoiceOver reads both after its name ("Working, 1 needs you").
struct TabsBar: View {
    @Binding var tab: MainTabs.Tab
    let threadsBadge: Int
    let watcher: WatcherTabState?
    /// Stacked in the Duo cover screen's side strip, icons only, as the system drew its rail there.
    var rail = false
    var body: some View {
        let layout = rail ? AnyLayout(VStackLayout(spacing: Space.s2)) : AnyLayout(HStackLayout(spacing: 0))
        layout {
            item(.threads, Image(systemName: "bubble.left"), Text("Threads"), badge: threadsBadge, spoken: threadsBadge > 0 ? "\(threadsBadge)" : "")
            if let watcher {
                item(.watcher, Image(watcher.working ? "WatcherTabWorking" : "WatcherTab"), Text("Watcher"), badge: watcher.needs, spoken: watcher.spoken)
            }
            item(.computers, Image(systemName: "desktopcomputer"), Text("Computers"), badge: 0, spoken: "")
            item(.settings, Image(systemName: "slider.horizontal.3"), Text("Settings"), badge: 0, spoken: "")
        }
        .padding(rail ? .vertical : .horizontal, Space.s2)
        .padding(.top, rail ? 0 : Space.s1)
        .background(Palette.canvas)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
        .accessibilityIdentifier("tabs")
    }
    private func item(_ id: MainTabs.Tab, _ icon: Image, _ title: Text, badge: Int, spoken: String) -> some View {
        let chosen = tab == id
        return Button { tab = id } label: {
            VStack(spacing: 3) {
                icon.renderingMode(.template).resizable().scaledToFit()
                    .frame(width: 24, height: 24)
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
            .frame(maxWidth: .infinity, minHeight: rail ? 52 : 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(Text(verbatim: spoken))
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("tab-\(id)")
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
        navigationDestination(for: ThreadRoute.self) { ThreadView(ref: $0.ref) }
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
            .sensoryFeedback(trigger: model.feedback) { _, now in now == nil ? nil : .warning }
            .task(id: model.passing) {
                if let id = model.passing, model.confirmationShown(id) { UIAccessibility.post(notification: .announcement, argument: feedback) }
            }
        }
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
