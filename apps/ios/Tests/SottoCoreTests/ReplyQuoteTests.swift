import XCTest
@testable import SottoCore

/// The quote the phone writes into a reply box, in the desktop's words (tests/unit/renderer/replyQuotes.test.ts).
final class ReplyQuoteTests: XCTestCase {
    func testSaysWhereItIsFromAndQuotesEachLine() {
        XCTAssertEqual(ReplyQuote.text("\r\nRead the saved draft first.\r\n\r\nThen skip the write-back.  "),
                       "From your earlier reply:\n> Read the saved draft first.\n>\n> Then skip the write-back.")
    }

    func testKeepsTheFirstLinesIndentationTrimmingOnlyBlankLinesAroundTheWords() {
        XCTAssertEqual(ReplyQuote.text("\n\n    if (!key) return\n  done()  \n\n"), "From your earlier reply:\n>     if (!key) return\n>   done()")
        XCTAssertEqual(ReplyQuote.trimBlankLines(" \n  a\n\n b \n \n"), "  a\n\n b")
        XCTAssertEqual(ReplyQuote.trimBlankLines(" \n \n"), "")
    }

    func testAnEmptySelectionQuotesNothing() {
        XCTAssertNil(ReplyQuote.text(" \n\t"))
        XCTAssertNil(ReplyQuote.appending("  ", to: "Keep this."))
    }

    func testAQuoteGoesAfterTheDraftAndLeavesALineForTheUsersWords() {
        XCTAssertEqual(ReplyQuote.appending("It drops the draft.", to: ""), "From your earlier reply:\n> It drops the draft.\n\n")
        XCTAssertEqual(ReplyQuote.appending("It drops the draft.", to: "Fix this:\n"), "Fix this:\n\nFrom your earlier reply:\n> It drops the draft.\n\n")
        let twice = ReplyQuote.appending("One source of truth.", to: ReplyQuote.appending("The first is smaller.", to: "")!)
        XCTAssertEqual(twice, "From your earlier reply:\n> The first is smaller.\n\nFrom your earlier reply:\n> One source of truth.\n\n")
    }
}
