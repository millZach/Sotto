import SwiftUI
import SottoCore

/// Three choices: computer, project (or a folder on it), then that computer's model and options (ADR-0039). The
/// options start from this iPhone's new-thread defaults where the computer offers them (ADR-0051), and each field's
/// whole box opens its choices.
struct NewThreadSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let opened: (ThreadRef) -> Void
    private enum Step: Equatable { case computer, project, folders, options }
    @State private var step = Step.computer
    /// Whether the last move went forward, so the next page slides in from the side it came from.
    @State private var forward = true
    @State private var presses = 0
    @State private var openedCount = 0
    @State private var hostID = ""
    @State private var projectID: String?
    @State private var folder: FolderListing?
    @State private var modelID = ""
    @State private var effort = ""
    @State private var permissionID = ""
    @State private var workingCopy = WorkingCopy.shared
    /// A permission default that would let the thread act without asking, held back because this computer doesn't
    /// let this iPhone answer. Cleared once the user picks a permission themselves.
    @State private var heldBack = false
    private var models: [ThreadModel] { model.creationModels(hostID) }
    private var chosenModel: ThreadModel? { models.first { $0.id == modelID } }
    private var busy: Bool { model.creatingHostID != nil }
    private var computerName: String { model.name(hostID) }
    private var project: Project? { model.projects(hostID).first { $0.id == projectID } }
    private var projectTitle: String { folder?.shownName ?? project?.title ?? String(localized: "Project", comment: "Stands in for a project's name when the computer gave none.") }
    private var projectPath: String? { folder?.path ?? project?.path }

    var body: some View {
        VStack(spacing: 0) {
            header
            StepBar(filled: stepNumber)
                .padding(.horizontal, Space.gutter)
            Text(stepLabel)
                .font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Space.gutter).padding(.top, Space.s2)
            if let notice = model.shareNotice {
                Text(notice).font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Space.gutter).padding(.top, Space.s1)
            }
            ZStack { page }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
            footer
        }
        .foregroundStyle(Palette.ink)
        .background { NewThreadBackground() }
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
        .onAppear { model.creationFeedback = nil; startOnTheOnlyComputer() }
        .onChange(of: modelID) { _, _ in resetOptions() }
    }

    // MARK: Header, steps and footer

    private var header: some View {
        ZStack {
            Text("New thread").font(.sotto(.lead, .bold)).foregroundStyle(Palette.ink)
                .accessibilityAddTraits(.isHeader)
            HStack {
                if step == .computer {
                    cancelButton
                    Spacer(minLength: Space.s2)
                } else {
                    Button { back() } label: {
                        HStack(spacing: Space.s1) {
                            Image(systemName: "chevron.left").font(.system(size: 14, weight: .semibold)).accessibilityHidden(true)
                            Text("Back")
                        }
                    }
                    .buttonStyle(PillButtonStyle(kind: .ghost))
                    .disabled(busy)
                    .accessibilityLabel("Back")
                    .accessibilityHint("Returns to the step before.")
                    Spacer(minLength: Space.s2)
                    cancelButton
                }
            }
        }
        .frame(minHeight: 48)
        .padding(.horizontal, Space.s2)
        .padding(.top, Space.s3)
    }

    private var cancelButton: some View {
        Button("Cancel") { dismiss() }
            .buttonStyle(PillButtonStyle(kind: .ghost))
            .disabled(busy)
            .keyboardShortcut(.cancelAction)
    }

    private var stepNumber: Int {
        switch step {
        case .computer: return 1
        case .project, .folders: return 2
        case .options: return 3
        }
    }

    private var stepLabel: String {
        switch step {
        case .computer: return String(localized: "Step 1 of 3: computer")
        case .project: return String(localized: "Step 2 of 3: project")
        case .folders: return String(localized: "Step 2 of 3: folder")
        case .options: return String(localized: "Step 3 of 3: options")
        }
    }

    @ViewBuilder private var page: some View {
        switch step {
        case .computer: computers.transition(pageTransition)
        case .project: projects.transition(pageTransition)
        case .folders:
            ComputerFolderPicker(hostID: hostID, initialPath: folder?.path) { value in
                folder = value; projectID = nil; chooseOptions()
            }
            .transition(pageTransition)
        case .options: options.transition(pageTransition)
        }
    }

    /// The next page slides in from the side it comes from; the last one fades. Under Reduce Motion, a fade.
    private var pageTransition: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity), removal: .opacity)
    }

    @ViewBuilder private var footer: some View {
        switch step {
        case .computer: FooterHint(text: String(localized: "Choose a computer to continue."))
        case .project: FooterHint(text: String(localized: "Choose a project to continue."))
        case .folders: EmptyView()
        case .options: openButton
        }
    }

    private var openButton: some View {
        Button {
            presses += 1
            Task {
                if let ref = await model.createThread(on: hostID, projectID: projectID, folder: folder, modelID: modelID,
                                                     effort: effort, permissionID: permissionID, workingCopy: workingCopy) {
                    self.openedCount += 1
                    dismiss(); opened(ref)
                }
            }
        } label: {
            HStack(spacing: Space.s2) {
                if busy { ProgressView().tint(Palette.onAccent) }
                (busy ? Text("Opening thread…") : Text("Open thread on \(computerName)")).lineLimit(1)
            }
        }
        .buttonStyle(ActionStyle(wide: true))
        .sensoryFeedback(.impact(flexibility: .soft), trigger: presses)
        .sensoryFeedback(.success, trigger: openedCount)
        .disabled(!canCreate)
        .accessibilityIdentifier("open-new-thread")
        .padding(.horizontal, Space.gutter).padding(.vertical, Space.s3)
        .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }

    // MARK: Step 1: a computer

    private var computers: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                StepTitle(title: String(localized: "Where should it run?"), subtitle: String(localized: "Threads run on a computer with Sotto open."))
                VStack(spacing: Space.s2) {
                    ForEach(model.computers, id: \.hostID) { computer in
                        Button { chooseComputer(computer.hostID) } label: {
                            PickRow(title: computer.name, detail: computerDetail(computer.hostID),
                                    chevron: model.online(computer.hostID)) {
                                ComputerDot(status: model.status(computer.hostID))
                            }
                        }
                        .buttonStyle(PressStyle())
                        .disabled(!model.online(computer.hostID))
                        .accessibilityIdentifier("new-thread-computer-\(computer.hostID)")
                    }
                }
                .padding(.top, Space.s5)
                if !model.computers.contains(where: { model.online($0.hostID) }) {
                    QuietLine(text: String(localized: "Reconnect a computer in Computers before starting a thread.")).padding(.top, Space.s4)
                }
            }
            .pagePadding()
        }
    }

    private func computerDetail(_ id: String) -> String {
        switch model.status(id) {
        case .online:
            let count = model.projects(id).count
            let projects = count == 1 ? String(localized: "1 project") : String(localized: "\(count) projects")
            return String(localized: "Online · \(projects)", comment: "%@ is how many projects the computer has, such as 3 projects.")
        case .connecting: return String(localized: "Connecting…")
        case .unreachable: return String(localized: "Can’t be reached right now")
        }
    }

    // MARK: Step 2: a project or a folder

    private var projects: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                FlowLayout(spacing: Space.s2) { computerCrumb }
                    .padding(.bottom, Space.s5)
                StepTitle(title: String(localized: "Which project?"), subtitle: String(localized: "The thread works in this folder."))
                connectionNotice
                VStack(spacing: Space.s2) {
                    ForEach(model.projects(hostID)) { project in
                        Button { projectID = project.id; folder = nil; chooseOptions() } label: {
                            PickRow(title: project.title, detail: projectDetail(project)) {
                                Image(systemName: "folder").font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.accentText)
                            }
                        }
                        .buttonStyle(PressStyle())
                        .disabled(!model.online(hostID))
                        .accessibilityIdentifier("new-thread-project-\(project.id)")
                    }
                    Button { go(.folders, forward: true) } label: {
                        PickRow(title: String(localized: "Browse another folder"), detail: String(localized: "Folders on \(computerName)", comment: "%@ is the computer's name.")) {
                            Image(systemName: "folder.badge.plus").font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.accentText)
                        }
                    }
                    .buttonStyle(PressStyle())
                    .disabled(!model.canBrowseFolders(hostID))
                    .accessibilityIdentifier("browse-project-folder")
                }
                .padding(.top, Space.s5)
                if !model.canBrowseFolders(hostID), model.online(hostID) {
                    QuietLine(text: String(localized: "Update Sotto on this computer to browse its folders.")).padding(.top, Space.s3)
                }
            }
            .pagePadding()
        }
    }

    /// Its folder and how many threads it holds.
    private func projectDetail(_ project: Project) -> String? {
        let threads = model.lists.first { $0.hostID == hostID }?.threads.filter { $0.projectId == project.id && !ThreadGroups.isUnsent($0) }.count ?? 0
        let count: String? = threads == 0 ? nil : threads == 1 ? String(localized: "1 thread") : String(localized: "\(threads) threads")
        let parts = [project.path, count].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: Step 3: how it works

    private var options: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                FlowLayout(spacing: Space.s2) {
                    computerCrumb
                    Crumb(symbol: "folder", text: projectTitle, label: String(localized: "Change project, now \(projectTitle)", comment: "%@ is the project's name.")) {
                        go(folder == nil ? .project : .folders, forward: false)
                    }
                    .accessibilityIdentifier("new-thread-change-project")
                }
                .padding(.bottom, Space.s5)
                StepTitle(title: String(localized: "How should it work?"), subtitle: optionsSubtitle)
                if let projectPath {
                    Text(verbatim: projectPath).font(.system(.caption, design: .monospaced)).foregroundStyle(Palette.muted)
                        .textSelection(.enabled).padding(.top, Space.s2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                connectionNotice
                if models.isEmpty {
                    QuietLine(text: String(localized: "No ready models on this computer. Connect a provider in Sotto there, then try again.")).padding(.top, Space.s5)
                } else {
                    fields.padding(.top, Space.s5)
                }
                if let feedback = model.creationFeedback {
                    Text(feedback).font(.sotto(.small)).foregroundStyle(Palette.warningText)
                        .fixedSize(horizontal: false, vertical: true)
                        .paragraphDirection()
                        .padding(.top, Space.s4)
                        .accessibilityIdentifier("creation-feedback")
                }
                ForEach(model.pendingCreations.filter { $0.hostID == hostID }) { CreationPendingRow(operation: $0).padding(.top, Space.s3) }
            }
            .pagePadding()
        }
    }

    private var optionsSubtitle: String {
        model.newThreadDefaults == NewThreadDefaults()
            ? String(localized: "These start from \(computerName)’s own choices.", comment: "%@ is the computer's name.")
            : String(localized: "These start from your new thread defaults.")
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            FieldBox(label: String(localized: "Model", comment: "The field for the model a new thread uses."), value: chosenModel.map(modelName) ?? String(localized: "Choose a model"), identifier: "new-thread-model") {
                Picker("Model", selection: $modelID) {
                    if chosenModel == nil {
                        Text("Saved model unavailable — choose a model").tag(modelID).selectionDisabled(true)
                    }
                    ForEach(models) { value in Text(modelName(value)).tag(value.id) }
                }
            }
            if let chosenModel, let efforts = chosenModel.reasoningEfforts, !efforts.isEmpty {
                FieldBox(label: String(localized: "Effort", comment: "The field for how hard a new thread's model reasons."), value: effort.isEmpty ? String(localized: "Choose an effort") : effort.capitalized, identifier: "new-thread-effort") {
                    Picker("Effort", selection: $effort) {
                        ForEach(efforts, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                }
            }
            if let chosenModel { permissionField(chosenModel) }
            FieldBox(label: String(localized: "Working copy"), value: workingCopy.title, identifier: "new-thread-working-copy") {
                Picker("Working copy", selection: $workingCopy) {
                    ForEach(WorkingCopy.allCases, id: \.self) { Text($0.title).tag($0) }
                }
            }
            FieldNote(text: workingCopy.summary)
        }
    }

    @ViewBuilder private func permissionField(_ chosen: ThreadModel) -> some View {
        let mayAnswer = model.mayAnswer(hostID)
        let current = chosen.permissions.first { $0.id == permissionID }
        FieldBox(label: String(localized: "Permissions", comment: "The field for the permission mode a new thread starts in."), value: current?.name ?? String(localized: "Choose a permission mode"), identifier: "new-thread-permissions") {
            Picker("Permissions", selection: chosenPermission) {
                if current == nil { Text("Choose a permission mode").tag("") }
                ForEach(chosen.permissions) { permission in
                    Text(permission.name).tag(permission.id).selectionDisabled(permission.grants && !mayAnswer)
                }
            }
        }
        if let asks = current?.asks { FieldNote(text: asks) }
        if chosen.permissions.isEmpty {
            FieldNote(text: String(localized: "This model has no supported permission modes. Choose another model."))
        } else if heldBack {
            FieldNote(text: String(localized: "\(computerName) hasn’t let this iPhone answer, so this thread starts by asking.", comment: "%@ is the computer's name."), warm: true)
                .accessibilityIdentifier("new-thread-permission-held-back")
        } else if !mayAnswer {
            FieldNote(text: String(localized: "This iPhone can start a thread that asks before acting. To answer its permissions here, turn on Can answer in this computer’s Settings › Hosts & phones."))
        }
    }

    /// The user's own pick, which replaces any held-back default.
    private var chosenPermission: Binding<String> {
        Binding(get: { permissionID }, set: { permissionID = $0; heldBack = false })
    }

    private func modelName(_ value: ThreadModel) -> String { value.label }

    private var canCreate: Bool {
        guard !busy, model.online(hostID), !model.pendingCreations.contains(where: { $0.hostID == hostID }),
              let chosenModel, let permission = chosenModel.permissions.first(where: { $0.id == permissionID }),
              !permission.grants || model.mayAnswer(hostID) else { return false }
        return folder?.path != nil || model.projects(hostID).contains { $0.id == projectID }
    }

    // MARK: Shared pieces

    private var computerCrumb: some View {
        Crumb(symbol: "desktopcomputer", text: computerName, label: String(localized: "Change computer, now \(computerName)", comment: "%@ is the computer's name.")) {
            go(.computer, forward: false)
        }
        .accessibilityIdentifier("new-thread-change-computer")
    }

    @ViewBuilder private var connectionNotice: some View {
        if !model.online(hostID) {
            Text("Can’t reach \(computerName). Reconnect before opening a thread.")
                .font(.sotto(.small)).foregroundStyle(Palette.warningText)
                .fixedSize(horizontal: false, vertical: true)
                .paragraphDirection()
                .padding(.top, Space.s3)
        }
    }

    // MARK: Moving between steps

    private func go(_ next: Step, forward: Bool) {
        self.forward = forward
        withAnimation(reduceMotion ? .easeInOut(duration: 0.2) : .spring(response: 0.44, dampingFraction: 0.86)) { step = next }
    }

    /// With one computer able to take the thread, the sheet opens on its projects: a first step with one live row decided
    /// nothing (#1856). The computer's chip still opens the list.
    private func startOnTheOnlyComputer() {
        let online = model.computers.filter { model.online($0.hostID) }
        guard step == .computer, hostID.isEmpty, online.count == 1, let only = online.first else { return }
        hostID = only.hostID
        step = .project
    }

    private func chooseComputer(_ id: String) {
        if id != hostID { projectID = nil; folder = nil }
        hostID = id
        go(.project, forward: true)
    }

    private func chooseOptions() {
        modelID = model.initialCreationModelID(hostID)
        workingCopy = model.initialCreationWorkingCopy
        resetOptions()
        go(.options, forward: true)
    }

    /// Effort and permission for the chosen model, from this iPhone's defaults where they apply.
    private func resetOptions() {
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

    private func back() {
        model.creationFeedback = nil
        switch step {
        case .computer: dismiss()
        case .project: go(.computer, forward: false)
        case .folders: go(.project, forward: false)
        case .options: go(folder == nil ? .project : .folders, forward: false)
        }
    }
}

extension WorkingCopy {
    /// Where a new thread works, as New thread and Settings name it.
    var title: String { self == .shared ? String(localized: "Project folder") : String(localized: "New worktree") }
    var summary: String {
        self == .shared
            ? String(localized: "Works in the project’s own folder, beside its other threads.")
            : String(localized: "Its own folder on a new branch, made when you send the first message.")
    }
}

// MARK: - Pieces of the sheet

/// The sheet's surface, with the theme's wash at the top.
private struct NewThreadBackground: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ZStack(alignment: .top) {
            Rectangle().fill(scheme == .dark ? Palette.raised : Palette.surface)
            Wash(height: 300, drifts: false)
        }
        .ignoresSafeArea()
    }
}

/// Three short bars, lit in the accent up to the current step.
private struct StepBar: View {
    let filled: Int
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 6) {
            ForEach(1...3, id: \.self) { index in
                Capsule()
                    .fill(index <= filled ? theme.color(.accent) : theme.color(.fillSoft))
                    .frame(height: 4)
                    .glow(Capsule(), color: theme.color(.accent), alpha: 0.6, radius: 5, showing: index <= filled)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.4), value: filled)
        .accessibilityHidden(true)
    }
}

/// A step's question and the line under it.
private struct StepTitle: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Text(title).font(.sotto(.title, .bold)).headingTracking(-0.4).foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle).font(.sotto(.small)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .paragraphDirection()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A choice on steps 1 and 2: what it is, a line about it, and a chevron when it leads on.
private struct PickRow<Leading: View>: View {
    let title: String
    let detail: String?
    var chevron = true
    @ViewBuilder let leading: () -> Leading
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        HStack(spacing: Space.s3) {
            leading().frame(width: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    .lineLimit(2).multilineTextAlignment(.leading)
                if let detail {
                    Text(detail).font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if chevron {
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                    .accessibilityHidden(true)
            }
        }
        .padding(Space.s4)
        .frame(minHeight: 64)
        .background(Palette.fillSofter, in: shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
        .contentShape(shape)
        .opacity(enabled ? 1 : 0.62)
    }
}

/// A crumb at the top of a step: what was chosen before, and a press goes back to change it.
private struct Crumb: View {
    let symbol: String
    let text: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 13, weight: .medium)).accessibilityHidden(true)
                Text(text).lineLimit(1).truncationMode(.middle)
            }
        }
        .buttonStyle(ChipStyle())
        .accessibilityLabel(label)
    }
}

/// A field on step 3. The whole box opens its choices, shows the current one, and carries a chevron.
private struct FieldBox<Choices: View>: View {
    let label: String
    let value: String
    let identifier: String
    @ViewBuilder let choices: () -> Choices
    var body: some View {
        Menu {
            choices()
        } label: {
            FieldBoxLabel(label: label, value: value)
        }
        .menuStyle(.button)
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
        .accessibilityValue(value)
        .accessibilityHint("Shows the choices.")
        .accessibilityIdentifier(identifier)
    }
}

private struct FieldBoxLabel: View {
    let label: String
    let value: String
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        HStack(spacing: Space.s3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                Text(value).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .background(Palette.fillSofter, in: shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
        .contentShape(shape)
    }
}

/// A short line under a field. A warm one carries a warning light, for a default that didn't apply.
private struct FieldNote: View {
    let text: String
    var warm = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
            if warm { Light(tone: .warning, size: 7) }
            Text(text).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                .paragraphDirection()
        }
        .padding(.horizontal, Space.s1).padding(.bottom, Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A quiet line on its own.
private struct QuietLine: View {
    let text: String
    var body: some View {
        Text(text).font(.sotto(.small)).foregroundStyle(Palette.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .paragraphDirection()
    }
}

/// The foot of a step that has no action yet.
private struct FooterHint: View {
    let text: String
    var body: some View {
        Text(text).font(.sotto(.small)).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .paragraphDirection()
            .padding(.horizontal, Space.gutter).padding(.vertical, Space.s3)
            .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }
}

private extension View {
    /// A step's margins.
    func pagePadding() -> some View {
        padding(.horizontal, Space.gutter).padding(.top, Space.s4).padding(.bottom, Space.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Folders on a computer

private struct ComputerFolderPicker: View {
    @EnvironmentObject var model: AppModel
    let hostID: String
    let initialPath: String?
    let selected: (FolderListing) -> Void
    @State private var listing: FolderListing?
    @State private var filter = ""
    @State private var path = ""
    @State private var loading = false
    @State private var problem: String?
    /// The last read failed, rather than finding a folder missing or unreadable, so reading it again may work.
    @State private var failed = false
    /// The folder the last read asked for, which Try again reads again.
    @State private var lastTarget: JSONValue?
    @State private var requestID = UUID()
    private enum Field: Hashable { case path, filter }
    @FocusState private var focusedField: Field?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s4) {
                StepTitle(title: String(localized: "Folders on \(model.name(hostID))", comment: "%@ is the computer's name."), subtitle: String(localized: "Choose the folder the thread works in. Only folder names are read."))
                places
                pathField
                filterField
                if loading {
                    ProgressView("Reading folders…").font(.sotto(.small)).frame(maxWidth: .infinity).padding(.vertical, Space.s3)
                }
                if let problem {
                    VStack(alignment: .leading, spacing: Space.s2) {
                        Text(problem).font(.sotto(.small)).foregroundStyle(Palette.warningText).fixedSize(horizontal: false, vertical: true)
                            .paragraphDirection()
                        // An error that says to try again has a button that does (#1862).
                        if failed {
                            Button("Try again") { read(lastTarget) }
                                .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                                .accessibilityIdentifier("folders-try-again")
                        }
                    }
                }
                if let listing, !loading, problem == nil { folders(listing) }
            }
            .pagePadding()
        }
        .scrollDismissesKeyboard(.interactively)
        .task { await load(initialPath.map(JSONValue.string)) }
        .onDisappear { requestID = UUID() }
        .safeAreaInset(edge: .bottom) {
            Button("Use this folder") { if let listing { selected(listing) } }
                .buttonStyle(ActionStyle(wide: true))
                .disabled(loading || problem != nil || listing?.path == nil || !model.online(hostID))
                .accessibilityIdentifier("use-project-folder")
                .padding(.horizontal, Space.gutter).padding(.vertical, Space.s3)
                .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
        }
    }

    /// Home, every drive or root, and the folder above this one.
    private var places: some View {
        FlowLayout(spacing: Space.s2) {
            Button { read(nil) } label: { Label("Home", systemImage: "house") }
                .buttonStyle(ChipStyle())
                .accessibilityLabel("Home")
            Button { read(.null) } label: { Label("All folders", systemImage: "externaldrive") }
                .buttonStyle(ChipStyle())
                .accessibilityLabel("All folders")
            if let listing, listing.crumbs.count > 1 {
                Button { read(listing.crumbs[listing.crumbs.count - 2].path.map(JSONValue.string) ?? .null) } label: {
                    Label("Up", systemImage: "arrow.up")
                }
                .buttonStyle(ChipStyle())
                .accessibilityLabel("Open parent folder")
            }
        }
    }

    private var pathField: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            Text("Full folder path").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
            VStack(alignment: .leading, spacing: Space.s2) {
                TextField("Enter a folder path", text: $path, prompt: Text("Enter a folder path").foregroundStyle(Palette.placeholder))
                    .font(.sotto(.body))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($focusedField, equals: .path)
                    .submitLabel(.go).onSubmit { if !path.isEmpty { read(.string(path)) } }
                    .fieldSurface()
                    .accessibilityIdentifier("project-folder-path")
                    .accessibilityLabel("Full folder path on \(model.name(hostID))")
                Button("Go to folder") { read(.string(path)) }
                    .buttonStyle(PlainStyle(compact: true))
                    .disabled(path.isEmpty)
            }
        }
    }

    private var filterField: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "line.3.horizontal.decrease").foregroundStyle(Palette.muted).accessibilityHidden(true)
            TextField("Filter folders", text: $filter, prompt: Text("Filter folders").foregroundStyle(Palette.placeholder))
                .font(.sotto(.body))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($focusedField, equals: .filter).submitLabel(.done).onSubmit { focusedField = nil }
                .accessibilityLabel("Filter folders in this directory")
                .accessibilityIdentifier("folder-filter")
        }
        .padding(.horizontal, Space.s4)
        .frame(minHeight: 46)
        .background(Palette.fillSofter, in: Capsule())
        .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
    }

    @ViewBuilder private func folders(_ listing: FolderListing) -> some View {
        let shown = listing.folders.filter { filter.isEmpty || $0.name.localizedCaseInsensitiveContains(filter) }
        Text(listing.path ?? String(localized: "Drives", comment: "Stands in for a folder path at the top level, where a computer lists its drives or roots.")).font(.system(.caption, design: .monospaced)).foregroundStyle(Palette.muted)
            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        if !shown.isEmpty {
            LazyVStack(spacing: 0) {
                ForEach(shown) { folder in
                    Button { read(.string(folder.path)) } label: { FolderRow(folder: folder) }
                        .buttonStyle(PressStyle())
                        .accessibilityIdentifier("folder-\(folder.name)")
                    if folder.id != shown.last?.id {
                        Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, 52)
                    }
                }
            }
            .sottoCard(.plain)
        }
        if listing.folders.isEmpty { QuietLine(text: String(localized: "No subfolders here.")) }
        if listing.truncated { QuietLine(text: String(localized: "Only the first 1,000 folders are listed. Enter a full path to open another.")) }
    }

    private func read(_ path: JSONValue?) { focusedField = nil; Task { await load(path) } }
    private func load(_ target: JSONValue?) async {
        let current = UUID(); requestID = current; loading = true; problem = nil; failed = false; lastTarget = target
        defer { if requestID == current { loading = false } }
        do {
            let result = try await model.folders(hostID, path: target)
            guard requestID == current else { return }
            switch result {
            case .listed(let value): listing = value; path = value.path ?? ""; filter = ""
            case .missing: problem = String(localized: "This folder doesn’t exist. Nothing was added. Go Home or enter another path.")
            case .unreadable: problem = String(localized: "This folder can’t be read. Nothing was added. Go Home or choose another folder.")
            }
        } catch { if requestID == current { problem = error.localizedDescription; failed = true } }
    }
}

/// One folder in a listing: its name, whether it is a Git repository, and a chevron into it.
private struct FolderRow: View {
    let folder: HostFolder
    var body: some View {
        HStack(spacing: Space.s3) {
            Image(systemName: "folder").font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.accentText)
                .frame(width: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: folder.name).font(.sotto(.body)).foregroundStyle(Palette.ink).multilineTextAlignment(.leading)
                if folder.git { Text("Git repository").font(.sotto(.caption)).foregroundStyle(Palette.muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.muted)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
        .frame(minHeight: 54)
        .contentShape(Rectangle())
    }
}

/// A thread or project creation this iPhone sent that its computer hasn't confirmed. Nothing is resent.
struct CreationPendingRow: View {
    @EnvironmentObject var model: AppModel
    let operation: PendingOperation
    @State private var dismissing = false
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Light(tone: .warning)
                (operation.kind == "create-project" ? Text("Project registration on \(model.name(operation.hostID)) is unconfirmed.")
                    : Text("Thread creation on \(model.name(operation.hostID)) is unconfirmed."))
                    .font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .paragraphDirection()
            }
            Text("Nothing was resent. Check this computer before trying again.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .paragraphDirection()
            HStack(spacing: Space.s2) {
                Button("Check again") { Task { await model.checkDelivery(operation.hostID) } }
                    .buttonStyle(PlainStyle(compact: true))
                    .disabled(!model.online(operation.hostID))
                Button("Dismiss unconfirmed action") { dismissing = true }
                    .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
            }
        }
        .card()
        .confirmationDialog("Dismiss this unconfirmed action?", isPresented: $dismissing, titleVisibility: .visible) {
            Button("Dismiss unconfirmed action") { model.acknowledgeUnknown(operation.id) }
        } message: { Text("The computer may already have created it. Check its projects and threads first. Dismissing sends nothing.") }
    }
}
