import XCTest
import Combine
import SottoCore

/// The Watcher tab on the real AppModel, against a scripted computer that runs Watcher (ADR-0073, amended October 11,
/// 2026): only a computer that offers it gets a tab, the tab's dot and badge, answers that go to the thread that asked
/// under Can answer, Stop all that asks first, the box's one draft ID per exact text, and Watcher's own alerts.
final class WatcherModelTests: XCTestCase {
    private let laptop = "00000000-0000-4000-8000-000000000001"
    private let forge = "00000000-0000-4000-8000-000000000009"
    private static let watcherFeatures = ["host-folders", "watcher-phone", "watcher-phone-stop-all"]
    private var suites: [String] = []
    override func tearDown() {
        for suite in suites { UserDefaults().removePersistentDomain(forName: suite) }
        suites = []
        super.tearDown()
    }

    /// Lets the model's own tasks run until `condition` holds, or ten seconds pass.
    @MainActor private func until(_ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(10)
        while !condition() && Date() < deadline { await Task.yield() }
    }
    private func json(_ value: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(value.utf8)) }

    /// What Watcher's page holds in a test.
    private struct Spec {
        var working = true
        var status = "running"
        var ownCard = false
        var workerCard = true
        var remoteCard = false
        var mayAnswer = true
        var watched = true
        var takenOver = false
        var observedAt = "2026-10-11T09:00:00.000Z"
        /// Where drafts this iPhone sent stand, by draft ID, as the computer says.
        var deliveries: [String: String] = [:]
        /// Watcher's answer so far, after its first reply.
        var answer: String?
    }
    private static let workerRequest = #"{"id":"q1","kind":"question","text":"Which account?","options":[{"id":"a","label":"A fresh account"},{"id":"b","label":"The seeded user"}]}"#
    private static let ownRequest = #"{"id":"p1","kind":"permission","text":"Wants to run gh pr checks 845.","options":[]}"#

    /// Watcher's page as the laptop sends it: Watcher itself is thread `w`, and it works with `t`, Fix login test, which
    /// the laptop also lists. A remote card belongs to a thread on forge, which this iPhone doesn't list.
    private func page(_ spec: Spec = Spec()) -> String {
        var cards: [String] = []
        if spec.workerCard {
            cards.append(#"{"target":{"hostId":"\#(laptop)","threadId":"t"},"title":"Fix login test","provider":"claude","request":\#(Self.workerRequest),"connected":true,"mayAnswer":\#(spec.mayAnswer)}"#)
        }
        if spec.remoteCard {
            cards.append(#"{"target":{"hostId":"\#(forge)","threadId":"r"},"title":"Add Android share sheet","provider":"claude","request":{"id":"q2","kind":"question","text":"Which device?","options":[{"id":"x","label":"Pixel"}]},"connected":true,"mayAnswer":false}"#)
        }
        if spec.ownCard {
            cards.append(#"{"target":{"hostId":"\#(laptop)","threadId":"w"},"title":"Watcher","provider":"codex","request":\#(Self.ownRequest),"connected":true,"mayAnswer":\#(spec.mayAnswer)}"#)
        }
        let deliveries = spec.deliveries.map { draft, status in #"{"draftId":"\#(draft)","status":"\#(status)"}"# }.joined(separator: ",")
        let answer = spec.answer.map { #",{"id":"more","role":"assistant","text":"\#($0)","createdAt":"2026-10-11T08:02:00.000Z"}"# } ?? ""
        return #"""
        {"hostId":"\#(laptop)","current":{"target":{"hostId":"\#(laptop)","threadId":"w"},"provider":"codex","modelId":"m","reasoningEffort":"high","status":"\#(spec.status)","connected":true},
         "conversation":{"messages":[{"id":"ask","role":"user","text":"Fix the login test.","createdAt":"2026-10-11T08:00:00.000Z"},{"id":"started","role":"assistant","text":"Started it.","createdAt":"2026-10-11T08:01:00.000Z"}\#(answer)],"earlierAvailable":false,"revision":\#(spec.answer == nil ? 2 : 3)},
         "receiptGroups":[{"replyMessageId":"started","requestId":"aaaaaaaa-0000-4000-8000-000000000001","rows":[{"operationId":"bbbbbbbb-0000-4000-8000-000000000001","target":{"hostId":"\#(laptop)","threadId":"t"},"title":"Fix login test","provider":"claude","action":"start","deliveryState":"accepted","createdAt":"2026-10-11T08:01:00.000Z","updatedAt":"2026-10-11T08:01:00.000Z"}]}],
         "watchedThreads":[{"target":{"hostId":"\#(laptop)","threadId":"t"},"title":"Fix login test","provider":"claude","status":"running","connected":true,"watched":\#(spec.watched),"takenOver":\#(spec.takenOver),"backgroundWorkCount":0}],
         "needsYou":[\#(cards.joined(separator: ","))],"inFlight":1,"inFlightLimit":4,"working":\#(spec.working),"observedAt":"\#(spec.observedAt)",
         "draftDeliveries":[\#(deliveries)]}
        """#
    }
    private func decoded(_ spec: Spec = Spec()) throws -> WatcherPage {
        try JSONDecoder().decode(WatcherPage.self, from: Data(page(spec).utf8))
    }
    /// The laptop's shell, with Watcher's page when it runs Watcher. Fix login test waits on the same question its card does.
    private func shell(_ page: String?, mayAnswer: Bool, asking: Bool = true) throws -> JSONValue {
        let watcher = page.map { #","watcher":\#($0)"# } ?? ""
        let requests = asking ? Self.workerRequest : ""
        return try json(#"{"hostId":"\#(laptop)","clientCapabilities":{"mayAnswer":\#(mayAnswer)},"host":{"hostId":"\#(laptop)","name":"Laptop","threads":[{"id":"t","projectId":"p","title":"Fix login test","providerId":"claude","status":"running","requests":[\#(requests)]}],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}\#(watcher)}"#)
    }
    private func ok(_ page: String) throws -> JSONValue { try json(#"{"status":"ok","state":\#(page)}"#) }
    /// Forge's shell, when this iPhone is paired with it too: Add Android share sheet, waiting on these requests, and with
    /// `watcher`, forge's own Watcher page.
    private func forgeShell(_ requests: String, watcher: String? = nil) throws -> JSONValue {
        let page = watcher.map { #","watcher":\#($0)"# } ?? ""
        return try json(#"{"hostId":"\#(forge)","clientCapabilities":{"mayAnswer":true},"host":{"hostId":"\#(forge)","name":"Forge","threads":[{"id":"r","projectId":"p","title":"Add Android share sheet","providerId":"claude","status":"running","requests":[\#(requests)]}],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}\#(page)}"#)
    }
    /// Watcher's page as forge sends it when forge runs Watcher too: the laptop's page, with forge in the laptop's place.
    private func forgePage(_ spec: Spec) -> String { page(spec).replacingOccurrences(of: laptop, with: forge) }
    private func refusal(_ code: String, _ message: String) throws -> HostRefusal {
        HostRefusal(failure: try json(#"{"code":"\#(code)","message":"\#(message)"}"#).decode(WireFailure.self))
    }

    /// With `forge`, this iPhone is paired with forge too, and forge's thread waits on those requests.
    @MainActor private func fixture(features: [String] = WatcherModelTests.watcherFeatures, mayAnswer: Bool = true, spec: Spec? = Spec(),
                                    alerts: FakeAlerts? = nil, switches: [String: Bool] = [:], forge forgeRequests: String? = nil) async throws -> AppModel {
        TestKeychain.items = [:]; HostConnection.instances = []; HostConnection.afterGreeting = nil
        HostConnection.failDetail = false; HostConnection.failConnect = false; HostConnection.holdDetail = false
        HostConnection.connectAttempts = 0
        TestKeychain.locked = false; TestKeychain.unreadableAccount = nil; TestKeychain.unwritableAccount = nil
        HostConnection.mayAnswer = mayAnswer; HostConnection.loseAcknowledgement = false
        HostConnection.receipt = .object(["status": .string("unknown")]); HostConnection.receipts = [:]
        HostConnection.features = features; HostConnection.shells = [:]
        HostConnection.commandHandler = nil; HostConnection.folderHandler = nil; HostConnection.stageHandler = nil
        HostConnection.previewHandler = nil; HostConnection.terminalHandler = nil; HostConnection.watcherHandler = nil
        HostConnection.detail = try json(#"{"threadId":"t","revision":1,"messages":[]}"#)
        HostConnection.shells[laptop] = try shell(spec.map { page($0) }, mayAnswer: mayAnswer)
        let store = TestKeychain.store
        try store.write(forgeRequests == nil ? [laptop] : [laptop, forge], account: ComputerStore.indexAccount)
        let pairing = try json(#"{"v":1,"hostId":"\#(laptop)","clientId":"phone","token":"fixture"}"#).decode(Pairing.self)
        try store.write(SavedComputer(address: "https://laptop.example.ts.net:8443", pairing: pairing, reportedName: "Laptop"),
                        account: ComputerStore.account(laptop))
        if let forgeRequests {
            HostConnection.shells[forge] = try forgeShell(forgeRequests)
            let paired = try json(#"{"v":1,"hostId":"\#(forge)","clientId":"phone","token":"fixture"}"#).decode(Pairing.self)
            try store.write(SavedComputer(address: "https://forge.example.ts.net:8443", pairing: paired, reportedName: "Forge"),
                            account: ComputerStore.account(forge))
        }
        let model = AppModel(keychain: store, receiptSleep: { _ in })
        if let alerts {
            let suite = "sotto-watcher-tests-" + UUID().uuidString
            suites.append(suite)
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            for (key, on) in switches { defaults.set(on, forKey: key) }
            model.preferences = PhonePreferences(defaults: defaults)
            model.alerts = alerts
        }
        model.phase(.active); await model.reconnectAll(); await model.waitForActivation()
        return model
    }
    @MainActor private var connection: HostConnection {
        get throws { try XCTUnwrap(HostConnection.instances.last { $0.hostID == laptop }) }
    }
    private var worker: ThreadRef { ThreadRef(hostID: laptop, threadID: "t") }
    /// The laptop sends a new shell, with this page, as it does after anything changes there.
    @MainActor private func push(_ spec: Spec, mayAnswer: Bool = true) throws {
        let next = try shell(page(spec), mayAnswer: mayAnswer)
        HostConnection.shells[laptop] = next
        try connection.push(.shell(next.decode(Shell.self)))
    }

    // MARK: Which computers get a tab

    @MainActor func testOnlyAComputerThatOffersWatcherGetsATab() async throws {
        // An older computer, or a stable desktop: no watcher-phone, so no tab, nothing read, and no owl, even if a page
        // came along in its shell.
        let old = try await fixture(features: ["host-folders"])
        XCTAssertNil(old.watcherHostID)
        XCTAssertNil(old.watcherPage(laptop))
        XCTAssertEqual(old.watcherTab, WatcherTabState(working: false, needs: 0))
        XCTAssertFalse(old.watchedByWatcher(worker))
        XCTAssertTrue(old.watchedThreadIDs.isEmpty)
        XCTAssertTrue(try connection.watcherCalls.isEmpty, "A computer that doesn't offer Watcher is never asked for it")
        old.phase(.background)

        // An Owl desktop that runs Watcher, with this iPhone opted in: the tab is its, and its page comes with hello's
        // shell, so nothing more is read.
        let owl = try await fixture()
        XCTAssertEqual(owl.watcherHostID, laptop)
        XCTAssertEqual(owl.watcherPage(laptop)?.current?.target, WatcherTarget(hostId: laptop, threadId: "w"))
        XCTAssertTrue(try connection.watcherCalls.isEmpty)
        XCTAssertEqual(owl.watcherModel(laptop), "Codex · m")
        owl.phase(.background)
    }

    @MainActor func testAPageThatCantBeReadSaysWhatHappened() async throws {
        // Hello came without Watcher's page, and the read after it fails.
        let model = try await fixture(spec: nil)
        await until { model.watcherReadProblems[laptop] != nil }
        XCTAssertNil(model.watcherPage(laptop))
        XCTAssertEqual(model.watcherReadProblems[laptop], "Watcher on Laptop couldn’t be read. Nothing was lost. Pull down to read it again.",
                       "It says what happened, rather than reading for good")
        XCTAssertEqual(model.watcherSendHeld(laptop), model.watcherReadProblems[laptop], "The box says why it can't send")
        // Refused, the computer's own words say why.
        HostConnection.watcherHandler = { _, _, _ in
            try self.json(#"{"status":"refused","code":"UNAVAILABLE","message":"Watcher is starting on Laptop. Try again in a moment.","retryable":true}"#)
        }
        await model.readWatcher(laptop)
        XCTAssertEqual(model.watcherReadProblems[laptop], "Watcher is starting on Laptop. Try again in a moment.")
        // Read, the page shows and the problem goes.
        HostConnection.watcherHandler = { _, _, _ in try self.ok(self.page()) }
        await model.readWatcher(laptop)
        XCTAssertNotNil(model.watcherPage(laptop))
        XCTAssertNil(model.watcherReadProblems[laptop])
        XCTAssertNil(model.watcherSendHeld(laptop))
        model.phase(.background)
    }

    @MainActor func testAReadAskedForDuringAFailedReadStillRuns() async throws {
        let model = try await fixture()
        var reads = 0
        var held: CheckedContinuation<JSONValue, Error>?
        HostConnection.watcherHandler = { op, _, _ in
            guard op == "watcher-phone-read" else { return .null }
            reads += 1
            if reads == 1 { return try await withCheckedThrowingContinuation { held = $0 } }
            return try self.ok(self.page(Spec(working: false, status: "idle", observedAt: "2026-10-11T09:05:00.000Z")))
        }
        let first = Task { await model.readWatcher(laptop) }
        await until { held != nil }
        // A pull to refresh asks for another read while the first is on its way; then the first fails.
        await model.readWatcher(laptop)
        held?.resume(throwing: ClientError.disconnected)
        await first.value
        XCTAssertEqual(reads, 2, "The read asked for while the first was on its way still runs after the first fails")
        XCTAssertEqual(model.watcherPage(laptop)?.working, false, "And its page shows")
        XCTAssertNil(model.watcherReadProblems[laptop], "The read that worked clears the first one's problem")
        model.phase(.background)
    }

    @MainActor func testTheTabsDotAndBadgeSayWhatOnlyWatchersPageShows() async throws {
        // Fix login test's card is on Threads too, so the badge counts Watcher's own request and the forge thread's.
        let model = try await fixture(spec: Spec(ownCard: true, remoteCard: true))
        XCTAssertEqual(model.watcherTab, WatcherTabState(working: true, needs: 2))
        XCTAssertEqual(model.watcherTab.spoken, "Working, 2 need you")
        try push(Spec(working: false, status: "idle", workerCard: true, observedAt: "2026-10-11T09:01:00.000Z"))
        await until { model.watcherTab == WatcherTabState(working: false, needs: 0) }
        XCTAssertEqual(model.watcherTab, WatcherTabState(working: false, needs: 0), "No dot once Watcher is idle, no badge once nothing waits")
        XCTAssertEqual(model.watcherTab.spoken, "")
        // A computer that can't be reached claims neither.
        try push(Spec(ownCard: true, observedAt: "2026-10-11T09:02:00.000Z"))
        await until { model.watcherTab.needs == 1 }
        try connection.onDisconnect?()
        XCTAssertEqual(model.watcherTab, WatcherTabState(working: false, needs: 0))
        model.phase(.background)

        XCTAssertEqual(WatcherTabState(working: true, needs: 0).spoken, "Working")
        XCTAssertEqual(WatcherTabState(working: false, needs: 1).spoken, "1 needs you")
    }

    @MainActor func testAWatcherAlertFromAnotherComputerShowsThatComputersWatcher() async throws {
        let alerts = FakeAlerts()
        let model = try await fixture(alerts: alerts, switches: [PhonePreferenceKey.notifyNeedsYou: true], forge: "")
        XCTAssertEqual(model.watcherHostIDs, [laptop, forge], "Both computers run Watcher")
        XCTAssertEqual(model.watcherHostID, laptop, "The first that runs Watcher shows until another is chosen")
        // The Watcher tab is on screen, showing the laptop's Watcher. Forge's Watcher reads its page, then asks something.
        model.watcherOnScreen = true
        let forgeConnection = try XCTUnwrap(HostConnection.instances.last { $0.hostID == forge })
        let quiet = try forgeShell("", watcher: forgePage(Spec(observedAt: "2026-10-11T09:01:00.000Z")))
        forgeConnection.push(.shell(try quiet.decode(Shell.self)))
        let asking = try forgeShell("", watcher: forgePage(Spec(ownCard: true, observedAt: "2026-10-11T09:02:00.000Z")))
        forgeConnection.push(.shell(try asking.decode(Shell.self)))
        await until { !alerts.posted.isEmpty }
        XCTAssertEqual(alerts.posted.map(\.alert.body), ["Watcher is asking for permission on Forge."],
                       "Another computer's Watcher still alerts while the tab shows the laptop's")
        // Its alert opens forge's Watcher.
        let alert = try XCTUnwrap(alerts.posted.first?.alert)
        model.openFromAlert(alert.ref, watcher: true)
        XCTAssertEqual(model.watcherAlertOpened, forge)
        XCTAssertEqual(model.watcherHostID, forge, "The alert's computer's Watcher is the one the tab shows")
        // With forge's on screen, the laptop's Watcher alerts.
        try push(Spec(ownCard: true, observedAt: "2026-10-11T09:03:00.000Z"))
        await until { alerts.posted.count == 2 }
        XCTAssertEqual(alerts.posted.map(\.alert.body).last, "Watcher is asking for permission on Laptop.")
        // The header's menu goes back.
        model.chooseWatcher(laptop)
        XCTAssertEqual(model.watcherHostID, laptop)
        model.phase(.background)
    }

    // MARK: The owl and the takeover line

    @MainActor func testAWatchedThreadCarriesTheOwlUntilItIsTakenOver() async throws {
        let model = try await fixture()
        XCTAssertTrue(model.watchedByWatcher(worker), "Its reply box carries the takeover line and its rows the owl")
        XCTAssertEqual(model.watchedThreadIDs, [worker.id])
        XCTAssertEqual(WatchedWords.takeover, "Watched by Watcher. If you send here, Watcher stops sending to it.")
        XCTAssertEqual(WatchedWords.label, "Watched by Watcher")
        try push(Spec(watched: false, takenOver: true, observedAt: "2026-10-11T09:01:00.000Z"))
        await until { !model.watchedByWatcher(worker) }
        XCTAssertFalse(model.watchedByWatcher(worker), "A thread the user took over loses the owl and the line")
        XCTAssertEqual(model.watcherPage(laptop)?.noLongerWatched.map(\.title), ["Fix login test"])
        XCTAssertEqual(WatcherWords.left(try XCTUnwrap(model.watcherPage(laptop)?.noLongerWatched.first)), "You took it over")
        model.phase(.background)
    }

    @MainActor func testWatchersGrowingConversationPublishesOnlyOnItsStore() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        var onModel = 0, onStore = 0
        let watchingModel = model.objectWillChange.sink { onModel += 1 }
        let watchingStore = model.watcherStore.objectWillChange.sink { onStore += 1 }
        defer { watchingModel.cancel(); watchingStore.cancel() }
        // Watcher's answer grows with each shell its computer sends.
        try push(Spec(workerCard: false, observedAt: "2026-10-11T09:01:00.000Z", answer: "Checking"))
        try push(Spec(workerCard: false, observedAt: "2026-10-11T09:01:01.000Z", answer: "Checking the release notes"))
        await until { model.watcherPage(laptop)?.conversation.messages.last?.text == "Checking the release notes" }
        XCTAssertEqual(model.watcherPage(laptop)?.conversation.messages.last?.text, "Checking the release notes")
        XCTAssertGreaterThan(onStore, 0)
        XCTAssertEqual(onModel, 0, "Watcher's conversation growing redraws the Watcher tab, not every view that watches the model")
        XCTAssertTrue(try connection.watcherCalls.isEmpty, "The page came with the shells")
        // What the rest of the app reads still publishes on the model when it changes.
        try push(Spec(working: false, status: "idle", workerCard: false, observedAt: "2026-10-11T09:01:02.000Z"))
        await until { !model.watcherTab.working }
        XCTAssertGreaterThan(onModel, 0)
        XCTAssertFalse(model.watcherTab.working)
        model.phase(.background)
    }

    @MainActor func testAnOlderPageNeverReplacesANewerOne() throws {
        let newer = try decoded(Spec(observedAt: "2026-10-11T09:05:00.000Z"))
        let older = try decoded(Spec(watched: false, observedAt: "2026-10-11T09:04:59.000Z"))
        XCTAssertTrue(older.isOlder(than: newer))
        XCTAssertFalse(newer.isOlder(than: older))
        XCTAssertFalse(newer.isOlder(than: newer))
    }

    // MARK: Cards in Watcher's page (4B)

    @MainActor func testACardInWatchersPageIsAnsweredAsTheUsersOwnAnswerToItsThread() async throws {
        var sent: [String: JSONValue] = [:]
        HostConnection.watcherHandler = nil
        let model = try await fixture()
        let answered = page(Spec(workerCard: false, observedAt: "2026-10-11T09:01:00.000Z"))
        HostConnection.watcherHandler = { op, operation, _ in
            if op == "watcher-phone-answer" {
                sent = operation
                HostConnection.shells[self.laptop] = try self.shell(answered, mayAnswer: true, asking: false)
                return try self.ok(answered)
            }
            return try self.ok(self.page())
        }
        HostConnection.receipt = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
        let card = try XCTUnwrap(model.watcherPage(laptop)?.needsYou.first { $0.target.threadId == "t" })
        XCTAssertTrue(model.canAnswerWatcherCard(card, on: laptop))
        await model.answerWatcherCard(card, on: laptop, choice: "a")
        let request = try XCTUnwrap(sent["request"])
        XCTAssertEqual(request["target"], .object(["hostId": .string(laptop), "threadId": .string("t")]))
        XCTAssertEqual(request["command"]["type"], .string("answer"))
        XCTAssertEqual(request["command"]["threadId"], .string("t"))
        XCTAssertEqual(request["command"]["requestId"], .string("q1"))
        XCTAssertEqual(request["command"]["answer"], .string("a"))
        XCTAssertFalse(try connection.operations.contains("command"), "The answer goes through Watcher's page, not as an ordinary command")
        XCTAssertTrue(model.pending.isEmpty, "Its own receipt confirmed it")
        XCTAssertNil(model.watcherAnswerMarker(card, on: laptop))
        XCTAssertEqual(model.feedback, "Answer sent.")
        XCTAssertTrue(model.answerConfirmed("q1", in: worker))
        XCTAssertNil(model.watcherPage(laptop)?.card(card.target.ref, requestID: "q1"))
        model.phase(.background)
    }

    @MainActor func testAPhoneWithoutCanAnswerSendsNoAnswer() async throws {
        let model = try await fixture(mayAnswer: false, spec: Spec(mayAnswer: false))
        let card = try XCTUnwrap(model.watcherPage(laptop)?.needsYou.first)
        XCTAssertFalse(model.canAnswerWatcherCard(card, on: laptop))
        XCTAssertFalse(model.mayAnswer(at: .watcher(hostID: laptop, target: card.target.ref)))
        await model.answerWatcherCard(card, on: laptop, choice: "a")
        XCTAssertTrue(try connection.watcherCalls.isEmpty, "Nothing was sent")
        XCTAssertTrue(model.pending.isEmpty)
        model.phase(.background)
    }

    @MainActor func testAnAnswerTheComputerRefusesLeavesNothingWaitingAndSaysWhy() async throws {
        let model = try await fixture()
        HostConnection.watcherHandler = { op, _, _ in
            if op == "watcher-phone-answer" { throw try self.refusal("forbidden", "This iPhone can’t answer on Laptop.") }
            return try self.ok(self.page())
        }
        let card = try XCTUnwrap(model.watcherPage(laptop)?.needsYou.first)
        XCTAssertTrue(model.canAnswerWatcherCard(card, on: laptop))
        await model.answerWatcherCard(card, on: laptop, choice: "a")
        XCTAssertTrue(model.pending.isEmpty, "A refused answer leaves no marker")
        XCTAssertFalse(model.mayAnswer(laptop), "Refused for authority, the phone stops offering answers there")
        XCTAssertFalse(model.canAnswerWatcherCard(card, on: laptop))
        XCTAssertEqual(model.feedback, "This iPhone can’t answer on Laptop.")
        model.phase(.background)
    }

    @MainActor func testTheRequestSheetReadsACardWhereItWaits() async throws {
        let model = try await fixture(spec: Spec(ownCard: true, remoteCard: true))
        let own = RequestPlace.watcher(hostID: laptop, target: ThreadRef(hostID: laptop, threadID: "w"))
        XCTAssertEqual(model.waitingRequest("p1", at: own)?.kind, "permission")
        XCTAssertEqual(model.requestOwner(own)?.title, "Watcher")
        XCTAssertTrue(model.mayAnswer(at: own))
        let remote = RequestPlace.watcher(hostID: laptop, target: ThreadRef(hostID: forge, threadID: "r"))
        XCTAssertEqual(model.requestOwner(remote)?.title, "Add Android share sheet")
        XCTAssertFalse(model.mayAnswer(at: remote), "A card on another computer isn't answered from here yet")
        XCTAssertEqual(remote.hostID, laptop, "Its answer would go to the computer that runs Watcher")
        XCTAssertNil(model.waitingRequest("gone", at: own))
        XCTAssertEqual(model.waitingRequest("q1", at: .thread(worker))?.id, "q1", "A thread's own request reads as before")
        model.phase(.background)
    }

    @MainActor func testACardForAThreadOnAnotherComputerIsAnsweredOnlyWhileThatComputerHoldsIt() async throws {
        let remote = #"{"id":"q2","kind":"question","text":"Which device?","options":[{"id":"x","label":"Pixel"}]}"#
        let model = try await fixture(spec: Spec(remoteCard: true), forge: remote)
        let ref = ThreadRef(hostID: forge, threadID: "r")
        await until { model.thread(ref) != nil }
        let card = try XCTUnwrap(model.watcherPage(laptop)?.needsYou.first { $0.target.hostId == forge })
        XCTAssertEqual(model.watcherCardPlace(card, on: laptop), .thread(ref), "Its answer goes to its own computer")
        guard case .answer(let place, let request) = model.watcherCardRoute(card, on: laptop) else {
            return XCTFail("Forge holds the request, so the card can be answered")
        }
        XCTAssertEqual(place, .thread(ref))
        XCTAssertEqual(request.id, "q2", "With forge's own copy of the request")

        // Forge no longer holds it, though Watcher's page still shows the card: nothing is offered, and the card says why.
        let forgeConnection = try XCTUnwrap(HostConnection.instances.last { $0.hostID == forge })
        let answered = try forgeShell("")
        HostConnection.shells[forge] = answered
        forgeConnection.push(.shell(try answered.decode(Shell.self)))
        await until { model.thread(ref)?.requests.isEmpty == true }
        XCTAssertNotNil(model.watcherPage(laptop)?.card(ref, requestID: "q2"), "Watcher's page still shows its card")
        XCTAssertEqual(model.watcherCardRoute(card, on: laptop), .note("This request is no longer waiting on Forge. Nothing was answered."))
        // A computer this iPhone can't reach now can't say it still holds it.
        forgeConnection.onDisconnect?()
        XCTAssertEqual(model.watcherCardRoute(card, on: laptop), .note("Reconnect to Forge to answer this one."))
        model.phase(.background)
    }

    // MARK: Stop all

    @MainActor func testStopAllAsksFirstAndStopsOnlyWhatWasConfirmed() async throws {
        let model = try await fixture()
        let confirmation = "cccccccc-0000-4000-8000-000000000001"
        var stopped: JSONValue?
        HostConnection.watcherHandler = { op, operation, _ in
            switch op {
            case "watcher-phone-prepare-stop-all":
                return try self.json(#"{"status":"ok","confirmationId":"\#(confirmation)","targets":[{"hostId":"\#(self.laptop)","threadId":"t","title":"Fix login test","provider":"claude"}],"expiresAt":"2026-10-11T09:10:00.000Z"}"#)
            case "watcher-phone-stop-all":
                stopped = operation["confirmationId"]
                let after = self.page(Spec(working: false, status: "idle", watched: false, observedAt: "2026-10-11T09:02:00.000Z"))
                return try self.json(#"{"status":"ok","state":\#(after),"results":[{"target":{"hostId":"\#(self.laptop)","threadId":"t"},"status":"stopped","message":"Stopped."}]}"#)
            default:
                return try self.ok(self.page())
            }
        }
        let prepared = await model.prepareWatcherStop(laptop)
        let preview = try XCTUnwrap(prepared)
        XCTAssertEqual(preview.targets.map(\.title), ["Fix login test"])
        XCTAssertEqual(WatcherWords.stopQuestion(preview.targets.count), "Stop the thread Watcher started?")
        XCTAssertEqual(WatcherWords.stopQuestion(3), "Stop the 3 threads Watcher started?")
        XCTAssertNil(stopped, "Preparing stops nothing; cancelling the question sends nothing more")
        XCTAssertTrue(model.watchedByWatcher(worker))
        await model.confirmWatcherStop(preview, on: laptop)
        XCTAssertEqual(stopped, .string(confirmation), "Only the confirmed preview goes")
        XCTAssertEqual(model.feedback, "Stopped 1 thread Watcher started.")
        XCTAssertFalse(model.watchedByWatcher(worker))
        XCTAssertTrue(model.watcherStopping.isEmpty)
        model.phase(.background)
    }

    @MainActor func testALostStopAllAcknowledgementReadsItsReceipt() async throws {
        let model = try await fixture()
        let confirmation = "cccccccc-0000-4000-8000-000000000002"
        var stops: [String] = []
        HostConnection.watcherHandler = { op, _, id in
            switch op {
            case "watcher-phone-prepare-stop-all":
                return try self.json(#"{"status":"ok","confirmationId":"\#(confirmation)","targets":[{"hostId":"\#(self.laptop)","threadId":"t","title":"Fix login test","provider":"claude"},{"hostId":"\#(self.forge)","threadId":"r","title":"Add Android share sheet","provider":"claude"}],"expiresAt":"2026-10-11T09:10:00.000Z"}"#)
            case "watcher-phone-stop-all":
                stops.append(id)
                // The computer stops what it can and keeps the outcome under this request's ID; the acknowledgement is lost.
                HostConnection.receipts[id] = try self.json(#"{"status":"completed","watcherStop":{"status":"ok","results":[{"target":{"hostId":"\#(self.laptop)","threadId":"t"},"status":"stopped","message":"Stopped."},{"target":{"hostId":"\#(self.forge)","threadId":"r"},"status":"uncertain","message":"No answer."}]}}"#)
                throw ClientError.uncertain
            default:
                return try self.ok(self.page(Spec(working: false, status: "idle", watched: false, observedAt: "2026-10-11T09:02:00.000Z")))
            }
        }
        let prepared = await model.prepareWatcherStop(laptop)
        let preview = try XCTUnwrap(prepared)
        await model.confirmWatcherStop(preview, on: laptop)
        XCTAssertEqual(stops.count, 1, "Stop all is never sent again on its own")
        XCTAssertTrue(try connection.operations.contains("receipt"), "Its receipt is read")
        XCTAssertEqual(model.feedback, "Stopped 1 of 2. Add Android share sheet isn’t confirmed.",
                       "The receipt under Stop all's own request ID says what it did, thread by thread")
        XCTAssertFalse(model.watchedByWatcher(worker), "And Watcher's page is read again")
        XCTAssertTrue(model.watcherStopping.isEmpty)

        // A receipt the computer no longer has leaves Stop all unconfirmed, and still nothing is sent again.
        HostConnection.watcherHandler = { op, _, id in
            switch op {
            case "watcher-phone-prepare-stop-all":
                return try self.json(#"{"status":"ok","confirmationId":"\#(confirmation)","targets":[{"hostId":"\#(self.laptop)","threadId":"t","title":"Fix login test","provider":"claude"}],"expiresAt":"2026-10-11T09:10:00.000Z"}"#)
            case "watcher-phone-stop-all":
                stops.append(id)
                throw ClientError.uncertain
            default:
                return try self.ok(self.page(Spec(working: false, status: "idle", watched: false, observedAt: "2026-10-11T09:03:00.000Z")))
            }
        }
        let again = await model.prepareWatcherStop(laptop)
        let next = try XCTUnwrap(again)
        await model.confirmWatcherStop(next, on: laptop)
        XCTAssertEqual(stops.count, 2)
        XCTAssertNotEqual(stops[1], stops[0], "Each Stop all the user confirms has its own request ID")
        XCTAssertEqual(model.feedback, "Stop all isn’t confirmed. Check Watched before you stop anything again.")
        model.phase(.background)
    }

    @MainActor func testStopAllIsOnlyOfferedWhereTheComputerOffersIt() async throws {
        let model = try await fixture(features: ["host-folders", "watcher-phone"])
        XCTAssertNotNil(model.watcherHostID)
        XCTAssertFalse(model.offersWatcherStop(laptop))
        let preview = await model.prepareWatcherStop(laptop)
        XCTAssertNil(preview)
        XCTAssertTrue(try connection.watcherCalls.isEmpty, "Nothing was asked of the computer")
        model.phase(.background)
    }

    @MainActor func testARefusedOrPartialStopAllSaysWhatHappened() async throws {
        let model = try await fixture()
        HostConnection.watcherHandler = { op, _, _ in
            if op == "watcher-phone-prepare-stop-all" {
                return try self.json(#"{"status":"refused","code":"TARGET_CHANGED","message":"Watcher changed. Nothing was stopped.","retryable":true}"#)
            }
            return try self.ok(self.page())
        }
        let refused = await model.prepareWatcherStop(laptop)
        XCTAssertNil(refused)
        XCTAssertEqual(model.feedback, "Watcher changed. Nothing was stopped.")
        model.phase(.background)
        let outcome = try json(#"[{"target":{"hostId":"\#(laptop)","threadId":"t"},"status":"stopped","message":"Stopped."},{"target":{"hostId":"\#(forge)","threadId":"r"},"status":"uncertain","message":"No answer."}]"#)
            .decode([WatcherStopResult.StoppedTarget].self)
        XCTAssertEqual(WatcherWords.stopped(outcome, titles: [ThreadRef(hostID: forge, threadID: "r").id: "Add Android share sheet"]),
                       "Stopped 1 of 2. Add Android share sheet isn’t confirmed.")
    }

    // MARK: Asking Watcher

    @MainActor func testTheSameWordsKeepOneDraftIDAndNothingIsResentOnItsOwn() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        var requests: [JSONValue] = []
        var reply = "lose"
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send", let request = operation["request"] else { return try self.ok(self.page(Spec(workerCard: false))) }
            requests.append(request)
            switch reply {
            case "lose": throw ClientError.uncertain
            case "refuse":
                return try self.json(#"{"status":"refused","code":"TARGET_CHANGED","message":"Watcher changed. Nothing new was sent.","retryable":true}"#)
            default:
                return try self.json(#"{"status":"ok","draftId":"\#(request["draftId"].string ?? "")","state":\#(self.page(Spec(workerCard: false, observedAt: "2026-10-11T09:03:00.000Z")))}"#)
            }
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "Check the release notes"
        XCTAssertTrue(model.canSendToWatcher(laptop))
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.drafts[key], "Check the release notes", "Unconfirmed words go back in the box")
        XCTAssertEqual(model.feedback, "Watcher didn’t confirm your message, so it’s back in the box. Check the conversation before you send it again.")
        XCTAssertEqual(requests.count, 1, "Nothing is sent again on its own")
        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0]["draftId"], requests[1]["draftId"], "The same words go with the same draft ID")
        reply = "refuse"
        model.drafts[key] = "Check the release notes now"
        await model.sendToWatcher(laptop)
        XCTAssertNotEqual(requests[2]["draftId"], requests[1]["draftId"], "Other words get a new draft ID")
        XCTAssertEqual(model.drafts[key], "Check the release notes now")
        XCTAssertEqual(model.feedback, "Watcher changed. Nothing new was sent.")
        reply = "ok"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests[3]["draftId"], requests[2]["draftId"])
        XCTAssertEqual(model.drafts[key], "", "Taken, the words leave the box")
        XCTAssertNil(model.watcherSending[laptop])
        let last = try XCTUnwrap(requests.last)
        XCTAssertEqual(last["origin"], .object(["kind": .string("phone"), "hostId": .string(laptop), "clientId": .string("phone")]))
        XCTAssertEqual(last["target"], .object(["hostId": .string(laptop), "threadId": .string("w")]))
        XCTAssertEqual(last["text"], .string("Check the release notes now"))
        XCTAssertNotNil(UUID(uuidString: last["draftId"].string ?? ""))

        // Lost again, then the laptop's next page says Watcher took those exact words: they leave the box, unsent again.
        reply = "lose"
        model.drafts[key] = "And the webhook thread?"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.drafts[key], "And the webhook thread?")
        let lost = try XCTUnwrap(requests.last?["draftId"].string)
        try push(Spec(workerCard: false, observedAt: "2026-10-11T09:04:00.000Z", deliveries: [lost: "accepted"]))
        await until { model.drafts[key] == "" }
        XCTAssertEqual(model.drafts[key], "", "Watcher took them")
        XCTAssertNil(model.feedback, "Nothing is left to check")
        XCTAssertEqual(requests.count, 5, "Nothing was sent again")
        model.phase(.background)
    }

    @MainActor func testUnconfirmedWordsKeepTheirDraftIDThroughOtherWords() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        var requests: [JSONValue] = []
        var reply = "lose"
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send", let request = operation["request"] else { return try self.ok(self.page(Spec(workerCard: false))) }
            requests.append(request)
            if reply == "lose" { throw ClientError.uncertain }
            return try self.json(#"{"status":"refused","code":"TARGET_CHANGED","message":"Watcher changed. Nothing new was sent.","retryable":true}"#)
        }
        let key = model.watcherDraftKey(laptop)
        // The first words' acknowledgement is lost: Watcher may have taken them.
        model.drafts[key] = "Stop the webhook thread"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.drafts[key], "Stop the webhook thread")
        // The user writes something else instead, and the computer refuses it.
        reply = "refuse"
        model.drafts[key] = "Check the webhook thread first"
        await model.sendToWatcher(laptop)
        XCTAssertNotEqual(requests[1]["draftId"], requests[0]["draftId"], "Other words get a new draft ID")
        // Back to the first words: they go with their first ID, so the computer can't deliver them twice.
        model.drafts[key] = "Stop the webhook thread"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests.count, 3, "Nothing is sent again on its own")
        XCTAssertEqual(requests[2]["draftId"], requests[0]["draftId"], "Unconfirmed words keep their draft ID through other words")
        model.phase(.background)

        var drafts = WatcherDrafts()
        let first = drafts.id(for: "One")
        for index in 0..<WatcherDrafts.limit - 1 { _ = drafts.id(for: "Other \(index)") }
        XCTAssertEqual(drafts.id(for: "One"), first, "Kept while fewer than the limit went unconfirmed after it")
        _ = drafts.id(for: "One more")
        XCTAssertEqual(drafts.unresolved.count, WatcherDrafts.limit, "Never more than the limit")
        XCTAssertNotEqual(drafts.id(for: "One"), first, "Past the limit, the oldest is let go")
        let other = drafts.id(for: "Other 5")
        drafts.resolve(other.uppercased())
        XCTAssertNotEqual(drafts.id(for: "Other 5"), other, "Taken, the same words get a new ID")
    }

    @MainActor func testThePageReadAfterALostAcknowledgementSettlesTheWords() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        var sends = 0
        var sentDraft = ""
        HostConnection.watcherHandler = { op, operation, _ in
            if op == "watcher-phone-send" {
                sends += 1
                guard let request = operation["request"] else { throw ClientError.invalidRequest }
                sentDraft = request["draftId"].string ?? ""
                throw ClientError.uncertain
            }
            // Watcher took the words before their acknowledgement was lost, and the page read after it says so.
            return try self.ok(self.page(Spec(workerCard: false, observedAt: "2026-10-11T09:05:00.000Z", deliveries: [sentDraft: "accepted"])))
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "Stop the webhook thread"
        await model.sendToWatcher(laptop)
        XCTAssertTrue(try connection.operations.contains("watcher-phone-read"), "The page is read after the lost acknowledgement")
        XCTAssertEqual(model.watcherPage(laptop)?.delivery(of: sentDraft), "accepted")
        XCTAssertEqual(model.drafts[key], "", "That page says Watcher took the words, so they leave the box")
        XCTAssertNil(model.feedback, "Nothing is left to check")
        XCTAssertEqual(sends, 1, "Nothing was sent again")
        model.phase(.background)
    }

    @MainActor func testWordsThatDidntReachWatcherAreOfferedBackWhenNewerWordsAreInTheBox() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        let key = model.watcherDraftKey(laptop)
        var reply = "refuse"
        HostConnection.watcherHandler = { op, _, _ in
            guard op == "watcher-phone-send" else { return try self.ok(self.page(Spec(workerCard: false))) }
            // The user writes something new while the first words are on their way.
            model.drafts[key] = "And the webhook thread?"
            if reply == "lose" { throw ClientError.uncertain }
            return try self.json(#"{"status":"refused","code":"TARGET_CHANGED","message":"Watcher changed. Nothing new was sent.","retryable":true}"#)
        }
        model.drafts[key] = "Stop the release notes thread"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.drafts[key], "And the webhook thread?", "The newer words stay in the box")
        XCTAssertEqual(model.watcherSetAside[laptop], [WatcherSetAside(text: "Stop the release notes thread", unconfirmed: false)],
                       "The refused words are kept, to be offered back")
        XCTAssertEqual(model.feedback, "Watcher changed. Nothing new was sent.")
        let refused = try XCTUnwrap(model.watcherSetAside[laptop]?.first)
        model.restoreWatcherWords(refused, on: laptop)
        XCTAssertEqual(model.drafts[key], "And the webhook thread?", "Put back only into an empty box")
        model.drafts[key] = ""
        model.restoreWatcherWords(refused, on: laptop)
        XCTAssertEqual(model.drafts[key], "Stop the release notes thread")
        XCTAssertNil(model.watcherSetAside[laptop])

        // Unconfirmed, the message says where the words are, not that they are back in the box.
        reply = "lose"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.drafts[key], "And the webhook thread?")
        XCTAssertEqual(model.watcherSetAside[laptop], [WatcherSetAside(text: "Stop the release notes thread", unconfirmed: true)])
        XCTAssertEqual(model.feedback, AppModel.watcherUnconfirmedSetAside)
        model.phase(.background)
    }

    @MainActor func testWatcherWaitsForItsOwnRequestBeforeTakingMore() async throws {
        let model = try await fixture(spec: Spec(ownCard: true))
        model.drafts[model.watcherDraftKey(laptop)] = "And the webhook thread?"
        XCTAssertEqual(model.watcherSendHeld(laptop), "Answer Watcher’s request first.")
        XCTAssertFalse(model.canSendToWatcher(laptop))
        await model.sendToWatcher(laptop)
        XCTAssertTrue(try connection.watcherCalls.isEmpty, "Nothing was sent")
        XCTAssertEqual(model.drafts[model.watcherDraftKey(laptop)], "And the webhook thread?")
        model.phase(.background)
    }

    // MARK: Alerts (5A)

    func testWatcherAlertsItsOwnRequestsAndErrorsButNeverItsTurns() throws {
        var watch = WatcherWatch()
        let on = AlertSwitches(needsYou: true, finished: true, failed: true)
        func observe(_ spec: Spec, onScreen: Bool = false, switches: AlertSwitches = on) throws -> [ThreadAlert] {
            watch.observe(try decoded(spec), hostID: laptop, computer: "Laptop", onScreen: onScreen, switches: switches)
        }
        XCTAssertTrue(try observe(Spec(ownCard: true)).isEmpty, "The first page after connecting is not news")
        XCTAssertTrue(try observe(Spec(working: false, status: "idle")).isEmpty, "Watcher's finished turns never alert")
        let asked = try observe(Spec(ownCard: true))
        XCTAssertEqual(asked.map(\.body), [], "A request already seen alerts once, even when it comes back")
        var fresh = WatcherWatch()
        _ = fresh.observe(try decoded(Spec()), hostID: laptop, computer: "Laptop", onScreen: false, switches: on)
        let news = fresh.observe(try decoded(Spec(ownCard: true)), hostID: laptop, computer: "Laptop", onScreen: false, switches: on)
        XCTAssertEqual(news.map(\.body), ["Watcher is asking for permission on Laptop."])
        XCTAssertEqual(news.map(\.title), ["Watcher"])
        XCTAssertTrue(news.allSatisfy { $0.id.hasPrefix(WatcherWatch.alertPrefix) }, "Its alert opens the Watcher tab")
        XCTAssertEqual(news.first?.ref, ThreadRef(hostID: laptop, threadID: "w"))
        let failed = fresh.observe(try decoded(Spec(working: false, status: "error")), hostID: laptop, computer: "Laptop", onScreen: false, switches: on)
        XCTAssertEqual(failed.map(\.kind), [.failed])
        XCTAssertEqual(failed.map(\.body), ["Watcher stopped with an error on Laptop."])
        // A switch that is off, or the Watcher tab on screen, alerts nothing.
        var quiet = WatcherWatch()
        _ = quiet.observe(try decoded(Spec()), hostID: laptop, computer: "Laptop", onScreen: false, switches: on)
        XCTAssertTrue(quiet.observe(try decoded(Spec(ownCard: true)), hostID: laptop, computer: "Laptop", onScreen: true, switches: on).isEmpty)
        var off = WatcherWatch()
        _ = off.observe(try decoded(Spec()), hostID: laptop, computer: "Laptop", onScreen: false, switches: AlertSwitches())
        XCTAssertTrue(off.observe(try decoded(Spec(ownCard: true)), hostID: laptop, computer: "Laptop", onScreen: false, switches: AlertSwitches()).isEmpty)
    }

    @MainActor func testTheModelPostsWatchersOwnRequestUnderTheNeedsYouSwitch() async throws {
        let alerts = FakeAlerts()
        let model = try await fixture(alerts: alerts, switches: [PhonePreferenceKey.notifyNeedsYou: true])
        XCTAssertTrue(alerts.posted.isEmpty, "What Watcher already had is not news")
        try push(Spec(ownCard: true, observedAt: "2026-10-11T09:01:00.000Z"))
        await until { !alerts.posted.isEmpty }
        XCTAssertEqual(alerts.posted.map(\.alert.body), ["Watcher is asking for permission on Laptop."])
        XCTAssertNil(model.feedback)
        model.phase(.background)
    }

    @MainActor func testTappingWatchersAlertOpensTheWatcherTab() async throws {
        let model = try await fixture()
        model.openFromAlert(ThreadRef(hostID: laptop, threadID: "w"), watcher: true)
        XCTAssertEqual(model.watcherAlertOpened, laptop)
        XCTAssertNil(model.alertOpened, "It opens the tab, not a thread page")
        model.phase(.background)
    }

    // MARK: The conversation (2B)

    func testWhatWatcherDidSitsUnderItsReplyAndAGroupWithoutOneStandsAlone() throws {
        let laptop = self.laptop
        let row = { (id: String, at: String) in
            #"{"operationId":"\#(id)","target":{"hostId":"\#(laptop)","threadId":"t"},"title":"Fix login test","provider":"claude","action":"send","deliveryState":"accepted","createdAt":"\#(at)","updatedAt":"\#(at)"}"#
        }
        let json = #"""
        {"hostId":"\#(laptop)","current":null,
         "conversation":{"messages":[
           {"id":"m1","role":"user","text":"One","createdAt":"2026-10-11T08:00:00.000Z"},
           {"id":"r1","role":"assistant","text":"Two","createdAt":"2026-10-11T08:01:00.000Z"},
           {"id":"m2","role":"user","text":"Three","createdAt":"2026-10-11T08:10:00.000Z"},
           {"id":"r2","role":"assistant","text":"Four","createdAt":"2026-10-11T08:20:00.000Z"}],"earlierAvailable":true,"revision":4},
         "receiptGroups":[
           {"replyMessageId":"r1","requestId":"g1","rows":[\#(row("o1", "2026-10-11T08:01:00.000Z"))]},
           {"replyMessageId":null,"requestId":"g2","rows":[\#(row("o2", "2026-10-11T08:15:00.000Z"))]},
           {"replyMessageId":"older","requestId":"g3","rows":[\#(row("o3", "2026-10-11T07:00:00.000Z"))]},
           {"replyMessageId":"r2","requestId":"g4","rows":[]}],
         "watchedThreads":[],"needsYou":[],"inFlight":0,"inFlightLimit":4,"working":false,"recoveryNotice":null,"observedAt":"2026-10-11T09:00:00.000Z"}
        """#
        let page = try JSONDecoder().decode(WatcherPage.self, from: Data(json.utf8))
        let order = WatcherConversation.items(page).map { item -> String in
            switch item {
            case .message(let message): return message.id
            case .receipts(let group, let attached): return group.requestId + (attached ? "" : " alone")
            }
        }
        XCTAssertEqual(order, ["g3 alone", "m1", "r1", "g1", "m2", "g2 alone", "r2"],
                       "A reply carries its own card; a group whose reply isn't shown stands alone by its time; an empty one shows nothing")
        XCTAssertEqual(WatcherWords.meter(try decoded()), "1 of 4 watched")
        XCTAssertEqual(WatcherWords.room(try decoded()), "3 more can start. A thread waiting on you still counts.")
    }
}

