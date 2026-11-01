import XCTest
import UIKit

/// Runs the real SwiftUI hierarchy with isolated, in-memory host data. No host or account is used.
@MainActor final class FocusJourneyTests: XCTestCase {
    private let app = XCUIApplication()
    private let laptop = "11111111-1111-4111-8111-111111111111"
    private static let fixture = ["--ui-fixture", "--reset-ui-preferences"]

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        // Each journey launches the fixture it uses; CPU journeys can skip before starting the app.
    }

    override func tearDownWithError() throws {
        // Each journey stops its own copy of Sotto, so the next journey's launch never has to stop one first.
        if appIsRunning { app.terminate(); _ = app.wait(for: .notRunning, timeout: 20) }
    }

    private var appIsRunning: Bool {
        switch app.state {
        case .runningForeground, .runningBackground, .runningBackgroundSuspended: return true
        default: return false
        }
    }

    /// Starts a fresh copy of Sotto with these arguments once any earlier copy has stopped, and waits for Threads.
    private func launch(_ arguments: [String], opensOnThreads: Bool = true) {
        if appIsRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 20), "The earlier copy of Sotto must stop before the next launch")
        }
        // The journeys read English labels, so Sotto runs in English whatever the simulator's language (ADR-0123).
        app.launchArguments = arguments + ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "Sotto must come to the foreground after launch")
        if opensOnThreads { XCTAssertTrue(app.textFields["thread-search"].waitForExistence(timeout: 20)) }
        waitForRenderedOrientation(landscape: false)
    }

    private func row(_ id: String) -> XCUIElement { app.buttons["thread-\(laptop)/\(id)"] }
    /// Any element by its accessibility identifier, whatever kind of element it is.
    private func byID(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    /// Any element whose label starts with these words.
    private func text(_ start: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", start)).firstMatch
    }
    /// Text in the open thread's own conversation that starts with these words. Scoped to the scroll view holding the
    /// thread's title, so a copy elsewhere in the app (the Threads list under the pushed page) is never the match.
    private func threadText(_ start: String) -> XCUIElement {
        app.scrollViews.containing(.staticText, identifier: "thread-title").firstMatch
            .descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", start)).firstMatch
    }
    /// Any element whose label is exactly these words.
    private func labelled(_ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", words)).firstMatch
    }
    private func capture(_ name: String) {
        // Capture the screen rather than the app's rotating/clipped window crop.
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    private func reveal(_ element: XCUIElement, swipingDown: Bool = false, fullyVisible: Bool = false) {
        var down = swipingDown
        var steps: [String] = []
        var lastViewport = CGRect.null
        for attempt in 0..<40 {
            if element.exists && element.isHittable && !fullyVisible { return }
            // A full-window fling can skip a whole card. Keep each drag inside the foreground
            // scroll view, clear of the pinned search/header and the tabs' bar.
            guard let scroll = app.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable }) else {
                steps.append("No hittable scroll view on attempt \(attempt)")
                break
            }
            let window = app.windows.firstMatch
            var visible = scroll.frame.intersection(window.frame)
            let tab = app.tab("Threads")
            if tab.exists && tab.frame.minY > visible.minY {
                visible.size.height = min(visible.maxY, tab.frame.minY) - visible.minY
            }
            guard !visible.isNull, visible.width > 20, visible.height > 40 else {
                steps.append("No usable scroll viewport: \(visible)")
                break
            }
            lastViewport = visible.insetBy(dx: 0, dy: 12)
            if element.exists && element.isHittable && lastViewport.contains(element.frame) { return }
            if element.exists {
                let target = element.frame
                if !target.isEmpty {
                    if fullyVisible {
                        if target.minY < lastViewport.minY { down = true }
                        else if target.maxY > lastViewport.maxY { down = false }
                    } else {
                        if target.maxY <= visible.minY + 12 { down = true }
                        else if target.minY >= visible.maxY - 12 { down = false }
                    }
                }
                steps.append("\(attempt): target \(target), viewport \(visible), down \(down)")
            } else {
                steps.append("\(attempt): target not materialized, viewport \(visible), down \(down)")
            }
            let distance = min(120, visible.height * 0.3)
            let direction: CGFloat = down ? 1 : -1
            let origin = window.coordinate(withNormalizedOffset: .zero)
            // Drag in the page's leading margin, where no control sits: a drag that starts on a slider moves the slider,
            // not the page. Settings' Glow slider came to sit under the viewport's middle once Glass added a third row of
            // theme tiles, and forty drags in a row moved only the slider (#1752).
            let x = visible.minX + 10 - window.frame.minX
            let y = visible.midY - window.frame.minY
            let start = origin.withOffset(CGVector(dx: x, dy: y - direction * distance / 2))
            let end = origin.withOffset(CGVector(dx: x, dy: y + direction * distance / 2))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.15)
        }
        let reached = element.exists && element.isHittable && (!fullyVisible || lastViewport.contains(element.frame))
        if reached { return }
        capture("unreachable-control")
        let diagnostic = XCTAttachment(string: steps.joined(separator: "\n") + "\n\n" + app.debugDescription)
        diagnostic.name = "Scroll reachability and accessibility hierarchy"
        diagnostic.lifetime = .keepAlways
        add(diagnostic)
        XCTAssertTrue(reached, "The control must remain reachable and meet the requested visibility by scrolling")
    }
    /// Grows the open sheet to its full height, as a person does to read the rest of its list: its grabber dragged to the
    /// top of the screen and held there, so the sheet settles at full height. At half height a drag on the list grows the
    /// sheet instead of scrolling it, and `reveal`'s short, slow drags let it fall back each time: on CI's SE, Full access
    /// stayed below the screen through forty of them. iOS gives its grabber no identifier, so it is found by its name, and
    /// its height read from its value: "Sheet Grabber", "Half screen" and "Expanded" are iOS 26's English words for them.
    private func expandSheet() {
        let grabber = app.buttons["Sheet Grabber"].firstMatch
        XCTAssertTrue(grabber.waitForExistence(timeout: 5), "The sheet shows its grabber")
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        for _ in 0..<2 where grabber.value as? String != "Expanded" {
            let top = origin.withOffset(CGVector(dx: grabber.frame.midX - window.frame.minX, dy: 40))
            grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                .press(forDuration: 0.1, thenDragTo: top, withVelocity: .slow, thenHoldForDuration: 0.3)
            let expanded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Expanded"), object: grabber)
            if XCTWaiter.wait(for: [expanded], timeout: 10) == .completed { break }
        }
        let value = grabber.value as? String ?? "no value"
        if value != "Expanded" { explain("sheet-not-expanded", "grabber \(grabber.frame), value \(value)") }
        XCTAssertEqual(value, "Expanded", "Dragging the grabber to the top grows the sheet to its full height")
    }
    private func waitForRenderedOrientation(landscape: Bool) {
        var consecutiveMatches = 0
        var samples: [String] = []
        let rendered = NSPredicate { _, _ in
            let frame = self.app.windows.firstMatch.frame
            let image = XCUIScreen.main.screenshot().image
            var imageSize = image.cgImage.map { CGSize(width: CGFloat($0.width), height: CGFloat($0.height)) } ?? image.size
            // A screenshot may store portrait pixels with a quarter-turn orientation. Read the
            // displayed dimensions, rather than interpreting raw PNG dimensions as orientation.
            switch image.imageOrientation {
            case .left, .right, .leftMirrored, .rightMirrored:
                imageSize = CGSize(width: imageSize.height, height: imageSize.width)
            default: break
            }
            samples.append("window \(frame), displayed screen \(imageSize), orientation \(image.imageOrientation.rawValue)")
            let matches = (frame.width > frame.height) == landscape
                && (imageSize.width > imageSize.height) == landscape
            consecutiveMatches = matches ? consecutiveMatches + 1 : 0
            return consecutiveMatches >= 2
        }
        // Window geometry and screenshot orientation can settle separately during rotation.
        let ready = XCTNSPredicateExpectation(predicate: rendered, object: app)
        let result = XCTWaiter.wait(for: [ready], timeout: 20)
        if result != .completed {
            capture("rotation-not-ready")
            let diagnostic = XCTAttachment(string: samples.joined(separator: "\n"))
            diagnostic.name = "Window and screen orientation samples"
            diagnostic.lifetime = .keepAlways
            add(diagnostic)
        }
        XCTAssertEqual(result, .completed,
                       "The rendered screenshot must finish rotating with the window")
    }
    private func back() {
        let button = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in button.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed,
                       "Back must be hittable after a request sheet closes")
        button.tap()
    }
    /// Presses `control` and waits up to `timeout` for `done`. A loaded CI simulator now and then drops a synthesized tap:
    /// the tap reports success and the app never sees it (#1320). So when nothing has happened after a first look and
    /// `untouched` says the control still reads as it did before the press, it is pressed once more; `untouched` keeps a
    /// press that only landed late from being undone by the second.
    @discardableResult
    private func press(_ control: XCUIElement, until done: NSPredicate, timeout: TimeInterval = 20,
                       untouched: () -> Bool = { true }) -> XCTWaiter.Result {
        control.tap()
        let first = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: done, object: nil)], timeout: min(8, timeout))
        if first == .completed { return first }
        if untouched() { control.tap() }
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: done, object: nil)], timeout: timeout)
    }
    /// Generous on purpose: it ends as soon as the element goes, and a loaded CI simulator can take seconds just to look.
    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval = 20) -> Bool {
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        return XCTWaiter.wait(for: [gone], timeout: timeout) == .completed
    }

    // MARK: The open thread

    /// The top of what the conversation shows: the bottom of the thread's slim bar.
    private var threadTop: CGFloat {
        let bar = app.navigationBars.firstMatch
        return bar.exists ? bar.frame.maxY : app.windows.firstMatch.frame.minY
    }

    /// Waits until the conversation's end is in view above `dock`: `end`, the final row, whole between the bar and the
    /// dock, and the bottom of `last`, the last message, on screen above the dock. Two readings in a row must agree.
    private func waitForEnd(_ end: XCUIElement, last: XCUIElement, above dock: XCUIElement, _ message: String) {
        // At accessibility sizes, with timers ticking and the keyboard settling, a query can briefly find nothing; let
        // each element be found before reading where it is.
        for element in [end, last, dock] { _ = element.waitForExistence(timeout: 10) }
        var matches = 0
        var seen = ""
        let inView = NSPredicate { _, _ in
            guard end.exists, last.exists, dock.exists else { seen = "an element is missing"; matches = 0; return false }
            let top = self.threadTop, floor = dock.frame.minY
            let step = end.frame, words = last.frame
            seen = "end \(step), last message \(words), bar bottom \(top), dock top \(floor)"
            let shown = step.minY >= top - 1 && step.maxY <= floor + 1 && words.maxY > top && words.maxY <= floor + 1
            matches = shown ? matches + 1 : 0
            return matches >= 2
        }
        // With the keyboard up, one reading of the four elements can take the simulator ten seconds or more.
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: inView, object: nil)], timeout: 60)
        if result != .completed { explain("conversation-end-not-in-view", seen) }
        XCTAssertEqual(result, .completed, message + " (" + seen + ")")
    }

    private func explain(_ name: String, _ frames: String) {
        capture(name)
        let diagnostic = XCTAttachment(string: frames + "\n\n" + app.debugDescription)
        diagnostic.name = name + " frames and accessibility hierarchy"
        diagnostic.lifetime = .keepAlways
        add(diagnostic)
    }

    /// Scrolls the open thread's conversation until `target` can be pressed. Each drag stays inside the page, clear of
    /// the native scrollbar and the back gesture's edge, between the bar and the reply box.
    private func scrollThread(to target: XCUIElement, towardStart: Bool) {
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        var down = towardStart
        var steps: [String] = []
        for attempt in 0..<40 {
            if target.exists && target.isHittable { return }
            let top = threadTop + 16
            let reply = byID("thread-reply")
            let bottom = (reply.exists ? reply.frame.minY : window.frame.maxY - 120) - 32
            guard bottom - top > 60 else { steps.append("No room to drag: \(top) to \(bottom)"); break }
            if target.exists {
                let frame = target.frame
                if !frame.isEmpty {
                    if frame.maxY <= top { down = true } else if frame.minY >= bottom { down = false }
                }
                steps.append("\(attempt): target \(frame), between \(top) and \(bottom), down \(down)")
            } else {
                steps.append("\(attempt): target not materialized, between \(top) and \(bottom), down \(down)")
            }
            // Shorter than the space it drags in, so nothing can pass from below that space to above it unseen.
            let distance = min(220, (bottom - top) * 0.45)
            let direction: CGFloat = down ? 1 : -1
            let x = window.frame.width - 32
            let middle = (top + bottom) / 2 - window.frame.minY
            let start = origin.withOffset(CGVector(dx: x, dy: middle - direction * distance / 2))
            let end = origin.withOffset(CGVector(dx: x, dy: middle + direction * distance / 2))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.15)
        }
        if target.exists && target.isHittable { return }
        explain("unreachable-in-thread", steps.joined(separator: "\n"))
        XCTAssertTrue(target.exists && target.isHittable, "Scrolling the thread must reach it")
    }

    // MARK: Journeys

    func testCreateThreadInAKnownProject() {
        launch(Self.fixture)
        app.buttons["new-thread"].tap()
        // With only the laptop online, New thread starts on its projects (#1856); the computer's chip still opens the list.
        let project = app.buttons["new-thread-project-sotto"]
        XCTAssertTrue(project.waitForExistence(timeout: 5), "With one computer online, New thread opens on its projects")
        app.buttons["new-thread-change-computer"].tap()
        let offline = app.buttons["new-thread-computer-22222222-2222-4222-8222-222222222222"]
        XCTAssertTrue(offline.waitForExistence(timeout: 5))
        XCTAssertFalse(offline.isEnabled)
        capture("new-thread-computers-dark")
        app.buttons["new-thread-computer-\(laptop)"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        project.tap()
        let open = app.buttons["open-new-thread"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        XCTAssertTrue(open.isEnabled)
        capture("new-thread-options-dark")
        open.tap()
        let title = byID("thread-title")
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "New thread")
        capture("new-thread-conversation-dark")
    }

    func testCreateThreadByBrowsingANewFolder() {
        launch(Self.fixture)
        browseANewFolder()
    }
    /// Return closes search's keyboard on Threads, where the page's looping lights and wash run in Core Animation.
    func testSearchClosesOnReturn() {
        launch(Self.fixture)
        let search = app.textFields["thread-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        let keyboard = app.keyboards.firstMatch
        // On CI's large simulator a tap once left the field without the keyboard (PR #1657). This journey is about Return,
        // so the field is tapped once more; the scroll journey still holds a single tap to opening it.
        if !keyboard.waitForExistence(timeout: 5) { search.tap() }
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "Search opens the keyboard")
        search.typeText("Sim")
        search.typeText("\n")
        XCTAssertTrue(waitUntilGone(keyboard), "Return closes search's keyboard")
    }

    private func browseANewFolder() {
        app.tab("Settings").tap()
        app.buttons["setting-light"].tap()
        app.tab("Threads").tap()
        app.buttons["new-thread"].tap()
        let browse = app.buttons["browse-project-folder"]
        XCTAssertTrue(browse.waitForExistence(timeout: 5), "With one computer online, New thread opens on its projects")
        reveal(browse); browse.tap()
        let filter = app.textFields["folder-filter"]
        XCTAssertTrue(filter.waitForExistence(timeout: 5))
        capture("new-project-folders-light")
        filter.tap(); filter.typeText("New")
        capture("new-project-filter-keyboard")
        filter.typeText("\n")
        XCTAssertTrue(waitUntilGone(app.keyboards.firstMatch))
        let folder = app.buttons["folder-New project"]
        reveal(folder); XCTAssertTrue(folder.isHittable)
        XCTAssertFalse(app.buttons["folder-Panel tools"].exists)
        capture("new-project-filtered-folders")
        folder.tap()
        // Opening the folder reads it, and Use this folder is off while a read is on its way: the read is done once the path
        // names the folder, and only then is the button pressed.
        let path = app.textFields["project-folder-path"]
        let read = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "D:\\New project"), object: path)
        XCTAssertEqual(XCTWaiter.wait(for: [read], timeout: 10), .completed, "Opening the folder reads it")
        let use = app.buttons["use-project-folder"]
        XCTAssertTrue(use.waitForExistence(timeout: 5)); XCTAssertTrue(use.isEnabled)
        capture("new-project-selected-folder-light")
        use.tap()
        let open = app.buttons["open-new-thread"]
        // On CI the simulator once drew this press on Use this folder and SwiftUI never acted on it: the recording shows the
        // button pressed, then the folder step, its button enabled and nothing on it moving, until the journey gave up. A
        // press that wasn't taken is pressed once more, only while the folder step still offers it, and the screen and
        // hierarchy go in the results, so a press that keeps being lost is seen there.
        if !open.waitForExistence(timeout: 10), use.exists, use.isEnabled, use.isHittable {
            explain("use-folder-press-not-taken", "Use this folder \(use.frame), still on the folder step")
            use.tap()
        }
        XCTAssertTrue(open.waitForExistence(timeout: 10)); XCTAssertTrue(open.isEnabled)
        let project = app.buttons["new-thread-change-project"]
        XCTAssertTrue(project.exists)
        XCTAssertEqual(project.label, "Change project, now New project", "The chosen folder names the project")
        capture("new-project-thread-options")
        open.tap()
        XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 5))
        capture("new-project-conversation")
    }

    func testFocusSearchAndNavigation() {
        launch(Self.fixture)
        XCTAssertTrue(app.tab("Threads").isSelected)
        XCTAssertFalse(app.tabButtons["Needs you"].exists)
        XCTAssertTrue(app.tab("Computers").exists)
        XCTAssertTrue(app.tab("Settings").exists)
        XCTAssertTrue(row("release").exists)
        let search = app.textFields["thread-search"]
        let restingTop = search.frame.minY
        capture("focus-dark")
        reveal(row("iphone"))
        reveal(row("wiring"))
        XCTAssertTrue(row("wiring").label.contains("Working"), "Background work must not read Done")
        capture("working-threads")
        reveal(row("shortcuts"))
        reveal(row("drives"))
        XCTAssertTrue(row("shortcuts").label.contains("just finished, not opened yet"), "A thread that finished out of sight says so until it is opened")
        XCTAssertFalse(row("drives").label.contains("just finished"), "A read row is unchanged")
        capture("recent-unread-finished")
        let settled = app.buttons["settled-threads"]
        reveal(settled)
        XCTAssertTrue(!search.exists || search.frame.minY < restingTop - 40, "Search scrolls away with the list, as one sheet")

        // Search's keyboard closes on a tap outside the field, and on scrolling the list. The Needs you heading under
        // search is somewhere to tap that does nothing else.
        let heading = byID("threads-heading-needs")
        reveal(heading, swipingDown: true)
        reveal(search)
        let keyboard = app.keyboards.firstMatch
        search.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "Search opens the keyboard")
        XCTAssertTrue(heading.isHittable)
        heading.tap()
        XCTAssertTrue(waitUntilGone(keyboard), "A tap outside search closes its keyboard")
        search.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "Search opens the keyboard again")
        capture("search-before-scroll-keyboard")
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        // iOS 26 draws its suggestion bar above the frame XCTest reports for the keyboard, so start well clear of it.
        let low = keyboard.frame.minY - 90
        let high = max(search.frame.maxY + 24, low - 120)
        let x = window.frame.width / 2
        origin.withOffset(CGVector(dx: x, dy: low - window.frame.minY))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: x, dy: high - window.frame.minY)),
                   withVelocity: .slow, thenHoldForDuration: 0.1)
        let keyboardClosed = app.keyboards.firstMatch.waitForNonExistence(timeout: 5)
        XCTAssertTrue(keyboardClosed, "Scrolling the list closes search's keyboard")
        capture("search-after-scroll-keyboard")
        reveal(search, swipingDown: true)

        search.tap()
        search.typeText("Simplify")
        XCTAssertTrue(row("settings").waitForExistence(timeout: 5), "Search includes collapsed settled threads")
        XCTAssertFalse(row("iphone").exists)
        capture("search-settled-keyboard")
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8))
        search.typeText("no matching thread")
        XCTAssertFalse(row("settings").exists)
        capture("search-empty")

        // Relaunch clears only transient search, allowing the real list's collapse state to be checked.
        launch(Self.fixture)
        reveal(settled)
        XCTAssertFalse(row("settings").exists)
        settled.tap()
        reveal(row("settings"))
        capture("settled-expanded")
        row("settings").tap()
        XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 5))
        let run = byID("steps-run-read")
        XCTAssertTrue(run.waitForExistence(timeout: 5), "Steps sit in the conversation, folded into one line; there is no Activity tab")
        XCTAssertEqual(run.label, "Show 1 step")
        XCTAssertFalse(byID("step-read").exists, "A finished run's steps stay folded until its line is pressed")
        XCTAssertFalse(app.buttons["thread-pane-activity"].exists)
        capture("thread-messages")
        run.tap()
        let step = byID("step-read")
        XCTAssertTrue(step.waitForExistence(timeout: 5), "Pressing the line opens its steps")
        XCTAssertTrue(step.label.contains("Read project notes"))
        back()
        reveal(settled, swipingDown: true)
        settled.tap()
        XCTAssertFalse(row("settings").exists)

        launch(Self.fixture)
        let release = row("release")
        reveal(release)
        release.tap()
        XCTAssertTrue(app.buttons["Not now"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Which release should I prepare?"].exists)
        capture("thread-question")
        reveal(app.buttons["Not now"])
        app.buttons["Not now"].tap()
        let permission = "Allow reading the release checklist?"
        XCTAssertTrue(app.staticTexts[permission].waitForExistence(timeout: 5), "Deferring the first request exposes the second")
        capture("thread-second-request")
        reveal(app.buttons["Not now"])
        app.buttons["Not now"].tap()
        let requests = app.buttons["thread-requests"]
        XCTAssertTrue(requests.waitForExistence(timeout: 5))
        requests.tap()
        app.buttons["Which release should I prepare?"].tap()
        XCTAssertTrue(app.staticTexts["Which release should I prepare?"].waitForExistence(timeout: 5))
        reveal(app.buttons["Not now"])
        app.buttons["Not now"].tap()
        XCTAssertTrue(requests.waitForExistence(timeout: 5))
        requests.tap()
        app.buttons[permission].tap()
        XCTAssertTrue(app.staticTexts[permission].waitForExistence(timeout: 5), "Both unanswered requests remain reachable from the composer")
        reveal(app.buttons["Not now"])
        app.buttons["Not now"].tap()
        back()
        let computers = app.tab("Computers")
        XCTAssertTrue(computers.waitForExistence(timeout: 5), "Back restores the main tabs")
        computers.tap()
        XCTAssertTrue(app.buttons["Try reaching Studio Mac again"].waitForExistence(timeout: 5))
        capture("computers")
    }

    /// A long thread whose messages arrive a moment after it opens shows its end at once. On the phone a thread sometimes
    /// opened black until scrolled; a lazy list landing over rows it had not drawn is the likely cause. The simulator did
    /// not reproduce it, so this journey guards the end of a long thread rather than proving the fix.
    func testALongThreadShowsItsEndWithoutAScroll() {
        launch(["--ui-fixture", "--reset-ui-preferences", "--ui-long-thread", "--ui-slow-detail"])
        let thread = row("drives")
        reveal(thread)
        thread.tap()
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        // The thread ends on its last run of steps, folded into one line.
        let end = byID("steps-run-long-final")
        // The last reply is taller than the screen, so its heading sits above the view at the end; its closing command
        // is what must be on screen.
        let last = threadText("python compare_drives.py --option 12 --report")
        waitForEnd(end, last: last, above: reply, "A long thread opens showing its end, with no scroll needed")
        capture("thread-long-open")
    }

    /// A paste into the reply box attaches a copied file as a pill, as if chosen in Files, and copied words still paste as words.
    func testPastingACopiedFileAttachesItAndWordsStayWords() {
        launch(Self.fixture + ["--ui-files"])
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let pdf = Data("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n".utf8)
        UIPasteboard.general.setItems([["com.adobe.pdf": pdf]])
        paste(into: reply)
        XCTAssertTrue(text("Pasted file.pdf").waitForExistence(timeout: 5), "A copied PDF goes into the box as a file")
        XCTAssertTrue(["", "Reply while it works", "Reply to this thread"].contains(reply.value as? String ?? ""), "None of it is pasted as words")
        capture("thread-pasted-file")
        UIPasteboard.general.string = "Synthetic copied words"
        paste(into: reply)
        XCTAssertTrue(reply.waitForValue("Synthetic copied words"), "Copied words paste as words")
    }
    private func paste(into field: XCUIElement) {
        field.tap()
        field.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.buttons["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste is offered for what was copied")
        paste.tap()
    }

    /// Thread page B: the conversation opens at its end and stays there while the reply keyboard opens and closes; the
    /// title block and Git chips scroll away with it; messages read as Markdown blocks.
    func testThreadPageKeepsItsPlaceAndReadsMarkdown() {
        launch(Self.fixture)
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        let title = byID("thread-title")
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Refine the iPhone thread view")
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let running = byID("steps-run-drawer-test")
        XCTAssertTrue(running.waitForExistence(timeout: 5), "The working run's line sits at the end of the conversation")
        let update = threadText("Still working through the review fixes")
        waitForEnd(running, last: update, above: reply, "The thread opens at the end of its conversation")
        XCTAssertLessThanOrEqual(title.frame.maxY, threadTop + 1, "A long thread opens at its end, not its title")
        capture("thread-glow-bottom")

        reply.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "The reply box opens the keyboard")
        waitForEnd(running, last: update, above: reply, "With the keyboard open, the conversation's end stays above the reply box")
        capture("thread-glow-keyboard")
        let opening = text("Review the frosted window branch")
        XCTAssertFalse(opening.exists && opening.isHittable, "The page stays away from the thread's first message")

        // The review reads as blocks: headings, separate list items, a code block, and no Markdown marks left over. The
        // whole message is one row of the conversation, so once its heading is on screen every block of it exists.
        let heading = labelled("Not asked for")
        scrollThread(to: heading, towardStart: true)
        for start in ["Remembered state:", "The shortcut itself:", "Reduce transparency:", "Tooltips:"] {
            let item = text(start)
            XCTAssertTrue(item.exists, "\(start) is a list item of its own")
            XCTAssertFalse(item.label.contains("Not asked for"), "A list item is its own block, apart from the heading")
        }
        XCTAssertFalse(text("Remembered state:").label.contains("The shortcut itself"), "Each list item is its own block")
        XCTAssertFalse(text("The shortcut itself:").label.contains("Reduce transparency"), "Each list item is its own block")
        XCTAssertTrue(text("The shortcut itself:").label.contains("Ctrl+`"), "A key chord ending in a backtick reads as the key")
        XCTAssertTrue(text("The shortcut itself:").label.contains("Mod+J"), "A backtick chord doesn't swallow the words after it")
        XCTAssertTrue(labelled("Implemented but looks wrong").exists, "A bold line reads as a heading")
        XCTAssertTrue(labelled("npm test -- tests/unit/renderer/terminalDrawer.test.ts").exists, "A fenced block reads as code")
        let marks = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "**"))
        XCTAssertEqual(marks.count, 0, "Bold marks never show as asterisks")

        // A table that fits reads as a grid of cells and one too wide as a card per row. Larger text can make the narrow
        // one a card too, so its words are looked for inside any label. No pipe is left over.
        let holding = { (words: String) in
            self.app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
        }
        let narrow = holding("Open the thread")
        scrollThread(to: narrow, towardStart: false)
        XCTAssertTrue(holding("0.3 s").exists, "The narrow table's cells read")
        let card = text("Finding")
        scrollThread(to: card, towardStart: false)
        XCTAssertTrue(card.label.contains("Drawer toggle"), "A wide table's row reads as one card under its first column")
        XCTAssertTrue(card.label.contains("Terminal mode"), "A card holds every column of its row")
        capture("thread-glow-tables")
        let pipes = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "|"))
        XCTAssertEqual(pipes.count, 0, "Table pipes never show")

        scrollThread(to: title, towardStart: true)
        let chips = text("Branch feat/frosted-window-and-pane-terminal")
        XCTAssertTrue(chips.waitForExistence(timeout: 5), "The branch chip reads from the worktree's Git status")
        XCTAssertTrue(chips.label.contains("7 files changed, 212 lines added, 48 removed"))
        XCTAssertTrue(chips.label.contains("Pull request 721, draft"))
        capture("thread-glow-top")
    }

    /// At the largest text sizes a thread stays inside the screen. On a small iPhone the Git chips wrap onto another line
    /// rather than widen the page, which cut the first letters off every line of the thread (#1848).
    func testAThreadStaysInsideTheScreenAtTheLargestTextSizes() {
        launch(Self.fixture + ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"])
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(byID("thread-reply").waitForExistence(timeout: 5))
        let chips = text("Branch feat/frosted-window-and-pane-terminal")
        scrollThread(to: chips, towardStart: true)
        let screen = app.windows.firstMatch.frame
        for (name, element) in [("The title", app.staticTexts["thread-title"]), ("The branch and changes", chips), ("The reply box", byID("thread-reply"))] {
            XCTAssertTrue(element.exists, "\(name) shows")
            XCTAssertGreaterThanOrEqual(element.frame.minX, screen.minX - 1, "\(name) starts inside the screen")
            XCTAssertLessThanOrEqual(element.frame.maxX, screen.maxX + 1, "\(name) ends inside the screen")
        }
        capture("thread-largest-text-top")
    }

    /// A press on the tab already chosen scrolls its page back to the top, as the system's tab bar does.
    func testPressingTheChosenTabAgainScrollsItsPageToTheTop() {
        launch(Self.fixture)
        let tab = byID("tab-settings")
        tab.tap()
        let heading = app.staticTexts["Settings"].firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: 5))
        for _ in 0..<3 { app.swipeUp() }
        XCTAssertFalse(heading.isHittable, "Scrolled down, the page's heading has left the screen")
        capture("settings-scrolled-status-bar")
        tab.tap()
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: heading)
        waitForExpectations(timeout: 5)
    }

    /// A thread's pull request on an Owl computer (ADR-0102): the chip opens a sheet that reads it from GitHub, shows where
    /// it stands, its failing check first with how long it took, and starts and stops babysitting. Once read, the chip
    /// carries the checks.
    func testThePullRequestChipOpensItsSheetAndBabysitsIt() {
        launch(Self.fixture + ["--ui-pull-request"])
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(byID("thread-reply").waitForExistence(timeout: 5))
        let chip = app.buttons["pull-request-chip"]
        scrollThread(to: chip, towardStart: true)
        XCTAssertEqual(chip.label, "Show pull request 721, draft", "Before the sheet has read it, the chip says nothing of its checks")
        XCTAssertTrue(text("Branch feat/frosted-window-and-pane-terminal").exists, "The branch and changes still read as one sentence")
        chip.tap()

        let title = byID("pull-request-title")
        XCTAssertTrue(title.waitForExistence(timeout: 5), "The sheet reads the pull request when it opens")
        XCTAssertEqual(title.label, "Let the window frost and put a terminal in the bottom third")
        XCTAssertTrue(byID("pull-request-standing-0").label.hasPrefix("A check failed"), "Where it stands starts with the checks")
        XCTAssertTrue(byID("pull-request-standing-1").label.hasPrefix("Changes requested"))
        XCTAssertTrue(byID("pull-request-standing-2").label.hasPrefix("3 commits behind main"))
        capture("pull-request-sheet-top")

        app.buttons["pull-request-jump-checks"].tap()
        let failing = labelled("Gates (Windows), Failed, 14 minutes 2 seconds")
        XCTAssertTrue(failing.waitForExistence(timeout: 5), "The failing check comes first, with how long it took")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Lint, Passed")).firstMatch.exists, "Passed checks fold away while one fails")
        let showPassed = app.buttons["pull-request-passed-checks"]
        let lint = text("Lint, Passed")
        press(showPassed, until: NSPredicate { _, _ in lint.exists }, untouched: { showPassed.label.hasPrefix("Show") })
        XCTAssertTrue(lint.waitForExistence(timeout: 5), "Show passed opens them in place")
        capture("pull-request-sheet-checks")

        let babysit = app.buttons["babysit-pull-request"]
        XCTAssertTrue(babysit.waitForExistence(timeout: 5), "Babysit pull request is docked at the bottom")
        XCTAssertEqual(babysit.label, "Babysit pull request #721")
        babysit.tap()
        let stop = app.buttons["stop-babysitting"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5), "Once the computer babysits it, the dock offers Stop babysitting")
        XCTAssertTrue(text("Babysitting since").exists)
        capture("pull-request-sheet-babysitting")
        stop.tap()
        XCTAssertTrue(babysit.waitForExistence(timeout: 5), "Stopping offers Babysit pull request again")

        app.buttons["pull-request-close"].tap()
        XCTAssertTrue(chip.waitForExistence(timeout: 5))
        let read = NSPredicate(format: "label == %@", "Show pull request 721, draft. Checks: 1 failing, 1 running, 2 passed")
        XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: read, evaluatedWith: chip)], timeout: 5), .completed, "Once read, the chip says its checks")
    }

    /// Each run of steps between two messages is one line. The working run names the step running now; a finished run
    /// says how many steps it had and how long they took. A press opens a run's steps in place and another folds them.
    func testARunOfStepsOpensInPlaceAndFoldsAgain() {
        launch(Self.fixture)
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(byID("thread-reply").waitForExistence(timeout: 5))
        let working = byID("steps-run-drawer-test")
        XCTAssertTrue(working.waitForExistence(timeout: 5), "The working run is one line at the end of the conversation")
        XCTAssertEqual(working.label, "Show 1 step", "The line's name says what a press does")
        XCTAssertEqual(working.value as? String,
                       "Working: Running npm test -- tests/unit/renderer/terminalDrawer.test.ts, 1 step so far",
                       "The working line names the step running now")
        XCTAssertFalse(byID("step-drawer-test").exists, "The working run's steps stay folded until its line is pressed")

        let finished = byID("steps-run-edit-tooltips")
        XCTAssertTrue(finished.waitForExistence(timeout: 5))
        scrollThread(to: finished, towardStart: true)
        XCTAssertEqual(finished.label, "Show 3 steps")
        // From the first edit's start to the end of the typecheck: three and a half minutes, give or take a second.
        let summary = finished.value as? String ?? ""
        XCTAssertTrue(summary.hasPrefix("3 steps, 3 minutes"), "A finished run says how many steps and how long (\(summary))")
        XCTAssertFalse(finished.isSelected)
        let typecheck = byID("step-typecheck")
        XCTAssertFalse(typecheck.exists, "A finished run's steps stay folded until its line is pressed")
        capture("thread-steps-folded")

        finished.tap()
        XCTAssertTrue(typecheck.waitForExistence(timeout: 5), "Pressing the line opens the run's steps in place")
        XCTAssertTrue(byID("step-edit-tooltips").exists)
        XCTAssertTrue(byID("step-edit-drawer").exists)
        XCTAssertEqual(finished.label, "Hide steps")
        XCTAssertTrue(finished.isSelected, "An open run is marked as open")
        XCTAssertFalse(byID("step-think").exists, "Opening one run leaves the others folded")
        capture("thread-steps-open")

        scrollThread(to: finished, towardStart: true)
        finished.tap()
        XCTAssertTrue(waitUntilGone(typecheck), "Pressing the line again folds the steps")
        XCTAssertEqual(finished.label, "Show 3 steps")
        XCTAssertTrue(working.exists, "Folding a run leaves the working run's line in place")
    }

    /// A question answered from its sheet leaves the conversation where the user was reading: at its end.
    func testAnsweringAQuestionKeepsTheConversationAtItsEnd() {
        launch(Self.fixture + ["--ui-question-while-reading"])
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        let send = app.buttons["request-send-answer"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "A waiting question opens with its thread")
        let notNow = app.buttons["Not now"]
        XCTAssertTrue(notNow.exists)
        notNow.tap()
        XCTAssertTrue(waitUntilGone(send), "Not now closes the question")
        let ask = app.buttons["Answer the question"]
        XCTAssertTrue(ask.waitForExistence(timeout: 5), "The reply box offers the question again")
        let running = byID("steps-run-drawer-test")
        let update = threadText("Still working through the review fixes")
        XCTAssertTrue(running.waitForExistence(timeout: 5))
        waitForEnd(running, last: update, above: ask, "The conversation stays at its end under a waiting question")

        ask.tap()
        XCTAssertTrue(send.waitForExistence(timeout: 5), "The question opens again from the reply box")
        let option = app.buttons["request-option-j"]
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        reveal(option)
        option.tap()
        XCTAssertTrue(option.isSelected, "The chosen answer is marked")
        XCTAssertTrue(send.isEnabled)
        capture("question-glow-sheet")
        send.tap()
        // Asked first: "Answer sent." passes five seconds after it shows.
        XCTAssertTrue(labelled("Answer sent.").waitForExistence(timeout: 10))
        XCTAssertTrue(waitUntilGone(send), "The question closes once it is answered")
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5), "With nothing waiting, the reply box returns")
        waitForEnd(running, last: update, above: reply, "Answering keeps the conversation at its end, not its top")
        XCTAssertLessThanOrEqual(byID("thread-title").frame.maxY, threadTop + 1, "The page never jumps to the title after an answer")
        capture("question-glow-after")
    }

    /// Needs you is a row like the others, with nothing to answer on the Threads page itself: the row opens its thread,
    /// and the question opens there (ADR-0151, amended October 30, 2026, Zach's pick A).
    func testANeedsYouRowOpensItsThreadOnTheQuestion() {
        launch(Self.fixture + ["--ui-question-while-reading"])
        let thread = row("iphone")
        reveal(thread)
        XCTAssertTrue(thread.label.contains("Refine the iPhone thread view"))
        XCTAssertFalse(app.buttons["Send answer"].exists, "The Threads page answers nothing in place")
        XCTAssertFalse(app.buttons["Ctrl+J"].exists, "A Needs you row shows no choices")
        capture("threads-list-needs-you")
        thread.tap()
        XCTAssertTrue(app.buttons["request-send-answer"].waitForExistence(timeout: 5), "The row opens its thread on the question")
        XCTAssertTrue(app.buttons["request-option-j"].exists)
    }

    // MARK: Watcher (ADR-0073, amended October 11, 2026)

    private static let watcher = fixture + ["--ui-watcher"]

    /// Opens the Watcher tab, which only a computer that runs Watcher gives this iPhone.
    @discardableResult private func openWatcher() -> XCUIElement {
        let tab = app.tab("Watcher")
        XCTAssertTrue(tab.waitForExistence(timeout: 10), "A computer that runs Watcher gives it a tab")
        tab.tap()
        XCTAssertTrue(byID("watcher-state").waitForExistence(timeout: 10), "Watcher's page opens with its state")
        return tab
    }
    /// Something shared to Sotto opens the Watcher tab with its file in the box and its link in the field (ADR-0157).
    func testASharedFileAndLinkLandInWatchersBox() {
        launch(Self.watcher + ["--ui-files", "--ui-shared"], opensOnThreads: false)
        XCTAssertTrue(byID("watcher-state").waitForExistence(timeout: 15), "A share opens the Watcher tab")
        XCTAssertTrue(text("Quarterly report.pdf").waitForExistence(timeout: 10), "The shared PDF waits in Watcher's box")
        XCTAssertTrue(byID("watcher-reply").waitForValue("https://example.com/release-notes"), "The shared link is in the field")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The caret is in the field, ready for words")
        capture("watcher-shared")
    }
    /// Where every drag on Watcher's page runs: down its leading margin, clear of bubbles, cards and rows. Not the trailing
    /// margin, where iOS draws the page's scroll indicator: a touch that lands on the indicator while it shows takes hold
    /// of it and scrubs the page. On CI's Pro Max, every third drag up Watched met the indicator on its way down the track
    /// and threw the page back to its top, so Stop watching never came within reach in forty drags.
    private let watcherDragX: CGFloat = 8
    /// Puts the keyboard away the way Watcher's conversation lets it go, as a thread's does: a drag that starts in the
    /// conversation and carries on down into the keyboard, which follows it off the screen. A swipe that ends above the
    /// keyboard leaves it up, which is how the journey's first swipe failed on CI.
    private func dismissKeyboard() {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        let x = watcherDragX
        for _ in 0..<3 where keyboard.exists {
            let band = watcherBand
            let from = origin.withOffset(CGVector(dx: x, dy: (band.top + band.bottom) / 2 - window.frame.minY))
            let to = origin.withOffset(CGVector(dx: x, dy: window.frame.height - 24))
            from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .default, thenHoldForDuration: 0)
            if keyboard.waitForNonExistence(timeout: 5) { break }
        }
        XCTAssertTrue(waitUntilGone(keyboard), "Dragging the conversation down into the keyboard puts it away")
    }
    /// Turns this iPhone to light in Settings and comes back to the Watcher tab.
    private func watcherInLight() {
        app.tab("Settings").tap()
        let light = app.buttons["setting-light"]
        XCTAssertTrue(light.waitForExistence(timeout: 5))
        reveal(light, swipingDown: true)
        light.tap()
        XCTAssertEqual(light.value as? String, "Selected")
        openWatcher()
    }
    /// Every element in the app from one reading of its hierarchy, parents before their children. Frames read from it
    /// all come from the same instant, and the reading is one query however many elements the caller looks at.
    private func everyElement() throws -> [any XCUIElementSnapshot] {
        var elements: [any XCUIElementSnapshot] = []
        func collect(_ parent: any XCUIElementSnapshot) {
            for child in parent.children {
                elements.append(child)
                collect(child)
            }
        }
        collect(try app.snapshot())
        return elements
    }
    /// The part of Watcher's conversation a press reaches: below its pinned glass bar and above its reply box, with
    /// anything the box carries over it. XCTest calls a row under the bar hittable, but a press there lands on the bar
    /// (on CI it opened Watched instead of a card's Review question).
    private var watcherBand: (top: CGFloat, bottom: CGFloat) {
        // Read the whole hierarchy once. Separate queries for every present and absent dock element repeatedly ask
        // XCTest to walk the same accessibility tree; on CI those queries grew until an absent held line timed out.
        let elements: [any XCUIElementSnapshot]
        do {
            elements = try everyElement()
        } catch {
            XCTFail("Watcher's visible bounds must provide a snapshot: \(error)")
            return (.infinity, -.infinity)
        }
        guard let band = watcherBand(in: elements) else {
            XCTFail("Watcher's visible bounds must include its window")
            return (.infinity, -.infinity)
        }
        return band
    }
    /// The band from one reading of the hierarchy (`everyElement`), or nil without the app's window.
    private func watcherBand(in elements: [any XCUIElementSnapshot]) -> (top: CGFloat, bottom: CGFloat)? {
        func element(_ identifier: String, type: XCUIElement.ElementType = .any) -> (any XCUIElementSnapshot)? {
            // Like matching(identifier:), keep the first descendant of the requested type whose identifying
            // attributes match. All of these attributes belong to the captured snapshot, with no further UI query.
            elements.first {
                (type == .any || $0.elementType == type) &&
                ($0.identifier == identifier || $0.title == identifier || $0.label == identifier ||
                 ($0.value as? String) == identifier || $0.placeholderValue == identifier)
            }
        }
        guard let window = elements.first(where: { $0.elementType == .window }) else { return nil }
        let header = element("watcher-section-conversation")
        // The bar's glass ends the switch's own padding and the bar's bottom padding below Conversation | Watched. While
        // the bar is away (#1278), the page shows from under the status bar's glass, which no iPhone draws taller than 60
        // points.
        let top = max(header?.frame.maxY ?? window.frame.minY, window.frame.minY + 44) + 16
        let tabs = elements.first { $0.identifier == "tab-threads" }
        var bottom = tabs?.frame.minY ?? window.frame.maxY
        // The box's glass starts above its text; a held line or a message sits above the box, and on Watched, what a
        // Stop watching press did sits over the tab bar. Watcher's permissions are in the hero, which scrolls (#1276).
        let dock: [((any XCUIElementSnapshot)?, CGFloat)] = [(element("watcher-reply"), 20), (element("watcher-send-held"), 8),
                                                             (element("Dismiss message", type: .button), 8),
                                                             (element("watch-toast"), 8)]
        // Presence and frame come from the same instant, including a toast that may leave between separate queries.
        for (element, gap) in dock {
            if let element { bottom = min(bottom, element.frame.minY - gap) }
        }
        return (top, bottom)
    }
    /// One slow drag of Watcher's page down its leading margin (`watcherDragX`): `down` reads down the page, toward its
    /// end, by dragging it up. Slow, and held at its end, so the page moves no farther than the finger.
    private func dragWatcher(down: Bool, by distance: CGFloat = 160) {
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        let band = watcherBand
        let middle = (band.top + band.bottom) / 2 - window.frame.minY
        let direction: CGFloat = down ? -1 : 1
        let start = origin.withOffset(CGVector(dx: watcherDragX, dy: middle - direction * distance / 2))
        let end = origin.withOffset(CGVector(dx: watcherDragX, dy: middle + direction * distance / 2))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.15)
    }
    /// Waits for Watcher's bar to be in its place, `away` or not: away, Conversation | Watched has slid up past the top of
    /// the screen, where VoiceOver no longer finds it; back, it sits whole below the status bar where it can be pressed.
    private func waitForWatcherBar(away: Bool, _ message: String) {
        let window = app.windows.firstMatch.frame
        var seen = "no look found the bar"
        // One snapshot per look, so the frame and whether the bar is there come from the same instant: on CI's slower
        // phone, separate queries took long enough that a bar already back read as not yet in its place.
        let placed = NSPredicate { [app] _, _ in
            guard let snapshot = try? app.snapshot() else { seen = "no snapshot of the page"; return false }
            var stack: [any XCUIElementSnapshot] = [snapshot]
            var conversation: (any XCUIElementSnapshot)?
            while let next = stack.popLast(), conversation == nil {
                if next.identifier == "watcher-section-conversation" { conversation = next } else { stack.append(contentsOf: next.children) }
            }
            guard let conversation else { seen = "Conversation is missing"; return away }
            let frame = conversation.frame
            seen = "Conversation \(frame)"
            return away ? frame.maxY <= window.minY + 1
                : frame.minY >= window.minY + 20 && frame.maxY <= window.maxY && conversation.isEnabled
        }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: placed, object: nil)], timeout: 30)
        if result != .completed { explain(away ? "watcher-bar-not-away" : "watcher-bar-not-back", seen) }
        XCTAssertEqual(result, .completed, message + " (" + seen + ")")
    }
    /// Drags Watcher's page as `dragWatcher` does, which slides the bar `away` or brings it back, and checks the page under
    /// the bar moves with the finger and by nothing else, during the slide or after it. `marker` picks an element on the
    /// page. Its top is read before the drag and then, from one snapshot per look, until the bar is in its place and two
    /// looks in a row agree. Every look after the drag must find it moved by the drag's distance, less no more than the
    /// touch's slop before the page starts to follow, and none may differ from another: a page that jumped as the bar
    /// went or came, by the bar's height or any part of it, fails either way, whether the jump is still running when the
    /// drag ends or long over.
    private func dragWatcherKeepingThePage(down: Bool, by distance: CGFloat, away: Bool, marker: String,
                                           _ matches: @escaping (any XCUIElementSnapshot) -> Bool, _ message: String) {
        // The touch moves this far before the page follows it.
        let slop: CGFloat = 30
        func look() -> (bar: CGRect?, top: CGFloat, marker: CGFloat?)? {
            guard let elements = try? everyElement(),
                  let window = elements.first(where: { $0.elementType == .window }) else { return nil }
            let bar = elements.first { $0.elementType == .button && $0.identifier == "watcher-section-conversation" }
            return (bar?.frame, window.frame.minY, elements.first(where: matches)?.frame.minY)
        }
        guard let start = look()?.marker else {
            XCTFail("\(marker) must be on Watcher's page before the drag")
            return
        }
        dragWatcher(down: down, by: distance)
        var seen: [CGFloat] = []
        var placedLooks = 0
        var last = "no look after the drag"
        let settled = NSPredicate { _, _ in
            guard let now = look(), let top = now.marker else { last = "\(marker) is missing"; return false }
            seen.append(top)
            let placed = away ? (now.bar.map { $0.maxY <= now.top + 1 } ?? true) : (now.bar.map { $0.minY >= now.top + 20 } ?? false)
            last = "bar \(now.bar.map { "\($0)" } ?? "missing"), \(marker) at \(top)"
            placedLooks = placed ? placedLooks + 1 : 0
            return placedLooks >= 2 && seen.count >= 2 && abs(seen[seen.count - 1] - seen[seen.count - 2]) <= 0.5
        }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: nil)], timeout: 30)
        let moved = seen.map { (down ? start - $0 : $0 - start) }
        let frames = "\(marker) at \(start) before the drag of \(distance), then \(seen); \(last)"
        if result != .completed || moved.contains(where: { $0 < distance - slop || $0 > distance + 2 })
            || (seen.max() ?? 0) - (seen.min() ?? 0) > 1 {
            explain(away ? "watcher-bar-away-page-moved" : "watcher-bar-back-page-moved", frames)
        }
        XCTAssertEqual(result, .completed, message + ": the bar must settle in its place (" + frames + ")")
        XCTAssertFalse(moved.contains { $0 < distance - slop || $0 > distance + 2 },
                       message + ": the page moves with the finger and no farther (" + frames + ")")
        XCTAssertLessThanOrEqual((seen.max() ?? 0) - (seen.min() ?? 0), 1,
                                 message + ": nothing moves the page once the finger lifts (" + frames + ")")
        waitForWatcherBar(away: away, message)
    }
    /// Brings Watcher's bar back if reading down the page slid it away: a short drag back up the page.
    private func showWatcherBar() {
        let conversation = app.buttons["watcher-section-conversation"]
        let top = app.windows.firstMatch.frame.minY
        if conversation.exists, conversation.frame.minY >= top + 20 { return }
        dragWatcher(down: false, by: 80)
        waitForWatcherBar(away: false, "Going back up the page brings the bar back")
    }
    /// Presses the bar's owl, and waits for the hero at the top of Watcher's page to bring Watcher's state into view.
    @discardableResult private func toWatcherHero() -> XCUIElement {
        let owl = app.buttons["watcher-to-top"]
        XCTAssertTrue(owl.waitForExistence(timeout: 5), "The bar carries the owl")
        showWatcherBar()
        let state = byID("watcher-state")
        // The bar and the box don't move; where the band begins and ends is read once.
        let band = watcherBand
        var seen = "no look found Watcher's state"
        let shown = NSPredicate { _, _ in
            guard state.exists else { seen = "Watcher's state is missing"; return false }
            let frame = state.frame
            seen = "state \(frame), between \(band.top) and \(band.bottom)"
            return frame.minY >= band.top && frame.maxY <= band.bottom && state.isHittable
        }
        // Going to the top again does nothing more, so a dropped press is simply pressed again.
        let result = press(owl, until: shown)
        if result != .completed { explain("watcher-hero-state-not-shown", seen) }
        XCTAssertEqual(result, .completed, "The owl brings Watcher's state into view (\(seen))")
        return state
    }
    /// Watcher's permissions, the shield in its box's row where its computer offers no more from here.
    private func watcherShield() -> XCUIElement {
        let shield = app.buttons["watcher-permissions"]
        XCTAssertTrue(shield.waitForExistence(timeout: 10), "Watcher's box carries its permissions")
        return shield
    }
    /// Scrolls Watcher's conversation until `target` sits whole in `watcherBand`, or for one taller than the band, until
    /// its top does. Each drag runs down the page's leading margin (`watcherDragX`), clear of cards, rows and the scroll
    /// indicator, and moves the page no farther than the target needs, so it settles rather than passing back and forth.
    private func revealInWatcher(_ target: XCUIElement) {
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        var down = true
        var steps: [String] = []
        var settling = 0
        func placed(_ frame: CGRect, _ band: (top: CGFloat, bottom: CGFloat)) -> Bool {
            if frame.height <= band.bottom - band.top { return frame.minY >= band.top && frame.maxY <= band.bottom }
            return frame.minY >= band.top && frame.minY <= band.bottom - 60
        }
        for attempt in 0..<40 {
            let band = watcherBand
            guard band.bottom - band.top > 60 else { steps.append("No room to drag: \(band.top) to \(band.bottom)"); break }
            var needed: CGFloat = 120
            if target.exists {
                let frame = target.frame
                if placed(frame, band) {
                    if target.isHittable { return }
                    // A page still settling after a drag can't be pressed yet; give it a moment, a few times at most.
                    steps.append("\(attempt): target \(frame) is in place but can't be pressed yet")
                    settling += 1
                    if settling > 3 { break }
                    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in target.isHittable }, object: nil)
                    _ = XCTWaiter.wait(for: [ready], timeout: 2)
                    continue
                }
                if !frame.isEmpty {
                    let fits = frame.height <= band.bottom - band.top
                    if frame.minY < band.top { down = true; needed = band.top - frame.minY }
                    else { down = false; needed = fits ? frame.maxY - band.bottom : frame.minY - (band.bottom - 60) }
                }
                steps.append("\(attempt): target \(frame), between \(band.top) and \(band.bottom), down \(down)")
            } else {
                steps.append("\(attempt): target not materialized, between \(band.top) and \(band.bottom), down \(down)")
            }
            let distance = min(220, (band.bottom - band.top) * 0.45, max(needed + 16, 40))
            let direction: CGFloat = down ? 1 : -1
            let x = watcherDragX
            let middle = (band.top + band.bottom) / 2 - window.frame.minY
            let start = origin.withOffset(CGVector(dx: x, dy: middle - direction * distance / 2))
            let end = origin.withOffset(CGVector(dx: x, dy: middle + direction * distance / 2))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.15)
        }
        let reached = target.exists && target.isHittable && placed(target.frame, watcherBand)
        if reached { return }
        explain("unreachable-in-watcher", steps.joined(separator: "\n"))
        XCTAssertTrue(reached, "Scrolling Watcher's conversation must bring it clear of the header and the reply box")
    }

    /// The Watcher tab sits between Threads and Computers, with a dot while Watcher works that VoiceOver reads; its page
    /// shows Watcher's model and computer, its conversation and one card of what it did for each reply. A message the
    /// user writes goes to Watcher and its answer arrives under it.
    /// Words selected in a reply offer Add to prompt, which quotes them after what the box already holds, in the
    /// desktop's words, and puts the caret in the box (ADR-0129): on Watcher's page and on a thread's.
    func testWordsSelectedInAReplyAreAddedToThePrompt() {
        launch(Self.watcher)
        openWatcher()
        let box = byID("watcher-reply")
        XCTAssertTrue(box.waitForExistence(timeout: 5))
        box.tap()
        box.typeText("Why?")
        dismissKeyboard()
        let words = text("Started it.")
        XCTAssertTrue(words.waitForExistence(timeout: 5))
        revealInWatcher(words)
        words.doubleTap()
        let add = labelled("Add to prompt")
        XCTAssertTrue(add.waitForExistence(timeout: 5), "A selection in Watcher's reply offers Add to prompt")
        capture("reply-quote-menu-watcher")
        add.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The box takes focus")
        let watcherDraft = box.value as? String ?? ""
        XCTAssertTrue(watcherDraft.hasPrefix("Why?\n\nFrom your earlier reply:\n> "), "The quote follows the draft: \(watcherDraft)")
        capture("reply-quote-added-watcher")

        launch(Self.fixture)
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let update = threadText("Still working through the review fixes")
        XCTAssertTrue(update.waitForExistence(timeout: 5))
        update.doubleTap()
        let addHere = labelled("Add to prompt")
        XCTAssertTrue(addHere.waitForExistence(timeout: 5), "A selection in a thread's reply offers Add to prompt")
        addHere.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The reply box takes focus")
        let threadDraft = reply.value as? String ?? ""
        XCTAssertTrue(threadDraft.hasPrefix("From your earlier reply:\n> "), "The quote is the draft: \(threadDraft)")
    }

    func testTheWatcherTabOpensAndTakesAMessage() {
        launch(Self.watcher)
        let labels = app.tabButtons.allElementsBoundByIndex.map(\.label)
        XCTAssertEqual(labels, ["Threads", "Watcher", "Computers", "Settings"], "Watcher's tab sits between Threads and Computers")
        let tab = openWatcher()
        XCTAssertEqual(byID("watcher-state").label, "Watcher, Working")
        XCTAssertTrue(text("Codex · GPT-6.1 Sol on Laptop").exists, "Watcher's model and computer head its page")
        XCTAssertTrue(text("Started it.").waitForExistence(timeout: 5), "Watcher's conversation is on its page")
        let receipt = app.buttons["watcher-receipt-\(laptop)/login"]
        XCTAssertTrue(receipt.exists, "What Watcher did sits under its reply, a row per thread")
        XCTAssertTrue(receipt.label.contains("Started"), "The row says what Watcher did")
        capture("watcher-conversation-dark")

        let reply = byID("watcher-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertEqual(reply.label, "Ask Watcher")
        reply.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "The box opens the keyboard, with its own dictation key")
        reply.typeText("How is the release notes thread doing?")
        let send = app.buttons["watcher-send"]
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(waitUntilGone(keyboard), "Sending puts the keyboard away, as the design does, so the answer has room")
        XCTAssertTrue(text("How is the release notes thread doing?").waitForExistence(timeout: 5), "The message joins the conversation")
        let answer = text("On it.")
        XCTAssertTrue(answer.waitForExistence(timeout: 10), "Watcher's answer arrives under it")
        // The page already had a row for the release notes thread; Watcher's answer carries one more. Counting rows reads
        // the whole of Watcher's long page, not just a first match. On CI's SE the first count took over four seconds and
        // XCTest asked twice more, so a five-second wait ran out within one look and failed with the answer's row on screen
        // in its recording. A deadline that is never reached costs nothing.
        let rows = app.buttons.matching(identifier: "watcher-receipt-\(laptop)/notes845")
        var counted = 0
        let twoRows = NSPredicate { _, _ in
            counted = rows.count
            return counted == 2
        }
        let added = XCTNSPredicateExpectation(predicate: twoRows, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [added], timeout: 30), .completed,
                       "With what it did (\(counted) rows for the release notes thread)")
        // The answer's end is on screen between the header and the box, not left under the card still waiting below.
        // The band is read before the wait and again after it, and the wait reads only the answer. On CI's SE each query
        // can take a second or two: reading the header, tab bar and box inside a ten-second wait left time for one
        // reading, which ran past the deadline, found no answer and failed with the answer on screen.
        func inBand(_ frame: CGRect, _ band: (top: CGFloat, bottom: CGFloat)) -> Bool {
            frame.maxY > band.top && frame.maxY <= band.bottom + 1
        }
        let band = watcherBand
        var seen = "no look found the answer's frame"
        var matches = 0
        let shown = NSPredicate { _, _ in
            guard answer.exists else { seen = "the answer is missing"; matches = 0; return false }
            let frame = answer.frame
            // A look that lost the answer between its two reads gets no frame; keep the last frame a look did read, which
            // is what a failure needs to say. Writing the empty one over it once hid an answer left under the box.
            guard !frame.isEmpty else { matches = 0; return false }
            seen = "answer \(frame), between \(band.top) and \(band.bottom)"
            matches = inBand(frame, band) ? matches + 1 : 0
            return matches >= 2
        }
        let inView = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: shown, object: nil)], timeout: 60)
        if inView != .completed { explain("watcher-answer-not-in-view", seen) }
        XCTAssertEqual(inView, .completed, "Watcher's answer comes into view above the box (\(seen))")
        let settled = watcherBand, rest = answer.frame
        XCTAssertTrue(inBand(rest, settled),
                      "Watcher's answer stays in view above the box (answer \(rest), between \(settled.top) and \(settled.bottom))")
        capture("watcher-sent-dark")
        // The keyboard can also be put away without sending, by dragging the conversation down into it.
        reply.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "The box opens the keyboard again")
        dismissKeyboard()
        watcherInLight()
        XCTAssertTrue(answer.waitForExistence(timeout: 5))
        revealInWatcher(answer)
        capture("watcher-sent-light")
        // Last, so the rest of the journey reports first if the tab bar doesn't carry it.
        let working = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Working"), object: tab)
        XCTAssertEqual(XCTWaiter.wait(for: [working], timeout: 10), .completed, "VoiceOver hears the working dot as Working")
    }

    /// Watcher's name, state and computer head its page and scroll away with the conversation, as a thread's title does
    /// (#1275, Zach's pick A). The slim bar stays, with Conversation | Watched, which still switches, and its owl, which
    /// carries Watcher's state, brings the hero back.
    func testWatchersHeroScrollsAwayUnderItsSlimBar() {
        launch(Self.watcher)
        openWatcher()
        let owl = app.buttons["watcher-to-top"]
        XCTAssertTrue(owl.waitForExistence(timeout: 5), "The bar carries the owl")
        XCTAssertEqual(owl.label, "Go to the top, where Watcher’s state is")
        XCTAssertEqual(owl.value as? String, "Working", "The owl says Watcher's state once the hero has scrolled off")
        let conversation = app.buttons["watcher-section-conversation"]
        let watched = app.buttons["watcher-section-watched"]
        XCTAssertTrue(conversation.isHittable && watched.isHittable, "Conversation | Watched sit in the bar")
        let bar = conversation.frame.maxY
        let state = byID("watcher-state")
        // Reading at the conversation's end, the hero has scrolled off under the bar.
        revealInWatcher(app.buttons["watcher-card-review"])
        XCTAssertLessThanOrEqual(state.frame.maxY, bar, "Watcher's state scrolls away with the conversation (\(state.frame), bar at \(bar))")
        XCTAssertEqual(conversation.frame.maxY, bar, accuracy: 1, "The bar stays")
        capture("watcher-hero-away-dark")
        // The switch still works from the bar, and Watched has the hero at its top too.
        watched.tap()
        XCTAssertTrue(byID("watcher-watched-lead").waitForExistence(timeout: 5), "Watched opens from the bar")
        XCTAssertGreaterThanOrEqual(state.frame.minY, bar, "Watched opens at its top, with Watcher's hero")
        XCTAssertTrue(text("Codex · GPT-6.1 Sol on Laptop").isHittable, "With Watcher's model and computer")
        capture("watcher-hero-watched-dark")
        conversation.tap()
        XCTAssertTrue(byID("watcher-reply").waitForExistence(timeout: 5), "Conversation opens from the bar")
        // The owl goes to the top of the conversation, where the hero is. Each look reads Watcher's state and the box from
        // one snapshot. On CI's large iPhone, separate queries for them took up to eleven seconds a look, so twenty seconds
        // held one whole look, and the deadline cut the second one's queries off, which read every frame as zero while the
        // hero sat between the bar and the box.
        var seen = "no look found Watcher's state"
        var matches = 0
        let atTop = NSPredicate { _, _ in
            guard let elements = try? self.everyElement() else { seen = "no snapshot of the page"; matches = 0; return false }
            guard let frame = elements.first(where: { $0.identifier == "watcher-state" })?.frame,
                  let box = elements.first(where: { $0.identifier == "watcher-reply" })?.frame.minY else {
                seen = "Watcher's state or the box is missing"; matches = 0; return false
            }
            seen = "state \(frame), bar at \(bar), the box at \(box)"
            matches = frame.minY >= bar && frame.maxY <= box ? matches + 1 : 0
            return matches >= 2
        }
        owl.tap()
        let shown = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: atTop, object: nil)], timeout: 30)
        if shown != .completed { explain("watcher-hero-not-shown", seen) }
        XCTAssertEqual(shown, .completed, "The owl brings Watcher's hero back into view (\(seen))")
        capture("watcher-hero-dark")
        watcherInLight()
        // Counted again from here, so the hero must be seen in light on two looks of its own.
        matches = 0
        owl.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: atTop, object: nil)], timeout: 30), .completed,
                       "The owl brings Watcher's hero back into view in light (\(seen))")
        capture("watcher-hero-light")
    }

    /// Watcher's bar slides away as the user reads down the conversation, and comes back as they go up, as Safari's does
    /// (#1278, pick A), and so it does on Watched, which measures its own page. The page under it moves with the finger
    /// and by nothing else as the bar goes and comes back, and the box and the tab bar stay. No card waits, as one keeps
    /// the bar (#1288). Ten of the user's follow-ups wait at the conversation's end and Watcher watches six more threads,
    /// so both panes have a page to read down on the largest iPhone too.
    func testWatchersBarSlidesAwayOnTheWayDownAndBackOnTheWayUp() {
        launch(Self.watcher + ["--ui-watcher-nothing-waits", "--ui-watcher-queued-below", "--ui-watcher-many-watched"])
        openWatcher()
        toWatcherHero()
        let reply = byID("watcher-reply")
        let firstWords = "The login test fails about one run in five"
        XCTAssertTrue(text(firstWords).waitForExistence(timeout: 5))
        let first: (any XCUIElementSnapshot) -> Bool = { $0.label.hasPrefix(firstWords) }
        // Reading down the page from its top slides the bar away, and the page moves only with the finger.
        dragWatcherKeepingThePage(down: true, by: 160, away: true, marker: "The first message", first,
                                  "Reading down the conversation slides the bar away")
        XCTAssertTrue(reply.isHittable, "The box stays")
        XCTAssertTrue(app.tab("Watcher").isHittable, "The tab bar stays")
        capture("watcher-bar-away-dark")
        // Going back up a little brings it back, and it works.
        dragWatcherKeepingThePage(down: false, by: 80, away: false, marker: "The first message", first,
                                  "Going back up the conversation brings the bar back")
        capture("watcher-bar-back-dark")
        app.buttons["watcher-section-watched"].tap()
        XCTAssertTrue(byID("watcher-watched-lead").waitForExistence(timeout: 5), "Watched opens from the bar that came back")
        // Watched slides the bar the same way, from its own page.
        let lead: (any XCUIElementSnapshot) -> Bool = { $0.identifier == "watcher-watched-lead" }
        dragWatcherKeepingThePage(down: true, by: 160, away: true, marker: "Watched's lead", lead,
                                  "Reading down Watched slides the bar away")
        XCTAssertTrue(app.tab("Watcher").isHittable, "The tab bar stays on Watched")
        capture("watcher-bar-away-watched-dark")
        dragWatcherKeepingThePage(down: false, by: 80, away: false, marker: "Watched's lead", lead,
                                  "Going back up Watched brings the bar back")
        app.buttons["watcher-section-conversation"].tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 5), "Conversation opens from the bar")
    }

    /// While a card waits on the user in Watcher's conversation, the bar stays where it is however they move the page
    /// (#1288, Zach's call on October 22, 2026): the page keeps a card the reader is on where they left it, and a bar that
    /// slides would move the edge it keeps the card clear of. Once the card is answered and no card waits, reading down
    /// slides the bar away again. Ten of the user's follow-ups wait at the page's end, so there is page enough to read
    /// down once the card has gone.
    func testTheBarStaysWhileACardWaitsAndSlidesOnceItIsAnswered() {
        launch(Self.watcher + ["--ui-watcher-can-answer", "--ui-watcher-queued-below"])
        openWatcher()
        XCTAssertTrue(text("The thread’s own card. Your answer goes to Fix login test, not to Watcher.").waitForExistence(timeout: 5))
        toWatcherHero()
        // Reading down the page, twice, with Fix login test's question waiting, leaves the bar where it is.
        let conversation = app.buttons["watcher-section-conversation"]
        let top = app.windows.firstMatch.frame.minY
        for _ in 0..<2 {
            dragWatcher(down: true)
            _ = XCTWaiter.wait(for: [XCTestExpectation(description: "The page settles")], timeout: 1)
            let shown = conversation.exists && conversation.frame.minY >= top + 20 && conversation.isHittable
            if !shown { explain("watcher-bar-slid-while-a-card-waits", "Conversation \(conversation.frame)") }
            XCTAssertTrue(shown, "With a card waiting, reading down leaves the bar where it is (\(conversation.frame))")
        }
        capture("watcher-bar-stays-card-waits-dark")
        // The question is answered here, and leaves the page.
        let choice = app.buttons["A fresh account for each run"]
        revealInWatcher(choice)
        choice.tap()
        XCTAssertTrue(choice.isSelected, "The chosen answer is marked")
        let send = app.buttons["watcher-card-send"]
        revealInWatcher(send)
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(labelled("Answer sent.").waitForExistence(timeout: 10), "The answer reached its thread")
        XCTAssertTrue(waitUntilGone(send), "The card leaves Watcher's page once answered")
        // With no card waiting, reading down from the top slides the bar away.
        toWatcherHero()
        dragWatcher(down: true)
        waitForWatcherBar(away: true, "With no card waiting, reading down slides the bar away")
        capture("watcher-bar-away-card-answered-dark")
    }

    /// Whether a line over a thread's reply box says it is watched, as one did until October 31, 2026, in any wording.
    private func watchedLineShows() -> Bool {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Watched by Watcher.")).firstMatch.exists
    }

    /// A row in what Watcher did opens its thread, with the provider's logo and the owl under its title and Watch on,
    /// and no line over its reply box: the lit owl says the thread is watched (ADR-0073, October 31 amendment).
    func testAReceiptRowOpensItsThread() {
        launch(Self.watcher)
        for appearance in ["dark", "light"] {
            if appearance == "light" { watcherInLight() } else { openWatcher() }
            let row = app.buttons["watcher-receipt-\(laptop)/notes845"]
            revealInWatcher(row)
            XCTAssertTrue(row.label.contains("watched by Watcher"), "The row says Watcher works with the thread")
            row.tap()
            let title = byID("thread-title")
            XCTAssertTrue(title.waitForExistence(timeout: 10), "The row opens its thread")
            XCTAssertEqual(title.label, "Babysit #845 release notes")
            XCTAssertTrue(text("Codex on Laptop · Sotto, watched by Watcher").exists, "The owl follows the provider's logo")
            XCTAssertEqual(app.buttons["thread-watch"].value as? String, "On", "Its Watch is on")
            XCTAssertFalse(watchedLineShows(), "Nothing over the reply box says what the lit owl says")
            capture("watcher-receipt-thread-" + appearance)
            back()
            XCTAssertTrue(byID("watcher-state").waitForExistence(timeout: 10), "Back returns to Watcher's page")
        }
    }

    /// Pulls Watcher's conversation down from just under its header, far and slowly enough for iOS to refresh it, and holds
    /// it there a moment. On CI a quick 200-point swipe at the conversation's start only bounced the page, short of where
    /// iOS starts a refresh: no refresh showed in the recording, and the page was never read again.
    private func pullWatcherToRefresh(_ band: (top: CGFloat, bottom: CGFloat)) {
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        // Down the leading margin, clear of bubbles, cards and the scroll indicator, which sits at the top of the trailing
        // margin at the conversation's start, from under the header to near the screen's foot.
        let x = watcherDragX
        let from = origin.withOffset(CGVector(dx: x, dy: band.top + 8 - window.frame.minY))
        let to = origin.withOffset(CGVector(dx: x, dy: window.frame.height - 40))
        from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.6)
    }

    /// Watcher's new words leave a reader of earlier messages where they are, and are there when the reader comes back to
    /// the newest words. The page follows them only for a reader who sees the newest words or the page's end, and never
    /// while the user moves it (ADR-0051). Here a pull to refresh at the conversation's start reads the page again, and the
    /// fixture's Watcher says something new at its end.
    func testWatchersNewWordsLeaveAReaderOfEarlierMessagesWhereTheyAre() {
        launch(Self.watcher + ["--ui-watcher-refresh-news"])
        openWatcher()
        let first = text("The login test fails about one run in five")
        XCTAssertTrue(first.waitForExistence(timeout: 5), "Watcher's conversation starts with the user's first message")
        // The header and the box don't move here; where the band begins and ends is read once.
        let band = watcherBand
        // The scroll view that holds Watcher's conversation, whatever else is on screen.
        let conversation = app.scrollViews.containing(NSPredicate(format: "label BEGINSWITH %@", "The login test fails")).firstMatch
        for _ in 0..<8 where first.frame.minY < band.top { conversation.swipeDown(velocity: .fast) }
        XCTAssertGreaterThanOrEqual(first.frame.minY, band.top, "The conversation's start is in view")
        // A pull past the start reads Watcher's page again. A pull iOS doesn't take for a refresh is tried again.
        let news = text("Nothing new needs you.")
        for _ in 0..<3 where !news.exists {
            pullWatcherToRefresh(band)
            _ = news.waitForExistence(timeout: 10)
        }
        if !news.exists { explain("watcher-refresh-not-read", "first message \(first.frame), band \(band.top) to \(band.bottom)") }
        XCTAssertTrue(news.exists, "Pulling down read the page again, and Watcher said something new at its end")
        // A scroll that shouldn't happen is given time to happen; then the reader is still where they were.
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "The page settles")], timeout: 2)
        let frame = first.frame
        if !(frame.minY >= band.top - 1 && frame.minY < band.bottom) {
            explain("watcher-reader-moved", "first message \(frame), between \(band.top) and \(band.bottom)")
        }
        XCTAssertTrue(frame.minY >= band.top - 1 && frame.minY < band.bottom,
                      "Watcher's new words leave the reader at the conversation's start (first message \(frame), between \(band.top) and \(band.bottom))")
        capture("watcher-reading-earlier-dark")
        // The reader comes back down when they choose to, and Watcher's new words are there, above the box.
        revealInWatcher(news)
        let shown = news.frame
        XCTAssertTrue(shown.minY >= band.top - 1 && shown.maxY <= band.bottom + 1,
                      "Back at the newest words, Watcher's new words are in view (\(shown), between \(band.top) and \(band.bottom))")
        capture("watcher-back-at-newest-dark")
    }

    /// A worker's own question sits in Watcher's page and is answered there, as the user's own answer to that thread.
    func testAWorkersCardIsAnsweredInWatchersPage() {
        launch(Self.watcher + ["--ui-watcher-can-answer"])
        openWatcher()
        XCTAssertTrue(text("The thread’s own card. Your answer goes to Fix login test, not to Watcher.").waitForExistence(timeout: 5))
        let choice = app.buttons["A fresh account for each run"]
        revealInWatcher(choice)
        capture("watcher-card-dark")
        choice.tap()
        XCTAssertTrue(choice.isSelected, "The chosen answer is marked")
        let send = app.buttons["watcher-card-send"]
        revealInWatcher(send)
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(labelled("Answer sent.").waitForExistence(timeout: 10), "The answer reached its thread")
        XCTAssertTrue(waitUntilGone(send), "The card leaves Watcher's page once answered")
        capture("watcher-card-answered-dark")
        launch(Self.watcher + ["--ui-watcher-can-answer", "--ui-light"])
        openWatcher()
        revealInWatcher(app.buttons["A fresh account for each run"])
        capture("watcher-card-light")
    }

    /// The first words of the reply the fixture's Watcher goes on writing (`--ui-watcher-keeps-writing`).
    private static let writingStart = "Checking the threads I watch."
    /// A worker's question that arrives while Watcher writes stays where the reader scrolls to it: Watcher's words go on
    /// growing above it and never push it under the box, so it is answered there. Once it is answered, the page follows
    /// Watcher's words again (#1277).
    func testAWaitingCardStaysAboveTheBoxWhileWatcherKeepsWriting() {
        launch(Self.watcher + ["--ui-watcher-can-answer", "--ui-watcher-keeps-writing"])
        openWatcher()
        let writing = text(Self.writingStart)
        XCTAssertTrue(writing.waitForExistence(timeout: 10), "Watcher is writing")
        XCTAssertTrue(text("The thread’s own card. Your answer goes to Fix login test, not to Watcher.").waitForExistence(timeout: 15),
                      "Fix login test's question arrives while Watcher writes")
        let choice = app.buttons["A fresh account for each run"]
        revealInWatcher(choice)
        // Watcher goes on writing above the card while the reader is on it.
        let before = writing.label
        let grew = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in writing.exists && writing.label != before }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [grew], timeout: 20), .completed, "Watcher's reply grows while the reader is on the card")
        stays(choice, "The card's answer")
        // More words come, and the card is still where the reader left it.
        let later = writing.label
        let more = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in writing.exists && writing.label != later }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [more], timeout: 20), .completed, "Watcher keeps writing")
        stays(choice, "The card's answer")
        capture("watcher-card-held-dark")
        choice.tap()
        XCTAssertTrue(choice.isSelected, "The chosen answer is marked")
        // Send answer sits at the card's foot; the card is kept whole above the box without the reader scrolling to it.
        let send = app.buttons["watcher-card-send"]
        stays(send, "Send answer")
        XCTAssertTrue(send.isEnabled)
        send.tap()
        XCTAssertTrue(labelled("Answer sent.").waitForExistence(timeout: 10), "The answer reached its thread")
        XCTAssertTrue(waitUntilGone(send), "The card leaves Watcher's page once answered")
        // With the card answered, the page follows Watcher's words again: the end of its reply comes into view above the box.
        // Each look reads the band again: Answer sent. stays a few seconds over the page, and the band ends above it. The
        // band and the reply come from one reading of the hierarchy, the same instant, and the reply is found by its first
        // words in that reading: queries of their own for a reply growing a line twice a second took a look a second on
        // CI, and the wait cut the last one off before it could say where the reply was.
        var seen = "no look found the reply's frame"
        let following = NSPredicate { _, _ in
            let elements: [any XCUIElementSnapshot]
            // A reading the wait cuts off leaves the last look's report standing.
            do { elements = try self.everyElement() } catch { return false }
            guard let band = self.watcherBand(in: elements) else { seen = "no window"; return false }
            guard let reply = elements.first(where: { $0.label.hasPrefix(Self.writingStart) }) else {
                seen = "the reply is missing"; return false
            }
            let frame = reply.frame
            guard !frame.isEmpty else { return false }
            seen = "reply \(frame), between \(band.top) and \(band.bottom)"
            return frame.maxY > band.top && frame.maxY <= band.bottom + 1
        }
        let followed = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: following, object: nil)], timeout: 20)
        if followed != .completed { explain("watcher-not-following-after-answer", seen) }
        XCTAssertEqual(followed, .completed, "Once the card is answered, Watcher's new words are followed again (\(seen))")
        capture("watcher-card-answered-following-dark")
    }

    /// With two cards waiting, a reader on the whole one is kept on it while Watcher writes, not moved to the lower one the
    /// box cuts off, and the lower one leaving, answered on the laptop, leaves the whole one where the reader has it
    /// (#1277). The journey has the laptop answer only once the reader is held on the question with the permission still
    /// under it, and the permission leaves with no change to Watcher's conversation, so only the page's height moves.
    func testAWholeCardStaysAnswerableOverALowerOneWhileWatcherWrites() {
        launch(Self.watcher + ["--ui-watcher-can-answer", "--ui-watcher-keeps-writing", "--ui-watcher-two-cards"])
        openWatcher()
        let writing = text("Checking the threads I watch.")
        XCTAssertTrue(writing.waitForExistence(timeout: 10), "Watcher is writing")
        let permission = byID("watcher-card-notes845")
        XCTAssertTrue(permission.waitForExistence(timeout: 15), "Babysit #845 release notes's permission arrives while Watcher writes")
        // The question from its title to its answers, with the permission under it.
        revealInWatcher(byID("watcher-card-login"))
        let choice = app.buttons["A fresh account for each run"]
        revealInWatcher(choice)
        let before = writing.label
        let grew = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in writing.exists && writing.label != before }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [grew], timeout: 20), .completed, "Watcher's reply grows while the reader is on the question")
        stays(choice, "The question's answer")
        XCTAssertTrue(permission.exists, "The permission is still under the question the reader is held on")
        // The permission is answered on the laptop and leaves the page. The question doesn't move with the page's end.
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName("app.sotto.ui.watcher-notes-answered" as CFString), nil, nil, true)
        XCTAssertTrue(waitUntilGone(permission), "The permission leaves Watcher's page once the laptop answers it")
        stays(choice, "The question's answer, once the permission under it has gone,")
        capture("watcher-two-cards-held-dark")
        choice.tap()
        XCTAssertTrue(choice.isSelected, "The chosen answer is marked")
        let send = app.buttons["watcher-card-send"]
        stays(send, "Send answer")
        send.tap()
        XCTAssertTrue(labelled("Answer sent.").waitForExistence(timeout: 10), "The answer reached its thread")
    }

    /// Waits for `element` to sit whole above Watcher's box and be pressable, two looks in a row, so a page passing through
    /// on its way under the box doesn't count. The band is read before the wait and the wait reads only the element and the
    /// box: on CI's SE each query can take a second or two.
    private func stays(_ element: XCUIElement, _ what: String) {
        let reply = byID("watcher-reply")
        let band = watcherBand
        var seen = "no look found \(what)"
        var matches = 0
        let placed = NSPredicate { _, _ in
            guard element.exists else { seen = "\(what) is missing"; matches = 0; return false }
            let frame = element.frame
            guard !frame.isEmpty else { matches = 0; return false }
            seen = "\(what) \(frame), between \(band.top) and \(band.bottom), the box at \(reply.frame.minY)"
            let inPlace = frame.minY >= band.top && frame.maxY <= band.bottom && frame.maxY <= reply.frame.minY && element.isHittable
            matches = inPlace ? matches + 1 : 0
            return matches >= 2
        }
        // Two looks in a row; on a loaded runner one look can take ten seconds (#1320).
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: placed, object: nil)], timeout: 30)
        if result != .completed { explain("watcher-card-under-the-box", seen) }
        XCTAssertEqual(result, .completed, "\(what) stays whole above the box while Watcher writes (\(seen))")
    }

    /// Watcher's permissions can only stay asking first from a phone that can't answer on Watcher's computer, and the list
    /// says why.
    func testAPhoneThatCantAnswerCanOnlyKeepWatcherAskingFirst() {
        launch(Self.watcher)
        openWatcher()
        let permissions = watcherShield()
        XCTAssertEqual(permissions.value as? String, "Ask before actions")
        XCTAssertTrue(permissions.isEnabled, "Watcher waits between turns, so its permissions can change")
        permissions.tap()
        XCTAssertTrue(byID("watcher-permissions-asks-only").waitForExistence(timeout: 5), "The list says why")
        XCTAssertEqual(byID("watcher-permissions-asks-only").label, "This iPhone can’t answer on Laptop, so it can only keep Watcher asking first.")
        // The list runs past half the SE's screen, so the sheet is grown to read every mode in it.
        expandSheet()
        for mode in ["auto-accept-edits", "auto", "full-access"] {
            let option = app.buttons["watcher-permission-\(mode)"]
            reveal(option)
            XCTAssertFalse(option.isEnabled, "\(mode) can't be chosen from here")
        }
        let asking = app.buttons["watcher-permission-approval-required"]
        reveal(asking, swipingDown: true)
        XCTAssertTrue(asking.isEnabled)
        XCTAssertTrue(asking.isSelected)
        capture("watcher-permissions-asks-only-dark")
        // Pressing the chosen mode closes the list and changes nothing.
        asking.tap()
        XCTAssertTrue(waitUntilGone(asking))
        XCTAssertEqual(permissions.value as? String, "Ask before actions")
    }

    /// Watched says what watching means, with a card for each watched thread and no count to fill, and Stop all asks
    /// first: cancelling stops nothing, and confirming stops only the threads Watcher started.
    func testStopAllAsksFirst() {
        launch(Self.watcher)
        openWatcher()
        app.buttons["watcher-section-watched"].tap()
        let lead = byID("watcher-watched-lead")
        XCTAssertTrue(lead.waitForExistence(timeout: 5))
        let three = "Watcher keeps these 3 threads going on its own and brings you their questions and permissions. Each stays watched until you stop it."
        XCTAssertEqual(lead.label, three)
        XCTAssertFalse(byID("watcher-meter").exists, "Watching has no limit, so there is no count of how many it may")
        XCTAssertTrue(app.buttons["watched-\(laptop)/login"].exists, "Each watched thread opens from its card")
        XCTAssertTrue(app.buttons["watched-stop-\(laptop)/login"].exists, "And has Stop watching")
        XCTAssertTrue(text("No longer watched").exists)
        capture("watcher-watched-dark")
        let stopAll = app.buttons["watcher-stop-all"]
        revealInWatcher(stopAll)
        stopAll.tap()
        // An alert, named by its question, so its Cancel is always there to press (iOS 26 leaves a confirmation
        // dialog's out).
        let question = app.alerts["Stop the 3 threads Watcher started?"]
        XCTAssertTrue(question.waitForExistence(timeout: 5), "Stop all asks first")
        let confirm = question.buttons["Stop 3 threads"]
        XCTAssertTrue(confirm.exists)
        let named = question.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Add Android share sheet, Claude Code on Studio Mac")).firstMatch
        XCTAssertTrue(named.exists, "The question names each thread it would stop and where it runs")
        capture("watcher-stop-all-dark")
        question.buttons["Cancel"].tap()
        XCTAssertTrue(waitUntilGone(question))
        XCTAssertEqual(lead.label, three, "Cancelling stops nothing")
        stopAll.tap()
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(labelled("Stopped 3 threads Watcher started.").waitForExistence(timeout: 10))
        let none = "Watcher watches no threads yet. Watch one here or from its page, and Watcher keeps it going until you stop it."
        let stopped = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", none), object: lead)
        XCTAssertEqual(XCTWaiter.wait(for: [stopped], timeout: 5), .completed)
        XCTAssertFalse(stopAll.exists, "With nothing watched, there is nothing to stop")
        capture("watcher-stopped-dark")
        watcherInLight()
        app.buttons["watcher-section-watched"].tap()
        XCTAssertTrue(lead.waitForExistence(timeout: 5))
        capture("watcher-stopped-light")
    }

    /// Watcher's permissions are the shield in its box's row where its computer offers no more from here, in this
    /// iPhone's own words (control A, #1276): the shield opens the four modes, a choice shows at once, and until Watcher's
    /// provider confirms it the line over the box says what is still in force.
    func testWatchersPermissionsChangeFromItsBox() {
        launch(Self.watcher + ["--ui-watcher-can-answer"])
        openWatcher()
        let reply = byID("watcher-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let permissions = watcherShield()
        XCTAssertGreaterThanOrEqual(permissions.frame.minY, reply.frame.maxY - 1, "The shield sits under the words, in the box")
        XCTAssertEqual(permissions.label, "Watcher’s permissions")
        XCTAssertEqual(permissions.value as? String, "Ask before actions")
        capture("watcher-permissions-dark")
        permissions.tap()
        XCTAssertTrue(text("What Watcher may do without asking").waitForExistence(timeout: 5))
        let asking = app.buttons["watcher-permission-approval-required"]
        XCTAssertTrue(asking.isSelected, "The mode in force is ticked")
        XCTAssertTrue(asking.label.contains("Asks you before it edits a file or runs a command that changes something."),
                      "Each mode says what Watcher does under it")
        let edits = app.buttons["watcher-permission-auto-accept-edits"]
        reveal(edits)
        XCTAssertTrue(edits.isEnabled, "Where this iPhone can answer, a wider mode can be chosen")
        XCTAssertFalse(byID("watcher-permissions-asks-only").exists)
        capture("watcher-permissions-sheet-dark")
        edits.tap()
        XCTAssertTrue(waitUntilGone(edits), "Choosing closes the list")
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Allow edits"), object: permissions)
        XCTAssertEqual(XCTWaiter.wait(for: [chosen], timeout: 5), .completed, "The shield says the choice at once")
        let inForce = byID("watcher-permissions-in-force")
        XCTAssertTrue(inForce.waitForExistence(timeout: 5), "Until Codex confirms it, the line over the box says what is still in force")
        XCTAssertEqual(inForce.label, "Codex stays on Ask before actions until it confirms.")
        XCTAssertLessThanOrEqual(inForce.frame.maxY, reply.frame.minY, "Over the box")
        capture("watcher-permissions-pending-dark")
        // The fixture's Codex confirms fifteen seconds after the choice. On CI's SE each look for the caption on Watcher's
        // long page took eight seconds or more, so twenty seconds held only three looks, and once ran out with the caption
        // already gone from the screen. A deadline that is never reached costs nothing.
        XCTAssertTrue(waitUntilGone(inForce, timeout: 60), "Once Codex confirms it, nothing more is said")
        XCTAssertEqual(permissions.value as? String, "Allow edits")
        // Writing in the box leaves the shield where it is.
        reply.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(permissions.exists, "The shield stays in the box while the box is written in")
        dismissKeyboard()
        watcherInLight()
        capture("watcher-permissions-light")
        watcherShield().tap()
        let picked = app.buttons["watcher-permission-auto-accept-edits"]
        XCTAssertTrue(picked.waitForExistence(timeout: 5))
        reveal(picked)
        XCTAssertTrue(picked.isSelected)
        capture("watcher-permissions-sheet-light")
        // Pressing the chosen mode closes the list and changes nothing.
        picked.tap()
        XCTAssertTrue(waitUntilGone(picked))
        XCTAssertEqual(permissions.value as? String, "Allow edits")
    }

    /// Watcher's box takes a thread box's pill (ADR-0166, amended November 1, 2026): Watcher's model and effort on it, and
    /// one menu holding the models of every provider Watcher runs on, Effort, Speed, Permissions and, last, New Watcher,
    /// which starts one at once, whose empty conversation says so, with the last one's handover offered over the box until
    /// X puts it away.
    func testWatchersBoxChangesItsModelAndStartsANewWatcher() {
        launch(Self.watcher + ["--ui-watcher-box", "--ui-watcher-can-answer", "--ui-watcher-nothing-waits"])
        openWatcher()
        let reply = byID("watcher-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let settings = byID("watcher-settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        XCTAssertEqual(settings.label, "Watcher’s settings")
        XCTAssertTrue((settings.value as? String)?.hasPrefix("GPT-6.1 Sol, High") == true, "The pill says Watcher's model and effort (\(String(describing: settings.value)))")
        XCTAssertGreaterThanOrEqual(settings.frame.minY, reply.frame.maxY - 1, "Under the words, in the box")
        XCTAssertFalse(app.buttons["watcher-permissions"].exists, "Watcher's permissions are in the pill's menu")
        capture("watcher-box-dark")
        // Watcher's effort, from its box.
        let low = menuItem("Low")
        open(settings, then: "Effort", until: low)
        low.tap()
        XCTAssertEqual(waitForValue(settings, containing: "Low"), .completed, "The pill says the choice")
        // The menu lists Claude Code too, and says what its model does.
        let opus = menuItem("Opus 5.5")
        press(settings, until: NSPredicate { _, _ in opus.exists })
        XCTAssertTrue(opus.waitForExistence(timeout: 5), "Another provider Watcher runs on is listed")
        XCTAssertTrue(text("Another provider’s model starts a new Watcher.").exists, "And the menu says what its model does")
        capture("watcher-box-models-dark")
        // The model Watcher is on closes the menu and changes nothing.
        menuItem("GPT-6.1 Sol").tap()
        XCTAssertEqual(waitForValue(settings, containing: "GPT-6.1 Sol"), .completed)
        // New Watcher, the menu's last item: an empty conversation that says so, and the handover offered over the box.
        let new = menuItem("New Watcher")
        press(settings, until: NSPredicate { _, _ in new.exists })
        XCTAssertTrue(new.isEnabled)
        new.tap()
        let note = byID("watcher-new-note")
        XCTAssertTrue(note.waitForExistence(timeout: 10), "The new Watcher's conversation says what happened")
        XCTAssertTrue(note.label.contains("New Watcher on GPT-6.1 Sol."))
        XCTAssertTrue(note.label.contains("The last conversation is in Watcher history on Laptop."))
        let strip = byID("watcher-handover")
        XCTAssertTrue(strip.waitForExistence(timeout: 5))
        XCTAssertTrue(labelled("Sending starts the new Watcher with a handover of the last one.").exists)
        press(settings, until: NSPredicate { _, _ in new.exists })
        XCTAssertFalse(new.isEnabled, "A Watcher that has said nothing has nothing to hand over")
        dismissMenu()
        XCTAssertTrue(waitUntilGone(new), "The menu goes")
        capture("watcher-new-handover-dark")
        app.buttons["watcher-handover-dismiss"].tap()
        XCTAssertTrue(waitUntilGone(strip), "X puts the handover away")
        watcherInLight()
        capture("watcher-new-light")
    }

    /// While Watcher's own turn runs, its box offers Stop where Send was, a solid disc the size of Send, and New Watcher
    /// waits for it.
    func testWatchersOwnTurnStopsFromItsBox() {
        launch(Self.watcher + ["--ui-watcher-box", "--ui-watcher-turn", "--ui-watcher-nothing-waits"])
        openWatcher()
        let stop = app.buttons["watcher-stop"], settings = byID("watcher-settings"), new = menuItem("New Watcher")
        XCTAssertTrue(stop.waitForExistence(timeout: 10), "Watcher's turn runs, so its box offers Stop")
        XCTAssertEqual(stop.label, "Stop Watcher’s turn")
        XCTAssertGreaterThanOrEqual(stop.frame.width, 30, "At least as large as Send")
        XCTAssertFalse(app.buttons["watcher-send"].exists, "With nothing written, Stop stands where Send was")
        press(settings, until: NSPredicate { _, _ in new.exists })
        XCTAssertFalse(new.isEnabled, "New Watcher waits for Watcher's turn")
        dismissMenu()
        XCTAssertTrue(waitUntilGone(new), "The menu goes")
        capture("watcher-turn-stop-dark")
        stop.tap()
        XCTAssertTrue(waitUntilGone(stop), "Stopped, Stop leaves the box")
        XCTAssertTrue(app.buttons["watcher-send"].waitForExistence(timeout: 5), "And Send is back in its place")
        XCTAssertTrue(becomesEnabled(new, in: settings), "New Watcher can start one once the turn has stopped")
    }

    /// A reply in which Watcher changed files itself carries one quiet line under it (mark B): how many, its reason or that
    /// it gave none, and the files on request.
    func testAReplyWhereWatcherChangedFilesItselfSaysSo() {
        launch(Self.watcher)
        openWatcher()
        let line = byID("watcher-own-change")
        XCTAssertTrue(line.waitForExistence(timeout: 5), "The line sits under the reply")
        revealInWatcher(line)
        XCTAssertTrue(line.label.contains("Watcher changed 2 files itself."), "Sotto's own count of what Watcher changed")
        XCTAssertTrue(line.label.contains("Its reason: “A one-word typo in two files is smaller than briefing a thread.”"),
                      "And Watcher's reason, as its claim")
        let files = app.buttons["watcher-own-change-files"]
        revealInWatcher(files)
        XCTAssertEqual(files.label, "Show the 2 files")
        XCTAssertFalse(labelled("docs/guide.md").exists, "The file names wait until asked for")
        capture("watcher-own-change-dark")
        files.tap()
        XCTAssertTrue(labelled("docs/guide.md").waitForExistence(timeout: 5), "The files show on request")
        XCTAssertTrue(labelled("README.md").exists)
        XCTAssertEqual(files.label, "Hide the 2 files")
        revealInWatcher(labelled("docs/guide.md"))
        capture("watcher-own-change-files-dark")
        watcherInLight()
        revealInWatcher(line)
        capture("watcher-own-change-light")
        // A reply that gave no reason says so, in the needs-you ink.
        launch(Self.watcher + ["--ui-watcher-no-reason"])
        openWatcher()
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        revealInWatcher(line)
        XCTAssertTrue(line.label.contains("Watcher changed 2 files itself. It gave no reason."), "Watcher's reply said nothing of it")
        capture("watcher-own-change-no-reason-dark")
    }

    /// Watch on a thread's page watches it at once, with Undo, and the owl follows its logo (watch B). Stop watching on
    /// Watched stops it, and Watch a thread watches it again.
    func testWatchAThreadFromItsPageAndStopWatchingFromWatched() {
        launch(Self.watcher)
        let thread = row("shortcuts")
        reveal(thread)
        thread.tap()
        let title = byID("thread-title")
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertEqual(title.label, "Add keyboard shortcuts")
        let watch = app.buttons["thread-watch"]
        XCTAssertTrue(watch.waitForExistence(timeout: 5), "A thread's page offers Watch where a computer runs Watcher")
        XCTAssertEqual(watch.label, "Watch")
        XCTAssertEqual(watch.value as? String, "Off")
        // XCTest lets an expectation be waited on only once, so each wait for Watch's value makes its own.
        func watchReads(_ value: String) -> XCTWaiter.Result {
            let reads = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: watch)
            return XCTWaiter.wait(for: [reads], timeout: 5)
        }
        watch.tap()
        let toast = byID("watch-toast")
        XCTAssertTrue(toast.waitForExistence(timeout: 5), "What the press did is said at once")
        XCTAssertTrue(text("Watcher is watching Add keyboard shortcuts.").exists)
        XCTAssertEqual(watchReads("On"), .completed, "Watch is on")
        XCTAssertTrue(text("Codex on Laptop · Sotto, watched by Watcher").exists, "The owl follows the provider's logo")
        capture("watch-thread-page-dark")
        // Undo takes it back.
        let undo = app.buttons["watch-undo"]
        XCTAssertEqual(undo.label, "Undo: stop watching Add keyboard shortcuts")
        undo.tap()
        XCTAssertEqual(watchReads("Off"), .completed, "Undo stops watching it")
        XCTAssertTrue(text("Watcher stopped watching Add keyboard shortcuts.").waitForExistence(timeout: 5))
        watch.tap()
        XCTAssertEqual(watchReads("On"), .completed, "Watch watches it again")
        // Once the toast goes, nothing over the reply box takes its place: the lit owl says the thread is watched.
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: toast)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 20), .completed, "The toast goes")
        XCTAssertFalse(watchedLineShows(), "No line says what watching means")
        capture("watch-thread-page-watched-dark")
        back()

        openWatcher()
        app.buttons["watcher-section-watched"].tap()
        let card = app.buttons["watched-\(laptop)/shortcuts"]
        XCTAssertTrue(card.waitForExistence(timeout: 5), "The thread has a card on Watched")
        XCTAssertTrue(card.label.contains("Watching since"), "With how long Watcher has watched it with nothing sent")
        let stop = app.buttons["watched-stop-\(laptop)/shortcuts"]
        revealInWatcher(stop)
        XCTAssertEqual(stop.label, "Stop watching Add keyboard shortcuts")
        capture("watcher-watched-card-dark")
        stop.tap()
        // What a press did is said for eight seconds, so it is read straight after the press: on a loaded simulator the
        // waits that follow it have outlasted it.
        XCTAssertTrue(text("Watcher stopped watching Add keyboard shortcuts.").waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["watch-undo"].waitForExistence(timeout: 8), "With Undo")
        capture("watcher-watched-stopped-dark")
        XCTAssertTrue(waitUntilGone(stop), "Stop watching takes its card off Watched")
        // Watch a thread offers it again.
        let add = app.buttons["watcher-watch-a-thread"]
        revealInWatcher(add)
        add.tap()
        let pick = app.buttons["watch-pick-\(laptop)/shortcuts"]
        XCTAssertTrue(pick.waitForExistence(timeout: 5), "Watch a thread lists the threads Watcher could watch")
        XCTAssertFalse(app.buttons["watch-pick-\(laptop)/login"].exists, "Not one it watches already")
        // Add keyboard shortcuts comes after the release, iPhone and wiring threads, at the half-height sheet's foot on the SE.
        expandSheet()
        reveal(pick)
        XCTAssertEqual(pick.label, "Watch Add keyboard shortcuts")
        capture("watcher-watch-a-thread-dark")
        pick.tap()
        XCTAssertTrue(text("Watcher is watching Add keyboard shortcuts.").waitForExistence(timeout: 8), "What the press did is said at once")
        XCTAssertTrue(waitUntilGone(pick), "Choosing one closes the list")
        XCTAssertTrue(card.waitForExistence(timeout: 5), "And Watcher watches it")
        watcherInLight()
        app.buttons["watcher-section-watched"].tap()
        revealInWatcher(app.buttons["watched-stop-\(laptop)/shortcuts"])
        capture("watcher-watched-card-light")
    }

    /// Settings on this iPhone: the look, alerts off until turned on, another theme, light, compact and larger text.
    func testSettingsThemeAppearanceDensityAndAlerts() {
        launch(Self.fixture)
        app.tab("Settings").tap()
        let dark = app.buttons["setting-dark"]
        XCTAssertTrue(dark.waitForExistence(timeout: 5))
        XCTAssertEqual(dark.value as? String, "Selected", "Dark is the default")
        capture("settings-glow-top")
        // Turning an alert on is when iOS asks, so the journey only reads them.
        for id in ["setting-notify-needs-you", "setting-notify-finished", "setting-notify-failed", "setting-notify-sound"] {
            let toggle = app.switches[id]
            reveal(toggle)
            XCTAssertEqual(toggle.value as? String, "0", "Each alert is off until the user turns it on")
        }
        capture("settings-glow-notifications")

        let fern = app.buttons["setting-theme-fern"]
        reveal(fern, swipingDown: true)
        fern.tap()
        XCTAssertEqual(fern.value as? String, "Selected")
        let sotto = app.buttons["setting-theme-sotto"]
        reveal(sotto, swipingDown: true)
        XCTAssertTrue(sotto.exists, "The other themes stay listed after a new one paints")
        XCTAssertEqual(sotto.value as? String, "Not selected")
        app.tab("Threads").tap()
        XCTAssertTrue(app.textFields["thread-search"].waitForExistence(timeout: 5))
        capture("threads-glow-fern")

        app.tab("Settings").tap()
        let light = app.buttons["setting-light"]
        reveal(light, swipingDown: true)
        light.tap()
        XCTAssertEqual(light.value as? String, "Selected")
        app.tab("Threads").tap()
        XCTAssertTrue(app.textFields["thread-search"].waitForExistence(timeout: 5))
        capture("threads-glow-fern-light")

        app.tab("Settings").tap()
        let compact = app.buttons["setting-density-compact"]
        reveal(compact)
        compact.tap()
        XCTAssertEqual(compact.value as? String, "Selected")
        let larger = app.buttons["setting-larger-text"]
        reveal(larger)
        larger.tap()
        XCTAssertEqual(larger.value as? String, "Selected")
        app.tab("Threads").tap()
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 5))
        XCTAssertTrue(byID("steps-run-drawer-test").waitForExistence(timeout: 5))
        capture("thread-glow-compact-large")
    }

    /// New thread's fields open from anywhere in their box, and New worktree can be chosen.
    /// A thread's model, effort, speed and permissions change from the reply box's settings pill (ADR-0166, amended
    /// November 1, 2026, pick A): the pill shows the model and effort and opens one menu, the models first, then Effort,
    /// Speed and Permissions as submenus; a permission change is marked until the agent confirms it. The row around it is
    /// Claude's: the + and the pill on the left, the mic and Send on the right. While a turn runs the pill is held, as on
    /// the desktop.
    func testAThreadsSettingsChangeFromItsReplyBox() {
        launch(Self.fixture + ["--ui-thread-settings"])
        let thread = row("shortcuts")
        reveal(thread)
        thread.tap()
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let settings = byID("thread-settings"), plus = byID("thread-attach-photos"), mic = byID("dictate"), send = byID("thread-send")
        XCTAssertTrue(settings.waitForExistence(timeout: 5), "The thread's settings are a pill in the reply box's row")
        XCTAssertEqual(settings.label, "Thread settings")
        XCTAssertEqual(settings.value as? String, "GPT-6.1 Sol, High, Standard, Ask before actions")
        XCTAssertGreaterThanOrEqual(settings.frame.minY, reply.frame.maxY - 1, "Under the words, inside the box")
        XCTAssertLessThan(plus.frame.maxX, settings.frame.minX + 1, "The + leads the row, then the pill")
        XCTAssertLessThan(settings.frame.maxX, mic.frame.minX, "The mic is on the right")
        XCTAssertLessThan(mic.frame.maxX, send.frame.minX + 1, "Then Send")
        XCTAssertLessThan(abs(plus.frame.midY - send.frame.midY), 1, "All on one line")
        XCTAssertEqual(mic.label, "Dictate")
        XCTAssertFalse(send.isEnabled, "Send is there with nothing to send, and waits")
        XCTAssertTrue(settings.isEnabled, "An idle thread's settings can be changed")
        capture("thread-settings-dark")

        let astra = menuItem("GPT-6 Astra")
        press(settings, until: NSPredicate { _, _ in astra.exists })
        XCTAssertTrue(astra.waitForExistence(timeout: 5), "The pill opens the thread's own provider's models")
        XCTAssertFalse(menuItem("GPT-6.1 Luna").exists, "A model that isn't ready is left out")
        XCTAssertTrue(menuItem("Effort").exists && menuItem("Speed").exists && menuItem("Permissions").exists, "Then the thread's other settings")
        capture("thread-settings-model-menu-dark")
        astra.tap()
        XCTAssertEqual(waitForValue(settings, containing: "GPT-6 Astra"), .completed, "The pill says the choice at once")

        let low = menuItem("Low")
        open(settings, then: "Effort", until: low)
        XCTAssertFalse(menuItem("Extra high").exists, "Astra offers no Extra high")
        capture("thread-settings-effort-menu-dark")
        low.tap()
        XCTAssertEqual(waitForValue(settings, containing: "Low"), .completed)

        let fast = menuItem("Fast")
        open(settings, then: "Speed", until: fast)
        fast.tap()
        XCTAssertEqual(waitForValue(settings, containing: "Fast"), .completed, "Speed is a choice in the same menu")

        let full = menuItem("Full access")
        open(settings, then: "Permissions", until: full)
        capture("thread-settings-permissions-menu-dark")
        full.tap()
        XCTAssertEqual(waitForValue(settings, containing: "Full access"), .completed, "The pill says the choice at once")
        let inForce = byID("thread-settings-in-force")
        XCTAssertTrue(inForce.waitForExistence(timeout: 5), "Until Codex confirms it, a line says what is still in force")
        XCTAssertEqual(inForce.label, "Codex still asks before acting until it confirms.")
        capture("thread-settings-pending-dark")
        // The fixture's Codex confirms eight seconds after the choice. A deadline that is never reached costs nothing.
        XCTAssertTrue(waitUntilGone(inForce, timeout: 60), "Once Codex confirms it, nothing more is said")
        XCTAssertEqual(waitForValue(settings, containing: "Full access"), .completed)

        // In light, and on the working thread, whose pill waits for its turn to end.
        launch(Self.fixture + ["--ui-thread-settings", "--ui-light"])
        let idle = row("shortcuts")
        reveal(idle)
        idle.tap()
        XCTAssertTrue(byID("thread-settings").waitForExistence(timeout: 5))
        capture("thread-settings-light")
        let medium = menuItem("Medium")
        open(byID("thread-settings"), then: "Effort", until: medium)
        capture("thread-settings-effort-menu-light")
        medium.tap()
        back()
        let working = row("iphone")
        reveal(working)
        working.tap()
        let held = byID("thread-settings")
        XCTAssertTrue(held.waitForExistence(timeout: 5))
        XCTAssertFalse(held.isEnabled, "While the turn runs the agent would refuse a change, so the pill waits")
        capture("thread-settings-working-light")
    }
    /// Opens a settings pill's menu, then its submenu, until `item` shows.
    private func open(_ pill: XCUIElement, then submenu: String, until item: XCUIElement) {
        let entry = menuItem(submenu)
        press(pill, until: NSPredicate { _, _ in entry.exists })
        XCTAssertTrue(entry.waitForExistence(timeout: 5), "The pill's menu offers \(submenu)")
        press(entry, until: NSPredicate { _, _ in item.exists })
        XCTAssertTrue(item.waitForExistence(timeout: 5), "\(submenu) opens its choices")
    }
    /// Puts an open menu away with a press above it, clear of the box.
    private func dismissMenu() {
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
    }
    /// Whether a pill's menu item reads enabled within `timeout`. An open menu keeps the state it opened with, so it is
    /// put away and opened again until the item reads enabled.
    private func becomesEnabled(_ item: XCUIElement, in pill: XCUIElement, timeout: TimeInterval = 20) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        repeat {
            press(pill, until: NSPredicate { _, _ in item.exists })
            if item.exists && item.isEnabled { return true }
            dismissMenu()
            _ = waitUntilGone(item, timeout: 5)
        } while Date() < end
        return false
    }
    /// A menu's item whose words start with these, wherever iOS draws the menu.
    private func menuItem(_ start: String) -> XCUIElement {
        let kinds = [XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.switch.rawValue]
        return app.descendants(matching: .any).matching(NSPredicate(format: "elementType IN %@ AND label BEGINSWITH %@", kinds, start)).firstMatch
    }
    /// Waits for an element to read this value: a chip settling on a choice.
    private func waitForValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 10) -> XCTWaiter.Result {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)], timeout: timeout)
    }
    /// Waits for an element's value to hold these words: a settings pill settling on a choice.
    private func waitForValue(_ element: XCUIElement, containing part: String, timeout: TimeInterval = 10) -> XCTWaiter.Result {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", part), object: element)], timeout: timeout)
    }

    func testNewThreadFieldsOpenFromTheirWholeBox() {
        launch(Self.fixture)
        app.buttons["new-thread"].tap()
        let project = app.buttons["new-thread-project-sotto"]
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        project.tap()
        XCTAssertTrue(app.buttons["open-new-thread"].waitForExistence(timeout: 5))
        let model = app.buttons["new-thread-model"]
        XCTAssertTrue(model.waitForExistence(timeout: 5))
        reveal(model)
        let choice = app.buttons["Codex · GPT-6.1 Sol"]
        XCTAssertFalse(choice.exists, "The model's choices stay closed until the field is pressed")
        // Press the box's trailing inner edge, clear of its words and its chevron.
        let box = model.frame
        model.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: box.width - 6, dy: 0)).tap()
        XCTAssertTrue(choice.waitForExistence(timeout: 5), "Pressing the edge of the Model box opens its choices")
        capture("new-thread-glow-menu")
        choice.tap()
        XCTAssertTrue(waitUntilGone(choice), "Choosing a model closes its choices")

        let copy = app.buttons["new-thread-working-copy"]
        reveal(copy)
        XCTAssertEqual(copy.value as? String, "Project folder")
        copy.tap()
        let worktree = app.buttons["New worktree"]
        XCTAssertTrue(worktree.waitForExistence(timeout: 5))
        worktree.tap()
        let chosen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "New worktree"), object: copy)
        XCTAssertEqual(XCTWaiter.wait(for: [chosen], timeout: 5), .completed, "New worktree becomes the working copy")
        XCTAssertTrue(text("Its own folder on a new branch").exists, "The note under the field says what New worktree does")
        XCTAssertTrue(app.buttons["open-new-thread"].isEnabled)
        capture("new-thread-glow-options")
    }

    /// The app's CPU while a page sits still, three seconds at a time. A page that keeps itself busy spends CPU with nothing
    /// moving; the variants switch off looping animations to show how close Core Animation's loops come to a still page.
    private func idleCPU(_ arguments: [String], openThread: Bool) throws {
        try skipUnlessMeasuring()
        launch(Self.fixture + arguments)
        measureCPUForThreeSeconds(openThread: openThread)
    }
    func testIdleCPUOnThreads() throws { try idleCPU([], openThread: false) }
    func testIdleCPUOnThreadsWithoutLoopingAnimations() throws { try idleCPU(["--ui-still"], openThread: false) }
    func testIdleCPUInAThread() throws { try idleCPU([], openThread: true) }
    func testIdleCPUInAThreadWithoutLoopingAnimations() throws { try idleCPU(["--ui-still"], openThread: true) }
    /// The same still thread with the reply keyboard open and nothing typed: the page must not keep itself busy there either.
    func testIdleCPUInAThreadWithTheKeyboardOpen() throws {
        try skipUnlessMeasuring()
        launch(Self.fixture)
        openWorkingThread()
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        reply.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The reply box opens the keyboard")
        measureCPUForThreeSeconds()
    }

    /// The app's CPU while the working thread streams a message, a word every 50 milliseconds with the thread list sent
    /// again unchanged each time, on Threads and in that thread. The comparison passes --ui-publish-everything, which
    /// publishes every change on the whole model as the app did before its stores.
    private func streamingCPU(_ arguments: [String], openThread: Bool) throws {
        try skipUnlessMeasuring()
        launch(["--ui-fixture", "--reset-ui-preferences", "--ui-streaming"] + arguments)
        measureCPUForThreeSeconds(openThread: openThread)
    }
    func testStreamingCPUOnThreads() throws { try streamingCPU([], openThread: false) }
    func testStreamingCPUOnThreadsPublishingEverything() throws { try streamingCPU(["--ui-publish-everything"], openThread: false) }
    func testStreamingCPUInTheThread() throws { try streamingCPU([], openThread: true) }
    func testStreamingCPUInTheThreadPublishingEverything() throws { try streamingCPU(["--ui-publish-everything"], openThread: true) }

    /// The CPU journeys are timing benchmarks, run by hand:
    /// TEST_RUNNER_SOTTO_IOS_PERF=1 sh apps/ios/Scripts/verify-ui.sh (docs/ci.md).
    private func skipUnlessMeasuring() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["SOTTO_IOS_PERF"] == "1", "CPU is measured by hand")
    }

    /// Opens the working thread, or stays on Threads, and measures the app's CPU over three seconds, three times.
    private func measureCPUForThreeSeconds(openThread: Bool) {
        if openThread {
            openWorkingThread()
        } else {
            XCTAssertTrue(byID("thread-counts").waitForExistence(timeout: 5))
        }
        measureCPUForThreeSeconds()
    }
    private func measureCPUForThreeSeconds() {
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTCPUMetric(application: app)], options: options) {
            Thread.sleep(forTimeInterval: 3)
        }
    }

    private func openWorkingThread() {
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 5))
    }

    /// The app's CPU while a sentence is typed into a thread's reply box, three times. The comparison passes
    /// --ui-publish-everything, which publishes each keystroke on the whole model as the app did before the draft store.
    private func typingCPU(_ arguments: [String]) throws {
        try skipUnlessMeasuring()
        launch(["--ui-fixture", "--reset-ui-preferences"] + arguments)
        openWorkingThread()
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        reply.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The reply box opens the keyboard")
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTCPUMetric(application: app)], options: options) {
            reply.typeText("The tooltips look right now, ship it. ")
        }
    }
    func testTypingCPUInAReply() throws { try typingCPU([]) }
    func testTypingCPUInAReplyPublishingEverything() throws { try typingCPU(["--ui-publish-everything"]) }

    /// Threads and Computers at the top in the Glow look, dark then light.
    func testThreadsAndComputersInTheGlowLook() {
        launch(Self.fixture)
        let working = byID("threads-heading-working")
        XCTAssertTrue(working.exists)
        XCTAssertTrue(working.label.contains("2"), "Working now counts the threads at work")
        XCTAssertFalse(byID("thread-counts").exists, "The sections count their threads; there is no counts line (#1849)")
        XCTAssertTrue(app.buttons["Try reaching Studio Mac again"].exists, "A computer that can't be reached offers Try again")
        XCTAssertFalse(app.tab("Watcher").exists, "A computer that doesn't run Watcher gives it no tab")
        capture("threads-glow-dark")
        app.tab("Computers").tap()
        XCTAssertTrue(app.buttons["Add computer"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Try reaching Studio Mac again"].waitForExistence(timeout: 5))
        capture("computers-glow")
        app.tab("Settings").tap()
        let light = app.buttons["setting-light"]
        XCTAssertTrue(light.waitForExistence(timeout: 5))
        light.tap()
        XCTAssertEqual(light.value as? String, "Selected")
        app.tab("Threads").tap()
        XCTAssertTrue(app.textFields["thread-search"].waitForExistence(timeout: 5))
        capture("threads-glow-light")
        app.tab("Computers").tap()
        XCTAssertTrue(app.buttons["Add computer"].waitForExistence(timeout: 5))
        capture("computers-glow-light")
    }

    func testRecoveryAndNeutralDeliveryFeedbackInBothAppearances() {
        let scenarios = [
            ("request-gone", "That request is no longer waiting."),
            ("markers-unreadable", "Saved unconfirmed actions could not be read. Check your threads before sending again. Nothing was resent."),
            ("computer-unreadable", "Recovered the saved computer list. 1 saved computer needs pairing again.")
        ]
        for (scenario, words) in scenarios {
            launch(Self.fixture + ["--ui-feedback-" + scenario])
            let message = app.staticTexts.matching(NSPredicate(format: "label == %@", words)).firstMatch
            XCTAssertTrue(message.waitForExistence(timeout: 15))
            reveal(message)
            XCTAssertFalse(app.staticTexts["Answer sent."].exists)
            capture("feedback-" + scenario + "-dark")
            app.tab("Settings").tap()
            XCTAssertTrue(app.buttons["setting-light"].waitForExistence(timeout: 5))
            app.buttons["setting-light"].tap()
            let larger = app.buttons["setting-larger-text"]
            reveal(larger)
            larger.tap()
            app.tab("Threads").tap()
            reveal(message, swipingDown: true)
            capture("feedback-" + scenario + "-light-larger-text")
            let dismiss = app.buttons["Dismiss message"]
            reveal(dismiss, swipingDown: true)
            dismiss.tap()
            XCTAssertFalse(message.exists)
        }
    }

    /// A thread whose computer loses its connection keeps its messages on screen, with Reconnecting over the reply box,
    /// rather than going back to "Reading this thread…".
    func testAThreadStaysOnScreenWhileItsComputerReconnects() {
        launch(Self.fixture + ["--ui-reconnecting"])
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        let reconnecting = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Reconnecting to Laptop")).firstMatch
        XCTAssertTrue(reconnecting.waitForExistence(timeout: 10), "The reply box says the thread's computer is reconnecting")
        XCTAssertTrue(threadText("Fix the tooltips first").exists, "The thread as last read stays on screen")
        XCTAssertFalse(text("Reading this thread").exists)
        capture("thread-reconnecting")
    }

    func testFolderReadTimeoutInBothAppearances() {
        launch(Self.fixture + ["--ui-folder-timeout"])
        for appearance in ["dark", "light"] {
            if appearance == "light" {
                app.tab("Settings").tap()
                app.buttons["setting-light"].tap()
                let larger = app.buttons["setting-larger-text"]
                reveal(larger); larger.tap()
                app.tab("Threads").tap()
            }
            app.buttons["new-thread"].tap()
            let browse = app.buttons["browse-project-folder"]
            XCTAssertTrue(browse.waitForExistence(timeout: 5))
            reveal(browse); browse.tap()
            let problem = app.staticTexts["Sotto did not answer in time. Try again."]
            XCTAssertTrue(problem.waitForExistence(timeout: 5))
            reveal(problem)
            XCTAssertFalse(app.staticTexts["Delivery is unconfirmed. Check the thread before sending again."].exists)
            XCTAssertTrue(app.buttons["folders-try-again"].exists, "A read that timed out has a Try again button")
            capture("folder-read-timeout-" + appearance)
            app.buttons["Home"].tap()
            XCTAssertTrue(problem.waitForExistence(timeout: 5))
            app.buttons["Back"].tap()
            app.buttons["Cancel"].tap()
        }
    }

    func testAppearanceAndLargerTextPersist() {
        launch(Self.fixture)
        app.tab("Settings").tap()
        let light = app.buttons["setting-light"]
        XCTAssertTrue(light.waitForExistence(timeout: 5))
        light.tap()
        XCTAssertEqual(light.value as? String, "Selected")
        // Larger is a step of the five-step text size, where the earlier Larger text switch was.
        let larger = app.buttons["setting-larger-text"]
        reveal(larger)
        larger.tap()
        XCTAssertEqual(larger.value as? String, "Selected")
        capture("settings-light-larger-text")

        launch(["--ui-fixture"])
        capture("focus-light-larger-text")
        app.tab("Settings").tap()
        XCTAssertTrue(light.waitForExistence(timeout: 5))
        XCTAssertEqual(light.value as? String, "Selected", "Appearance persists across launch")
        reveal(larger)
        XCTAssertEqual(larger.value as? String, "Selected", "Larger text persists across launch")
        reveal(app.buttons["setting-dark"], swipingDown: true)
        app.buttons["setting-dark"].tap()
        XCTAssertEqual(app.buttons["setting-dark"].value as? String, "Selected")
        app.tab("Threads").tap()
        capture("focus-dark-larger-text")
    }

    /// The Agents view (ADR-0103): Agents in a thread's top bar counts its delegated threads and agents and says one needs
    /// you. Its sheet lists them newest first; an agent opens in place to its task and latest update, a delegated thread
    /// opens, and Back comes back to the sheet.
    func testAgentsOpensADelegatedThreadAndBackReturnsToTheSheet() {
        launch(Self.fixture + ["--ui-agents"])
        let thread = row("iphone")
        reveal(thread)
        // Its delegated review waits on the user, so the row stands in Needs you and opens the review on its question,
        // with Back returning to the thread that delegated it (ADR-0151's second October 30 amendment).
        XCTAssertTrue(thread.label.contains("Review the drawer fix"), "The row says which delegated thread asks")
        thread.tap()
        XCTAssertTrue(app.staticTexts["Run npm test -- terminalDrawer?"].waitForExistence(timeout: 5),
                      "A Needs you row for a delegated thread opens that thread on its question")
        let notNow = app.buttons["Not now"]
        reveal(notNow)
        // The journey runs first on a freshly booted simulator, where a synthesized tap is now and then dropped (#1984).
        XCTAssertEqual(press(notNow, until: NSPredicate { _, _ in !notNow.exists }, untouched: { notNow.exists }), .completed,
                       "Not now closes the delegated thread's question")
        back()
        let agents = app.buttons["thread-agents"]
        XCTAssertTrue(agents.waitForExistence(timeout: 5), "A thread with delegated threads and agents has Agents in its top bar")
        XCTAssertEqual(agents.value as? String, "4 agents, 1 needs you")
        agents.tap()
        let docs = app.buttons["agents-row-thread:drawer-docs"]
        XCTAssertTrue(docs.waitForExistence(timeout: 5), "Agents opens the sheet of the thread's delegated threads and agents")
        XCTAssertTrue(text("2 delegated threads · 2 agents").exists, "The sheet counts both")
        XCTAssertTrue(app.buttons["agents-answer-thread:review-fix"].exists, "A delegated thread that waits on you opens to answer")
        // The outcome and the order come with the computer's reads, a moment after the sheet opens.
        let answered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@", "Check the drawer docs, delegated thread on Codex, Answered"), object: docs)
        // A deadline that is never reached costs nothing; on a cold simulator those reads can take longer than 5 s (#1984).
        XCTAssertEqual(XCTWaiter.wait(for: [answered], timeout: 30), .completed, "A delegated thread's row says its outcome")
        XCTAssertTrue(app.buttons["agents-row-agent:waits"].waitForExistence(timeout: 30))
        // Newest start first: the running agent, the review, the docs, then the finished agent.
        let order = ["agents-row-agent:suite", "agents-row-thread:review-fix", "agents-row-thread:drawer-docs", "agents-row-agent:waits"]
            .map { app.buttons[$0].frame.minY }
        XCTAssertEqual(order, order.sorted(), "Rows run newest start first")
        capture("agents-sheet-dark")

        let suite = app.buttons["agents-row-agent:suite"]
        suite.tap()
        XCTAssertTrue(text("Run 11 of 20").waitForExistence(timeout: 5), "An agent opens in place to its latest update")
        XCTAssertTrue(text("Run the drawer tests twenty times and count the failures.").exists, "and to its task")
        XCTAssertEqual(suite.value as? String, "Open")
        capture("agents-sheet-agent-open")

        docs.tap()
        // The thread behind the sheet has a title too, so wait for the delegated thread's own.
        let title = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "thread-title", "Check the drawer docs")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10), "A delegated thread's row opens it")
        capture("agents-delegated-thread")
        back()
        XCTAssertTrue(docs.waitForExistence(timeout: 10), "Back from the delegated thread comes back to the sheet")
        app.buttons["agents-done"].tap()
        XCTAssertTrue(waitUntilGone(docs), "Done closes the sheet")
    }

    func testComputerScopePreservesSearchAndLandscape() {
        launch(Self.fixture)
        let filter = app.buttons["computer-filter"]
        let search = app.textFields["thread-search"]
        let lighting = app.buttons["thread-22222222-2222-4222-8222-222222222222/lighting"]
        filter.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop")).firstMatch.tap()
        XCTAssertEqual(filter.value as? String, "Laptop")
        XCTAssertTrue(row("release").exists)
        XCTAssertFalse(lighting.exists)
        capture("focus-connected")

        filter.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Studio Mac")).firstMatch.tap()
        XCTAssertEqual(filter.value as? String, "Studio Mac")
        reveal(lighting)
        XCTAssertFalse(row("release").exists)
        capture("offline-computer-scope")
        reveal(search, swipingDown: true)
        search.tap()
        search.typeText("lighting\n")
        filter.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Laptop")).firstMatch.tap()
        XCTAssertEqual(search.value as? String, "lighting")
        XCTAssertTrue(app.staticTexts["No matching threads."].exists)
        filter.tap()
        app.buttons["All computers"].tap()
        reveal(lighting)
        XCTAssertEqual(search.value as? String, "lighting")
        reveal(search, swipingDown: true)
        app.buttons["Clear search"].tap()
        search.typeText("\n")

        XCUIDevice.shared.orientation = .landscapeLeft
        waitForRenderedOrientation(landscape: true)
        capture("focus-landscape")
        XCTAssertTrue(app.tab("Settings").isHittable)
        XCUIDevice.shared.orientation = .portrait
        waitForRenderedOrientation(landscape: false)
    }
}

extension XCUIApplication {
    /// The tabs' bar's buttons, by identifier: the system's hidden tab bar keeps buttons of the same names in the tree.
    var tabButtons: XCUIElementQuery { buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tab-'")) }
    /// One tab's button, by its English name: `tab("Settings")`.
    func tab(_ name: String) -> XCUIElement { buttons["tab-\(name.lowercased())"] }
}

private extension XCUIElement {
    func waitForValue(_ value: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (self.value as? String) == value { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return false
    }
}
