import Foundation

/// Words from an agent's reply written into the reply box, as the desktop writes a reply quote into a prompt (ADR-0129,
/// `replyQuoteText` in src/renderer/src/agents/replyQuotes.ts). The phone writes the quote into the draft itself, so
/// the user sees and can edit exactly what the agent will read.
public enum ReplyQuote {
    /// The text without blank lines before or after it, and line ends trimmed; the first line keeps its indentation.
    public static func trimBlankLines(_ text: String) -> String {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in String(line[..<(line.lastIndex { !$0.isWhitespace }.map(line.index(after:)) ?? line.startIndex)]) }
        guard let first = lines.firstIndex(where: { !$0.isEmpty }), let last = lines.lastIndex(where: { !$0.isEmpty }) else { return "" }
        return lines[first...last].joined(separator: "\n")
    }

    /// One quote as the provider reads it: a line saying where it is from, then each line as a Markdown blockquote.
    /// Nil when the words are only white space.
    public static func text(_ words: String) -> String? {
        let trimmed = trimBlankLines(words)
        guard !trimmed.isEmpty else { return nil }
        let lines = trimmed.split(separator: "\n", omittingEmptySubsequences: false).map { $0.isEmpty ? ">" : "> \($0)" }
        return "From your earlier reply:\n" + lines.joined(separator: "\n")
    }

    /// The draft with the quote after it, set apart by a blank line, and a blank line after the quote so what the user
    /// types next is their own words rather than more of the quote. Nil when the words are only white space.
    public static func appending(_ words: String, to draft: String) -> String? {
        guard let quote = text(words) else { return nil }
        let kept = String(draft[..<(draft.lastIndex { !$0.isWhitespace }.map(draft.index(after:)) ?? draft.startIndex)])
        return (kept.isEmpty ? "" : kept + "\n\n") + quote + "\n\n"
    }
}
