import XCTest
@testable import SottoCore

/// The question sheet's reading of a request: no summary a provider built from its own questions, and the links in it.
final class RequestTextTests: XCTestCase {
    private func request(_ json: String) throws -> AgentRequest { try JSONDecoder().decode(AgentRequest.self, from: Data(json.utf8)) }
    private let database = #"{"id":"0","question":"Which database?","header":"Database","options":[{"id":"Postgres","label":"Postgres"},{"id":"SQLite","label":"SQLite"}],"multiSelect":false,"allowFreeText":true}"#
    private let service = #"{"id":"1","question":"Name the service","options":[],"multiSelect":false,"allowFreeText":true}"#

    // MARK: Explanation

    /// The same requests as the desktop's "does not repeat text a provider built from its own question prompts and choices".
    func testTextAProviderBuiltFromItsOwnQuestionsIsNoExplanation() throws {
        let claude = try request(#"{"id":"c-1","kind":"question","text":"1. Which database?\nPostgres / SQLite\n2. Name the service","options":[],"questions":[\#(database),\#(service)]}"#)
        let claudeOne = try request(#"{"id":"c-2","kind":"question","text":"Which database?","options":[{"id":"Postgres","label":"Postgres"},{"id":"SQLite","label":"SQLite"}],"questions":[\#(database)]}"#)
        let codex = try request(#"{"id":"u-1","kind":"question","text":"1. Which database? (Postgres; SQLite)\n2. Name the service","options":[],"questions":[\#(database),\#(service)]}"#)
        let grok = try request(#"{"id":"g-1","kind":"question","text":"Which database?\nName the service","options":[],"questions":[\#(database),\#(service)]}"#)
        let channel = #"{"id":"channel","question":"Where should the notes go?","header":"Channel","options":[{"id":"blog","label":"Blog post"},{"id":"email","label":"Email digest"}],"multiSelect":false,"allowFreeText":false}"#
        let note = #"{"id":"note","question":"Anything reviewers should know","options":[],"multiSelect":false,"allowFreeText":true,"required":false}"#
        let codexCopied = try request(#"{"id":"elicit-1","kind":"question","text":"Where should the notes go?","options":[],"questions":[\#(channel),\#(note)]}"#)
        for item in [claude, claudeOne, codex, grok, codexCopied] {
            XCTAssertNil(RequestText.explanation(item), item.id)
        }
    }

    func testAnExplanationThatAddsToAPromptItQuotesIsKept() throws {
        let text = "Which database? The migration runs against it right after you answer."
        let item = try request(#"{"id":"r","kind":"question","text":"\#(text)","options":[],"questions":[\#(database)]}"#)
        XCTAssertEqual(RequestText.explanation(item), text)
        let message = "The release-notes server needs a publishing target before it drafts v0.9.\n\nNothing is published until you confirm in the next step."
        let form = try request(#"{"id":"f","kind":"question","text":"The release-notes server needs a publishing target before it drafts v0.9.\n\nNothing is published until you confirm in the next step.","options":[],"questions":[\#(service)]}"#)
        XCTAssertEqual(RequestText.explanation(form), message, "Kept exactly as the provider sent it")
    }

    func testEmptyTextIsNoExplanation() throws {
        XCTAssertNil(RequestText.explanation(try request(#"{"id":"r","kind":"question","text":"  ","options":[],"questions":[\#(database)]}"#)))
    }

    // MARK: Links

    func testBareAddressesAreFoundWithoutTheSentenceAroundThem() {
        let found = WebLinks.find(in: ["The three are side by side at https://laptop.tail5728ca.ts.net/terminal-states/. Pick one, or see (https://example.com/a), then https://example.com/b, too!"])
        XCTAssertEqual(found.map(\.absoluteString), ["https://laptop.tail5728ca.ts.net/terminal-states/", "https://example.com/a", "https://example.com/b"])
    }

    func testAMarkdownLinkGivesItsAddress() {
        XCTAssertEqual(WebLinks.find(in: ["Read [the spec](https://example.com/spec#states) first."]).map(\.absoluteString), ["https://example.com/spec#states"])
    }

    func testOnlyWebAddressesWrittenWithTheirSchemeCount() {
        let found = WebLinks.find(in: ["mailto:someone@example.com ftp://example.com/file file:///etc/hosts README.md www.example.com http://example.org/page"])
        XCTAssertEqual(found.map(\.absoluteString), ["http://example.org/page"])
    }

    func testEachAddressIsListedOnceInTheOrderItFirstAppears() throws {
        let question = try JSONDecoder().decode(Question.self, from: Data(#"{"id":"q","question":"Which one? See https://example.com/b","header":"https://example.com/a","options":[{"id":"x","label":"https://example.com/a","description":"Like https://example.com/c"},{"id":"y","label":"Other","description":"https://example.com/b"}],"multiSelect":false,"allowFreeText":false}"#.utf8))
        XCTAssertEqual(WebLinks.find(in: question).map(\.absoluteString), ["https://example.com/b", "https://example.com/a", "https://example.com/c"])
        XCTAssertTrue(WebLinks.find(in: ["No link here.", ""]).isEmpty)
    }

    /// One block for the whole request: a Codex form's own message, every question, and choices without questions.
    func testARequestGathersTheLinksInItsTextQuestionsAndChoices() throws {
        let form = try request(#"{"id":"f","kind":"question","text":"The variants are at https://example.com/form","options":[],"questions":[{"id":"q","question":"Which? See https://example.com/q","options":[{"id":"x","label":"X","description":"https://example.com/x"}],"multiSelect":false,"allowFreeText":false}]}"#)
        XCTAssertEqual(WebLinks.find(in: form).map(\.absoluteString), ["https://example.com/form", "https://example.com/q", "https://example.com/x"])
        let legacy = try request(#"{"id":"l","kind":"question","text":"Pick one","options":[{"id":"a","label":"A","description":"https://example.com/a"}]}"#)
        XCTAssertEqual(WebLinks.find(in: legacy).map(\.absoluteString), ["https://example.com/a"])
    }

    /// The sheet covers the thread, so the agent's message just before the question lends it the links the question lacks.
    func testTheAgentsLastMessageAddsTheLinksTheRequestLacks() throws {
        let form = try request(#"{"id":"f","kind":"question","text":"Which layout?","options":[],"questions":[{"id":"q","question":"Which? See https://example.com/q","options":[{"id":"x","label":"X"}],"multiSelect":false,"allowFreeText":false}]}"#)
        let messages = try JSONDecoder().decode([Message].self, from: Data(#"""
        [{"id":"m1","role":"assistant","text":"Old: https://example.com/old"},
         {"id":"m2","role":"user","text":"Mine: https://example.com/mine"},
         {"id":"m3","role":"assistant","text":"**Review page:** http://localhost:8075/ and https://example.com/q, also [the tag](https://github.com/o/r/tree/t)."}]
        """#.utf8))
        XCTAssertEqual(WebLinks.find(in: form, after: messages).map(\.absoluteString),
                       ["https://example.com/q", "http://localhost:8075/", "https://github.com/o/r/tree/t"])
        XCTAssertEqual(WebLinks.find(in: form, after: []).map(\.absoluteString), ["https://example.com/q"])
        XCTAssertEqual(WebLinks.find(in: form, after: Array(messages[1...1])).map(\.absoluteString), ["https://example.com/q"])
        // A visual reaches the phone as its words alone, and those are the agent's newest (ADR-0056).
        let visual = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"visual:v1","role":"assistant","text":"A diagram, https://example.com/visual"}"#.utf8))
        XCTAssertEqual(WebLinks.find(in: form, after: messages + [visual]).map(\.absoluteString), ["https://example.com/q", "https://example.com/visual"])
    }

    func testARowShowsTheHostAndPath() throws {
        XCTAssertEqual(WebLinks.place(try XCTUnwrap(URL(string: "http://localhost:8075/"))), "localhost:8075")
        XCTAssertEqual(WebLinks.place(try XCTUnwrap(URL(string: "https://laptop.tail5728ca.ts.net/terminal-states/"))), "laptop.tail5728ca.ts.net/terminal-states/")
        XCTAssertEqual(WebLinks.place(try XCTUnwrap(URL(string: "https://example.com/"))), "example.com")
        XCTAssertEqual(WebLinks.place(try XCTUnwrap(URL(string: "https://example.com"))), "example.com")
        XCTAssertEqual(WebLinks.place(try XCTUnwrap(URL(string: "https://example.com/a/b?c=d"))), "example.com/a/b")
    }

    // MARK: Pages (ADR-0084)

    private let file = #"{"token":"ffffffffffffffffffffffffffffffff","kind":"file","name":"greeting-prototype.html","start":"greeting-prototype.html"}"#
    private let served = #"{"token":"ssssssssssssssssssssssssssssssss","kind":"server","name":"localhost:8075","start":"variants/a.html?variant=A"}"#

    func testAQuestionReadsItsPagesAndLeavesOutOneItCannotRead() throws {
        let asked = try request(#"{"id":"r","kind":"question","text":"Which greeting?","options":[],"pages":[\#(file),{"token":7},\#(served)]}"#)
        XCTAssertEqual(asked.pages.map(\.name), ["greeting-prototype.html", "localhost:8075"])
        XCTAssertEqual(try request(#"{"id":"r","kind":"question","text":"Which greeting?","options":[]}"#).pages, [])
        XCTAssertEqual(try request(#"{"id":"r","kind":"question","text":"Which greeting?","options":[],"pages":"nonsense"}"#).pages, [])
    }

    func testAPageOpensUnderItsTokenOnTheComputersOwnAddress() throws {
        let asked = try request(#"{"id":"r","kind":"question","text":"Which greeting?","options":[],"pages":[\#(file),\#(served)]}"#)
        let endpoint = try HostEndpoint("https://laptop.tail5728ca.ts.net:8443")
        XCTAssertEqual(asked.pages.map { $0.url(on: endpoint)?.absoluteString }, [
            "https://laptop.tail5728ca.ts.net:8443/page/ffffffffffffffffffffffffffffffff/greeting-prototype.html",
            "https://laptop.tail5728ca.ts.net:8443/page/ssssssssssssssssssssssssssssssss/variants/a.html?variant=A",
        ])
        let odd = try request(#"{"id":"r","kind":"question","text":"?","options":[],"pages":[{"token":"../../v1/session/aaaaaaaaaaaaaaaaaaa","kind":"file","name":"x","start":""}]}"#)
        XCTAssertNil(odd.pages.first?.url(on: endpoint))
    }

    func testALoopbackLinkAPageAlreadyOpensHasNoRowOfItsOwn() throws {
        let asked = try request(#"{"id":"r","kind":"question","text":"Which greeting?","options":[],"pages":[\#(served)]}"#)
        let links = [try XCTUnwrap(URL(string: "http://localhost:8075/")), try XCTUnwrap(URL(string: "https://github.com/o/r/pull/1"))]
        XCTAssertEqual(WebLinks.withoutPages(links, asked.pages).map(\.absoluteString), ["https://github.com/o/r/pull/1"])
    }

    func testPagesArrivingLaterLeaveTheRequestTheSameToAnswer() throws {
        let before = try request(#"{"id":"r","kind":"question","text":"Which greeting?","options":[]}"#)
        let after = try request(#"{"id":"r","kind":"question","text":"Which greeting?","options":[],"pages":[\#(file)]}"#)
        // The pages arriving is a change the sheet shows, and the question is still the same one to answer.
        XCTAssertNotEqual(before, after)
        XCTAssertTrue(before.asksTheSame(as: after))
        XCTAssertFalse(before.asksTheSame(as: try request(#"{"id":"r","kind":"question","text":"Which other greeting?","options":[]}"#)))
        XCTAssertNoThrow(try Commands.answer(threadID: "t", request: before, currentRequests: [after], text: "A"))
    }
}
