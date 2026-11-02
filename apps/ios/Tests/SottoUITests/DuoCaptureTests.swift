import XCTest
import UIKit

/// Throwaway, on the Duo capture branches only and never merged: the before and after shots for Zach's Duo polish card,
/// taken the same way on main and on the change. Each shot is the app's own window.
@MainActor final class DuoCaptureTests: XCTestCase {
    private let app = XCUIApplication()
    private let long = "Look at the release notes thread and tell me what it is waiting on, then check the login test, "
        + "the wiring schedule and the iPhone thread view, and say which of them need me before lunch today."

    override func setUpWithError() throws { continueAfterFailure = true }
    override func tearDownWithError() throws { if app.state != .notRunning { app.terminate() } }

    /// Marks a picture for the host to take: XCTest's screenshots on the Duo show its dark cover screen.
    private func shot(_ name: String) {
        print("DUO-SHOT \(name) \(Date().timeIntervalSince1970)")
        Thread.sleep(forTimeInterval: 3)
    }
    private func byID(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func launch(_ extra: [String]) {
        app.launchArguments = ["--ui-fixture", "--reset-ui-preferences", "--ui-still", "--ui-watcher", "--ui-watcher-nothing-waits",
                               "-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + extra
        app.launch()
        _ = app.wait(for: .runningForeground, timeout: 30)
    }
    private func openWatcher() -> XCUIElement {
        let tab = app.buttons["tab-watcher"]
        _ = tab.waitForExistence(timeout: 20)
        tab.tap()
        let reply = byID("watcher-reply")
        _ = reply.waitForExistence(timeout: 20)
        sleep(3)
        return reply
    }

    /// Watcher's page, then the same page with several lines in the box, with and without the keyboard.
    func testCaptureWatcherWorkingRow() {
        launch([])
        let reply = openWatcher()
        shot("watcher-page")
        reply.tap()
        _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
        reply.typeText(long)
        let working = byID("watcher-working")
        print("DUO-STATE keyboards \(app.keyboards.count) reply \(reply.frame) working \(working.exists ? working.frame : .null)")
        shot("watcher-tall-box-keyboard")
        print("DUO-STATE after keyboards \(app.keyboards.count) reply \(reply.frame) working \(working.exists ? working.frame : .null)")
        // Drag the conversation down into the keyboard to put it away, as a reader does.
        let page = app.windows.firstMatch
        page.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.35))
            .press(forDuration: 0.05, thenDragTo: page.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.95)))
        sleep(3)
        shot("watcher-tall-box")
    }

    /// A press 4 points above the model pill, at its middle: what opens.
    func testCaptureTapAboveThePill() {
        launch([])
        _ = openWatcher()
        let pill = app.buttons["watcher-settings"]
        _ = pill.waitForExistence(timeout: 10)
        shot("watcher-box-at-rest")
        print("DUO-STATE pill \(pill.frame) reply \(byID("watcher-reply").frame)")
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0)).withOffset(CGVector(dx: 0, dy: -4)).tap()
        sleep(3)
        shot("watcher-tap-above-pill")
    }
}
