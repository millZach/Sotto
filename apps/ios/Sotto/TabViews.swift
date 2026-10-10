import SwiftUI
import SottoCore

// MARK: - Terminal-mode rows and approval cards

/// Uses the existing Glow Permission surface. The screen excerpt explains this one hook request;
/// it is neither a terminal stream nor an input surface.
private struct TerminalRequestCard: View, Equatable {
    @EnvironmentObject var model: AppModel
    let row: HostedTerminal
    var inFlight = false
    var retained = false
    var detail = false
    let send: (TerminalDecision) -> Void
    @State private var more = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    static func == (left: Self, right: Self) -> Bool {
        left.row.ref == right.row.ref && left.row.terminal == right.row.terminal && left.row.computer == right.row.computer
            && left.row.status == right.row.status && left.inFlight == right.inFlight && left.retained == right.retained && left.detail == right.detail
    }
    private enum Phase: Equatable { case idle, sending, answered, gone, unconfirmed }
    private var phase: Phase {
        if inFlight { return .sending }
        if let marker = model.terminalPending(row.ref) { return model.isSending(marker) ? .sending : .unconfirmed }
        if let approval = row.terminal.approval, model.terminalAnswerConfirmed(approval, in: row.ref) { return .answered }
        if retained && model.terminal(row.ref)?.approval?.id != row.terminal.approval?.id { return .gone }
        return .idle
    }
    private var preview: TerminalApprovalPreview? {
        guard let value = model.terminalPreviews[row.id], value.matches(row.terminal) else { return nil }
        return value
    }
    private var previewTaskID: String {
        row.id + "/" + (row.terminal.approval?.id ?? "screen-only") + "/" + (row.terminal.approval?.previewId ?? "no-fingerprint")
            + "/" + String(model.online(row.ref.hostID))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if detail { summary }
            else {
                NavigationLink(value: TerminalRoute(ref: row.ref)) { summary }
                    .buttonStyle(PressStyle())
                    .accessibilityLabel("\(row.terminal.title), \(row.terminal.hasAnswerChannel ? "Permission" : "Needs you"), terminal on \(row.computer)")
                    .accessibilityHint("Opens the terminal's state")
                    .accessibilityIdentifier("terminal-\(row.id)")
            }
            if let preview, phase == .idle {
                Text(preview.lines.joined(separator: "\n"))
                    .font(.mono).foregroundStyle(Palette.codeInk)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Space.s3).padding(.vertical, Space.s2)
                    .background(Palette.code, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
                    .padding(.horizontal, Space.s4).padding(.bottom, Space.s2)
                    .accessibilityLabel("The end of the terminal's screen. " + preview.lines.joined(separator: "\n"))
                    .accessibilityIdentifier("terminal-approval-preview")
            }
            actions.padding(.horizontal, Space.s4).padding(.bottom, Space.s3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sottoCard(phase == .answered ? .answered : .needsYou)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .easeInOut(duration: 0.4), value: phase)
        .task(id: previewTaskID) { await model.readTerminalApproval(row.ref) }
        .alert("More choices", isPresented: $more) {
            Button("Done", role: .cancel) {}
        } message: {
            Text("Review this permission in the terminal on \(row.computer). Choices that change future permissions stay on the computer.")
        }
    }
    private var summary: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s2) {
                Light(tone: phase == .answered ? .accent : .warning)
                Text(row.terminal.hasAnswerChannel ? "Permission" : "Needs you")
                    .font(.sotto(.caption, .semibold)).foregroundStyle(phase == .answered ? Palette.accentText : Palette.warningText)
                Label("Terminal", systemImage: "terminal").font(.sotto(.caption)).foregroundStyle(Palette.muted)
                Spacer(minLength: 0)
            }
            Text(row.terminal.title).font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text("\(Words.terminalProvider(row.terminal.providerId)) on \(row.computer)")
                .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, Space.s4).padding(.top, Space.s4).padding(.bottom, Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
    @ViewBuilder private var actions: some View {
        switch phase {
        case .sending:
            HStack(spacing: Space.s2) { Spacer(minLength: 0); ProgressView().controlSize(.small); Text("Sending…") }
                .font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted).frame(minHeight: 44)
                .accessibilityElement(children: .combine)
        case .answered:
            HStack(spacing: Space.s2) { Spacer(minLength: 0); Image(systemName: "checkmark").accessibilityHidden(true); Text("Answered") }
                .font(.sotto(.small, .semibold)).foregroundStyle(Palette.accentText).frame(minHeight: 44)
                .accessibilityElement(children: .combine)
        case .gone:
            Text("No longer waiting").font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted).frame(minHeight: 44)
        case .unconfirmed:
            VStack(alignment: .leading, spacing: Space.s2) {
                review("Not confirmed yet. Check the terminal on \(row.computer) before answering again.")
                Button("Check again") { Task { await model.checkDelivery(row.ref.hostID) } }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                    .disabled(!model.online(row.ref.hostID))
                    .accessibilityHint("Checks this answer's receipt without sending the answer again")
            }
        case .idle:
            idleActions
        }
    }
    @ViewBuilder private var idleActions: some View {
        if !row.terminal.hasAnswerChannel {
            review("Answer this one in the terminal on \(row.computer).")
        } else if !model.mayAnswer(row.ref.hostID) {
            review("This iPhone can’t answer on \(row.computer) yet.")
        } else if !model.online(row.ref.hostID) {
            review("Reconnect to \(row.computer) to review this permission.")
        } else if preview != nil {
            VStack(alignment: .leading, spacing: Space.s2) {
                HStack(spacing: Space.s2) {
                    Button { send(.deny) } label: { Text("No").frame(maxWidth: .infinity) }
                        .buttonStyle(PillButtonStyle(kind: .soft, wide: true))
                        .accessibilityIdentifier("terminal-answer-no")
                    Button { send(.allow) } label: { Text("Yes").frame(maxWidth: .infinity) }
                        .buttonStyle(PillButtonStyle(kind: .primary, wide: true))
                        .accessibilityIdentifier("terminal-answer-yes")
                }
                .frame(maxWidth: .infinity)
                .disabled(!model.canAnswerTerminal(row.ref, approval: row.terminal.approval))
                Button("More choices") { more = true }.buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                    .frame(maxWidth: .infinity)
            }
        } else if model.readingTerminalPreviews.contains(row.id) {
            HStack(spacing: Space.s2) { ProgressView().controlSize(.small); Text("Reading permission…") }
                .font(.sotto(.small)).foregroundStyle(Palette.muted).frame(minHeight: 44)
        } else {
            VStack(alignment: .leading, spacing: Space.s2) {
                Text(model.terminalPreviewProblems[row.id] ?? "Read the current permission before answering.")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                Button("Refresh permission") { Task { await model.readTerminalApproval(row.ref, force: true) } }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                    .disabled(!model.online(row.ref.hostID))
            }
        }
    }
    private func review(_ note: String) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Text(note).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            if detail {
                Text(!model.mayAnswer(row.ref.hostID) && row.terminal.hasAnswerChannel
                    ? "On \(row.computer), open Settings > Phones and turn on Can answer for this iPhone."
                    : "Open this terminal on \(row.computer) to review and answer it.")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                NavigationLink(value: TerminalRoute(ref: row.ref)) { Text(row.terminal.hasAnswerChannel ? "Review permission" : "Review on computer") }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
            }
        }
    }
}

private struct TerminalWorkingCard: View {
    let row: HostedTerminal
    var body: some View {
        NavigationLink(value: TerminalRoute(ref: row.ref)) {
            VStack(alignment: .leading, spacing: Space.s2) {
                HStack(spacing: Space.s2) {
                    Light(tone: .accent, breathing: true)
                    Text(row.terminal.stateWords).font(.sotto(.caption, .semibold)).foregroundStyle(Palette.accentText)
                    Label("Terminal", systemImage: "terminal").font(.sotto(.caption)).foregroundStyle(Palette.muted)
                }
                Text(row.terminal.title).font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(Words.terminalProvider(row.terminal.providerId)) on \(row.computer)").font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(Space.s4).frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { Runner() }.sottoCard(.working).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle()).accessibilityIdentifier("terminal-\(row.id)")
        .accessibilityLabel("\(row.terminal.title), \(row.terminal.stateWords), terminal on \(row.computer)")
    }
}

private struct TerminalRow: View {
    @EnvironmentObject var model: AppModel
    let row: HostedTerminal
    private var unread: Bool { row.finishedUnread && model.selectedTerminal != row.ref }
    private var state: String { unread ? "Just finished" : row.terminal.state == .justFinished ? "Idle" : row.terminal.stateWords }
    var body: some View {
        NavigationLink(value: TerminalRoute(ref: row.ref)) {
            HStack(alignment: .top, spacing: Space.s3) {
                Light(tone: unread ? .accent : .off).padding(.top, 6)
                VStack(alignment: .leading, spacing: Space.s1) {
                    Label(row.terminal.title, systemImage: "terminal").font(.sotto(.body, unread ? .bold : .semibold)).foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(row.reachable ? state : row.status.words) · \(Words.terminalProvider(row.terminal.providerId)) on \(row.computer)")
                        .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(PressStyle()).accessibilityIdentifier("terminal-\(row.id)")
        .accessibilityLabel("\(row.terminal.title), \(row.reachable ? state : row.status.words), terminal on \(row.computer)")
    }
}

/// Small state view, with the same approval card when needed. Showing this view clears Just finished
/// through the host's visibility set, for both devices. There is no shell input or screen history.
struct TerminalView: View {
    @EnvironmentObject var model: AppModel
    let ref: TerminalRef
    @State private var sending = false
    @State private var answeredRow: HostedTerminal?
    @State private var leaving = false
    private var row: HostedTerminal? { model.terminalRows.first { $0.ref == ref } }
    var body: some View {
        SheetPage(warm: row?.terminal.state == .needsYou) {
            if let row {
                PageHeading(row.terminal.title, subtitle: "\(Words.terminalProvider(row.terminal.providerId)) on \(row.computer)") { Image(systemName: "terminal").foregroundStyle(Palette.muted) }
                HStack(spacing: Space.s2) {
                    Light(tone: row.reachable && row.terminal.state == .needsYou ? .warning : row.reachable && row.terminal.state.workInProgress ? .accent : .off,
                          breathing: row.reachable && row.terminal.state.workInProgress)
                    Text(row.reachable ? (row.terminal.state == .justFinished ? "Idle" : row.terminal.stateWords) : row.status.words)
                        .font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
                }
                .padding(.top, Space.s2)
                FeedbackBanner().padding(.top, Space.s3)
                if row.terminal.providerId != nil && row.terminal.stateDetection != "available" {
                    Text("State detection is unavailable. Review this terminal on \(row.computer).")
                        .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true).padding(.top, Space.s4)
                }
                if row.terminal.state == .needsYou || answeredRow != nil {
                    TerminalRequestCard(row: answeredRow ?? row, inFlight: sending, retained: answeredRow != nil, detail: true) { decision in
                        guard let approval = row.terminal.approval else { return }
                        answeredRow = row; sending = true
                        Task { await model.answerTerminal(ref, approval: approval, decision: decision); sending = false; resolveAnswer() }
                    }
                    .equatable()
                    .padding(.top, Space.s4)
                } else {
                    Text("Open this terminal on \(row.computer) to read its screen or type into it.")
                        .font(.sotto(.body)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true).padding(.top, Space.s5)
                }
            } else {
                Text("This terminal is no longer shared. Review it on \(model.name(ref.hostID)).")
                    .font(.sotto(.body)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true).padding(.top, Space.s5)
            }
        }
        .navigationTitle("Terminal").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
        .task(id: ref) { await model.selectTerminal(ref) }
        .onDisappear { Task { if model.selectedTerminal == ref { await model.selectTerminal(nil) } } }
        .onChange(of: model.pending) { _, _ in resolveAnswer() }
        .onChange(of: model.live) { _, _ in resolveAnswer() }
    }
    private func resolveAnswer() {
        guard !sending, !leaving, let answeredRow, model.terminalPending(ref) == nil, let approval = answeredRow.terminal.approval else { return }
        if !model.terminalAnswerConfirmed(approval, in: ref), model.terminal(ref)?.approval?.id == approval.id { self.answeredRow = nil; return }
        leaving = true
        Task {
            try? await Task.sleep(nanoseconds: 900_000_000)
            self.answeredRow = nil; leaving = false
        }
    }
}

/// A request shown on a Needs you card: the thread, and the first request waiting in it.
private struct NeedsItem {
    let row: HostedThread
    let request: AgentRequest
}

/// An answer sent from a Needs you card. The card reads Sending, then Answered once the thread's computer confirms
/// the answer, or No longer waiting if the request left without that, before it leaves.
private struct CardAnswer {
    let requestID: String
    let busy: String
    let done: String
    /// Where the card stood in Needs you, so it keeps its place once its thread has moved on.
    let index: Int
    let row: HostedThread
    let request: AgentRequest
    /// Until the model has finished sending it.
    var inFlight = true
    var answered = false
    /// Whether the computer confirmed it. A request that left without that reads as no longer waiting instead.
    var confirmed = false
}

/// The search field's frame, kept outside SwiftUI's state so scrolling doesn't redraw the page.
private final class FrameBox {
    var frame: CGRect = .zero
}

/// Threads: questions and permissions first, answerable in place, then working threads, recent ones and the
/// settled shelf (ADR-0039, ADR-0051). The heading, the computer menu, the summary and search scroll with the
/// list as one sheet. Focus reads only host list summaries; opening a thread subscribes to its detail.
struct ThreadsView: View {
    @EnvironmentObject var model: AppModel
    var openCreated: (ThreadRef) -> Void = { _ in }
    @State private var creating = false
    @State private var query = ""
    @State private var settledExpanded = false
    @State private var sent: [String: CardAnswer] = [:]
    @State private var sentTerminals: [String: HostedTerminal] = [:]
    @State private var sendingTerminals: Set<String> = []
    @State private var leavingTerminals: Set<String> = []
    @State private var searchBox = FrameBox()
    @FocusState private var searching: Bool
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let groups = FocusThreads(model.lists, show: model.show, query: query, opened: model.selected)
        let unsearched = query.isEmpty ? groups : FocusThreads(model.lists, show: model.show, opened: model.selected)
        SheetPage(warm: unsearched.requestCount > 0 || terminalRows().contains { $0.reachable && $0.terminal.state == .needsYou }) {
            heading
            controls(unsearched)
            searchPill
            notices
            sections(groups)
        }
        // A tap anywhere outside the search field closes its keyboard; so does scrolling.
        .simultaneousGesture(SpatialTapGesture(coordinateSpace: .global).onEnded { tap in
            if searching && !searchBox.frame.contains(tap.location) { searching = false }
        })
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await model.refresh() }
        .navigationTitle("Threads")
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: model.pending) { _, _ in
            for id in Array(sent.keys) { resolve(id) }
            resolveTerminalCards()
        }
        .onChange(of: model.live) { _, _ in resolveTerminalCards() }
        .sheet(isPresented: $creating) { NewThreadSheet(opened: openCreated) }
    }

    // MARK: Top of the sheet

    private var heading: some View {
        PageHeading("Threads") {
            Button { creating = true } label: { Image(systemName: "plus") }
                .buttonStyle(GlassCircleStyle())
                .accessibilityLabel("New thread")
                .accessibilityIdentifier("new-thread")
        }
        .padding(.top, Space.s1)
    }

    private func controls(_ all: FocusThreads) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.s3) {
                ComputerMenu()
                Spacer(minLength: Space.s2)
                ThreadCounts(working: all.working.count + terminalRows().filter { $0.reachable && $0.terminal.state.workInProgress }.count,
                             needs: all.questions.count + terminalRows().filter { $0.reachable && $0.terminal.state == .needsYou }.count)
            }
            VStack(alignment: .leading, spacing: Space.s2) {
                ComputerMenu()
                ThreadCounts(working: all.working.count + terminalRows().filter { $0.reachable && $0.terminal.state.workInProgress }.count,
                             needs: all.questions.count + terminalRows().filter { $0.reachable && $0.terminal.state == .needsYou }.count)
            }
        }
        .padding(.top, Space.s3)
    }

    private var searchPill: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted).accessibilityHidden(true)
            TextField("Search threads and terminals", text: $query, prompt: Text("Search threads and terminals").foregroundStyle(Palette.placeholder))
                .focused($searching)
                .font(.sotto(.body))
                .foregroundStyle(Palette.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { searching = false }
                .accessibilityLabel("Search threads and terminals")
                .accessibilityIdentifier("thread-search")
            if !query.isEmpty {
                Button { query = ""; searching = true } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.muted)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, Space.s4)
        .padding(.trailing, query.isEmpty ? Space.s4 : Space.s1)
        .frame(minHeight: 46)
        .background(Palette.surface.opacity(0.7), in: Capsule())
        .overlay(Capsule().strokeBorder(searching ? Palette.accent.opacity(0.6) : Palette.hairline, lineWidth: 1))
        .background {
            // The focus ring: a soft accent halo just outside the field.
            Capsule().strokeBorder(theme.color(.accent).opacity(0.14), lineWidth: 4).padding(-4)
                .opacity(searching ? 1 : 0)
        }
        .animation(.easeInOut(duration: 0.3), value: searching)
        .background {
            GeometryReader { proxy in
                Color.clear
                    .onAppear { searchBox.frame = proxy.frame(in: .global) }
                    .onChange(of: proxy.frame(in: .global)) { _, frame in searchBox.frame = frame }
            }
        }
        .padding(.top, Space.s3)
    }

    /// What just went wrong, creations waiting on a computer, and computers that can't be reached.
    @ViewBuilder private var notices: some View {
        if model.feedback != nil { FeedbackBanner().padding(.top, Space.s4) }
        ForEach(model.pendingCreations.filter { model.show.admits($0.hostID) }) { operation in
            CreationPendingRow(operation: operation).padding(.top, Space.s3)
        }
        if query.isEmpty {
            ForEach(model.lists.filter { model.show.admits($0.hostID) && $0.status != .online }, id: \.hostID) { computer in
                connectionNote(computer)
            }
        }
    }

    private func connectionNote(_ computer: ComputerThreads) -> some View {
        let trying = computer.status == .connecting
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        return HStack(spacing: Space.s3) {
            Image(systemName: "desktopcomputer").foregroundStyle(Palette.muted).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(trying ? "Checking \(computer.name)…" : "Can’t reach \(computer.name).")
                    .font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                if !trying {
                    Text(model.supportsTerminals(computer.hostID) ? "Showing its last shared threads and terminals." : "Showing its last shared threads.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Space.s2)
            Button { Task { await model.connect(computer.hostID) } } label: {
                if trying {
                    HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Trying") }
                } else {
                    Text("Try again")
                }
            }
            .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
            .disabled(trying)
            .accessibilityLabel(trying ? "Trying to reach \(computer.name)" : "Try reaching \(computer.name) again")
        }
        .padding(.vertical, Space.s3).padding(.leading, Space.s4).padding(.trailing, Space.s3)
        .background {
            LinearGradient(colors: [trying ? theme.color(.surface) : theme.tinted(.surface, with: .danger, 0.09), theme.color(.surface)],
                           startPoint: .leading, endPoint: UnitPoint(x: 0.7, y: 0.5))
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
        .padding(.top, Space.s4)
    }

    // MARK: Sections

    @ViewBuilder private func sections(_ groups: FocusThreads) -> some View {
        let terminals = terminalRows(query: query)
        let terminalNeeds = terminalNeedsItems(terminals)
        let terminalWorking = terminals.filter { $0.reachable && $0.terminal.state.workInProgress && sentTerminals[$0.id] == nil }
        let terminalRecent = terminals.filter { (!$0.reachable || ($0.terminal.state != .needsYou && !$0.terminal.state.workInProgress)) && sentTerminals[$0.id] == nil }
        let needs = needsItems(groups)
        let departing = Set(needs.map { $0.row.id }).subtracting(groups.questions.map { $0.id })
        let working = groups.working.filter { !departing.contains($0.id) }
        let recent = groups.recent.filter { !departing.contains($0.id) }
        let settled = groups.settled.filter { !departing.contains($0.id) }
        let unread = Set((recent + settled).filter { groups.isUnreadFinish($0) }.map { $0.id })
        if needs.isEmpty && working.isEmpty && recent.isEmpty && settled.isEmpty && terminals.isEmpty && terminalNeeds.isEmpty {
            Text(groups.searching ? "No matching threads or terminals." : model.anyConnecting ? "Reading threads…" : "No threads or terminals here yet. Tap New thread to start one.")
                .font(.sotto(.body)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, Space.s7)
        }
        if !needs.isEmpty || !terminalNeeds.isEmpty {
            SectionHeading("Needs you", count: needs.count + terminalNeeds.count, light: .warning)
            VStack(spacing: Space.s3) {
                ForEach(terminalNeeds) { row in
                    TerminalRequestCard(row: row, inFlight: sendingTerminals.contains(row.id), retained: sentTerminals[row.id] != nil) { decision in
                        answerTerminal(row, decision: decision)
                    }
                    .equatable()
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.opacity.combined(with: .scale(scale: 0.96)))
                }
                ForEach(Array(needs.enumerated()), id: \.element.row.id) { index, item in
                    RequestCard(row: item.row, request: item.request, answer: sent[item.row.id]) { choice, busy, done in
                        answer(item, choice: choice, busy: busy, done: done, index: index)
                    }
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.opacity.combined(with: .scale(scale: 0.96)))
                }
            }
        }
        if !working.isEmpty || !terminalWorking.isEmpty {
            SectionHeading("Working now", count: working.count + terminalWorking.count, light: .accent)
            VStack(spacing: Space.s3) {
                ForEach(terminalWorking) { row in TerminalWorkingCard(row: row) }
                ForEach(working) { row in WorkingCard(row: row) }
            }
        }
        if !recent.isEmpty || !terminalRecent.isEmpty {
            SectionHeading("Recent", count: recent.count + terminalRecent.count)
            VStack(spacing: 0) {
                ForEach(terminalRecent) { row in
                    TerminalRow(row: row)
                    if row.id != terminalRecent.last?.id || !recent.isEmpty { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4 + 20) }
                }
                ForEach(Array(recent.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4 + 20) }
                    ThreadRow(row: row, unread: unread.contains(row.id))
                }
            }
            .sottoCard(.plain)
        }
        if !settled.isEmpty {
            if groups.searching {
                SectionHeading("Settled", count: settled.count)
            } else {
                settledToggle(settled.count)
            }
            if settledExpanded || groups.searching {
                ThreadRowList(rows: settled, unread: unread)
            }
        }
    }

    private func settledToggle(_ count: Int) -> some View {
        Button { settledExpanded.toggle() } label: {
            HStack(spacing: Space.s2) {
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                    .rotationEffect(.degrees(settledExpanded ? 90 : 0))
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: settledExpanded)
                Text("Settled")
                Spacer()
                Text("\(count)").fontWeight(.regular)
            }
            .font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
            .padding(.horizontal, Space.s1)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .padding(.top, Space.s6)
        .accessibilityIdentifier("settled-threads")
        .accessibilityLabel(settledExpanded ? "Hide settled threads" : "Show settled threads")
        .accessibilityValue("\(count) threads, \(settledExpanded ? "expanded" : "collapsed")")
    }

    /// The live requests, with any card that was just answered here kept in its place until it leaves.
    private func needsItems(_ groups: FocusThreads) -> [NeedsItem] {
        var items: [NeedsItem] = groups.questions.compactMap { row in
            guard let request = row.thread.requests.first else { return nil }
            return NeedsItem(row: row, request: request)
        }
        let live = Set(items.map { $0.row.id })
        let leaving = sent.values.filter { !live.contains($0.row.id) && model.show.admits($0.row.ref.hostID) }.sorted { $0.index < $1.index }
        for answer in leaving {
            items.insert(NeedsItem(row: answer.row, request: answer.request), at: min(answer.index, items.count))
        }
        return items
    }

    private func terminalRows(query: String = "") -> [HostedTerminal] { Terminals.filtered(model.terminalRows, show: model.show, query: query) }
    private func terminalNeedsItems(_ rows: [HostedTerminal]) -> [HostedTerminal] {
        var items = rows.filter { $0.reachable && $0.terminal.state == .needsYou }
        for row in sentTerminals.values.filter({ model.show.admits($0.ref.hostID) }).sorted(by: { $0.terminal.openedAt > $1.terminal.openedAt }) {
            if let index = items.firstIndex(where: { $0.id == row.id }) { items[index] = row }
            else { items.append(row) }
        }
        return items
    }
    private func answerTerminal(_ row: HostedTerminal, decision: TerminalDecision) {
        guard let approval = row.terminal.approval else { return }
        sentTerminals[row.id] = row; sendingTerminals.insert(row.id)
        Task {
            await model.answerTerminal(row.ref, approval: approval, decision: decision)
            sendingTerminals.remove(row.id)
            resolveTerminalCards()
        }
    }
    private func resolveTerminalCards() {
        for (id, row) in sentTerminals {
            guard !sendingTerminals.contains(id), !leavingTerminals.contains(id), model.terminalPending(row.ref) == nil,
                  let approval = row.terminal.approval else { continue }
            if !model.terminalAnswerConfirmed(approval, in: row.ref), model.terminal(row.ref)?.approval?.id == approval.id {
                sentTerminals[id] = nil
                continue
            }
            leavingTerminals.insert(id)
            Task {
                try? await Task.sleep(nanoseconds: 900_000_000)
                withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : .easeInOut(duration: 0.42)) {
                    sentTerminals[id] = nil; leavingTerminals.remove(id)
                }
            }
        }
    }

    // MARK: Answering in place

    /// Sends a card's answer through the model's own answer path, which checks this iPhone may answer there and
    /// keeps a marker until the computer confirms it.
    private func answer(_ item: NeedsItem, choice: String, busy: String, done: String, index: Int) {
        let id = item.row.id
        sent[id] = CardAnswer(requestID: item.request.id, busy: busy, done: done, index: index, row: item.row, request: item.request)
        Task {
            await model.answer(item.request, in: item.row.ref, choice: choice)
            sent[id]?.inFlight = false
            resolve(id)
        }
    }

    /// Settles a card once the model has finished with its answer. Confirmed, it reads Answered for a moment and
    /// leaves; gone without confirmation, it reads No longer waiting and leaves; refused, it returns to its choices and the banner says why. While the
    /// computer hasn't confirmed it, the card says so and waits.
    private func resolve(_ id: String) {
        guard let answer = sent[id], !answer.inFlight, !answer.answered else { return }
        let ref = answer.row.ref
        if model.pending(for: ref).contains(where: { $0.kind == "answer" && $0.requestID == answer.requestID }) { return }
        let waiting = model.thread(ref)?.requests.contains(where: { $0.id == answer.requestID }) ?? false
        if waiting {
            sent[id] = nil
            return
        }
        let confirmed = model.answerConfirmed(answer.requestID, in: ref)
        withAnimation(.easeInOut(duration: 0.4)) { sent[id]?.answered = true; sent[id]?.confirmed = confirmed }
        Task {
            try? await Task.sleep(nanoseconds: 900_000_000)
            withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : .easeInOut(duration: 0.42)) { sent[id] = nil }
        }
    }
}

// MARK: - The computer menu and the summary

private struct ComputerMenu: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        Menu {
            Picker("Computer", selection: $model.show) {
                Text("All computers").tag(ComputerFilter.all)
                ForEach(model.computers, id: \.hostID) { computer in
                    Text("\(computer.name) · \(model.status(computer.hostID).words)").tag(ComputerFilter.only(computer.hostID))
                }
            }
        } label: {
            HStack(spacing: Space.s2) {
                if case .only(let id) = model.show { ComputerDot(status: model.status(id)) } else { Light(tone: .accent) }
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
            }
            .font(.sotto(.small, .semibold))
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, Space.s3)
            .frame(minHeight: 44)
            .background(Palette.fillSoft, in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
            .contentShape(Capsule())
        }
        .accessibilityLabel("Choose a computer")
        .accessibilityValue(title)
        .accessibilityIdentifier("computer-filter")
    }
    private var title: String {
        if case .only(let id) = model.show { return model.name(id) }
        return "All computers"
    }
}

/// How many threads are working and how many requests need the user, beside the computer menu.
private struct ThreadCounts: View {
    let working: Int
    let needs: Int
    var body: some View {
        HStack(spacing: Space.s4) {
            HStack(spacing: Space.s2) {
                Light(tone: working > 0 ? .accent : .off, breathing: working > 0)
                HStack(spacing: 4) {
                    Text("\(working)").font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                    Text("working")
                }
            }
            HStack(spacing: Space.s2) {
                Light(tone: needs > 0 ? .warning : .off)
                HStack(spacing: 4) {
                    Text("\(needs)").font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                    Text(needs == 1 ? "needs you" : "need you")
                }
            }
        }
        .font(.sotto(.small))
        .foregroundStyle(Palette.muted)
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(working) working, \(needs) \(needs == 1 ? "needs" : "need") you")
        .accessibilityIdentifier("thread-counts")
    }
}

// MARK: - Needs you

/// A question or permission waiting on the user, warm with its glow. One-tap answers are made here: a chip
/// and Send answer, or Deny and Allow once. Anything more opens the thread, where the full sheet waits.
private struct RequestCard: View {
    @EnvironmentObject var model: AppModel
    let row: HostedThread
    let request: AgentRequest
    let answer: CardAnswer?
    let send: (_ choice: String, _ busy: String, _ done: String) -> Void
    @State private var picked: String?

    enum Phase: Equatable { case idle, sending, answered, unconfirmed }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NavigationLink(value: ThreadRoute(ref: row.ref)) { summary }
                .buttonStyle(PressStyle())
                .accessibilityLabel(openLabel)
                .accessibilityHint("Opens the thread")
                .accessibilityIdentifier("thread-\(row.id)")
            actions
                .padding(.horizontal, Space.s4)
                .padding(.top, Space.s1)
                .padding(.bottom, Space.s3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sottoCard(phase == .answered ? .answered : .needsYou)
        .animation(.easeInOut(duration: 0.4), value: phase)
    }

    private var phase: Phase {
        guard let answer, answer.requestID == request.id else { return .idle }
        if answer.answered { return .answered }
        if let marker = model.pending(for: row.ref).first(where: { $0.kind == "answer" && $0.requestID == answer.requestID }) {
            return model.isSending(marker) ? .sending : .unconfirmed
        }
        return .sending
    }
    /// Whether the computer confirmed the answer this card sent; otherwise its request left without one.
    private var answerConfirmed: Bool { answer?.confirmed == true }
    private var isPermission: Bool { request.kind == "permission" }
    private var tag: String { isPermission ? "Permission" : "Question" }
    private var ask: String { isPermission ? request.text : (request.questions?.first?.question ?? request.text) }
    private var openLabel: String { "\(row.thread.title). \(tag) from \(Words.provider(row.thread.providerId)) on \(row.computer): \(ask)" }
    private var reviewWords: String {
        if row.thread.requests.count > 1 { return "Review \(row.thread.requests.count) requests" }
        return isPermission ? "Review permission" : "Review question"
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s2) {
                Light(tone: phase == .answered ? .accent : .warning)
                Text(tag).font(.sotto(.caption, .semibold))
                    .foregroundStyle(phase == .answered ? Palette.accentText : Palette.warningText)
                Spacer(minLength: Space.s2)
                if let ago = Words.ago(row.thread.summary?.lastMessageAt) {
                    Text(ago).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1)
                }
            }
            .frame(minHeight: 18)
            Text(row.thread.title).font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s2)
            Text("\(Words.provider(row.thread.providerId)) on \(row.computer)").font(.sotto(.small)).foregroundStyle(Palette.muted)
                .lineLimit(1)
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
            }
            if row.thread.requests.count > 1 {
                Text(row.thread.requests.count == 2 ? "1 more request in this thread" : "\(row.thread.requests.count - 1) more requests in this thread")
                    .font(.sotto(.caption)).foregroundStyle(Palette.muted)
                    .padding(.top, Space.s2)
            }
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s4)
        .padding(.bottom, Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var actions: some View {
        switch phase {
        case .sending:
            HStack(spacing: Space.s2) {
                Spacer(minLength: 0)
                ProgressView().controlSize(.small)
                Text(answer?.busy ?? "Sending…")
            }
            .font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
        case .answered:
            HStack(spacing: Space.s2) {
                Spacer(minLength: 0)
                if answerConfirmed { Image(systemName: "checkmark").accessibilityHidden(true) }
                Text(answerConfirmed ? (answer?.done ?? "Answered") : "No longer waiting")
            }
            .font(.sotto(.small, .semibold)).foregroundStyle(answerConfirmed ? Palette.accentText : Palette.muted)
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
        case .unconfirmed:
            reviewOnly("Not confirmed yet. Check the thread before answering again.")
        case .idle:
            idleActions
        }
    }

    @ViewBuilder private var idleActions: some View {
        let ready = model.canAnswer(request, in: row.ref) && !model.answering(row.ref.hostID)
        if !request.supported {
            reviewOnly("Answer this one in the thread.")
        } else if !model.mayAnswer(row.ref.hostID) {
            reviewOnly("This iPhone can’t answer on \(row.computer) yet.")
        } else if isPermission {
            permissionActions(enabled: ready)
        } else if let options = request.oneTapOptions {
            questionActions(options, enabled: ready)
        } else {
            reviewOnly(nil)
        }
    }

    private func reviewOnly(_ note: String?) -> some View {
        HStack(spacing: Space.s3) {
            if let note {
                Text(note).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            NavigationLink(value: ThreadRoute(ref: row.ref)) { Text(reviewWords) }
                .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
        }
    }

    private func questionActions(_ options: [RequestOption], enabled: Bool) -> some View {
        let ownWords = request.questions?.first?.allowFreeText == true ? "Write your own" : reviewWords
        return VStack(alignment: .leading, spacing: Space.s3) {
            FlowLayout(spacing: Space.s2) {
                ForEach(options) { option in
                    Button { picked = picked == option.id ? nil : option.id } label: { Text(option.label) }
                        .buttonStyle(ChipStyle(selected: picked == option.id))
                        .accessibilityAddTraits(picked == option.id ? .isSelected : [])
                }
            }
            .disabled(!enabled)
            HStack(spacing: Space.s2) {
                NavigationLink(value: ThreadRoute(ref: row.ref)) { Text(ownWords) }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                Spacer(minLength: 0)
                Button("Send answer") {
                    if let picked { send(picked, "Sending…", "Answered") }
                }
                .buttonStyle(PillButtonStyle(kind: .primary, compact: true))
                .disabled(!enabled || picked == nil)
            }
        }
    }

    private func permissionActions(enabled: Bool) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.s2) {
                NavigationLink(value: ThreadRoute(ref: row.ref)) { Text(moreWords) }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                Spacer(minLength: 0)
                permissionButtons(enabled: enabled)
            }
            VStack(alignment: .trailing, spacing: Space.s2) {
                HStack(spacing: Space.s2) { permissionButtons(enabled: enabled) }
                NavigationLink(value: ThreadRoute(ref: row.ref)) { Text(moreWords) }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    private var moreWords: String { request.cardPermissionChoices == nil && request.permissionChoices != nil ? reviewWords : "More choices" }

    /// Deny, then Allow once, on the computer's own words. A request with no choices of its own takes Allow and Deny.
    @ViewBuilder private func permissionButtons(enabled: Bool) -> some View {
        if let choices = request.cardPermissionChoices {
            let ordered: [PermissionChoice] = choices.sorted { $0.kind == "deny" && $1.kind != "deny" }
            ForEach(ordered) { choice in
                let allows = choice.kind != "deny"
                Button(choice.label) {
                    send(choice.id, allows ? "Allowing…" : "Denying…", allows ? "Allowed" : "Denied")
                }
                .buttonStyle(PillButtonStyle(kind: allows ? .primary : .soft, compact: true))
                .disabled(!enabled)
            }
        } else if request.permissionChoices == nil {
            Button("Deny") { send("deny", "Denying…", "Denied") }
                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                .disabled(!enabled)
            Button("Allow") { send("allow", "Allowing…", "Allowed") }
                .buttonStyle(PillButtonStyle(kind: .primary, compact: true))
                .disabled(!enabled)
        }
    }
}

// MARK: - Working now

/// A thread at work: a breathing accent halo, how long it has been at it, and what it is doing.
private struct WorkingCard: View {
    @EnvironmentObject var model: AppModel
    /// Watched for the step the open thread is running, which the thread's history carries.
    @EnvironmentObject var detailStore: DetailStore
    let row: HostedThread
    private var state: ThreadState { ThreadState(row.thread) }
    var body: some View {
        NavigationLink(value: ThreadRoute(ref: row.ref)) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Space.s2) {
                    Light(tone: .accent, breathing: true)
                    Text(state.words).font(.sotto(.caption, .semibold)).foregroundStyle(Palette.accentText)
                    Spacer(minLength: Space.s2)
                    if let since = Words.date(row.thread.summary?.runningTurnStartedAt) {
                        ElapsedText(since: since).font(.sotto(.caption, .semibold).monospacedDigit()).foregroundStyle(Palette.muted)
                    } else if let ago = Words.ago(row.thread.summary?.lastMessageAt) {
                        Text(ago).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                }
                .frame(minHeight: 18)
                Text(row.thread.title).font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Space.s2)
                Text(place).font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(1)
                    .padding(.top, Space.s1)
                Text(liveLine).font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Space.s3)
            }
            .padding(Space.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { Runner() }
            .sottoCard(.working)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("\(row.thread.title), \(state.words), \(place)")
        .accessibilityHint("Opens the thread")
        .accessibilityIdentifier("thread-\(row.id)")
    }
    private var place: String {
        let base = "\(Words.provider(row.thread.providerId)) on \(row.computer)"
        guard let project = row.project else { return base }
        return base + " · " + project
    }
    /// The step running now when this iPhone holds the thread's detail; otherwise what the state says. The list
    /// a computer shares carries no steps.
    private var liveLine: String {
        if let detail = model.detail(for: row.ref), let step = detail.activities?.last(where: { $0.status == "running" }) {
            return [step.title, step.subject].compactMap { $0 }.joined(separator: " ")
        }
        if state == .compacting { return "Making room in the thread’s context." }
        if state == .waiting { return "A background command is still running." }
        if row.thread.status != "running", !(row.thread.backgroundWork ?? []).isEmpty { return "Background agents are still working." }
        return "\(Words.provider(row.thread.providerId)) is working on \(row.computer)."
    }
}

// MARK: - Recent and settled

/// Quiet rows on one surface, for Recent and the settled shelf.
private struct ThreadRowList: View {
    let rows: [HostedThread]
    let unread: Set<String>
    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 {
                    Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4 + 20)
                }
                ThreadRow(row: row, unread: unread.contains(row.id))
            }
        }
        .sottoCard(.plain)
    }
}

/// A finished, failed or settled thread. One that finished while nothing showed it (ADR-0046) has an accent
/// light, a bold title and Just finished until it is opened here or on the desktop.
private struct ThreadRow: View {
    let row: HostedThread
    let unread: Bool
    @Environment(\.sottoDensity) private var density
    private var state: ThreadState { ThreadState(row.thread) }
    private var failed: Bool { row.reachable && state == .failed }
    var body: some View {
        NavigationLink(value: ThreadRoute(ref: row.ref)) {
            HStack(alignment: .top, spacing: Space.s3) {
                Light(tone: unread ? .accent : failed ? .danger : .off).padding(.top, 6)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.thread.title).font(.sotto(.body, unread ? .bold : .semibold)).foregroundStyle(Palette.ink)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Text(line).font(.sotto(.small)).foregroundStyle(failed ? Palette.dangerText : Palette.muted).lineLimit(1)
                }
                Spacer(minLength: Space.s2)
                if let ago = Words.ago(row.thread.summary?.runningTurnStartedAt ?? row.thread.summary?.lastMessageAt) {
                    Text(ago).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1).padding(.top, 3)
                }
            }
            .padding(.horizontal, Space.s4)
            .padding(.vertical, Space.dense(Space.s3, density) + 2)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            .failedEdge(failed)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
        .accessibilityHint("Opens the thread")
        .accessibilityIdentifier("thread-\(row.id)")
    }
    /// What the row says under its title: just finished, can't be reached, failed, or where it lives.
    private var line: String {
        if unread { return "Just finished · \(row.computer)" }
        if !row.reachable { return "\(row.status.words) · \(row.computer)" }
        if failed { return "\(state.words) · \(row.computer)" }
        return Words.place(row)
    }
    /// The row as VoiceOver reads it; a thread that finished out of sight says so right after its name.
    private var label: String {
        if unread { return "\(row.thread.title), just finished, not opened yet, \(Words.place(row))" }
        if !row.reachable { return "\(row.thread.title), \(row.status.words), \(Words.place(row))" }
        if failed { return "\(row.thread.title), \(state.words), \(Words.place(row))" }
        return "\(row.thread.title), \(Words.place(row))"
    }
}
