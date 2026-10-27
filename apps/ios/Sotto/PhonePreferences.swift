import Foundation

/// Preferences kept on this iPhone in UserDefaults (ADR-0051). Nothing here is sent to a paired computer or
/// changes its settings. SwiftUI views read these keys with `@AppStorage`; anything else, the app model included,
/// reads them through `PhonePreferences`. This file imports Foundation only so the model's tests can compile it.
enum PhonePreferenceKey {
    /// A built-in palette's id: sotto, hush, citrine, graphite, clay, fern or vellum. One saved before October 26,
    /// 2026 may name linen, nocturne or tropic; `PhoneThemeID.current` reads it as the palette that replaced it.
    static let theme = "phoneTheme"
    /// dark, light or system.
    static let appearance = "phoneAppearance"
    /// One of `PhoneTextSize`'s raw values. Missing until the user picks one; see `PhonePreferences.textSize`.
    static let textSize = "phoneTextSize"
    /// The earlier Larger text switch. Read only to carry it over as the Larger step.
    static let legacyLargerText = "phoneLargerText"
    /// comfortable or compact.
    static let density = "phoneDensity"
    static let notifyNeedsYou = "phoneNotifyNeedsYou"
    static let notifyFinished = "phoneNotifyFinished"
    static let notifyFailed = "phoneNotifyFailed"
    static let notifySound = "phoneNotifySound"
    /// New-thread defaults. Empty means the chosen computer's own saved choice applies.
    static let newThreadModel = "phoneNewThreadModel"
    static let newThreadEffort = "phoneNewThreadEffort"
    static let newThreadPermission = "phoneNewThreadPermission"
    static let newThreadWorkingCopy = "phoneNewThreadWorkingCopy"
}

/// So an iPhone that saved a palette the desktop has since retired paints its replacement (ADR-0024).
enum PhoneThemeID {
    /// The id a saved choice paints now: a retired palette's replacement, any other id as it was.
    static func current(_ id: String) -> String { ThemePalettes.retired[id] ?? id }
}

/// Dark, Light, or following the iPhone. Dark is the default.
enum PhoneAppearance: String, CaseIterable {
    case dark, light, system
    var title: String {
        switch self {
        case .dark: return String(localized: "Dark", comment: "Appearance choice: always dark.")
        case .light: return String(localized: "Light", comment: "Appearance choice: always light.")
        case .system: return String(localized: "System", comment: "Appearance choice: follow the iPhone's own setting.")
        }
    }
}

/// Five text sizes. Each moves the iPhone's own text size up or down; none goes below a size iOS asks for
/// through its accessibility settings.
enum PhoneTextSize: String, CaseIterable {
    case smaller, standard = "default", large, larger, largest
    var title: String {
        switch self {
        case .smaller: return String(localized: "Smaller", comment: "Text size step, one below the iPhone's own size.")
        case .standard: return String(localized: "text-size.default", defaultValue: "Default", comment: "Text size step: the iPhone's own size.")
        case .large: return String(localized: "Large", comment: "Text size step, one above the iPhone's own size.")
        case .larger: return String(localized: "Larger", comment: "Text size step, two above the iPhone's own size.")
        case .largest: return String(localized: "Largest", comment: "Text size step, three above the iPhone's own size.")
        }
    }
    /// Steps from the iPhone's own text size.
    var offset: Int {
        switch self {
        case .smaller: return -1
        case .standard: return 0
        case .large: return 1
        case .larger: return 2
        case .largest: return 3
        }
    }
    /// The stored step, or the earlier Larger text switch carried over as Larger.
    static func resolve(_ raw: String, legacyLarger: Bool) -> PhoneTextSize {
        if let size = PhoneTextSize(rawValue: raw) { return size }
        return legacyLarger ? .larger : .standard
    }
}

/// How much room messages, lists and steps get.
enum PhoneDensity: String, CaseIterable {
    case comfortable, compact
    var title: String { self == .comfortable ? String(localized: "Comfortable", comment: "Message density choice: more room between messages.") : String(localized: "Compact", comment: "Message density choice: tighter spacing.") }
}

/// Where a new thread works: the project's shared folder or a new worktree.
enum PhoneWorkingCopy: String, CaseIterable {
    case shared, independent
    var title: String { self == .shared ? String(localized: "Project folder", comment: "Where a new thread works: the project's shared folder.") : String(localized: "New worktree", comment: "Where a new thread works: a new git worktree of its own.") }
}

/// Reads and writes the preferences outside SwiftUI.
struct PhonePreferences {
    var defaults: UserDefaults = .standard

    var themeID: String { PhoneThemeID.current(defaults.string(forKey: PhonePreferenceKey.theme) ?? "sotto") }
    var appearance: PhoneAppearance {
        defaults.string(forKey: PhonePreferenceKey.appearance).flatMap(PhoneAppearance.init(rawValue:)) ?? .dark
    }
    var textSize: PhoneTextSize {
        PhoneTextSize.resolve(defaults.string(forKey: PhonePreferenceKey.textSize) ?? "",
                              legacyLarger: defaults.bool(forKey: PhonePreferenceKey.legacyLargerText))
    }
    var density: PhoneDensity {
        defaults.string(forKey: PhonePreferenceKey.density).flatMap(PhoneDensity.init(rawValue:)) ?? .comfortable
    }
    /// Each notification is off until the user turns it on.
    var notifyNeedsYou: Bool { defaults.bool(forKey: PhonePreferenceKey.notifyNeedsYou) }
    var notifyFinished: Bool { defaults.bool(forKey: PhonePreferenceKey.notifyFinished) }
    var notifyFailed: Bool { defaults.bool(forKey: PhonePreferenceKey.notifyFailed) }
    var notifySound: Bool { defaults.bool(forKey: PhonePreferenceKey.notifySound) }
    /// A new-thread default, or nil where the computer's own choice applies.
    var newThreadModel: String? { chosen(PhonePreferenceKey.newThreadModel) }
    var newThreadEffort: String? { chosen(PhonePreferenceKey.newThreadEffort) }
    var newThreadPermission: String? { chosen(PhonePreferenceKey.newThreadPermission) }
    var newThreadWorkingCopy: PhoneWorkingCopy? { chosen(PhonePreferenceKey.newThreadWorkingCopy).flatMap(PhoneWorkingCopy.init(rawValue:)) }

    private func chosen(_ key: String) -> String? {
        guard let value = defaults.string(forKey: key), !value.isEmpty else { return nil }
        return value
    }

    /// Carries the earlier Larger text switch over as the Larger step, once, so the five-step control shows it.
    func migrate() {
        guard defaults.string(forKey: PhonePreferenceKey.textSize) == nil,
              defaults.bool(forKey: PhonePreferenceKey.legacyLargerText) else { return }
        defaults.set(PhoneTextSize.larger.rawValue, forKey: PhonePreferenceKey.textSize)
    }
}
