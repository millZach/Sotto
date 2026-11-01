import SwiftUI
import SottoCore

/// A request shown on a Needs you card: the thread, and the first request waiting in it.
private struct NeedsItem {
    let row: HostedThread
    /// The thread that asks: the row's own, or the delegated thread it stands for (ADR-0081).
    let asking: HostedThread
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
    /// The thread the answer went to: the row's own, or the delegated thread it stands for.
    let asking: HostedThread
    let request: AgentRequest
    /// Until the model has finished sending it.
    var inFlight = true
    var answered = false
    /// Whether the computer confirmed it. A request that left without that reads as no longer waiting instead.
    var confirmed = false
    /// What it answered. The card's row can go on to show another thread's request, so the answer is matched on both.
    var asked: AskedRequest { AskedRequest(thread: asking.ref, requestID: requestID) }
}

/// The search field's frame, kept outside SwiftUI's state so scrolling doesn't redraw the page.
private final class FrameBox {
    var frame: CGRect = .zero
}

/// Threads: questions and permissions first, then working threads, recent ones and the settled shelf (ADR-0039,
/// ADR-0051). On every iPhone but the unfolded Duo it is the thread list, a row each, as the unfolded Duo's sidebar
/// shows it, and a press opens the thread (ADR-0151, amended October 30, 2026). The unfolded Duo keeps its columns of
/// cards, answerable in place. The heading, the computer menu and search scroll with the list as one sheet. Focus reads
/// only host list summaries; opening a thread subscribes to its detail.
struct ThreadsView: View {
    @EnvironmentObject var model: AppModel
    /// Opens a thread over the page, from the list or once New thread has made it.
    var open: (ThreadRef) -> Void = { _ in }
    @State private var creating = false
    @State private var query = ""
    @State private var settledExpanded = false
    @State private var sent: [String: CardAnswer] = [:]
    @State private var searchBox = FrameBox()
    @FocusState private var searching: Bool
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.duoLayout) private var duo
    /// The unfolded Duo keeps its cards: side by side, a column each, except at the accessibility text sizes, where a
    /// third of the width can't hold a title and the page keeps one column. Every other iPhone shows the thread list.
    private var unfolded: Bool { duo.sideways || duo == .upright }
    private var inColumns: Bool { unfolded && !typeSize.isAccessibilitySize }

    var body: some View {
        let _ = BenchProbe.body("ThreadsView")
        let groups = model.focusThreads(show: model.show, query: query, opened: model.selected)
        let unsearched = query.isEmpty ? groups : model.focusThreads(show: model.show, opened: model.selected)
        SheetPage(warm: unsearched.requestCount > 0) {
            VStack(alignment: .leading, spacing: 0) {
                heading
                // The computer menu shares the search row, and the sections count their own threads (#1849). At the
                // accessibility text sizes the row can't hold both, so search goes under the menu.
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: Space.s3) { ComputerMenu(); searchPill }
                        .padding(.top, Space.s3)
                } else {
                    HStack(spacing: Space.s3) {
                        ComputerMenu()
                        searchPill.frame(maxWidth: inColumns ? 420 : nil)
                        if inColumns { Spacer(minLength: Space.s2) }
                    }
                    .padding(.top, Space.s3)
                }
                notices
                if unfolded { sections(groups) } else { list(groups) }
            }
            // A Max held sideways reads the list at the reading width, as a thread does; the unfolded Duo's columns
            // take the whole width.
            .readingWidth(on: !unfolded)
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
        }
        .sheet(isPresented: $creating, onDismiss: { model.newThreadClosed() }) {
            NewThreadSheet(opened: { ref in model.newThreadOpened(ref); open(ref) })
        }
        .onChange(of: model.shareOpened) { _, destination in openForShare(destination) }
        .onAppear { openForShare(model.shareOpened) }
        // What the list is searched for, so unfolding the Duo opens the top row of the list shown.
        .onChange(of: query, initial: true) { _, typed in model.listQuery = typed }
    }

    private func openForShare(_ destination: ShareDestination?) {
        guard destination == .newThread else { return }
        model.shareOpened = nil
        creating = true
    }

    // MARK: Top of the sheet

    private var heading: some View {
        PageHeading(String(localized: "Threads")) {
            // On the iPhone Duo, New thread is on the rail instead (ADR-0151, amended).
            if duo == .none {
                Button { creating = true } label: { Image(systemName: "plus") }
                    .buttonStyle(GlassCircleStyle())
                    .accessibilityLabel("New thread")
                    .accessibilityIdentifier("new-thread")
            }
        }
        .padding(.top, Space.s1)
    }

    private var searchPill: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted).accessibilityHidden(true)
            TextField("Search threads", text: $query, prompt: Text("Search threads").foregroundStyle(Palette.placeholder))
                .focused($searching)
                .font(.sotto(.body))
                .foregroundStyle(Palette.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { searching = false }
                .accessibilityLabel("Search threads")
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
    }

    /// What just went wrong, creations waiting on a computer, and computers that can't be reached.
    @ViewBuilder private var notices: some View {
        if model.feedback != nil { FeedbackBanner().padding(.top, Space.s4) }
        ForEach(model.pendingCreations.filter { model.show.admits($0.hostID) }) { operation in
            CreationPendingRow(operation: operation).padding(.top, Space.s3)
        }
        // Every computer that can't be reached shares one note (#1849).
        let unreachable = model.lists.filter { model.show.admits($0.hostID) && $0.status != .online }
        if query.isEmpty && !unreachable.isEmpty {
            ConnectionNote(computers: unreachable, trying: unreachable.allSatisfy { $0.status == .connecting })
        }
    }

    // MARK: The thread list

    /// The thread list, then the settled shelf, folded unless a search reaches into it.
    @ViewBuilder private func list(_ groups: FocusThreads) -> some View {
        if groups.isEmpty { empty(groups) }
        ThreadListSections(groups: groups, open: open).equatable()
        if !groups.settled.isEmpty {
            if groups.searching {
                ThreadListHeading(title: String(localized: "Settled", comment: "The heading over threads the user has put aside."), count: groups.settled.count, id: "settled")
            } else {
                settledToggle(groups.settled.count)
            }
            if settledExpanded || groups.searching {
                let watched = model.watchedThreadIDs
                ForEach(groups.settled) { row in
                    ThreadListRow(row: row, kind: .recent(unread: groups.isUnreadFinish(row)), watched: watched.contains(row.id), chosen: false,
                                  canWatch: model.canChangeWatch(row.ref), identifier: "thread-",
                                  open: { open(row.ref) },
                                  setWatched: { on in Task { await model.setWatched(row.ref, on, title: row.thread.title) } })
                        .equatable()
                }
            }
        }
    }

    private func empty(_ groups: FocusThreads) -> some View {
        (groups.searching ? Text("No matching threads.") : model.anyConnecting ? Text("Reading threads…") : Text("No threads here yet. Tap New thread to start one."))
            .font(.sotto(.body)).foregroundStyle(Palette.muted)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, Space.s7)
            .paragraphDirection()
    }

    // MARK: Sections

    @ViewBuilder private func sections(_ groups: FocusThreads) -> some View {
        let needs = needsItems(groups)
        let departing = Set(needs.map { $0.row.id }).subtracting(groups.questions.map { $0.id })
        let working = groups.working.filter { !departing.contains($0.id) }
        let recent = groups.recent.filter { !departing.contains($0.id) }
        let settled = groups.settled.filter { !departing.contains($0.id) }
        let unread = Set((recent + settled).filter { groups.isUnreadFinish($0) }.map { $0.id })
        let watched = model.watchedThreadIDs
        if needs.isEmpty && working.isEmpty && recent.isEmpty && settled.isEmpty { empty(groups) }
        let needsColumn = VStack(alignment: .leading, spacing: 0) {
            SectionHeading(String(localized: "Needs you", comment: "The heading over threads waiting on the user's answer."), count: needs.count, light: .warning)
            VStack(spacing: Space.s3) {
                ForEach(Array(needs.enumerated()), id: \.element.row.id) { index, item in
                    RequestCard(row: item.row, asking: item.asking, request: item.request, answer: sent[item.row.id]) { choice, busy, done in
                        answer(item, choice: choice, busy: busy, done: done, index: index)
                    }
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.opacity.combined(with: .scale(scale: 0.96)))
                }
            }
        }
        let workingColumn = VStack(alignment: .leading, spacing: 0) {
            SectionHeading(String(localized: "Working now"), count: working.count, light: .accent)
            VStack(spacing: Space.s3) {
                ForEach(working) { row in WorkingCard(row: row) }
            }
        }
        let recentColumn = VStack(alignment: .leading, spacing: 0) {
            if !recent.isEmpty {
                SectionHeading(String(localized: "Recent", comment: "The heading over threads that finished lately."), count: recent.count)
                ThreadRowList(rows: recent, unread: unread, watched: watched)
            }
            if !settled.isEmpty {
                if groups.searching {
                    SectionHeading(String(localized: "Settled", comment: "The heading over threads the user has put aside."), count: settled.count)
                } else {
                    settledToggle(settled.count)
                }
                if settledExpanded || groups.searching {
                    ThreadRowList(rows: settled, unread: unread, watched: watched)
                }
            }
        }
        if inColumns {
            // Only the sections that hold threads become columns, as the phone shows only those, and share the width.
            HStack(alignment: .top, spacing: Space.s4) {
                if !needs.isEmpty { needsColumn.frame(maxWidth: .infinity, alignment: .leading) }
                if !working.isEmpty { workingColumn.frame(maxWidth: .infinity, alignment: .leading) }
                if !recent.isEmpty || !settled.isEmpty { recentColumn.frame(maxWidth: .infinity, alignment: .leading) }
            }
        } else {
            if !needs.isEmpty { needsColumn }
            if !working.isEmpty { workingColumn }
            recentColumn
        }
    }

    private func settledToggle(_ count: Int) -> some View {
        let threads = count == 1 ? String(localized: "1 thread") : String(localized: "\(count) threads")
        return Button { settledExpanded.toggle() } label: {
            HStack(spacing: Space.s2) {
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                    .rotationEffect(.degrees(settledExpanded ? 90 : 0))
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: settledExpanded)
                Text("Settled", comment: "The heading over threads the user has put aside.")
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
        .accessibilityLabel(settledExpanded ? String(localized: "Hide settled threads") : String(localized: "Show settled threads"))
        .accessibilityValue(settledExpanded ? String(localized: "\(threads), expanded", comment: "%@ is how many settled threads there are, such as 3 threads.")
                            : String(localized: "\(threads), collapsed", comment: "%@ is how many settled threads there are, such as 3 threads."))
    }

    /// The live requests, with any card that was just answered here kept in its place until it leaves.
    private func needsItems(_ groups: FocusThreads) -> [NeedsItem] {
        var items: [NeedsItem] = groups.questions.compactMap { row in
            let asking = groups.asking(row)
            guard let request = asking.thread.requests.first else { return nil }
            return NeedsItem(row: row, asking: asking, request: request)
        }
        let live = Set(items.map { $0.row.id })
        let leaving = sent.values.filter { !live.contains($0.row.id) && model.show.admits($0.row.ref.hostID) }.sorted { $0.index < $1.index }
        for answer in leaving {
            items.insert(NeedsItem(row: answer.row, asking: answer.asking, request: answer.request), at: min(answer.index, items.count))
        }
        return items
    }

    // MARK: Answering in place

    /// Sends a card's answer through the model's own answer path, which checks this iPhone may answer there and
    /// keeps a marker until the computer confirms it.
    private func answer(_ item: NeedsItem, choice: String, busy: String, done: String, index: Int) {
        let id = item.row.id
        sent[id] = CardAnswer(requestID: item.request.id, busy: busy, done: done, index: index, row: item.row, asking: item.asking, request: item.request)
        Task {
            await model.answer(item.request, in: item.asking.ref, choice: choice, answers: Self.oneTapAnswers(item.request, choice: choice))
            sent[id]?.inFlight = false
            resolve(id)
        }
    }

    /// A chip on a card for one structured question answers that question; plain options and permissions go as the
    /// choice alone. As a choice alone, a structured question had no answer, and the phone refused to send it.
    static func oneTapAnswers(_ request: AgentRequest, choice: String) -> [String: QuestionAnswer] {
        guard request.kind == "question", let question = request.questions?.first else { return [:] }
        return [question.id: QuestionAnswer(optionIds: [choice])]
    }

    /// Settles a card once the model has finished with its answer. Confirmed, it reads Answered for a moment and
    /// leaves; gone without confirmation, it reads No longer waiting and leaves; refused, it returns to its choices and the banner says why. While the
    /// computer hasn't confirmed it, the card says so and waits.
    private func resolve(_ id: String) {
        guard let answer = sent[id], !answer.inFlight, !answer.answered else { return }
        let ref = answer.asking.ref
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

/// The note for the computers that can't be reached, one line however many there are (#1849). Try again is its own
/// view so one press gives one press's feedback, and it tries each of them that isn't being tried already; it waits
/// only while every one of them is.
private struct ConnectionNote: View {
    let computers: [ComputerThreads]
    let trying: Bool
    /// Their names, joined as the language joins a list: "Studio Mac and Desktop".
    private var names: String { ListFormatter.localizedString(byJoining: computers.map(\.name)) }
    @EnvironmentObject var model: AppModel
    @Environment(\.sottoTheme) private var theme
    @State private var retries = 0

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        HStack(spacing: Space.s3) {
            Image(systemName: "desktopcomputer").foregroundStyle(Palette.muted).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                (trying ? Text("Checking \(names)…") : Text(String(localized: "computer-row.cant-reach", defaultValue: "Can’t reach \(names).", comment: "Over a computer's last shared threads when it can't be reached. %@ is the computer's name")))
                    .font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink)
                    // Several names hold one line, cut at its end; VoiceOver reads them all.
                    .lineLimit(computers.count > 1 ? 1 : nil)
                if !trying {
                    (computers.count == 1 ? Text("Showing its last shared threads.") : Text("Showing their last shared threads."))
                        .font(.sotto(.small)).foregroundStyle(Palette.muted)
                        .paragraphDirection()
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Space.s2)
            // Each computer is tried on its own, so a slow one holds up none of the others.
            Button { retries += 1; for computer in computers where computer.status != .connecting { Task { await model.connect(computer.hostID) } } } label: {
                if trying {
                    HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Trying", comment: "On the button while Sotto tries to reach a computer again.") }
                } else {
                    Text("Try again")
                }
            }
            .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
            .sensoryFeedback(.impact(flexibility: .soft), trigger: retries)
            .disabled(trying)
            .accessibilityLabel(trying ? String(localized: "Trying to reach \(names)", comment: "%@ is the computer's name.")
                                : String(localized: "Try reaching \(names) again", comment: "%@ is the computer's name."))
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
}

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
                Text(title).lineLimit(1).minimumScaleFactor(0.8)
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
        return String(localized: "All computers")
    }
}

// MARK: - Needs you

/// A question or permission waiting on the user, warm with its glow. One-tap answers are made here: a chip
/// and Send answer, or Deny and Allow once. Anything more opens the thread, where the full sheet waits.
private struct RequestCard: View {
    @EnvironmentObject var model: AppModel
    let row: HostedThread
    /// The thread that asks and takes the answer: the row's own, or the delegated thread the row stands for (ADR-0081).
    /// Opening the card opens the row's thread; reviewing the request opens the thread that asks.
    let asking: HostedThread
    let request: AgentRequest
    let answer: CardAnswer?
    let send: (_ choice: String, _ busy: String, _ done: String) -> Void
    /// The chip picked and not sent yet, kept with the request it was picked for, so it is gone once the card shows
    /// another request, from another delegated thread or the same one.
    @State private var choice: CardChoice?

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

    private var asked: AskedRequest { AskedRequest(thread: asking.ref, requestID: request.id) }
    private var picked: Binding<String?> {
        Binding(get: { choice?.chosen(for: asked) }, set: { option in choice = option.map { CardChoice(asked: asked, option: $0) } })
    }

    private var phase: Phase {
        guard let answer, answer.asked == asked else { return .idle }
        if answer.answered { return .answered }
        if let marker = model.pending(for: asking.ref).first(where: { $0.kind == "answer" && $0.requestID == answer.requestID }) {
            return model.isSending(marker) ? .sending : .unconfirmed
        }
        return .sending
    }
    /// Whether the computer confirmed the answer this card sent; otherwise its request left without one.
    private var answerConfirmed: Bool { answer?.confirmed == true }
    private var isPermission: Bool { request.kind == "permission" }
    private var tag: String {
        isPermission ? String(localized: "Permission", comment: "The tag on a card whose thread asks the user for a permission.")
            : String(localized: "Question", comment: "The tag on a card whose thread asks the user a question.")
    }
    private var ask: String { isPermission ? request.text : (request.questions?.first?.question ?? request.text) }
    /// The delegated thread the request waits in, when it is not the row's own.
    private var delegated: Bool { asking.ref != row.ref }
    private var place: String {
        let provider = Words.provider(row.thread.providerId)
        if delegated {
            return String(localized: "\(provider) on \(row.computer) · Waiting in \(asking.thread.title)",
                          comment: "First %@ is the agent's name, such as Codex; second is the computer's name; third is the title of the delegated thread the request waits in.")
        }
        return String(localized: "\(provider) on \(row.computer)", comment: "First %@ is the agent's name, such as Codex; second is the computer's name.")
    }
    private var openLabel: String {
        let provider = Words.provider(row.thread.providerId)
        let title = row.thread.title
        var label: String
        if delegated {
            label = isPermission
                ? String(localized: "\(title). Permission from \(provider) on \(row.computer), waiting in \(asking.thread.title)",
                         comment: "First %@ is the thread's title; second is the agent's name, such as Codex; third is the computer's name; fourth is the delegated thread the request waits in.")
                : String(localized: "\(title). Question from \(provider) on \(row.computer), waiting in \(asking.thread.title)",
                         comment: "First %@ is the thread's title; second is the agent's name, such as Codex; third is the computer's name; fourth is the delegated thread the request waits in.")
        } else {
            label = isPermission
                ? String(localized: "\(title). Permission from \(provider) on \(row.computer)",
                         comment: "First %@ is the thread's title; second is the agent's name, such as Codex; third is the computer's name.")
                : String(localized: "\(title). Question from \(provider) on \(row.computer)",
                         comment: "First %@ is the thread's title; second is the agent's name, such as Codex; third is the computer's name.")
        }
        if model.watchedByWatcher(row.ref) {
            label = String(localized: "\(label), watched by Watcher", comment: "%@ is what VoiceOver reads of the thread before this: its title and where it runs.")
        }
        return String(localized: "\(label): \(ask)", comment: "First %@ is the thread's title and where it runs; second is the question or permission, in the agent's own words.")
    }
    private var reviewWords: String {
        if asking.thread.requests.count > 1 {
            return String(localized: "Review \(asking.thread.requests.count) requests", comment: "%lld is how many requests wait in the thread, always more than one.")
        }
        return isPermission ? String(localized: "Review permission") : String(localized: "Review question")
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
            Text(verbatim: row.thread.title).font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s2)
            PlaceLine(providerID: row.thread.providerId, watched: model.watchedByWatcher(row.ref),
                      text: place)
                .padding(.top, Space.s1)
            Text(verbatim: ask).font(.sotto(.body)).foregroundStyle(Palette.ink).lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Space.s3)
            if let command = request.context?.command, !command.isEmpty {
                Text(verbatim: command).font(.mono).foregroundStyle(Palette.codeInk).lineLimit(3)
                    .padding(.horizontal, Space.s3).padding(.vertical, Space.s2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.code, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
                    .padding(.top, Space.s2)
            }
            if asking.thread.requests.count > 1 {
                (asking.thread.requests.count == 2 ? Text("1 more request in this thread")
                    : Text("\(asking.thread.requests.count - 1) more requests in this thread"))
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
                Text(answer?.busy ?? String(localized: "Sending…"))
            }
            .font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
        case .answered:
            HStack(spacing: Space.s2) {
                Spacer(minLength: 0)
                if answerConfirmed { Image(systemName: "checkmark").accessibilityHidden(true) }
                (answerConfirmed ? Text(answer?.done ?? String(localized: "Answered", comment: "A card's answer reached the thread's computer."))
                    : Text("No longer waiting", comment: "A card's request left without the computer confirming the answer."))
            }
            .font(.sotto(.small, .semibold)).foregroundStyle(answerConfirmed ? Palette.accentText : Palette.muted)
            .frame(minHeight: 44)
            .accessibilityElement(children: .combine)
        case .unconfirmed:
            reviewOnly(String(localized: "Not confirmed yet. Check the thread before answering again."))
        case .idle:
            idleActions
        }
    }

    @ViewBuilder private var idleActions: some View {
        let ready = model.canAnswer(request, in: asking.ref) && !model.answering(asking.ref.hostID)
        if !request.supported {
            reviewOnly(String(localized: "Answer this one in the thread."))
        } else if !model.mayAnswer(asking.ref.hostID) {
            reviewOnly(String(localized: "This iPhone can’t answer on \(row.computer) yet.", comment: "%@ is the computer's name."))
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
                    .paragraphDirection()
            }
            Spacer(minLength: 0)
            NavigationLink(value: ThreadRoute(ref: asking.ref)) { Text(reviewWords) }
                .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
        }
    }

    private func questionActions(_ options: [RequestOption], enabled: Bool) -> some View {
        let ownWords = request.questions?.first?.allowFreeText == true ? String(localized: "Write your own") : reviewWords
        return OneTapQuestion(options: options, enabled: enabled, picked: picked) { option in
            send(option, String(localized: "Sending…"), String(localized: "Answered", comment: "A card's answer reached the thread's computer."))
        } more: {
            NavigationLink(value: ThreadRoute(ref: asking.ref)) { Text(ownWords) }
                .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
        }
    }

    private func permissionActions(enabled: Bool) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.s2) {
                NavigationLink(value: ThreadRoute(ref: asking.ref)) { Text(moreWords) }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                Spacer(minLength: 0)
                permissionButtons(enabled: enabled)
            }
            VStack(alignment: .trailing, spacing: Space.s2) {
                HStack(spacing: Space.s2) { permissionButtons(enabled: enabled) }
                NavigationLink(value: ThreadRoute(ref: asking.ref)) { Text(moreWords) }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    private var moreWords: String { request.cardPermissionChoices == nil && request.permissionChoices != nil ? reviewWords : String(localized: "More choices") }

    /// Deny, then Allow once, on the computer's own words. A request with no choices of its own takes Allow and Deny.
    private func permissionButtons(enabled: Bool) -> some View {
        CardPermissionButtons(request: request, enabled: enabled) { choice, allows in
            send(choice, allows ? String(localized: "Allowing…") : String(localized: "Denying…"),
                 allows ? String(localized: "Allowed", comment: "A permission the user allowed from a card.") : String(localized: "Denied", comment: "A permission the user denied from a card."))
        }
    }
}

/// A card's one-tap answer to a question with a few choices: the choices as chips, then the card's own way to say more
/// and Send answer, which stays off until a chip is chosen. Threads and Watcher's page share it, and each says where the
/// chosen answer goes.
struct OneTapQuestion<More: View>: View {
    let options: [RequestOption]
    let enabled: Bool
    @Binding var picked: String?
    let sendID: String?
    let send: (String) -> Void
    let more: More
    init(options: [RequestOption], enabled: Bool, picked: Binding<String?>, sendID: String? = nil,
         send: @escaping (String) -> Void, @ViewBuilder more: () -> More) {
        self.options = options
        self.enabled = enabled
        self._picked = picked
        self.sendID = sendID
        self.send = send
        self.more = more()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            FlowLayout(spacing: Space.s2) {
                ForEach(options) { option in
                    Button { picked = picked == option.id ? nil : option.id } label: { Text(verbatim: option.label) }
                        .buttonStyle(ChipStyle(selected: picked == option.id))
                        .accessibilityAddTraits(picked == option.id ? .isSelected : [])
                }
            }
            .disabled(!enabled)
            HStack(spacing: Space.s2) {
                more
                Spacer(minLength: 0)
                let button = Button("Send answer") { if let picked { send(picked) } }
                    .buttonStyle(PillButtonStyle(kind: .primary, compact: true))
                    .disabled(!enabled || picked == nil)
                if let sendID { button.accessibilityIdentifier(sendID) } else { button }
            }
        }
    }
}

/// A card's permission buttons: Deny, then Allow once, in the provider's own words, and Deny and Allow for a request with
/// no choices of its own. Each press hands over the choice and whether it allows; where it goes is the card's.
struct CardPermissionButtons: View {
    let request: AgentRequest
    let enabled: Bool
    let send: (_ choice: String, _ allows: Bool) -> Void
    var body: some View {
        if let choices = request.cardPermissionChoices {
            let ordered: [PermissionChoice] = choices.sorted { $0.kind == "deny" && $1.kind != "deny" }
            ForEach(ordered) { choice in
                let allows = choice.kind != "deny"
                Button(choice.label) { send(choice.id, allows) }
                    .buttonStyle(PillButtonStyle(kind: allows ? .primary : .soft, compact: true))
                    .disabled(!enabled)
            }
        } else if request.permissionChoices == nil {
            Button("Deny") { send("deny", false) }
                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                .disabled(!enabled)
            Button("Allow") { send("allow", true) }
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
        Group {
            if model.canChangeWatch(row.ref) {
                link.contextMenu {
                    let watched = model.watchedByWatcher(row.ref)
                    Button { Task { await model.setWatched(row.ref, !watched, title: row.thread.title) } } label: {
                        Label(watched ? String(localized: "Stop watching", comment: "Context menu: Watcher stops watching this thread") : String(localized: "Watch", comment: "Context menu: Watcher keeps this thread going"), systemImage: watched ? "eye.slash" : "eye")
                    }
                }
            } else {
                link
            }
        }
        .accessibilityLabel(spokenLabel)
        .accessibilityHint("Opens the thread")
        .accessibilityIdentifier("thread-\(row.id)")
    }
    @ViewBuilder private var link: some View {
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
                Text(verbatim: row.thread.title).font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, Space.s2)
                PlaceLine(providerID: row.thread.providerId, watched: model.watchedByWatcher(row.ref), text: place)
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
    }
    private var place: String {
        let provider = Words.provider(row.thread.providerId)
        guard let project = row.project else {
            return String(localized: "\(provider) on \(row.computer)", comment: "First %@ is the agent's name, such as Codex; second is the computer's name.")
        }
        return String(localized: "\(provider) on \(row.computer) · \(project)",
                      comment: "First %@ is the agent's name, such as Codex; second is the computer's name; third is the project's name.")
    }
    /// The card as VoiceOver reads it.
    private var spokenLabel: String {
        let label = "\(row.thread.title), \(state.words), \(place)"
        return model.watchedByWatcher(row.ref)
            ? String(localized: "\(label), watched by Watcher", comment: "%@ is what VoiceOver reads of the thread before this: its title and where it runs.")
            : label
    }
    /// The step running now when this iPhone holds the thread's detail; otherwise what the state says. The list
    /// a computer shares carries no steps.
    private var liveLine: String {
        if let detail = model.detail(for: row.ref), let step = detail.activities?.last(where: { $0.status == "running" }) {
            return [step.title, step.subject].compactMap { $0 }.joined(separator: " ")
        }
        if state == .compacting { return String(localized: "Making room in the thread’s context.") }
        if state == .waiting { return String(localized: "A background command is still running.") }
        if row.thread.status != "running", !(row.thread.backgroundWork ?? []).isEmpty { return String(localized: "Background agents are still working.") }
        let provider = Words.provider(row.thread.providerId)
        return String(localized: "\(provider) is working on \(row.computer).", comment: "First %@ is the agent's name, such as Codex; second is the computer's name.")
    }
}

// MARK: - Recent and settled

/// Quiet rows on one surface, for Recent and the settled shelf.
private struct ThreadRowList: View {
    let rows: [HostedThread]
    let unread: Set<String>
    var watched: Set<String> = []
    var body: some View {
        let _ = BenchProbe.body("ThreadRowList")
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 {
                    Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, Space.s4 + 20)
                }
                ThreadRow(row: row, unread: unread.contains(row.id), watched: watched.contains(row.id))
            }
        }
        .sottoCard(.plain)
    }
}

/// A finished, failed or settled thread. One that finished while nothing showed it (ADR-0046) has an accent
/// light, a bold title and Just finished until it is opened here or on the desktop. A settled thread says neither
/// that nor Turn failed.
private struct ThreadRow: View {
    let row: HostedThread
    let unread: Bool
    /// Watcher works with it: the owl follows its provider's logo.
    var watched = false
    @EnvironmentObject var model: AppModel
    @Environment(\.sottoDensity) private var density
    private var state: ThreadState { ThreadState(row.thread) }
    /// Settled is quiet: a settled thread whose last turn failed doesn't say so here.
    private var failed: Bool { row.failed }
    var body: some View {
        let _ = BenchProbe.body("ThreadRow")
        Group {
            if model.canChangeWatch(row.ref) {
                link.contextMenu {
                    Button { Task { await model.setWatched(row.ref, !watched, title: row.thread.title) } } label: {
                        Label(watched ? String(localized: "Stop watching", comment: "Context menu: Watcher stops watching this thread") : String(localized: "Watch", comment: "Context menu: Watcher keeps this thread going"), systemImage: watched ? "eye.slash" : "eye")
                    }
                }
            } else {
                link
            }
        }
        .accessibilityLabel(watched ? String(localized: "\(label), watched by Watcher", comment: "%@ is what VoiceOver reads of the thread before this: its title and where it runs.") : label)
        .accessibilityHint("Opens the thread")
        .accessibilityIdentifier("thread-\(row.id)")
    }
    @ViewBuilder private var link: some View {
        NavigationLink(value: ThreadRoute(ref: row.ref)) {
            HStack(alignment: .top, spacing: Space.s3) {
                Light(tone: unread ? .accent : failed ? .danger : .off).padding(.top, 6)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.thread.title).font(.sotto(.body, unread ? .bold : .semibold)).foregroundStyle(Palette.ink)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    PlaceLine(providerID: row.thread.providerId, watched: watched, text: line,
                              tone: failed ? Palette.dangerText : Palette.muted)
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
    }
    /// What the row says under its title: just finished, can't be reached, failed, or where it lives.
    private var line: String {
        if unread { return String(localized: "Just finished · \(row.computer)", comment: "%@ is the computer's name.") }
        if !row.reachable { return "\(row.status.words) · \(row.computer)" }
        if failed { return "\(state.words) · \(row.computer)" }
        return Words.place(row)
    }
    /// The row as VoiceOver reads it; a thread that finished out of sight says so right after its name.
    private var label: String {
        if unread {
            let place = Words.place(row)
            return String(localized: "\(row.thread.title), just finished, not opened yet, \(place)",
                          comment: "First %@ is the thread's title; second is where it runs: its agent, project and computer.")
        }
        if !row.reachable { return "\(row.thread.title), \(row.status.words), \(Words.place(row))" }
        if failed { return "\(row.thread.title), \(state.words), \(Words.place(row))" }
        return "\(row.thread.title), \(Words.place(row))"
    }
}
