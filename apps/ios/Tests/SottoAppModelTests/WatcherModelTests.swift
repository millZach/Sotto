import XCTest
import Combine
import CoreGraphics
import SottoCore

/// Holds the model between two receipt reads while a test says so. Otherwise it lets other work run, as the real wait
/// does, without waiting.
private final class ReceiptPause: @unchecked Sendable {
    var holding = false
    var held: CheckedContinuation<Void, Never>?
    func wait() async {
        guard holding else { await Task.yield(); return }
        await withCheckedContinuation { held = $0 }
    }
}

/// The Watcher tab on the real AppModel, against a scripted computer that runs Watcher (ADR-0073, amended October 11,
/// 2026): only a computer that offers it gets a tab, the tab's dot and badge, answers that go to the thread that asked
/// under an answers grant, Stop all that asks first, the box's one draft ID per exact text, and Watcher's own alerts.
final class WatcherModelTests: XCTestCase {
    private let laptop = "00000000-0000-4000-8000-000000000001"
    private let forge = "00000000-0000-4000-8000-000000000009"
    private static let watcherFeatures = ["host-folders", "watcher-phone", "watcher-phone-stop-all"]
    /// An Owl desktop that also takes Watcher's permissions and watches from this iPhone.
    private static let manageFeatures = watcherFeatures + ["watcher-phone-manage"]
    /// One that also takes a message while Watcher works (#1229).
    private static let steerFeatures = manageFeatures + ["watcher-phone-steer"]
    private let receiptPause = ReceiptPause()
    private var suites: [String] = []
    /// The laptop's model catalog in every shell it sends, as JSON, when a test needs Watcher's model in it.
    private var catalog = ""
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
        /// The user's message from this iPhone, once Watcher's computer has put it in the conversation.
        var sent: String?
        /// What Watcher may do without asking, as its computer keeps it for Watcher, and as the current Watcher has it.
        var runtimeMode: String?
        var currentMode: String?
        /// Whether `t` has a standing watch, which lasts until the user stops it, and whether the user's own turn there
        /// holds it.
        var standing = false
        var paused = false
        var inFlight = 1
        /// The files Watcher changed itself in its reply `started`, and the reason it gave, if any.
        var changed: [String] = []
        var reason: String?
        /// Whether Watcher's provider takes a steer, as a computer that takes a message while Watcher works says it.
        var steers: Bool?
        /// The user's follow-ups waiting for Watcher, as (item, draft, words, status).
        var followups: [(String, String, String, String)] = []
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
        let answer = (spec.answer.map { #",{"id":"more","role":"assistant","text":"\#($0)","createdAt":"2026-10-11T08:02:00.000Z"}"# } ?? "")
            + (spec.sent.map { #",{"id":"sent","role":"user","text":"\#($0)","createdAt":"2026-10-11T08:03:00.000Z"}"# } ?? "")
        let currentMode = (spec.currentMode.map { #","runtimeMode":"\#($0)""# } ?? "") + (spec.steers.map { #","steers":\#($0)"# } ?? "")
        let paused = spec.paused ? #","paused":true"# : ""
        var extra = spec.runtimeMode.map { #","runtimeMode":"\#($0)""# } ?? ""
        if spec.standing {
            let hold = spec.paused ? #","pausedByUserMessageId":"human""# : ""
            extra += #","standingWatches":[{"id":"eeeeeeee-0000-4000-8000-000000000001","target":{"hostId":"\#(laptop)","threadId":"t"},"createdAt":"2026-10-11T08:01:00.000Z","generation":1\#(hold)}]"#
        }
        if !spec.followups.isEmpty {
            let rows = spec.followups.map { item, draft, text, status in #"{"itemId":"\#(item)","draftId":"\#(draft)","text":"\#(text)","status":"\#(status)"}"# }
            extra += #","followups":[\#(rows.joined(separator: ","))]"#
        }
        if !spec.changed.isEmpty {
            let files = spec.changed.map { #""\#($0)""# }.joined(separator: ",")
            let reason = spec.reason.map { #""\#($0)""# } ?? "null"
            extra += #","ownChanges":[{"replyMessageId":"started","turnId":"turn","files":[\#(files)],"fileCount":\#(spec.changed.count),"reason":\#(reason),"source":"provider-file-change"}]"#
        }
        return #"""
        {"hostId":"\#(laptop)","current":{"target":{"hostId":"\#(laptop)","threadId":"w"},"provider":"codex","modelId":"m","reasoningEffort":"high","status":"\#(spec.status)","connected":true\#(currentMode)},
         "conversation":{"messages":[{"id":"ask","role":"user","text":"Fix the login test.","createdAt":"2026-10-11T08:00:00.000Z"},{"id":"started","role":"assistant","text":"Started it.","createdAt":"2026-10-11T08:01:00.000Z"}\#(answer)],"earlierAvailable":false,"revision":\#(spec.answer == nil ? 2 : 3)},
         "receiptGroups":[{"replyMessageId":"started","requestId":"aaaaaaaa-0000-4000-8000-000000000001","rows":[{"operationId":"bbbbbbbb-0000-4000-8000-000000000001","target":{"hostId":"\#(laptop)","threadId":"t"},"title":"Fix login test","provider":"claude","action":"start","deliveryState":"accepted","createdAt":"2026-10-11T08:01:00.000Z","updatedAt":"2026-10-11T08:01:00.000Z"}]}],
         "watchedThreads":[{"target":{"hostId":"\#(laptop)","threadId":"t"},"title":"Fix login test","provider":"claude","status":"running","connected":true,"watched":\#(spec.watched),"takenOver":\#(spec.takenOver),"backgroundWorkCount":0\#(paused)}],
         "needsYou":[\#(cards.joined(separator: ","))],"inFlight":\#(spec.inFlight),"inFlightLimit":4,"working":\#(spec.working),"observedAt":"\#(spec.observedAt)",
         "draftDeliveries":[\#(deliveries)]\#(extra)}
        """#
    }
    private func decoded(_ spec: Spec = Spec()) throws -> WatcherPage {
        try JSONDecoder().decode(WatcherPage.self, from: Data(page(spec).utf8))
    }
    /// The laptop's shell, with Watcher's page when it runs Watcher. Fix login test waits on the same question its card does.
    private func shell(_ page: String?, mayAnswer: Bool, asking: Bool = true) throws -> JSONValue {
        let watcher = page.map { #","watcher":\#($0)"# } ?? ""
        let requests = asking ? Self.workerRequest : ""
        let models = catalog.isEmpty ? "" : #""models":\#(catalog),"#
        return try json(#"{"hostId":"\#(laptop)","clientCapabilities":{"mayAnswer":\#(mayAnswer)},"host":{\#(models)"hostId":"\#(laptop)","name":"Laptop","threads":[{"id":"t","projectId":"p","title":"Fix login test","providerId":"claude","status":"running","requests":[\#(requests)]}],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}\#(watcher)}"#)
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
                                    alerts: FakeAlerts? = nil, switches: [String: Bool] = [:], forge forgeRequests: String? = nil,
                                    photos: Bool = false) async throws -> AppModel {
        TestKeychain.items = [:]; HostConnection.instances = []; HostConnection.afterGreeting = nil
        HostConnection.failDetail = false; HostConnection.failConnect = false; HostConnection.holdDetail = false
        HostConnection.connectAttempts = 0
        TestKeychain.locked = false; TestKeychain.unreadableAccount = nil; TestKeychain.unwritableAccount = nil
        HostConnection.mayAnswer = mayAnswer; HostConnection.loseAcknowledgement = false
        HostConnection.receipt = .object(["status": .string("unknown")]); HostConnection.receipts = [:]
        HostConnection.features = features; HostConnection.shells = [:]
        HostConnection.commandHandler = nil; HostConnection.folderHandler = nil; HostConnection.stageHandler = nil
        HostConnection.previewHandler = nil; HostConnection.watcherHandler = nil
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
        // Between receipt reads the model lets other work run, as the real wait does, without waiting, unless a test holds it.
        let pause = receiptPause
        // With `photos`, a chosen photo is prepared as it is, and staged under the next of `staged-1`, `staged-2`...
        var staged = 0
        if photos {
            HostConnection.stageHandler = { image in
                staged += 1
                let name = String(decoding: try JSONEncoder().encode(image["name"]), as: UTF8.self)
                return try self.json(#"{"id":"staged-\#(staged)","name":\#(name),"mimeType":"image/jpeg","sizeBytes":4,"digest":"\#(String(repeating: "d", count: 64))"}"#)
            }
        }
        let model = photos
            ? AppModel(keychain: store,
                       preparePhoto: { _, name in PreparedPhoto(name: name + ".jpg", mimeType: "image/jpeg", base64: "/9j/AA==", byteCount: 4, dimensions: nil, thumbnail: nil) },
                       receiptSleep: { _ in await pause.wait() }, photoLoadLimit: { try await Task.sleep(nanoseconds: 3_600_000_000_000) })
            : AppModel(keychain: store, receiptSleep: { _ in await pause.wait() })
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
        // Fix login test, which Watcher started, still works: it says so on its own row, and lights no dot for Watcher.
        let started = try XCTUnwrap(model.watcherPage(laptop)?.watchedThreads.first { $0.target.threadId == "t" })
        XCTAssertEqual(WatcherWords.status(started), "Working")
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

    @MainActor func testOneStopAllReceiptIsReadAtATime() async throws {
        let model = try await fixture()
        HostConnection.watcherHandler = { op, _, id in
            switch op {
            case "watcher-phone-prepare-stop-all":
                return try self.json(#"{"status":"ok","confirmationId":"cccccccc-0000-4000-8000-000000000003","targets":[{"hostId":"\#(self.laptop)","threadId":"t","title":"Fix login test","provider":"claude"}],"expiresAt":"2026-10-11T09:10:00.000Z"}"#)
            case "watcher-phone-stop-all":
                // Still being carried out after every read, so its outcome is kept to read again.
                HostConnection.receipts[id] = .object(["status": .string("pending")])
                throw ClientError.uncertain
            default:
                return try self.ok(self.page())
            }
        }
        let prepared = await model.prepareWatcherStop(laptop)
        let preview = try XCTUnwrap(prepared)
        await model.confirmWatcherStop(preview, on: laptop)
        let firstReads = try connection.operations.filter { $0 == "receipt" }.count
        XCTAssertGreaterThan(firstReads, 1, "A pending receipt is read again")
        // A reconnect asks for it while another read of it runs: only one reads.
        let host = laptop
        async let one: Void = model.recoverWatcherStop(host)
        async let two: Void = model.recoverWatcherStop(host)
        await one
        await two
        let reads = try connection.operations.filter { $0 == "receipt" }.count - firstReads
        XCTAssertEqual(reads, firstReads, "A second read of the same Stop all's receipt while one runs reads nothing")
        XCTAssertEqual(model.feedback, "Stop all isn’t confirmed. Check Watched before you stop anything again.")
        model.phase(.background)
    }

    @MainActor func testAReconnectReadsStopAllsReceiptWhileTheOldConnectionsReadWaits() async throws {
        let model = try await fixture()
        var stopID = ""
        HostConnection.watcherHandler = { op, _, id in
            switch op {
            case "watcher-phone-prepare-stop-all":
                return try self.json(#"{"status":"ok","confirmationId":"cccccccc-0000-4000-8000-000000000004","targets":[{"hostId":"\#(self.laptop)","threadId":"t","title":"Fix login test","provider":"claude"}],"expiresAt":"2026-10-11T09:10:00.000Z"}"#)
            case "watcher-phone-stop-all":
                stopID = id
                HostConnection.receipts[id] = .object(["status": .string("pending")])
                throw ClientError.uncertain
            default:
                return try self.ok(self.page())
            }
        }
        let prepared = await model.prepareWatcherStop(laptop)
        let preview = try XCTUnwrap(prepared)
        await model.confirmWatcherStop(preview, on: laptop)
        // A read of its receipt waits between two reads when the connection drops.
        let host = laptop
        let link = try connection
        receiptPause.holding = true
        let reading = Task { await model.recoverWatcherStop(host) }
        await until { self.receiptPause.held != nil }
        receiptPause.holding = false
        let before = link.operations.filter { $0 == "receipt" }.count
        link.onDisconnect?()
        await model.connect(host)
        XCTAssertEqual(model.status(host), .online, "The computer is reached again, over a new connection")
        await until { link.operations.filter { $0 == "receipt" }.count > before }
        XCTAssertGreaterThan(link.operations.filter { $0 == "receipt" }.count, before,
                             "The new connection reads the receipt while the old connection's read still waits")
        // Stop all finishes on the computer: the new connection's read says what it did.
        HostConnection.receipts[stopID] = try json(#"{"status":"completed","watcherStop":{"status":"ok","results":[{"target":{"hostId":"\#(laptop)","threadId":"t"},"status":"stopped","message":"Stopped."}]}}"#)
        await until { model.feedback == "Stopped 1 thread Watcher started." }
        XCTAssertEqual(model.feedback, "Stopped 1 thread Watcher started.")
        receiptPause.held?.resume()
        await reading.value
        XCTAssertEqual(model.feedback, "Stopped 1 thread Watcher started.", "The old connection's read stops at its next read and says nothing")
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

    /// Photos in Watcher's box (Zach's pick A, October 23, 2026): the + and the photos work as in a thread's reply box,
    /// the photos go with the words or alone, and a message Watcher refuses comes back to the box whole.
    @MainActor func testPhotosGoToWatcherWithTheWordsOrAloneAndARefusedMessageComesBackWhole() async throws {
        catalog = #"[{"id":"m","name":"Model","provider":"Codex","ready":true,"supportsImages":true}]"#
        let model = try await fixture(features: Self.watcherFeatures + ["attachment-staging", WatcherWire.photosFeature],
                                      spec: Spec(workerCard: false), photos: true)
        let box = PhotoBox.watcher(hostID: laptop)
        XCTAssertEqual(model.photoSupport(box), .available)
        var requests: [JSONValue] = []
        var reply = "refuse"
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send", let request = operation["request"] else {
                // The page read after a lost acknowledgement: the computer has the last draft, and may still deliver it.
                let last = requests.last?["draftId"].string ?? ""
                return try self.ok(self.page(Spec(workerCard: false, deliveries: [last: "uncertain"])))
            }
            requests.append(request)
            if reply == "lose" { throw ClientError.uncertain }
            if reply == "refuse" {
                return try self.json(#"{"status":"refused","code":"TARGET_CHANGED","message":"Watcher changed. Nothing new was sent.","retryable":true}"#)
            }
            return try self.json(#"{"status":"ok","draftId":"\#(request["draftId"].string ?? "")","state":\#(self.page(Spec(workerCard: false)))}"#)
        }
        model.attachPhotos(box, from: [PhotoSource(name: "Photo 1") { Data([1, 2, 3]) }])
        await model.waitForPhotos()
        XCTAssertEqual(model.photos(box).map(\.staged?.id), ["staged-1"])
        XCTAssertTrue(model.photos(ThreadRef(hostID: laptop, threadID: "w")).isEmpty, "Watcher's box keeps its own photos")
        XCTAssertTrue(model.canSendToWatcher(laptop), "A photo alone is a message")

        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0]["text"], .string(""))
        guard case .array(let first) = requests[0]["images"] else { return XCTFail("The message carried no photos") }
        XCTAssertEqual(first.map { $0["id"] }, [.string("staged-1")])
        XCTAssertEqual(model.photos(box).count, 1, "Refused, the photo goes back in the box")
        XCTAssertNil(model.photos(box).first?.staged, "A refused message's photo is staged again before it next goes")
        XCTAssertEqual(model.feedback, "Watcher changed. Nothing new was sent.")
        XCTAssertFalse(model.preparingSends.contains(box.id), "The box is unlocked again")
        XCTAssertNil(model.watcherSendingPhotos[laptop])

        // Lost on its way: the message comes back whole, and sent again it is the same message, under the same draft ID.
        reply = "lose"
        model.drafts[box.id] = "What does this screen say?"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[1]["text"], .string("What does this screen say?"))
        guard case .array(let second) = requests[1]["images"] else { return XCTFail("The words went without their photo") }
        XCTAssertEqual(second.map { $0["id"] }, [.string("staged-2")])
        XCTAssertNotEqual(requests[1]["draftId"], requests[0]["draftId"], "Words with the photo are another message than the photo alone")
        XCTAssertEqual(model.drafts[box.id], "What does this screen say?")
        XCTAssertEqual(model.photos(box).map(\.staged?.id), ["staged-2"], "Unconfirmed, the photo comes back as it went")

        reply = "ok"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests[2]["draftId"], requests[1]["draftId"], "The same words and photos go with the same draft ID")
        XCTAssertEqual(requests[2]["images"], requests[1]["images"])
        XCTAssertTrue(model.photos(box).isEmpty, "Taken, the photo leaves the box")
        XCTAssertEqual(model.drafts[box.id], "")

        // Words alone carry no photos, as before.
        model.drafts[box.id] = "Thanks"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests[3]["images"], .null)
        model.phase(.background)
    }

    @MainActor func testAComputerThatTakesNoPhotosForWatcherKeepsTheChoicesUnavailable() async throws {
        catalog = #"[{"id":"m","name":"Model","provider":"Codex","ready":true,"supportsImages":true}]"#
        let model = try await fixture(features: Self.watcherFeatures + ["attachment-staging"], spec: Spec(workerCard: false), photos: true)
        let box = PhotoBox.watcher(hostID: laptop)
        XCTAssertEqual(model.photoSupport(box), .needsUpdate)
        model.attachPhotos(box, from: [PhotoSource(name: "Photo 1") { Data([1, 2, 3]) }])
        await model.waitForPhotos()
        XCTAssertTrue(model.photos(box).isEmpty, "Nothing is added to a box that can't send it")
        XCTAssertTrue(try connection.operations.filter { $0 == "stage-attachment" }.isEmpty)
        model.phase(.background)
    }

    @MainActor func testTheSameWordsKeepOneDraftIDAndNothingIsResentOnItsOwn() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        var requests: [JSONValue] = []
        var reply = "lose"
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send", let request = operation["request"] else {
                // The page read after a lost acknowledgement: the computer has the last draft, and may still deliver it.
                let last = requests.last?["draftId"].string ?? ""
                return try self.ok(self.page(Spec(workerCard: false, deliveries: [last: "uncertain"])))
            }
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

    /// The computer puts the user's words in Watcher's conversation, or its queue, before it answers the send: from then
    /// the conversation shows them, and the Sending bubble goes, while the box stays locked until the answer.
    @MainActor func testWordsWatcherShowsBeforeItAnswersShowOnce() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        var shownMidSend: [WatcherSending?] = []
        var lockedMidSend: [Bool] = []
        var step = 0
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send", let draft = operation["request"]?["draftId"].string else { return try self.ok(self.page(Spec(workerCard: false))) }
            step += 1
            XCTAssertNotNil(model.watcherSendingShown(self.laptop), "Until the page shows them, the words show as on their way")
            if step == 1 {
                try self.push(Spec(workerCard: false, observedAt: "2026-10-11T09:01:00.000Z", sent: "Check the release notes"))
            } else {
                try self.push(Spec(workerCard: false, observedAt: "2026-10-11T09:03:00.000Z", steers: true,
                                   followups: [("q", draft, "And the webhook thread?", "queued")]))
            }
            await self.until { model.watcherSendingShown(self.laptop) == nil }
            shownMidSend.append(model.watcherSendingShown(self.laptop))
            lockedMidSend.append(model.watcherSending[self.laptop] != nil && !model.canSendToWatcher(self.laptop))
            let answered = self.page(Spec(workerCard: false, observedAt: "2026-10-11T09:0\(step + 1):30.000Z"))
            return try self.json(#"{"status":"ok","draftId":"\#(draft)","state":\#(answered)}"#)
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "Check the release notes"
        await model.sendToWatcher(laptop)
        model.drafts[key] = "And the webhook thread?"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(shownMidSend, [nil, nil], "In the conversation, or in Watcher's queue, the words show once")
        XCTAssertEqual(lockedMidSend, [true, true], "The box stays locked until the computer answers")
        XCTAssertNil(model.watcherSending[laptop])
        XCTAssertEqual(model.drafts[key], "")
        model.phase(.background)
    }

    @MainActor func testUnconfirmedWordsKeepTheirDraftIDThroughOtherWords() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        var requests: [JSONValue] = []
        var reply = "lose"
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send", let request = operation["request"] else {
                // The page read after a lost acknowledgement: the computer has the last draft, and may still deliver it.
                let last = requests.last?["draftId"].string ?? ""
                return try self.ok(self.page(Spec(workerCard: false, deliveries: [last: "uncertain"])))
            }
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

    @MainActor func testTheSameWordsGoAsANewMessageOnceAPageSaysTheFirstIsNoLongerOnItsWay() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        var requests: [JSONValue] = []
        // Where the page read after a send says its draft stands; nil when the computer has no record of it.
        var listed: String? = "uncertain"
        var reads = 0
        HostConnection.watcherHandler = { op, operation, _ in
            if op == "watcher-phone-send", let request = operation["request"] {
                requests.append(request)
                throw ClientError.uncertain
            }
            reads += 1
            let last = requests.last?["draftId"].string ?? ""
            let deliveries = listed.map { [last: $0] } ?? [:]
            return try self.ok(self.page(Spec(workerCard: false, observedAt: "2026-10-11T10:0\(reads):00.000Z", deliveries: deliveries)))
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "Yes"
        await model.sendToWatcher(laptop)
        let first = try XCTUnwrap(requests.last?["draftId"].string)
        XCTAssertEqual(model.watcherPage(laptop)?.delivery(of: first), "uncertain", "The page read after the lost acknowledgement says it may still arrive")
        // A page pushed with a shell proves nothing of it: the computer may have made it before it read the send.
        try push(Spec(workerCard: false, observedAt: "2026-10-11T10:01:30.000Z"))
        await until { model.watcherPage(laptop)?.observedAt == "2026-10-11T10:01:30.000Z" }
        // This time the page read after the send has no record of the draft.
        listed = nil
        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests.last?["draftId"].string, first, "Words that may still arrive keep their ID, so they can't arrive twice")
        XCTAssertEqual(model.drafts[key], "Yes", "Words that didn't reach Watcher stay in the box")
        // The page read after that send no longer shows the draft: it never arrived, or it failed.
        await model.sendToWatcher(laptop)
        XCTAssertEqual(requests.count, 3, "Nothing is sent again on its own")
        XCTAssertNotEqual(requests.last?["draftId"].string, first,
                          "Once a page asked for after the send shows the draft is no longer on its way, the same words go with a new ID")
        model.phase(.background)

        // Watcher's computer lists a draft until Watcher took it or it failed. Only a page asked for after a send ended
        // lets go of a draft it doesn't show on its way, and a page that says nothing of drafts lets go of nothing.
        var drafts = WatcherDrafts()
        let onItsWay = drafts.id(for: "One"), took = drafts.id(for: "Two"), failed = drafts.id(for: "Three")
        let unasked = drafts.id(for: "Four"), unlisted = drafts.id(for: "Five"), resent = drafts.id(for: "Six")
        for id in [onItsWay, took, failed, unlisted, resent] { drafts.end(id) }
        let proof = drafts.endedSends
        drafts.end(unasked)
        // Six goes again after the page was asked for, with its own ID: the page can't speak for that send.
        XCTAssertEqual(drafts.id(for: "Six"), resent)
        drafts.end(resent)
        let page = try decoded(Spec(deliveries: [onItsWay: "submitting", took: "accepted", failed: "failed"]))
        let silent = try JSONDecoder().decode(WatcherPage.self, from: Data(self.page(Spec()).replacingOccurrences(of: #""draftDeliveries":[]"#, with: #""recoveryNotice":null"#).utf8))
        XCTAssertNil(silent.draftDeliveries)
        XCTAssertTrue(drafts.retire(after: silent, proof: proof).isEmpty)
        XCTAssertEqual(drafts.unresolved.count, 6, "A page that says nothing of drafts lets go of nothing")
        XCTAssertEqual(drafts.retire(after: page, proof: proof).map(\.text), ["Two"], "Watcher took Two")
        XCTAssertEqual(drafts.unresolved.map(\.text), ["One", "Four", "Six"],
                       "One is still on its way, Three failed, Five never arrived, Four ended and Six went again after the page was asked for")
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

    @MainActor func testWatcherQueuesBehindItsOwnCardWithoutAnsweringIt() async throws {
        let model = try await fixture(features: Self.steerFeatures, spec: Spec(ownCard: true))
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "And the webhook thread?"
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send", let request = operation["request"] else { throw ClientError.invalidRequest }
            let queued = self.page(Spec(ownCard: true, observedAt: "2026-10-11T09:03:00.000Z",
                                       followups: [("q", request["draftId"].string ?? "", "And the webhook thread?", "queued")]))
            return try self.json(#"{"status":"ok","draftId":"\#(request["draftId"].string ?? "")","state":\#(queued)}"#)
        }
        XCTAssertNil(model.watcherSendHeld(laptop))
        XCTAssertTrue(model.canSendToWatcher(laptop))
        await model.sendToWatcher(laptop)
        XCTAssertEqual(try calls("watcher-phone-send").count, 1)
        XCTAssertEqual(model.drafts[key], "")
        let page = try XCTUnwrap(model.watcherPage(laptop))
        XCTAssertTrue(page.needsYou.contains { page.isOwn($0) }, "Only the card can answer the request")
        XCTAssertEqual(page.followups?.map(\.text), ["And the webhook thread?"])
        XCTAssertNil(WatcherWords.followupNote("queued", page: page, computer: "Laptop"))
        model.phase(.background)
    }

    // MARK: Steering Watcher while it works (#1229, Zach's pick B)

    @MainActor func testSendSteersWhileWatcherWorksAndWhatGoesNextShowsUntilRemoved() async throws {
        let model = try await fixture(features: Self.steerFeatures, spec: Spec(workerCard: false, steers: false))
        XCTAssertTrue(model.offersWatcherSteer(laptop))
        let item = "cccccccc-0000-4000-8000-000000000001"
        var sent: [JSONValue] = []
        HostConnection.watcherHandler = { op, operation, _ in
            switch op {
            case "watcher-phone-send":
                guard let request = operation["request"] else { throw ClientError.invalidRequest }
                sent.append(request)
                // Watcher's provider takes no steer: the words wait in its queue to go next.
                let queued = self.page(Spec(workerCard: false, observedAt: "2026-10-11T09:03:00.000Z", steers: false,
                                            followups: [(item, request["draftId"].string ?? "", "And the webhook thread?", "queued")]))
                return try self.json(#"{"status":"ok","draftId":"\#(request["draftId"].string ?? "")","state":\#(queued)}"#)
            case "watcher-phone-remove-followup":
                return try self.ok(self.page(Spec(workerCard: false, observedAt: "2026-10-11T09:04:00.000Z", steers: false)))
            default: return try self.ok(self.page(Spec(workerCard: false, steers: false)))
            }
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "And the webhook thread?"
        XCTAssertTrue(model.canSendToWatcher(laptop), "Watcher works, and Send still takes the words")
        await model.sendToWatcher(laptop)
        XCTAssertEqual(sent.first?["delivery"], .string("steer"), "A computer that takes it is asked to steer")
        XCTAssertEqual(model.drafts[key], "", "Waiting to go next, the words leave the box")
        XCTAssertNil(model.feedback, "Nothing announces itself; the line under the conversation says it")
        let waiting = try XCTUnwrap(model.watcherPage(laptop)?.followups?.first)
        XCTAssertEqual(WatcherWords.followup(waiting.status), "Goes next, after this turn")
        XCTAssertEqual(WatcherWords.followupNote(waiting.status, page: try XCTUnwrap(model.watcherPage(laptop)), computer: "Laptop"), "Codex can’t take a steer.")
        XCTAssertTrue(model.canRemoveWatcherFollowup(waiting, on: laptop))
        await model.removeWatcherFollowup(waiting, on: laptop)
        let removed = try XCTUnwrap(try calls("watcher-phone-remove-followup").first)
        XCTAssertEqual(removed.operation["request"]?["itemId"], .string(item))
        XCTAssertEqual(removed.operation["request"]?["target"]["threadId"], .string("w"))
        XCTAssertNil(model.watcherPage(laptop)?.followups, "The page the computer sent back shows it gone")
        XCTAssertTrue(model.watcherManaging.isEmpty)
        model.phase(.background)
    }

    @MainActor func testAnOlderComputerSaysToUpdateSottoAndKeepsTheWords() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        XCTAssertFalse(model.offersWatcherSteer(laptop))
        var sent: [JSONValue] = []
        var reply = #"{"status":"refused","code":"PROVIDER_UNAVAILABLE","message":"Watcher could not take this instruction. Your text is kept on the phone. Refresh Watcher and check its delivery before trying again.","retryable":true}"#
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send", let request = operation["request"] else { return try self.ok(self.page(Spec(workerCard: false))) }
            sent.append(request)
            return try self.json(reply)
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "And the webhook thread?"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(sent.first?["delivery"], .null, "An older computer is never asked to steer")
        XCTAssertEqual(model.drafts[key], "And the webhook thread?", "The words stay in the box")
        XCTAssertEqual(model.feedback, "Update Sotto on Laptop to send to Watcher while it works. Your message is still here.")
        // Any other refusal says what the computer said.
        reply = #"{"status":"refused","code":"TARGET_CHANGED","message":"Watcher changed. Nothing new was sent.","retryable":true}"#
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.feedback, "Watcher changed. Nothing new was sent.")
        model.phase(.background)
    }

    @MainActor func testTheUpdateGuidanceHoldsWhenWatcherFinishesBeforeTheRefusalArrives() async throws {
        let model = try await fixture(spec: Spec(workerCard: false))
        HostConnection.watcherHandler = { op, _, _ in
            guard op == "watcher-phone-send" else { return try self.ok(self.page(Spec(workerCard: false))) }
            // Watcher's turn ends while the words are on their way, and that page arrives before the older computer's refusal.
            try self.push(Spec(working: false, status: "idle", workerCard: false, observedAt: "2026-10-11T09:06:00.000Z"))
            await self.until { model.watcherPage(self.laptop)?.current?.status == "idle" }
            return try self.json(#"{"status":"refused","code":"PROVIDER_UNAVAILABLE","message":"Watcher could not take this instruction. Your text is kept on the phone. Refresh Watcher and check its delivery before trying again.","retryable":true}"#)
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "And the webhook thread?"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.watcherPage(laptop)?.current?.status, "idle")
        XCTAssertEqual(model.drafts[key], "And the webhook thread?", "The words stay in the box")
        XCTAssertEqual(model.feedback, "Update Sotto on Laptop to send to Watcher while it works. Your message is still here.",
                       "Watcher was working when the words left, so the refusal is the older computer's")
        model.phase(.background)
    }

    @MainActor func testWordsAPushedPageShowsWaitingStayOutOfTheBoxWhateverTheReplySays() async throws {
        let model = try await fixture(features: Self.steerFeatures, spec: Spec(workerCard: false, steers: false))
        var sends = 0
        HostConnection.watcherHandler = { op, operation, _ in
            guard op == "watcher-phone-send" else { return try self.ok(self.page(Spec(workerCard: false, steers: false))) }
            sends += 1
            let draft = operation["request"]?["draftId"].string ?? ""
            // The page pushed with the queue's change comes first, and settles the draft as waiting to go next.
            try self.push(Spec(workerCard: false, observedAt: "2026-10-11T09:07:00.000Z", steers: false,
                               followups: [("cccccccc-0000-4000-8000-000000000003", draft, "Stop the webhook thread", "queued")]))
            await self.until { model.watcherPage(self.laptop)?.followup(of: draft) != nil }
            // An older desktop answered with its own banner's error.
            return try self.json(#"{"status":"refused","code":"DELIVERY_UNCERTAIN","message":"Watcher didn’t confirm your message. Check the conversation before you send it again.","retryable":true}"#)
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "Stop the webhook thread"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.drafts[key], "", "The page says the words wait in Watcher's queue, so they don't come back to be sent twice")
        XCTAssertNil(model.watcherSetAside[laptop])
        XCTAssertNil(model.feedback)
        XCTAssertEqual(sends, 1)
        model.phase(.background)
    }

    @MainActor func testWordsWaitingInWatchersQueueLeaveTheBoxAfterALostAcknowledgement() async throws {
        let model = try await fixture(features: Self.steerFeatures, spec: Spec(workerCard: false, steers: false))
        var draft = ""
        HostConnection.watcherHandler = { op, operation, _ in
            if op == "watcher-phone-send" {
                draft = operation["request"]?["draftId"].string ?? ""
                throw ClientError.uncertain
            }
            // The computer queued the words before their acknowledgement was lost, and the page read after it says so.
            return try self.ok(self.page(Spec(workerCard: false, observedAt: "2026-10-11T09:05:00.000Z", steers: false,
                                              followups: [("cccccccc-0000-4000-8000-000000000002", draft, "Stop the webhook thread", "queued")])))
        }
        let key = model.watcherDraftKey(laptop)
        model.drafts[key] = "Stop the webhook thread"
        await model.sendToWatcher(laptop)
        XCTAssertEqual(model.drafts[key], "", "Waiting in Watcher's queue, the words leave the box")
        XCTAssertEqual(try calls("watcher-phone-send").count, 1, "Nothing was sent again")
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
            case .ownChange(let change): return "own " + change.replyMessageId
            }
        }
        XCTAssertEqual(order, ["g3 alone", "m1", "r1", "g1", "m2", "g2 alone", "r2"],
                       "A reply carries its own card; a group whose reply isn't shown stands alone by its time; an empty one shows nothing")
        XCTAssertEqual(WatcherWords.meter(try decoded()), "1 of 4 watched")
        XCTAssertEqual(WatcherWords.room(try decoded()), "3 more can start. A thread waiting on you still counts.")
    }

    // MARK: What Watcher may do without asking (control A)

    /// The computer's answer to a set-permission, watch or unwatch: Watcher's page as it stands after the change. Reads
    /// return `read`. Every management operation is kept, with its request ID.
    @MainActor private func manage(_ after: @escaping (String, [String: JSONValue]) throws -> JSONValue, read: @escaping () -> String,
                                   sent: @escaping ([String: JSONValue], String) -> Void = { _, _ in }) {
        HostConnection.watcherHandler = { op, operation, id in
            if op == "watcher-phone-read" { return try self.ok(read()) }
            sent(operation, id)
            return try after(op, operation)
        }
    }
    @MainActor private func calls(_ op: String) throws -> [(operation: [String: JSONValue], id: String)] {
        try connection.watcherCalls.filter { $0.operation["op"] == .string(op) }
    }

    @MainActor func testWatchersPermissionChangesThroughItsComputerAndSaysWhatIsStillInForce() async throws {
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(status: "idle", runtimeMode: "approval-required", currentMode: "approval-required"))
        XCTAssertTrue(model.offersWatcherManage(laptop))
        XCTAssertEqual(model.watcherPermission(laptop), "approval-required")
        XCTAssertEqual(WatcherPermissions.name(model.watcherPermission(laptop)), "Ask before actions", "In this iPhone's own words")
        XCTAssertEqual(model.watcherPermissionModes(laptop), WatcherPermissions.modes, "A model that names none offers all four")
        XCTAssertNil(model.watcherPermissionInForce(laptop))
        // The computer keeps the choice for Watcher at once; Watcher's provider hasn't confirmed it yet.
        let kept = page(Spec(status: "idle", observedAt: "2026-10-11T09:01:00.000Z", runtimeMode: "full-access", currentMode: "approval-required"))
        manage({ _, _ in try self.ok(kept) }, read: { kept })
        XCTAssertTrue(model.mayChooseWatcherPermission("full-access", on: laptop))
        await model.setWatcherPermission("full-access", on: laptop)
        let sent = try calls("watcher-phone-set-permission")
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.operation["request"], .object(["runtimeMode": .string("full-access")]))
        XCTAssertEqual(model.watcherPermission(laptop), "full-access", "The chip says the choice")
        XCTAssertEqual(model.watcherPermissionInForce(laptop), "Codex stays on Ask before actions until it confirms.")
        XCTAssertTrue(model.watcherManaging.isEmpty)
        XCTAssertTrue(model.watcherPermissionPicks.isEmpty)
        XCTAssertNil(model.feedback)
        // Once the provider confirms it, nothing more is said.
        try push(Spec(status: "idle", observedAt: "2026-10-11T09:02:00.000Z", runtimeMode: "full-access", currentMode: "full-access"))
        await until { model.watcherPermissionInForce(laptop) == nil }
        XCTAssertNil(model.watcherPermissionInForce(laptop))
        // The same choice again sends nothing.
        await model.setWatcherPermission("full-access", on: laptop)
        XCTAssertEqual(try calls("watcher-phone-set-permission").count, 1)
        model.phase(.background)
    }

    @MainActor func testWatchersPermissionIsFixedWhileWatcherWorksOrItsOwnRequestWaits() async throws {
        // Watcher's turn runs: its computer would refuse a change, so the chip waits and nothing is sent.
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(status: "running", runtimeMode: "approval-required", currentMode: "approval-required"))
        XCTAssertTrue(model.watcherPermissionFixed(laptop))
        XCTAssertFalse(model.canChangeWatcherPermission(laptop))
        await model.setWatcherPermission("auto-accept-edits", on: laptop)
        XCTAssertTrue(try calls("watcher-phone-set-permission").isEmpty)
        XCTAssertEqual(WatcherPermissions.fixed, "Fixed while Watcher works.")
        // Its turn over, a request of its own still waits on the user.
        try push(Spec(status: "idle", ownCard: true, observedAt: "2026-10-11T09:01:00.000Z", runtimeMode: "approval-required", currentMode: "approval-required"))
        await until { model.watcherPage(laptop)?.needsYou.contains { model.watcherPage(laptop)?.isOwn($0) == true } == true }
        XCTAssertTrue(model.watcherPermissionFixed(laptop))
        // Nothing waits: the chip can be pressed again.
        try push(Spec(status: "idle", observedAt: "2026-10-11T09:02:00.000Z", runtimeMode: "approval-required", currentMode: "approval-required"))
        await until { !model.watcherPermissionFixed(laptop) }
        XCTAssertFalse(model.watcherPermissionFixed(laptop))
        XCTAssertTrue(model.canChangeWatcherPermission(laptop))
        model.phase(.background)
    }

    @MainActor func testAPhoneWithoutCanAnswerCanOnlyKeepWatcherAskingFirst() async throws {
        let model = try await fixture(features: Self.manageFeatures, mayAnswer: false,
                                      spec: Spec(status: "idle", mayAnswer: false, runtimeMode: "auto", currentMode: "auto"))
        XCTAssertEqual(model.watcherPermission(laptop), "auto")
        for mode in ["auto-accept-edits", "auto", "full-access"] {
            XCTAssertFalse(model.mayChooseWatcherPermission(mode, on: laptop), "\(mode) lets Watcher act without asking")
        }
        XCTAssertTrue(model.mayChooseWatcherPermission("approval-required", on: laptop))
        XCTAssertEqual(WatcherPermissions.asksOnly("Laptop"), "This iPhone can’t answer on Laptop, so it can only keep Watcher asking first.")
        let narrowed = page(Spec(status: "idle", mayAnswer: false, observedAt: "2026-10-11T09:01:00.000Z", runtimeMode: "approval-required", currentMode: "approval-required"))
        manage({ _, _ in try self.ok(narrowed) }, read: { narrowed })
        await model.setWatcherPermission("full-access", on: laptop)
        XCTAssertTrue(try calls("watcher-phone-set-permission").isEmpty, "A wider mode is never sent from a phone that can't answer")
        await model.setWatcherPermission("approval-required", on: laptop)
        XCTAssertEqual(try calls("watcher-phone-set-permission").first?.operation["request"], .object(["runtimeMode": .string("approval-required")]),
                       "Asking first needs only the pairing")
        XCTAssertEqual(model.watcherPermission(laptop), "approval-required")
        model.phase(.background)
    }

    @MainActor func testARefusedPermissionPutsTheChipBackAndSaysWhy() async throws {
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(status: "idle", runtimeMode: "approval-required", currentMode: "approval-required"))
        let before = page(Spec(status: "idle"))
        manage({ _, _ in
            try self.json(#"{"status":"refused","code":"PERMISSION_TOO_WIDE","message":"This phone can’t answer on this computer, so Watcher keeps asking first. Nothing changed. Change Watcher’s permissions in Sotto on this computer.","retryable":false}"#)
        }, read: { before })
        await model.setWatcherPermission("auto-accept-edits", on: laptop)
        XCTAssertEqual(model.feedback, "This phone can’t answer on this computer, so Watcher keeps asking first. Nothing changed. Change Watcher’s permissions in Sotto on this computer.",
                       "The computer's refusal, in its own words")
        XCTAssertEqual(model.watcherPermission(laptop), "approval-required", "The chip goes back")
        XCTAssertTrue(model.watcherManaging.isEmpty)
        model.phase(.background)
    }

    @MainActor func testALostPermissionAcknowledgementReadsItsReceiptAndIsNeverSentAgain() async throws {
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(status: "idle", runtimeMode: "approval-required", currentMode: "approval-required"))
        let kept = page(Spec(status: "idle", observedAt: "2026-10-11T09:01:00.000Z", runtimeMode: "auto", currentMode: "auto"))
        // The computer makes the change and keeps its outcome under the request's ID; the acknowledgement is lost.
        manage({ _, _ in throw ClientError.uncertain }, read: { kept }, sent: { _, id in
            HostConnection.receipts[id] = try? self.json(#"{"status":"completed","watcherManage":{"status":"ok"}}"#)
        })
        await model.setWatcherPermission("auto", on: laptop)
        XCTAssertEqual(try calls("watcher-phone-set-permission").count, 1, "Nothing is sent again on its own")
        XCTAssertTrue(try connection.operations.contains("receipt"), "Its receipt is read")
        XCTAssertFalse(try calls("watcher-phone-read").isEmpty, "And then Watcher's page")
        XCTAssertEqual(model.watcherPermission(laptop), "auto")
        XCTAssertNil(model.feedback, "The receipt says it took")

        // A receipt the computer no longer has leaves the change unconfirmed, and says so.
        manage({ _, _ in throw ClientError.uncertain }, read: { kept })
        await model.setWatcherPermission("approval-required", on: laptop)
        XCTAssertEqual(try calls("watcher-phone-set-permission").count, 2)
        XCTAssertEqual(model.feedback, WatcherWords.permissionUnconfirmed("Laptop"))
        XCTAssertEqual(model.feedback, "Laptop didn’t confirm the change to Watcher’s permissions. Check what they say before you change them again.")
        XCTAssertEqual(model.watcherPermission(laptop), "auto", "The page read after it says how things stand")
        model.phase(.background)
    }

    @MainActor func testAnOlderComputerOffersNoPermissionOrWatchControls() async throws {
        let model = try await fixture(spec: Spec(watched: false))
        XCTAssertFalse(model.offersWatcherManage(laptop))
        XCTAssertFalse(model.canChangeWatcherPermission(laptop))
        await model.setWatcherPermission("full-access", on: laptop)
        XCTAssertNil(model.watchHost(for: worker), "No computer here takes Watch from this iPhone")
        XCTAssertFalse(model.canChangeWatch(worker))
        await model.setWatched(worker, true)
        XCTAssertTrue(try connection.watcherCalls.isEmpty, "Nothing was asked of the computer")
        // Its watched threads keep the takeover line it has always had.
        try push(Spec(observedAt: "2026-10-11T09:01:00.000Z"))
        await until { model.watchedByWatcher(worker) }
        XCTAssertEqual(model.watchedLine(worker), WatchedWords.takeover)
        model.phase(.background)
    }

    // MARK: Watching (watch B)

    @MainActor func testWatchAndStopWatchingGoThroughWatchersComputerWithUndo() async throws {
        // Watcher already has as many threads in flight as it may start: watching has no limit.
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(watched: false, inFlight: 4))
        XCTAssertFalse(model.watchedByWatcher(worker))
        XCTAssertEqual(model.watchHost(for: worker), laptop)
        XCTAssertTrue(model.canChangeWatch(worker))
        XCTAssertNil(model.watchHost(for: ThreadRef(hostID: laptop, threadID: "w")), "Watcher's own thread is never offered")
        XCTAssertEqual(model.watchableThreads.map(\.ref), [worker])
        var watched = false
        manage({ op, _ in
            watched = op == "watcher-phone-watch"
            return try self.ok(self.page(Spec(watched: watched, observedAt: watched ? "2026-10-11T09:01:00.000Z" : "2026-10-11T09:02:00.000Z",
                                              standing: watched, inFlight: 4)))
        }, read: { self.page(Spec(watched: watched, observedAt: "2026-10-11T09:00:30.000Z", standing: watched, inFlight: 4)) })
        await model.setWatched(worker, true)
        let watch = try calls("watcher-phone-watch")
        XCTAssertEqual(watch.count, 1)
        XCTAssertEqual(watch.first?.operation["request"], .object(["target": .object(["hostId": .string(laptop), "threadId": .string("t")])]))
        XCTAssertTrue(model.watchedByWatcher(worker), "The owl follows its logo now")
        XCTAssertEqual(model.watchedLine(worker), WatchedWords.standing)
        XCTAssertEqual(model.watchedLine(worker), "Watched by Watcher. It keeps this thread going and brings you its questions and permissions.")
        let notice = try XCTUnwrap(model.watchNotice, "What the press did is said, with Undo")
        XCTAssertEqual(notice.words, "Watcher is watching Fix login test.")
        XCTAssertEqual(notice.undo, "Undo: stop watching Fix login test")
        XCTAssertTrue(model.watchableThreads.isEmpty, "A watched thread isn't offered again")
        XCTAssertTrue(model.watcherManaging.isEmpty)

        // Undo is a press the other way.
        await model.undoWatch(notice)
        XCTAssertEqual(try calls("watcher-phone-unwatch").first?.operation["request"],
                       .object(["target": .object(["hostId": .string(laptop), "threadId": .string("t")])]))
        XCTAssertFalse(model.watchedByWatcher(worker))
        XCTAssertNil(model.watchedLine(worker))
        XCTAssertEqual(model.watchNotice?.words, "Watcher stopped watching Fix login test.")
        XCTAssertEqual(model.watchNotice?.undo, "Undo: watch Fix login test again")
        XCTAssertEqual(try calls("watcher-phone-watch").count, 1, "Nothing went twice")
        model.phase(.background)
    }

    @MainActor func testUndoGoesBackToTheComputerWhoseWatcherTookThePress() async throws {
        // Both computers run Watcher. The laptop's Watcher watches a thread on forge.
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(workerCard: false), forge: "")
        let remote = ThreadRef(hostID: forge, threadID: "r")
        let onForge = { (spec: Spec) -> String in
            self.page(spec).replacingOccurrences(of: #"{"hostId":"\#(self.laptop)","threadId":"t"}"#, with: #"{"hostId":"\#(self.forge)","threadId":"r"}"#)
        }
        let watching = try shell(onForge(Spec(workerCard: false, observedAt: "2026-10-11T09:01:00.000Z", standing: true)), mayAnswer: true)
        HostConnection.shells[laptop] = watching
        try connection.push(.shell(watching.decode(Shell.self)))
        await until { model.watchedByWatcher(remote) }
        XCTAssertEqual(model.watchHost(for: remote), laptop, "Stop watching goes to the computer that watches it")
        let stopped = onForge(Spec(workerCard: false, watched: false, observedAt: "2026-10-11T09:02:00.000Z"))
        manage({ _, _ in try self.ok(stopped) }, read: { stopped })
        await model.setWatched(remote, false)
        let notice = try XCTUnwrap(model.watchNotice)
        XCTAssertEqual(notice.hostID, laptop)
        // Nothing watches it now, so a new press would go to forge, the thread's own computer. Undo goes back to the laptop.
        XCTAssertEqual(model.watchHost(for: remote), forge)
        let watchedAgain = onForge(Spec(workerCard: false, observedAt: "2026-10-11T09:03:00.000Z", standing: true))
        manage({ _, _ in try self.ok(watchedAgain) }, read: { watchedAgain })
        await model.undoWatch(notice)
        XCTAssertEqual(try calls("watcher-phone-watch").first?.operation["request"],
                       .object(["target": .object(["hostId": .string(forge), "threadId": .string("r")])]), "Undo went to the laptop's Watcher")
        let forgeConnection = try XCTUnwrap(HostConnection.instances.last { $0.hostID == forge })
        XCTAssertTrue(forgeConnection.watcherCalls.filter { $0.operation["op"] == .string("watcher-phone-watch") }.isEmpty, "And not to forge's")
        model.phase(.background)
    }

    @MainActor func testARefusedOrUnconfirmedWatchSaysSoAndIsNeverSentAgain() async throws {
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(watched: false))
        manage({ _, _ in
            try self.json(#"{"status":"refused","code":"HOST_DISCONNECTED","message":"Sotto can’t reach the thread’s computer. Nothing changed.","retryable":true}"#)
        }, read: { self.page(Spec(watched: false)) })
        await model.setWatched(worker, true)
        XCTAssertEqual(model.feedback, "Sotto can’t reach the thread’s computer. Nothing changed.")
        XCTAssertNil(model.watchNotice, "A refused press says nothing took")
        XCTAssertFalse(model.watchedByWatcher(worker))

        // Lost on the way, and its receipt says the computer refused it.
        manage({ _, _ in throw ClientError.uncertain }, read: { self.page(Spec(watched: false)) }, sent: { _, id in
            HostConnection.receipts[id] = try? self.json(#"{"status":"completed","watcherManage":{"status":"refused","code":"UNKNOWN_TARGET","message":"That thread isn’t there any more. Nothing changed.","retryable":false}}"#)
        })
        await model.setWatched(worker, true)
        XCTAssertEqual(model.feedback, "That thread isn’t there any more. Nothing changed.")
        XCTAssertNil(model.watchNotice)
        // Lost again, with no receipt to read.
        manage({ _, _ in throw ClientError.uncertain }, read: { self.page(Spec(watched: false)) })
        await model.setWatched(worker, true)
        XCTAssertEqual(model.feedback, WatcherWords.watchUnconfirmed("Fix login test", watched: true, computer: "Laptop"))
        XCTAssertEqual(model.feedback, "Laptop didn’t confirm that Watcher is watching Fix login test. Check Watched before you try again.")
        XCTAssertEqual(try calls("watcher-phone-watch").count, 3, "One send for each press, never again on its own")
        model.phase(.background)
    }

    @MainActor func testAThreadWatchedOnlyForARequestIsPromisedNothingPastTheUsersOwnSend() async throws {
        // The computer keeps standing watches, but `t` is watched only because it takes part in Watcher's request.
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(standing: false))
        XCTAssertTrue(model.watchedByWatcher(worker))
        XCTAssertEqual(model.watchedLine(worker), WatchedWords.takeover)
        XCTAssertEqual(model.watchedLine(worker), "Watched by Watcher. If you send here, Watcher stops sending to it.")
        // Under a standing watch it is kept going until the user stops it.
        try push(Spec(observedAt: "2026-10-11T09:01:00.000Z", standing: true))
        await until { model.watchedLine(worker) == WatchedWords.standing }
        XCTAssertEqual(model.watchedLine(worker), WatchedWords.standing)
        XCTAssertEqual(WatcherWords.watchedLead(1, standing: 0),
                       "Watcher keeps this thread going on its own and brings you its questions and permissions. It is watched for a request: if you send to it yourself, Watcher stops sending to it.")
        XCTAssertEqual(WatcherWords.watchedLead(3, standing: 1),
                       "Watcher keeps these 3 threads going on its own and brings you their questions and permissions. A thread you watch stays watched until you stop it. One watched for a request stops when you send to it yourself.")
        model.phase(.background)
    }

    @MainActor func testAWatchedThreadsReplyBoxSaysWatcherWaitsWhileTheUsersTurnRuns() async throws {
        let model = try await fixture(features: Self.manageFeatures, spec: Spec(standing: true, paused: true))
        XCTAssertTrue(model.watchedByWatcher(worker))
        XCTAssertEqual(model.watchedLine(worker), WatchedWords.paused)
        XCTAssertEqual(model.watchedLine(worker), "Watched by Watcher. While your own turn here runs, it can only steer that turn.")
        XCTAssertEqual(model.watchHost(for: worker), laptop, "Stop watching goes to the computer that watches it")
        try push(Spec(observedAt: "2026-10-11T09:01:00.000Z", standing: true))
        await until { model.watchedLine(worker) == WatchedWords.standing }
        XCTAssertEqual(model.watchedLine(worker), WatchedWords.standing, "Once the turn ends, Watcher keeps it going")
        model.phase(.background)
    }

    func testWatchedSaysWhatWatcherLastDidAndWhatWatchingMeans() throws {
        let started = try XCTUnwrap(try decoded(Spec(standing: true)).watched.first)
        let at = try XCTUnwrap(WatcherWords.clock("2026-10-11T08:01:00.000Z"))
        XCTAssertEqual(WatcherWords.doing(started, in: try decoded(Spec(standing: true))), "Watcher started it at \(at).",
                       "From Watcher's own receipt for the thread")
        let paused = try decoded(Spec(standing: true, paused: true))
        XCTAssertEqual(WatcherWords.doing(try XCTUnwrap(paused.watched.first), in: paused), "You sent here yourself. Until that turn ends, Watcher can only steer it.")
        // A thread watched with nothing sent yet says since when.
        let json = page(Spec(standing: true)).replacingOccurrences(of: #""threadId":"t"},"title":"Fix login test","provider":"claude","action""#,
                                                                   with: #""threadId":"other"},"title":"Other","provider":"claude","action""#)
        let quiet = try JSONDecoder().decode(WatcherPage.self, from: Data(json.utf8))
        XCTAssertEqual(WatcherWords.doing(try XCTUnwrap(quiet.watched.first), in: quiet), "Watching since \(at). Nothing sent yet.")
        XCTAssertEqual(WatcherWords.watchedLead(0), "Watcher watches no threads yet. Watch one here or from its page, and Watcher keeps it going until you stop it.")
        XCTAssertEqual(WatcherWords.watchedLead(1), "Watcher keeps this thread going on its own and brings you its questions and permissions. It stays watched until you stop it.")
        XCTAssertEqual(WatcherWords.watchedLead(7), "Watcher keeps these 7 threads going on its own and brings you their questions and permissions. Each stays watched until you stop it.")
    }

    // MARK: What Watcher changed itself (mark B)

    func testALineSaysWhenWatcherChangedFilesItselfUnderThatReply() throws {
        let silent = try decoded(Spec(changed: ["README.md", "docs/guide.md"]))
        let order = WatcherConversation.items(silent).map(\.id)
        XCTAssertEqual(order, ["message/ask", "message/started", "receipts/aaaaaaaa-0000-4000-8000-000000000001/started", "own/started"],
                       "After the reply and what Watcher did for it")
        guard case .ownChange(let change)? = WatcherConversation.items(silent).last else { return XCTFail("No line") }
        XCTAssertNil(change.reason, "It gave no reason")
        XCTAssertEqual(WatcherWords.ownChangeHeadline(change.fileCount), "Watcher changed 2 files itself.")
        XCTAssertEqual(WatcherWords.ownChangeToggle(2, open: false), "Show the 2 files")
        XCTAssertEqual(WatcherWords.ownChangeToggle(2, open: true), "Hide the 2 files")
        XCTAssertEqual(WatcherWords.ownChangeToggle(1, open: false), "Show the file")
        XCTAssertEqual(WatcherWords.ownChangeHeadline(1), "Watcher changed 1 file itself.")
        let said = try decoded(Spec(changed: ["README.md"], reason: "A one-word typo is smaller than briefing a thread."))
        XCTAssertEqual(said.ownChange(for: "started")?.reason, "A one-word typo is smaller than briefing a thread.")
        // A mark whose reply isn't in the conversation says nothing on its own.
        let gone = page(Spec(changed: ["README.md"])).replacingOccurrences(of: #""replyMessageId":"started","turnId""#, with: #""replyMessageId":"elsewhere","turnId""#)
        let orphan = try JSONDecoder().decode(WatcherPage.self, from: Data(gone.utf8))
        XCTAssertFalse(WatcherConversation.items(orphan).contains { if case .ownChange = $0 { return true } else { return false } })
        XCTAssertTrue(WatcherConversation.items(try decoded()).allSatisfy { if case .ownChange = $0 { return false } else { return true } },
                      "A reply in which Watcher changed nothing has no line")
    }

    // MARK: Where the reader stands (#1277)

    /// A reader who lets go with a waiting card in view is held on it, even with the page's end in view, so Watcher's new
    /// words never push it under the box. A reader who sees no card follows the new words where they see the newest words
    /// or the end, and a reader of earlier messages follows nothing.
    func testAReaderOnAWaitingCardIsHeldThereRatherThanFollowingNewWords() {
        // The header ends at 140 and the box starts at 600.
        func place(newest: CGFloat, end: CGFloat, cards: [String: CGRect] = [:]) -> WatcherReaderPlace {
            WatcherReaderPlace(newest: newest, end: end, top: 140, dockTop: 600, cards: cards)
        }
        let whole = CGRect(x: 16, y: 340, width: 340, height: 230)
        let onCard = place(newest: 320, end: 590, cards: ["login": whole])
        XCTAssertEqual(onCard.heldCard, "login", "The card is whole above the box")
        XCTAssertFalse(onCard.following, "The end is in view, but the card holds the page")

        let barelyShowing = place(newest: 560, end: 860, cards: ["login": CGRect(x: 16, y: 580, width: 340, height: 260)])
        XCTAssertNil(barelyShowing.heldCard, "Less than a reading's worth of the card shows above the box")
        XCTAssertTrue(barelyShowing.following, "The newest words are in view, so the page follows them")

        let scrolledPast = place(newest: 100, end: 400, cards: ["login": CGRect(x: 16, y: -140, width: 340, height: 230)])
        XCTAssertNil(scrolledPast.heldCard, "A card above the header isn't the one the reader is on")
        XCTAssertTrue(scrolledPast.following, "The page's end is in view")

        let two = place(newest: 160, end: 595, cards: ["login": CGRect(x: 16, y: 180, width: 340, height: 180),
                                                       "notes": CGRect(x: 16, y: 380, width: 340, height: 200)])
        XCTAssertEqual(two.heldCard, "notes", "With two in view, the lower one is kept whole above the box")

        let reading = place(newest: 1600, end: 1900, cards: ["login": CGRect(x: 16, y: 1640, width: 340, height: 230)])
        XCTAssertNil(reading.heldCard)
        XCTAssertFalse(reading.following, "A reader of earlier messages is left where they are")
    }

    /// A card the reader sees whole is the one they are on, even with a lower card cut off by the box: holding the lower
    /// one whole above the box would push the whole one under the header.
    func testAWholeCardIsHeldOverALowerOneTheBoxCutsOff() {
        let question = CGRect(x: 16, y: 200, width: 340, height: 260)
        let permission = CGRect(x: 16, y: 480, width: 340, height: 450)
        let place = WatcherReaderPlace(newest: 180, end: 990, top: 140, dockTop: 600,
                                       cards: ["login": question, "notes": permission])
        XCTAssertEqual(place.heldCard, "login", "The question is whole above the box; the permission under it is cut off")
        XCTAssertFalse(place.following)

        // With none whole, the one the reader sees most of: 220 points of the question, 120 of the permission.
        let neitherWhole = WatcherReaderPlace(newest: 60, end: 990, top: 140, dockTop: 600,
                                              cards: ["login": CGRect(x: 16, y: 100, width: 340, height: 260),
                                                      "notes": permission])
        XCTAssertEqual(neitherWhole.heldCard, "login", "With none whole, the one the reader sees most of is kept")
        let lowerShowsMore = WatcherReaderPlace(newest: 60, end: 990, top: 140, dockTop: 600,
                                                cards: ["login": CGRect(x: 16, y: -60, width: 340, height: 260),
                                                        "notes": CGRect(x: 16, y: 300, width: 340, height: 450)])
        XCTAssertEqual(lowerShowsMore.heldCard, "notes")
    }

    /// The card the reader is on goes back where they left it when the page changes around it, no lower than keeps it
    /// whole above the box and never under the header.
    func testTheHeldCardGoesBackWhereTheReaderLeftIt() throws {
        // The header ends at 140 and the box starts at 600: 460 points of room. The reader left the card 60 points below
        // the header.
        func anchor(_ card: CGRect, offset: CGFloat = 60, dockTop: CGFloat = 600) -> CGFloat? {
            WatcherReaderPlace.anchor(card: card, offset: offset, top: 140, dockTop: dockTop)
        }
        XCTAssertNil(anchor(CGRect(x: 16, y: 200.5, width: 340, height: 260)), "Where the reader left it, nothing moves")
        // A card under it was removed and the page's bottom carried this one down by 90 points: back to 60 below the
        // header, which `scrollTo` does by lining up the point 60 / (460 - 260) down the card and the page.
        let carried = try XCTUnwrap(anchor(CGRect(x: 16, y: 290, width: 340, height: 260)))
        XCTAssertEqual(carried, 0.3, accuracy: 0.0001)
        XCTAssertEqual(140 + carried * 460 - carried * 260, 200, accuracy: 0.0001, "The card's top lands where it was")
        // The keyboard raised the box to 380: the card goes up as far as keeps it whole above the box, and no farther than
        // the header.
        XCTAssertEqual(anchor(CGRect(x: 16, y: 200, width: 340, height: 200), dockTop: 380), 1, "Its bottom meets the box")
        XCTAssertEqual(anchor(CGRect(x: 16, y: 200, width: 340, height: 300), dockTop: 380), 0,
                       "A card taller than the room comes no lower than the header")
        // A card taller than the room, its top left 100 points above the header and carried 90 points down: back to 40.
        let tall = try XCTUnwrap(anchor(CGRect(x: 16, y: 130, width: 340, height: 600), offset: -100))
        XCTAssertEqual(140 + tall * 460 - tall * 600, 40, accuracy: 0.0001, "The tall card's top lands where it was")
        // Carried so far up that its bottom left the box: back down only as far as keeps it filling the room.
        let lifted = try XCTUnwrap(anchor(CGRect(x: 16, y: -300, width: 340, height: 600), offset: -300))
        XCTAssertEqual(140 + lifted * 460 - lifted * 600, 0, accuracy: 0.0001, "Its bottom meets the box")
        // Pushed up behind the header, it comes back down.
        let hidden = try XCTUnwrap(anchor(CGRect(x: 16, y: 40, width: 340, height: 260), offset: 0))
        XCTAssertEqual(hidden, 0, accuracy: 0.0001)
    }

    // MARK: The bar that slides away (#1278)

    /// Watcher's bar slides away once the user has read down the page a little way, comes back once they have gone up a
    /// little way, and always shows near the page's top. A move the user didn't make counts for neither.
    func testWatchersBarSlidesAwayOnTheWayDownAndBackOnTheWayUp() {
        var slide = WatcherBarSlide()
        XCTAssertNil(slide.moved(to: 400, counts: true), "The first look only says where the page is")
        XCTAssertNil(slide.moved(to: 410, counts: true), "Ten points down isn't enough")
        XCTAssertEqual(slide.moved(to: 420, counts: true), true, "Twenty points down slides it away")
        XCTAssertEqual(slide.moved(to: 500, counts: true), true)
        XCTAssertNil(slide.moved(to: 490, counts: true), "Turning back starts the count again")
        XCTAssertEqual(slide.moved(to: 480, counts: true), false, "Twenty points up brings it back")

        // The page following Watcher's words, or changing height, moves it without the user.
        XCTAssertNil(slide.moved(to: 900, counts: false))
        XCTAssertNil(slide.moved(to: 910, counts: true), "A move that didn't count starts the count again")
        XCTAssertEqual(slide.moved(to: 920, counts: true), true)

        XCTAssertEqual(slide.moved(to: 6, counts: false), false, "Near the top it always shows")
        XCTAssertEqual(slide.moved(to: -40, counts: true), false, "And past it, pulling to read the page again")
    }

    /// While a card waits on the user, the bar stays where it is however the page moves, and comes back if it was away
    /// when the card arrived (#1288). Once no card waits, reading down slides it away again, counted from there.
    func testTheBarStaysWhileACardWaits() {
        var slide = WatcherBarSlide()
        XCTAssertNil(slide.moved(to: 400, counts: true, pinned: true), "The first look only says where the page is")
        XCTAssertEqual(slide.moved(to: 460, counts: true, pinned: true), false, "Reading down with a card waiting keeps the bar")
        XCTAssertEqual(slide.moved(to: 520, counts: false, pinned: true), false, "So does the page moving for the card")
        XCTAssertNil(slide.moved(to: 530, counts: true), "With the card answered, the count starts again")
        XCTAssertEqual(slide.moved(to: 545, counts: true), true, "Twenty-five points down slides it away")
        XCTAssertEqual(slide.moved(to: 545, counts: false, pinned: true), false, "A card arriving brings it back")
        XCTAssertEqual(slide.moved(to: 400, counts: true, pinned: true), false, "Going up with a card waiting keeps it")
    }

    func testWatcherPermissionWordsFollowTheiPhonesOwn() {
        XCTAssertEqual(WatcherPermissions.modes.map(WatcherPermissions.name), ["Ask before actions", "Allow edits", "Allow actions", "Full access"])
        XCTAssertEqual(WatcherPermissions.line("auto", provider: "Codex", computer: "Laptop"), "Codex decides what to ask you about.")
        XCTAssertEqual(WatcherPermissions.line("full-access", provider: "Codex", computer: "Laptop"),
                       "Edits files and runs any command without asking, anywhere on Laptop.")
        XCTAssertEqual(WatcherPermissions.foot, "When Watcher asks, you can allow it once, not for good. Its instructions still tell it to hand changes to a thread.")
        XCTAssertFalse(WatcherPermissions.grants("approval-required"))
        XCTAssertTrue(WatcherPermissions.grants("auto-accept-edits"))
    }
}
