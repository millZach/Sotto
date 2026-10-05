import XCTest
import SottoCore

/// Records the alerts the model posts, in place of iOS's notification centre.
@MainActor final class FakeAlerts: AlertPosting {
    struct Posted { let alert: ThreadAlert; let sound: Bool }
    var posted: [Posted] = []
    var current = AlertPermission.undecided
    var answer = true
    var asked = 0
    func permission() async -> AlertPermission { current }
    func requestPermission() async -> Bool { asked += 1; current = answer ? .allowed : .denied; return answer }
    func post(_ alert: ThreadAlert, sound: Bool) { posted.append(Posted(alert: alert, sound: sound)) }
}

final class AlertModelTests: XCTestCase {
    private let laptop = "00000000-0000-4000-8000-000000000001"
    private var suites: [String] = []
    override func tearDown() {
        for suite in suites { UserDefaults().removePersistentDomain(forName: suite) }
        suites = []
        super.tearDown()
    }
    private func json(_ value: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(value.utf8)) }
    /// A thread list as the laptop sends it. Each thread is `(id, status, request IDs, finished unread)`.
    private func shell(_ threads: [(String, String, [String], Bool)], mayAnswer: Bool = false) throws -> JSONValue {
        let rows = threads.map { thread -> String in
            let requests = thread.2.map { #"{"id":"\#($0)","kind":"question","text":"Which shortcut?","options":[]}"# }.joined(separator: ",")
            return #"{"id":"\#(thread.0)","projectId":"p","title":"Thread \#(thread.0)","providerId":"claude","status":"\#(thread.1)","requests":[\#(requests)],"finishedUnread":\#(thread.3)}"#
        }.joined(separator: ",")
        return try json(#"{"hostId":"\#(laptop)","clientCapabilities":{"mayAnswer":\#(mayAnswer)},"host":{"hostId":"\#(laptop)","name":"Laptop","threads":[\#(rows)],"projects":[{"id":"p","title":"Project","path":"D:\\Project"}],"models":[{"id":"m","name":"Model","provider":"Codex","providerId":"codex","ready":true,"runtimeModes":["approval-required","full-access"],"reasoningEfforts":["low","high"]},{"id":"n","name":"Other","provider":"Codex","providerId":"codex","ready":true,"runtimeModes":["approval-required"]}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"projects":true,"threads":true},"providers":[{"id":"codex","connection":"connected","capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"projects":true,"threads":true}}]}}"#)
    }
    @MainActor private func fixture(_ threads: [(String, String, [String], Bool)], switches: [String: Bool] = [:],
                                    mayAnswer: Bool = false) async throws -> (AppModel, FakeAlerts, UserDefaults) {
        TestKeychain.items = [:]; HostConnection.instances = []; HostConnection.afterGreeting = nil
        HostConnection.failDetail = false; HostConnection.holdDetail = false; HostConnection.mayAnswer = mayAnswer
        TestKeychain.locked = false; TestKeychain.unreadableAccount = nil
        HostConnection.receipt = .object(["status": .string("unknown")]); HostConnection.loseAcknowledgement = false
        HostConnection.features = ["host-folders"]; HostConnection.receipts = [:]; HostConnection.shells = [:]
        HostConnection.commandHandler = nil; HostConnection.folderHandler = nil
        HostConnection.stageHandler = nil; HostConnection.previewHandler = nil
        HostConnection.detail = try json(#"{"threadId":"a","revision":1,"messages":[]}"#)
        let store = TestKeychain.store
        try store.write([laptop], account: ComputerStore.indexAccount)
        let pairing = try json(#"{"v":1,"hostId":"\#(laptop)","clientId":"phone","token":"fixture"}"#).decode(Pairing.self)
        try store.write(SavedComputer(address: "https://laptop.example.ts.net:8443", pairing: pairing, reportedName: "LAPTOP-RUSSH2J5"),
                        account: ComputerStore.account(laptop))
        HostConnection.shells[laptop] = try shell(threads, mayAnswer: mayAnswer)
        let suite = "sotto-alert-tests-" + UUID().uuidString
        suites.append(suite)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        for (key, on) in switches { defaults.set(on, forKey: key) }
        let model = AppModel(keychain: store, receiptSleep: { _ in })
        let alerts = FakeAlerts()
        model.preferences = PhonePreferences(defaults: defaults)
        model.alerts = alerts
        model.phase(.active); await model.reconnectAll(); await model.waitForActivation()
        return (model, alerts, defaults)
    }
    @MainActor private func push(_ threads: [(String, String, [String], Bool)]) throws {
        let connection = try XCTUnwrap(HostConnection.instances.last { $0.hostID == laptop })
        connection.push(.shell(try shell(threads).decode(Shell.self)))
    }
    private let allOn = [PhonePreferenceKey.notifyNeedsYou: true, PhonePreferenceKey.notifyFinished: true,
                         PhonePreferenceKey.notifyFailed: true]

    @MainActor func testTheFirstListAfterConnectingAlertsNothing() async throws {
        let (_, alerts, _) = try await fixture([("a", "error", ["r1"], false), ("b", "idle", [], true)], switches: allOn)
        XCTAssertTrue(alerts.posted.isEmpty, "What a computer already had is not news")
    }
    @MainActor func testNewsAlertsOnceWithItsComputerAndSound() async throws {
        var switches = allOn; switches[PhonePreferenceKey.notifySound] = true
        let (model, alerts, _) = try await fixture([("a", "running", [], false), ("b", "running", [], false)], switches: switches)
        XCTAssertEqual(model.status(laptop), .online, "The laptop is connected before anything is pushed")
        XCTAssertNil(model.feedback)
        XCTAssertTrue(model.preferences.notifyNeedsYou && model.preferences.notifySound)
        XCTAssertNotNil(model.alerts)
        try push([("a", "running", ["r1"], false), ("b", "running", [], false)])
        XCTAssertNil(model.feedback, "The pushed list was accepted")
        XCTAssertEqual(model.thread(ThreadRef(hostID: laptop, threadID: "a"))?.requests.map(\.id), ["r1"], "The pushed list reached the model")
        XCTAssertEqual(alerts.posted.map(\.alert.kind), [.question])
        XCTAssertEqual(alerts.posted.first?.alert.body, "Claude Code is asking a question on LAPTOP-RUSSH2J5.")
        XCTAssertEqual(alerts.posted.first?.alert.title, "Thread a")
        XCTAssertEqual(alerts.posted.first?.sound, true)
        try push([("a", "running", ["r1"], false), ("b", "running", [], false)])
        XCTAssertEqual(alerts.posted.count, 1, "The same request is not news twice")
        try push([("a", "running", ["r1"], false), ("b", "idle", [], true)])
        try push([("a", "error", [], false), ("b", "idle", [], true)])
        XCTAssertEqual(alerts.posted.map(\.alert.kind), [.question, .finished, .failed])
    }
    @MainActor func testTheOpenThreadAndSwitchedOffAlertsStaySilent() async throws {
        let (model, alerts, defaults) = try await fixture([("a", "running", [], false), ("b", "running", [], false)],
                                                          switches: [PhonePreferenceKey.notifyNeedsYou: true])
        await model.select(ThreadRef(hostID: laptop, threadID: "a"))
        try push([("a", "running", ["r1"], false), ("b", "error", [], false)])
        XCTAssertTrue(alerts.posted.isEmpty, "The thread on screen and a failure with its switch off are silent")
        model.phase(.inactive)
        try push([("a", "running", ["r1", "r2"], false), ("b", "error", [], false)])
        XCTAssertEqual(alerts.posted.map(\.alert.ref.threadID), ["a"], "Once the app is off screen the open thread is not on screen")
        defaults.set(false, forKey: PhonePreferenceKey.notifyNeedsYou)
        model.phase(.active)
        try push([("a", "running", ["r1", "r2", "r3"], false), ("b", "running", ["r4"], false)])
        XCTAssertEqual(alerts.posted.count, 1)
    }
    @MainActor func testAReconnectStartsFromWhatIsThereAgain() async throws {
        let (model, alerts, _) = try await fixture([("a", "running", [], false)], switches: allOn)
        model.phase(.background)
        HostConnection.shells[laptop] = try shell([("a", "error", ["r1"], true)])
        model.phase(.active); await model.reconnectAll(); await model.waitForActivation()
        XCTAssertTrue(alerts.posted.isEmpty, "What happened while away is on the list, not in an alert")
        try push([("a", "error", ["r1", "r2"], true)])
        XCTAssertEqual(alerts.posted.map(\.alert.kind), [.question])
    }
    @MainActor func testTurningASwitchOnAsksIOSOnlyWhileItHasNotAnswered() async throws {
        let (model, alerts, _) = try await fixture([])
        let allowedFirst = await model.allowAlerts()
        XCTAssertTrue(allowedFirst); XCTAssertEqual(alerts.asked, 1)
        let allowedAgain = await model.allowAlerts()
        XCTAssertTrue(allowedAgain); XCTAssertEqual(alerts.asked, 1, "Asked once")
        alerts.current = .denied
        let refused = await model.allowAlerts()
        XCTAssertFalse(refused); XCTAssertEqual(alerts.asked, 1, "A refusal is the user's; Settings says where to change it")
        let state = await model.alertPermission()
        XCTAssertEqual(state, .denied)
    }
    @MainActor func testATappedAlertOpensOnlyAComputerThisIPhoneHolds() async throws {
        let (model, _, _) = try await fixture([("a", "running", [], false)])
        model.openFromAlert(ThreadRef(hostID: "00000000-0000-4000-8000-000000000009", threadID: "a"))
        XCTAssertNil(model.alertOpened)
        model.openFromAlert(ThreadRef(hostID: laptop, threadID: "a"))
        XCTAssertEqual(model.alertOpened, ThreadRef(hostID: laptop, threadID: "a"))
    }

    // MARK: New-thread defaults

    @MainActor func testNewThreadStartsOnTheIPhonesDefaultsWhereTheComputerOffersThem() async throws {
        let (model, _, defaults) = try await fixture([])
        defaults.set("n", forKey: PhonePreferenceKey.newThreadModel)
        defaults.set("independent", forKey: PhonePreferenceKey.newThreadWorkingCopy)
        XCTAssertEqual(model.initialCreationModelID(laptop), "n")
        XCTAssertEqual(model.initialCreationWorkingCopy, .independent)
        defaults.set("elsewhere", forKey: PhonePreferenceKey.newThreadModel)
        XCTAssertEqual(model.initialCreationModelID(laptop), "m", "A model this computer doesn't offer leaves its own choice")
        let chosen = try XCTUnwrap(model.creationModels(laptop).first { $0.id == "m" })
        defaults.set("low", forKey: PhonePreferenceKey.newThreadEffort)
        XCTAssertEqual(model.initialCreationEffort(laptop, model: chosen), "low")
        XCTAssertEqual(model.defaultModelChoices.map(\.id), ["m", "n"])
    }
    @MainActor func testAPermissionDefaultThatGrantsWaitsForCanAnswer() async throws {
        let (model, _, defaults) = try await fixture([])
        defaults.set("full-access", forKey: PhonePreferenceKey.newThreadPermission)
        let chosen = try XCTUnwrap(model.creationModels(laptop).first { $0.id == "m" })
        XCTAssertEqual(model.initialCreationPermission(laptop, model: chosen), StartingPermission(id: "approval-required", heldBack: true))
        let (allowed, _, allowedDefaults) = try await fixture([], mayAnswer: true)
        allowedDefaults.set("full-access", forKey: PhonePreferenceKey.newThreadPermission)
        let offered = try XCTUnwrap(allowed.creationModels(laptop).first { $0.id == "m" })
        XCTAssertEqual(allowed.initialCreationPermission(laptop, model: offered), StartingPermission(id: "full-access", heldBack: false))
    }
    @MainActor func testANewWorktreeIsAskedForOnTheCreateCommand() async throws {
        let (model, _, _) = try await fixture([])
        HostConnection.commandHandler = { host, command, id in
            guard case .object(var root) = HostConnection.shells[host]!, case .object(var source) = root["host"] else { throw ClientError.invalidProtocol }
            source["threads"] = .array([.object(["id": command["threadId"], "projectId": command["projectId"], "title": .string("New thread"),
                                                 "providerId": .string("codex"), "status": .string("idle"), "requests": .array([])])])
            root["host"] = .object(source)
            HostConnection.shells[host] = .object(root)
            HostConnection.receipts[id] = .object(["status": .string("completed")])
            return .object(root)
        }
        let created = await model.createThread(on: laptop, projectID: "p", folder: nil, modelID: "m", effort: "high",
                                               permissionID: "approval-required", workingCopy: .independent)
        XCTAssertNotNil(created)
        let command = try XCTUnwrap(HostConnection.instances.flatMap(\.commands).first)
        XCTAssertEqual(command["workingCopy"], .string("independent"))
        XCTAssertEqual(command["runtimeMode"], .string("approval-required"))
    }
}
