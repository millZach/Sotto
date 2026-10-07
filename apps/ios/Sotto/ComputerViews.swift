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
            PageHeading("Computers", subtitle: "Each computer runs Sotto and shares its threads with this iPhone.") {
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
        }
        .refreshable { await model.refresh() }
        .navigationTitle("Computers")
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: ComputerRoute.self) { ComputerDetailView(hostID: $0.hostID) }
    }
}

/// One computer: whether it can be reached, whether this iPhone may answer there, and what it last shared.
/// The card opens the computer's page; one that can't be reached offers Try again.
private struct ComputerCard: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dynamicTypeSize) private var textSize
    let hostID: String
    let name: String
    private var status: ComputerStatus { model.status(hostID) }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NavigationLink(value: ComputerRoute(hostID: hostID)) {
                VStack(alignment: .leading, spacing: Space.s4) {
                    header
                    facts
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .accessibilityElement(children: .combine)
                .accessibilityHint("Opens this computer’s details")
            }
            .buttonStyle(PressStyle())
            if status == .unreachable {
                HStack(spacing: Space.s3) {
                    Button { Task { await model.connect(hostID) } } label: {
                        Label("Try again", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(PillButtonStyle(kind: .soft, compact: true))
                    .accessibilityLabel("Try reaching \(name) again")
                    Spacer(minLength: 0)
                }
                .padding(.top, Space.s3)
            }
        }
        .padding(Space.s4)
        .failedEdge(status == .unreachable, tint: 0.09)
        .sottoCard(status == .online ? .online : .plain)
    }

    private var header: some View {
        HStack(spacing: Space.s3) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(status == .online ? Palette.accentText : Palette.muted)
                .frame(width: 42, height: 42)
                .background(status == .online ? Palette.accent.opacity(0.14) : Palette.fillSoft, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.sotto(.lead, .bold)).foregroundStyle(Palette.ink)
                    .lineLimit(textSize.isAccessibilitySize ? 3 : 1)
                HStack(spacing: Space.s2) {
                    ComputerDot(status: status)
                    Text(status.words).font(.sotto(.small)).foregroundStyle(Palette.muted)
                }
            }
            Spacer(minLength: Space.s2)
            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Palette.muted).accessibilityHidden(true)
        }
    }

    @ViewBuilder private var facts: some View {
        if textSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: Space.s2) {
                Fact(title: answerTitle, detail: answerDetail)
                Fact(title: projectWords, detail: threadWords)
            }
        } else {
            HStack(alignment: .top, spacing: Space.s2) {
                Fact(title: answerTitle, detail: answerDetail)
                Fact(title: projectWords, detail: threadWords)
            }
        }
    }

    private var answerTitle: String {
        switch status {
        case .online: return model.mayAnswer(hostID) ? "Can answer" : "Can’t answer yet"
        case .connecting: return "Checking…"
        case .unreachable: return "Not known now"
        }
    }
    private var answerDetail: String {
        switch status {
        case .online: return model.mayAnswer(hostID) ? "Questions and permissions" : "Turn on Can answer in Sotto there"
        case .connecting: return "Whether this iPhone may answer"
        case .unreachable: return "Shown once it’s back"
        }
    }
    private var shared: ComputerThreads? { model.lists.first { $0.hostID == hostID } }
    private var projectWords: String {
        let count = shared?.projects.count ?? 0
        return count == 1 ? "1 project" : "\(count) projects"
    }
    private var threadWords: String {
        let count = shared?.threads.count ?? 0
        return count == 1 ? "1 thread" : "\(count) threads"
    }
}

/// One fact about a computer in a small tile.
private struct Fact: View {
    let title: String
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
            Text(detail).font(.sotto(.small)).foregroundStyle(Palette.muted)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.s3).padding(.vertical, Space.s2)
        .background(Palette.fillSofter, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
        .background(Palette.canvas)
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
    private var hostID: String { computer.hostID }
    private var status: ComputerStatus { model.status(hostID) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s3) {
                ComputerStatusCard(hostID: hostID, status: status)
                if model.feedback != nil { FeedbackBanner() }
                VStack(spacing: 0) {
                    DetailRow(label: "Name on tailnet", value: computer.machineName, mono: true)
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                    DetailRow(label: "Address", value: computer.endpoint?.address ?? computer.address, mono: true)
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                    DetailRow(label: "Answers from this iPhone", value: answers, mono: false)
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
                        Text(model.removing == hostID ? "Removing…" : "Remove this computer").font(.sotto(.body, .semibold))
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
            }
            .padding(.horizontal, Space.gutter).padding(.top, Space.s2).padding(.bottom, Space.s6)
        }
        .refreshable { await model.connect(hostID) }
        .confirmationDialog("Remove \(computer.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove from this iPhone", role: .destructive) { Task { await model.remove(hostID) } }
        } message: {
            Text("This iPhone stops showing its threads. If \(computer.name) can’t be reached, remove this iPhone there too: in Settings › Phones, or for a computer without a screen, with Phones on its row in Settings › Hosts on your main computer.")
        }
        .alert("Rename \(computer.name)", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Save") { model.rename(hostID, to: newName) }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The name shows on this iPhone only. Leave it empty to use the computer’s own name.") }
    }
    private var answers: String {
        switch status {
        case .online: return model.mayAnswer(hostID) ? "Allowed" : "Not allowed yet"
        case .connecting: return "Checking…"
        case .unreachable: return "Shown once it’s back"
        }
    }
}

/// Online, connecting, or can't be reached with what to do about it.
private struct ComputerStatusCard: View {
    @EnvironmentObject var model: AppModel
    let hostID: String
    let status: ComputerStatus
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s3) {
                ComputerDot(status: status, size: 10)
                Text(status.words).font(.sotto(.title, .bold)).foregroundStyle(Palette.ink)
            }
            .accessibilityElement(children: .combine)
            if status == .unreachable {
                Text(model.problem(hostID) ?? "Check that it’s on and that Tailscale is connected on this iPhone.")
                    .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                Text("Work carries on there. Your drafts are kept.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                Button { Task { await model.connect(hostID) } } label: { Label("Reconnect", systemImage: "arrow.clockwise") }
                    .buttonStyle(ActionStyle(wide: true)).padding(.top, Space.s1)
                    .accessibilityLabel("Reconnect to \(model.name(hostID))")
            }
        }
        .padding(Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .failedEdge(status == .unreachable, tint: 0.09)
        .sottoCard(status == .online ? .online : .plain)
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
            Text(clientID).font(.mono).foregroundStyle(Palette.muted).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
        .accessibilityElement(children: .combine)
    }
}

/// How to let this iPhone answer on a computer: its Settings › Phones, a host's Phones on the main computer, or its command.
private struct AllowAnswersHelp: View {
    let name: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("To answer questions and permissions from this iPhone, open Sotto on \(name), go to Settings › Phones and turn on Can answer for this iPhone.")
            Text("For a computer without a screen, turn it on in Sotto on your main computer: Settings › Hosts, then Phones on its row. Or run its --allow-answers command with this iPhone’s client ID.")
        }
        .font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, Space.s1)
    }
}
