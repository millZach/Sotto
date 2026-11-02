import SwiftUI
import SottoCore

// The Agents view (ADR-0103, an Owl feature; variant A of docs/prototypes/iphone-agents-view-prototype.html): Agents in a
// thread's top bar, with a count, opens a sheet of the thread's delegated threads and its provider's own sub-agents,
// newest start first, as the desktop's Tools › Agents lists them. A delegated thread's row opens that thread, and Back
// comes back to the sheet; a sub-agent's row opens in place to its task and result. Nothing here answers anything: a
// thread that waits on the user opens to be answered there.

/// Agents beside the thread's state: the count of its delegated threads and agents, with the Needs you light while a
/// delegated thread waits on the user. At compact width, where the bar's room goes to the thread's title, and at the
/// largest text sizes it is the mark and the count alone.
struct AgentsButton: View {
    let count: AgentsCount
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.horizontalSizeClass) private var sizeClass
    var body: some View {
        let needs = count.needs > 0
        let compact = typeSize.isAccessibilitySize || sizeClass != .regular
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "person.2").font(.system(size: 13, weight: .semibold)).accessibilityHidden(true)
                if !compact { Text("Agents").lineLimit(1) }
                if needs { Light(tone: .warning, size: 7) }
                Text("\(count.total)")
                    .monospacedDigit()
                    .foregroundStyle(needs ? Palette.warningText : Palette.muted)
            }
            .font(.sotto(.small, .semibold))
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, Space.s3)
            .frame(minHeight: 32)
            .background(needs ? Palette.warning.opacity(Tint.needsYou) : Palette.fillSoft, in: Capsule())
            .overlay(Capsule().strokeBorder(needs ? Palette.warning.opacity(0.55) : Palette.hairline, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("Agents")
        .accessibilityValue(spokenCount)
        .accessibilityHint("Opens this thread’s delegated threads and agents")
        .accessibilityIdentifier("thread-agents")
    }
    /// The count as VoiceOver reads it: how many agents, and how many of them need the user.
    private var spokenCount: String {
        let agents = count.total == 1 ? String(localized: "1 agent") : String(localized: "\(count.total) agents")
        guard count.needs > 0 else { return agents }
        let waiting = count.needs == 1 ? String(localized: "1 needs you") : String(localized: "\(count.needs) need you")
        return String(localized: "\(agents), \(waiting)", comment: "First %@ is how many agents the thread has, such as 3 agents; second is how many need the user, such as 1 needs you.")
    }
}

extension View {
    /// The Agents sheet on a thread's page, and the delegated thread a row of it opens. Back from that thread opens the
    /// sheet again.
    /// `covered` is true while a delegated thread opened from it is on top; `closed` runs when the sheet goes with nothing
    /// to open, so the page can offer a request that came while it was up.
    func agentsSheet(ref: ThreadRef, open: Binding<Bool>, covered: Binding<Bool>, closed: @escaping () -> Void) -> some View {
        modifier(AgentsPresenter(ref: ref, open: open, covered: covered, closed: closed))
    }
}

private struct AgentsPresenter: ViewModifier {
    let ref: ThreadRef
    @Binding var open: Bool
    @Binding var covered: Bool
    let closed: () -> Void
    /// The delegated thread a row asked for, opened once the sheet has gone.
    @State private var pending: ThreadRef?
    @State private var pushed: ThreadRef?
    /// Opened from the sheet, so coming back opens the sheet again.
    @State private var reopen = false
    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $open, onDismiss: {
                guard let next = pending else { closed(); return }
                pending = nil
                reopen = true
                pushed = next
            }) {
                AgentsSheet(ref: ref) { target in
                    pending = target
                    open = false
                }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
            .navigationDestination(item: $pushed) { target in ThreadView(ref: target).duoThreadBar(nested: true) }
            // Only once the delegated thread has gone: a swipe back that is cancelled leaves it open, and the sheet shut.
            .onChange(of: pushed) { old, new in
                covered = new != nil
                guard old != nil, new == nil, reopen else { return }
                reopen = false
                open = true
            }
    }
}

/// The sheet: the thread's delegated threads and agents in one list, newest start first, under a line that counts them
/// and says what needs the user and what is working. It reads what the computer's delegation record and the provider's
/// agents say when it opens, and again when the thread list says one of them changed. While an agent runs it reads the
/// agents again every few seconds, since nothing tells the phone of an agent's new update until its counts change.
private struct AgentsSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let ref: ThreadRef
    let open: (ThreadRef) -> Void
    @State private var delegations: [DelegatedThreadRecord]?
    @State private var page: SubagentPage?
    @State private var problem = false
    /// Until the first read has answered, the list is loading rather than empty.
    @State private var loading = true
    /// Counts the user's own refreshes, so an opened agent reads its task and result again with the list.
    @State private var refreshes = 0

    var body: some View {
        let source = model.agentsSource(ref)
        let rows = source.map { AgentsRoster.rows(owner: $0.owner, threads: $0.threads, delegations: delegations, agents: page?.rows ?? [], models: $0.models,
                                                  failuresSeen: $0.failuresSeen) } ?? []
        let counts = AgentsRoster.countLine(rows, summary: page?.summary ?? source?.owner.subagentSummary)
        let needs = rows.contains { $0.tone == .needs }
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s3) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                    Text("Agents").font(.sotto(.title, .bold)).headingTracking(-0.4).foregroundStyle(Palette.ink)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: Space.s2)
                    Button("Done") { dismiss() }
                        .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("agents-done")
                }
                if let title = source?.owner.title {
                    Text(verbatim: title).font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
                    Text(counts.title).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                    Spacer(minLength: Space.s2)
                    Text(counts.detail).font(.sotto(.small, needs ? .semibold : .regular)).foregroundStyle(needs ? Palette.warningText : Palette.muted)
                }
                .padding(.top, Space.s2)
                .accessibilityElement(children: .combine)
                if problem {
                    VStack(alignment: .leading, spacing: Space.s2) {
                        Text("Couldn’t read the agents on \(model.name(ref.hostID)). Nothing was changed. Try again.")
                            .font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                            .paragraphDirection()
                        Button("Try again") { Task { await refresh() } }
                            .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                            .disabled(loading)
                    }
                    .padding(Space.s4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .sottoCard(.plain)
                }
                if rows.isEmpty {
                    (loading ? Text("Loading agents…") : Text("This thread has no delegated threads or agents now."))
                        .font(.sotto(.body)).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal: false, vertical: true).padding(.vertical, Space.s6)
                        .paragraphDirection()
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4) }
                            switch row.kind {
                            case .thread:
                                AgentsThreadRow(row: row) {
                                    if let id = row.threadID { open(ThreadRef(hostID: ref.hostID, threadID: id)) }
                                }
                            case .agent:
                                AgentsAgentRow(ref: ref, row: row, refreshes: refreshes)
                            }
                        }
                    }
                    .sottoCard(.plain)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Delegated threads and agents, newest first")
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s6)
            .padding(.bottom, Space.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .refreshable { await refresh() }
        .task(id: source.map { AgentsRoster.refreshSignal($0.owner, in: $0.threads) } ?? "") { await load() }
        // Ends when nothing is running or the sheet goes.
        .task(id: AgentsRoster.followsAgents(page?.rows ?? [])) { if AgentsRoster.followsAgents(page?.rows ?? []) { await follow() } }
        .presentationBackground { SheetBackdrop(wash: false) }
        .environment(\.sottoOnSheet, true)
        .presentationCornerRadius(Radius.xl)
        .accessibilityAction(.escape) { dismiss() }
    }

    /// The user's own refresh: the list, and every opened agent's task and result with it.
    private func refresh() async {
        refreshes += 1
        await load()
    }

    /// The agents alone, read again while one runs. An opened agent reads its task and result again only when its run,
    /// revision or status moves. A read that fails leaves the list as it was and is tried at the next one.
    private func follow() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: AgentsRoster.followInterval)
            guard !Task.isCancelled, !loading else { continue }
            if let next = try? await model.readSubagents(ref), !Task.isCancelled { page = next }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        var failed = false
        var read: [DelegatedThreadRecord]? = nil, agents: SubagentPage? = nil
        do { read = try await model.readDelegations(ref).threads } catch { failed = true }
        do { agents = try await model.readSubagents(ref) } catch { failed = true }
        // A read a newer one replaced leaves the sheet to the newer read.
        guard !Task.isCancelled else { return }
        if let read { delegations = read }
        if let agents { page = agents }
        problem = failed
    }
}

/// How a row's light and status words are coloured.
private extension AgentsRow.Tone {
    var light: Light.Tone {
        switch self {
        case .needs: return .warning
        case .working: return .accent
        case .failed: return .danger
        case .done, .quiet: return .off
        }
    }
    var words: ThemeRole {
        switch self {
        case .needs: return Palette.warningText
        case .working: return Palette.accentText
        case .failed: return Palette.dangerText
        case .done, .quiet: return Palette.muted
        }
    }
}

/// How long a row has worked, counting each second while it does.
private struct RowElapsed: View {
    let elapsed: AgentsElapsed
    var body: some View {
        switch elapsed {
        case .since(let start): ElapsedText(since: start)
        case .took(let seconds): Text(Elapsed.words(seconds))
        case .unknown: EmptyView()
        }
    }
}

/// What every row shows: its mark, its title with Thread or Agent and its time, who delegated it, its brief or
/// description, where it runs and its status.
private struct RowBody: View {
    let row: AgentsRow
    let tag: String
    let mark: AnyView
    var body: some View {
        HStack(alignment: .top, spacing: Space.s3) {
            mark
                .frame(width: 28, height: 28)
                .background(Palette.fillSoft, in: Circle())
                .foregroundStyle(Palette.ink)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                    Text(verbatim: row.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).lineLimit(2)
                    Text(tag)
                        .font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                        .padding(.horizontal, 7).padding(.vertical, 1)
                        .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
                        .fixedSize()
                    Spacer(minLength: Space.s1)
                    RowElapsed(elapsed: row.elapsed)
                        .font(.sotto(.caption).monospacedDigit()).foregroundStyle(Palette.muted)
                        .fixedSize()
                }
                if let by = row.delegatedBy {
                    Text("Delegated by \(by)").font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1)
                }
                if let preview = row.preview {
                    Text(preview).font(.sotto(.small)).foregroundStyle(Palette.ink.opacity(0.86)).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(row.meta(clock: { $0.formatted(date: .omitted, time: .shortened) }))
                    .font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(2)
                if let status = row.status {
                    HStack(spacing: 6) {
                        Light(tone: row.tone.light, size: 7, breathing: row.tone == .working)
                        Text(status)
                    }
                    .font(.sotto(.small, row.tone == .done || row.tone == .quiet ? .regular : .semibold))
                    .foregroundStyle(row.tone.words)
                    .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // A row under another is set in, as Tools › Agents sets it.
        .padding(.leading, CGFloat(min(row.level - 1, 3)) * 18)
    }
}

/// A delegated thread: pressed, it opens. One that waits on the user says Open to answer, as the desktop does; it opens
/// the thread, where the request is answered as any other.
private struct AgentsThreadRow: View {
    let row: AgentsRow
    let open: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: open) {
                HStack(alignment: .center, spacing: Space.s2) {
                    RowBody(row: row, tag: String(localized: "Thread", comment: "The tag on a row of the Agents sheet that is a delegated thread."), mark: ProviderLogo.asset(row.providerID) != nil ? AnyView(ProviderLogo(providerID: row.providerID))
                        : AnyView(Image(systemName: "bubble.left").font(.system(size: 12, weight: .semibold))))
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted)
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.s3)
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel(row.spokenLabel)
            .accessibilityIdentifier("agents-row-\(row.id)")
            if row.waitingFor != nil {
                Button("Open to answer", action: open)
                    .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                    .padding(.leading, Space.s4 + 28 + Space.s3 + CGFloat(min(row.level - 1, 3)) * 18)
                    .padding(.bottom, Space.s3)
                    .accessibilityLabel("Open \(row.title) to answer its request")
                    .accessibilityIdentifier("agents-answer-\(row.id)")
            }
        }
    }
}

/// One of the provider's own agents: pressed, it opens in place to what it was asked and its latest update or result,
/// read from the computer when it opens.
private struct AgentsAgentRow: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let row: AgentsRow
    /// The sheet's count of the user's refreshes: each one reads an opened agent again.
    let refreshes: Int
    @State private var open = false
    @State private var assignment: SubagentAssignment?
    @State private var failed = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open.toggle() } label: {
                HStack(alignment: .center, spacing: Space.s2) {
                    RowBody(row: row, tag: row.workflow ? String(localized: "Workflow", comment: "The tag on a row of the Agents sheet that is a workflow's run.")
                                : String(localized: "Agent", comment: "The tag on a row of the Agents sheet that is one of the provider's own agents."),
                            mark: AnyView(Image(systemName: row.workflow ? "square.stack.3d.up" : "person.crop.square").font(.system(size: 13, weight: .semibold))))
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, Space.s4)
                .padding(.vertical, Space.s3)
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel(row.spokenLabel)
            .accessibilityValue(open ? FoldWords.open : FoldWords.closed)
            .accessibilityHint(open ? String(localized: "Hides its task and result") : String(localized: "Shows its task and result"))
            .accessibilityIdentifier("agents-row-\(row.id)")
            if open { details }
        }
        // Opened, it reads again when its run, its revision or its status changes, and on the user's refresh, so a running
        // agent that finishes shows its result rather than its last update.
        .task(id: [String(open), row.detailsKey ?? "", String(refreshes)].joined(separator: "|")) { if open { await load() } }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            Text("Task").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted).accessibilityAddTraits(.isHeader)
            Text(taskWords).font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
            if let assignment {
                Text(AgentsRoster.resultHeading(assignment.status)).font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                    .padding(.top, Space.s2).accessibilityAddTraits(.isHeader)
                Text(AgentsRoster.resultWords(assignment)).font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
            } else if failed {
                Text("Couldn’t read its result. Nothing was changed. Close it and open it again to try again.")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true).padding(.top, Space.s2)
                    .paragraphDirection()
            } else {
                Text("Loading its result…").font(.sotto(.small)).foregroundStyle(Palette.muted).padding(.top, Space.s2)
            }
        }
        .padding(.leading, Space.s4 + 28 + Space.s3 + CGFloat(min(row.level - 1, 3)) * 18)
        .padding(.trailing, Space.s4)
        .padding(.bottom, Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agents-details-\(row.id)")
    }

    private var taskWords: String {
        if let prompt = assignment?.prompt, !prompt.isEmpty { return prompt }
        return row.preview ?? row.title
    }

    private func load() async {
        guard let agentID = row.agentID else { return }
        failed = false
        do {
            let page = try await model.readAssignments(ref, agentID: agentID)
            // A read a newer one replaced (its run, revision or a refresh changed) leaves the row to the newer read.
            guard !Task.isCancelled else { return }
            assignment = page.assignments.first
        } catch {
            guard !Task.isCancelled else { return }
            // The words already shown may be an earlier run's, under a row that now names a newer one, so a failed read
            // says so rather than keeping them.
            assignment = nil
            failed = true
        }
    }
}
