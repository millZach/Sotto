import Foundation

/// Search threads' look through what was said (`thread-words`, Zach's picks of November 19, 2026, the desktop's
/// `src/shared/threadWords.ts`). A computer that offers the feature answers `thread-words` with the threads whose messages
/// hold the words searched: the user's messages and the agents' replies, never a step's command or output. Each thread it
/// names carries a quote of its newest matching message and how many other messages match. Each computer searches its own
/// threads, so Threads' search asks every computer it can reach that offers the read, and asks nothing of one that doesn't.

/// One thread a computer found by what was said in it: a quote of its newest matching message, whose words they were, and
/// how many other messages of the thread match too.
public struct ThreadWordMatch: Decodable, Equatable, Sendable {
    /// Whose words matched: the user's, or an agent's reply.
    public enum Role: String, Decodable, Sendable { case user, assistant }
    /// The computer's own ID for the thread, as its list names it.
    public let threadId: String
    public let messageId: String
    public let role: Role
    /// The match with some words around it, on one line, an ellipsis where the message goes on.
    public let quote: String
    public let more: Int
    public init(threadId: String, messageId: String, role: Role, quote: String, more: Int) {
        self.threadId = threadId; self.messageId = messageId; self.role = role; self.quote = quote; self.more = more
    }
}

/// One computer's answer to `thread-words`, newest match first. A computer whose thread store cannot say answers null.
public struct ThreadWordsAnswer: Decodable, Equatable, Sendable {
    public let found: [ThreadWordMatch]
}

public extension Wire {
    static let threadWordsFeature = "thread-words"
    /// The longest search a computer reads, counted as it counts, in UTF-16 units.
    static let threadWordsLongest = 200
    /// A search as a computer reads it: trimmed, and cut to the longest it takes without cutting a character in two.
    static func threadWordsQuery(_ query: String) -> String {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf16.count > threadWordsLongest else { return trimmed }
        var cut = "", units = 0
        for character in trimmed {
            units += character.utf16.count
            if units > threadWordsLongest { break }
            cut.append(character)
        }
        return cut.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /// The threads whose messages hold `query`, or nothing for a search with no words, which a computer refuses.
    static func threadWords(query: String) -> [String: JSONValue]? {
        let words = threadWordsQuery(query)
        guard !words.isEmpty else { return nil }
        return ["op": .string("thread-words"), "query": .string(words)]
    }
}

/// What Threads' search last read of what was said in the computers' threads: the search it answers, and each computer's
/// matches by its own thread ID. A computer that could not answer has none.
public struct ThreadWordsSearch: Equatable, Sendable {
    public let query: String
    public let found: [String: [String: ThreadWordMatch]]
    /// `found` is each computer's answer by host ID, newest match first; a thread named twice keeps its newest.
    public init(query: String = "", found: [String: [ThreadWordMatch]] = [:]) {
        self.query = query
        self.found = found.mapValues { matches in Dictionary(matches.map { ($0.threadId, $0) }, uniquingKeysWith: { first, _ in first }) }
    }
    /// The matches the list shows for `query`, by row ID (`ThreadRef.id`): this answer's, when it answers that search. While
    /// the answer to a longer search that holds this one is on its way, only the matches whose quote still holds the longer
    /// search stay, so a row found by what was said does not leave and come back with each key. Nothing for any other search.
    public func matches(for query: String) -> [String: ThreadWordMatch] {
        let words = Wire.threadWordsQuery(query)
        guard !words.isEmpty, !self.query.isEmpty else { return [:] }
        let same = words == self.query
        guard same || ThreadWordQuote.holds(words, self.query) else { return [:] }
        var matches: [String: ThreadWordMatch] = [:]
        for (hostID, threads) in found {
            for (threadID, match) in threads where same || ThreadWordQuote.holds(match.quote, words) {
                matches[ThreadRef(hostID: hostID, threadID: threadID).id] = match
            }
        }
        return matches
    }
}

/// The quote a row shows under its name when the search found its thread only by what was said in it (Zach's pick A,
/// November 19, 2026): whose words, the search's words marked in them, and how many other messages match.
public struct ThreadWordQuote: Equatable, Sendable {
    /// A stretch of the quote, and whether it is the search's words.
    public struct Part: Equatable, Sendable {
        public let text: String; public let hit: Bool
        public init(text: String, hit: Bool) { self.text = text; self.hit = hit }
    }
    public let match: ThreadWordMatch
    /// The search, trimmed, whose words the quote marks.
    public let query: String
    public init(match: ThreadWordMatch, query: String) { self.match = match; self.query = query }
    /// The quote in parts, with the first place it holds the search's words marked.
    public var parts: [Part] { Self.parts(match.quote, query: query) }
    /// `quote` in parts, with the first place it holds `query` marked, whatever the case or accents. A quote that doesn't
    /// hold it is one unmarked part.
    public static func parts(_ quote: String, query: String) -> [Part] {
        guard !query.isEmpty, let hit = quote.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) else {
            return [Part(text: quote, hit: false)]
        }
        var parts: [Part] = []
        if hit.lowerBound > quote.startIndex { parts.append(Part(text: String(quote[..<hit.lowerBound]), hit: false)) }
        parts.append(Part(text: String(quote[hit]), hit: true))
        if hit.upperBound < quote.endIndex { parts.append(Part(text: String(quote[hit.upperBound...]), hit: false)) }
        return parts
    }
    /// Whether `text` holds `words`, whatever the case or accents.
    static func holds(_ text: String, _ words: String) -> Bool {
        text.range(of: words, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }
}
