import XCTest
import UIKit

/// The Duo design captures: every surface of the iPhone Duo's own layout, folded and unfolded, in dark and light, taken
/// the same way on any commit so a before and an after match. They assert nothing about the layout; `DuoJourneyTests`
/// does that. `apps/ios/Scripts/duo-captures.sh` runs them on the iPhone Duo simulator in each posture and sets
/// `SOTTO_DUO_POSTURE` (folded or sideways) through xcodebuild's `TEST_RUNNER_` prefix; without it every test skips
/// before launching anything, so CI's iPhone journeys spend no time here. The simulator can't turn the unfolded Duo
/// upright, neither by `--ui-orientation` nor by `XCUIDevice` (November 8, 2026), so upright is checked on a real Duo.
///
/// XCTest's own screenshots on the Duo show only the cover screen, so each test prints `DUO-SHOT name time` at a moment
/// worth a picture and the script takes it from the host, and `DUO-CLIP-START` and `DUO-CLIP-END` around a movement worth
/// a short video.
@MainActor final class DuoCaptureTests: XCTestCase {
    private let app = XCUIApplication()
    private let laptop = "11111111-1111-4111-8111-111111111111"
    private var posture = ""

    override func setUpWithError() throws {
        continueAfterFailure = true
        posture = ProcessInfo.processInfo.environment["SOTTO_DUO_POSTURE"] ?? ""
        guard ["folded", "sideways"].contains(posture) else { throw XCTSkip("Only the Duo captures run these") }
    }

    override func tearDownWithError() throws {
        if app.state != .notRunning { app.terminate() }
    }

    // MARK: Helpers

    private var unfolded: Bool { posture != "folded" }

    private func launch(_ extra: [String], light: Bool = false) {
        var arguments = ["--ui-fixture", "--reset-ui-preferences", "--ui-still", "--ui-watcher", "--ui-watcher-nothing-waits",
                         "-AppleLanguages", "(en)", "-AppleLocale", "en_US"] + extra
        if light { arguments += ["--ui-light"] }
        app.launchArguments = arguments
        app.launch()
        _ = app.wait(for: .runningForeground, timeout: 30)
        sleep(3)
    }

    private func byID(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func row(_ id: String) -> XCUIElement { app.buttons["thread-\(laptop)/\(id)"] }

    /// Marks a picture for the host to take, named for the posture and theme, and holds the page still for long enough:
    /// a host screenshot takes a second or two, so the frame it keeps must be well clear of whatever comes next.
    private func shot(_ name: String, light: Bool = false) {
        print("DUO-SHOT \(posture)-\(name)-\(light ? "light" : "dark") \(Date().timeIntervalSince1970)")
        Thread.sleep(forTimeInterval: 5)
    }

    /// Marks a movement for the host to cut as a short video.
    private func clip(_ name: String, light: Bool = false, _ body: () -> Void) {
        let label = "\(posture)-\(name)-\(light ? "light" : "dark")"
        print("DUO-CLIP-START \(label) \(Date().timeIntervalSince1970)")
        Thread.sleep(forTimeInterval: 1)
        body()
        Thread.sleep(forTimeInterval: 2)
        print("DUO-CLIP-END \(label) \(Date().timeIntervalSince1970)")
    }

    private func tapIfThere(_ element: XCUIElement, timeout: TimeInterval = 8) -> Bool {
        guard element.waitForExistence(timeout: timeout) else { return false }
        // A menu's items can read as not hittable while they are in view, so press where the element stands.
        if element.isHittable { element.tap() } else { element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        sleep(2)
        return true
    }

    /// A drag on the page's content, since a swipe can land on the rail or be taken for the sidebar's drag.
    private func scrollPage(by points: CGFloat) {
        let page = app.windows.firstMatch
        let from = page.coordinate(withNormalizedOffset: CGVector(dx: unfolded ? 0.5 : 0.4, dy: points < 0 ? 0.75 : 0.25))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: points)))
        sleep(2)
    }

    /// Closes whatever sheet is up: its Done, or a drag down from its top.
    private func dismissSheet() {
        for id in ["pull-request-done", "agents-done", "settings-sheet-done", "machine-done"] where app.buttons[id].exists {
            app.buttons[id].tap(); sleep(2); return
        }
        if app.buttons["Not now"].exists { app.buttons["Not now"].tap(); sleep(2); return }
        let top = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
        top.press(forDuration: 0.05, thenDragTo: top.withOffset(CGVector(dx: 0, dy: 500)))
        sleep(2)
    }

    /// Opens a thread from the Threads page, or from the sidebar where it stands.
    private func open(_ id: String) {
        let target = row(id)
        if target.waitForExistence(timeout: 15) {
            if !target.isHittable { app.swipeUp(); sleep(1) }
            target.tap()
        }
        _ = byID("thread-reply").waitForExistence(timeout: 10)
        sleep(2)
    }

    private func scrollThread(up: Bool) { scrollPage(by: up ? 320 : -320) }

    // MARK: Surfaces

    /// The Threads page: columns of cards unfolded, the thread list folded.
    func testThreadsPage() {
        for light in [false, true] {
            launch([], light: light)
            _ = byID("thread-search").waitForExistence(timeout: 20)
            shot("threads", light: light)
            if !light {
                scrollPage(by: -320)
                shot("threads-scrolled")
            }
            app.terminate()
        }
    }

    /// A running thread: the sidebar beside it unfolded, its steps, its menu, and the thread with the sidebar hidden.
    func testThreadReading() {
        for light in [false, true] {
            launch(["--ui-open-thread", "iphone"], light: light)
            _ = byID("thread-reply").waitForExistence(timeout: 20)
            sleep(2)
            shot("thread", light: light)
            guard !light else { app.terminate(); continue }
            // The running turn's working line, its steps opened and shut again.
            let runs = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'steps-run-'")).allElementsBoundByIndex
            if let running = runs.last, tapIfThere(running, timeout: 4) {
                shot("thread-steps-open")
                _ = tapIfThere(running, timeout: 2)
            }
            scrollThread(up: true)
            shot("thread-earlier")
            if tapIfThere(app.buttons["thread-actions"]) {
                shot("thread-menu")
                app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap(); sleep(2)
            }
            if unfolded, app.buttons["duo-sidebar"].exists {
                clip("sidebar-hide") { app.buttons["duo-sidebar"].tap(); sleep(2) }
                shot("thread-sidebar-hidden")
                clip("sidebar-show") { app.buttons["duo-sidebar"].tap(); sleep(2) }
            }
            let another = app.buttons["sidebar-thread-\(laptop)/shortcuts"]
            if unfolded, another.exists {
                clip("sidebar-switch-thread") { another.tap(); sleep(3) }
                shot("thread-idle")
            }
            app.terminate()
        }
    }

    /// A long finished thread, read from its end and scrolled back.
    func testLongThread() {
        launch(["--ui-long-thread", "--ui-open-thread", "drives"])
        _ = byID("thread-reply").waitForExistence(timeout: 20)
        sleep(3)
        shot("long-thread")
        clip("long-thread-scroll") { scrollThread(up: true); scrollThread(up: true) }
        shot("long-thread-earlier")
    }

    /// A thread with the pictures its agent made, as tiles.
    func testPictures() {
        launch(["--ui-pictures", "--ui-long-thread", "--ui-open-thread", "drives"])
        _ = byID("thread-reply").waitForExistence(timeout: 20)
        sleep(4)
        shot("pictures")
    }

    /// The reply box with the keyboard up.
    func testReplyKeyboard() {
        launch(["--ui-open-thread", "shortcuts", "--ui-can-stop"])
        let reply = byID("thread-reply")
        _ = reply.waitForExistence(timeout: 20)
        shot("reply-at-rest")
        clip("reply-focus") {
            reply.tap()
            _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
            reply.typeText("Check the shortcut list against the dictation hotkey before you add Ctrl+Shift+K.")
        }
        shot("reply-keyboard")
    }

    /// A question waiting on the user, raised as its sheet, and the reply box offering it again after Not now.
    func testQuestion() {
        for light in [false, true] {
            launch(["--ui-question-while-reading"], light: light)
            if unfolded { _ = byID("thread-search").waitForExistence(timeout: 20); shot("needs-you", light: light) }
            clip("question-open", light: light) { open("iphone"); _ = app.buttons["request-send-answer"].waitForExistence(timeout: 8) }
            shot("question", light: light)
            if !light, tapIfThere(app.buttons["Not now"]) { shot("question-waiting") }
            app.terminate()
        }
    }

    /// The pull request sheet from the ••• menu.
    func testPullRequest() {
        launch(["--ui-pull-request", "--ui-open-thread", "iphone"])
        _ = byID("thread-reply").waitForExistence(timeout: 20)
        if tapIfThere(app.buttons["thread-actions"]) {
            shot("thread-menu-pull-request")
            let item = app.buttons["thread-menu-pull-request"].exists ? app.buttons["thread-menu-pull-request"]
                : app.buttons.matching(NSPredicate(format: "label CONTAINS '721'")).firstMatch
            if tapIfThere(item, timeout: 4) {
                _ = byID("pull-request-title").waitForExistence(timeout: 10)
                sleep(2)
                shot("pull-request")
                if tapIfThere(app.buttons["pull-request-jump-checks"], timeout: 4) { shot("pull-request-checks") }
            }
        }
    }

    /// Agents: the thread's delegated threads and agents.
    func testAgents() {
        launch(["--ui-agents", "--ui-open-thread", "iphone"])
        _ = byID("thread-reply").waitForExistence(timeout: 20)
        dismissSheet()
        if tapIfThere(app.buttons["thread-agents"]) {
            sleep(3)
            shot("agents")
        }
    }

    /// Watcher's conversation, at rest and with the keyboard up.
    func testWatcher() {
        for light in [false, true] {
            launch(["--ui-open-watcher"], light: light)
            _ = byID("watcher-reply").waitForExistence(timeout: 20)
            sleep(2)
            shot("watcher", light: light)
            if !light {
                let reply = byID("watcher-reply")
                reply.tap()
                _ = app.keyboards.firstMatch.waitForExistence(timeout: 5)
                reply.typeText("What is waiting on me before lunch?")
                shot("watcher-keyboard")
            }
            app.terminate()
        }
    }

    /// Computers, Settings and New thread.
    func testOtherPages() {
        for light in [false, true] {
            launch([], light: light)
            _ = byID("thread-search").waitForExistence(timeout: 20)
            if tapIfThere(app.buttons["tab-computers"]) { shot("computers", light: light) }
            if tapIfThere(app.buttons["tab-settings"]) {
                shot("settings", light: light)
                if !light { scrollPage(by: -420); shot("settings-scrolled") }
            }
            if !light, tapIfThere(app.buttons["tab-threads"]), tapIfThere(app.buttons["new-thread"]) { shot("new-thread") }
            app.terminate()
        }
    }

    /// Movement between pages: a thread opened from Threads and back, and a tab change.
    func testMovement() {
        launch([])
        _ = byID("thread-search").waitForExistence(timeout: 20)
        clip("open-thread") { open("iphone") }
        clip("back-to-threads") {
            if app.buttons["duo-rail-back"].exists { app.buttons["duo-rail-back"].tap() } else { app.buttons["tab-threads"].tap() }
            sleep(2)
        }
        clip("tab-change") { app.buttons["tab-watcher"].tap(); sleep(2); app.buttons["tab-threads"].tap(); sleep(2) }
    }
}
