import SwiftUI
import SottoCore

/// A computer's own page, by host ID.
struct ComputerRoute: Hashable { let hostID: String }

/// Add computer first, then every paired computer and whether it can be reached.
struct ComputersView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Button { model.startAdding() } label: { Label("Add computer", systemImage: "plus") }
                    .buttonStyle(ActionStyle(wide: true)).disabled(!model.storageReady)
                FeedbackBanner()
                VStack(spacing: 0) {
                    ForEach(model.computers, id: \.hostID) { computer in
                        if computer.hostID != model.computers.first?.hostID { Divider().overlay(Palette.hairline).padding(.leading, 38) }
                        NavigationLink(value: ComputerRoute(hostID: computer.hostID)) {
                            ComputerRow(name: computer.name, status: model.status(computer.hostID))
                        }.buttonStyle(.plain)
                    }
                }.background(Palette.surface, in: RoundedRectangle(cornerRadius: 16))
                Text("Whether this iPhone can answer questions and permissions is set in Sotto on each computer.")
                    .font(.footnote).foregroundStyle(Palette.muted)
            }.padding(.horizontal, 16).padding(.bottom, 24)
        }
        .refreshable { await model.refresh() }
        .page("Computers")
        .navigationDestination(for: ComputerRoute.self) { ComputerDetailView(hostID: $0.hostID) }
    }
}

private struct ComputerRow: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let name: String
    let status: ComputerStatus
    var body: some View {
        HStack(spacing: 12) {
            ComputerDot(status: status, size: 10)
            if textSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    Text(name).fontWeight(.semibold).fixedSize(horizontal: false, vertical: true)
                    Text(status.words).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
            } else {
                Text(name).fontWeight(.semibold).lineLimit(1)
                Spacer(minLength: 8)
                Text(status.words).foregroundStyle(Palette.muted)
            }
            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Palette.muted).accessibilityHidden(true)
        }
        .padding(.horizontal, 16).frame(minHeight: 52).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens this computer’s details")
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
            VStack(alignment: .leading, spacing: 14) {
                ComputerStatusCard(hostID: hostID, status: status)
                FeedbackBanner()
                VStack(spacing: 0) {
                    DetailRow(label: "Name on tailnet", value: computer.machineName, mono: true)
                    Divider().overlay(Palette.hairline)
                    DetailRow(label: "Address", value: computer.endpoint?.address ?? computer.address, mono: true)
                    Divider().overlay(Palette.hairline)
                    DetailRow(label: "Answers from this iPhone", value: answers, mono: false)
                    Divider().overlay(Palette.hairline)
                    ClientIDRow(clientID: computer.pairing.clientId)
                }.background(Palette.surface, in: RoundedRectangle(cornerRadius: 16))
                if status == .online && !model.mayAnswer(hostID) { AllowAnswersHelp(name: computer.name) }
                VStack(spacing: 0) {
                    Button { newName = computer.localName ?? ""; renaming = true } label: {
                        Text("Rename").frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).padding(.horizontal, 16).accessibilityLabel("Rename \(computer.name) on this iPhone")
                    Divider().overlay(Palette.hairline)
                    Button(role: .destructive) { confirmRemove = true } label: {
                        Text(model.removing == hostID ? "Removing…" : "Remove this computer")
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(Palette.danger).padding(.horizontal, 16)
                    .disabled(model.removing != nil).accessibilityLabel("Remove \(computer.name) from this iPhone")
                }.background(Palette.surface, in: RoundedRectangle(cornerRadius: 16))
                Text("Removing it forgets this iPhone on \(computer.name) too, when it can be reached. Threads stay on the computer.")
                    .font(.footnote).foregroundStyle(Palette.muted)
            }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                ComputerDot(status: status, size: 10)
                Text(status.words).font(.figtree(22, .title2, .bold))
            }
            .accessibilityElement(children: .combine)
            if status == .unreachable {
                Text(model.problem(hostID) ?? "Check that it’s on and that Tailscale is connected on this iPhone.")
                    .font(.subheadline).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                Text("Work carries on there. Your drafts are kept.").font(.subheadline).foregroundStyle(Palette.muted)
                Button { Task { await model.connect(hostID) } } label: { Label("Reconnect", systemImage: "arrow.clockwise") }
                    .buttonStyle(ActionStyle(wide: true)).accessibilityLabel("Reconnect to \(model.name(hostID))")
            }
        }.card()
    }
}

private struct DetailRow: View {
    let label: String
    let value: String
    let mono: Bool
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
            Spacer(minLength: 8)
            Text(value).font(mono ? Font.mono : Font.body).foregroundStyle(Palette.muted)
                .multilineTextAlignment(.trailing).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
        }
        .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 48)
        .accessibilityElement(children: .combine)
    }
}

private struct ClientIDRow: View {
    let clientID: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Client ID")
            Text(clientID).font(.mono).foregroundStyle(Palette.muted).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 8)
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
        .font(.subheadline).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
    }
}
