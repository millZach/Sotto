import SwiftUI
import SottoCore

/// A computer's own page, by host ID.
struct ComputerRoute: Hashable { let hostID: String }

/// Every paired computer and whether it can be reached, with Add computer at the top. The heading and the
/// cards scroll as one sheet, like Threads.
struct ComputersView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        SheetPage(washHeight: 330) {
            PageHeading(String(localized: "Computers"), subtitle: String(localized: "Each computer runs Sotto and shares its threads with this iPhone.")) {
                Button { model.startAdding() } label: { Image(systemName: "plus") }
                    .buttonStyle(GlassCircleStyle())
                    .disabled(!model.storageReady)
                    .accessibilityLabel("Add computer")
            }
            .padding(.top, Space.s1)
            if model.feedback != nil { FeedbackBanner().padding(.top, Space.s4) }
            VStack(spacing: Space.s3) {
                ForEach(model.computers, id: \.hostID) { computer in
                    ComputerCard(hostID: computer.hostID, name: computer.name)
                }
            }
            .padding(.top, Space.s6)
            Text("Whether this iPhone can answer questions and permissions is set in Sotto on each computer.")
                .font(.sotto(.small)).foregroundStyle(Palette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Space.s1)
                .padding(.top, Space.s3)
                .paragraphDirection()
        }
        .refreshable { await model.refresh() }
        .navigationTitle("Computers")
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: ComputerRoute.self) { ComputerDetailView(hostID: $0.hostID).toolbar(.hidden, for: .tabBar) }
    }
}

/// One computer: whether it can be reached, whether this iPhone may answer there, and what it last shared. One card with
/// plain lines and no tiles inside it (#1863). The card opens the computer's page; one that can't be reached offers Try
/// again.
private struct ComputerCard: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var textSize
    let hostID: String
    let name: String
    @State private var retries = 0
    private var status: ComputerStatus { model.status(hostID) }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NavigationLink(value: ComputerRoute(hostID: hostID)) {
                header
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Opens this computer’s details")
            }
            .buttonStyle(PressStyle())
            if status == .unreachable {
                HStack(spacing: Space.s3) {
                    Button { retries += 1; Task { await model.connect(hostID) } } label: {
                        Label("Try again", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                    .sensoryFeedback(.impact(flexibility: .soft), trigger: retries)
                    .accessibilityLabel("Try reaching \(name) again")
                    Spacer(minLength: 0)
                }
                .padding(.top, Space.s3)
            }
        }
        .padding(Space.s4)
        .sottoCard()
    }

    /// The name with one line under it, and the computer's state at the trailing edge. At the largest text sizes the
    /// state goes under the name instead, so the name keeps the width.
    @ViewBuilder private var header: some View {
        if textSize.isAccessibilitySize {
            HStack(spacing: Space.s3) {
                VStack(alignment: .leading, spacing: Space.s1) {
                    title
                    state
                    detail
                }
                Spacer(minLength: Space.s2)
                chevron
            }
        } else {
            HStack(spacing: Space.s3) {
                VStack(alignment: .leading, spacing: 2) {
                    title
                    detail
                }
                Spacer(minLength: Space.s2)
                state
                chevron
            }
        }
    }
    private var title: some View {
        Text(verbatim: name).font(.sotto(.lead, .bold)).foregroundStyle(Palette.ink)
            .lineLimit(textSize.isAccessibilitySize ? 3 : 1)
    }
    private var state: some View {
        HStack(spacing: Space.s2) {
            ComputerDot(status: status)
            Text(status.words).font(.sotto(.small)).foregroundStyle(Palette.muted)
        }
    }
    private var detail: some View {
        Text(verbatim: line).font(.sotto(.small)).foregroundStyle(Palette.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
    private var chevron: some View {
        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Palette.muted).accessibilityHidden(true)
    }

    /// Under the name: whether this iPhone may answer there, then what it last shared, "Can’t answer yet · 3 projects,
    /// 7 threads". A computer that can't be reached leaves out whether this iPhone may answer, which isn't known until
    /// it's back.
    private var line: String {
        let counts = "\(projectWords), \(threadWords)"
        switch status {
        case .online:
            let answer = model.mayAnswer(hostID) ? String(localized: "Can answer", comment: "This iPhone may answer questions and permissions on this computer.") : String(localized: "Can’t answer yet", comment: "This iPhone may not answer questions and permissions on this computer yet.")
            return "\(answer) · \(counts)"
        case .connecting:
            return "\(String(localized: "Checking…", comment: "Whether this iPhone may answer on a computer is being checked.")) · \(counts)"
        case .unreachable:
            return counts
        }
    }
    private var shared: ComputerThreads? { model.lists.first { $0.hostID == hostID } }
    private var projectWords: String {
        let count = shared?.projects.count ?? 0
        return count == 1 ? String(localized: "1 project") : String(localized: "\(count) projects")
    }
    private var threadWords: String {
        let count = shared?.threads.filter { !ThreadGroups.isUnsent($0) }.count ?? 0
        return count == 1 ? String(localized: "1 thread") : String(localized: "\(count) threads")
    }
}

/// One computer: whether it can be reached, its names, whether this iPhone may answer there and how
/// to allow it, this iPhone's client ID, Rename and Remove.
struct ComputerDetailView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let hostID: String
    var body: some View {
        Group {
            if let computer = model.computer(hostID) { ComputerDetails(computer: computer) } else { Color.clear }
        }
        .pageGround()
        .navigationTitle(model.name(hostID)).navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.canvas, for: .navigationBar)
        .onChange(of: model.computer(hostID) == nil) { _, gone in if gone { dismiss() } }
    }
}

private struct ComputerDetails: View {
    @EnvironmentObject var model: AppModel
    let computer: SavedComputer
    @State private var confirmRemove = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var removals = 0
    private var hostID: String { computer.hostID }
    private var status: ComputerStatus { model.status(hostID) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s3) {
                ComputerStatusCard(hostID: hostID, status: status)
                if model.feedback != nil { FeedbackBanner() }
                VStack(spacing: 0) {
                    DetailRow(label: String(localized: "Name on tailnet"), value: computer.machineName, mono: true)
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                    DetailRow(label: String(localized: "Address", comment: "A computer’s network address."), value: computer.endpoint?.address ?? computer.address, mono: true)
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                    DetailRow(label: String(localized: "Answers from this iPhone"), value: answers, mono: false)
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                    ClientIDRow(clientID: computer.pairing.clientId)
                }
                .sottoCard(.plain)
                if status == .online && !model.mayAnswer(hostID) { AllowAnswersHelp(name: computer.name) }
                VStack(spacing: 0) {
                    Button { newName = computer.localName ?? ""; renaming = true } label: {
                        Text("Rename").font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle()).padding(.horizontal, Space.s4)
                    .accessibilityLabel("Rename \(computer.name) on this iPhone")
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                    Button(role: .destructive) { confirmRemove = true } label: {
                        (model.removing == hostID ? Text("Removing…") : Text("Remove this computer")).font(.sotto(.body, .semibold))
                            .foregroundStyle(Palette.dangerText)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle()).padding(.horizontal, Space.s4)
                    .disabled(model.removing != nil).accessibilityLabel("Remove \(computer.name) from this iPhone")
                }
                .sottoCard(.plain)
                Text("Removing it forgets this iPhone on \(computer.name) too, when it can be reached. Threads stay on the computer.")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Space.s1)
                    .paragraphDirection()
            }
            .padding(.horizontal, Space.gutter).padding(.top, Space.s2).padding(.bottom, Space.s6)
        }
        // A computer that gave up waits for its Reconnect; pulling leaves it alone, as it does on the lists.
        .refreshable { if model.status(hostID) != .unreachable { await model.connect(hostID) } }
        .confirmationDialog(String(localized: "computer-remove.title", defaultValue: "Remove \(computer.name)?", comment: "Asks before removing a computer from this iPhone. %@ is the computer's name"), isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove from this iPhone", role: .destructive) { removals += 1; Task { await model.remove(hostID) } }
        } message: {
            Text("This iPhone stops showing its threads. If \(computer.name) can’t be reached, remove this iPhone there too: in Settings › Hosts & phones, or for a computer without a screen, with Phones on its row in Settings › Hosts & phones on your main computer.")
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: removals)
        .alert("Rename \(computer.name)", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Save") { model.rename(hostID, to: newName) }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The name shows on this iPhone only. Leave it empty to use the computer’s own name.") }
    }
    private var answers: String {
        switch status {
        case .online: return model.mayAnswer(hostID) ? String(localized: "Allowed", comment: "This iPhone may answer questions and permissions on this computer.") : String(localized: "Not allowed yet", comment: "This iPhone may not answer questions and permissions on this computer yet.")
        case .connecting: return String(localized: "Checking…", comment: "Whether this iPhone may answer on a computer is being checked.")
        case .unreachable: return String(localized: "Shown once it’s back")
        }
    }
}

/// Online, connecting, or can't be reached with what to do about it.
private struct ComputerStatusCard: View {
    @EnvironmentObject var model: AppModel
    let hostID: String
    let status: ComputerStatus
    @State private var retries = 0
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s3) {
                ComputerDot(status: status, size: 10)
                Text(status.words).font(.sotto(.title, .bold)).foregroundStyle(Palette.ink)
            }
            .accessibilityElement(children: .combine)
            if status == .unreachable {
                Text(model.problem(hostID) ?? String(localized: "Check that it’s on and that Tailscale is connected on this iPhone."))
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                    .paragraphDirection()
                Text("Work carries on there. Your drafts are kept.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .paragraphDirection()
                Button { retries += 1; Task { await model.connect(hostID) } } label: { Label("Reconnect", systemImage: "arrow.clockwise") }
                    .buttonStyle(ActionStyle(wide: true)).padding(.top, Space.s1)
                    .sensoryFeedback(.impact(flexibility: .soft), trigger: retries)
                    .accessibilityLabel("Reconnect to \(model.name(hostID))")
            }
        }
        .padding(Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .sottoCard()
    }
}

private struct DetailRow: View {
    let label: String
    let value: String
    let mono: Bool
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
            Text(label).font(.sotto(.body)).foregroundStyle(Palette.ink)
            Spacer(minLength: Space.s2)
            Text(value).font(mono ? Font.mono : Font.sotto(.body)).foregroundStyle(Palette.muted)
                .multilineTextAlignment(.trailing).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s3).frame(minHeight: 48)
        .accessibilityElement(children: .combine)
    }
}

private struct ClientIDRow: View {
    let clientID: String
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            Text("Client ID").font(.sotto(.body)).foregroundStyle(Palette.ink)
            Text(verbatim: clientID).font(.mono).foregroundStyle(Palette.muted).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
        .accessibilityElement(children: .combine)
    }
}

/// How to let this iPhone answer on a computer: its Settings › Hosts & phones, a host's Phones on the main computer, or its command.
private struct AllowAnswersHelp: View {
    let name: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("To answer questions and permissions from this iPhone, open Sotto on \(name), go to Settings › Hosts & phones and turn on Can answer for this iPhone.")
            Text("For a computer without a screen, turn it on in Sotto on your main computer: Settings › Hosts & phones, then Phones on its row. Or run its \(Interface.isolated("--allow-answers")) command with this iPhone’s client ID.", comment: "%@ is a command-line option, left as it is.")
        }
        .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, Space.s1)
        .paragraphDirection()
    }
}
