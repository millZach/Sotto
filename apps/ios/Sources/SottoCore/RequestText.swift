import Foundation

/// How the question sheet reads a request's own words, as the desktop's request card does
/// (`requestExplanation` in src/renderer/src/agents/requests/AgentRequestCard.tsx).
public enum RequestText {
    /// A structured request's own explanation, exactly as the provider sent it, or nil when its text only restates the
    /// questions. Providers without a request-level message fill the text from the question prompts, numbered when
    /// there are several and sometimes followed by the choice labels; a Codex form keeps its message there.
    public static func explanation(_ request: AgentRequest) -> String? {
        guard !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var rest = collapse(request.text)
        let questions = request.questions ?? []
        // Prompts first, longest first, so a prompt containing a shorter one or a choice label is removed whole.
        let pieces = questions.map(\.question) + questions.flatMap { [$0.header ?? ""] + $0.options.map(\.label) }
        for piece in pieces.map(collapse).filter({ !$0.isEmpty }).sorted(by: { $0.count > $1.count }) {
            rest = rest.replacingOccurrences(of: piece, with: " ")
        }
        return rest.range(of: #"^(?:\s|[0-9]+\.|[()/;,])*$"#, options: .regularExpression) != nil ? nil : request.text
    }

    /// Every run of white space as one space, with none at either end.
    private static func collapse(_ value: String) -> String {
        value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

/// The web links in a request, lifted into rows of their own so a tap opens the page and never picks a choice.
public enum WebLinks {
    /// Every http and https address written out in these texts, each once, in the order they first appear. An address
    /// needs its scheme: a bare name such as README.md is never a link. Punctuation that ends a sentence, or closes a
    /// bracket the address didn't open, is left out.
    public static func find(in texts: [String]) -> [URL] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        var found: [URL] = []
        var seen: Set<String> = []
        for text in texts where !text.isEmpty {
            for match in detector.matches(in: text, options: [], range: NSRange(text.startIndex..., in: text)) {
                guard let range = Range(match.range, in: text) else { continue }
                let written = trimmed(String(text[range]))
                let lower = written.lowercased()
                guard lower.hasPrefix("http://") || lower.hasPrefix("https://"), let url = URL(string: written),
                      let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
                      let host = url.host, !host.isEmpty, seen.insert(url.absoluteString).inserted else { continue }
                found.append(url)
            }
        }
        return found
    }

    /// The links in one question: in its prompt, its header, and each choice's label and description.
    public static func find(in question: Question) -> [URL] {
        find(in: [question.question, question.header ?? ""] + question.options.flatMap { [$0.label, $0.description ?? ""] })
    }

    /// Where a link goes, as its row shows it: the host and path, without the scheme.
    public static func place(_ url: URL) -> String {
        let host = url.host ?? ""
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
        return path.isEmpty || path == "/" ? host : host + path
    }

    /// The address without what ends the sentence around it.
    private static func trimmed(_ written: String) -> String {
        var value = written
        let closing: [Character: Character] = [")": "(", "]": "[", "}": "{", ">": "<"]
        while let last = value.last {
            if ".,;:!?'\"".contains(last) {
                value.removeLast()
            } else if let opening = closing[last], value.filter({ $0 == opening }).count < value.filter({ $0 == last }).count {
                value.removeLast()
            } else {
                break
            }
        }
        return value
    }
}
