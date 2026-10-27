import SwiftUI
import SottoCore

/// Keeps the tab rail beside a thread that shares the screen with something else.
private struct SharesScreenKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var sharesScreen: Bool {
        get { self[SharesScreenKey.self] }
        set { self[SharesScreenKey.self] = newValue }
    }
}

#if DEBUG

/// Throwaway harness for the iPhone Duo layout prototype (prototype/iphone-duo-layout). `--ui-duo-layout N` swaps the
/// root for mock-up N once the window is wide, over the fixture and the app's real views; folded, the window is narrow
/// and the app's own tabs show unchanged. `--ui-open-thread ID` and `--ui-open-watcher` open a page for captures, and
/// `--ui-size-probe` prints the size class and window size over everything.
enum DuoLaunch {
    static let arguments = ProcessInfo.processInfo.arguments
    static func value(_ flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }
    static let layout = value("--ui-duo-layout").flatMap(Int.init)
    static let openThread = value("--ui-open-thread")
    static let openWatcher = arguments.contains("--ui-open-watcher")
    static let probe = arguments.contains("--ui-size-probe")
    static let laptop = "11111111-1111-4111-8111-111111111111"
    static var startRef: ThreadRef { ThreadRef(hostID: laptop, threadID: openThread ?? "iphone") }
}

struct DuoRoot: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.horizontalSizeClass) private var sizeClass
    var body: some View {
        GeometryReader { proxy in
            let wide = proxy.size.width >= 700
            Group {
                if wide, let layout = DuoLaunch.layout { DuoMock(layout: layout) } else { MainTabs() }
            }
            .overlay(alignment: .bottomLeading) {
                if DuoLaunch.probe {
                    Text(verbatim: "size class \(sizeClass == .regular ? "regular" : "compact") · \(Int(proxy.size.width))×\(Int(proxy.size.height)) pt")
                        .font(.system(size: 13, weight: .semibold).monospaced()).padding(8)
                        .background(.yellow, in: RoundedRectangle(cornerRadius: 8)).foregroundStyle(.black).padding(12)
                }
            }
        }
    }
}

private struct DuoMock: View {
    let layout: Int
    var body: some View {
        switch layout {
        case 1: SplitMock()
        case 2: TwoThreadsMock()
        case 3: WatcherBesideMock()
        case 4: MeasureMock()
        case 5: NeedsColumnMock()
        case 6: SidebarMock()
        case 7: BoardMock()
        default: StripMock()
        }
    }
}

// MARK: - Building blocks

/// The Threads home, with a tapped thread handed to `selection` instead of pushed.
private struct ListPane: View {
    @Binding var selection: ThreadRef?
    @State private var routes: [ThreadRoute] = []
    var body: some View {
        NavigationStack(path: $routes) {
            ThreadsView(openCreated: { selection = $0 })
                .navigationDestination(for: ThreadRoute.self) { _ in Color.clear }
        }
        .onChange(of: routes) { _, now in
            guard let last = now.last else { return }
            selection = last.ref
            routes = []
        }
    }
}

private struct ThreadPane: View {
    let ref: ThreadRef?
    var body: some View {
        NavigationStack {
            if let ref { ThreadView(ref: ref).id(ref) } else { EmptyPane(text: "Choose a thread") }
        }
        .environment(\.sharesScreen, true)
    }
}

private struct WatcherPane: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        NavigationStack {
            if let hostID = model.watcherHostID { WatcherView(hostID: hostID).threadDestination() } else { EmptyPane(text: "Watcher is off") }
        }
    }
}

private struct EmptyPane: View {
    let text: String
    var body: some View {
        Text(text).font(.sotto(.body)).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.canvas)
    }
}

private struct Seam: View {
    var body: some View { Rectangle().fill(Palette.hairline).frame(width: 1).ignoresSafeArea() }
}

/// The app's tabs with `threads` in the Threads tab, the system's own tab bar around it.
private struct Tabs<Threads: View>: View {
    @EnvironmentObject var model: AppModel
    var watcherTab = true
    var watcherWidth: CGFloat? = nil
    @ViewBuilder let threads: Threads
    @State private var tab = DuoLaunch.openWatcher ? 1 : 0
    var body: some View {
        TabView(selection: $tab) {
            threads.tabItem { Label("Threads", systemImage: "bubble.left") }.badge(model.threadsBadge).tag(0)
            if watcherTab, model.watcherHostID != nil {
                Group { if let watcherWidth { WatcherPane().capped(watcherWidth) } else { WatcherPane() } }.tabItem { Label("Watcher", image: "WatcherTab") }.badge(model.watcherTab.needs).tag(1)
            }
            NavigationStack { ComputersView() }.tabItem { Label("Computers", systemImage: "desktopcomputer") }.tag(2)
            NavigationStack { SettingsView() }.tabItem { Label("Settings", systemImage: "slider.horizontal.3") }.tag(3)
        }
    }
}

/// The requests waiting on the user across every thread, each with what asks and where.
private struct NeedsList: View {
    @EnvironmentObject var model: AppModel
    var open: (ThreadRef) -> Void
    @State private var reviewing: Reviewed?
    struct Reviewed: Identifiable { let ref: ThreadRef; let request: AgentRequest; var id: String { request.id } }
    var body: some View {
        let groups = model.focusThreads(show: model.show, opened: model.selected)
        VStack(alignment: .leading, spacing: Space.s3) {
            ForEach(groups.questions) { row in
                let asking = groups.asking(row)
                if let request = asking.thread.requests.first {
                    VStack(alignment: .leading, spacing: Space.s2) {
                        HStack(spacing: Space.s2) {
                            Light(tone: .warning)
                            Text(verbatim: request.kind == "permission" ? "Permission" : "Question").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.warningText)
                            Spacer()
                            if let ago = Words.ago(row.thread.summary?.lastMessageAt) { Text(ago).font(.sotto(.caption)).foregroundStyle(Palette.muted) }
                        }
                        Button { open(row.ref) } label: {
                            Text(verbatim: row.thread.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).multilineTextAlignment(.leading)
                        }.buttonStyle(.plain)
                        Text(verbatim: request.text).font(.sotto(.small)).foregroundStyle(Palette.ink).lineLimit(3)
                        HStack {
                            Text(verbatim: row.computer).font(.sotto(.caption)).foregroundStyle(Palette.muted)
                            Spacer()
                            Button { reviewing = Reviewed(ref: asking.ref, request: request) } label: { Text(verbatim: "Review") }
                                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                        }
                    }
                    .padding(Space.s4)
                    .sottoCard(.needsYou)
                }
            }
            if groups.questions.isEmpty {
                Text(verbatim: "Nothing needs you.").font(.sotto(.small)).foregroundStyle(Palette.muted).padding(.vertical, Space.s4)
            }
        }
        .sheet(item: $reviewing) { item in
            RequestSheet(ref: item.ref, request: item.request).presentationDetents([.medium, .large])
        }
    }
}

// MARK: - 1. List and thread

/// Mail's shape: the Threads home on the left, the open thread on the right, the tab rail kept.
private struct SplitMock: View {
    @State private var selection: ThreadRef? = DuoLaunch.startRef
    var body: some View {
        Tabs {
            HStack(spacing: 0) {
                ListPane(selection: $selection).frame(width: 360)
                Seam()
                ThreadPane(ref: selection)
            }
        }
    }
}

// MARK: - 2. Two threads

/// A book: one thread on each half of the fold, each at phone width, for keeping an eye on two agents at once. Either
/// page's title opens the Threads home to swap what it shows.
private struct TwoThreadsMock: View {
    @State private var left: ThreadRef? = DuoLaunch.startRef
    @State private var right: ThreadRef? = ThreadRef(hostID: DuoLaunch.laptop, threadID: "notes845")
    var body: some View {
        Tabs {
            HStack(spacing: 0) {
                ThreadPane(ref: left)
                Seam()
                ThreadPane(ref: right)
            }
        }
    }
}

// MARK: - 3. Watcher beside

/// Watcher becomes a standing page on the right; the left keeps the phone's own Threads stack.
private struct WatcherBesideMock: View {
    @State private var path: [ThreadRoute] = DuoLaunch.openThread.map { [ThreadRoute(ref: ThreadRef(hostID: DuoLaunch.laptop, threadID: $0))] } ?? []
    var body: some View {
        Tabs(watcherTab: false) {
            HStack(spacing: 0) {
                NavigationStack(path: $path) {
                    ThreadsView(openCreated: { path.append(ThreadRoute(ref: $0)) }).threadDestination()
                }
                .environment(\.sharesScreen, true)
                Seam()
                WatcherPane().frame(width: 400)
            }
        }
    }
}

// MARK: - 4. Capped measure

/// The phone layout kept, every page held to a reading measure in the middle of the wide screen.
private struct MeasureMock: View {
    @State private var path: [ThreadRoute] = DuoLaunch.openThread.map { [ThreadRoute(ref: ThreadRef(hostID: DuoLaunch.laptop, threadID: $0))] } ?? []
    var body: some View {
        Tabs(watcherWidth: 620) {
            NavigationStack(path: $path) {
                ThreadsView(openCreated: { path.append(ThreadRoute(ref: $0)) })
                    .navigationDestination(for: ThreadRoute.self) { ThreadView(ref: $0.ref).capped() }
                    .capped()
            }
        }
    }
}

extension View {
    fileprivate func capped(_ width: CGFloat = 620) -> some View {
        frame(maxWidth: width).frame(maxWidth: .infinity).background(Palette.canvas)
    }
}

// MARK: - 5. Needs you column

/// The open thread in the middle, and on the right every question and permission waiting anywhere, answered without
/// leaving the thread. The Threads home goes behind a list button in the column's head.
private struct NeedsColumnMock: View {
    @State private var selection: ThreadRef? = DuoLaunch.startRef
    @State private var listing = false
    var body: some View {
        Tabs {
            HStack(spacing: 0) {
                ThreadPane(ref: selection)
                Seam()
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        SectionHeading("Needs you", light: .warning).padding(.top, -Space.s5)
                        Spacer()
                        Button { listing = true } label: { Image(systemName: "list.bullet") }
                            .buttonStyle(GlassCircleStyle()).accessibilityLabel(Text(verbatim: "All threads"))
                    }
                    .padding(.top, Space.s4)
                    ScrollView { NeedsList { selection = $0 }.padding(.bottom, Space.s6) }
                }
                .padding(.horizontal, Space.s4)
                .frame(width: 320)
                .background(Palette.canvas)
            }
            .sheet(isPresented: $listing) { ListPane(selection: Binding(get: { selection }, set: { selection = $0; listing = false })) }
        }
    }
}

// MARK: - 6. Sidebar

/// The tab bar becomes a labelled sidebar on the left with the threads at work under it, iPad Mail's shape at phone size.
private struct SidebarMock: View {
    @EnvironmentObject var model: AppModel
    enum Place: Hashable { case threads, watcher, computers, settings }
    @State private var place: Place = DuoLaunch.openWatcher ? .watcher : .threads
    @State private var path: [ThreadRoute] = DuoLaunch.openThread.map { [ThreadRoute(ref: ThreadRef(hostID: DuoLaunch.laptop, threadID: $0))] } ?? []
    var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 230)
            Seam()
            Group {
                switch place {
                case .threads:
                    NavigationStack(path: $path) {
                        ThreadsView(openCreated: { path.append(ThreadRoute(ref: $0)) }).threadDestination()
                    }
                case .watcher: WatcherPane()
                case .computers: NavigationStack { ComputersView() }
                case .settings: NavigationStack { SettingsView() }
                }
            }
            .environment(\.sharesScreen, true)
        }
    }
    private var sidebar: some View {
        let groups = model.focusThreads(show: model.show, opened: model.selected)
        return ScrollView {
            VStack(alignment: .leading, spacing: Space.s1) {
                Text("Sotto").font(.sotto(.title, .bold)).foregroundStyle(Palette.ink).padding(.bottom, Space.s4).padding(.leading, Space.s3)
                item("Threads", "bubble.left", .threads, count: model.threadsBadge)
                if model.watcherHostID != nil { item("Watcher", nil, .watcher, count: model.watcherTab.needs) }
                item("Computers", "desktopcomputer", .computers)
                item("Settings", "slider.horizontal.3", .settings)
                if !groups.working.isEmpty {
                    Text("Working now").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                        .padding(.top, Space.s6).padding(.bottom, Space.s1).padding(.leading, Space.s3)
                    ForEach(groups.working + groups.questions) { row in
                        Button { place = .threads; path = [ThreadRoute(ref: row.ref)] } label: {
                            HStack(spacing: Space.s2) {
                                Light(tone: row.thread.requests.isEmpty ? .accent : .warning, breathing: row.thread.requests.isEmpty)
                                Text(verbatim: row.thread.title).font(.sotto(.small)).foregroundStyle(Palette.ink).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, Space.s3).frame(minHeight: 36)
                            .background(Palette.surface.opacity(path.last?.ref == row.ref ? 1 : 0), in: RoundedRectangle(cornerRadius: Radius.sm))
                        }.buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, Space.s3).padding(.top, Space.s5)
        }
        .background(Palette.surface.opacity(0.35))
    }
    private func item(_ title: String, _ symbol: String?, _ target: Place, count: Int = 0) -> some View {
        Button { place = target } label: {
            HStack(spacing: Space.s3) {
                Group {
                    if let symbol { Image(systemName: symbol) } else { Image("WatcherTab").renderingMode(.template) }
                }
                .frame(width: 24).foregroundStyle(place == target ? Palette.accentText : Palette.muted)
                Text(title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                Spacer()
                if count > 0 { Text("\(count)").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted) }
            }
            .padding(.horizontal, Space.s3).frame(minHeight: 44)
            .background(Palette.surface.opacity(place == target ? 1 : 0), in: RoundedRectangle(cornerRadius: Radius.md))
        }.buttonStyle(.plain)
    }
}

// MARK: - 7. Board

/// The Threads home as a board: Needs you, Working now and Recent side by side, read across at a glance. A thread
/// opens full width over it, at a reading measure.
private struct BoardMock: View {
    @EnvironmentObject var model: AppModel
    @State private var path: [ThreadRoute] = DuoLaunch.openThread.map { [ThreadRoute(ref: ThreadRef(hostID: DuoLaunch.laptop, threadID: $0))] } ?? []
    var body: some View {
        Tabs {
            NavigationStack(path: $path) {
                board
                    .navigationDestination(for: ThreadRoute.self) { ThreadView(ref: $0.ref).capped(680) }
                    .toolbar(.hidden, for: .navigationBar)
            }
        }
    }
    private var board: some View {
        let groups = model.focusThreads(show: model.show, opened: model.selected)
        let unread = Set(groups.recent.filter { groups.isUnreadFinish($0) }.map(\.id))
        return VStack(alignment: .leading, spacing: 0) {
            PageHeading(String(localized: "Threads")) {
                Button {} label: { Image(systemName: "plus") }.buttonStyle(GlassCircleStyle()).accessibilityLabel("New thread")
            }
            .padding(.horizontal, Space.gutter).padding(.top, Space.s1)
            HStack(alignment: .top, spacing: Space.s4) {
                column("Needs you", count: groups.questions.count, light: .warning) { NeedsList { path = [ThreadRoute(ref: $0)] } }
                column("Working now", count: groups.working.count, light: .accent) {
                    VStack(spacing: Space.s3) { ForEach(groups.working) { WorkingCard(row: $0) } }
                }
                column("Recent", count: groups.recent.count, light: nil) {
                    ThreadRowList(rows: groups.recent, unread: unread, watched: model.watchedThreadIDs)
                }
            }
            .padding(.horizontal, Space.gutter)
        }
        .background(alignment: .top) { Wash(warm: groups.requestCount > 0, height: 420).ignoresSafeArea() }
        .background(Palette.canvas)
    }
    private func column<C: View>(_ title: String, count: Int, light: Light.Tone?, @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeading(title, count: count, light: light).padding(.top, -Space.s4)
            ScrollView { content().padding(.bottom, Space.s6) }.scrollIndicators(.hidden)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - 8. Thread strip

/// One thread at a time at a reading measure, with every live thread as a mark down a thin strip on the left, the way a
/// chat app lists its rooms. Tapping a mark switches threads; the top of the strip goes back to the Threads home.
private struct StripMock: View {
    @EnvironmentObject var model: AppModel
    @State private var selection: ThreadRef? = DuoLaunch.startRef
    var body: some View {
        Tabs {
            HStack(spacing: 0) {
                strip
                Seam()
                Group {
                    if let selection {
                        NavigationStack { ThreadView(ref: selection).id(selection).capped(640) }.environment(\.sharesScreen, true)
                    } else {
                        ListPane(selection: $selection).capped(640)
                    }
                }
            }
        }
    }
    private var strip: some View {
        let groups = model.focusThreads(show: model.show, opened: model.selected)
        let rows = groups.questions + groups.working + groups.recent
        return ScrollView {
            VStack(spacing: Space.s3) {
                Button { selection = nil } label: { Image(systemName: "square.grid.2x2") }
                    .buttonStyle(GlassCircleStyle()).accessibilityLabel(Text(verbatim: "All threads")).padding(.bottom, Space.s2)
                ForEach(rows) { row in
                    let chosen = selection == row.ref
                    let tone: Light.Tone = !row.thread.requests.isEmpty ? .warning : ThreadState(row.thread).words == ThreadState.done.words ? .off : .accent
                    Button { selection = row.ref } label: { mark(row, chosen: chosen, tone: tone) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(row.thread.title)
                }
            }
            .padding(.vertical, Space.s4)
        }
        .scrollIndicators(.hidden)
        .frame(width: 72)
        .background(Palette.canvas)
    }
    private func mark(_ row: HostedThread, chosen: Bool, tone: Light.Tone) -> some View {
        Text(String(row.thread.title.prefix(1)))
            .font(.sotto(.body, .bold)).foregroundStyle(chosen ? Palette.canvas : Palette.ink)
            .frame(width: 44, height: 44)
            .background(chosen ? Palette.accent : Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(alignment: .topTrailing) {
                if tone != .off { Light(tone: tone).padding(3).background(Palette.canvas, in: Circle()).offset(x: 5, y: -5) }
            }
    }
}
#endif
