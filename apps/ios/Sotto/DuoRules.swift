import SwiftUI

// The iPhone Duo's rules that its views follow and the app model's tests can reach: the sheet Sotto draws over the page
// held sideways, and a few choices of words. It imports SwiftUI alone, so the macOS test target compiles it.

/// The sheet Sotto draws over the page on the Duo held sideways, and what closes it. iOS centres its own sheet in the
/// window, where it cut the sidebar's names mid-word, so here the sheet stands over the page alone, from the sidebar's
/// edge to the rail, and the sidebar stays whole beside it (Zach's pick A, November 9, 2026, round 4).
@MainActor final class DuoSheetHost: ObservableObject {
    struct Shown {
        let id: UUID
        /// The question sheet's warm wash at its top.
        let wash: Bool
        /// A sheet that takes the page's height runs on to the screen's foot (`DuoSheetLayer`).
        var toFoot = false
        let content: AnyView
        let close: () -> Void
    }
    @Published private(set) var shown: Shown?
    /// Shows a sheet. One already up is closed through its own binding, so its presenter knows it went, runs its
    /// `onDismiss` and can open it again, where it had been replaced and left thinking it was still up.
    func show(_ sheet: Shown) {
        let old = shown
        shown = sheet
        old?.close()
    }
    func gone(_ id: UUID) { if shown?.id == id { shown = nil } }
}

/// What a Duo sheet presenter does next, from whether its sheet should show, whether Sotto draws it (the Duo held
/// sideways) and whether it is up in the host now. One rule for a sheet opening or closing and for the Duo turning or
/// folding, so a turn moves an open sheet between Sotto's sheet and iOS's own rather than closing it.
enum DuoSheetStep: Equatable {
    case none
    /// Put the sheet up in the host.
    case show
    /// Take it out of the host. `dismissed` when the sheet closed, so its `onDismiss` runs; not when it moved on to iOS's
    /// own sheet because the Duo turned or folded.
    case take(dismissed: Bool)

    static func next(presented: Bool, own: Bool, inHost: Bool) -> DuoSheetStep {
        if presented && own { return inHost ? .none : .show }
        return inHost ? .take(dismissed: !presented) : .none
    }
}

/// Words the Duo says differently from every other iPhone, and the rules for when a line can go.
enum DuoWords {
    /// Whether Watcher's words name a thread by its title, so a card straight after them need not name it again: the
    /// title whole, not inside another word, and long enough to be a name rather than a common word, three words or
    /// twelve letters. "Tests" was found in "running the tests again" and the card lost its thread's name.
    static func names(_ text: String, title: String) -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard title.split(whereSeparator: \.isWhitespace).count >= 3 || title.count >= 12 else { return false }
        var from = text.startIndex
        while let found = text.range(of: title, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
            let before = found.lowerBound == text.startIndex ? nil : text[text.index(before: found.lowerBound)]
            let after = found.upperBound == text.endIndex ? nil : text[found.upperBound]
            if !Self.wordy(before) && !Self.wordy(after) { return true }
            from = found.upperBound
        }
        return false
    }
    private static func wordy(_ character: Character?) -> Bool { character.map { $0.isLetter || $0.isNumber } ?? false }

    private static let bareAnswers: Set<String> = ["yes", "no", "y", "n", "true", "false", "on", "off", "n/a", "na", "none"]

    /// Whether a short table value says what it is without its column: words do; a bare answer, number or mark doesn't,
    /// so a folded table card names its column before it ("Fixed: No").
    static func namesItself(_ value: String) -> Bool {
        let words = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return words.contains(where: \.isLetter) && !bareAnswers.contains(words.lowercased())
    }

    /// A working card's last line when this iPhone has no step to show. On the Duo nothing, since the state and the place
    /// above already say the agent works on its computer (Zach's pick B, November 9, 2026); every other iPhone says it.
    static func workingLine(provider: String, computer: String, onDuo: Bool) -> String? {
        onDuo ? nil : String(localized: "\(provider) is working on \(computer).", comment: "First %@ is the agent's name, such as Codex; second is the computer's name.")
    }

    /// A question card's note when this iPhone can't answer on the thread's computer. On the Duo it says where to answer
    /// (Zach's pick B, November 9, 2026); every other iPhone keeps its words.
    static func cantAnswerHere(computer: String, onDuo: Bool) -> String {
        onDuo
            ? String(localized: "Answer it on \(computer).", comment: "On a question card when this iPhone can't answer on the thread's computer. %@ is the computer's name.")
            : String(localized: "This iPhone can’t answer on \(computer) yet.", comment: "%@ is the computer's name.")
    }
}
