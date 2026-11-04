import SwiftUI
import SottoCore

/// The iPhone's side of the to-do list (ADR-0188). It outlives whatever shows it, because the five seconds a check-off waits go
/// on through rolling up and moving to another page: nothing reaches the computer that holds the item until they end, and an
/// app that goes away in those seconds leaves the item unchecked, which loses nothing.
@MainActor final class ToDoStore: ObservableObject {
    @Published private(set) var book = ToDoBook()
    @Published private(set) var open = false
    /// The last press failed. Rolling up reads it.
    @Published private(set) var failed = false
    /// What was new when the list opened, or came while it stood open: marked until it rolls up, though the badge is quiet.
    @Published private(set) var marked: Set<String> = []
    /// Carries a press to the computer that holds the item. Set once, by the model.
    var send: ((ToDoRequest, String) async throws -> Void)?
    private var holds: [String: Task<Void, Never>] = [:]
    private var askedSeen: Set<String> = []

    func take(hostID: String, items: [ToDoItem]) {
        for key in book.take(hostID: hostID, items: items) { holds.removeValue(forKey: key)?.cancel() }
        if open { noteSeen() }
    }
    func forget(hostID: String) {
        for key in book.forget(hostID: hostID) { holds.removeValue(forKey: key)?.cancel() }
    }
    func toggle() { if open { rollUp() } else { unroll() } }
    func unroll() { open = true; noteSeen() }
    func rollUp() { open = false; failed = false; marked = []; askedSeen = [] }
    /// The list's last row going rolls it up, once its press has an answer. A list opened empty stays, for adding to.
    func rowsChanged(from before: Int, to now: Int) { if open && before > 0 && now == 0 { rollUp() } }
    /// Opening quiets the badge on each computer, and so does anything that comes while it stands open.
    private func noteSeen() {
        let fresh = book.rows.filter { !$0.item.seen }
        marked.formUnion(fresh.map(\.id))
        for hostID in Set(fresh.filter { !askedSeen.contains($0.id) }.map(\.hostID)) {
            askedSeen.formUnion(fresh.filter { $0.hostID == hostID }.map(\.id))
            Task { try? await send?(.seen, hostID) }
        }
    }
    /// Takes it off in five seconds, unless Undo comes first.
    func check(_ row: ToDoRow) {
        guard holds[row.id] == nil else { return }
        failed = false
        book.hold(row.id)
        holds[row.id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: ToDoWire.undoSeconds * 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            self.book.sending(row.id)
            do { try await self.send?(.check(id: row.item.id, didNotWork: nil), row.hostID) } catch {
                guard !Task.isCancelled else { return }
                self.book.release(row.id)
                self.holds[row.id] = nil
                self.fail()
            }
        }
    }
    func undo(_ row: ToDoRow) {
        guard !row.sending else { return }
        holds.removeValue(forKey: row.id)?.cancel()
        book.release(row.id)
    }
    /// It did not work: the user's words go at once, since they asked to send them. False leaves the words to send again.
    func didNotWork(_ row: ToDoRow, words: String) async -> Bool {
        failed = false
        do { try await send?(.check(id: row.item.id, didNotWork: words), row.hostID); return true } catch { fail(); return false }
    }
    func add(_ title: String) async -> Bool {
        guard let host = book.firstHost else { return false }
        failed = false
        do { try await send?(.add(title: title), host); return true } catch { fail(); return false }
    }
    /// A press that failed says so, even with the list rolled up by then.
    private func fail() { failed = true; if !open { unroll() } }
}

/// One of a prototype's pages, and where it opens on the computer that serves it.
struct PrototypePageLink: Identifiable {
    let page: RequestPage
    let url: URL
    var id: String { page.token }
}

/// The list's icon, wherever it stands: a tile on the Duo's rail, in a page's heading, or in a thread's bar. It shows only
/// where a connected computer keeps a list.
struct ToDoIcon: View {
    @EnvironmentObject var toDos: ToDoStore
    var inBar = false
    var body: some View {
        if toDos.book.offered {
            Button { toDos.toggle() } label: {
                Group {
                    if inBar {
                        Image(systemName: "checklist").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.ink)
                            .frame(width: 32, height: 32)
                            .background(Palette.fillSoft, in: Circle())
                            .overlay(Circle().strokeBorder(Palette.hairline, lineWidth: 1))
                    } else {
                        Image(systemName: "checklist")
                    }
                }
                .frame(width: inBar ? 44 : nil, height: inBar ? 44 : nil)
                .contentShape(Rectangle())
            }
            .modifier(CircleIfNotBar(inBar: inBar))
            // Outside the button, since a button's own shape may clip what it draws.
            .overlay(alignment: .topTrailing) { badge.offset(x: inBar ? 0 : 3, y: inBar ? 0 : -3).allowsHitTesting(false) }
            .accessibilityLabel(label)
            .accessibilityHint(toDos.open ? String(localized: "Roll up the list") : String(localized: "Unroll the list"))
            .accessibilityIdentifier("to-do-icon")
        }
    }
    private var loud: Bool { !toDos.open && toDos.book.unseen > 0 }
    @ViewBuilder private var badge: some View {
        let count = loud ? toDos.book.unseen : toDos.book.left
        if count > 0 { DuoRailBadge(count: count, warning: loud).accessibilityHidden(true).accessibilityIdentifier("to-do-badge") }
    }
    private var label: String {
        let count = toDos.book.left, n = toDos.book.unseen
        return loud ? String(localized: "To-do, \(count) to do, \(n) new.") : String(localized: "To-do, \(count) to do.")
    }
}

private struct CircleIfNotBar: ViewModifier {
    let inBar: Bool
    func body(content: Content) -> some View {
        if inBar { content.buttonStyle(.plain) } else { content.buttonStyle(GlassCircleStyle()) }
    }
}

/// The list as it unrolls downward like a scroll, over the page: as long as what it holds up to the page, with a roll at its
/// foot that travels with it and thins as the paper leaves it. Reduced motion fades it in place. A press outside rolls it up.
struct ToDoScroll: View {
    @EnvironmentObject var toDos: ToDoStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// How far down the page the paper starts, under whatever bar or heading stands there.
    let top: CGFloat
    let wide: Bool
    var body: some View {
        ZStack(alignment: wide ? .topTrailing : .top) {
            if toDos.open {
                Color.clear.contentShape(Rectangle()).onTapGesture { toDos.rollUp() }
                    .accessibilityHidden(true)
                ToDoSheet()
                    .frame(maxWidth: wide ? 400 : .infinity)
                    .padding(.horizontal, Space.s2)
                    .padding(.top, top)
                    .padding(.bottom, Space.s5)
                    .transition(reduceMotion ? AnyTransition.opacity : .modifier(active: RollReveal(progress: 0), identity: RollReveal(progress: 1)))
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .timingCurve(0.32, 0.72, 0.28, 1, duration: toDos.open ? 0.72 : 0.4), value: toDos.open)
        .onChange(of: toDos.book.rows.count) { before, now in toDos.rowsChanged(from: before, to: now) }
    }
}

/// Unrolls what it holds from its top edge, with the roll at the edge of what shows.
private struct RollReveal: ViewModifier, Animatable {
    var progress: CGFloat
    var animatableData: CGFloat { get { progress } set { progress = newValue } }
    func body(content: Content) -> some View {
        content
            .mask(alignment: .top) {
                GeometryReader { place in Rectangle().frame(height: place.size.height * progress) }
            }
            .overlay(alignment: .top) {
                GeometryReader { place in
                    Capsule().fill(Palette.overlay)
                        .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
                        .frame(height: 24 - 8 * progress)
                        .offset(y: max(0, place.size.height * progress - 8))
                }
                .accessibilityHidden(true)
                .allowsHitTesting(false)
            }
    }
}

private struct ToDoSheet: View {
    @EnvironmentObject var toDos: ToDoStore
    @State private var title = ""
    var body: some View {
        let count = toDos.book.left
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Text("To-do").font(.sotto(.lead, .semibold)).foregroundStyle(Palette.ink).accessibilityAddTraits(.isHeader)
                Text("\(count) to do").font(.sotto(.small)).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, Space.s4).padding(.top, Space.s3).padding(.bottom, Space.s2)
            // Only as long as what it holds, and it scrolls once that is more than the page has.
            ViewThatFits(in: .vertical) {
                rows
                ScrollView { rows }.scrollBounceBehavior(.basedOnSize)
            }
            if toDos.failed {
                Text("Sotto could not change your list. Try again.").font(.sotto(.small)).foregroundStyle(Palette.warningText)
                    .padding(.horizontal, Space.s4).padding(.top, Space.s2)
                    .accessibilityIdentifier("to-do-failure")
            }
            Divider().overlay(Palette.hairline).padding(.top, Space.s2)
            HStack(spacing: Space.s2) {
                TextField("Add your own", text: $title)
                    .font(.sotto(.small))
                    .submitLabel(.done)
                    .onSubmit(add)
                    .padding(.horizontal, Space.s3).frame(minHeight: 38)
                    .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("to-do-add")
                Button { toDos.rollUp() } label: {
                    Label("Roll up", systemImage: "chevron.up").font(.sotto(.small)).foregroundStyle(Palette.muted)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("to-do-roll-up")
            }
            .padding(.horizontal, Space.s3).padding(.top, Space.s1).padding(.bottom, Space.s4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.raised, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Palette.hairline, lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 16, y: 8)
        .accessibilityIdentifier("to-do-scroll")
    }
    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            if toDos.book.rows.isEmpty {
                Text("Nothing left to do.").font(.sotto(.small)).foregroundStyle(Palette.muted).padding(Space.s3)
            }
            ForEach(toDos.book.rows) { row in
                ToDoRowView(row: row)
                if row.id != toDos.book.rows.last?.id { Divider().overlay(Palette.hairline) }
            }
        }
        .padding(.horizontal, Space.s2)
    }
    private func add() {
        let words = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ToDoWire.titleMax))
        guard !words.isEmpty else { return }
        title = ""
        // A failure gives the words back to send again, unless the user has moved on to writing others.
        Task { if await !toDos.add(words), title.isEmpty { title = words } }
    }
}

private struct ToDoRowView: View {
    @EnvironmentObject var toDos: ToDoStore
    @EnvironmentObject var model: AppModel
    let row: ToDoRow
    @State private var stepsOpen = false
    @State private var noting = false
    @State private var note = ""
    @State private var sending = false
    @FocusState private var noteFocused: Bool
    @Environment(\.openURL) private var openURL
    private var item: ToDoItem { row.item }
    private var ref: ThreadRef? { item.threadId.map { ThreadRef(hostID: row.hostID, threadID: $0) } }
    /// A prototype's is Sotto's own words, so it reads in the user's language; every other is in its author's words.
    private var shownTitle: String { item.by == "prototype" ? String(localized: "Review the prototype") : item.title }
    var body: some View {
        if row.held { held } else { open }
    }
    private var held: some View {
        let title = shownTitle
        return HStack(spacing: Space.s2) {
            Text("Checked off: \(title)").font(.sotto(.small)).foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !row.sending {
                Button("Undo") { toDos.undo(row) }.buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                    .accessibilityIdentifier("to-do-undo")
            }
        }
        .padding(.vertical, Space.s2).padding(.horizontal, Space.s2)
    }
    private var open: some View {
        let title = shownTitle
        return HStack(alignment: .top, spacing: Space.s2) {
            Button { toDos.check(row) } label: {
                Circle().strokeBorder(Palette.border, lineWidth: 1.5).frame(width: 22, height: 22)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.top, -Space.s2)
            .accessibilityLabel("Check off: \(title)")
            .accessibilityIdentifier("to-do-check-\(item.id)")
            VStack(alignment: .leading, spacing: Space.s1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if toDos.marked.contains(row.id) || !item.seen {
                        Circle().fill(Palette.warning).frame(width: 7, height: 7).accessibilityLabel("New")
                    }
                    Text(verbatim: title).font(.sotto(.body, .medium)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                }
                if let why = item.why { Text(verbatim: why).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true) }
                source
                if let link = item.link, let url = URL(string: link.url), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                    Button { openURL(url) } label: { Label { Text(verbatim: link.label) } icon: { Image(systemName: "arrow.up.right") } }
                        .buttonStyle(.plain).font(.sotto(.small)).foregroundStyle(Palette.accentText).frame(minHeight: 30)
                }
                if let ref, item.by == "prototype" {
                    ForEach(model.prototypePages(ref)) { opening in
                        // The computer's page route clears the mark as the page loads, which takes this to-do off.
                        Button { openURL(opening.url) } label: {
                            Label { Text("Open the prototype") } icon: { Image(systemName: "macwindow") }
                        }
                        .buttonStyle(.plain).font(.sotto(.small)).foregroundStyle(Palette.accentText).frame(minHeight: 30)
                        .accessibilityLabel("Open the prototype, \(opening.page.name)")
                    }
                }
                if let steps = item.steps, !steps.isEmpty {
                    Button { stepsOpen.toggle() } label: { stepsOpen ? Text("Hide the steps") : Text("Show the steps") }
                        .buttonStyle(.plain).font(.sotto(.small)).foregroundStyle(Palette.accentText).frame(minHeight: 30)
                    if stepsOpen {
                        VStack(alignment: .leading, spacing: Space.s1) {
                            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                                Text(verbatim: "\(index + 1). \(step)").font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(Space.s2).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 10))
                    }
                }
                if item.waits { didNotWork }
            }
        }
        .padding(.top, Space.s3).padding(.bottom, Space.s2)
    }
    /// Who put it there, and on which computer when there is more than one, as the thread's own words are that thread's.
    @ViewBuilder private var source: some View {
        let thread = ref.flatMap { model.thread($0) }
        HStack(spacing: Space.s2) {
            if let ref, let thread {
                Button { toDos.rollUp(); model.openToDoThread(ref) } label: { Text(verbatim: thread.title).lineLimit(1) }
                    .buttonStyle(.plain).foregroundStyle(Palette.muted).frame(minHeight: 30)
            } else if item.by == "user" { Text("You added this") }
            else if item.by == "watcher" { Text("Watcher added this") }
            else if item.by == "thread" { Text("A thread added this") }
            if model.computerCount > 1 { Text(verbatim: model.name(row.hostID)) }
            if item.waits { Text("This thread is waiting").foregroundStyle(Palette.warningText) }
        }
        .font(.sotto(.caption)).foregroundStyle(Palette.muted)
    }
    @ViewBuilder private var didNotWork: some View {
        if noting {
            VStack(alignment: .leading, spacing: Space.s2) {
                TextField("Say what happened", text: $note, axis: .vertical)
                    .font(.sotto(.small)).focused($noteFocused)
                    .padding(Space.s2).background(Palette.canvas, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("to-do-note")
                HStack(spacing: Space.s2) {
                    Button("Tell the thread") { tell() }.buttonStyle(PillButtonStyle(kind: .primary, compact: true))
                        .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                    Button("Cancel") { noting = false; note = "" }.buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                }
            }
            .onAppear { noteFocused = true }
        } else {
            Button("It didn’t work") { noting = true }
                .buttonStyle(.plain).font(.sotto(.small)).foregroundStyle(Palette.accentText).frame(minHeight: 30)
                .accessibilityIdentifier("to-do-did-not-work")
        }
    }
    private func tell() {
        let words = String(note.trimmingCharacters(in: .whitespacesAndNewlines).prefix(ToDoWire.noteMax))
        guard !words.isEmpty, !sending else { return }
        sending = true
        // Success takes the row away; a failure leaves the words in place to send again.
        Task { _ = await toDos.didNotWork(row, words: words); sending = false }
    }
}
