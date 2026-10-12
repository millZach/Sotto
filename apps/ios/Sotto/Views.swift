import SwiftUI
import SottoCore

/// Pairing until this iPhone holds a computer, then Threads, Computers and Settings.
struct RootView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if model.computers.isEmpty { PairFlow() } else { MainTabs() }
    }
}

/// The three tabs. The system tab bar keeps its own glass; the theme's accent tints it.
struct MainTabs: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = Tab.threads
    @State private var threadPath = NavigationPath()
    enum Tab: Hashable { case threads, computers, settings }
    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $threadPath) {
                ThreadsView(openCreated: { ref in threadPath.append(ThreadRoute(ref: ref)) }).threadDestination()
            }
                .tabItem { Label("Threads", systemImage: "bubble.left") }
                .badge(waitingCount + unreadFinishedCount)
                .tag(Tab.threads)
            NavigationStack { ComputersView() }
                .tabItem { Label("Computers", systemImage: "desktopcomputer") }
                .tag(Tab.computers)
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
                .tag(Tab.settings)
        }
        .sheet(isPresented: $model.adding, onDismiss: { model.closeAdding() }) { AddComputerSheet() }
        // A tapped alert opens its thread on Threads (ADR-0051).
        .onChange(of: model.alertOpened) { _, ref in openAlerted(ref) }
        .onAppear { openAlerted(model.alertOpened) }
    }
    private func openAlerted(_ ref: ThreadRef?) {
        guard let ref else { return }
        model.alertOpened = nil
        tab = .threads
        threadPath = NavigationPath([ThreadRoute(ref: ref)])
    }
    private var waitingCount: Int { ThreadGroups.waiting(model.lists).count + model.terminalRows.filter { $0.reachable && $0.terminal.state == .needsYou }.count }
    /// Recent threads that finished while nothing showed them and have not been opened on either device (ADR-0046).
    private var unreadFinishedCount: Int {
        FocusThreads(model.lists, opened: model.selected).unreadFinishedCount
            + model.terminalRows.filter { $0.finishedUnread && $0.ref != model.selectedTerminal }.count
    }
}

/// A thread, named with its computer: two computers can hold the same thread ID.
struct ThreadRoute: Hashable { let ref: ThreadRef }
struct TerminalRoute: Hashable { let ref: TerminalRef }
extension View {
    func threadDestination() -> some View {
        navigationDestination(for: ThreadRoute.self) { ThreadView(ref: $0.ref) }
            .navigationDestination(for: TerminalRoute.self) { TerminalView(ref: $0.ref) }
    }
}

enum Words {
    static func terminalProvider(_ id: String?) -> String { id == nil ? "Shell" : provider(id) }
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
