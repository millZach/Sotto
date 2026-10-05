import SwiftUI
import SottoCore

/// Adding a computer in two steps: find it by its name on the tailnet, then enter the code it shows.
/// Full screen until one computer is paired; after that, the Add computer sheet over Computers.
/// Pairing admits this iPhone; whether it may answer permissions is decided on that computer.
struct PairFlow: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        Group {
            if let found = model.found { CodeStep(found: found) } else { NameStep() }
        }
        .background(Palette.canvas)
    }
}

/// Add computer, over the tabs. Cancel closes it; a code already spent still finishes pairing.
struct AddComputerSheet: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        NavigationStack {
            PairFlow()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { model.adding = false }.accessibilityLabel("Cancel adding a computer")
                    }
                }
                .toolbarBackground(Palette.canvas, for: .navigationBar)
                .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled(model.working)
    }
}

private struct StepHeader: View {
    let step: Int, title: String, detail: String
    var body: some View {
        VStack(spacing: 8) {
            Text("Step \(step) of 2").font(.subheadline).foregroundStyle(Palette.muted)
            Text(title).font(.figtree(28, .title, .bold)).multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
            Text(detail).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
        }
    }
}

private struct PairFeedback: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if let feedback = model.pairFeedback {
            Text(feedback).font(.subheadline).foregroundStyle(Palette.warning).multilineTextAlignment(.center)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}

private struct FieldLabel: View {
    let text: String
    var body: some View {
        Text(text).font(.subheadline).fontWeight(.semibold).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity, alignment: .leading).accessibilityHidden(true)
    }
}

struct NameStep: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @FocusState var focused: Bool
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 24) {
                    StepHeader(step: 1, title: "Add computer",
                               detail: "Read its name in Sotto on that computer: Settings › Phones. For a computer without a screen, first turn on Let phones reach it in Sotto on your main computer: Settings › Hosts, then Phones on its row. Then use its name on your tailnet.")
                    VStack(spacing: 6) {
                        FieldLabel(text: "Computer name on your tailnet")
                        TextField("forge", text: $name).keyboardType(.URL).textContentType(.URL)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.next).onSubmit(find).focused($focused).fieldSurface()
                            .accessibilityLabel("Computer name on your tailnet")
                    }
                    PairFeedback()
                }.padding(.horizontal, 24).padding(.top, 32)
            }.scrollDismissesKeyboard(.interactively)
            Button(model.working ? "Finding it…" : "Next", action: find).buttonStyle(ActionStyle(wide: true))
                .disabled(model.working || !model.storageReady || name.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityLabel(model.working ? "Finding the computer" : "Find this computer")
                .padding(.horizontal, 24).padding(.bottom, 12)
        }
        .onAppear { focused = true }
    }
    private func find() {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        Task { await model.find(name) }
    }
}

struct CodeStep: View {
    @EnvironmentObject var model: AppModel
    let found: FoundHost
    @State private var code = ""
    @FocusState var focused: Bool
    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 24) {
                    StepHeader(step: 2, title: "Enter the pairing code", detail: detail)
                    ZStack {
                        // The field takes the typing; the boxes show it. VoiceOver reads the field.
                        TextField("", text: $code).keyboardType(.asciiCapable).textContentType(.oneTimeCode)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled()
                            .submitLabel(.go).onSubmit(pair).focused($focused)
                            .foregroundStyle(.clear).tint(.clear).accessibilityLabel("Pairing code")
                        CodeBoxes(code: code, focused: focused).allowsHitTesting(false)
                    }
                    .contentShape(Rectangle()).onTapGesture { focused = true }
                    FoundLine(found: found)
                    PairFeedback()
                }.padding(.horizontal, 24).padding(.top, 32)
            }.scrollDismissesKeyboard(.interactively)
            Button(model.working ? "Pairing…" : "Pair", action: pair).buttonStyle(ActionStyle(wide: true))
                .disabled(model.working || code.count != PairingCode.length)
                .accessibilityLabel(model.working ? "Pairing" : "Pair with \(found.name)")
                .padding(.horizontal, 24).padding(.bottom, 12)
        }
        .onAppear { focused = true }
        .onChange(of: code) { _, typed in
            let cleaned = PairingCode.cleaned(typed)
            if cleaned != typed { code = cleaned }
        }
    }
    private var detail: String {
        "In Sotto on \(found.name): Settings › Phones › Pair a phone. For a computer without a screen, it is in Sotto on your main computer: Settings › Hosts, then Phones on its row, then Pair a phone. A code works once, for five minutes."
    }
    private func pair() {
        guard code.count == PairingCode.length else { return }
        Task { await model.pair(code: code); if model.found == nil { code = "" } }
    }
}

/// Where step 1 found Sotto, with the way back to step 1.
private struct FoundLine: View {
    @EnvironmentObject var model: AppModel
    let found: FoundHost
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle").foregroundStyle(Palette.accent).accessibilityHidden(true)
            Text("Found Sotto at \(found.endpoint.address)").lineLimit(1).truncationMode(.middle)
            Button("Change") { model.changeComputer() }.frame(minHeight: 44).disabled(model.working)
                .accessibilityLabel("Change computer")
        }.font(.subheadline).foregroundStyle(Palette.muted)
    }
}

/// Eight boxes in two groups of four, the way the computer shows a code.
private struct CodeBoxes: View {
    let code: String, focused: Bool
    var body: some View {
        let characters = Array(code)
        HStack(spacing: 5) {
            ForEach(0..<PairingCode.length, id: \.self) { index in
                if index == 4 { Text("–").foregroundStyle(Palette.muted).frame(width: 10) }
                let current = focused && index == min(characters.count, PairingCode.length - 1)
                Text(index < characters.count ? String(characters[index]) : " ")
                    .font(.system(size: 24, weight: .semibold, design: .monospaced))
                    .frame(width: 34, height: 50)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(current ? Palette.accent : Palette.border, lineWidth: current ? 2 : 1))
            }
        }
        .accessibilityHidden(true)
    }
}
