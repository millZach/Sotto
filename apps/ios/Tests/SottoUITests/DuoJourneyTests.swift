import XCTest
import UIKit

/// The unfolded iPhone Duo, upright and sideways (Zach's Duo polish, November 1, 2026): the page reaches the top of the
/// screen with no band, the tabs stand low on the right in one pill of same-size tiles, the sidebar's button and New
/// thread stand at the top of the rail, and a thumb's drag moves the sidebar. These journeys run only where the app's
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

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Turns the Duo and waits for the window to take the turn; skips where this isn't the unfolded Duo held that way.
    private func hold(upright: Bool) throws {
        XCUIDevice.shared.orientation = upright ? .portrait : .landscapeLeft
        let window = app.windows.firstMatch
        let turned = NSPredicate { _, _ in
            let frame = window.frame
            return upright ? frame.height > frame.width : frame.width > frame.height
        }
        _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: turned, object: nil)], timeout: 10)
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

    /// How light the screen is along its top edge, from 0 to 1, read across the page's middle half at the very top.
    private func topLightness() -> CGFloat {
        let shot = XCUIScreen.main.screenshot().image
        guard let image = shot.cgImage else { return 0 }
        let width = image.width, height = image.height
        // Two pixel rows a few pixels down from the top edge, clear of the status bar's words in the middle.
        var bytes = [UInt8](repeating: 0, count: width * 4 * 2)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: &bytes, width: width, height: 2, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 0 }
        context.draw(image, in: CGRect(x: 0, y: -CGFloat(height) + 2 + 4, width: CGFloat(width), height: CGFloat(height)))
        var total: CGFloat = 0, count: CGFloat = 0
        for row in 0..<2 {
            for x in stride(from: width / 4, to: width * 3 / 4, by: 4) {
                let i = (row * width + x) * 4
                total += (0.2126 * CGFloat(bytes[i]) + 0.7152 * CGFloat(bytes[i + 1]) + 0.0722 * CGFloat(bytes[i + 2])) / 255
                count += 1
            }
        }
        return count > 0 ? total / count : 0
    }

    func testUprightFillsTheScreenWithTheRailLowOnTheRight() throws {
        launch(["-phoneAppearance", "light"])
        try hold(upright: true)
        XCTAssertTrue(byID("thread-search").waitForExistence(timeout: 20), "Threads opens")
        let window = app.windows.firstMatch.frame
        capture("duo-upright-threads-light")
        // In Light the page's ground is light from edge to edge: a dark band along the top is what Zach saw.
        XCTAssertGreaterThan(topLightness(), 0.6, "The page reaches the top of the screen with no dark band")
        checkRail(in: window, "Threads")
        XCTAssertFalse(app.buttons["duo-sidebar"].isEnabled, "On the Threads list the list is the page, so the sidebar's button rests")
        app.buttons["tab-watcher"].tap()
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: app.buttons["tab-watcher"])
        XCTAssertEqual(XCTWaiter.wait(for: [chosen], timeout: 10), .completed, "Watcher shows")
        capture("duo-upright-watcher-light")
        XCTAssertGreaterThan(topLightness(), 0.6, "Watcher reaches the top of the screen with no bar over it")
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
        XCTAssertGreaterThan(topLightness(), 0.6, "The page reaches the top of the screen with no dark band")
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
