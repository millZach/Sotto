import SwiftUI

/// Settings on this iPhone. Nothing here is sent to a paired computer (ADR-0039, ADR-0050).
struct SettingsView: View {
    @AppStorage(PhonePreferenceKey.appearance) private var appearance = PhoneAppearance.dark.rawValue
    @AppStorage(PhonePreferenceKey.textSize) private var textSize = ""
    @AppStorage(PhonePreferenceKey.legacyLargerText) private var legacyLarger = false
    var body: some View {
        SheetPage {
            PageHeading("Settings", subtitle: "These are kept on this iPhone. They don’t change any computer’s settings.")
                .padding(.top, Space.s1)
            SectionLabel("Appearance")
            HStack(spacing: Space.s3) {
                ForEach(PhoneAppearance.allCases, id: \.rawValue) { choice in
                    AppearanceChoice(choice: choice, selected: appearance == choice.rawValue) { appearance = choice.rawValue }
                }
            }
            SectionLabel("Reading")
            Toggle(isOn: largerText) {
                VStack(alignment: .leading, spacing: Space.s1) {
                    Text("Larger text").font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    Text("Increase text size throughout Sotto.").font(.sotto(.small)).foregroundStyle(Palette.muted)
                }
            }
            .accessibilityIdentifier("setting-larger-text")
            .padding(Space.s4)
            .sottoCard(.plain)
        }
        .navigationTitle("Settings")
        .toolbar(.hidden, for: .navigationBar)
    }
    /// The Larger step of the text size, as the switch it was before the five-step control.
    private var largerText: Binding<Bool> {
        Binding(get: { PhoneTextSize.resolve(textSize, legacyLarger: legacyLarger).offset >= PhoneTextSize.larger.offset },
                set: { on in textSize = on ? PhoneTextSize.larger.rawValue : PhoneTextSize.standard.rawValue })
    }
}

/// One appearance, drawn as a small page in that appearance.
private struct AppearanceChoice: View {
    let choice: PhoneAppearance
    let selected: Bool
    let pick: () -> Void
    @Environment(\.colorScheme) private var current
    var body: some View {
        Button(action: pick) {
            VStack(alignment: .leading, spacing: Space.s3) {
                VStack(alignment: .leading, spacing: Space.s2) {
                    Capsule().fill(Palette.ink).frame(width: 46, height: 6)
                    Capsule().fill(Palette.muted).frame(width: 30, height: 5)
                    Spacer(minLength: 0)
                    Capsule().fill(Palette.accent).frame(width: 24, height: 10)
                }
                .padding(Space.s3)
                .frame(maxWidth: .infinity, minHeight: 76, maxHeight: 76, alignment: .leading)
                .background(Palette.canvas, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
                .environment(\.colorScheme, choice.scheme ?? current)
                .accessibilityHidden(true)
                HStack {
                    Text(choice.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    Spacer(minLength: Space.s1)
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Palette.accentText : Palette.muted)
                        .accessibilityHidden(true)
                }
            }
            .padding(Space.s3)
            .sottoCard(selected ? .online : .plain, radius: 17)
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).strokeBorder(selected ? Palette.accent : ThemeRole.clear, lineWidth: 1.5))
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(choice.title)
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("setting-\(choice.rawValue)")
    }
}
