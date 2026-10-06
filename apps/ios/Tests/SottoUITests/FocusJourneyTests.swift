import XCTest

/// Runs the real SwiftUI hierarchy with isolated, in-memory host data. No host or account is used.
@MainActor final class FocusJourneyTests: XCTestCase {
    private let app = XCUIApplication()
    private let laptop = "11111111-1111-4111-8111-111111111111"
    private static let fixture = ["--ui-fixture", "--reset-ui-preferences"]

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        launch(Self.fixture)
        waitForRenderedOrientation(landscape: false)
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
    private func launch(_ arguments: [String]) {
        if appIsRunning {
            app.terminate()
            XCTAssertTrue(app.wait(for: .notRunning, timeout: 20), "The earlier copy of Sotto must stop before the next launch")
        }
        app.launchArguments = arguments
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "Sotto must come to the foreground after launch")
        XCTAssertTrue(app.textFields["thread-search"].waitForExistence(timeout: 20))
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
    private func reveal(_ element: XCUIElement, swipingDown: Bool = false) {
        var down = swipingDown
        var steps: [String] = []
        for attempt in 0..<40 {
            if element.exists && element.isHittable { return }
            // A full-window fling can skip a whole card. Keep each drag inside the foreground
            // scroll view, clear of the pinned search/header and the floating system tab bar.
            guard let scroll = app.scrollViews.allElementsBoundByIndex.last(where: { $0.isHittable }) else {
                steps.append("No hittable scroll view on attempt \(attempt)")
                break
            }
            let window = app.windows.firstMatch
            var visible = scroll.frame.intersection(window.frame)
            let tab = app.tabBars.firstMatch
            if tab.exists && tab.isHittable && tab.frame.minY > visible.minY {
                visible.size.height = min(visible.maxY, tab.frame.minY) - visible.minY
            }
            guard !visible.isNull, visible.width > 20, visible.height > 40 else {
                steps.append("No usable scroll viewport: \(visible)")
                break
            }
            if element.exists {
                let target = element.frame
                if !target.isEmpty {
                    if target.maxY <= visible.minY + 12 { down = true }
                    else if target.minY >= visible.maxY - 12 { down = false }
                }
                steps.append("\(attempt): target \(target), viewport \(visible), down \(down)")
            } else {
                steps.append("\(attempt): target not materialized, viewport \(visible), down \(down)")
            }
            let distance = min(120, visible.height * 0.3)
            let direction: CGFloat = down ? 1 : -1
            let origin = window.coordinate(withNormalizedOffset: .zero)
            let x = visible.midX - window.frame.minX
            let y = visible.midY - window.frame.minY
            let start = origin.withOffset(CGVector(dx: x, dy: y - direction * distance / 2))
            let end = origin.withOffset(CGVector(dx: x, dy: y + direction * distance / 2))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.15)
        }
        if element.exists && element.isHittable { return }
        capture("unreachable-control")
        let diagnostic = XCTAttachment(string: steps.joined(separator: "\n") + "\n\n" + app.debugDescription)
        diagnostic.name = "Scroll reachability and accessibility hierarchy"
        diagnostic.lifetime = .keepAlways
        add(diagnostic)
        XCTAssertTrue(element.isHittable, "The control must remain reachable by scrolling")
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
        let result = XCTWaiter.wait(for: [ready], timeout: 10)
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
    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
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
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: inView, object: nil)], timeout: 20)
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

    /// Scrolls the open thread's conversation until `target` can be pressed. Each drag runs down the page's trailing
    /// margin, clear of messages, code blocks and the back gesture's edge, between the bar and the reply box.
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
            let x = window.frame.width - 8
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
        app.buttons["new-thread"].tap()
        let offline = app.buttons["new-thread-computer-22222222-2222-4222-8222-222222222222"]
        XCTAssertTrue(offline.waitForExistence(timeout: 5))
        XCTAssertFalse(offline.isEnabled)
        capture("new-thread-computers-dark")
        app.buttons["new-thread-computer-\(laptop)"].tap()
        let project = app.buttons["new-thread-project-sotto"]
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

    func testCreateThreadByBrowsingANewFolder() { browseANewFolder() }
    /// The same journey with every looping animation stopped, to tell whether a running loop keeps Return from closing
    /// the folder filter's keyboard.
    func testCreateThreadByBrowsingANewFolderWithoutLoops() {
        launch(["--ui-fixture", "--reset-ui-preferences", "--ui-still"])
        browseANewFolder()
    }
    /// Return closes search's keyboard on Threads, with the page's loops running and with them stopped.
    func testSearchClosesOnReturn() { searchReturns() }
    func testSearchClosesOnReturnWithoutLoops() {
        launch(["--ui-fixture", "--reset-ui-preferences", "--ui-still"])
        searchReturns()
    }
    private func searchReturns() {
        let search = app.textFields["thread-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "Search opens the keyboard")
        search.typeText("Sim")
        search.typeText("\n")
        XCTAssertTrue(waitUntilGone(keyboard), "Return closes search's keyboard")
    }

    private func browseANewFolder() {
        app.tabBars.buttons["Settings"].tap()
        app.buttons["setting-light"].tap()
        app.tabBars.buttons["Threads"].tap()
        app.buttons["new-thread"].tap()
        app.buttons["new-thread-computer-\(laptop)"].tap()
        let browse = app.buttons["browse-project-folder"]
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
        let use = app.buttons["use-project-folder"]
        XCTAssertTrue(use.waitForExistence(timeout: 5)); XCTAssertTrue(use.isEnabled)
        capture("new-project-selected-folder-light")
        use.tap()
        let open = app.buttons["open-new-thread"]
        XCTAssertTrue(open.waitForExistence(timeout: 5)); XCTAssertTrue(open.isEnabled)
        let project = app.buttons["new-thread-change-project"]
        XCTAssertTrue(project.exists)
        XCTAssertEqual(project.label, "Change project, now New project", "The chosen folder names the project")
        capture("new-project-thread-options")
        open.tap()
        XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 5))
        capture("new-project-conversation")
    }

    func testFocusSearchAndNavigation() {
        XCTAssertTrue(app.tabBars.buttons["Threads"].isSelected)
        XCTAssertFalse(app.tabBars.buttons["Needs you"].exists)
        XCTAssertTrue(app.tabBars.buttons["Computers"].exists)
        XCTAssertTrue(app.tabBars.buttons["Settings"].exists)
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

        // Search's keyboard closes on a tap outside the field, and on scrolling the list. The summary above search is
        // somewhere to tap that does nothing else.
        let counts = byID("thread-counts")
        reveal(counts, swipingDown: true)
        reveal(search)
        let keyboard = app.keyboards.firstMatch
        search.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "Search opens the keyboard")
        XCTAssertTrue(counts.isHittable)
        counts.tap()
        XCTAssertTrue(waitUntilGone(keyboard), "A tap outside search closes its keyboard")
        search.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5), "Search opens the keyboard again")
        let window = app.windows.firstMatch
        let origin = window.coordinate(withNormalizedOffset: .zero)
        // iOS 26 draws its suggestion bar above the frame XCTest reports for the keyboard, so start well clear of it.
        let low = keyboard.frame.minY - 90
        let high = max(search.frame.maxY + 24, low - 120)
        let x = window.frame.width / 2
        origin.withOffset(CGVector(dx: x, dy: low - window.frame.minY))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: x, dy: high - window.frame.minY)),
                   withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(waitUntilGone(keyboard), "Scrolling the list closes search's keyboard")
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
        let step = byID("step-read")
        XCTAssertTrue(step.waitForExistence(timeout: 5), "Steps sit in the conversation; there is no Activity tab")
        XCTAssertTrue(step.label.contains("Read project notes"))
        XCTAssertFalse(app.buttons["thread-pane-activity"].exists)
        capture("thread-messages")
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
        let computers = app.tabBars.buttons["Computers"]
        XCTAssertTrue(computers.waitForExistence(timeout: 5), "Back restores the main tabs")
        computers.tap()
        XCTAssertTrue(app.buttons["Try reaching Studio Mac again"].waitForExistence(timeout: 5))
        capture("computers")
    }

    /// Thread page B: the conversation opens at its end and stays there while the reply keyboard opens and closes; the
    /// title block and Git chips scroll away with it; messages read as Markdown blocks.
    func testThreadPageKeepsItsPlaceAndReadsMarkdown() {
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        let title = byID("thread-title")
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Refine the iPhone thread view")
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        let running = byID("step-drawer-test")
        XCTAssertTrue(running.waitForExistence(timeout: 5), "The running step sits at the end of the conversation")
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

        scrollThread(to: title, towardStart: true)
        let chips = text("Branch feat/frosted-window-and-pane-terminal")
        XCTAssertTrue(chips.waitForExistence(timeout: 5), "The branch chip reads from the worktree's Git status")
        XCTAssertTrue(chips.label.contains("7 files changed, 212 lines added, 48 removed"))
        XCTAssertTrue(chips.label.contains("Pull request 721, draft"))
        capture("thread-glow-top")
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
        let running = byID("step-drawer-test")
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
        XCTAssertTrue(waitUntilGone(send), "The question closes once it is answered")
        let reply = byID("thread-reply")
        XCTAssertTrue(reply.waitForExistence(timeout: 5), "With nothing waiting, the reply box returns")
        XCTAssertTrue(labelled("Answer sent.").waitForExistence(timeout: 5))
        waitForEnd(running, last: update, above: reply, "Answering keeps the conversation at its end, not its top")
        XCTAssertLessThanOrEqual(byID("thread-title").frame.maxY, threadTop + 1, "The page never jumps to the title after an answer")
        capture("question-glow-after")
    }

    /// Settings on this iPhone: the look, alerts off until turned on, another theme, light, compact and larger text.
    func testSettingsThemeAppearanceDensityAndAlerts() {
        app.tabBars.buttons["Settings"].tap()
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

        let tropic = app.buttons["setting-theme-tropic"]
        reveal(tropic, swipingDown: true)
        tropic.tap()
        XCTAssertEqual(tropic.value as? String, "Selected")
        let sotto = app.buttons["setting-theme-sotto"]
        reveal(sotto, swipingDown: true)
        XCTAssertTrue(sotto.exists, "The other themes stay listed after a new one paints")
        XCTAssertEqual(sotto.value as? String, "Not selected")
        app.tabBars.buttons["Threads"].tap()
        XCTAssertTrue(app.textFields["thread-search"].waitForExistence(timeout: 5))
        capture("threads-glow-tropic")

        app.tabBars.buttons["Settings"].tap()
        let light = app.buttons["setting-light"]
        reveal(light, swipingDown: true)
        light.tap()
        XCTAssertEqual(light.value as? String, "Selected")
        app.tabBars.buttons["Threads"].tap()
        XCTAssertTrue(app.textFields["thread-search"].waitForExistence(timeout: 5))
        capture("threads-glow-tropic-light")

        app.tabBars.buttons["Settings"].tap()
        let compact = app.buttons["setting-density-compact"]
        reveal(compact)
        compact.tap()
        XCTAssertEqual(compact.value as? String, "Selected")
        let larger = app.buttons["setting-larger-text"]
        reveal(larger)
        larger.tap()
        XCTAssertEqual(larger.value as? String, "Selected")
        app.tabBars.buttons["Threads"].tap()
        let thread = row("iphone")
        reveal(thread)
        thread.tap()
        XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 5))
        XCTAssertTrue(byID("step-drawer-test").waitForExistence(timeout: 5))
        capture("thread-glow-compact-large")
    }

    /// New thread's fields open from anywhere in their box, and New worktree can be chosen.
    func testNewThreadFieldsOpenFromTheirWholeBox() {
        app.buttons["new-thread"].tap()
        let computer = app.buttons["new-thread-computer-\(laptop)"]
        XCTAssertTrue(computer.waitForExistence(timeout: 5))
        computer.tap()
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
    private func idleCPU(_ arguments: [String], openThread: Bool) {
        if !arguments.isEmpty { launch(["--ui-fixture", "--reset-ui-preferences"] + arguments) }
        if openThread {
            let thread = row("iphone")
            reveal(thread)
            thread.tap()
            XCTAssertTrue(byID("thread-title").waitForExistence(timeout: 5))
        } else {
            XCTAssertTrue(byID("thread-counts").waitForExistence(timeout: 5))
        }
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTCPUMetric(application: app)], options: options) {
            Thread.sleep(forTimeInterval: 3)
        }
    }
    func testIdleCPUOnThreads() { idleCPU([], openThread: false) }
    func testIdleCPUOnThreadsWithoutLoopingAnimations() { idleCPU(["--ui-still"], openThread: false) }
    func testIdleCPUInAThread() { idleCPU([], openThread: true) }
    func testIdleCPUInAThreadWithoutLoopingAnimations() { idleCPU(["--ui-still"], openThread: true) }

    /// Threads and Computers at the top in the Glow look, dark then light.
    func testThreadsAndComputersInTheGlowLook() {
        let counts = byID("thread-counts")
        XCTAssertTrue(counts.exists)
        XCTAssertTrue(counts.label.contains("2 working"), "The summary counts the threads at work")
        XCTAssertTrue(app.buttons["Try reaching Studio Mac again"].exists, "A computer that can't be reached offers Try again")
        capture("threads-glow-dark")
        app.tabBars.buttons["Computers"].tap()
        XCTAssertTrue(app.buttons["Add computer"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Try reaching Studio Mac again"].waitForExistence(timeout: 5))
        capture("computers-glow")
        app.tabBars.buttons["Settings"].tap()
        let light = app.buttons["setting-light"]
        XCTAssertTrue(light.waitForExistence(timeout: 5))
        light.tap()
        XCTAssertEqual(light.value as? String, "Selected")
        app.tabBars.buttons["Threads"].tap()
        XCTAssertTrue(app.textFields["thread-search"].waitForExistence(timeout: 5))
        capture("threads-glow-light")
        app.tabBars.buttons["Computers"].tap()
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
            app.tabBars.buttons["Settings"].tap()
            XCTAssertTrue(app.buttons["setting-light"].waitForExistence(timeout: 5))
            app.buttons["setting-light"].tap()
            let larger = app.buttons["setting-larger-text"]
            reveal(larger)
            larger.tap()
            app.tabBars.buttons["Threads"].tap()
            reveal(message, swipingDown: true)
            capture("feedback-" + scenario + "-light-larger-text")
            let dismiss = app.buttons["Dismiss message"]
            reveal(dismiss, swipingDown: true)
            dismiss.tap()
            XCTAssertFalse(message.exists)
        }
    }

    func testFolderReadTimeoutInBothAppearances() {
        launch(Self.fixture + ["--ui-folder-timeout"])
        for appearance in ["dark", "light"] {
            if appearance == "light" {
                app.tabBars.buttons["Settings"].tap()
                app.buttons["setting-light"].tap()
                let larger = app.buttons["setting-larger-text"]
                reveal(larger); larger.tap()
                app.tabBars.buttons["Threads"].tap()
            }
            app.buttons["new-thread"].tap()
            app.buttons["new-thread-computer-\(laptop)"].tap()
            let browse = app.buttons["browse-project-folder"]
            reveal(browse); browse.tap()
            let problem = app.staticTexts["Sotto did not answer in time. Try again."]
            XCTAssertTrue(problem.waitForExistence(timeout: 5))
            reveal(problem)
            XCTAssertFalse(app.staticTexts["Delivery is unconfirmed. Check the thread before sending again."].exists)
            capture("folder-read-timeout-" + appearance)
            app.buttons["Home"].tap()
            XCTAssertTrue(problem.waitForExistence(timeout: 5))
            app.buttons["Back"].tap()
            app.buttons["Cancel"].tap()
        }
    }

    func testAppearanceAndLargerTextPersist() {
        app.tabBars.buttons["Settings"].tap()
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
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(light.waitForExistence(timeout: 5))
        XCTAssertEqual(light.value as? String, "Selected", "Appearance persists across launch")
        reveal(larger)
        XCTAssertEqual(larger.value as? String, "Selected", "Larger text persists across launch")
        reveal(app.buttons["setting-dark"], swipingDown: true)
        app.buttons["setting-dark"].tap()
        XCTAssertEqual(app.buttons["setting-dark"].value as? String, "Selected")
        app.tabBars.buttons["Threads"].tap()
        capture("focus-dark-larger-text")
    }

    func testComputerScopePreservesSearchAndLandscape() {
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
        XCTAssertTrue(app.tabBars.buttons["Settings"].isHittable)
        XCUIDevice.shared.orientation = .portrait
        waitForRenderedOrientation(landscape: false)
    }
}
