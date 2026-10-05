import Foundation

/// Preferences kept on this iPhone in UserDefaults (ADR-0051). Nothing here is sent to a paired computer or
/// changes its settings. SwiftUI views read these keys with `@AppStorage`; anything else, the app model included,
/// reads them through `PhonePreferences`. This file imports Foundation only so the model's tests can compile it.
enum PhonePreferenceKey {
    /// A built-in palette's id: sotto, hush, linen, nocturne, tropic or citrine.
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

/// Dark, Light, or following the iPhone. Dark is the default.
enum PhoneAppearance: String, CaseIterable {
    case dark, light, system
    var title: String {
        switch self {
        case .dark: return "Dark"
        case .light: return "Light"
        case .system: return "System"
        }
    }
}

/// Five text sizes. Each moves the iPhone's own text size up or down; none goes below a size iOS asks for
/// through its accessibility settings.
enum PhoneTextSize: String, CaseIterable {
    case smaller, standard = "default", large, larger, largest
    var title: String {
        switch self {
        case .smaller: return "Smaller"
        case .standard: return "Default"
        case .large: return "Large"
        case .larger: return "Larger"
        case .largest: return "Largest"
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
    var title: String { self == .comfortable ? "Comfortable" : "Compact" }
}

/// Where a new thread works: the project's shared folder or a new worktree.
enum PhoneWorkingCopy: String, CaseIterable {
    case shared, independent
    var title: String { self == .shared ? "Project folder" : "New worktree" }
}

/// Reads and writes the preferences outside SwiftUI.
struct PhonePreferences {
    var defaults: UserDefaults = .standard

    var themeID: String { defaults.string(forKey: PhonePreferenceKey.theme) ?? "sotto" }
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
