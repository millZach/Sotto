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
    /// Counts presses on the bar's owl, each of which takes the open pane to its top, where Watcher's hero is.
    @State private var toTop = 0
    /// The bar has slid away as the user reads down the page; it comes back as they go up (#1278).
    @State private var barAway = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @State private var stopPreview: WatcherStopPreview?
    /// Counts confirmed stops, so the view that carries the alert can give the destructive act a warning buzz.
    @State private var stopsConfirmed = 0
    @State private var reviewing: ReviewedCard?
    enum Pane: Hashable { case conversation, watched }

    var body: some View {
        Group {
            switch section {
            case .conversation: WatcherConversationPane(hostID: hostID, toTop: toTop, slideBar: slideBar) { reviewing = $0 }
            case .watched: WatchedPane(hostID: hostID, toTop: toTop, slideBar: slideBar, stopAll: prepareStop)
            }
        }
        // The bar keeps its place in the layout while it is away, so the page never jumps as it goes and comes back: it
        // only slides, up past the screen's top edge.
        .safeAreaInset(edge: .top, spacing: 0) {
            let away = barAway
            WatcherBar(hostID: hostID, section: $section) { slideBar(false); toTop += 1 }
                .readingWidth()
                .visualEffect { content, proxy in content.offset(y: away ? -proxy.frame(in: .global).maxY : 0) }
                .accessibilityHidden(away)
        }
        // While the bar is away, glass under the status bar keeps the page's words from running into the clock.
        .overlay(alignment: .top) {
            Color.clear.frame(height: 0)
                .background { Color.clear.glass(in: Rectangle()).ignoresSafeArea(edges: .top) }
                .opacity(barAway ? 1 : 0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .background(Palette.canvas)
        .navigationTitle("Watcher")
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { model.watcherOnScreen = true; barAway = false }
        .onDisappear { model.watcherOnScreen = false }
        // Another computer's Watcher opens on its own Conversation, with nothing of this one's open over it.
        .onChange(of: hostID) { _, _ in section = .conversation; stopPreview = nil; reviewing = nil; barAway = false }
        .onChange(of: section) { _, _ in barAway = false }
        .onChange(of: voiceOver) { _, on in if on { barAway = false } }
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
                stopsConfirmed += 1
                Task { await model.confirmWatcherStop(preview, on: hostID) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { preview in
            Text(stopMessage(preview))
        }
        .sensoryFeedback(.warning, trigger: stopsConfirmed)
    }

    /// What stays, then each thread Stop all would stop and where it runs: "Fix login test, Claude Code on Laptop".
    private func stopMessage(_ preview: WatcherStopPreview) -> String {
        let threads = preview.targets.map { target -> String in
            let computer = model.computerName(target.hostId) ?? String(localized: "another computer", comment: "Stands in for a computer this iPhone has no name for")
            return String(localized: "watcher-stop.thread", defaultValue: "\(target.title), \(AgentNames.name(target.provider)) on \(computer)",
                          comment: "The first %@ is a thread's title, the second the provider's name, such as Claude Code, the third the computer's name")
        }
        return ([String(localized: "Threads you started or took over keep going, and so does Watcher."), ""] + threads).joined(separator: "\n")
    }

    /// Slides the bar away, or back. Under Reduce Motion it goes and comes back without sliding, and with VoiceOver on it
    /// stays, where VoiceOver can always reach the switch.
    private func slideBar(_ away: Bool) {
        guard away != barAway, !(away && voiceOver) else { return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { barAway = away }
    }

    /// Stop all asks first: the computer says which threads it would stop, and nothing stops until the user confirms.
    private func prepareStop() {
        Task {
            guard let preview = await model.prepareWatcherStop(hostID) else { return }
            if preview.targets.isEmpty { model.feedback = String(localized: "Watcher has no threads of its own to stop. Nothing was stopped.") }
            else { stopPreview = preview }
        }
    }
}

// MARK: - Header

/// The slim bar pinned over Watcher's page in glass (#1275, Zach's pick A of
/// `docs/prototypes/iphone-watcher-room-prototype.html`): the owl, which goes to the top of the page where Watcher's hero
/// is, and Conversation | Watched. Watcher's name, state and computer scroll away with the page, in `WatcherHero`, so
/// the conversation has the room, as a thread's title does on its page.
private struct WatcherBar: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    @Binding var section: WatcherView.Pane
    let toTop: () -> Void
    var body: some View {
        let page = model.watcherPage(hostID)
        HStack(spacing: Space.s2) {
            owl
            SectionSwitch(section: $section, watched: page?.watched.count ?? 0)
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s1)
        .padding(.bottom, Space.s2)
        .background {
            // Glass that reaches up under the status bar, rounded where it meets the page.
            Color.clear
                .glass(in: UnevenRoundedRectangle(bottomLeadingRadius: Radius.xl, bottomTrailingRadius: Radius.xl, style: .continuous))
                .ignoresSafeArea(edges: .top)
        }
        // The bar as a whole, from the status bar to where its glass ends over the page, so a journey reads where the bar
        // ends from the bar itself. VoiceOver still reads the owl and the switch.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("watcher-bar")
    }
    /// Once the hero has scrolled off, Watcher's state is the light on the owl, and VoiceOver reads it as the owl's value.
    private var owl: some View {
        let state = WatcherStatePill.state(model, hostID)
        return Button(action: toTop) {
            WatcherOwlMark(size: 22)
                .foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44)
                .background(Palette.fillSoft, in: Circle())
                .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 1))
                .overlay(alignment: .topTrailing) {
                    Light(tone: state.tone, size: 7, breathing: state.tone == .accent)
                        .padding(2)
                        .background(Palette.raised, in: Circle())
                        .offset(x: -1, y: 2)
                }
                .contentShape(Circle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(WatcherWords.toTop)
        .accessibilityValue(state.word)
        .accessibilityIdentifier("watcher-to-top")
    }
}

/// Watcher's name, its state, its model and computer, and what it may do without asking, at the top of each of its
/// panes, where they scroll away with the page as a thread's title does (#1275, #1276, pick A). The bar's owl brings
/// them back.
private struct WatcherHero: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    @Environment(\.dynamicTypeSize) private var typeSize
    let hostID: String
    /// Where the bar's owl scrolls each pane to.
    static let id = "watcher-hero"
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            // The state sits beside the name, as the design draws it. At accessibility sizes it goes under the name.
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
            if model.watcherHostIDs.count > 1 { computerMenu } else { subtitleText }
            WatcherMachinesLine(hostID: hostID)
            if model.offersWatcherManage(hostID), model.watcherPage(hostID) != nil {
                WatcherPermissionChip(hostID: hostID).padding(.top, Space.s1)
            }
            Rectangle().fill(Palette.hairline).frame(height: 1).padding(.top, Space.s2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .id(Self.id)
    }
    private var title: some View {
        HStack(spacing: Space.s3) {
            WatcherOwlMark(size: 28)
                .foregroundStyle(Palette.ink)
                .frame(width: 48, height: 48)
                .background(Palette.raised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
                .accessibilityHidden(true)
            Text("Watcher").font(.sotto(.display, .bold)).headingTracking(-0.6).foregroundStyle(Palette.ink)
                .accessibilityAddTraits(.isHeader)
        }
    }
    private var subtitleText: some View {
        Text(subtitle).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
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
        guard let running = model.watcherModel(hostID) else { return String(localized: "On \(computer)", comment: "Where Watcher runs. %@ is the computer's name") }
        return String(localized: "\(running) on \(computer)",
                      comment: "Where Watcher runs. The first %@ is its provider and model, such as Codex · GPT-6.1 Sol; the second is the computer's name")
    }
}

// MARK: - Machines

/// The machines line (#1032, Zach's pick D "Names" on October 23, 2026), under Watcher's computer while that computer has
/// Work across machines on: each machine's name, then its working count, then the words a problem adds, in the warning
/// ink. A phone always shortens it: no "starting" counts, only the machines with a problem and how many more, and with
/// nothing wrong anywhere just how many machines and how much works on them. Each name opens that machine's panel, and
/// the count of the rest shows every machine. Plain text and underlined names, never pills or chips (ADR-0110).
private struct WatcherMachinesLine: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    @State private var all = false
    @State private var open: OpenMachine?
    struct OpenMachine: Identifiable { let id: String }

    var body: some View {
        if model.offersWatcherMachines(hostID), let machines = model.watcherPage(hostID)?.machines, !machines.rows.isEmpty {
            let rows = MachineLine.named(machines.rows, computer: model.name(hostID))
            let short = MachineLine.short(rows)
            let shown = all ? rows : short.shown
            FlowLayout(spacing: Space.s1) {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, machine in
                    entry(machine, first: index == 0, starting: all)
                }
                if !all && short.more > 0 {
                    if short.shown.isEmpty {
                        moreButton(MachineLine.calm(rows), label: MachineLine.calmLabel(rows))
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: Space.s1) {
                            Text("·").foregroundStyle(Palette.muted).accessibilityHidden(true)
                            moreButton(MachineLine.more(short.more), label: MachineLine.moreLabel(short.more))
                        }
                    }
                }
            }
            .font(.sotto(.small))
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Machines and what works on each")
            .accessibilityIdentifier("watcher-machines")
            // Machine facts are read when Watcher places work, once for each set of starts, and when a panel opens.
            .onAppear { model.readWatcherMachinesAfterStarts(hostID) }
            .onChange(of: model.watcherPage(hostID)?.receiptGroups) { _, _ in model.readWatcherMachinesAfterStarts(hostID) }
            .onChange(of: hostID) { _, _ in all = false; open = nil }
            .sheet(item: $open) { machine in
                MachineSheet(hostID: hostID, machineID: machine.id)
                    .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
        }
    }

    /// One machine: its name, a press that opens its panel, then its count and any problem's words.
    private func entry(_ machine: WatcherMachines.Machine, first: Bool, starting: Bool) -> some View {
        let count = MachineLine.count(machine, starting: starting)
        let problems = MachineLine.problems(machine).joined(separator: ", ")
        return HStack(alignment: .firstTextBaseline, spacing: Space.s1) {
            if !first { Text("·").foregroundStyle(Palette.muted).accessibilityHidden(true) }
            Button { open = OpenMachine(id: machine.id) } label: {
                // A long saved name gives way to an ellipsis; the button's spoken label keeps it whole.
                Text(machine.name).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                    .underline()
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: 180, alignment: .leading)
            }
            .buttonStyle(.plain)
            .frame(minHeight: 30)
            .contentShape(Rectangle())
            .accessibilityLabel(MachineLine.label(machine))
            .accessibilityIdentifier("watcher-machine-\(machine.id)")
            if !count.isEmpty { Text(count).foregroundStyle(Palette.muted).lineLimit(1).fixedSize().accessibilityHidden(true) }
            if !problems.isEmpty {
                Text((count.isEmpty ? "" : ", ") + problems).foregroundStyle(Palette.warningText)
                    .fixedSize(horizontal: false, vertical: true).accessibilityHidden(true)
            }
        }
    }

    private func moreButton(_ words: String, label: String) -> some View {
        Button { all = true } label: {
            Text(words).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink).underline()
        }
        .buttonStyle(.plain)
        .frame(minHeight: 30)
        .contentShape(Rectangle())
        .accessibilityLabel(label)
        .accessibilityIdentifier("watcher-machines-more")
    }
}

/// One machine's panel, as a sheet (#1032, pick D): its system, CPU busy, memory available and when that was read; why its
/// load reads unknown when it does; what works there and who started each; and whether new workers start there.
/// Opening it reads the machines afresh. Where new workers start is changed on the computer, in Settings.
private struct MachineSheet: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var watcherStore: WatcherStore
    @Environment(\.dismiss) private var dismiss
    let hostID: String
    let machineID: String

    var body: some View {
        let computer = model.name(hostID)
        let machine = model.watcherPage(hostID)?.machines.flatMap { MachineLine.named($0.rows, computer: computer).first { $0.id == machineID } }
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s3) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                    Text(machine?.name ?? String(localized: "Machine", comment: "A machine panel's title before its name is known")).font(.sotto(.title, .bold)).tracking(-0.4).foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: Space.s2)
                    Button("Done") { dismiss() }
                        .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("machine-done")
                }
                if let machine { details(machine, computer: computer) }
                else { line("\(computer) no longer lists this machine.") }
            }
            .padding(Space.gutter)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Palette.canvas)
        .task { await model.readWatcherMachines(hostID) }
    }

    @ViewBuilder private func details(_ machine: WatcherMachines.Machine, computer: String) -> some View {
        if !machine.connected {
            line(MachineLine.notConnected(machine, computer: computer))
        } else {
            VStack(alignment: .leading, spacing: Space.s2) {
                if let system = machine.system {
                    row("System", system + (machine.logicalCpuCount.map { " · \($0) CPUs" } ?? ""), warn: false)
                }
                if machine.cpuState != nil {
                    row("CPU", MachineLine.cpu(machine), warn: machine.cpuState != "not-busy")
                    row("Memory", MachineLine.memoryRow(machine), warn: machine.memoryState != "enough")
                }
                if let at = machine.loadObservedAt.flatMap({ Stamp.date($0) }) {
                    row("Read", MachineLine.ago(Date().timeIntervalSince(at)), warn: false)
                }
            }
            if let why = machine.unknownWhy { line(why) }
            Text(MachineLine.panelCount(machine)).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
            if let over = MachineLine.over(machine) { line(over, warn: true) }
            if !machine.threads.isEmpty || machine.starting > 0 {
                VStack(alignment: .leading, spacing: Space.s2) {
                    ForEach(Array(machine.threads.enumerated()), id: \.offset) { _, thread in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(thread.title).font(.sotto(.small)).foregroundStyle(Palette.ink).lineLimit(2)
                            Text(thread.who).font(.sotto(.caption)).foregroundStyle(Palette.muted)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    if machine.working > machine.threads.count {
                        Text("and \(machine.working - machine.threads.count) more").font(.sotto(.caption)).foregroundStyle(Palette.muted)
                    }
                    if machine.starting > 0 {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(machine.starting) placed here, starting").font(.sotto(.small)).foregroundStyle(Palette.ink)
                            Text("Counted, so the next start sees it").font(.sotto(.caption)).foregroundStyle(Palette.muted)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        line("Where new workers start is set on \(computer), in Settings, under Watcher.")
    }

    private func row(_ name: String, _ value: String, warn: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
            Text(name).foregroundStyle(Palette.muted).frame(width: 72, alignment: .leading)
            Text(value).foregroundStyle(warn ? Palette.warningText : Palette.ink).monospacedDigit().fixedSize(horizontal: false, vertical: true)
        }
        .font(.sotto(.small))
        .accessibilityElement(children: .combine)
    }

    private func line(_ words: String, warn: Bool = false) -> some View {
        Text(words).font(.sotto(.small)).foregroundStyle(warn ? Palette.warningText : Palette.muted).fixedSize(horizontal: false, vertical: true)
    }
}

/// Watcher's state in a word, as a thread's bar says its own.
private struct WatcherStatePill: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    var body: some View {
        let state = Self.state(model, hostID)
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
        .accessibilityLabel(String(localized: "Watcher, \(state.word)", comment: "For VoiceOver. %@ is Watcher's state, such as Working"))
        .accessibilityIdentifier("watcher-state")
    }
    static func state(_ model: AppModel, _ hostID: String) -> (word: String, tone: Light.Tone, ink: ThemeRole, fill: ThemeRole) {
        guard model.online(hostID) else {
            return (String(localized: "Can’t reach it", comment: "Watcher's state: its computer can't be reached"), .off, Palette.muted, Palette.fillSoft)
        }
        guard let page = model.watcherPage(hostID), let current = page.current else {
            return (String(localized: "Not started", comment: "Watcher's state: it isn't running"), .off, Palette.muted, Palette.fillSoft)
        }
        if page.needsYou.contains(where: { page.isOwn($0) }) {
            return (String(localized: "Needs you", comment: "Watcher's state: it is waiting on the user"), .warning, Palette.warningText, Palette.warning.opacity(Tint.accentPill))
        }
        if current.status == "error" {
            return (String(localized: "Failed", comment: "Watcher's state: it stopped with an error"), .danger, Palette.dangerText, Palette.danger.opacity(0.12))
        }
        if page.working {
            return (String(localized: "Working", comment: "Watcher's state: it is taking a turn"), .accent, Palette.accentText, Palette.accent.opacity(Tint.accentPill))
        }
        return (String(localized: "Idle", comment: "Watcher's state: nothing is running"), .off, Palette.muted, Palette.fillSoft)
    }
}

/// Conversation | Watched: two halves of one capsule, the chosen one raised.
private struct SectionSwitch: View {
    @Binding var section: WatcherView.Pane
    let watched: Int
    @Namespace private var knob
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var picks = 0
    var body: some View {
        HStack(spacing: 4) {
            option(.conversation, String(localized: "Conversation", comment: "One of Watcher's two panes"), count: nil, id: "watcher-section-conversation")
            option(.watched, String(localized: "Watched", comment: "One of Watcher's two panes: the threads it watches"), count: watched, id: "watcher-section-watched")
        }
        .padding(4)
        .background(Palette.fillSoft, in: Capsule())
        .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
        .sensoryFeedback(.selection, trigger: picks)
    }
    private func option(_ value: WatcherView.Pane, _ title: String, count: Int?, id: String) -> some View {
        let chosen = section == value
        return Button {
            picks += 1
            withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85)) { section = value }
        } label: {
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
                        .matchedGeometryEffect(id: "watcher-section-knob", in: knob)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(spoken(title, count: count))
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
        .accessibilityIdentifier(id)
    }
    /// "Watched, 3 threads", for VoiceOver.
    private func spoken(_ title: String, count: Int?) -> String {
        guard let count else { return title }
        let threads = count == 1 ? String(localized: "1 thread") : String(localized: "\(count) threads")
        return String(localized: "\(title), \(threads)", comment: "For VoiceOver. The first %@ is a Watcher pane's name; the second a count of threads, such as 3 threads")
    }
}

// MARK: - Conversation

/// Where Watcher's conversation stands, kept outside SwiftUI's state so scrolling never redraws it. Frames are global.
private final class WatcherFollow {
    /// Whether this iOS says when the user lets go of the page, as iOS 18 and later do. iOS 17 can't, and keeps the page's
    /// end where it was as the page grows, so there where the page stands is decided as its end moves, as a thread's is.
    static let seesLetGo: Bool = { if #available(iOS 18.0, *) { return true } else { return false } }()
    /// The bottom of the newest words, and of the page.
    var newest: CGFloat = 0
    var end: CGFloat = 0
    /// The bottom of the header, and the top of the box.
    var top: CGFloat = 0
    var dockTop: CGFloat = .greatestFiniteMagnitude
    /// Where each card waiting on the user sits, by the card's key.
    var cards: [String: CGRect] = [:]
    /// The key of the card the reader is on. Nothing but the reader moves it away: Watcher's new words, the box changing
    /// height and the keyboard all leave it whole above the box (#1277). Taken where the user lets go of the page with a
    /// card in view, and let go of where they let go with none, when they send their own words, or when the card leaves.
    var held: String?
    /// How far below the header the held card's top was where the reader was put on it. The page keeps it there as the
    /// page changes around it, or as near as keeps it whole between the header and the box.
    var heldOffset: CGFloat = 0
    /// The page's height, so a frame that moved for a change of height is told apart from one the page scrolled.
    var height: CGFloat = 0
    /// The reader sees the newest words, or the page's end where it opens, and no card they are on, so the page follows
    /// Watcher's new words. Decided where the user lets go of the page, or the box moves, never as the content grows: new
    /// words judged by where they pushed the page would stop it following them.
    var following = true
    /// The user is dragging the page or letting a flick run out, so it never moves under them.
    var userScrolling = false
    /// New words came while the user moved the page; followed once they let go, if they let go where it follows.
    var missedFollow = false
    /// Counts requests to follow, so requests made in the same moment scroll once.
    var followRequests = 0
    /// Which way the user moves the page, for the bar (#1278).
    var slide = WatcherBarSlide()
    /// Until when the page moves for the app rather than the user: following new words, or going to the top. iOS 17
    /// can't say when the user moves the page, so there a move outside these times is theirs.
    var quietUntil = Date.distantPast
    func quiet() { quietUntil = Date().addingTimeInterval(0.6) }
    /// Whether the move the page just made was the user's.
    var userMoved: Bool { WatcherFollow.seesLetGo ? userScrolling : Date() >= quietUntil }
    func settle() {
        let place = WatcherReaderPlace(newest: newest, end: end, top: top, dockTop: dockTop, cards: cards)
        held = place.heldCard
        following = place.following
        if let held, let card = cards[held] { heldOffset = card.minY - top }
    }
}

private extension View {
    /// Opens at the page's end, and sits a short conversation at the bottom, as a chat does. On iOS 18 and later that is
    /// all the anchor does, so a page that grows keeps a reader's place and follows new words only for a reader who sees
    /// them (`WatcherFollow`), except while the reader is on a card: Watcher's words grow above the cards, so there the
    /// page keeps its bottom where it was and the card stays put as they grow. iOS 17 can't separate the anchor's roles,
    /// so there it always keeps its bottom, as it did before. Either way, what changes below the card moves it with the
    /// page's bottom, and the page puts it back (`WatcherConversationPane.keepHeldCard`).
    @ViewBuilder func watcherScrollAnchor(holdingCard: Bool) -> some View {
        if #available(iOS 18.0, *) {
            defaultScrollAnchor(.bottom, for: .initialOffset).defaultScrollAnchor(.bottom, for: .alignment)
                .defaultScrollAnchor(holdingCard ? .bottom : nil, for: .sizeChanges)
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
    /// Presses on the bar's owl: each one scrolls the page to its top, to Watcher's hero.
    let toTop: Int
    /// Slides the bar away, or back, as the user reads down or goes up.
    let slideBar: (Bool) -> Void
    let review: (ReviewedCard) -> Void
    @Environment(\.sottoDensity) private var density
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var follow = WatcherFollow()
    /// The height between the bar and the box, so a short conversation sits at the bottom with the hero still at the top.
    @State private var visible: CGFloat = 0
    /// The reader is on a card (`WatcherFollow.held`), as the scroll anchor needs it. Changed only where that is decided,
    /// never as the page scrolls, and read only on iOS 18 and later.
    @State private var holdingCard = false
    /// A message's photos, open full screen.
    @State private var viewing: OpenPhotos?
    private static let end = "watcher-end"
    private static let sendingID = "watcher-sending"
    /// A waiting card's place on the page, to scroll it whole above the box.
    private static func cardID(_ key: String) -> String { "watcher-needs-you-" + key }

    var body: some View {
        let page = model.watcherPage(hostID)
        let sending = model.watcherSendingShown(hostID)?.text
        let sendingPhotos = model.watcherSendingPhotos[hostID] ?? [], sendingFiles = model.watcherSendingFiles[hostID] ?? []
        // The photos of Watcher's messages are its thread's, read through Watcher's page.
        let ref = page?.current.map { ThreadRef(hostID: hostID, threadID: $0.target.threadId) }
        let items = page.map { WatcherConversation.items($0) } ?? []
        let newest = sending != nil ? Self.sendingID : items.last?.id ?? Self.end
        // While a card waits on the user, the bar stays where it is (#1288).
        let pinned = page?.needsYou.isEmpty == false
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Space.dense(Space.s5, density)) {
                    // In to the page's gutter, as on Watched, rather than the conversation's narrower margin.
                    WatcherHero(hostID: hostID).padding(.horizontal, Space.gutter - Space.s4)
                    Spacer(minLength: 0)
                    notes(page)
                    if !items.isEmpty || sending != nil {
                        // The conversation and the words on their way, whose bottom is the newest words.
                        VStack(alignment: .leading, spacing: Space.dense(Space.s5, density)) {
                            ForEach(items) { item in
                                Group {
                                    switch item {
                                    case .message(let message): WatcherMessage(message: message, ref: ref) { viewing = $0 }.equatable()
                                    case .receipts(let group, _): ReceiptCard(hostID: hostID, group: group)
                                    case .ownChange(let change): WatcherOwnChangeLine(change: change)
                                    }
                                }
                                .id(item.id)
                            }
                            if let sending { SendingBubble(text: sending, photos: sendingPhotos, files: sendingFiles).id(Self.sendingID) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(reader { follow.newest = $0.maxY })
                        .environment(\.replyQuoteBox, ReplyQuoteBox(key: model.watcherDraftKey(hostID)) { [model, hostID] in
                            model.quoteReply($0, into: model.watcherDraftKey(hostID))
                        })
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
                    // What goes next, after Watcher's turn: a quiet line for each of the user's follow-ups (#1229, pick B).
                    ForEach(page?.followups ?? []) { item in
                        if let page { WatcherFollowupLine(hostID: hostID, item: item, page: page) }
                    }
                    Color.clear.frame(height: 1).id(Self.end)
                        .background(reader { follow.end = $0.maxY })
                }
                .padding(.horizontal, Space.s4)
                .padding(.top, Space.s4)
                .padding(.bottom, Space.s4)
                .readingWidth()
                .frame(maxWidth: .infinity, minHeight: visible, alignment: .topLeading)
                .background(reader { frame in
                    // A change of the page's height (new words, a card or a follow-up arriving or leaving, anywhere on
                    // the page) puts the card the reader is on back where they left it. Only a frame the page scrolled
                    // says where the reader is, on iOS 17, which can't say when they let go.
                    let resized = abs(frame.height - follow.height) > 0.5
                    follow.height = frame.height
                    if resized { keepHeldCard(proxy, animated: false) } else if !WatcherFollow.seesLetGo { settle() }
                    // How far the page has scrolled from its top, short of the bounce past its end, which would read as
                    // going back up.
                    let offset = min(follow.top - frame.minY, max(0, frame.height - (follow.dockTop - follow.top)))
                    if let away = follow.slide.moved(to: offset, counts: !resized && follow.userMoved, pinned: pinned) {
                        slideBar(away)
                    }
                })
            }
            .watcherScrollAnchor(holdingCard: holdingCard)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.readWatcher(hostID) }
            .onUserScrolling { scrolling in
                let wasScrolling = follow.userScrolling
                follow.userScrolling = scrolling
                guard wasScrolling && !scrolling else { return }
                // Where they let go decides whether the page follows, or keeps the card they stopped on. What arrived
                // while they moved it is followed then, if they let go where it follows; a page moved to earlier messages
                // is left where they put it.
                settle()
                guard follow.missedFollow else { return }
                follow.missedFollow = false
                if follow.following { toNewest(proxy, to: newest) } else { keepHeldCard(proxy, animated: true) }
            }
            .background(barReader)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                WatcherDock(hostID: hostID, willSend: {
                    // A fast send can begin and end before SwiftUI renders its sending state. The press itself
                    // resumes following, before the keyboard and the conversation change their layout.
                    resumeFollowing()
                }).readingWidth().background(dockReader(proxy, newest: newest))
            }
            // New words, the user's own or Watcher's, are scrolled to just above the box, for a reader who sees the newest
            // words or the page's end. Cards waiting on the user sit after the whole conversation, where the page opens,
            // so scrolling to the end would leave the new words under the header on a small phone. A reader of earlier
            // messages is left there, a reader on a card is left on it, where the page's change of height puts it back,
            // and the user's own words are always shown as they send them (ADR-0051).
            .onChange(of: WatcherTail(revision: page?.conversation.revision ?? 0, sending: sending != nil)) { before, after in
                if after.sending && !before.sending { resumeFollowing() }
                if follow.following { toNewest(proxy, to: newest) }
            }
            // The card the reader was on left the page, answered here or anywhere else: the page follows the newest words
            // again.
            .onChange(of: page?.needsYou.map(\.key) ?? []) { _, keys in
                guard let held = follow.held, !keys.contains(held) else { return }
                resumeFollowing()
                toNewest(proxy, to: newest)
            }
            .onChange(of: toTop) { _, _ in toHero(proxy) }
            // A card that arrives with the bar away brings it back, without moving the page: the bar keeps its place in
            // the layout while it is away. It stays until no card waits (#1288).
            .onChange(of: pinned, initial: true) { _, waits in if waits { slideBar(false) } }
        }
        .fullScreenCover(item: $viewing) { PhotoViewer(opened: $0) }
    }

    /// Scrolls to the hero at the page's top. The reader is reading there now, so Watcher's new words leave them there;
    /// where they stand is decided again once the page has stopped.
    private func toHero(_ scroll: ScrollViewProxy) {
        let box = follow
        box.followRequests += 1
        box.missedFollow = false
        box.held = nil
        box.following = false
        setHoldingCard(false)
        let still = reduceMotion
        box.quiet()
        withAnimation(still ? nil : .easeOut(duration: 0.35)) { scroll.scrollTo(WatcherHero.id, anchor: .top) }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: still ? 120_000_000 : 450_000_000)
            if !box.userScrolling { settle() }
        }
    }

    /// Decides where the page stands (`WatcherFollow.settle`), and tells the scroll anchor whether the reader is on a card.
    private func settle() {
        follow.settle()
        setHoldingCard(follow.held != nil)
    }
    /// The page follows the newest words again, and no card is held.
    private func resumeFollowing() {
        follow.held = nil
        follow.following = true
        setHoldingCard(false)
    }
    private func setHoldingCard(_ holding: Bool) {
        if WatcherFollow.seesLetGo, holdingCard != holding { holdingCard = holding }
    }

    /// Reads a frame, in global coordinates, as it moves. Nothing redraws for it, and nothing is decided by it.
    private func reader(_ moved: @escaping (CGRect) -> Void) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { moved(proxy.frame(in: .global)) }
                .onChange(of: proxy.frame(in: .global)) { _, frame in moved(frame) }
        }
    }
    /// The bottom of the header, which sits over the page's top. Where the page stands is decided where the user lets go
    /// of it or the box moves; the header only says where the page's top is.
    private var barReader: some View {
        GeometryReader { proxy in
            let bottom = proxy.frame(in: .global).minY + proxy.safeAreaInsets.top
            Color.clear
                .onAppear { follow.top = bottom; updateVisible() }
                .onChange(of: bottom) { _, value in follow.top = value; updateVisible() }
        }
    }
    private func updateVisible() {
        guard follow.dockTop < .greatestFiniteMagnitude / 2 else { return }
        let next = max(0, follow.dockTop - follow.top)
        if abs(next - visible) > 0.5 { visible = next }
    }
    /// The top of the box, which moves when it changes height or the keyboard opens or closes. A reader who saw the newest
    /// words before it moved still sees them after, and a reader on a card still sees all of it.
    private func dockReader(_ scroll: ScrollViewProxy, newest: String) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { follow.dockTop = proxy.frame(in: .global).minY; updateVisible() }
                .onChange(of: proxy.frame(in: .global).minY) { _, value in
                    let wasFollowing = follow.following
                    follow.dockTop = value
                    updateVisible()
                    if wasFollowing { toNewest(scroll, to: newest) }
                    else if follow.held != nil { keepHeldCard(scroll, animated: true) }
                    else { settle() }
                }
        }
    }
    /// Keeps the card the reader is on where they left it (`WatcherReaderPlace.anchor`) once the new layout is in, and
    /// looks once more after it has settled: the box rose over it, or the page changed around it and its bottom carried
    /// the card off. The box moving slides it, as the box does; a change in the page puts it back at once, so it never
    /// drifts. Requests made in the same moment scroll once. None scrolls while the user moves the page; the page owes it
    /// to them for when they let go.
    private func keepHeldCard(_ scroll: ScrollViewProxy, animated: Bool) {
        let box = follow
        guard box.held != nil else { return }
        guard !box.userScrolling else { box.missedFollow = true; return }
        box.followRequests += 1
        let request = box.followRequests
        let still = reduceMotion || !animated
        Task { @MainActor in
            await Task.yield()
            Self.place(box, scroll, request: request, still: still)
            try? await Task.sleep(nanoseconds: 120_000_000)
            Self.place(box, scroll, request: request, still: still)
        }
    }
    /// Scrolls the held card back where the reader left it, if it moved and nothing asked to scroll since.
    private static func place(_ box: WatcherFollow, _ scroll: ScrollViewProxy, request: Int, still: Bool) {
        guard box.followRequests == request, !box.userScrolling, let key = box.held, let frame = box.cards[key],
              let y = WatcherReaderPlace.anchor(card: frame, offset: box.heldOffset, top: box.top, dockTop: box.dockTop) else { return }
        withAnimation(still ? nil : .easeOut(duration: 0.25)) { scroll.scrollTo(cardID(key), anchor: UnitPoint(x: 0.5, y: y)) }
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
            box.quiet()
            withAnimation(still ? nil : .easeOut(duration: 0.3)) { scroll.scrollTo(target, anchor: .bottom) }
            try? await Task.sleep(nanoseconds: still ? 120_000_000 : 360_000_000)
            if box.followRequests == request, box.following, !box.userScrolling {
                box.quiet()
                scroll.scrollTo(target, anchor: .bottom)
            }
        }
    }

    @ViewBuilder private func notes(_ page: WatcherPage?) -> some View {
        // A read that failed while a page is shown says so over the page it left.
        if page != nil, model.online(hostID), let problem = model.watcherReadProblems[hostID] { note(problem) }
        if let notice = page?.recoveryNotice, !notice.isEmpty { note(notice) }
        if page?.conversation.earlierAvailable == true {
            note(String(localized: "Earlier messages are in Sotto on \(model.name(hostID)).", comment: "%@ is the computer's name"))
        }
        if let page, page.current == nil {
            note(String(localized: "Watcher isn’t running on \(model.name(hostID)). Start it in Sotto on \(model.name(hostID)), then ask it here.",
                        comment: "Both %@ are the computer's name"))
        } else if let page, page.conversation.messages.isEmpty, model.watcherSending[hostID] == nil {
            note(String(localized: "Ask Watcher to start, check on or stop your threads. It answers nothing for you."))
        } else if page == nil {
            note(model.online(hostID) ? model.watcherReadProblems[hostID] ?? String(localized: "Reading Watcher on \(model.name(hostID))…", comment: "%@ is the computer's name")
                 : String(localized: "Reconnect to \(model.name(hostID)) to read Watcher.", comment: "%@ is the computer's name"))
        }
    }
    private func note(_ words: String) -> some View {
        Text(words).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .center).multilineTextAlignment(.center)
            .paragraphDirection()
    }

    /// What waits on the user: workers' own cards, each saying where its answer goes, then Watcher's own.
    @ViewBuilder private func cards(_ page: WatcherPage) -> some View {
        let workers = page.needsYou.filter { !page.isOwn($0) }
        let own = page.needsYou.filter { page.isOwn($0) }
        ForEach(workers, id: \.key) { card in
            waiting(card.key) {
                VStack(alignment: .leading, spacing: Space.s2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        WatcherOwlMark(size: 12).foregroundStyle(Palette.muted).accessibilityHidden(true)
                        Text("The thread’s own card. Your answer goes to \(card.title), not to Watcher.", comment: "%@ is a thread's title")
                            .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                            .paragraphDirection()
                    }
                    .accessibilityElement(children: .combine)
                    WatcherRequestCard(hostID: hostID, card: card, own: false, review: review)
                }
            }
        }
        ForEach(own, id: \.key) { card in
            waiting(card.key) { WatcherRequestCard(hostID: hostID, card: card, own: true, review: review) }
        }
    }
    /// A card waiting on the user, where the page can scroll to it and say where it sits, so a reader can be held on it.
    private func waiting<Card: View>(_ key: String, @ViewBuilder _ card: () -> Card) -> some View {
        card()
            .id(Self.cardID(key))
            .background(reader { follow.cards[key] = $0 })
            .onDisappear { follow.cards[key] = nil }
    }
}

/// A message in Watcher's conversation: the user's in a bubble at the trailing edge, Watcher's on the canvas under the
/// owl, its name and the time. Drawn again only when the message changes, not each time Watcher's page moves.
private struct WatcherMessage: View, Equatable {
    let message: Message
    /// Watcher's thread, whose photos these are; nil while the page names no Watcher.
    let ref: ThreadRef?
    let open: (OpenPhotos) -> Void
    @Environment(\.sottoDensity) private var density
    /// Opening a photo is the same action for every message.
    static func == (a: Self, b: Self) -> Bool { a.message == b.message && a.ref == b.ref }
    var body: some View {
        if message.role == "user" {
            // The user's photos stand on their own above their words, as in a thread and in Messages.
            let photos: [Attachment] = ref == nil ? [] : (message.attachments ?? []).filter(\.hasPreview)
            VStack(alignment: .trailing, spacing: Space.s1) {
                if let ref { SentPhotoButtons(ref: ref, messageID: message.id, photos: photos, open: open) }
                if !message.text.isEmpty || photos.count != (message.attachments ?? []).count {
                    VStack(alignment: .leading, spacing: Space.s2) {
                        if !message.text.isEmpty { MarkdownText(text: message.text).equatable() }
                        // A photo Sotto keeps no copy of is named, and so is a file, as in a thread (ADR-0131).
                        ForEach((message.attachments ?? []).filter { photo in !photos.contains { $0.id == photo.id } }) { attachment in
                            Label("\(attachment.name) (open on the desktop)", systemImage: attachment.mimeType.map { PhotoLimits.mimeTypes.contains($0) } == false ? "doc" : "photo").font(.sotto(.small))
                        }
                    }
                    .foregroundStyle(Palette.bubbleInk)
                    .padding(.horizontal, Space.s4)
                    .padding(.vertical, Space.dense(Space.s3, density))
                    .background(Palette.bubble, in: bubble)
                    .overlay(bubble.stroke(Palette.accent.opacity(0.12), lineWidth: 1))
                }
            }
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
                    Text(verbatim: time.map { "Watcher · \($0)" } ?? "Watcher").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                }
                MarkdownText(text: message.text, quotable: true).equatable().foregroundStyle(Palette.ink)
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
    let photos: [DraftPhoto]
    var files: [DraftFile] = []
    private static let shown = 4
    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !photos.isEmpty {
                // At most four, then how many more, so eight fit the narrowest iPhone.
                HStack(spacing: 6) {
                    ForEach(photos.prefix(Self.shown)) { photo in
                        Group {
                            if let thumbnail = photo.prepared?.thumbnail { Image(decorative: thumbnail, scale: 1).resizable().scaledToFill() }
                            else { Rectangle().fill(Palette.surface) }
                        }
                        .frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .opacity(0.6)
                    }
                    if photos.count > Self.shown {
                        Text("+\(photos.count - Self.shown)").font(.sotto(.body, .semibold)).foregroundStyle(Palette.muted)
                            .frame(width: 60, height: 60)
                            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .accessibilityElement()
                .accessibilityLabel(photos.count == 1 ? String(localized: "1 photo") : String(localized: "\(photos.count) photos"))
            }
            ForEach(files) { file in FilePill(name: file.name, sizeBytes: file.sizeBytes).opacity(0.6) }
            if !text.isEmpty {
                Text(text).font(.sotto(.body)).foregroundStyle(Palette.bubbleInk)
                    .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
                    .background(Palette.bubble.opacity(0.6), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Sending to Watcher…") }
                .font(.sotto(.caption)).foregroundStyle(Palette.muted)
                .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
    }
}

/// One of the user's follow-ups waiting for Watcher, as a quiet line under the conversation (#1229, Zach's pick B): it goes
/// next, after Watcher's turn, and Remove takes it out of the queue before it goes. Nothing is asked first.
private struct WatcherFollowupLine: View {
    @EnvironmentObject var model: AppModel
    let hostID: String
    let item: WatcherPage.Followup
    let page: WatcherPage
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
            Image(systemName: "clock")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Palette.muted)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(WatcherWords.followup(item.status)).font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
                Text(item.text.isEmpty ? String(localized: "Photos", comment: "Stands in for a queued message to Watcher that carries only photos") : item.text)
                    .font(.sotto(.body)).foregroundStyle(Palette.ink).lineLimit(1).truncationMode(.tail)
                if let note = WatcherWords.followupNote(item.status, page: page, computer: model.name(hostID)) {
                    Text(note).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                        .paragraphDirection()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            if ["queued", "paused", "failed"].contains(item.status) {
                Button("Remove") { Task { await model.removeWatcherFollowup(item, on: hostID) } }
                    .font(.sotto(.small, .semibold))
                    .foregroundStyle(Palette.accentText)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .buttonStyle(PressStyle())
                    .disabled(!model.canRemoveWatcherFollowup(item, on: hostID))
                    .accessibilityLabel(item.text.isEmpty ? String(localized: "Remove these photos from the queue")
                                        : String(localized: "Remove “\(item.text)” from the queue", comment: "%@ is the queued message's own words"))
                    .accessibilityIdentifier("watcher-followup-remove")
            }
        }
        .accessibilityIdentifier("watcher-followup")
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
            (words.unconfirmed ? Text("Watcher didn’t confirm this message") : Text("Your message to Watcher wasn’t sent"))
                .font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
            Text(verbatim: words.text).font(.sotto(.body)).foregroundStyle(Palette.ink).textSelection(.enabled)
            if words.unconfirmed {
                Text("Check the conversation before you send it again.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .paragraphDirection()
            }
            Button("Put it back in the box") { model.restoreWatcherWords(words, on: hostID) }
                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                .disabled(!model.canRestoreWatcherWords(on: hostID))
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
                ReceiptRow(row: row, computer: model.computerName(row.target.hostId) ?? String(localized: "another computer", comment: "Stands in for a computer this iPhone has no name for"),
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
                Text(verbatim: row.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text(WatcherWords.action(row.action)).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                PlaceLine(providerID: row.provider, watched: watched,
                          text: String(localized: "\(AgentNames.name(row.provider)) on \(computer)", comment: "Where a thread runs. The first %@ is the provider's name, such as Claude Code; the second is the computer's name"))
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
        var words = String(localized: "\(row.title), \(WatcherWords.action(row.action)), \(AgentNames.name(row.provider)) on \(computer)",
                           comment: "For VoiceOver. The first %@ is a thread's title, the second what Watcher did, such as Started, the third the provider's name, the fourth the computer's name")
            + WatchedWords.spoken(watched)
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
        let quoted: Text = Text("“\(reason)”", comment: "%@ is Watcher's reason in its own words, in quotation marks")
            .font(.sotto(.small)).foregroundStyle(theme.color(.ink))
        let said: Text = Text("Its reason: \(quoted)", comment: "%@ is Watcher's reason, already in quotation marks")
            .font(.sotto(.small)).foregroundStyle(theme.color(.muted))
        return head + said
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
                    let unnamed = count - change.files.count
                    (unnamed == 1 ? Text("and 1 file more") : Text("and \(unnamed) files more")).font(.sotto(.small)).foregroundStyle(Palette.muted)
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
    @State private var answered = 0

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
        .sensoryFeedback(.impact(flexibility: .soft), trigger: answered)
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
    private var tag: String {
        isPermission ? String(localized: "Permission", comment: "The tag on a card asking for permission")
            : String(localized: "Question", comment: "The tag on a card asking a question")
    }
    private var ask: String { isPermission ? request.text : (request.questions?.first?.question ?? request.text) }
    private var computer: String { model.name(hostID) }
    /// "Claude Code on Laptop": the thread's provider and computer.
    private var whereItRuns: String {
        let computer = model.computerName(card.target.hostId) ?? String(localized: "another computer", comment: "Stands in for a computer this iPhone has no name for")
        return String(localized: "\(AgentNames.name(card.provider)) on \(computer)", comment: "Where a thread runs. The first %@ is the provider's name, such as Claude Code; the second is the computer's name")
    }
    private var reviewWords: String { isPermission ? String(localized: "Review permission") : String(localized: "Review question") }
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
        answered += 1
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
                    Text(verbatim: card.title)
                }
            }
            .font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, Space.s2)
            PlaceLine(providerID: card.provider, watched: !own && model.watchedByWatcher(card.target.ref), text: whereItRuns)
                .padding(.top, Space.s1)
            Text(verbatim: ask).font(.sotto(.body)).foregroundStyle(Palette.ink).lineLimit(4)
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
                    .paragraphDirection()
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
                        .paragraphDirection()
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
                note(String(localized: "Answer this one in Sotto on \(model.name(place.hostID)).", comment: "%@ is the computer's name"), reviews: false)
            } else if !model.mayAnswer(at: place) {
                note(String(localized: "This iPhone can’t answer on \(model.name(place.hostID)) yet.", comment: "%@ is the computer's name"), reviews: true)
            } else if !card.connected {
                let elsewhere = model.computerName(card.target.hostId) ?? computer
                note(String(localized: "\(AgentNames.name(card.provider)) isn’t connected on \(elsewhere). Answer once it’s back.",
                            comment: "The first %@ is the provider's name, such as Claude Code; the second is the computer's name"), reviews: false)
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
                    .paragraphDirection()
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
            Button(request.questions?.first?.allowFreeText == true ? String(localized: "Write your own") : reviewWords, action: openReview)
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
        return (request.permissionChoices?.count ?? 0) > shown ? String(localized: "More choices")
            : String(localized: "Details", comment: "Opens the whole request")
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
    @State private var sent = 0
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: Space.s2) {
            banner
            if let held = model.watcherSendHeld(hostID) {
                Text(held).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .paragraphDirection()
                    .padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
                    .glass(in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                    .accessibilityIdentifier("watcher-send-held")
            }
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
                        .paragraphDirection()
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
        let box = PhotoBox.watcher(hostID: hostID)
        let photos = model.photos(box), files = model.files(box)
        // Locked from the press of a message with photos or files until Watcher answers, so nothing typed meanwhile joins it.
        let preparing = model.preparingSends.contains(box.id)
        let shape = RoundedRectangle(cornerRadius: photos.isEmpty && files.isEmpty ? 26 : 22, style: .continuous)
        let working = model.watcherPage(hostID)?.working == true
        let canSend = model.canSendToWatcher(hostID)
        // While Watcher's turn runs on a computer that takes it, Send steers into that turn, or queues when its provider
        // takes no steer (#1229, pick B); otherwise it sends as before.
        let current = model.watcherPage(hostID)?.current
        let steering = model.offersWatcherSteer(hostID) && current?.status == "running"
        let queueing = steering && current?.steers == false
        let symbol = queueing ? "text.badge.plus" : steering ? "arrow.turn.up.right" : "arrow.up"
        let label = queueing ? String(localized: "Queue for after this turn") : steering ? String(localized: "Steer into Watcher’s turn") : String(localized: "Send to Watcher")
        return HStack(alignment: .bottom, spacing: Space.s2) {
            AttachPhotosButton(box: box)
            // Photos wait inside the box, above the words, and files under them as pills, as in a thread's reply box.
            VStack(alignment: .leading, spacing: Space.s2) {
                if !photos.isEmpty { DraftPhotoStrip(box: box).padding(.top, Space.s1) }
                if !files.isEmpty { DraftFilePills(box: box).padding(.top, photos.isEmpty ? Space.s1 : 0) }
                if let notice = model.photoNotices[box.id] {
                    Text(notice).font(.sotto(.small)).foregroundStyle(Palette.dangerText).fixedSize(horizontal: false, vertical: true)
                        .paragraphDirection()
                        .accessibilityAddTraits(.updatesFrequently)
                }
                TextField("Ask Watcher", text: draft, prompt: (working ? Text("Ask Watcher while it works") : Text("Ask Watcher")).foregroundStyle(Palette.placeholder), axis: .vertical)
                    .font(.sotto(.body))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1...6)
                    .focused($focused)
                    // Words added from a reply put the caret after them, here (ADR-0129).
                    .onChange(of: draftStore.focus) { _, focus in if focus?.key == model.watcherDraftKey(hostID) { focused = true } }
                    .padding(.vertical, 11)
                    .accessibilityLabel("Ask Watcher")
                    .accessibilityIdentifier("watcher-reply")
                    .pasteAttaches(to: box)
                    .onChange(of: model.focusRequest, initial: true) { if model.focusRequest == box.id { model.focusRequest = nil; focused = true } }
                    .disabled(preparing)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Sending puts the keyboard away, as the design does, so Watcher's answer has room on a small phone.
            Button { sent += 1; willSend(); focused = false; Task { await model.sendToWatcher(hostID) } } label: {
                Group {
                    if preparing { ProgressView().tint(Palette.onAccent) }
                    else { Image(systemName: symbol).font(.system(size: 17, weight: .semibold)) }
                }
                .frame(width: 44, height: 44)
                .foregroundStyle(canSend || preparing ? Palette.onAccent : Palette.muted)
                .background(canSend || preparing ? Palette.accent : Palette.fillSoft, in: Circle())
                .contentShape(Circle())
            }
            .buttonStyle(PressStyle())
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: canSend)
            .sensoryFeedback(.impact(flexibility: .soft), trigger: sent)
            .disabled(!canSend)
            .accessibilityLabel(preparing ? String(localized: "watcher-send.sending", defaultValue: "Sending to Watcher", comment: "The send button's name while a message is on its way to Watcher") : label)
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

/// Watcher's permissions in its hero, under its model and computer (#1276, pick A): a chip in this iPhone's own words,
/// after the Threads composer's, that opens the four modes. A choice shows at once; until Watcher's provider confirms
/// it, the chip's edge is dashed and the words beside it say what is still in force. A computer that refuses says why
/// in its own words. It left the box so the conversation has the room, and so it no longer comes and goes as the box is
/// written in.
private struct WatcherPermissionChip: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    @State private var choosing = false
    @State private var picks = 0
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
                picks += 1
                choosing = false
                Task { await model.setWatcherPermission(mode, on: hostID) }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sensoryFeedback(.selection, trigger: picks)
    }

    private func chip(pending: Bool, fixed: Bool) -> some View {
        let mode = model.watcherPermission(hostID)
        let busy = model.watcherManaging.contains(AppModel.permissionKey(hostID))
        let edge = StrokeStyle(lineWidth: 1, dash: pending ? [4, 3] : [])
        return Button { choosing = true } label: {
            HStack(spacing: 6) {
                if busy { ProgressView().controlSize(.mini) } else {
                    Image(systemName: "shield").font(.system(size: 13, weight: .semibold)).accessibilityHidden(true)
                }
                Text(WatcherPermissions.name(mode)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).accessibilityHidden(true)
            }
            .font(.sotto(.small, .semibold))
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, Space.s4)
            .frame(minHeight: 44)
            .background(Palette.fillSoft, in: Capsule())
            .overlay(Capsule().strokeBorder(pending ? Palette.accent.opacity(0.7) : Palette.hairline, style: edge))
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .disabled(!model.canChangeWatcherPermission(hostID))
        .accessibilityLabel("Watcher’s permissions")
        .accessibilityValue(WatcherPermissions.name(mode))
        .accessibilityHint(fixed ? WatcherPermissions.fixedHint : String(localized: "Opens what Watcher may do without asking"))
        .opacity(fixed ? 0.55 : 1)
        .accessibilityIdentifier("watcher-permissions")
    }

    @ViewBuilder private func captionText(_ caption: String?) -> some View {
        if let caption {
            Text(caption).font(.sotto(.caption)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                .paragraphDirection()
                .accessibilityIdentifier("watcher-permissions-in-force")
        }
    }

    /// Beside the chip while Watcher works; the chip's hint says when it can change.
    @ViewBuilder private func fixedText(_ shown: Bool) -> some View {
        if shown {
            Text(WatcherPermissions.fixed).font(.sotto(.caption)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                .paragraphDirection()
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
                    Text(WatcherPermissions.title).font(.sotto(.title, .bold)).headingTracking(-0.4).foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    Text(provider.map { String(localized: "Watcher on \(computer), on \($0)", comment: "The first %@ is the computer's name; the second is Watcher's provider, such as Codex") }
                         ?? String(localized: "Watcher on \(computer)", comment: "%@ is the computer's name"))
                        .font(.sotto(.small)).foregroundStyle(Palette.muted)
                }
                if !model.mayAnswer(hostID) {
                    Text(WatcherPermissions.asksOnly(computer)).font(.sotto(.small)).foregroundStyle(Palette.warningText)
                        .fixedSize(horizontal: false, vertical: true)
                        .paragraphDirection()
                        .accessibilityIdentifier("watcher-permissions-asks-only")
                }
                VStack(spacing: Space.s2) {
                    ForEach(model.watcherPermissionModes(hostID), id: \.self) { mode in
                        option(mode, provider: provider ?? String(localized: "The provider", comment: "Stands in for the provider's name at the start of a sentence"), computer: computer)
                    }
                }
                .padding(.top, Space.s1)
                Text(WatcherPermissions.foot).font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .paragraphDirection()
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
                        .paragraphDirection()
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

/// How Watched's page moves, kept outside SwiftUI's state so scrolling never redraws it: which way the user moves it, for
/// the bar (#1278).
private final class WatchedMotion {
    /// The page's visible part: the bottom of the bar, and the height down to the tab bar.
    struct Room: Equatable {
        var top: CGFloat = 0
        var height: CGFloat = 0
    }
    var room = Room()
    var height: CGFloat = 0
    var slide = WatcherBarSlide()
    /// The user is dragging the page or letting a flick run out, on iOS 18 and later.
    var userScrolling = false
    /// Until when the page moves for the app, going to the top. iOS 17 can't say when the user moves the page, so there
    /// a move outside this time is theirs.
    var quietUntil = Date.distantPast
    func quiet() { quietUntil = Date().addingTimeInterval(0.6) }
    var userMoved: Bool { WatcherFollow.seesLetGo ? userScrolling : Date() >= quietUntil }
}

/// The threads Watcher works with: on a computer whose watches last until the user stops them, what watching means,
/// Watch a thread and Stop all, then each thread as a card that opens it, with what Watcher last did and Stop watching;
/// on an older one, how many of how many it may, Stop all and the cards. Then the ones it no longer watches.
private struct WatchedPane: View {
    @EnvironmentObject var model: AppModel
    /// Watched for Watcher's page, which publishes on its own store, not on the model.
    @EnvironmentObject var watcherStore: WatcherStore
    let hostID: String
    /// Presses on the bar's owl: each one scrolls the page to its top, to Watcher's hero.
    let toTop: Int
    /// Slides the bar away, or back, as the user reads down or goes up.
    let slideBar: (Bool) -> Void
    let stopAll: () -> Void
    @State private var stopPresses = 0
    @State private var picking = false
    @State private var motion = WatchedMotion()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ScrollViewReader { proxy in
            list
                .onUserScrolling { motion.userScrolling = $0 }
                .background(GeometryReader { page in
                    let frame = page.frame(in: .global)
                    let room = WatchedMotion.Room(top: frame.minY + page.safeAreaInsets.top,
                                                  height: frame.height - page.safeAreaInsets.top - page.safeAreaInsets.bottom)
                    Color.clear
                        .onAppear { motion.room = room }
                        .onChange(of: room) { _, value in motion.room = value }
                })
                .onChange(of: toTop) { _, _ in
                    motion.quiet()
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.35)) { proxy.scrollTo(WatcherHero.id, anchor: .top) }
                }
                // A card waiting on the user in the conversation keeps the bar here too, and brings it back if it was
                // away when the card arrived (#1288).
                .onChange(of: cardWaits, initial: true) { _, waits in if waits { slideBar(false) } }
        }
    }
    /// Whether a card waits on the user in Watcher's conversation, which keeps the bar where it is.
    private var cardWaits: Bool { model.watcherPage(hostID)?.needsYou.isEmpty == false }
    /// Where Watched's page has scrolled, from its content's frame, for the bar.
    private func moved(_ frame: CGRect) {
        let resized = abs(frame.height - motion.height) > 0.5
        motion.height = frame.height
        let offset = min(motion.room.top - frame.minY, max(0, frame.height - motion.room.height))
        if let away = motion.slide.moved(to: offset, counts: !resized && motion.userMoved, pinned: cardWaits) { slideBar(away) }
    }
    private var list: some View {
        let page = model.watcherPage(hostID)
        let manages = model.offersWatcherManage(hostID)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                WatcherHero(hostID: hostID).padding(.top, Space.s4)
                FeedbackBanner().padding(.top, Space.s3)
                if let page {
                    if manages { lead(page).padding(.top, Space.s4) } else { meterRow(page).padding(.top, Space.s4) }
                    if page.watched.isEmpty {
                        if !manages {
                            Text("Watcher isn’t working with any threads now.").font(.sotto(.body)).foregroundStyle(Palette.muted)
                                .fixedSize(horizontal: false, vertical: true).paragraphDirection().padding(.vertical, Space.s6)
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
                            .fixedSize(horizontal: false, vertical: true).paragraphDirection().padding(.top, Space.s3)
                    }
                    if !page.noLongerWatched.isEmpty {
                        SectionHeading(String(localized: "No longer watched", comment: "A heading over the threads Watcher no longer watches"), count: page.noLongerWatched.count)
                        VStack(spacing: 0) {
                            ForEach(Array(page.noLongerWatched.enumerated()), id: \.element.target.ref.id) { index, thread in
                                if index > 0 { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4 + 20) }
                                LeftRow(thread: thread, computer: computer(thread), listed: model.thread(thread.target.ref) != nil)
                            }
                        }
                        .sottoCard(.plain)
                    }
                } else {
                    Text(model.online(hostID) ? model.watcherReadProblems[hostID] ?? String(localized: "Reading Watcher on \(model.name(hostID))…", comment: "%@ is the computer's name")
                         : String(localized: "Reconnect to \(model.name(hostID)) to read Watcher.", comment: "%@ is the computer's name"))
                        .font(.sotto(.body)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, Space.s7)
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.s8)
            .readingWidth()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GeometryReader { content in
                Color.clear
                    .onAppear { moved(content.frame(in: .global)) }
                    .onChange(of: content.frame(in: .global)) { _, frame in moved(frame) }
            })
            // Once for the page, not once for each layout ViewThatFits builds, so one press plays one tap.
            .sensoryFeedback(.impact(weight: .medium), trigger: stopPresses)
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
        model.computerName(thread.target.hostId) ?? String(localized: "another computer", comment: "Stands in for a computer this iPhone has no name for")
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
                .paragraphDirection()
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
            Button { stopPresses += 1; stopAll() } label: {
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
    @State private var stops = 0
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
    private var running: Bool { WatcherWords.working(thread) }
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
            Text(verbatim: thread.title).font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s2)
            PlaceLine(providerID: thread.provider, watched: true,
                      text: String(localized: "\(AgentNames.name(thread.provider)) on \(computer)", comment: "Where a thread runs. The first %@ is the provider's name, such as Claude Code; the second is the computer's name"))
                .padding(.top, Space.s1)
            if let doing {
                Text(doing).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .paragraphDirection()
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
            Button {
                stops += 1
                stop()
            } label: {
                HStack(spacing: 6) {
                    if stopping { ProgressView().controlSize(.mini) }
                    Text("Stop watching")
                }
            }
            .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
            .sensoryFeedback(.impact(weight: .medium), trigger: stops)
            .disabled(!canStop)
            .accessibilityLabel("Stop watching \(thread.title)")
            .accessibilityIdentifier("watched-stop-\(thread.target.ref.id)")
        }
        .padding(.horizontal, Space.s4)
        .padding(.bottom, Space.s3)
    }
    private var spoken: String {
        var words = String(localized: "\(thread.title), \(WatcherWords.status(thread)), \(AgentNames.name(thread.provider)) on \(computer)",
                           comment: "For VoiceOver. The first %@ is a thread's title, the second its state, such as Working, the third the provider's name, the fourth the computer's name")
            + WatchedWords.spoken(true)
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
                    Text("Watch a thread").font(.sotto(.title, .bold)).headingTracking(-0.4).foregroundStyle(Palette.ink)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: Space.s2)
                    Button("Cancel") { dismiss() }
                        .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                        .keyboardShortcut(.cancelAction)
                }
                Text("Watcher on \(model.name(hostID)) keeps it going and brings you its questions and permissions, until you stop it.", comment: "%@ is the computer's name")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .paragraphDirection()
                if rows.isEmpty {
                    Text("Every thread this iPhone can reach is watched already, or settled.").font(.sotto(.body)).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true).paragraphDirection().padding(.vertical, Space.s6)
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
                        .paragraphDirection()
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
                Text(verbatim: thread.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                PlaceLine(providerID: thread.provider, watched: false,
                          text: WatcherWords.left(thread) + " · " + String(localized: "\(AgentNames.name(thread.provider)) on \(computer)", comment: "Where a thread runs. The first %@ is the provider's name, such as Claude Code; the second is the computer's name"))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.s4)
        .padding(.vertical, Space.s3 + 2)
        .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
        .contentShape(Rectangle())
    }
    private var spoken: String {
        String(localized: "\(thread.title), \(WatcherWords.left(thread)), \(AgentNames.name(thread.provider)) on \(computer)",
               comment: "For VoiceOver. The first %@ is a thread's title, the second why Watcher no longer watches it, the third the provider's name, the fourth the computer's name")
    }
}
