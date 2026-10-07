import XCTest
@testable import SottoCore

final class MarkdownTests: XCTestCase {
    /// The review reply from the bug report, as the agent wrote it: two Ctrl+` chords in one item once opened a code
    /// span across the rest of the message.
    private let review = """
    **Not asked for**
    - **Remembered state:** open state and height are remembered per thread across restarts.
    - **The shortcut itself:** the spec named no key. The code comment calls Ctrl+` "T3's own", and the reviewer recalls T3 uses Mod+J (unverified). Ctrl+` is also blocked in the Tools and Terminal-mode terminals.
    - **Reduce transparency:** the frost follows the system's reduce-transparency setting.

    **Implemented but looks wrong**
    1. **Ctrl+` in Terminal mode:** the same off-screen drawer toggle as Standards #2.
    2. **Tooltips:** they always say "(Ctrl+`)", even when dictation owns that chord and the shortcut is off.
    """

    private func inlines(_ blocks: [MarkdownBlock]) -> [MarkdownInline] {
        blocks.flatMap { block -> [MarkdownInline] in
            switch block {
            case .heading(_, let text), .paragraph(let text), .quote(let text): return [text]
            case .list(let items): return items.map(\.text)
            case .code, .rule: return []
            }
        }
    }

    private func hasCodeSpan(_ text: AttributedString) -> Bool {
        text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true }
    }

    private func keyRuns(_ text: AttributedString) -> [(text: String, bold: Bool)] {
        text.runs.compactMap { run in
            guard run.attributes[KeyChordAttribute.self] == true else { return nil }
            let bold = run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
            return (String(text[run.range].characters), bold)
        }
    }

    func testTheReviewReplyKeepsItsBlocksAndReadsItsChordsAsKeys() throws {
        let blocks = Markdown.blocks(review)
        XCTAssertEqual(blocks.count, 4)
        XCTAssertEqual(blocks[0], .heading(level: 4, text: MarkdownInline("Not asked for")))
        XCTAssertEqual(blocks[2], .heading(level: 4, text: MarkdownInline("Implemented but looks wrong")))

        guard case .list(let bullets) = blocks[1] else { return XCTFail("Expected the bulleted list") }
        XCTAssertEqual(bullets.map(\.marker), [.bullet, .bullet, .bullet])
        XCTAssertEqual(bullets.map(\.depth), [0, 0, 0])
        XCTAssertEqual(bullets[1].text.keys, ["Ctrl+`", "Ctrl+`"])
        XCTAssertTrue(bullets[1].text.text.hasPrefix("**The shortcut itself:** the spec named no key. The code comment calls Ctrl+` \"T3's own\""))

        guard case .list(let numbered) = blocks[3] else { return XCTFail("Expected the numbered list") }
        XCTAssertEqual(numbered.map(\.marker), [.number(1), .number(2)])
        XCTAssertEqual(numbered[0].text.keys, ["Ctrl+`"])

        // No backtick is left to open a code span, and nothing in the message reads as code.
        for inline in inlines(blocks) {
            XCTAssertFalse(inline.source.contains("`"), inline.text)
            XCTAssertFalse(hasCodeSpan(inline.attributed()), inline.text)
        }

        // The chord inside bold stays bold, and reads as the key it names.
        let first = keyRuns(numbered[0].text.attributed())
        XCTAssertEqual(first.map { $0.text }, ["Ctrl+`"])
        XCTAssertEqual(first.map { $0.bold }, [true])
        let quoted = numbered[1].text.attributed()
        XCTAssertEqual(keyRuns(quoted).map { $0.text }, ["Ctrl+`"])
        XCTAssertTrue(String(quoted.characters).contains("they always say \"(Ctrl+`)\", even when"))
    }

    func testALoneBacktickStaysAsWritten() {
        let blocks = Markdown.blocks("Press the ` key, then type the name.")
        XCTAssertEqual(blocks, [.paragraph(MarkdownInline("Press the ` key, then type the name."))])
        guard case .paragraph(let text) = blocks[0] else { return XCTFail("Expected a paragraph") }
        XCTAssertTrue(text.keys.isEmpty)
        let read = text.attributed()
        XCTAssertFalse(hasCodeSpan(read))
        XCTAssertEqual(String(read.characters), "Press the ` key, then type the name.")
    }

    func testABacktickCanReachNoFurtherThanItsBlock() {
        let blocks = Markdown.blocks("A stray ` here.\n\nAnd `real code` there.")
        XCTAssertEqual(blocks.count, 2)
        guard case .paragraph(let first) = blocks[0], case .paragraph(let second) = blocks[1] else { return XCTFail("Expected two paragraphs") }
        XCTAssertFalse(hasCodeSpan(first.attributed()))
        let read = second.attributed()
        let code = read.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }
        XCTAssertEqual(code.map { String(read[$0.range].characters) }, ["real code"])
    }

    func testKeyChordsAreSetAsideAndCodeSpansAreNot() {
        let chords = MarkdownInline("Open it with Ctrl+`, Cmd+`, Mod+`, Alt+`, Shift+`, Option+` or Ctrl+Shift+`.")
        XCTAssertEqual(chords.keys, ["Ctrl+`", "Cmd+`", "Mod+`", "Alt+`", "Shift+`", "Option+`", "Ctrl+Shift+`"])
        XCTAssertFalse(chords.source.contains("`"))
        XCTAssertEqual(chords.text, "Open it with Ctrl+`, Cmd+`, Mod+`, Alt+`, Shift+`, Option+` or Ctrl+Shift+`.")
        XCTAssertEqual(keyRuns(chords.attributed()).map { $0.text }, chords.keys)

        // A word that only ends in a modifier's name, and a plus that isn't after one, are not chords.
        XCTAssertTrue(MarkdownInline("Run `npm test` and press X+`.").keys.isEmpty)
        XCTAssertTrue(MarkdownInline("SuperCtrl+` is not a key").keys.isEmpty)
        let code = MarkdownInline("Use `Ctrl+K` to search.")
        XCTAssertTrue(code.keys.isEmpty)
        XCTAssertTrue(hasCodeSpan(code.attributed()))
    }

    func testNestedEmphasisInsideListItems() {
        let blocks = Markdown.blocks("- **Bold with _italic_ inside** and after\n- plain *one*")
        guard case .list(let items) = blocks.first, blocks.count == 1 else { return XCTFail("Expected one list") }
        XCTAssertEqual(items.map(\.text.source), ["**Bold with _italic_ inside** and after", "plain *one*"])
        let read = items[0].text.attributed()
        XCTAssertEqual(String(read.characters), "Bold with italic inside and after")
        let both = read.runs.filter {
            ($0.inlinePresentationIntent ?? []).contains([.stronglyEmphasized, .emphasized])
        }
        XCTAssertEqual(both.map { String(read[$0.range].characters) }, ["italic"])
    }

    func testNumberedListsKeepTheirNumbersAndNest() {
        let blocks = Markdown.blocks("3. Third\n4. Fourth\n   - Under fourth\n     continued\n5) Fifth")
        guard case .list(let items) = blocks.first, blocks.count == 1 else { return XCTFail("Expected one list") }
        XCTAssertEqual(items.map(\.marker), [.number(3), .number(4), .bullet, .number(5)])
        XCTAssertEqual(items.map(\.depth), [0, 0, 1, 0])
        XCTAssertEqual(items[2].text.text, "Under fourth\ncontinued")
    }

    func testAListOfTheOtherKindStartsItsOwnBlock() {
        let blocks = Markdown.blocks("- one\n- two\n1. first\n\nAfter the list.")
        XCTAssertEqual(blocks.count, 3)
        guard case .list(let bullets) = blocks[0], case .list(let numbers) = blocks[1] else { return XCTFail("Expected two lists") }
        XCTAssertEqual(bullets.count, 2)
        XCTAssertEqual(numbers.map(\.marker), [.number(1)])
        XCTAssertEqual(blocks[2], .paragraph(MarkdownInline("After the list.")))
    }

    func testFencedBlockKeepsBackticksAndItsLanguage() {
        let text = "Before:\n\n```swift\nlet name = \"`x`\"\nprint(\"``\")\n```\nAfter `code`."
        let blocks = Markdown.blocks(text)
        XCTAssertEqual(blocks, [
            .paragraph(MarkdownInline("Before:")),
            .code(language: "swift", text: "let name = \"`x`\"\nprint(\"``\")"),
            .paragraph(MarkdownInline("After `code`."))
        ])
    }

    func testAnIndentedFenceAndATildeFence() {
        let blocks = Markdown.blocks("  ~~~\n  indented\n    deeper\n  ~~~")
        XCTAssertEqual(blocks, [.code(language: nil, text: "indented\n  deeper")])
    }

    func testAnUnclosedFenceRunsToTheEnd() {
        let blocks = Markdown.blocks("Running:\n```sh\nnpm test\n\n**not bold**\n")
        XCTAssertEqual(blocks, [
            .paragraph(MarkdownInline("Running:")),
            .code(language: "sh", text: "npm test\n\n**not bold**")
        ])
    }

    func testCRLFLineEndingsReadAsLines() {
        let blocks = Markdown.blocks("# Title\r\n\r\n- one\r\n- two\r\n\r\n```\r\ncode\r\n```\r\nEnd\rline")
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: MarkdownInline("Title")),
            .list([MarkdownListItem(marker: .bullet, depth: 0, text: MarkdownInline("one")),
                   MarkdownListItem(marker: .bullet, depth: 0, text: MarkdownInline("two"))]),
            .code(language: nil, text: "code"),
            .paragraph(MarkdownInline("End\nline"))
        ])
    }

    func testHeadingsQuotesAndRules() {
        let blocks = Markdown.blocks("## Plan ##\n> quoted\n> more\n\n---\n#not a heading\n**Bold:** then words")
        XCTAssertEqual(blocks, [
            .heading(level: 2, text: MarkdownInline("Plan")),
            .quote(MarkdownInline("quoted\nmore")),
            .rule,
            .paragraph(MarkdownInline("#not a heading\n**Bold:** then words"))
        ])
    }

    func testEmptyInputHasNoBlocks() {
        XCTAssertEqual(Markdown.blocks(""), [])
        XCTAssertEqual(Markdown.blocks("  \n\r\n\t"), [])
        XCTAssertEqual(MarkdownInline("").attributed().characters.count, 0)
    }
}
