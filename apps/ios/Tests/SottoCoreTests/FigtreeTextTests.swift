import XCTest
@testable import SottoCore

final class FigtreeTextTests: XCTestCase {
    func testLatinTextAndItsPunctuationAreFigtrees() {
        for text in ["Fix the login test 40", "Codex \u{00B7} Panel tools \u{00B7} Zach\u{2019}s Laptop", "R\u{00E9}sum\u{00E9} \u{2013} Stra\u{00DF}e \u{20AC}5", "Za\u{017C}\u{00F3}\u{0142}\u{0107}"] {
            XCTAssertTrue(FigtreeText.drawsAlone(text), text)
        }
    }

    func testAnyOtherScriptOrEmojiFallsThroughToAnotherFont() {
        for text in ["\u{65E5}\u{672C}\u{8A9E}", "Ship it \u{1F389}", "\u{0627}\u{0631}\u{062F}\u{0648}", "\u{0E44}\u{0E17}\u{0E22}", "Vi\u{1EC7}t", "two\nlines", "soft\u{00AD}hyphen"] {
            XCTAssertFalse(FigtreeText.drawsAlone(text), text)
        }
    }

    func testEmptyTextIsNotALine() {
        XCTAssertFalse(FigtreeText.drawsAlone(""))
    }
}
