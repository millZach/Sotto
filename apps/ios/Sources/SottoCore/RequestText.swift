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

    /// The line over a summary, saying whose words they are: the model's own, or what Sotto got by asking its provider about
    /// the command alone. Sotto checks neither, so they never read as Sotto's account (ADR-0180).
    public static func summaryHeading(_ context: RequestContext, provider: String) -> String {
        context.summaryAsk == "answered"
            ? String(localized: "Sotto asked \(provider) what this does", bundle: .module, comment: "Over a summary of a command that Sotto asked the coding agent's provider for. %@ is its name, such as Codex.")
            : String(localized: "\(provider) says", bundle: .module, comment: "Over the words a coding agent wrote about what it asks to do. %@ is its name, such as Claude Code.")
    }

    /// What a command's card says while it has no summary: Sotto is asking, asking failed, or none came.
    public static func noSummary(_ context: RequestContext, provider: String) -> String {
        switch context.summaryAsk {
        case "waiting": return String(localized: "Asking \(provider) for a summary…", bundle: .module, comment: "Shown while Sotto waits for a summary of a command. The user can answer without waiting. %@ is the coding agent's name.")
        case "failed": return String(localized: "\(provider) couldn’t give a summary of this command.", bundle: .module, comment: "%@ is the coding agent's name, such as Codex.")
        default: return String(localized: "\(provider) gave no summary of this command.", bundle: .module, comment: "%@ is the coding agent's name, such as Codex.")
        }
    }

    /// What a permission's short card says it asks. A command's words sit over its command, so they are the summary and
    /// never the command again; any other request has only its own text.
    public static func permissionAsk(_ request: AgentRequest, provider: String) -> String {
        guard let context = request.context, context.command != nil else { return request.text }
        guard let summary = context.summary else { return noSummary(context, provider: provider) }
        return context.summaryAsk == "answered"
            ? String(localized: "Sotto asked \(provider) what this does: \(summary)", bundle: .module, comment: "The first %@ is the coding agent's name, such as Codex; the second is the summary its provider gave.")
            : String(localized: "\(provider) says: \(summary)", bundle: .module, comment: "The first %@ is the coding agent's name, such as Claude Code; the second is the words it wrote about what it asks to do.")
    }

    /// What a permission's sheet leads with, and the rest of its words (#1855). A command's words never lead: they can hold
    /// the model's summary, which reads as the model's under the headline (ADR-0180), so the sheet says a command is asked.
    /// Any other request leads with what it does, or with the first line of its words when it says nothing more exact.
    public static func permissionLead(_ request: AgentRequest) -> (headline: String?, rest: String?) {
        guard request.context?.command == nil else { return (nil, nil) }
        if let action = request.context?.action { return (action, nil) }
        let lines = request.text.split(separator: "\n", omittingEmptySubsequences: false)
        let first = lines.first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        let rest = lines.dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (first.isEmpty ? nil : first, rest.isEmpty ? nil : rest)
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
    public static func find(in question: Question) -> [URL] { find(in: texts(question)) }

    /// Every link in a request: its own words, then each question's, then any choices it carries without questions.
    public static func find(in request: AgentRequest) -> [URL] { find(in: texts(request)) }

    /// Every link a question's sheet shows: the request's own, then those in the agent's message just before it that the
    /// request doesn't already show, which the sheet covers. A request has no place in the thread of its own, but the
    /// agent waits on the answer, so its newest message is the one the question follows. A visual reaches a phone as its
    /// words alone, and words alone are a reply like any other (ADR-0056).
    public static func find(in request: AgentRequest, after messages: [Message]) -> [URL] {
        guard let message = messages.last(where: { $0.role == "assistant" }) else { return find(in: request) }
        return find(in: texts(request) + [message.text])
    }

    private static func texts(_ request: AgentRequest) -> [String] {
        [request.text] + (request.questions ?? []).flatMap(texts) + request.options.flatMap { [$0.label, $0.description ?? ""] }
    }

    private static func texts(_ question: Question) -> [String] {
        [question.question, question.header ?? ""] + question.options.flatMap { [$0.label, $0.description ?? ""] }
    }

    /// The links without the loopback addresses a question's pages already open (ADR-0085). Such a page opens through the
    /// computer that runs the thread; its own address names that computer's loopback, which a phone cannot reach.
    public static func withoutPages(_ links: [URL], _ pages: [RequestPage]) -> [URL] {
        let served = Set(pages.filter { $0.kind == "server" }.map { "\($0.name.lowercased())/\($0.start)" })
        return links.filter { url in
            let host = ((url.host ?? "") + (url.port.map { ":\($0)" } ?? "")).lowercased()
            // The page's start is its path without the leading slash, then its query and fragment, as the computer wrote it.
            let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
            let start = String(path.drop { $0 == "/" }) + (url.query.map { "?\($0)" } ?? "") + (url.fragment.map { "#\($0)" } ?? "")
            return !served.contains("\(host)/\(start)")
        }
    }

    /// Where a link goes, as its row shows it: the host, its port when it names one, and the path, without the scheme.
    public static func place(_ url: URL) -> String {
        let host = (url.host ?? "") + (url.port.map { ":\($0)" } ?? "")
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
