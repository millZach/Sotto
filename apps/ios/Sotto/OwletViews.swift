import SwiftUI
import SottoCore

// Owlets on the iPhone (ADR-0213, the first slice's second part): the Owlets tab beside Threads, its list of owlets, the
// unfolded Duo's sidebar of them beside an owlet's thread, and New owlet and Edit owlet. An owlet's thread opens as any
// thread does, and its cards are answered there. Zach's picks of November 21, 2026 (docs/prototypes/owlets-iphone/):
// the tab after Threads, Edit owlet in the thread's ••• menu, and the owlets in the Duo's sidebar beside an owlet.

extension ThreadSummary {
    /// The name a thread goes by on its page: an owlet's own name, which a rename changes, or the thread's title.
    var shownTitle: String { owlet?.name ?? title }
}

/// An owlet's own mark (Zach's pick C of `docs/prototypes/owlet-mark/`): a small round owl in lines whose head dips a
/// little in the middle, with two big eyes, a beak and a face of its own, chosen from its thread ID so a rename keeps it
/// and every window draws the same one (`OwletMark.tsx` on the desktop). No ear tufts and no fill, so it never reads as
/// Watcher's owl. It takes the colour of whatever holds it.
struct OwletMark: View {
    let threadID: String
    var size: CGFloat = 28
    /// The plain face, round eyes and no chest mark, for the Owlets tab, which stands for every owlet.
    var plain = false
    var body: some View {
        let look = plain ? (face: 0, chest: 0) : Owlets.look(threadID: threadID)
        Canvas { context, canvas in
            context.scaleBy(x: canvas.width / 24, y: canvas.height / 24)
            let line = StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)
            context.stroke(OwletShapes.body, with: .foreground, style: line)
            OwletShapes.face(look.face, in: context, line: line)
            context.fill(OwletShapes.beak, with: .foreground)
            context.stroke(OwletShapes.beak, with: .foreground, style: StrokeStyle(lineWidth: 1, lineJoin: .round))
            OwletShapes.chest(look.chest, in: context, line: line)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The mark's lines, on the desktop's 24-point grid, written out from its SVG paths.
private enum OwletShapes {
    static var body: Path {
        var path = Path()
        path.move(to: CGPoint(x: 5, y: 10.4))
        path.addCurve(to: CGPoint(x: 9.9, y: 3.6), control1: CGPoint(x: 5, y: 6.4), control2: CGPoint(x: 7.3, y: 3.6))
        path.addCurve(to: CGPoint(x: 12, y: 4.9), control1: CGPoint(x: 10.9, y: 3.6), control2: CGPoint(x: 11.6, y: 4.2))
        path.addCurve(to: CGPoint(x: 14.1, y: 3.6), control1: CGPoint(x: 12.4, y: 4.2), control2: CGPoint(x: 13.1, y: 3.6))
        path.addCurve(to: CGPoint(x: 19, y: 10.4), control1: CGPoint(x: 16.7, y: 3.6), control2: CGPoint(x: 19, y: 6.4))
        path.addLine(to: CGPoint(x: 19, y: 14.8))
        path.addCurve(to: CGPoint(x: 12, y: 20.9), control1: CGPoint(x: 19, y: 18.5), control2: CGPoint(x: 15.9, y: 20.9))
        path.addCurve(to: CGPoint(x: 5, y: 14.8), control1: CGPoint(x: 8.1, y: 20.9), control2: CGPoint(x: 5, y: 18.5))
        path.closeSubpath()
        return path
    }
    static var beak: Path {
        var path = Path()
        path.move(to: CGPoint(x: 11.2, y: 13.6))
        path.addLine(to: CGPoint(x: 12.8, y: 13.6))
        path.addLine(to: CGPoint(x: 12, y: 14.9))
        path.closeSubpath()
        return path
    }
    private static let left = CGPoint(x: 9.3, y: 10.4), right = CGPoint(x: 14.7, y: 10.4)
    private static func circle(_ center: CGPoint, _ radius: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
    }
    private static var rings: Path {
        var path = circle(left, 2.5)
        path.addPath(circle(right, 2.5))
        return path
    }
    private static func pupils(dx: CGFloat = 0, radius: CGFloat = 1) -> Path {
        var path = circle(CGPoint(x: left.x + dx, y: left.y), radius)
        path.addPath(circle(CGPoint(x: right.x + dx, y: right.y), radius))
        return path
    }
    /// Round, glancing, wide, smiling and sleepy eyes.
    static func face(_ face: Int, in context: GraphicsContext, line: StrokeStyle) {
        switch face {
        case 3:
            var smile = Path()
            smile.move(to: CGPoint(x: 7, y: 11.2))
            smile.addCurve(to: CGPoint(x: 9.3, y: 9.4), control1: CGPoint(x: 7.6, y: 10), control2: CGPoint(x: 8.4, y: 9.4))
            smile.addCurve(to: CGPoint(x: 11.6, y: 11.2), control1: CGPoint(x: 10.2, y: 9.4), control2: CGPoint(x: 11, y: 10))
            smile.move(to: CGPoint(x: 12.4, y: 11.2))
            smile.addCurve(to: CGPoint(x: 14.7, y: 9.4), control1: CGPoint(x: 13, y: 10), control2: CGPoint(x: 13.8, y: 9.4))
            smile.addCurve(to: CGPoint(x: 17, y: 11.2), control1: CGPoint(x: 15.6, y: 9.4), control2: CGPoint(x: 16.4, y: 10))
            context.stroke(smile, with: .foreground, style: line)
        case 4:
            context.stroke(rings, with: .foreground, style: line)
            var lids = Path()
            lids.move(to: CGPoint(x: 6.8, y: 10.4)); lids.addLine(to: CGPoint(x: 11.8, y: 10.4))
            lids.move(to: CGPoint(x: 12.2, y: 10.4)); lids.addLine(to: CGPoint(x: 17.2, y: 10.4))
            context.stroke(lids, with: .foreground, style: line)
        default:
            context.stroke(rings, with: .foreground, style: line)
            let pupils = face == 1 ? pupils(dx: 0.8, radius: 0.9) : face == 2 ? pupils(radius: 1.6) : pupils()
            context.fill(pupils, with: .foreground)
        }
    }
    /// No mark, three dots, or a small chevron on its chest.
    static func chest(_ chest: Int, in context: GraphicsContext, line: StrokeStyle) {
        switch chest {
        case 1:
            var dots = circle(CGPoint(x: 10.5, y: 17.6), 0.95)
            dots.addPath(circle(CGPoint(x: 12, y: 18.3), 0.95))
            dots.addPath(circle(CGPoint(x: 13.5, y: 17.6), 0.95))
            context.fill(dots, with: .foreground)
        case 2:
            var chevron = Path()
            chevron.move(to: CGPoint(x: 10.6, y: 17.4))
            chevron.addLine(to: CGPoint(x: 12, y: 18.3))
            chevron.addLine(to: CGPoint(x: 13.4, y: 17.4))
            context.stroke(chevron, with: .foreground, style: line)
        default: break
        }
    }
}

// MARK: - The Owlets tab

/// The Owlets tab's page: New owlet, a search, the owlets waiting on the user under Needs you, then the rest newest first
/// (R2 rows, Zach's pick on November 19, 2026). A press opens an owlet's thread over the page, as a row on Threads does.
/// It watches the model only while it shows, as Threads does (#2120).
struct OwletsView: View, Equatable {
    @Environment(\.unwatchedModel) private var unwatchedModel
    private var model: AppModel { unwatchedModel! }
    @State private var revision = 0
    @State private var showing = false
    let open: (ThreadRef) -> Void
    /// Its caller's `open` always pushes onto the same path, so the tabs drawing again never draws it again.
    static func == (lhs: OwletsView, rhs: OwletsView) -> Bool { true }
    @State private var creating = false
    @State private var query = ""
    @FocusState private var searching: Bool
    @Environment(\.duoLayout) private var duo
    @Environment(\.sottoTheme) private var theme
    private var unfolded: Bool { duo.sideways || duo == .upright }

    var body: some View {
        let _ = revision
        let list = model.owletList(query: query)
        SheetPage(warm: list.needsYouCount > 0) {
            VStack(alignment: .leading, spacing: 0) {
                PageHeading(String(localized: "Owlets")) {
                    // On the iPhone Duo, New owlet is the rail's + while this tab shows, as New thread is on Threads.
                    if duo == .none {
                        Button { creating = true } label: { Image(systemName: "plus") }
                            .buttonStyle(GlassCircleStyle())
                            .accessibilityLabel("New owlet")
                            .accessibilityIdentifier("new-owlet")
                    }
                }
                .padding(.top, unfolded ? Space.s3 : Space.s1)
                if list.total > 0 { searchPill.padding(.top, Space.s3) }
                if list.total == 0 {
                    empty
                } else if list.isEmpty {
                    Text("No owlet matches.").font(.sotto(.body)).foregroundStyle(Palette.muted).padding(.top, Space.s5)
                } else {
                    OwletRows(list: list, chosen: nil, identifier: "owlet-", open: open)
                }
            }
            .readingWidth(on: !unfolded)
        }
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await model.refresh() }
        .navigationTitle("Owlets")
        .toolbar(.hidden, for: .navigationBar)
        .duoSheet(isPresented: $creating, onDismiss: { model.creationFeedback = nil }) {
            OwletSetupSheet(editing: nil, opened: { ref in open(ref) })
        }
        .onAppear { showing = true; revision &+= 1 }
        .onDisappear { showing = false }
        .onReceive(model.objectWillChange) { _ in if showing { revision &+= 1 } }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            Text("An owlet is a helper you name and give a role. It keeps one thread in a folder of its own on one computer, with the same tools and cards as any thread. It runs when you talk to it.")
                .font(.sotto(.body)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .paragraphDirection()
            Button { creating = true } label: { Text("New owlet").font(.sotto(.body, .semibold)) }
                .buttonStyle(PillButtonStyle(kind: .primary))
                .accessibilityIdentifier("new-owlet-empty")
        }
        .padding(.top, Space.s5)
    }

    private var searchPill: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.muted).accessibilityHidden(true)
            TextField("Search owlets", text: $query, prompt: Text("Search owlets").foregroundStyle(Palette.placeholder))
                .focused($searching)
                .font(.sotto(.body))
                .foregroundStyle(Palette.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { searching = false }
                .accessibilityLabel("Search owlets")
                .accessibilityIdentifier("owlet-search")
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
    }
}

/// Needs you, then every other owlet, as the Owlets tab and the Duo's sidebar list them.
private struct OwletRows: View {
    let list: OwletList
    let chosen: ThreadRef?
    let identifier: String
    let open: (ThreadRef) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !list.needsYou.isEmpty {
                ThreadListHeading(title: String(localized: "Needs you"), count: list.needsYou.count, id: "owlets-needs")
                ForEach(list.needsYou) { row in OwletRow(row: row, needsYou: true, chosen: row.ref == chosen, identifier: identifier) { open(row.ref) } }
            }
            if !list.rest.isEmpty {
                ThreadListHeading(title: String(localized: "Owlets"), count: list.rest.count, id: "owlets-rest")
                ForEach(list.rest) { row in OwletRow(row: row, needsYou: false, chosen: row.ref == chosen, identifier: identifier) { open(row.ref) } }
            }
        }
    }
}

/// One owlet (R2): its mark, its name with its role beside it, and under them its home computer and what it last did.
/// One waiting on the user says Needs you; one with news nobody has seen carries the unread dot.
private struct OwletRow: View {
    let row: HostedThread
    let needsYou: Bool
    let chosen: Bool
    let identifier: String
    let open: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    private var owlet: ThreadOwlet { row.thread.owlet ?? ThreadOwlet(name: row.thread.title, role: "") }
    private var unread: Bool { !needsYou && OwletList.unread(row) }
    /// What it last did: the request it waits on, a computer that can't be reached, that it never ran, that it just
    /// finished, or its thread's state.
    private var last: String {
        let state = ThreadState(row.thread)
        if needsYou { return state.words }
        if !row.reachable { return row.status.words }
        if row.thread.nativeSessionStarted == false { return String(localized: "Not run yet", comment: "An owlet nobody has talked to yet.") }
        if row.finishedUnread { return String(localized: "Just finished", comment: "An owlet that finished while nothing showed it.") }
        return state.words
    }
    var body: some View {
        let large = typeSize.isAccessibilitySize
        let ago = Words.agoShort(row.thread.summary?.lastMessageAt)
        Button(action: open) {
            HStack(alignment: .top, spacing: Space.s3) {
                OwletMark(threadID: row.thread.id, size: 30)
                    .foregroundStyle(chosen ? Palette.accentText : Palette.ink)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                        Text(verbatim: owlet.name).font(.sotto(.body, unread ? .bold : .semibold))
                            .foregroundStyle(chosen ? Palette.accentText : Palette.ink).lineLimit(1).layoutPriority(1)
                        if !owlet.role.isEmpty {
                            Text(verbatim: owlet.role).font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(large ? 3 : 1)
                        }
                        Spacer(minLength: Space.s1)
                        if needsYou {
                            Text("Needs you").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.warningText).lineLimit(1).fixedSize()
                        } else {
                            if unread { Light(tone: .accent, size: 8).accessibilityHidden(true) }
                            if let ago { Text(ago).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1).fixedSize() }
                        }
                    }
                    Text(verbatim: "\(row.computer) · \(last)")
                        .font(.sotto(.small)).foregroundStyle(row.failed ? Palette.dangerText : Palette.muted)
                        .lineLimit(large ? 3 : 1)
                }
            }
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.s2 + 2)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background { if chosen { RoundedRectangle(cornerRadius: Radius.md, style: .continuous).fill(ThemeRole(.accentSurface)) } }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: spoken))
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint("Opens the owlet’s thread")
        .accessibilityIdentifier("\(identifier)\(row.id)")
    }
    private var spoken: String {
        let unreadWords = unread ? String(localized: "not opened yet", comment: "Read after an owlet's name when it has news nobody has seen.") : nil
        return [owlet.name, owlet.role.isEmpty ? nil : owlet.role, needsYou ? String(localized: "Needs you") : nil, last, row.computer, unreadWords]
            .compactMap { $0 }.joined(separator: ", ")
    }
}

/// The owlets beside an owlet's thread on the unfolded Duo, as the desktop's Owlets page lists them (Zach's pick A,
/// November 21, 2026). Upright it comes over the page with New owlet of its own; sideways the rail's + is New owlet.
struct OwletSidebar: View, Equatable {
    @EnvironmentObject var model: AppModel
    let open: (ThreadRef) -> Void
    var width: CGFloat = 280
    var newOwlet = false
    @State private var creating = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Space.s3) {
                    Text("Owlets").font(.sotto(.title, .bold)).foregroundStyle(Palette.ink).accessibilityAddTraits(.isHeader)
                    Spacer(minLength: Space.s2)
                    if newOwlet {
                        Button { creating = true } label: { Image(systemName: "plus") }
                            .buttonStyle(GlassCircleStyle())
                            .accessibilityLabel("New owlet")
                            .accessibilityIdentifier("sidebar-new-owlet")
                    }
                }
                .frame(minHeight: 44)
                .padding(.horizontal, Space.s2)
                .padding(.top, Space.s3)
                OwletRows(list: model.owletList(), chosen: model.selected, identifier: "sidebar-owlet-", open: open)
            }
            .padding(.horizontal, Space.s2)
            .padding(.bottom, Space.s6)
        }
        .mask {
            VStack(spacing: 0) {
                Rectangle()
                LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: 40)
            }
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .frame(width: width)
        .background(Palette.surface.opacity(0.7))
        .overlay(alignment: .trailing) { Rectangle().fill(Palette.hairline).frame(width: 1) }
        .accessibilityIdentifier("duo-sidebar-owlets")
        .duoSheet(isPresented: $creating, onDismiss: { model.creationFeedback = nil }) {
            OwletSetupSheet(editing: nil, opened: open)
        }
    }
    static func == (lhs: OwletSidebar, rhs: OwletSidebar) -> Bool { lhs.width == rhs.width && lhs.newOwlet == rhs.newOwlet }
}

// MARK: - New owlet and Edit owlet

/// New owlet: its name, its role, its home computer where more than one makes owlets, and its model, effort and
/// permission mode, as the desktop's setup asks (ADR-0213). Edit owlet changes its name and role; its model and permission
/// mode change in its thread, as any thread's do. The computer makes its folder and checks everything again.
struct OwletSetupSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var systemDismiss
    @Environment(\.sheetClose) private var sheetClose
    private func dismiss() { if let sheetClose { sheetClose() } else { systemDismiss() } }
    /// The owlet being changed, or nil for a new one.
    let editing: ThreadRef?
    let opened: (ThreadRef) -> Void
    @State private var name = ""
    @State private var role = ""
    @State private var hostID = ""
    @State private var modelID = ""
    @State private var effort = ""
    @State private var permissionID = ""
    @State private var heldBack = false
    @State private var busy = false
    @State private var error: String?
    @State private var started = false
    @FocusState private var nameFocused: Bool

    private var current: ThreadSummary? { editing.flatMap { model.thread($0) } }
    private var home: String { editing?.hostID ?? hostID }
    private var homeName: String { home.isEmpty ? "" : model.name(home) }
    private var hosts: [String] { model.owletHostIDs.filter { model.online($0) } }
    private var models: [ThreadModel] { home.isEmpty ? [] : model.owletModels(home) }
    private var chosenModel: ThreadModel? { models.first { $0.id == modelID } }
    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var nameError: String? {
        guard !trimmed.isEmpty else { return nil }
        switch Owlets.nameProblem(trimmed) {
        case .long?: return String(localized: "Keep the name to 40 characters.")
        case .characters?: return String(localized: "Use letters, numbers, spaces and hyphens in the name.")
        case .empty?, nil: break
        }
        let taken = model.owletList().needsYou.contains(where: sameName) || model.owletList().rest.contains(where: sameName)
        return taken ? String(localized: "An owlet on this computer already has that name.") : nil
    }
    private func sameName(_ row: HostedThread) -> Bool {
        row.ref.hostID == home && row.ref != editing && row.thread.owlet.map { Owlets.sameName($0.name, trimmed) } == true
    }
    private var roleTooLong: Bool { role.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > Owlets.roleMax }
    private var ready: Bool {
        guard !busy, !trimmed.isEmpty, nameError == nil, !roleTooLong, !home.isEmpty, model.online(home) else { return false }
        if editing != nil {
            return trimmed != current?.owlet?.name || role.trimmingCharacters(in: .whitespacesAndNewlines) != current?.owlet?.role
        }
        guard let chosenModel, let permission = chosenModel.permissions.first(where: { $0.id == permissionID }) else { return false }
        return !permission.grants || model.mayAnswer(home)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: Space.s3) {
                    fields
                    // An owlet this iPhone asked for and never heard back about: check again or dismiss it, as New thread offers.
                    if editing == nil {
                        ForEach(model.pendingCreations.filter { $0.hostID == hostID }) { CreationPendingRow(operation: $0) }
                    }
                    if let error {
                        Text(error).font(.sotto(.small)).foregroundStyle(Palette.dangerText)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("owlet-setup-error")
                    }
                }
                .padding(.horizontal, Space.gutter).padding(.top, Space.s4).padding(.bottom, Space.s6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .foregroundStyle(Palette.ink)
        .background { PageGround().ignoresSafeArea() }
        .environment(\.sottoOnSheet, true)
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
        .preference(key: DuoSheetHeld.self, value: busy)
        .onAppear(perform: start)
        .onChange(of: hostID) { _, _ in chooseModel() }
        // A home computer that stops being reachable, or stops making owlets, gives way to one that still does.
        .onChange(of: hosts) { _, now in if editing == nil, !now.contains(hostID) { hostID = now.first ?? "" } }
        .onChange(of: modelID) { _, _ in resetOptions() }
    }

    private var header: some View {
        HStack(spacing: Space.s2) {
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .font(.sotto(.body))
                .frame(minWidth: 44, minHeight: 44)
                .disabled(busy)
                .accessibilityIdentifier("owlet-setup-cancel")
            Text(editing == nil ? String(localized: "New owlet") : String(localized: "Edit \(current?.owlet?.name ?? "")", comment: "%@ is the owlet's name."))
                .font(.sotto(.body, .semibold)).lineLimit(1)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            Button { submit() } label: {
                Text(editing == nil ? String(localized: "Make owlet") : String(localized: "Save")).font(.sotto(.body, .semibold))
            }
            .frame(minWidth: 44, minHeight: 44)
            .disabled(!ready)
            .accessibilityIdentifier("owlet-setup-save")
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s3)
    }

    @ViewBuilder private var fields: some View {
        if editing == nil && hosts.isEmpty {
            FieldNote(text: String(localized: "No computer you reach makes owlets now. Owlets come with Sotto Owl on the computer."))
        } else {
            labelled(String(localized: "Name")) {
                TextField("Name", text: $name, prompt: Text("Such as Tawny").foregroundStyle(Palette.placeholder))
                    .focused($nameFocused)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .accessibilityIdentifier("owlet-name")
            }
            if let nameError { FieldNote(text: nameError, warm: true) }
            labelled(String(localized: "Role")) {
                TextField("Role", text: $role, prompt: Text("Such as Keeps my inbox").foregroundStyle(Palette.placeholder), axis: .vertical)
                    .lineLimit(1...4)
                    .accessibilityIdentifier("owlet-role")
            }
            FieldNote(text: roleTooLong ? String(localized: "Keep the role to 200 characters.") : String(localized: "What it does for you, in a few words."), warm: roleTooLong)
            if editing != nil {
                FieldNote(text: String(localized: "On \(homeName). Change its model and permission mode in its thread, as any thread’s.", comment: "%@ is the owlet's home computer."))
            } else {
                if hosts.count > 1 {
                    FieldBox(label: String(localized: "Home computer"), value: homeName, identifier: "owlet-home") {
                        Picker("Home computer", selection: $hostID) {
                            ForEach(hosts, id: \.self) { Text(verbatim: model.name($0)).tag($0) }
                        }
                    }
                    FieldNote(text: String(localized: "An owlet lives on one computer. If that computer is asleep, it can’t run."))
                }
                if models.isEmpty {
                    FieldNote(text: String(localized: "Connect Claude Code or Codex on \(homeName) to make an owlet there. Owlets run only on those two, whose own memory Sotto turns off.", comment: "%@ is the computer's name."), warm: true)
                } else {
                    modelFields
                }
                if !trimmed.isEmpty, nameError == nil {
                    FieldNote(text: String(localized: "Its folder: \(Interface.isolated(Owlets.folderLabel(trimmed))) on \(homeName). Sotto makes it, and its thread and its files live there.", comment: "First %@ is like Owlets/Tawny; second is the computer's name."))
                }
                FieldNote(text: String(localized: "It uses the plugin accounts kept for every project. Choose one for its folder alone in Settings › Plugins on the computer."))
            }
        }
    }

    @ViewBuilder private var modelFields: some View {
        FieldBox(label: String(localized: "Model", comment: "The field for the model a new thread uses."), value: chosenModel?.label ?? String(localized: "Choose a model"), identifier: "owlet-model") {
            Picker("Model", selection: $modelID) {
                ForEach(models) { value in Text(value.label).tag(value.id) }
            }
        }
        FieldNote(text: String(localized: "Claude Code or Codex. Sotto turns off their own memory in the owlet’s folder."))
        if let chosenModel, let efforts = chosenModel.reasoningEfforts, !efforts.isEmpty {
            FieldBox(label: String(localized: "Effort", comment: "The field for how hard a new thread's model reasons."), value: effort.isEmpty ? String(localized: "Choose an effort") : EffortWords.name(effort), identifier: "owlet-effort") {
                Picker("Effort", selection: $effort) {
                    ForEach(efforts, id: \.self) { Text(EffortWords.name($0)).tag($0) }
                }
            }
        }
        if let chosenModel {
            let mayAnswer = model.mayAnswer(home)
            let permission = chosenModel.permissions.first { $0.id == permissionID }
            FieldBox(label: String(localized: "Permissions", comment: "The field for the permission mode a new thread starts in."), value: permission?.name ?? String(localized: "Choose a permission mode"), identifier: "owlet-permissions") {
                Picker("Permissions", selection: Binding(get: { permissionID }, set: { permissionID = $0; heldBack = false })) {
                    if permission == nil { Text("Choose a permission mode").tag("") }
                    ForEach(chosenModel.permissions) { value in
                        Text(value.name).tag(value.id).selectionDisabled(value.grants && !mayAnswer)
                    }
                }
            }
            FieldNote(text: String(localized: "What it may do without asking, as for any thread. It asks you about everything else, and never answers its own cards."))
            if heldBack || !mayAnswer {
                FieldNote(text: String(localized: "\(homeName) hasn’t let this iPhone answer, so this thread starts by asking.", comment: "%@ is the computer's name."), warm: heldBack)
            }
        }
    }

    private func labelled<Field: View>(_ label: String, @ViewBuilder field: () -> Field) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        return VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
            field().font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .background(Palette.fillSofter, in: shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    private func start() {
        guard !started else { return }
        started = true
        model.creationFeedback = nil
        if let owlet = current?.owlet {
            name = owlet.name
            role = owlet.role
            return
        }
        hostID = hosts.first ?? ""
        chooseModel()
        DispatchQueue.main.async { nameFocused = true }
    }

    /// The computer's own starting model where it is Claude Code's or Codex's, or its first that is.
    private func chooseModel() {
        guard editing == nil else { return }
        let starting = model.initialCreationModelID(hostID)
        modelID = models.contains(where: { $0.id == starting }) ? starting : models.first?.id ?? ""
        resetOptions()
    }

    private func resetOptions() {
        guard editing == nil else { return }
        effort = chosenModel.map { model.initialCreationEffort(hostID, model: $0) } ?? ""
        if let chosenModel {
            let start = model.initialCreationPermission(hostID, model: chosenModel)
            permissionID = start.id
            heldBack = start.heldBack
        } else {
            permissionID = ""
            heldBack = false
        }
    }

    private func submit() {
        guard ready else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            if let editing {
                let before = current?.owlet
                let newRole = role.trimmingCharacters(in: .whitespacesAndNewlines)
                let refusal = await model.setOwlet(editing, name: trimmed == before?.name ? nil : trimmed, role: newRole == before?.role ? nil : newRole)
                if let refusal { error = refusal } else { dismiss() }
                return
            }
            if let ref = await model.createOwlet(on: hostID, name: trimmed, role: role, modelID: modelID, effort: effort, permissionID: permissionID) {
                dismiss()
                opened(ref)
            } else {
                error = model.creationFeedback ?? String(localized: "The owlet was not made. Try again.")
            }
        }
    }
}
