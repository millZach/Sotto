import XCTest
@testable import SottoCore

/// `thread-words` (Zach's picks of November 19, 2026): Threads' search also finds a thread by what was said in it, from
/// each computer's own threads, and a thread found only that way lists after those found by their own words, with a quote.
final class ThreadWordsTests: XCTestCase {
    private func reply(_ result: String) async throws -> ThreadWordsAnswer? {
        try await Wire.readReply(Data(#"{"v":1,"id":"words","ok":true,"result":\#(result)}"#.utf8), as: Optional<ThreadWordsAnswer>.self)
    }
    private func thread(_ id: String, title: String? = nil, _ extra: String = "") throws -> ThreadSummary {
        try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"\#(id)","projectId":"p","title":"\#(title ?? id)","status":"idle","requests":[]\#(extra)}"#.utf8))
    }
    private func match(_ threadID: String, _ quote: String, role: ThreadWordMatch.Role = .assistant, more: Int = 0) -> ThreadWordMatch {
        ThreadWordMatch(threadId: threadID, messageId: "m-" + threadID, role: role, quote: quote, more: more)
    }

    func testTheRequestCarriesTheTrimmedSearchCutToWhatAComputerTakes() {
        XCTAssertEqual(Wire.threadWords(query: "  rust port \n"), ["op": .string("thread-words"), "query": .string("rust port")])
        XCTAssertNil(Wire.threadWords(query: "   "), "A search with no words asks nothing, which a computer would refuse")
        let long = Wire.threadWords(query: String(repeating: "a", count: 250))
        XCTAssertEqual(long?["query"]?.string, String(repeating: "a", count: 200))
        // A computer counts in UTF-16 units, so a character it would count twice is never cut in two.
        let emoji = Wire.threadWordsQuery(String(repeating: "a", count: 199) + "😀b")
        XCTAssertEqual(emoji, String(repeating: "a", count: 199))
        XCTAssertLessThanOrEqual(Wire.threadWordsQuery(String(repeating: "😀", count: 150)).utf16.count, 200)
        XCTAssertEqual(Wire.threadWordsQuery(String(repeating: "a", count: 199) + " b"), String(repeating: "a", count: 199),
                       "A cut that ends on a space is trimmed again")
    }

    func testAnAnswerReadsWhatEachThreadSaidAndNullSaysTheStoreCannotSay() async throws {
        let answer = try await reply(#"{"found":[{"threadId":"a","messageId":"1","role":"user","quote":"Start the Rust port…","more":2},{"threadId":"b","messageId":"2","role":"assistant","quote":"…builds in Rust.","more":0}]}"#)
        XCTAssertEqual(answer?.found, [
            ThreadWordMatch(threadId: "a", messageId: "1", role: .user, quote: "Start the Rust port…", more: 2),
            ThreadWordMatch(threadId: "b", messageId: "2", role: .assistant, quote: "…builds in Rust.", more: 0),
        ])
        let none = try await reply("null")
        XCTAssertNil(none)
        let empty = try await reply(#"{"found":[]}"#)
        XCTAssertEqual(empty?.found, [])
    }

    func testABadEntryRejectsTheWholeAnswerAsABadSettledPageDoes() async {
        for bad in [#"{"found":[{"threadId":"a","messageId":"1","role":"tool","quote":"x","more":0}]}"#,
                    #"{"found":[{"threadId":"a","messageId":"1","role":"user","more":0}]}"#,
                    #"{"found":"a"}"#] {
            do {
                _ = try await reply(bad)
                XCTFail("Read a bad answer: \(bad)")
            } catch {}
        }
    }

    func testAQuoteMarksTheFirstPlaceItHoldsTheSearchWhateverTheCase() {
        XCTAssertEqual(ThreadWordQuote.parts("…the Rust port, then rust again", query: "rust"), [
            .init(text: "…the ", hit: false), .init(text: "Rust", hit: true), .init(text: " port, then rust again", hit: false),
        ])
        XCTAssertEqual(ThreadWordQuote.parts("Rust first", query: "RUST"), [.init(text: "Rust", hit: true), .init(text: " first", hit: false)])
        XCTAssertEqual(ThreadWordQuote.parts("ends in café", query: "cafe"), [.init(text: "ends in ", hit: false), .init(text: "café", hit: true)])
        XCTAssertEqual(ThreadWordQuote.parts("nothing here", query: "rust"), [.init(text: "nothing here", hit: false)])
        XCTAssertEqual(ThreadWordQuote(match: match("a", "a flake"), query: "flake").parts.last, ThreadWordQuote.Part(text: "flake", hit: true))
    }

    func testMatchesAreKeyedAsRowsAreAndALongerSearchKeepsOnlyQuotesThatStillHoldIt() {
        let search = ThreadWordsSearch(query: "rust", found: [
            "laptop": [match("a", "the Rust port"), match("b", "rust belt"), match("a", "an older match")],
            "forge": [match("a", "Rust on forge")],
        ])
        XCTAssertEqual(Set(search.matches(for: " rust ").keys), ["laptop/a", "laptop/b", "forge/a"])
        XCTAssertEqual(search.matches(for: "rust")["laptop/a"]?.quote, "the Rust port", "A thread named twice keeps its newest match")
        XCTAssertEqual(Set(search.matches(for: "rust port").keys), ["laptop/a"])
        XCTAssertTrue(search.matches(for: "ru").isEmpty, "A shorter search waits for its own answer")
        XCTAssertTrue(search.matches(for: "flake").isEmpty)
        XCTAssertTrue(search.matches(for: "").isEmpty)
        XCTAssertTrue(ThreadWordsSearch().matches(for: "rust").isEmpty)
    }

    func testAThreadFoundOnlyByWhatWasSaidListsAfterTitleMatchesInItsGroup() throws {
        let words = try thread("words", title: "Clean up worktrees", #", "summary":{"lastMessageAt":"2026-11-19T10:00:00Z"}"#)
        let titled = try thread("titled", title: "Port to Rust", #", "summary":{"lastMessageAt":"2026-11-19T09:00:00Z"}"#)
        let both = try thread("both", title: "Rust research", #", "summary":{"lastMessageAt":"2026-11-19T08:00:00Z"}"#)
        let other = try thread("other", title: "Release 0.1.43")
        let settledWords = try thread("settled-words", title: "Teams Watchers", #", "settledAt":"2026-11-03T00:00:00Z""#)
        let settledTitle = try thread("settled-title", title: "Rust thoughts", #", "settledAt":"2026-11-01T00:00:00Z""#)
        let computer = ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [words, titled, both, other, settledWords, settledTitle])
        let said = ["h/words": match("words", "…moved the Rust code"), "h/both": match("both", "rust again"),
                    "h/settled-words": match("settled-words", "Rust link", role: .user, more: 3)]
        let groups = FocusThreads([computer], query: "rust", words: said)
        // The newest thread lists last: what was said found it, not its title.
        XCTAssertEqual(groups.recent.map(\.id), ["h/titled", "h/both", "h/words"])
        XCTAssertEqual(groups.settled.map(\.id), ["h/settled-title", "h/settled-words"])
        XCTAssertEqual(groups.wordOnly, ["h/words", "h/settled-words"])
        XCTAssertEqual(groups.quote(groups.recent[2]), ThreadWordQuote(match: said["h/words"]!, query: "rust"))
        XCTAssertNil(groups.quote(groups.recent[1]), "A thread its own words found shows no quote")
        XCTAssertNil(groups.quote(groups.recent[0]))
        XCTAssertEqual(groups.quote(groups.settled[1])?.match.more, 3)
        // A settled thread read from the computer, which the list leaves out, is tested the same way.
        let heldBack = [try thread("held", title: "Paired host terminal", #", "settledAt":"2026-11-02T00:00:00Z""#),
                        try thread("held-title", title: "Rust host", #", "settledAt":"2026-11-02T00:00:00Z""#)]
        let read = ThreadGroups.older([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [])], read: ["h": heldBack])
        let held = FocusThreads([computer], query: "rust", words: ["h/held": match("held", "rust there"), "h/held-title": match("held-title", "rust")])
        XCTAssertNotNil(held.quote(read[0]))
        XCTAssertNil(held.quote(read[1]))
        XCTAssertEqual(held.ownWordsFirst(read).map(\.thread.id), ["held-title", "held"])
    }

    func testNoMatchesLeaveTheListAsItWas() throws {
        let threads = [try thread("Rust one", #", "summary":{"lastMessageAt":"2026-11-19T10:00:00Z"}"#),
                       try thread("two", #", "summary":{"lastMessageAt":"2026-11-19T09:00:00Z"}"#),
                       try thread("rust settled", #", "settledAt":"2026-11-01T00:00:00Z""#)]
        let computer = ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: threads)
        for query in ["", "rust"] {
            let before = FocusThreads([computer], query: query)
            let after = FocusThreads([computer], query: query, words: [:])
            XCTAssertEqual(after.recent.map(\.id), before.recent.map(\.id))
            XCTAssertEqual(after.settled.map(\.id), before.settled.map(\.id))
            XCTAssertTrue(after.wordOnly.isEmpty)
            XCTAssertEqual(after.ownWordsFirst(after.settled).map(\.id), before.settled.map(\.id))
        }
        // With nothing typed, a match never adds a row.
        let unsearched = FocusThreads([computer], words: ["h/two": match("two", "rust")])
        XCTAssertEqual(unsearched.recent.map(\.id), ["h/Rust one", "h/two"])
        XCTAssertTrue(unsearched.wordOnly.isEmpty)
        XCTAssertNil(unsearched.quote(unsearched.recent[1]))
        XCTAssertEqual(FocusThreads([computer], query: "rust").recent.map(\.id), ["h/Rust one"])
    }

    func testASnoozedProjectListsItsTitleMatchesFirst() throws {
        let now = try XCTUnwrap(Stamp.date("2026-11-19T09:00:00Z"))
        let snooze = #", "snoozedUntil":"2026-11-19T12:00:00Z""#
        let newest = try thread("newest", title: "Owl sprite", snooze + #", "updatedAt":"2026-11-19T08:00:00Z""#)
        let older = try thread("older", title: "Rust sprite", snooze + #", "updatedAt":"2026-11-19T07:00:00Z""#)
        let computer = ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [newest, older])
        let groups = FocusThreads([computer], query: "rust", words: ["h/newest": match("newest", "in Rust")], now: now)
        XCTAssertEqual(groups.snoozed.map(\.id), ["h/older", "h/newest"])
        XCTAssertEqual(groups.snoozedProjects.first?.rows.map(\.id), ["h/older", "h/newest"])
        XCTAssertEqual(FocusThreads([computer], now: now).snoozedProjects.first?.rows.map(\.id), ["h/newest", "h/older"])
    }
}
