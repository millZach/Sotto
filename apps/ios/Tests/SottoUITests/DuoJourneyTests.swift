import XCTest
import UIKit

/// The unfolded iPhone Duo, upright and sideways (Zach's Duo polish, November 1, 2026): the tabs stand low on the right
/// in one pill of same-size tiles, the sidebar's button and New thread stand at the top of the rail, and a thumb's drag
/// moves the sidebar. Each journey marks its pictures for the capture script, which takes them from the host and reads
/// the page's top edge there, since XCTest's own screenshots on the Duo show its dark cover screen. These journeys run only where the app's
/// window is the unfolded Duo's, so CI's iPhone SE and Pro Max skip them; the Duo captures run them on the iPhone Duo
/// simulator with its inner screen open (ADR-0151, November 1 amendment).
@MainActor final class DuoJourneyTests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        // Every other iPhone's screen is narrower than 560 points one way, and so is the Duo's cover screen: skip before
        // launching anything, so CI's journeys on iPhone SE and Pro Max spend no time here.
        let screen = UIScreen.main.bounds.size
        guard min(screen.width, screen.height) >= 560 else { throw XCTSkip("Not the unfolded iPhone Duo: screen \(screen)") }
    }

    override func tearDownWithError() throws {
        if app.state != .notRunning { app.terminate() }
    }

    private func launch(_ extra: [String]) {
        app.launchArguments = ["--ui-fixture", "--reset-ui-preferences", "--ui-still", "--ui-watcher",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + extra
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "Sotto must come to the foreground after launch")
    }

    private func byID(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

    /// Marks a moment worth a picture. On the Duo simulator XCTest's screenshots show the folded cover screen, dark while
    /// the inner one is open, so the capture script takes the inner screen's picture from the host around each mark, and
    /// reads its top edge there.
    private func capture(_ name: String) {
        print("DUO-SHOT \(name) \(Date().timeIntervalSince1970)")
        Thread.sleep(forTimeInterval: 3)
    }

    /// Turns the Duo until the window stands the way asked, and skips where this isn't the unfolded Duo held that way.
    /// The inner screen's own upright is the device's landscape, so each of the device's four orientations is tried.
    private func hold(upright: Bool) throws {
        let window = app.windows.firstMatch
        func standing() -> Bool {
            let frame = window.frame
            return upright ? frame.height > frame.width : frame.width > frame.height
        }
        for orientation in [UIDeviceOrientation.portrait, .landscapeLeft, .landscapeRight, .portraitUpsideDown] where !standing() {
            XCUIDevice.shared.orientation = orientation
            let turned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in standing() }, object: nil)
            _ = XCTWaiter.wait(for: [turned], timeout: 4)
        }
        let frame = window.frame
        // The unfolded Duo is regular width both ways: wider than any iPhone's 440 points upright, and held sideways
        // taller than any iPhone held sideways (about 440).
        let unfolded = upright ? frame.width >= 560 && frame.height > frame.width : frame.height >= 560 && frame.width > frame.height
        guard unfolded else { throw XCTSkip("Not the unfolded iPhone Duo held \(upright ? "upright" : "sideways"): window \(frame)") }
    }

    /// The tabs' four buttons in the rail's pill: one column of same-size tiles, low on the right edge.
    private func checkRail(in window: CGRect, _ stage: String) {
        let tabs = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tab-'")).allElementsBoundByIndex.filter { $0.isHittable }
        XCTAssertEqual(tabs.count, 4, "\(stage): Threads, Watcher, Computers and Settings")
        guard let first = tabs.first else { return }
        for tab in tabs {
            XCTAssertEqual(tab.frame.width, first.frame.width, accuracy: 0.5, "\(stage): every tab the same width")
            XCTAssertEqual(tab.frame.height, first.frame.height, accuracy: 0.5, "\(stage): every tab the same height")
            XCTAssertGreaterThanOrEqual(tab.frame.height, 44, "\(stage): every tab presses across 44 points")
            XCTAssertEqual(tab.frame.midX, first.frame.midX, accuracy: 0.5, "\(stage): one column")
            XCTAssertGreaterThan(tab.frame.minX, window.maxX - 100, "\(stage): on the right edge")
        }
        let lowest = tabs.map(\.frame.maxY).max() ?? 0
        XCTAssertGreaterThan(lowest, window.maxY - 120, "\(stage): the pill ends near the foot, where the thumb rests")
        let sidebar = app.buttons["duo-sidebar"], plus = app.buttons["new-thread"]
        XCTAssertTrue(sidebar.exists && plus.exists, "\(stage): the sidebar's button and New thread are on the rail")
        XCTAssertLessThan(sidebar.frame.maxY, plus.frame.minY, "\(stage): the sidebar's button over New thread")
        XCTAssertLessThan(plus.frame.maxY, tabs.map(\.frame.minY).min() ?? 0, "\(stage): both over the tabs")
        XCTAssertGreaterThan(plus.frame.minX, window.maxX - 100, "\(stage): New thread on the right edge")
    }

    func testUprightFillsTheScreenWithTheRailLowOnTheRight() throws {
        launch(["-phoneAppearance", "light"])
        try hold(upright: true)
        XCTAssertTrue(byID("thread-search").waitForExistence(timeout: 20), "Threads opens")
        let window = app.windows.firstMatch.frame
        capture("duo-upright-threads-light")
        checkRail(in: window, "Threads")
        XCTAssertFalse(app.buttons["duo-sidebar"].isEnabled, "On the Threads list the list is the page, so the sidebar's button rests")
        app.buttons["tab-watcher"].tap()
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: app.buttons["tab-watcher"])
        XCTAssertEqual(XCTWaiter.wait(for: [chosen], timeout: 10), .completed, "Watcher shows")
        capture("duo-upright-watcher-light")
        checkRail(in: window, "Watcher")
    }

    func testUprightSidebarFollowsTheThumb() throws {
        launch(["--ui-open-thread", "iphone"])
        try hold(upright: true)
        XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 20), "The thread opens")
        let window = app.windows.firstMatch.frame
        checkRail(in: window, "A thread")
        capture("duo-upright-thread")
        let list = byID("duo-sidebar-list")
        XCTAssertFalse(list.exists)
        // A drag right from the middle of the page, not the edge, pulls the sidebar in.
        let page = app.windows.firstMatch
        let from = page.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 260, dy: 4)), withVelocity: .default, thenHoldForDuration: 0.1)
        XCTAssertTrue(list.waitForExistence(timeout: 5), "A thumb's drag right anywhere on the page brings the sidebar")
        capture("duo-upright-sidebar")
        XCTAssertLessThan(list.frame.maxX, app.buttons["tab-threads"].frame.minX, "The sidebar stops short of the rail")
        // And a drag left pushes it out.
        let back = page.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
        back.press(forDuration: 0.05, thenDragTo: back.withOffset(CGVector(dx: -240, dy: 0)), withVelocity: .default, thenHoldForDuration: 0.1)
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: list)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 5), .completed, "A drag left puts the sidebar away")
        // The rail's button does both too.
        app.buttons["duo-sidebar"].tap()
        XCTAssertTrue(list.waitForExistence(timeout: 5), "The rail's sidebar button brings it")
        app.buttons["duo-sidebar"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: list)], timeout: 5),
                       .completed, "and puts it away")
    }

    func testSidewaysRailAndSidebarDrag() throws {
        launch(["--ui-open-thread", "iphone", "-phoneAppearance", "light"])
        try hold(upright: false)
        XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 20), "The thread opens")
        let window = app.windows.firstMatch.frame
        let list = byID("duo-sidebar-list")
        XCTAssertTrue(list.waitForExistence(timeout: 5), "Sideways, the sidebar stands beside a thread")
        capture("duo-sideways-thread-light")
        let tabs = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tab-'")).allElementsBoundByIndex.filter { $0.isHittable }
        XCTAssertEqual(tabs.count, 4)
        if let first = tabs.first {
            for tab in tabs {
                XCTAssertEqual(tab.frame.size.width, first.frame.size.width, accuracy: 0.5, "Every tab the same size")
                XCTAssertEqual(tab.frame.size.height, first.frame.size.height, accuracy: 0.5, "Every tab the same size")
            }
        }
        XCTAssertGreaterThan(tabs.map(\.frame.maxY).max() ?? 0, window.maxY - 120, "The pill ends near the foot")
        // A drag left puts the sidebar away; a drag right brings it back.
        let page = app.windows.firstMatch
        let middle = page.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.5))
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: -200, dy: 0)), withVelocity: .default, thenHoldForDuration: 0.1)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: list)], timeout: 5),
                       .completed, "A drag left hides the sidebar")
        capture("duo-sideways-thread-hidden")
        middle.press(forDuration: 0.05, thenDragTo: middle.withOffset(CGVector(dx: 200, dy: 0)), withVelocity: .default, thenHoldForDuration: 0.1)
        XCTAssertTrue(list.waitForExistence(timeout: 5), "A drag right brings it back")
    }
}
