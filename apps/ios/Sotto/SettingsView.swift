import SwiftUI
import UIKit
import SottoCore

/// Settings on this iPhone (ADR-0039, ADR-0051): the look, alerts, new-thread defaults and About. Everything here
/// stays on this iPhone; nothing is sent to a paired computer or changes its settings.
struct SettingsView: View {
    @State private var toast: String?
    var body: some View {
        SheetPage {
            PageHeading("Settings", subtitle: "These are kept on this iPhone. They don’t change any computer’s settings.")
                .padding(.top, Space.s1)
            SectionLabel("Look")
            VStack(spacing: Space.s3) {
                AppearancePanel()
                ThemePanel { toast = $0 }
                TextSizePanel()
                DensityPanel()
            }
            SectionLabel("Notifications")
            NotificationsPanel()
            SectionLabel("New thread defaults")
            DefaultsPanel { toast = $0 }
            SectionLabel("About")
            AboutPanel()
        }
        .toast($toast)
        .navigationTitle("Settings")
        .toolbar(.hidden, for: .navigationBar)
    }
}

// MARK: - Look

private struct AppearancePanel: View {
    @AppStorage(PhonePreferenceKey.appearance) private var appearance = PhoneAppearance.dark.rawValue
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let current = PhoneAppearance(rawValue: appearance) ?? .dark
        VStack(alignment: .leading, spacing: Space.s3) {
            PanelHeader(title: "Appearance", value: current == .system ? "Following the iPhone: \(scheme == .dark ? "Dark" : "Light")" : nil)
            Segmented(name: "Appearance", choices: PhoneAppearance.allCases, selection: current,
                      title: { $0.title }, identifier: { "setting-\($0.rawValue)" }) { appearance = $0.rawValue }
        }
        .card()
    }
}

private struct ThemePanel: View {
    let announce: (String) -> Void
    @AppStorage(PhonePreferenceKey.theme) private var themeID = ThemePalettes.defaultID
    @Environment(\.colorScheme) private var scheme
    private var columns: [GridItem] { Array(repeating: GridItem(.flexible(), spacing: Space.s3, alignment: .top), count: 3) }
    var body: some View {
        let current = ThemePalettes.named(themeID)
        let dark = scheme == .dark
        VStack(alignment: .leading, spacing: Space.s3) {
            PanelHeader(title: "Theme", value: "\(current.name), \(dark ? "dark" : "light")")
            LazyVGrid(columns: columns, alignment: .leading, spacing: Space.s4) {
                ForEach(ThemePalettes.all) { palette in
                    ThemeChoice(palette: palette, dark: dark, selected: palette.id == current.id) {
                        guard palette.id != current.id else { return }
                        themeID = palette.id
                        announce("\(palette.name) theme on.")
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Theme")
            PanelHint(text: "The theme colours the light at the top of each screen, what’s working and what you can tap.")
        }
        .card()
    }
}

/// One palette, drawn as a small room in its own colours: a title, a line, a message and the accent.
private struct ThemeChoice: View {
    let palette: ThemePalette
    let dark: Bool
    let selected: Bool
    let pick: () -> Void
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        Button(action: pick) {
            VStack(alignment: .leading, spacing: 6) {
                ThemeRoom(swatch: palette.swatch(dark: dark))
                    .padding(3)
                    .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous)
                        .strokeBorder(selected ? theme.color(.accent) : Color.clear, lineWidth: 2))
                    .shadow(color: selected ? theme.color(.accent).opacity(0.45) : Color.clear, radius: 10)
                HStack(spacing: 6) {
                    Text(palette.name).font(.sotto(.small, .semibold)).foregroundStyle(Palette.ink).lineLimit(1).minimumScaleFactor(0.8)
                    if selected {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.accentText)
                            .accessibilityHidden(true)
                    }
                }
                .padding(.horizontal, 2)
                .frame(minHeight: 22)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("\(palette.name) theme")
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("setting-theme-\(palette.id)")
    }
}

/// The room inside a theme choice, in that palette's own colours rather than the current theme's.
private struct ThemeRoom: View {
    let swatch: ThemeSwatch
    var body: some View {
        let room = RoundedRectangle(cornerRadius: 14, style: .continuous)
        room.fill(swatch.canvas.color)
            .overlay {
                RadialGradient(colors: [swatch.accent.color.opacity(0.45), swatch.accent.color.opacity(0)],
                               center: UnitPoint(x: 0.15, y: 0), startRadius: 0, endRadius: 80)
            }
            .overlay {
                GeometryReader { proxy in
                    let width = proxy.size.width
                    let height = proxy.size.height
                    ZStack(alignment: .topLeading) {
                        Capsule().fill(swatch.text.color.opacity(0.9)).frame(width: width * 0.54, height: 7).offset(x: 10, y: 14)
                        Capsule().fill(swatch.mutedText.color.opacity(0.9)).frame(width: width * 0.38, height: 5).offset(x: 10, y: 27)
                        Capsule().fill(swatch.messageSurface.color).frame(width: width * 0.46, height: 14)
                            .offset(x: width * 0.54 - 10, y: 44)
                        Capsule().fill(swatch.accent.color).frame(width: 26, height: 12)
                            .shadow(color: swatch.accent.color, radius: 6)
                            .offset(x: 10, y: height - 22)
                    }
                    .frame(width: width, height: height, alignment: .topLeading)
                }
            }
            .clipShape(room)
            .overlay(room.strokeBorder(swatch.text.color.opacity(0.12), lineWidth: 1))
            .frame(height: 92)
            .accessibilityHidden(true)
    }
}

private struct TextSizePanel: View {
    @AppStorage(PhonePreferenceKey.textSize) private var textSize = ""
    @AppStorage(PhonePreferenceKey.legacyLargerText) private var legacyLarger = false
    var body: some View {
        let current = PhoneTextSize.resolve(textSize, legacyLarger: legacyLarger)
        VStack(alignment: .leading, spacing: Space.s3) {
            PanelHeader(title: "Text size", value: current.title)
            HStack(spacing: 0) {
                ForEach(PhoneTextSize.allCases, id: \.rawValue) { size in
                    TextSizeStep(size: size, selected: size == current) { textSize = size.rawValue }
                }
            }
            .padding(4)
            .background {
                ZStack {
                    RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.fillSofter)
                    Rectangle().fill(Palette.hairline).frame(height: 2).padding(.horizontal, 30)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Text size")
            TextSample()
        }
        .card()
    }
}

/// One of the five text sizes, as a letter drawn at a size that grows with the step.
private struct TextSizeStep: View {
    let size: PhoneTextSize
    let selected: Bool
    let pick: () -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.sottoTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) { pick() }
        } label: {
            Text("A")
                .font(.custom("Figtree-Bold", fixedSize: CGFloat(16 + size.offset * 3)))
                .foregroundStyle(selected ? Palette.accentText : Palette.muted)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background {
                    if selected {
                        shape.fill(scheme == .dark ? Palette.raised : Palette.surface)
                            .overlay(shape.strokeBorder(theme.color(.accent).opacity(0.35), lineWidth: 1))
                            .shadow(color: theme.color(.accent).opacity(0.4), radius: 8)
                    }
                }
                .contentShape(shape)
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(size.title)
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
        // The Larger step keeps the earlier Larger text switch's identifier.
        .accessibilityIdentifier(size == .larger ? "setting-larger-text" : "setting-text-\(size.rawValue)")
    }
}

/// A request card's words at the chosen size, so the size can be judged before leaving Settings.
private struct TextSample: View {
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.md, style: .continuous)
        VStack(alignment: .leading, spacing: 2) {
            Text("Pick the drawer shortcut").font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
            Text("Asks: which shortcut should open the terminal drawer?").font(.sotto(.small)).foregroundStyle(Palette.muted)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.canvas, in: shape)
        .overlay(shape.strokeBorder(Palette.hairline, lineWidth: 1))
        .accessibilityHidden(true)
    }
}

private struct DensityPanel: View {
    @AppStorage(PhonePreferenceKey.density) private var density = PhoneDensity.comfortable.rawValue
    var body: some View {
        let current = PhoneDensity(rawValue: density) ?? .comfortable
        VStack(alignment: .leading, spacing: Space.s3) {
            PanelHeader(title: "Message density", value: nil)
            Segmented(name: "Message density", choices: PhoneDensity.allCases, selection: current,
                      title: { $0.title }, identifier: { "setting-density-\($0.rawValue)" }) { density = $0.rawValue }
            PanelHint(text: current == .compact ? "Tighter spacing fits more of a thread on screen." : "Room between messages, lists and steps.")
        }
        .card()
    }
}

// MARK: - Notifications

/// Local alerts while Sotto runs (ADR-0051). Each is off until turned on; turning one on is when iOS asks.
private struct NotificationsPanel: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openURL) private var openURL
    @AppStorage(PhonePreferenceKey.notifyNeedsYou) private var needsYou = false
    @AppStorage(PhonePreferenceKey.notifyFinished) private var finished = false
    @AppStorage(PhonePreferenceKey.notifyFailed) private var failed = false
    @AppStorage(PhonePreferenceKey.notifySound) private var sound = false
    /// iOS said no: the switch went back off, and the panel says where to allow alerts.
    @State private var refused = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 0) {
                AlertSwitch(title: "When a thread needs you", detail: "A question or permission is waiting.",
                            identifier: "setting-notify-needs-you", isOn: asking($needsYou))
                RowDivider()
                AlertSwitch(title: "When a thread finishes", detail: "Its turn ended while you weren’t looking.",
                            identifier: "setting-notify-finished", isOn: asking($finished))
                RowDivider()
                AlertSwitch(title: "When a thread stops with an error", detail: nil,
                            identifier: "setting-notify-failed", isOn: asking($failed))
                RowDivider()
                // A sound only goes with an alert, so it asks iOS for nothing and waits for one to be on.
                AlertSwitch(title: "Play a sound", detail: anyAlert ? nil : "Turn on an alert above first.",
                            identifier: "setting-notify-sound", isOn: $sound)
                    .disabled(!anyAlert)
            }
            .padding(.horizontal, Space.s4).padding(.vertical, Space.s1)
            .frame(maxWidth: .infinity)
            .sottoCard(.plain)
            if refused { refusal.padding(.top, Space.s3) }
            NoteLine(text: "Alerts arrive only while Sotto is open on this iPhone.")
        }
        .task { await check() }
    }

    private var anyAlert: Bool { needsYou || finished || failed }

    /// A switch that, turned on, first makes sure iOS lets Sotto alert, asking the first time.
    private func asking(_ stored: Binding<Bool>) -> Binding<Bool> {
        Binding(get: { stored.wrappedValue }, set: { on in
            stored.wrappedValue = on
            guard on else { return }
            Task { @MainActor in
                let allowed = await model.allowAlerts()
                if allowed { refused = false } else { stored.wrappedValue = false; refused = true }
            }
        })
    }

    /// Alerts turned off in iOS's own Settings since: the switches go back off and say so.
    @MainActor private func check() async {
        guard needsYou || finished || failed || sound else { return }
        if await model.alertPermission() == .denied {
            needsYou = false; finished = false; failed = false; sound = false
            refused = true
        }
    }

    private var refusal: some View {
        VStack(alignment: .leading, spacing: Space.s3) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Light(tone: .warning, size: 7)
                Text("iOS isn’t letting Sotto show alerts, so they’re off. To allow them, open Settings › Notifications › Sotto on this iPhone.")
                    .font(.sotto(.small)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
            }
            Button("Open iOS Settings") {
                if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
            }
            .buttonStyle(PlainStyle(compact: true))
            .accessibilityHint("Opens Sotto’s notification settings in iOS.")
        }
        .padding(Space.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .sottoCard(.needsYou)
        .accessibilityIdentifier("setting-notify-refused")
    }
}

private struct AlertSwitch: View {
    let title: String
    let detail: String?
    let identifier: String
    @Binding var isOn: Bool
    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, Space.s2)
        .frame(minHeight: 60)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - New thread defaults

/// What New thread starts on. Each default applies only where the chosen computer offers it, and a permission that
/// lets a thread act without asking only while that computer lets this iPhone answer (ADR-0051, ADR-0033).
private struct DefaultsPanel: View {
    let announce: (String) -> Void
    @EnvironmentObject var model: AppModel
    @AppStorage(PhonePreferenceKey.newThreadModel) private var modelID = ""
    @AppStorage(PhonePreferenceKey.newThreadEffort) private var effort = ""
    @AppStorage(PhonePreferenceKey.newThreadPermission) private var permission = ""
    @AppStorage(PhonePreferenceKey.newThreadWorkingCopy) private var workingCopy = ""
    private static let computersChoice = "Use the computer’s choice"
    private static let askingChoice = "Start by asking"
    var body: some View {
        let models = model.defaultModelChoices
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 0) {
                DefaultRow(label: "Model", value: modelValue(models), identifier: "setting-default-model") {
                    Picker("Model", selection: saving($modelID)) {
                        Text(Self.computersChoice).tag("")
                        if !modelID.isEmpty && !models.contains(where: { $0.id == modelID }) {
                            Text("A model no connected computer offers").tag(modelID)
                        }
                        ForEach(models) { value in Text(Self.modelName(value)).tag(value.id) }
                    }
                }
                RowDivider()
                DefaultRow(label: "Effort", value: effort.isEmpty ? Self.computersChoice : effort.capitalized, identifier: "setting-default-effort") {
                    Picker("Effort", selection: saving($effort)) {
                        Text(Self.computersChoice).tag("")
                        ForEach(efforts(models), id: \.self) { Text($0.capitalized).tag($0) }
                    }
                }
                RowDivider()
                DefaultRow(label: "Permissions", value: permissionValue(models), identifier: "setting-default-permissions") {
                    Picker("Permissions", selection: saving($permission)) {
                        Text(Self.askingChoice).tag("")
                        ForEach(permissions(models)) { choice in Text(choice.name).tag(choice.id) }
                    }
                }
                RowDivider()
                DefaultRow(label: "Working copy", value: currentWorkingCopy.title, identifier: "setting-default-working-copy") {
                    Picker("Working copy", selection: savingWorkingCopy) {
                        ForEach(WorkingCopy.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                }
            }
            .padding(.horizontal, Space.s4).padding(.vertical, Space.s1)
            .frame(maxWidth: .infinity)
            .sottoCard(.plain)
            NoteLine(text: "A default applies only where the chosen computer offers it. A computer that hasn’t let this iPhone answer starts every thread by asking.")
        }
    }

    private static func modelName(_ value: ThreadModel) -> String { "\(Words.provider(value.providerId)) · \(value.name)" }

    private func modelValue(_ models: [ThreadModel]) -> String {
        guard !modelID.isEmpty else { return Self.computersChoice }
        return models.first { $0.id == modelID }.map(Self.modelName) ?? "A model no connected computer offers"
    }

    /// The chosen model's efforts, or every effort the connected computers' models offer.
    private func efforts(_ models: [ThreadModel]) -> [String] {
        if let chosen = models.first(where: { $0.id == modelID }), let offered = chosen.reasoningEfforts, !offered.isEmpty { return offered }
        var seen = Set<String>()
        var all: [String] = []
        for value in models { for item in value.reasoningEfforts ?? [] where seen.insert(item).inserted { all.append(item) } }
        if !effort.isEmpty && seen.insert(effort).inserted { all.append(effort) }
        return all
    }

    /// Every mode the connected computers' models offer besides the one each starts on by asking, which is what
    /// no default means.
    private func permissions(_ models: [ThreadModel]) -> [DefaultChoice] {
        var seen = Set<String>()
        var all: [DefaultChoice] = []
        for value in models {
            for choice in value.permissions where choice.id != value.startingPermission && seen.insert(choice.id).inserted {
                all.append(DefaultChoice(id: choice.id, name: choice.name))
            }
        }
        if !permission.isEmpty && !seen.contains(permission) {
            all.append(DefaultChoice(id: permission, name: "A mode no connected computer offers"))
        }
        return all
    }

    private func permissionValue(_ models: [ThreadModel]) -> String {
        guard !permission.isEmpty else { return Self.askingChoice }
        return permissions(models).first { $0.id == permission }?.name ?? "A mode no connected computer offers"
    }

    private var currentWorkingCopy: WorkingCopy { WorkingCopy(rawValue: workingCopy) ?? .shared }

    /// Saves a default and says so.
    private func saving(_ stored: Binding<String>) -> Binding<String> {
        Binding(get: { stored.wrappedValue }, set: { value in
            guard value != stored.wrappedValue else { return }
            stored.wrappedValue = value
            announce("New thread defaults saved.")
        })
    }

    private var savingWorkingCopy: Binding<WorkingCopy> {
        Binding(get: { currentWorkingCopy }, set: { value in
            guard value != currentWorkingCopy else { return }
            workingCopy = value.rawValue
            announce("New thread defaults saved.")
        })
    }
}

/// One choice in a default's menu.
private struct DefaultChoice: Identifiable {
    let id: String
    let name: String
}

/// A default: its name, its value, and a chevron. The whole row opens its choices.
private struct DefaultRow<Choices: View>: View {
    let label: String
    let value: String
    let identifier: String
    @ViewBuilder let choices: () -> Choices
    var body: some View {
        Menu {
            choices()
        } label: {
            HStack(spacing: Space.s3) {
                Text(label).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                Spacer(minLength: Space.s2)
                Text(value).font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.muted)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
            .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(PressStyle())
        .accessibilityLabel("New thread \(label.lowercased())")
        .accessibilityValue(value)
        .accessibilityHint("Shows the choices.")
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - About

private struct AboutPanel: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        HStack(spacing: Space.s3) {
            Text("S").font(.custom("Figtree-Bold", fixedSize: 20)).foregroundStyle(Palette.onAccent)
                .frame(width: 44, height: 44)
                .background(Palette.accent, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .shadow(color: theme.color(.accent).opacity(0.5), radius: 10)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Sotto \(version)").font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                Text(connection).font(.sotto(.small)).foregroundStyle(Palette.muted)
            }
        }
        .card()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("setting-about")
    }

    /// The version this build carries, with its build number.
    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        guard let build = info?["CFBundleVersion"] as? String, !build.isEmpty else { return short }
        return "\(short) (\(build))"
    }

    private var connection: String {
        let total = model.computers.count
        let reached = model.computers.filter { model.online($0.hostID) }.count
        if total == 1 { return reached == 1 ? "Connected to its computer" : "Not connected to its computer" }
        return "Connected to \(reached) of \(total) computers"
    }
}

// MARK: - Shared pieces

/// A panel's name and, on the trailing side, what it is set to.
private struct PanelHeader: View {
    let title: String
    let value: String?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s3) {
            Text(title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).accessibilityAddTraits(.isHeader)
            Spacer(minLength: Space.s2)
            if let value {
                Text(value).font(.sotto(.small)).foregroundStyle(Palette.muted).multilineTextAlignment(.trailing)
            }
        }
    }
}

/// Two to three choices in a capsule, the chosen one on a raised knob that slides between them.
private struct Segmented<Value: Hashable>: View {
    let name: String
    let choices: [Value]
    let selection: Value
    let title: (Value) -> String
    let identifier: (Value) -> String
    let pick: (Value) -> Void
    @Namespace private var knob
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 0) {
            ForEach(choices, id: \.self) { choice in
                SegmentButton(title: title(choice), chosen: choice == selection, knob: knob, raised: scheme == .dark) {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { pick(choice) }
                }
                .accessibilityIdentifier(identifier(choice))
            }
        }
        .padding(3)
        .background(Palette.fillSoft, in: Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityLabel(name)
    }
}

private struct SegmentButton: View {
    let title: String
    let chosen: Bool
    let knob: Namespace.ID
    let raised: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.sotto(.small, .semibold))
                .foregroundStyle(chosen ? Palette.ink : Palette.muted)
                .lineLimit(1).minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background {
                    if chosen {
                        Capsule().fill(raised ? Palette.raised : Palette.surface)
                            .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
                            .matchedGeometryEffect(id: "knob", in: knob)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(title)
        .accessibilityValue(chosen ? "Selected" : "Not selected")
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

/// A line under a panel's control.
private struct PanelHint: View {
    let text: String
    var body: some View {
        Text(text).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
    }
}

/// A line under a group of panels.
private struct NoteLine: View {
    let text: String
    var body: some View {
        Text(text).font(.sotto(.small)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Space.s1).padding(.top, Space.s2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct RowDivider: View {
    var body: some View { Rectangle().fill(Palette.hairline).frame(height: 1) }
}
