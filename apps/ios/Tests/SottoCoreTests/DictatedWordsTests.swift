import XCTest
@testable import SottoCore

final class DictatedWordsTests: XCTestCase {
    func testAnEmptyBoxTakesWhatWasHeard() {
        XCTAssertEqual(DictatedWords.join("", "Check the folded Duo."), "Check the folded Duo.")
    }

    func testWhatWasHeardFollowsTheWordsAfterOneSpace() {
        XCTAssertEqual(DictatedWords.join("Then", "open the pull request."), "Then open the pull request.")
        XCTAssertEqual(DictatedWords.join("Then ", "open it."), "Then open it.")
        XCTAssertEqual(DictatedWords.join("First line\n", "second line"), "First line\nsecond line")
    }

    func testEachResultReplacesTheLastOnesWords() {
        let before = "Note:"
        XCTAssertEqual(DictatedWords.join(before, "check"), "Note: check")
        XCTAssertEqual(DictatedWords.join(before, "Check the Duo."), "Note: Check the Duo.", "A revised result starts from the same words")
    }

    func testNothingHeardLeavesTheBoxAsItWas() {
        XCTAssertEqual(DictatedWords.join("Keep this", ""), "Keep this")
    }
}
