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

/// The tabs: Threads, Watcher when a paired computer runs it, Computers and Settings. The system tab bar keeps its own
/// glass; the theme's accent tints it.
struct MainTabs: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = Tab.threads
    @State private var threadPath = NavigationPath()
    @State private var watcherPath = NavigationPath()
    enum Tab: Hashable { case threads, watcher, computers, settings }
    var body: some View {
        let watcher = model.watcherTab
        TabView(selection: $tab) {
            NavigationStack(path: $threadPath) {
                ThreadsView(openCreated: { ref in threadPath.append(ThreadRoute(ref: ref)) }).threadDestination()
                    .background(TabItemAccessibility(title: "Watcher", value: watcher.spoken))
            }
                .tabItem { Label("Threads", systemImage: "bubble.left") }
                .badge(threadsBadge)
                .tag(Tab.threads)
            // Watcher's tab (1B), only for a computer that runs Watcher and shows it to this iPhone. Its owl carries a dot
            // while Watcher works, and its badge counts what needs the user that only Watcher's page shows.
            if let hostID = model.watcherHostID {
                NavigationStack(path: $watcherPath) { WatcherView(hostID: hostID).threadDestination() }
                    .tabItem { Label("Watcher", image: watcher.working ? "WatcherTabWorking" : "WatcherTab") }
                    .badge(watcher.needs)
                    .tag(Tab.watcher)
            }
            NavigationStack { ComputersView() }
                .tabItem { Label("Computers", systemImage: "desktopcomputer") }
                .tag(Tab.computers)
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
                .tag(Tab.settings)
        }
        .sheet(isPresented: $model.adding, onDismiss: { model.closeAdding() }) { AddComputerSheet() }
        // A tapped alert opens its thread on Threads (ADR-0051), and Watcher's own opens the Watcher tab.
        .onChange(of: model.alertOpened) { _, ref in openAlerted(ref) }
        .onChange(of: model.watcherAlertOpened) { _, hostID in openWatcher(hostID) }
        .onAppear { openAlerted(model.alertOpened); openWatcher(model.watcherAlertOpened) }
        // A computer that stops offering Watcher takes its tab with it.
        .onChange(of: model.watcherHostID) { _, hostID in
            if hostID == nil, tab == .watcher { tab = .threads; watcherPath = NavigationPath() }
        }
    }
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
    /// The requests Needs you shows, and the Recent threads that finished while nothing showed them and have not been
    /// opened on either device (ADR-0046). A delegated thread counts only through the row that stands for it (ADR-0081).
    private var threadsBadge: Int {
        let groups = FocusThreads(model.lists, opened: model.selected)
        return groups.requestCount + groups.unreadFinishedCount
    }
}

/// SwiftUI's tab items take a title, an image and a badge, and nothing VoiceOver can read for the Watcher tab's working
/// dot. This finds the tab bar's item by its title, once SwiftUI has set it up for this update, and gives it the words:
/// "Working, 1 needs you". It sits in a tab's own page, where the tab bar's controller is above it.
struct TabItemAccessibility: UIViewControllerRepresentable {
    let title: String
    let value: String
    func makeUIViewController(context: Context) -> Probe { Probe() }
    func updateUIViewController(_ probe: Probe, context: Context) {
        probe.wanted = (title, value)
        probe.apply()
    }
    final class Probe: UIViewController {
        var wanted: (title: String, value: String)?
        override func loadView() {
            let view = UIView()
            view.isUserInteractionEnabled = false
            view.isAccessibilityElement = false
            self.view = view
        }
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            apply()
        }
        func apply() {
            DispatchQueue.main.async { [weak self] in
                guard let self, let wanted = self.wanted, let items = self.tabBarController?.tabBar.items else { return }
                for item in items where item.title == wanted.title {
                    item.accessibilityValue = wanted.value.isEmpty ? nil : wanted.value
                }
            }
        }
    }
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
        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
    }
}

/// Says what just went wrong, above whatever page is open.
struct FeedbackBanner: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if let feedback = model.feedback {
            HStack(alignment: .top, spacing: Space.s2) {
                Text(feedback).font(.sotto(.small)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, Space.s3)
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
