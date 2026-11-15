import XCTest
import SwiftUI

/// The iPhone Duo's rules in `DuoRules.swift`: Sotto's own sheet held sideways, how a sheet moves when the Duo turns or
/// folds, and the words the Duo alone changes.
@MainActor final class DuoRulesTests: XCTestCase {
    private func shown(_ closed: @escaping () -> Void = {}) -> DuoSheetHost.Shown {
        .init(id: UUID(), wash: false, content: AnyView(EmptyView()), close: closed)
    }

    // MARK: The sheet host

    func testANewSheetClosesTheOneItReplaces() {
        let host = DuoSheetHost()
        var firstClosed = 0
        let first = shown { firstClosed += 1 }
        host.show(first)
        XCTAssertEqual(firstClosed, 0)
        let second = shown()
        host.show(second)
        XCTAssertEqual(firstClosed, 1, "the replaced sheet's presenter hears it went, so it can run onDismiss and open again")
        XCTAssertEqual(host.shown?.id, second.id)
    }

    func testOnlyTheShownSheetCanTakeItselfAway() {
        let host = DuoSheetHost()
        let first = shown(), second = shown()
        host.show(first)
        host.show(second)
        host.gone(first.id)
        XCTAssertEqual(host.shown?.id, second.id, "a replaced sheet going leaves the one that took its place")
        host.gone(second.id)
        XCTAssertNil(host.shown)
    }

    // MARK: Turning and folding

    func testASheetOpenedSidewaysGoesUpInTheHost() {
        XCTAssertEqual(DuoSheetStep.next(presented: true, own: true, inHost: false), .show)
        XCTAssertEqual(DuoSheetStep.next(presented: true, own: true, inHost: true), .none)
    }

    func testTurningUprightOrFoldingMovesAnOpenSheetToIOSWithoutClosingIt() {
        XCTAssertEqual(DuoSheetStep.next(presented: true, own: false, inHost: true), .take(dismissed: false),
                       "the sheet stays open as iOS's own, and its onDismiss doesn't run")
    }

    func testClosingASheetInTheHostDismissesIt() {
        XCTAssertEqual(DuoSheetStep.next(presented: false, own: true, inHost: true), .take(dismissed: true))
        XCTAssertEqual(DuoSheetStep.next(presented: false, own: false, inHost: true), .take(dismissed: true))
    }

    func testNothingHappensForASheetTheHostDoesntHold() {
        XCTAssertEqual(DuoSheetStep.next(presented: false, own: true, inHost: false), .none)
        XCTAssertEqual(DuoSheetStep.next(presented: true, own: false, inHost: false), .none, "iOS's own sheet draws it")
        XCTAssertEqual(DuoSheetStep.next(presented: false, own: false, inHost: false), .none)
    }

    // MARK: Words

    func testWatcherNamesAThreadOnlyByItsWholeTitle() {
        XCTAssertTrue(DuoWords.names("Fix login test is asking which account to use.", title: "Fix login test"))
        XCTAssertTrue(DuoWords.names("“Refine the iPhone thread view” needs you.", title: "Refine the iPhone thread view"))
        XCTAssertFalse(DuoWords.names("I’m running the tests again.", title: "Tests"), "a short common title is no name")
        XCTAssertFalse(DuoWords.names("Unfix login tests first.", title: "Fix login test"), "inside other words isn't the title")
        XCTAssertFalse(DuoWords.names("Nothing about it here.", title: "Fix login test"))
        XCTAssertFalse(DuoWords.names("Anything", title: ""))
    }

    func testABareTableValueKeepsItsColumnsName() {
        XCTAssertFalse(DuoWords.namesItself("No"))
        XCTAssertFalse(DuoWords.namesItself(" yes "))
        XCTAssertFalse(DuoWords.namesItself("42"))
        XCTAssertFalse(DuoWords.namesItself("✓"))
        XCTAssertTrue(DuoWords.namesItself("Terminal mode"))
        XCTAssertTrue(DuoWords.namesItself("Not fixed"))
    }

    func testTheWorkingLineGoesOnlyOnTheDuo() {
        XCTAssertNil(DuoWords.workingLine(provider: "Codex", computer: "Laptop", onDuo: true))
        XCTAssertEqual(DuoWords.workingLine(provider: "Codex", computer: "Laptop", onDuo: false), "Codex is working on Laptop.")
    }

    func testTheCantAnswerNoteChangesOnlyOnTheDuo() {
        XCTAssertEqual(DuoWords.cantAnswerHere(computer: "Laptop", onDuo: true), "Answer it on Laptop.")
        XCTAssertEqual(DuoWords.cantAnswerHere(computer: "Laptop", onDuo: false), "This iPhone can’t answer on Laptop yet.")
    }
}
