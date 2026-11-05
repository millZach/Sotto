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
        XCTAssertTrue(button.waitForExistence(timeout: 30))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in button.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed,
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

    /// Whether the box has come to the shape asked for: small with its words in the row of buttons, full with them over it.
    /// The pill only fades (it keeps its place, and its sheet), so XCUITest finds it either way and can't say which.
    /// Generous on purpose: on CI's SE one look at the two frames took over four seconds, and a five second deadline ran
    /// out during the first look with the box already small. It is never reached when the box is right.
    private func waitForReplyBox(small: Bool, words: XCUIElement, timeout: TimeInterval = 30) -> Bool {
        let mic = byID("dictate")
        var seen = "nothing read"
        let shaped = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let wordsFrame = words.frame, micFrame = mic.frame
            seen = "words \(wordsFrame), mic \(micFrame)"
            guard !wordsFrame.isEmpty, !micFrame.isEmpty else { return false }
            return small ? wordsFrame.minY >= micFrame.minY : wordsFrame.maxY <= micFrame.minY + 1
        }, object: nil)
        let reached = XCTWaiter.wait(for: [shaped], timeout: timeout) == .completed
        if !reached { explain(small ? "reply-box-not-small" : "reply-box-not-full", seen) }
        return reached
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
    /// not reproduce it, so this journey guards the end of a long thread rather than proving the fix. The page lays out
    /// only the latest ten turns whole and makes the thirty before them as they scroll into view (#1702), so the first
    /// turn is not made yet.
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
        let last = threadText("python compare_drives.py --option 40 --report")
        waitForEnd(end, last: last, above: reply, "A long thread opens showing its end, with no scroll needed")
        XCTAssertFalse(threadText("python compare_drives.py --option 1 --report").exists,
                       "The turns before the latest ten are made as they scroll into view, not when the thread opens")
        capture("thread-long-open")
    }

    /// A row's long press offers Settle, as a thread's ••• does; it acts at once, and its confirmation offers Undo (#1859).
    func testARowsLongPressOffersSettle() {
        launch(Self.fixture)
        let recent = row("shortcuts")
        reveal(recent)
        recent.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Settle"].waitForExistence(timeout: 5), "A Recent row's long press offers Settle")
        capture("row-menu-settle")
    }

    /// The Settled shelf draws its rows itself, so its long press is checked on its own: Restore, for a thread the user settled.
    func testASettledRowsLongPressOffersRestore() {
        launch(Self.fixture)
        let settled = app.buttons["settled-threads"]
        reveal(settled)
        settled.tap()
        let notes = row("notes")
        reveal(notes)
        notes.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Restore"].waitForExistence(timeout: 5), "A settled row's long press offers Restore")
        capture("row-menu-restore")
    }

    /// A thread whose turns carry pictures keeps a reader at its end once they are there: while its pictures and photos
    /// load, after reading back up past turns whose tiles let go of their pictures and dragging down again, and while a
    /// reply streams. On the phone such a thread kept snapping back up to one spot and would not let the reader reach its
    /// end (Zach, November 1, 2026). Its messages arrive a moment after it opens, as from a computer.
    ///
    /// Where the end sits is read from the page's own layout (`--ui-end-probe`): in this long page an element's
    /// accessibility frame lagged its layout by up to thousands of points.
    func testAThreadWithPicturesStaysAtItsEnd() { picturesStayAtTheEnd(streaming: false) }
    func testAThreadWithPicturesStaysAtItsEndWhileAReplyStreams() { picturesStayAtTheEnd(streaming: true) }

    private func picturesStayAtTheEnd(streaming: Bool) {
        launch(Self.fixture + ["--ui-long-thread", "--ui-pictures", "--ui-slow-detail", "--ui-end-probe"] + (streaming ? ["--ui-streaming"] : []))
        let thread = row("drives")
        reveal(thread)
        thread.tap()
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertTrue(byID("steps-run-long-final").waitForExistence(timeout: 10), "The long thread's messages arrive")
        holdsTheEnd("pictures-open", "Opened at its end, the thread stays there while the pictures and photos near it load")

        // Back up past the latest turns' pictures, so the tiles at the end let go of theirs, then down again by dragging,
        // as a reader does, until the end is in view, and once more against it so the page rests there.
        for _ in 0..<12 { dragThread(towardEnd: false, above: reply) }
        capture("thread-pictures-read-back")
        XCTAssertTrue(endProbe().away, "Reading back up leaves the end, and nothing pulls the reader down (" + endProbe().words + ")")
        var drags = 0
        while !endProbe().atEnd && drags < 40 { dragThread(towardEnd: true, above: reply); drags += 1 }
        XCTAssertTrue(endProbe().atEnd, "Dragging down reaches the thread's end (" + endProbe().words + ")")
        dragThread(towardEnd: true, above: reply)
        holdsTheEnd("pictures-returned", "Back at its end, the thread stays there while its pictures load again")
    }

    /// Where the conversation's end, the reply box's top and the bar's bottom sit, as the page lays them out, and whether
    /// the end is whole on screen above the reply box, or well below it, where reading back up leaves it.
    private func endProbe() -> (atEnd: Bool, away: Bool, words: String) {
        let probe = byID("thread-end-probe")
        guard probe.exists else { return (false, false, "no probe") }
        let words = probe.label
        let numbers = words.split(separator: " ").compactMap { Double($0) }
        guard numbers.count == 3 else { return (false, false, words) }
        let end = numbers[0], dock = numbers[1], bar = numbers[2]
        return (end <= dock + 1 && end > bar, end > dock + 400, "end \(Int(end)), dock top \(Int(dock)), bar bottom \(Int(bar))")
    }

    /// Drags the thread once from the middle of the conversation, slowly enough not to fling: toward its end, or back
    /// toward its start.
    private func dragThread(towardEnd: Bool, above dock: XCUIElement) {
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        let top = threadTop + 16, bottom = dock.frame.minY - 32
        let distance = min(220, (bottom - top) * 0.45)
        let x = window.frame.width - 32, middle = (top + bottom) / 2 - window.frame.minY
        let direction: CGFloat = towardEnd ? -1 : 1
        origin.withOffset(CGVector(dx: x, dy: middle - direction * distance / 2))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: x, dy: middle + direction * distance / 2)),
                   withVelocity: .slow, thenHoldForDuration: 0.15)
    }

    /// Waits for the conversation's end to come into view above the reply box, then reads it for six seconds more: every
    /// reading must find it there. A page pulled back up leaves the end under the box or off the screen.
    private func holdsTheEnd(_ name: String, _ message: String) {
        var readings: [String] = []
        let started = Date()
        func shown() -> Bool {
            let probe = endProbe()
            readings.append(String(format: "%.1f s: ", Date().timeIntervalSince(started)) + probe.words)
            return probe.atEnd
        }
        var inARow = 0
        while inARow < 2 && Date().timeIntervalSince(started) < 30 {
            inARow = shown() ? inARow + 1 : 0
            if inARow < 2 { Thread.sleep(forTimeInterval: 0.2) }
        }
        guard inARow >= 2 else {
            explain("thread-\(name)-end-never-shown", readings.joined(separator: "\n"))
            XCTFail(message + ": the end never came into view\n" + readings.suffix(8).joined(separator: "\n"))
            return
        }
        var away = 0
        let held = Date()
        while Date().timeIntervalSince(held) < 6 {
            if !shown() { away += 1 }
            Thread.sleep(forTimeInterval: 0.2)
        }
        capture("thread-\(name)")
        if away > 0 { explain("thread-\(name)-left-the-end", readings.joined(separator: "\n")) }
        XCTAssertEqual(away, 0, message + "\n" + readings.joined(separator: "\n"))
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

    /// Thread page B: the conversation opens at its end and stays there while the reply keyboard opens, and dragging it
    /// down into the keyboard puts the keyboard away; the title block and Git chips scroll away with it; messages read as
    /// Markdown blocks.
    func testThreadPageKeepsItsPlaceAndReadsMarkdown() {
        launch(Self.fixture)
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        let title = byID("thread-title")
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Refine the iPhone thread view")
        XCTAssertTrue(threadText("Codex · Sotto · Laptop").exists, "The line under the title reads provider · project · computer (#1861)")
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
        // Put the keyboard away before reading on. With it up, every reading of the squeezed page took seconds, and the
        // Markdown, table and title checks below took 2 to 7 minutes of a run on CI (November 4, 2026).
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        for _ in 0..<3 where keyboard.exists {
            let middle = (threadTop + reply.frame.minY) / 2
            origin.withOffset(CGVector(dx: 8, dy: middle - window.frame.minY))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: 8, dy: window.frame.height - 24)),
                       withVelocity: .default, thenHoldForDuration: 0)
            if keyboard.waitForNonExistence(timeout: 5) { break }
        }
        XCTAssertTrue(waitUntilGone(keyboard), "Dragging the conversation down into the keyboard puts it away")

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
    func testAThreadStaysInsideTheScreenAtTheLargestTextSizes() throws {
        // The narrow phone is where #1848 cut words off; the large phone, which runs at the accessibility sizes, has the
        // room. The small phone's job checks it (November 4, 2026).
        try XCTSkipIf(UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory, "The small phone checks this")
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

        // Done closes it, trailing, as every sheet that only shows things closes (#1860).
        let done = app.buttons["pull-request-done"]
        XCTAssertEqual(done.label, "Done")
        XCTAssertTrue(app.buttons["pull-request-github"].exists, "Open on GitHub stays beside Done")
        done.tap()
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

    /// A request sheet leads with what it asks, under one quiet line that says who asks and in which thread, the same on
    /// a question and a permission (#1855).
    func testARequestSheetLeadsWithWhatItAsks() {
        launch(Self.fixture)
        let release = row("release")
        reveal(release)
        release.tap()
        XCTAssertTrue(app.staticTexts["Which release should I prepare?"].waitForExistence(timeout: 5), "A waiting question opens with its thread")
        let line = labelled("Claude Code · Choose the release target")
        XCTAssertTrue(line.exists, "Who asks and where is one short line over the question")
        reveal(app.buttons["Not now"])
        app.buttons["Not now"].tap()
        let permission = "Allow reading the release checklist?"
        let headline = app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label == %@", "request-headline", permission)).firstMatch
        XCTAssertTrue(headline.waitForExistence(timeout: 5), "The permission's headline is what it asks")
        XCTAssertTrue(line.exists, "Under the same short line as the question")
        XCTAssertFalse(labelled("Claude Code is asking permission").exists, "The headline never only says who asks")
        capture("request-permission-headline")
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
        let state = byID("watcher-state")
        press(tab, until: NSPredicate { _, _ in state.exists }, timeout: 30, untouched: { !state.exists })
        XCTAssertTrue(state.waitForExistence(timeout: 10), "Watcher's page opens with its state")
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
    /// The part of Watcher's conversation a press reaches: below the status bar and the page's fade under it, and above
    /// its reply box, with anything the box carries over it. Watcher's page has no bar of its own (November 1, 2026).
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
        // The page shows from under the status bar, which no iPhone draws taller than 62 points, and the page's ground
        // fades in over the 10 points under it once the page moves.
        let top = window.frame.minY + 62 + 10 + 8
        let tabs = elements.first { $0.identifier == "tab-threads" }
        var bottom = tabs?.frame.minY ?? window.frame.maxY
        // The box's glass starts above its text; a held line or a message sits above the box.
        let dock: [((any XCUIElementSnapshot)?, CGFloat)] = [(element("watcher-reply"), 20), (element("watcher-send-held"), 8),
                                                             (element("Dismiss message", type: .button), 8)]
        // Presence and frame come from the same instant, including a toast that may leave between separate queries.
        for (element, gap) in dock {
            if let element { bottom = min(bottom, element.frame.minY - gap) }
        }
        return (top, bottom)
    }
    /// Presses the Watcher tab while Watcher's page shows, and waits for the page's top, where Watcher's hero is, to bring
    /// Watcher's state into view between the status bar and the box, two looks in a row. Each look reads the state and
    /// the band from one snapshot. On CI's large iPhone, separate queries took up to eleven seconds a look.
    @discardableResult private func toWatcherHero(_ message: String = "A press on the Watcher tab brings Watcher's state into view") -> XCUIElement {
        let tab = app.tab("Watcher")
        XCTAssertTrue(tab.waitForExistence(timeout: 5), "The Watcher tab is there to press")
        var seen = "no look found Watcher's state"
        var matches = 0
        let shown = NSPredicate { _, _ in
            guard let elements = try? self.everyElement(), let band = self.watcherBand(in: elements),
                  let window = elements.first(where: { $0.elementType == .window }) else {
                seen = "no snapshot of the page"; matches = 0; return false
            }
            guard let frame = elements.first(where: { $0.identifier == "watcher-state" })?.frame, !frame.isEmpty else {
                seen = "Watcher's state is missing"; matches = 0; return false
            }
            seen = "state \(frame), under the window's top at \(window.frame.minY), above \(band.bottom)"
            // The smallest status bar is 20 points; at the page's top the hero sits its own margin under the status bar.
            matches = frame.minY >= window.frame.minY + 20 && frame.maxY <= band.bottom ? matches + 1 : 0
            return matches >= 2
        }
        // Going to the top again does nothing more, so a dropped press is simply pressed again.
        let result = press(tab, until: shown, timeout: 30)
        if result != .completed { explain("watcher-hero-state-not-shown", seen) }
        XCTAssertEqual(result, .completed, "\(message) (\(seen))")
        return byID("watcher-state")
    }
    /// Watcher's settings pill in its box's row, whose menu holds Watcher's permissions (ADR-0166, amended November 1, 2026).
    private func watcherPill() -> XCUIElement {
        let pill = byID("watcher-settings")
        XCTAssertTrue(pill.waitForExistence(timeout: 10), "Watcher's box carries its settings pill")
        return pill
    }
    /// Opens what Watcher may do without asking from its pill's menu, and waits for the list.
    private func openWatcherPermissions(_ pill: XCUIElement) {
        let entry = menuItem("Permissions")
        press(pill, until: NSPredicate { _, _ in entry.exists })
        XCTAssertTrue(entry.waitForExistence(timeout: 5), "The pill's menu offers Permissions")
        XCTAssertTrue(entry.isEnabled, "Watcher waits between turns, so its permissions can change")
        entry.tap()
        XCTAssertTrue(text("What Watcher may do without asking").waitForExistence(timeout: 10), "Permissions opens the four modes")
    }
    /// Whether the pill's value ends on this permission mode, within `timeout`. One look at the large iPhone's page can
    /// outlast five seconds on a loaded runner, so the deadline is generous; it is never reached when the pill is right.
    private func watcherPill(_ pill: XCUIElement, says mode: String, timeout: TimeInterval = 20) -> Bool {
        let says = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value ENDSWITH %@", mode), object: pill)
        return XCTWaiter.wait(for: [says], timeout: timeout) == .completed
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

    /// Watcher opens straight on its conversation, full screen, as any thread does, with no bar over it (Zach, November 1,
    /// 2026). Watcher's name, state and computer head its page and scroll away with the conversation, as a thread's title
    /// does (#1275, Zach's pick A), and a press on the Watcher tab while Watcher shows brings them back.
    func testWatchersHeroScrollsAwayAndTheWatcherTabBringsItBack() {
        launch(Self.watcher)
        openWatcher()
        XCTAssertFalse(byID("watcher-bar").exists, "No bar over Watcher's page")
        XCTAssertFalse(byID("watcher-to-top").exists, "No owl button: the tab goes to the top")
        XCTAssertFalse(app.buttons["watcher-section-watched"].exists, "No Watched pane to switch to")
        let state = byID("watcher-state")
        // Reading at the conversation's end, the hero has scrolled off under the status bar.
        revealInWatcher(app.buttons["watcher-card-review"])
        let band = watcherBand
        XCTAssertLessThanOrEqual(state.frame.maxY, band.top, "Watcher's state scrolls away with the conversation (\(state.frame), band from \(band.top))")
        capture("watcher-hero-away-dark")
        toWatcherHero()
        XCTAssertTrue(text("Codex · GPT-6.1 Sol on Laptop").isHittable, "With Watcher's model and computer")
        XCTAssertTrue(byID("watcher-reply").exists, "And the box, where it always is")
        capture("watcher-hero-dark")
        watcherInLight()
        revealInWatcher(app.buttons["watcher-card-review"])
        toWatcherHero("A press on the Watcher tab brings Watcher's state into view in light")
        capture("watcher-hero-light")
    }

    /// "Watcher is working" and what follows it stay whole above the box, the box's own gap clear of it, however tall the
    /// box grows: the page follows its end, not just Watcher's newest words, which sit above the working line (Zach's iPhone Duo, November 1, 2026).
    func testWatcherIsWorkingStaysAboveATallBox() {
        launch(Self.watcher + ["--ui-watcher-nothing-waits"])
        openWatcher()
        let working = byID("watcher-working")
        XCTAssertTrue(working.waitForExistence(timeout: 10), "Watcher works, and its page says so at its end")
        XCTAssertEqual(working.label, "Watcher is working")
        let reply = byID("watcher-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let oneLine = reply.frame.height
        reply.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        reply.typeText("Look at the release notes thread and tell me what it is waiting on, then check the login test, "
                       + "the wiring schedule and the iPhone thread view, and say which of them need me before lunch today.")
        // Each look reads the working line and the box from one snapshot, as the band does.
        var seen = "no look found the working line"
        var matches = 0
        let above = NSPredicate { _, _ in
            guard let elements = try? self.everyElement(), let band = self.watcherBand(in: elements) else {
                seen = "no snapshot of the page"; matches = 0; return false
            }
            guard let line = elements.first(where: { $0.identifier == "watcher-working" })?.frame, !line.isEmpty,
                  let box = elements.first(where: { $0.identifier == "watcher-reply" })?.frame else {
                seen = "the working line or the box is missing"; matches = 0; return false
            }
            seen = "working line \(line), box \(box), band from \(band.top) to \(band.bottom)"
            let tall = box.height > oneLine * 2
            matches = tall && line.minY >= band.top && line.maxY <= band.bottom + 1 && line.maxY <= box.minY ? matches + 1 : 0
            return matches >= 2
        }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: above, object: nil)], timeout: 30)
        if result != .completed { explain("watcher-working-under-the-box", seen) }
        XCTAssertEqual(result, .completed, "With several lines in the box, Watcher is working ends above the box's top (\(seen))")
        capture("watcher-working-tall-box-dark")
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
            XCTAssertTrue(row.label.contains("Codex · Sotto · Laptop"), "and where it runs, as every thread's line does (#1861)")
            row.tap()
            let title = byID("thread-title")
            XCTAssertTrue(title.waitForExistence(timeout: 10), "The row opens its thread")
            XCTAssertEqual(title.label, "Babysit #845 release notes")
            XCTAssertTrue(text("Codex · Sotto · Laptop, watched by Watcher").exists, "The owl follows the provider's logo")
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
        launch(Self.watcher + ["--ui-reply-box-stays-full"])
        openWatcher()
        let pill = watcherPill()
        XCTAssertTrue(watcherPill(pill, says: "Ask before actions"), "The pill says Watcher asks first (\(String(describing: pill.value)))")
        openWatcherPermissions(pill)
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
        XCTAssertTrue(watcherPill(pill, says: "Ask before actions"))
    }

    /// The threads Watcher watches carry its owl in Threads, and Stop Watcher’s threads, in Watcher's settings sheet above
    /// New Watcher (Zach, November 1, 2026), asks first: cancelling stops nothing, and confirming stops only the threads
    /// Watcher started.
    func testStopAllAsksFirst() {
        launch(Self.watcher + ["--ui-reply-box-stays-full"])
        let login = row("login")
        reveal(login)
        XCTAssertTrue(login.label.contains("watched by Watcher"), "A watched thread says so in Threads (\(login.label))")
        openWatcher()
        let settings = watcherPill()
        let stopAll = app.buttons["watcher-stop-all"], new = menuItem("New Watcher")
        press(settings, until: NSPredicate { _, _ in stopAll.exists })
        XCTAssertTrue(stopAll.waitForExistence(timeout: 5), "The settings sheet offers Stop Watcher’s threads while Watcher watches any")
        XCTAssertEqual(stopAll.label, "Stop Watcher’s threads")
        XCTAssertTrue(stopAll.isEnabled)
        XCTAssertTrue(new.exists)
        XCTAssertLessThan(stopAll.frame.minY, new.frame.minY, "Above New Watcher, the sheet's last row")
        capture("watcher-stop-row-dark")
        stopAll.tap()
        // An alert, named by its question, so its Cancel is always there to press (iOS 26 leaves a confirmation
        // dialog's out). It comes once the sheet has gone.
        let question = app.alerts["Stop the 3 threads Watcher started?"]
        XCTAssertTrue(question.waitForExistence(timeout: 10), "Stop Watcher’s threads asks first")
        XCTAssertFalse(stopAll.exists, "The sheet has gone")
        let confirm = question.buttons["Stop 3 threads"]
        XCTAssertTrue(confirm.exists)
        let named = question.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Add Android share sheet, Claude Code on Studio Mac")).firstMatch
        XCTAssertTrue(named.exists, "The question names each thread it would stop and where it runs")
        capture("watcher-stop-all-dark")
        question.buttons["Cancel"].tap()
        XCTAssertTrue(waitUntilGone(question))
        press(settings, until: NSPredicate { _, _ in stopAll.exists })
        XCTAssertTrue(stopAll.waitForExistence(timeout: 5), "Cancelling stops nothing: Watcher still has threads to stop")
        stopAll.tap()
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        XCTAssertTrue(labelled("Stopped 3 threads Watcher started.").waitForExistence(timeout: 10))
        // With nothing watched, the sheet offers nothing to stop.
        press(settings, until: NSPredicate { _, _ in new.exists })
        XCTAssertTrue(new.waitForExistence(timeout: 5))
        XCTAssertFalse(stopAll.exists, "With nothing watched, there is nothing to stop")
        capture("watcher-stopped-dark")
        dismissMenu()
        XCTAssertTrue(waitUntilGone(new), "The sheet goes")
        watcherInLight()
        capture("watcher-stopped-light")
    }

    /// Watcher's permissions are Permissions in its box's settings pill (ADR-0166, amended November 1, 2026), in this
    /// iPhone's own words (control A, #1276): it opens the four modes, a choice shows on the pill at once, and until
    /// Watcher's provider confirms it the line over the box says what is still in force.
    ///
    /// The fixture's Codex confirms fifteen seconds after the choice, and on a loaded CI simulator one look on this page has
    /// taken over twenty, so the line could go before the journey saw it (#2067). So Codex waits here until the journey has
    /// read the line, and only the second launch lets it confirm, where nothing has to catch the line.
    func testWatchersPermissionsChangeFromItsBox() {
        let arguments = Self.watcher + ["--ui-watcher-can-answer", "--ui-reply-box-stays-full"]
        launch(arguments + ["--ui-watcher-permission-unconfirmed"])
        openWatcher()
        let reply = byID("watcher-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let pill = watcherPill()
        XCTAssertGreaterThanOrEqual(pill.frame.minY, reply.frame.maxY - 1, "The pill sits under the words, in the box")
        XCTAssertEqual(pill.label, "Watcher’s settings")
        XCTAssertTrue(watcherPill(pill, says: "Ask before actions"), "The pill says Watcher asks first (\(String(describing: pill.value)))")
        capture("watcher-permissions-dark")
        openWatcherPermissions(pill)
        XCTAssertTrue(text("What Watcher may do without asking").waitForExistence(timeout: 5))
        let asking = app.buttons["watcher-permission-approval-required"]
        XCTAssertTrue(asking.isSelected, "The mode in force is ticked")
        XCTAssertTrue(asking.label.contains("Codex asks before every command, even one that only reads, and before every edit."),
                      "Each mode says what Watcher does under it")
        let edits = app.buttons["watcher-permission-auto-accept-edits"]
        reveal(edits)
        XCTAssertTrue(edits.isEnabled, "Where this iPhone can answer, a wider mode can be chosen")
        XCTAssertFalse(byID("watcher-permissions-asks-only").exists)
        capture("watcher-permissions-sheet-dark")
        edits.tap()
        XCTAssertTrue(waitUntilGone(edits), "Choosing closes the list")
        XCTAssertTrue(watcherPill(pill, says: "Allow edits"), "The pill says the choice at once")
        let inForce = byID("watcher-permissions-in-force")
        XCTAssertTrue(inForce.waitForExistence(timeout: 30), "Until Codex confirms it, the line over the box says what is still in force")
        XCTAssertEqual(inForce.label, "Codex stays on Ask before actions until it confirms.")
        XCTAssertLessThanOrEqual(inForce.frame.maxY, reply.frame.minY, "Over the box")
        capture("watcher-permissions-pending-dark")

        // With nothing holding it, Codex confirms and the line goes. On CI one look for it has taken 31 seconds, so sixty
        // seconds held only three looks and once ran out with the line already gone from the screen. A deadline that is
        // never reached costs nothing.
        launch(arguments)
        openWatcher()
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        openWatcherPermissions(pill)
        XCTAssertTrue(edits.waitForExistence(timeout: 5))
        reveal(edits)
        edits.tap()
        XCTAssertTrue(waitUntilGone(edits), "Choosing closes the list")
        XCTAssertTrue(watcherPill(pill, says: "Allow edits"), "The choice is made before the line can go")
        XCTAssertTrue(waitUntilGone(inForce, timeout: 120), "Once Codex confirms it, nothing more is said")
        XCTAssertTrue(watcherPill(pill, says: "Allow edits"))
        // Writing in the box leaves the pill where it is.
        reply.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(pill.exists, "The pill stays in the box while the box is written in")
        dismissKeyboard()
        watcherInLight()
        capture("watcher-permissions-light")
        openWatcherPermissions(watcherPill())
        let picked = app.buttons["watcher-permission-auto-accept-edits"]
        XCTAssertTrue(picked.waitForExistence(timeout: 5))
        reveal(picked)
        XCTAssertTrue(picked.isSelected)
        capture("watcher-permissions-sheet-light")
        // Pressing the chosen mode closes the list and changes nothing.
        picked.tap()
        XCTAssertTrue(waitUntilGone(picked))
        XCTAssertTrue(watcherPill(pill, says: "Allow edits"))
        // Done closes it too: a sheet that can be dragged away has a button that closes it (#1860).
        openWatcherPermissions(watcherPill())
        let done = app.buttons["watcher-permissions-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5), "The list closes with Done")
        XCTAssertEqual(done.label, "Done")
        done.tap()
        XCTAssertTrue(waitUntilGone(done), "Done closes the list")
        XCTAssertTrue(watcherPill(pill, says: "Allow edits"), "and changes nothing")
    }

    /// Watcher's box takes a thread box's pill (ADR-0166, amended November 1, 2026): Watcher's model and effort on it, and
    /// one sheet holding the models of every provider Watcher runs on, Effort, Speed, Permissions and, last, New Watcher,
    /// which starts one at once, whose empty conversation says so, with the last one's handover offered over the box until
    /// X puts it away.
    func testWatchersBoxChangesItsModelAndStartsANewWatcher() {
        launch(Self.watcher + ["--ui-watcher-box", "--ui-reply-box-stays-full", "--ui-watcher-can-answer", "--ui-watcher-nothing-waits"])
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
        // The sheet lists Claude Code too, closed until pressed, and says what its model does.
        let claude = byID("model-provider-claude"), opus = menuItem("Opus 5.5")
        press(settings, until: NSPredicate { _, _ in claude.exists })
        XCTAssertTrue(claude.waitForExistence(timeout: 5), "Another provider Watcher runs on is listed")
        claude.tap()
        XCTAssertTrue(opus.waitForExistence(timeout: 5), "Opened, it lists its models")
        XCTAssertTrue(text("Another provider’s model starts a new Watcher.").exists, "And the sheet says what its model does")
        capture("watcher-box-models-dark")
        // The model Watcher is on closes the sheet and changes nothing.
        byID("model-current").tap()
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
        launch(Self.watcher + ["--ui-watcher-box", "--ui-reply-box-stays-full", "--ui-watcher-turn", "--ui-watcher-nothing-waits"])
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

    /// The settings pill opens a sheet at its top (ADR-0166, amended November 1, 2026): the model in use, then the models
    /// starred on this iPhone, then every provider closed, the one in use too. Opening one provider closes the other, its
    /// older models wait closed under Legacy, and put away and opened again the sheet is back at its top with every
    /// provider closed and its stars kept.
    func testTheSettingsSheetOpensAtTheTopWithEveryProviderClosed() {
        launch(Self.watcher + ["--ui-watcher-box", "--ui-reply-box-stays-full", "--ui-watcher-can-answer", "--ui-watcher-nothing-waits"])
        openWatcher()
        let settings = watcherPill()
        let current = byID("model-current"), codex = byID("model-provider-codex"), claude = byID("model-provider-claude")
        let sol = byID("model-codex/fixture-model"), opus = byID("model-claude/fixture-opus")
        let legacy = byID("model-legacy-claude"), opus5 = byID("model-claude/fixture-opus-5")
        let favorite = byID("model-favorite-claude/fixture-opus")
        press(settings, until: NSPredicate { _, _ in current.exists })
        XCTAssertTrue(current.waitForExistence(timeout: 5), "The pill opens the settings sheet")
        XCTAssertTrue(current.isHittable, "It opens at its top, on the model in use")
        XCTAssertTrue(current.label.hasPrefix("GPT-6.1 Sol"), "The model in use leads (\(current.label))")
        XCTAssertFalse(favorite.exists, "Nothing is starred yet")
        XCTAssertEqual(codex.value as? String, "Closed", "Every provider starts closed, the one in use too")
        XCTAssertEqual(claude.value as? String, "Closed")
        XCTAssertFalse(sol.exists || opus.exists || legacy.exists, "Closed providers show none of their models")
        capture("settings-sheet-closed-dark")

        codex.tap()
        XCTAssertTrue(sol.waitForExistence(timeout: 5), "A press opens a provider")
        XCTAssertEqual(codex.value as? String, "Open")
        claude.tap()
        XCTAssertTrue(opus.waitForExistence(timeout: 5), "A press on another opens it")
        XCTAssertTrue(waitUntilGone(sol), "and closes the first: one open at a time")
        XCTAssertEqual(codex.value as? String, "Closed")
        XCTAssertEqual(claude.value as? String, "Open")
        XCTAssertTrue(legacy.exists, "Its older models wait under Legacy")
        XCTAssertFalse(opus5.exists, "closed")
        legacy.tap()
        XCTAssertTrue(opus5.waitForExistence(timeout: 5), "Legacy opens inside its provider")
        XCTAssertEqual(legacy.value as? String, "Open")
        capture("settings-sheet-legacy-dark")
        codex.tap()
        XCTAssertTrue(waitUntilGone(opus5), "Opening another provider closes Legacy with its own")
        XCTAssertTrue(waitUntilGone(opus))
        claude.tap()
        XCTAssertTrue(opus.waitForExistence(timeout: 5))
        XCTAssertFalse(opus5.exists, "and Legacy opens closed again")

        // A star keeps a model under Favorites, over the providers.
        byID("model-claude/fixture-opus-star").tap()
        XCTAssertTrue(favorite.waitForExistence(timeout: 5), "A starred model is listed under Favorites")
        XCTAssertLessThan(favorite.frame.minY, codex.frame.minY, "over the providers")
        capture("settings-sheet-favorite-dark")

        // Put away and opened again, the sheet is at its top with every provider closed, and the star kept.
        dismissMenu()
        XCTAssertTrue(waitUntilGone(current), "The sheet goes")
        press(settings, until: NSPredicate { _, _ in current.exists })
        XCTAssertTrue(current.waitForExistence(timeout: 5))
        XCTAssertTrue(current.isHittable, "Opened again at its top")
        XCTAssertEqual(claude.value as? String, "Closed", "with every provider closed again")
        XCTAssertFalse(opus.exists)
        XCTAssertTrue(favorite.exists, "and the star kept")
        dismissMenu()
        XCTAssertTrue(waitUntilGone(current), "The sheet goes")
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

    /// Watch on a thread's page watches it at once, with Undo, and the owl follows its logo (watch B). Threads shows the
    /// thread watched, and its own Watch stops watching it.
    ///
    /// What a press did is said for eight seconds, and on a loaded CI simulator one look on this page has taken 25, so the
    /// toast could go before the journey saw it (#1308). So the toast waits here until the journey has read it, and only the
    /// second launch lets it go on its own, where nothing has to catch it.
    func testWatchAThreadFromItsPageAndStopWatchingFromItsPage() {
        launch(Self.watcher + ["--ui-watch-notice-stays"])
        let thread = row("shortcuts")
        let title = byID("thread-title")
        let watch = app.buttons["thread-watch"]
        func openThread() {
            reveal(thread)
            thread.tap()
            XCTAssertTrue(title.waitForExistence(timeout: 30))
            XCTAssertTrue(watch.waitForExistence(timeout: 30), "A thread's page offers Watch where a computer runs Watcher")
        }
        // XCTest lets an expectation be waited on only once, so each wait for Watch's value makes its own.
        func watchReads(_ value: String) -> XCTWaiter.Result {
            let reads = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: watch)
            return XCTWaiter.wait(for: [reads], timeout: 30)
        }
        let watchOn = NSPredicate { _, _ in watch.value as? String == "On" }
        let watchOff = NSPredicate { _, _ in watch.value as? String == "Off" }
        openThread()
        XCTAssertEqual(title.label, "Add keyboard shortcuts")
        XCTAssertEqual(watch.label, "Watch")
        XCTAssertEqual(watch.value as? String, "Off")
        watch.tap()
        let toast = byID("watch-toast")
        XCTAssertTrue(toast.waitForExistence(timeout: 30), "What the press did is said at once")
        XCTAssertTrue(text("Watcher is watching Add keyboard shortcuts.").exists)
        XCTAssertEqual(watchReads("On"), .completed, "Watch is on")
        XCTAssertTrue(text("Codex · Sotto · Laptop, watched by Watcher").exists, "The owl follows the provider's logo")
        capture("watch-thread-page-dark")
        // Undo takes it back.
        let undo = app.buttons["watch-undo"]
        XCTAssertEqual(undo.label, "Undo: stop watching Add keyboard shortcuts")
        undo.tap()
        XCTAssertEqual(watchReads("Off"), .completed, "Undo stops watching it")
        XCTAssertTrue(text("Watcher stopped watching Add keyboard shortcuts.").waitForExistence(timeout: 30))
        XCTAssertEqual(press(watch, until: watchOn, untouched: { watch.value as? String == "Off" }), .completed, "Watch watches it again")
        // Its own Watch stops watching it, with Undo.
        XCTAssertEqual(press(watch, until: watchOff, untouched: { watch.value as? String == "On" }), .completed, "Watch stops watching it")
        XCTAssertTrue(text("Watcher stopped watching Add keyboard shortcuts.").waitForExistence(timeout: 30))
        XCTAssertTrue(undo.waitForExistence(timeout: 30), "With Undo")
        capture("watch-thread-page-stopped-dark")
        back()
        let unwatchedRow = XCTNSPredicateExpectation(predicate: NSPredicate(format: "NOT (label CONTAINS %@)", "watched by Watcher"), object: thread)
        XCTAssertEqual(XCTWaiter.wait(for: [unwatchedRow], timeout: 30), .completed, "Threads no longer says Watcher watches it (\(thread.label))")

        // With nothing holding it, the toast goes, and nothing over the reply box takes its place: the lit owl says the
        // thread is watched.
        launch(Self.watcher)
        openThread()
        XCTAssertEqual(press(watch, until: watchOn, untouched: { watch.value as? String == "Off" }), .completed, "Watch watches it")
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: toast)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 30), .completed, "The toast goes")
        XCTAssertFalse(watchedLineShows(), "No line says what watching means")
        capture("watch-thread-page-watched-dark")
        back()
        // Threads shows it watched, with the owl after its logo, where Watched used to list it (November 1, 2026).
        let watchedRow = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "watched by Watcher"), object: thread)
        XCTAssertEqual(XCTWaiter.wait(for: [watchedRow], timeout: 30), .completed, "Threads says Watcher watches it (\(thread.label))")
        capture("threads-watched-row-dark")
        // Opened again, Watch still reads on.
        openThread()
        XCTAssertEqual(watchReads("On"), .completed, "Watch is on")
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
    /// The small reply box (ADR-0184): in a thread with content or running, one row of the +, the prompt, the mic and Send
    /// or Stop; a press brings it back full with the settings, a tap on the conversation puts an empty one away again, and
    /// a draft keeps it full. The dock never changes height, which is what would move the conversation. The accessibility
    /// text sizes (the large iPhone's run) stay full, since one row can't hold the prompt.
    func testTheReplyBoxGoesSmallInAThreadAndComesBackToWrite() {
        launch(Self.fixture + ["--ui-thread-settings", "--ui-end-probe"])
        let thread = row("shortcuts")
        reveal(thread)
        thread.tap()
        let reply = byID("thread-reply"), settings = byID("thread-settings"), plus = byID("thread-attach-photos")
        let mic = byID("dictate"), send = byID("thread-send"), keyboard = app.keyboards.firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 20))
        if UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory {
            XCTAssertTrue(waitForReplyBox(small: false, words: reply), "At the accessibility sizes the box stays full")
            capture("reply-box-accessibility-size")
            return
        }
        XCTAssertTrue(waitForReplyBox(small: true, words: reply), "A thread with content opens with the box small")
        XCTAssertLessThan(abs(reply.frame.midY - plus.frame.midY), 2, "The prompt shares the row with the +")
        XCTAssertLessThanOrEqual(plus.frame.maxX, reply.frame.minX + 1, "The + leads the row")
        XCTAssertLessThanOrEqual(reply.frame.maxX, mic.frame.minX + 1, "The prompt stops short of the mic")
        XCTAssertLessThan(mic.frame.maxX, send.frame.minX + 1, "Then Send")
        XCTAssertFalse(send.isEnabled, "With nothing written Send waits")
        let dockTop = { (self.byID("thread-end-probe").label.split(separator: " ").compactMap { Double($0) } + [0, 0])[1] }
        let smallTop = dockTop()
        capture("reply-box-small-dark")

        // A press brings it back full, with the settings, and the row's buttons where they were over the keyboard.
        reply.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 20), "A press on the small box types in it")
        XCTAssertTrue(waitForReplyBox(small: false, words: reply), "Full again")
        XCTAssertTrue(settings.isHittable, "With the settings")
        XCTAssertGreaterThanOrEqual(settings.frame.minY, reply.frame.maxY - 1, "The words are back over the row")
        capture("reply-box-full-dark")

        // A tap on the conversation puts an empty box away.
        let words = threadText("I have the context")
        XCTAssertTrue(words.waitForExistence(timeout: 20))
        words.tap()
        XCTAssertTrue(waitUntilGone(keyboard), "A tap on the conversation puts the keyboard away")
        XCTAssertTrue(waitForReplyBox(small: true, words: reply), "Empty, the box goes small again")

        // Words keep it full: a tap on the conversation leaves them alone, and so does opening the thread again.
        reply.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 20))
        reply.typeText("Fix")
        words.tap()
        XCTAssertTrue(keyboard.exists, "With words in the box a tap on the conversation leaves the keyboard up")
        back()
        thread.tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 20))
        XCTAssertTrue(waitForReplyBox(small: false, words: reply), "A draft keeps the box full")
        XCTAssertFalse(keyboard.exists, "Even with the keyboard away")
        // Read once the page has settled on the probe's next tick. The full box took no more room than the small one.
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(dockTop() - smallTop) < 0.6 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 30), .completed, "The dock keeps its height, so the conversation stays put (\(dockTop()), was \(smallTop))")
        capture("reply-box-draft-dark")
    }

    /// While a turn runs the small box offers Stop, and a new empty thread keeps the box full. At the top effort the light
    /// goes round whichever shape the box has.
    func testTheSmallReplyBoxOffersStopAndANewEmptyThreadStaysFull() throws {
        try XCTSkipIf(UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory, "The accessibility sizes stay full")
        launch(Self.fixture + ["--ui-thread-settings", "--ui-still", "--ui-can-stop"])
        openWorkingThread()
        let reply = byID("thread-reply")
        let stop = app.buttons["Stop this turn"]
        XCTAssertTrue(stop.waitForExistence(timeout: 20), "A running thread's small box offers Stop")
        XCTAssertTrue(waitForReplyBox(small: true, words: reply), "With its words in the row, and no settings")
        XCTAssertFalse(byID("thread-send").exists, "With nothing written, Stop stands where Send was")
        capture("reply-box-small-running-dark")

        launch(Self.fixture + ["--ui-thread-settings", "--ui-still", "--ui-empty-thread"])
        var thread = row("shortcuts")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 20))
        XCTAssertTrue(waitForReplyBox(small: false, words: reply), "A new empty thread keeps the box full")
        capture("reply-box-empty-thread-dark")

        launch(Self.fixture + ["--ui-thread-settings", "--ui-still", "--ui-top-effort"])
        thread = row("shortcuts")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 20))
        XCTAssertTrue(waitForReplyBox(small: true, words: reply), "Small at the top effort too")
        capture("reply-box-small-top-effort-dark")
        reply.tap()
        XCTAssertTrue(waitForReplyBox(small: false, words: reply))
        capture("reply-box-full-top-effort-dark")

        launch(Self.fixture + ["--ui-thread-settings", "--ui-still", "--ui-top-effort", "--ui-light"])
        thread = row("shortcuts")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(reply.waitForExistence(timeout: 20))
        XCTAssertTrue(waitForReplyBox(small: true, words: reply), "In the light theme too")
        capture("reply-box-small-top-effort-light")
    }

    /// Watcher's box goes small by a thread's box's rule, and comes back full for its pill (ADR-0184).
    func testWatchersBoxGoesSmallAndComesBackToWrite() throws {
        try XCTSkipIf(UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory, "The accessibility sizes stay full")
        launch(Self.watcher + ["--ui-watcher-box"])
        openWatcher()
        let reply = byID("watcher-reply"), settings = byID("watcher-settings"), keyboard = app.keyboards.firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 20))
        XCTAssertTrue(waitForReplyBox(small: true, words: reply), "Watcher has a conversation, so its box is small")
        capture("watcher-box-small-dark")
        reply.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 20))
        XCTAssertTrue(waitForReplyBox(small: false, words: reply), "A press on the small box brings it back full")
        XCTAssertTrue(settings.isHittable, "With its pill")
        capture("watcher-box-full-dark")
    }

    func testAThreadsSettingsChangeFromItsReplyBox() {
        launch(Self.fixture + ["--ui-thread-settings", "--ui-reply-box-stays-full"])
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
        // At the accessibility text sizes (the large iPhone's run) the pill takes a line of its own over the buttons.
        let size = UIApplication.shared.preferredContentSizeCategory
        if size.isAccessibilityCategory {
            XCTAssertLessThanOrEqual(settings.frame.maxY, plus.frame.minY + 1, "At \(size.rawValue) the pill sits over the buttons")
            XCTAssertLessThan(plus.frame.maxX, mic.frame.minX, "The + leads the buttons, the mic on the right")
        } else {
            XCTAssertLessThan(plus.frame.maxX, settings.frame.minX + 1, "The + leads the row, then the pill (\(size.rawValue))")
            XCTAssertLessThan(settings.frame.maxX, mic.frame.minX, "The mic is on the right")
        }
        XCTAssertLessThan(mic.frame.maxX, send.frame.minX + 1, "Then Send")
        // Their tops, since each is drawn from the row's top and only some report the 44 points their press area reaches down.
        XCTAssertLessThan(abs(plus.frame.minY - send.frame.minY), 1, "All on one line")
        XCTAssertEqual(mic.label, "Dictate")
        XCTAssertFalse(send.isEnabled, "Send is there with nothing to send, and waits")
        XCTAssertTrue(settings.isEnabled, "An idle thread's settings can be changed")
        capture("thread-settings-dark")

        // The pill opens the settings sheet, the thread's own provider closed until pressed.
        let codex = byID("model-provider-codex"), astra = menuItem("GPT-6 Astra")
        press(settings, until: NSPredicate { _, _ in codex.exists })
        XCTAssertTrue(codex.waitForExistence(timeout: 5), "The pill opens the settings sheet with the thread's provider")
        XCTAssertEqual(codex.value as? String, "Closed", "Its provider starts closed")
        XCTAssertFalse(byID("model-provider-claude").exists, "A thread's sheet offers only its own provider")
        XCTAssertFalse(astra.exists, "Closed, it shows none of its models")
        if size.isAccessibilityCategory {
            // Stacked at the accessibility sizes, each setting row keeps space above and below its name and value.
            let effort = menuItem("Effort"), speed = menuItem("Speed"), permissions = menuItem("Permissions")
            reveal(permissions, fullyVisible: true)
            XCTAssertTrue(effort.isHittable && speed.isHittable && permissions.isHittable, "All three rows show")
            XCTAssertLessThanOrEqual(effort.frame.maxY, speed.frame.minY + 1, "Effort ends before Speed starts")
            XCTAssertLessThanOrEqual(speed.frame.maxY, permissions.frame.minY + 1, "Speed ends before Permissions starts")
            capture("thread-settings-rows-large-dark")
            reveal(codex)
        }
        codex.tap()
        XCTAssertTrue(astra.waitForExistence(timeout: 5), "Opened, it lists the thread's own provider's models")
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
        launch(Self.fixture + ["--ui-thread-settings", "--ui-light", "--ui-reply-box-stays-full"])
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
    /// Puts an open menu away with a press above it, clear of the box; an open settings sheet with its Done.
    private func dismissMenu() {
        let done = byID("settings-sheet-done")
        if done.exists && done.isHittable { done.tap(); return }
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

    /// At the accessibility text sizes New thread's title takes its own line, clear of its buttons, and Settings' New
    /// thread defaults put each value under its name rather than cut it in the middle (#1857).
    func testSheetHeadersAndDefaultsStackAtTheLargestTextSizes() throws {
        // The narrow phone is where #1857 cut words off; the large phone, which runs at the accessibility sizes, has the
        // room. The small phone's job checks it (November 4, 2026).
        try XCTSkipIf(UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory, "The small phone checks this")
        launch(Self.fixture + ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"])
        app.buttons["new-thread"].tap()
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        let title = app.staticTexts["New thread"].firstMatch
        XCTAssertTrue(title.exists)
        XCTAssertFalse(title.frame.intersects(cancel.frame), "New thread's title doesn't run into Cancel")
        capture("new-thread-largest-text")
        cancel.tap()
        XCTAssertTrue(waitUntilGone(cancel))
        app.tab("Settings").tap()
        let modelDefault = byID("setting-default-model")
        // Plain swipes rather than `reveal`, whose drags no longer move Settings on main (#1752).
        for _ in 0..<20 where !(modelDefault.exists && modelDefault.isHittable) { app.swipeUp() }
        XCTAssertTrue(modelDefault.isHittable, "Settings scrolls to its New thread defaults")
        XCTAssertGreaterThan(modelDefault.frame.height, 70, "At the largest sizes the default's value sits under its name")
        capture("settings-defaults-largest-text")
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
