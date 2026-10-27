import Foundation

/// The language Sotto's interface is written in on this iPhone, and what follows from it (ADR-0123). Sotto follows
/// the iPhone's language, or the one chosen for Sotto in the iPhone's Settings, when the app has it, and English
/// otherwise; iOS makes that choice and the bundle's preferred localization records it.
public enum Interface {
    /// The localization iOS chose for the app, such as `en`, `es-MX` or `zh-Hans`.
    public static let language: String = Bundle.main.preferredLocalizations.first ?? "en"

    /// The language code without its region or script, such as `es` or `zh`. Read once: every font Sotto makes asks it.
    public static let languageCode: String = String(language.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? "en")

    /// True in Arabic and Urdu. The window keeps its English layout there; only paragraph text runs right to left,
    /// inside its own box.
    public static let rightToLeft: Bool = Locale.Language(identifier: language).characterDirection == .rightToLeft

    /// True where Figtree's negative heading tracking would break the script: joined scripts (Arabic, Urdu), the
    /// Indic scripts, and Chinese and Japanese, none of which Figtree draws.
    public static let keepsTracking: Bool = !["ar", "ur", "hi", "bn", "mr", "te", "ta", "zh", "ja"].contains(languageCode)

    /// Code, paths, branch names and commands set inside a sentence of right-to-left text stay left to right and
    /// apart from the words around them. In a left-to-right interface the text comes back unchanged.
    public static func isolated(_ text: String) -> String {
        rightToLeft ? "\u{2066}" + text + "\u{2069}" : text
    }
}
