import XCTest
import Combine
import SottoCore

final class AppModelTests: XCTestCase {
    /// Lets the model's own tasks run until `condition` holds, or ten seconds pass.
    @MainActor private func until(_ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(10)
        while !condition() && Date() < deadline { await Task.yield() }
    }
    @MainActor private func fixture() throws -> (AppModel, ThreadRef) {
        HostConnection.instances = []; HostConnection.failDetail = false; HostConnection.failConnect = false; HostConnection.holdDetail = false; TestKeychain.items = [:]
        HostConnection.connectAttempts = 0
        HostConnection.afterGreeting = nil
        HostConnection.revokeFailure = nil; HostConnection.revokeHandler = nil
        HostConnection.foundHealth = nil; HostConnection.freshPairing = nil; HostConnection.pairCalls = 0; HostConnection.revoked = []
        TestKeychain.unwritableAccount = nil
        TestKeychain.locked = false; TestKeychain.unreadableAccount = nil
        HostConnection.mayAnswer = false; HostConnection.receipt = .object(["status": .string("unknown")])
        HostConnection.loseAcknowledgement = false
        HostConnection.shells = [:]; HostConnection.commandHandler = nil; HostConnection.folderHandler = nil
        HostConnection.stageHandler = nil; HostConnection.previewHandler = nil
        HostConnection.receipts = [:]; HostConnection.features = ["host-folders"]
        let host = "00000000-0000-4000-8000-000000000001"
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data(#"{"v":1,"hostId":"\#(host)","clientId":"phone","token":"fixture"}"#.utf8))
        let saved = SavedComputer(address: "https://laptop.example.ts.net:8443", pairing: pairing, reportedName: "Laptop")
        let store = TestKeychain.store
        try store.write([host], account: ComputerStore.indexAccount)
        try store.write(saved, account: ComputerStore.account(host))
        HostConnection.shell = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"hostId":"\#(host)","host":{"hostId":"\#(host)","name":"Laptop","threads":[{"id":"t","projectId":"p","title":"Thread","status":"idle","requests":[]}],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}}"#.utf8))
        HostConnection.detail = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"threadId":"t","revision":1,"messages":[{"id":"m","role":"assistant","text":"Ready"}]}"#.utf8))
        return (AppModel(keychain: TestKeychain.store), ThreadRef(hostID: host, threadID: "t"))
    }
    @MainActor func testPairChecksStorageAndRevokesWhenSavingFreshPairingFails() async throws {
        let (_, ref) = try fixture()
        defer { TestKeychain.locked = false; TestKeychain.unwritableAccount = nil }
        let saved = try XCTUnwrap(TestKeychain.store.read(SavedComputer.self, account: ComputerStore.account(ref.hostID)))
        TestKeychain.items = [:]
        HostConnection.foundHealth = try JSONDecoder().decode(Health.self, from: Data(#"{"v":1,"hostId":"\#(ref.hostID)","status":"ready"}"#.utf8))
        HostConnection.freshPairing = saved.pairing
        let model = AppModel(keychain: TestKeychain.store)
        await model.find("laptop.example.ts.net")
        XCTAssertNotNil(model.found)
        TestKeychain.locked = true
        await model.pair(code: "ABCDEFGH")
        XCTAssertEqual(HostConnection.pairCalls, 0)
        TestKeychain.locked = false
        TestKeychain.unwritableAccount = ComputerStore.account(ref.hostID)
        await model.pair(code: "ABCDEFGH")
        XCTAssertEqual(HostConnection.pairCalls, 1)
        XCTAssertEqual(HostConnection.revoked, [saved.pairing.clientId])
        XCTAssertTrue(model.computers.isEmpty)
        XCTAssertNil(TestKeychain.items[ComputerStore.account(ref.hostID)])
        for account in [ComputerStore.indexAccount, ComputerStore.pendingAccount] {
            TestKeychain.unwritableAccount = account
            await model.pair(code: "ABCDEFGH")
            XCTAssertTrue(model.computers.isEmpty)
            XCTAssertNil(TestKeychain.items[ComputerStore.account(ref.hostID)])
        }
        XCTAssertEqual(HostConnection.pairCalls, 3)
        XCTAssertEqual(HostConnection.revoked, Array(repeating: saved.pairing.clientId, count: 3))
    }
    @MainActor func testFailedPairingRollbackCannotDeleteANewerPairingWhileRevocationWaits() async throws {
        let (_, ref) = try fixture()
        let saved = try XCTUnwrap(TestKeychain.store.read(SavedComputer.self, account: ComputerStore.account(ref.hostID)))
        TestKeychain.items = [:]
        HostConnection.foundHealth = try JSONDecoder().decode(Health.self, from: Data(#"{"v":1,"hostId":"\#(ref.hostID)","status":"ready"}"#.utf8))
        HostConnection.freshPairing = saved.pairing
        let model = AppModel(keychain: TestKeychain.store)
        await model.find("laptop.example.ts.net")
        TestKeychain.unwritableAccount = ComputerStore.indexAccount
        let revoking = expectation(description: "The failed pairing waits for revocation")
        var release: CheckedContinuation<Void, Never>?
        HostConnection.revokeHandler = { _ in
            await withCheckedContinuation { continuation in
                release = continuation; revoking.fulfill()
            }
        }
        defer { release?.resume(); HostConnection.revokeHandler = nil; TestKeychain.unwritableAccount = nil }
        let first = Task { await model.pair(code: "ABCDEFGH") }
        await fulfillment(of: [revoking], timeout: 10)
        model.closeAdding()
        TestKeychain.unwritableAccount = nil
        let newer = try JSONDecoder().decode(Pairing.self, from: Data(#"{"v":1,"hostId":"\#(ref.hostID)","clientId":"new-phone","token":"new-fixture"}"#.utf8))
        HostConnection.freshPairing = newer
        model.startAdding()
        await model.find("laptop.example.ts.net")
        await model.pair(code: "ABCDEFGH")
        XCTAssertEqual(model.computers.first?.pairing, newer)
        release?.resume(); release = nil
        await first.value
        XCTAssertEqual(try TestKeychain.store.read(SavedComputer.self, account: ComputerStore.account(ref.hostID))?.pairing, newer)
        let relaunched = AppModel(keychain: TestKeychain.store)
        XCTAssertEqual(relaunched.computers.first?.pairing, newer)
        XCTAssertNil(relaunched.feedback)
        XCTAssertEqual(HostConnection.revoked, [saved.pairing.clientId])
    }
    @MainActor func testRemoveReportsAnOfflineComputerAsUnreachable() async throws {
        let (model, ref) = try fixture()
        HostConnection.revokeFailure = .hostUnreachable("Laptop")
        await model.remove(ref.hostID)
        XCTAssertTrue(model.computers.isEmpty)
        XCTAssertNil(TestKeychain.items[ComputerStore.account(ref.hostID)])
        XCTAssertTrue(model.feedback?.contains("It couldn’t be reached") == true)
        XCTAssertFalse(model.feedback?.contains("couldn’t confirm removal there") == true)
        XCTAssertEqual(model.pairFeedback, model.feedback)
    }
    @MainActor func testRemoveKeepsLocalRemovalWhenRemoteRemovalIsUnconfirmed() async throws {
        let (model, ref) = try fixture()
        HostConnection.revokeFailure = .invalidIdentity
        defer { HostConnection.revokeFailure = nil }
        await model.remove(ref.hostID)
        XCTAssertTrue(model.computers.isEmpty)
        XCTAssertNil(TestKeychain.items[ComputerStore.account(ref.hostID)])
        XCTAssertTrue(model.feedback?.contains("couldn’t confirm removal there") == true)
        XCTAssertTrue(model.feedback?.contains("Settings › Phones") == true)
    }
    @MainActor func testDroppedConnectionRetriesWithoutResendingPendingCommands() async throws {
        let (_, ref) = try fixture()
        let clock = RetryClock()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, draftID: "draft", kind: "reply")
        try TestKeychain.store.write([marker], account: ComputerStore.pendingAccount)
        let waiting = expectation(description: "A disconnected computer schedules a retry")
        let model = AppModel(keychain: TestKeychain.store, retryJitter: { 1 }, retrySleep: { delay in
            waiting.fulfill()
            try await clock.wait(delay)
        })
        let initial = expectation(description: "Initial connection")
        HostConnection.afterGreeting = { _ in initial.fulfill() }
        model.phase(.active)
        await fulfillment(of: [initial], timeout: 10)
        let connection = try XCTUnwrap(HostConnection.instances.last)
        connection.onDisconnect?()
        XCTAssertFalse(model.online(ref.hostID))
        await fulfillment(of: [waiting], timeout: 10)
        let delays = await clock.delays
        XCTAssertEqual(delays, [1_000_000_000])
        let restored = expectation(description: "Connection restored")
        HostConnection.afterGreeting = { _ in restored.fulfill() }
        await clock.release()
        await fulfillment(of: [restored], timeout: 10)
        XCTAssertTrue(model.online(ref.hostID))
        XCTAssertTrue(connection.commands.isEmpty)
        XCTAssertEqual(model.pending, [marker])
        model.phase(.background)
    }
    @MainActor func testALostConnectionRetriesQuietlyForAboutAMinuteThenWaitsForTheUser() async throws {
        let (_, ref) = try fixture()
        let clock = RetryClock()
        let model = AppModel(keychain: TestKeychain.store, retryJitter: { 1 }, retrySleep: { delay in _ = await clock.record(delay) })
        let initial = expectation(description: "Initial connection")
        HostConnection.afterGreeting = { _ in initial.fulfill() }
        model.phase(.active)
        await fulfillment(of: [initial], timeout: 10); await model.waitForActivation()
        HostConnection.afterGreeting = nil
        HostConnection.failConnect = true
        defer { HostConnection.failConnect = false }
        let connection = try XCTUnwrap(HostConnection.instances.last)
        connection.onDisconnect?()
        XCTAssertEqual(model.status(ref.hostID), .connecting, "A lost connection reads as reconnecting while it is tried again")
        await until { model.status(ref.hostID) == .unreachable }
        let delays = await clock.delays
        XCTAssertEqual(delays, [1, 2, 4, 8, 16, 30].map { UInt64($0) * 1_000_000_000 })
        XCTAssertEqual(HostConnection.connectAttempts, 7)
        XCTAssertEqual(model.problem(ref.hostID), "Couldn't reach Laptop. Check that it's on and that Tailscale is connected on this iPhone.")
        // Given up, it waits for the user: coming back to the app and pulling to refresh leave it alone.
        model.phase(.background)
        model.phase(.active); await model.waitForActivation()
        await model.refresh()
        XCTAssertEqual(HostConnection.connectAttempts, 7)
        XCTAssertEqual(model.status(ref.hostID), .unreachable)
        // Its Reconnect tries it, and once it is back a lost connection gets its quiet retries again.
        HostConnection.failConnect = false
        await model.connect(ref.hostID)
        XCTAssertTrue(model.online(ref.hostID))
        connection.onDisconnect?()
        await until { model.online(ref.hostID) }
        XCTAssertTrue(model.online(ref.hostID))
        let again = await clock.delays
        XCTAssertEqual(again.last, 1_000_000_000)
        model.phase(.background)
    }
    @MainActor func testAComputerThatNeverConnectedIsTriedOnceAndWaitsForTheUser() async throws {
        let (_, ref) = try fixture()
        HostConnection.failConnect = true
        defer { HostConnection.failConnect = false }
        let clock = RetryClock()
        let model = AppModel(keychain: TestKeychain.store, retryJitter: { 1 }, retrySleep: { delay in _ = await clock.record(delay) })
        model.phase(.active); await model.waitForActivation()
        XCTAssertEqual(model.status(ref.hostID), .unreachable)
        XCTAssertEqual(HostConnection.connectAttempts, 1)
        let delays = await clock.delays
        XCTAssertTrue(delays.isEmpty, "A computer that never connected is not retried")
        XCTAssertEqual(model.problem(ref.hostID), "Couldn't reach Laptop. Check that it's on and that Tailscale is connected on this iPhone.")
        model.phase(.background)
        model.phase(.active); await model.waitForActivation()
        await model.refresh()
        XCTAssertEqual(HostConnection.connectAttempts, 1, "Coming back and pulling to refresh leave it alone")
        // Its Try again tries it.
        HostConnection.failConnect = false
        await model.connect(ref.hostID)
        XCTAssertTrue(model.online(ref.hostID))
        XCTAssertEqual(HostConnection.connectAttempts, 2)
        model.phase(.background)
    }
    @MainActor func testTheOpenThreadStaysOnScreenWhileItIsReadAgain() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation()
        await model.select(ref)
        XCTAssertEqual(model.detail(for: ref)?.messages.first?.text, "Ready")
        var shownWhileReconnecting: String?
        HostConnection.afterGreeting = { _ in shownWhileReconnecting = model.shown(for: ref)?.messages.first?.text }
        HostConnection.detail = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"threadId":"t","revision":2,"messages":[{"id":"m","role":"assistant","text":"Ready now"}]}"#.utf8))
        await model.connect(ref.hostID)
        HostConnection.afterGreeting = nil
        XCTAssertEqual(shownWhileReconnecting, "Ready", "The thread as last read stays on screen while its computer reconnects")
        XCTAssertEqual(model.shown(for: ref)?.messages.first?.text, "Ready now", "A fresh copy replaces it")
        XCTAssertNil(model.detailStore.held)
        // Leaving the thread and coming back to it keeps it on screen too, even when it can't be read again.
        await model.select(nil)
        XCTAssertNil(model.shown(for: ref))
        HostConnection.failDetail = true
        await model.select(ref)
        XCTAssertNil(model.detail(for: ref))
        XCTAssertEqual(model.shown(for: ref)?.messages.first?.text, "Ready now")
        XCTAssertNotNil(model.detailProblem)
        model.phase(.background)
    }
    @MainActor func testShortConnectionsKeepBackoffUntilLivenessSucceeds() async throws {
        let (_, ref) = try fixture()
        let clock = RetryClock()
        let scheduled = (1...3).map { expectation(description: "Retry \($0) scheduled") }
        let model = AppModel(keychain: TestKeychain.store, retryJitter: { 1 }, retrySleep: { delay in
            let count = await clock.record(delay)
            if count <= scheduled.count { scheduled[count - 1].fulfill() }
            throw CancellationError()
        })
        let initial = expectation(description: "Initial connection")
        HostConnection.afterGreeting = { _ in initial.fulfill() }
        model.phase(.active)
        await fulfillment(of: [initial], timeout: 10)
        HostConnection.afterGreeting = nil
        let connection = try XCTUnwrap(HostConnection.instances.last)
        connection.onDisconnect?()
        await fulfillment(of: [scheduled[0]], timeout: 10)
        await model.connect(ref.hostID)
        connection.onDisconnect?()
        await fulfillment(of: [scheduled[1]], timeout: 10)
        let shortDelays = await clock.delays
        XCTAssertEqual(shortDelays, [1_000_000_000, 2_000_000_000])
        await model.connect(ref.hostID)
        connection.onLiveness?()
        connection.onDisconnect?()
        await fulfillment(of: [scheduled[2]], timeout: 10)
        let recoveredDelays = await clock.delays
        XCTAssertEqual(recoveredDelays, [1_000_000_000, 2_000_000_000, 1_000_000_000])
        model.phase(.background)
    }
    @MainActor func testReconnectDelayIncludesJitterAndKeepsThirtySecondCap() async throws {
        _ = try fixture()
        let clock = RetryClock()
        let capped = expectation(description: "Jittered retry reaches cap")
        let model = AppModel(keychain: TestKeychain.store, retryJitter: { 1.2 }, retrySleep: { delay in
            if await clock.record(delay) == 6 { capped.fulfill(); throw CancellationError() }
        })
        let initial = expectation(description: "Initial connection")
        HostConnection.afterGreeting = { _ in initial.fulfill() }
        model.phase(.active)
        await fulfillment(of: [initial], timeout: 10); await model.waitForActivation()
        HostConnection.afterGreeting = nil
        HostConnection.failConnect = true
        defer { HostConnection.failConnect = false }
        try XCTUnwrap(HostConnection.instances.last).onDisconnect?()
        await fulfillment(of: [capped], timeout: 10)
        let delays = await clock.delays
        XCTAssertEqual(delays, [1.2, 2.4, 4.8, 9.6, 19.2, 30].map { UInt64($0 * 1_000_000_000) })
        model.phase(.background)
    }
    @MainActor func testBackgroundCancelsScheduledReconnect() async throws {
        let (_, ref) = try fixture()
        let clock = RetryClock()
        let waiting = expectation(description: "Retry scheduled")
        let model = AppModel(keychain: TestKeychain.store, retryJitter: { 1 }, retrySleep: { delay in
            waiting.fulfill()
            try await clock.wait(delay)
        })
        let initial = expectation(description: "Initial connection")
        HostConnection.afterGreeting = { _ in initial.fulfill() }
        model.phase(.active)
        await fulfillment(of: [initial], timeout: 10)
        let connection = try XCTUnwrap(HostConnection.instances.last)
        connection.onDisconnect?()
        await fulfillment(of: [waiting], timeout: 10)
        model.phase(.background)
        let unwanted = expectation(description: "No background reconnect")
        unwanted.isInverted = true
        HostConnection.afterGreeting = { _ in unwanted.fulfill() }
        await clock.release()
        await fulfillment(of: [unwanted], timeout: 0.1)
        XCTAssertFalse(model.online(ref.hostID))
    }
    @MainActor func testLockedLaunchLoadsComputersAndMarkersWhenActiveAfterUnlock() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, draftID: "draft", kind: "reply")
        try TestKeychain.store.write([marker], account: ComputerStore.pendingAccount)
        TestKeychain.locked = true
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertFalse(model.storageReady)
        XCTAssertTrue(model.computers.isEmpty)
        model.phase(.active)
        XCTAssertFalse(model.storageReady)
        TestKeychain.locked = false
        let reconnected = expectation(description: "Recovered computers connect when storage becomes readable")
        HostConnection.afterGreeting = { _ in reconnected.fulfill() }
        model.phase(.active)
        XCTAssertTrue(model.storageReady)
        XCTAssertEqual(model.computers.map(\.hostID), [ref.hostID])
        XCTAssertEqual(model.pending, [marker])
        XCTAssertNil(model.feedback)
        XCTAssertNil(model.pairFeedback)
        await fulfillment(of: [reconnected], timeout: 10)
        XCTAssertTrue(model.online(ref.hostID))
    }
    @MainActor func testRealKeychainDecodingDistinguishesMissingDamagedAndInaccessibleItems() throws {
        _ = try fixture()
        XCTAssertNil(try TestKeychain.store.read([String].self, account: "missing"))
        TestKeychain.items["damaged"] = Data("incompatible item".utf8)
        XCTAssertThrowsError(try TestKeychain.store.read([String].self, account: "damaged")) { error in
            XCTAssertEqual((error as? KeychainStore.UndecodableItem)?.account, "damaged")
        }
        TestKeychain.locked = true
        XCTAssertThrowsError(try TestKeychain.store.read([String].self, account: "damaged")) { error in
            XCTAssertEqual(error as? ClientError, KeychainStore.failure)
        }
        TestKeychain.locked = false
    }
    @MainActor func testDamagedNoticeCacheDoesNotBlockHealthyPairings() throws {
        let (_, ref) = try fixture()
        TestKeychain.items["recovery-notices"] = Data("incompatible notice cache".utf8)
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertTrue(model.storageReady)
        XCTAssertEqual(model.computers.map(\.hostID), [ref.hostID])
        XCTAssertNil(model.feedback)
        XCTAssertEqual(try TestKeychain.store.read([String].self, account: "recovery-notices"), [])
        let relaunched = AppModel(keychain: TestKeychain.store)
        XCTAssertTrue(relaunched.storageReady)
        XCTAssertNil(relaunched.feedback)
    }
    @MainActor func testInaccessibleNoticeCacheStillRefusesLoading() throws {
        let (_, ref) = try fixture()
        let before = TestKeychain.items
        TestKeychain.unreadableAccount = "recovery-notices"
        defer { TestKeychain.unreadableAccount = nil }
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertFalse(model.storageReady)
        XCTAssertTrue(model.computers.isEmpty)
        XCTAssertEqual(TestKeychain.items, before)
        XCTAssertNotNil(TestKeychain.items[ComputerStore.account(ref.hostID)])
    }
    @MainActor func testDamagedIndexRecoversComputersAndMarkersWithoutReplacingOriginal() throws {
        let (_, ref) = try fixture()
        let bytes = Data("incompatible index".utf8)
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, draftID: "draft", kind: "reply")
        try TestKeychain.store.write([marker], account: ComputerStore.pendingAccount)
        TestKeychain.items[ComputerStore.indexAccount] = bytes
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertTrue(model.storageReady)
        XCTAssertEqual(model.computers.map(\.hostID), [ref.hostID])
        XCTAssertEqual(model.pending, [marker])
        XCTAssertEqual(TestKeychain.items[ComputerStore.indexAccount], bytes)
        XCTAssertEqual(try TestKeychain.store.read([String].self, account: ComputerStore.recoveredIndexAccount), [ref.hostID])
        XCTAssertEqual(model.feedback, "Recovered the saved computer list.")
        let relaunched = AppModel(keychain: TestKeychain.store)
        XCTAssertEqual(relaunched.computers, model.computers)
        XCTAssertNil(relaunched.feedback)
        XCTAssertNil(relaunched.pairFeedback)
    }
    @MainActor func testRecoveryPreservesADamagedRecoveredIndexToo() throws {
        let (_, ref) = try fixture()
        let bytes = Data("incompatible index".utf8)
        TestKeychain.items[ComputerStore.indexAccount] = bytes
        TestKeychain.items[ComputerStore.recoveredIndexAccount] = bytes
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertTrue(model.storageReady)
        XCTAssertEqual(model.computers.map(\.hostID), [ref.hostID])
        XCTAssertEqual(TestKeychain.items[ComputerStore.indexAccount], bytes)
        XCTAssertEqual(TestKeychain.items[ComputerStore.recoveredIndexAccount], bytes)
    }
    @MainActor func testDamagedIndexNamesUnrecoverableComputerAndKeepsItsItem() throws {
        let (_, ref) = try fixture()
        let damagedID = "00000000-0000-4000-8000-000000000002"
        let bytes = Data("incompatible computer".utf8)
        TestKeychain.items[ComputerStore.indexAccount] = Data("incompatible index".utf8)
        TestKeychain.items[ComputerStore.account(damagedID)] = bytes
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertTrue(model.storageReady)
        XCTAssertEqual(model.computers.map(\.hostID), [ref.hostID])
        XCTAssertTrue(model.feedback?.contains("1 saved computer needs pairing again.") == true)
        XCTAssertEqual(TestKeychain.items[ComputerStore.account(damagedID)], bytes)
        let relaunched = AppModel(keychain: TestKeychain.store)
        XCTAssertNil(relaunched.feedback)
        XCTAssertNil(relaunched.pairFeedback)
    }
    @MainActor func testDamagedMarkersAndLegacyPairingExplainWhatCouldNotBeRead() throws {
        for (account, expected) in [(ComputerStore.pendingAccount, "Saved unconfirmed actions could not be read."),
                                    (ComputerStore.legacyAccount, "1 saved computer needs pairing again.")] {
            let (_, ref) = try fixture()
            let bytes = Data("incompatible item".utf8)
            TestKeychain.items[account] = bytes
            let model = AppModel(keychain: TestKeychain.store)
            XCTAssertTrue(model.storageReady)
            XCTAssertEqual(model.computers.map(\.hostID), [ref.hostID])
            XCTAssertTrue(model.feedback?.contains(expected) == true)
            XCTAssertEqual(model.feedback, model.pairFeedback)
            XCTAssertEqual(TestKeychain.items[account], bytes)
            XCTAssertNil(AppModel(keychain: TestKeychain.store).feedback)
        }
    }
    @MainActor func testUnreadableComputersAreCountedWithoutHostIDs() throws {
        let (_, ref) = try fixture()
        let other = "00000000-0000-4000-8000-000000000002"
        try TestKeychain.store.write([ref.hostID, other], account: ComputerStore.indexAccount)
        for id in [ref.hostID, other] { TestKeychain.items[ComputerStore.account(id)] = Data("damaged".utf8) }
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertEqual(model.feedback, "2 saved computers need pairing again.")
        let relaunched = AppModel(keychain: TestKeychain.store)
        XCTAssertNil(relaunched.feedback)
        XCTAssertNil(relaunched.pairFeedback)
    }

    @MainActor func testDisappearedThreadSettlesAnswerNeutrally() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        XCTAssertEqual(model.pending, [marker])
        let empty = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"\#(ref.hostID)","host":{"hostId":"\#(ref.hostID)","name":"Laptop","threads":[],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}}"#.utf8))
        try XCTUnwrap(HostConnection.instances.last).push(.shell(empty))
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertFalse(model.answering(ref.hostID))
        XCTAssertEqual(model.feedback, "That request is no longer waiting.")
        model.phase(.background)
    }

    @MainActor func testDamagedComputerInReadableIndexExplainsPairingAgain() throws {
        let (_, ref) = try fixture()
        TestKeychain.items[ComputerStore.account(ref.hostID)] = Data("incompatible computer".utf8)
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertTrue(model.storageReady)
        XCTAssertTrue(model.computers.isEmpty)
        XCTAssertTrue(model.feedback?.contains("1 saved computer needs pairing again.") == true)
    }
    @MainActor func testRecoveryRefusesInaccessibleItemsWithoutWritingAnIndex() throws {
        let (_, ref) = try fixture()
        let bytes = Data("incompatible index".utf8)
        TestKeychain.items[ComputerStore.indexAccount] = bytes
        TestKeychain.unreadableAccount = ComputerStore.account(ref.hostID)
        let model = AppModel(keychain: TestKeychain.store)
        XCTAssertFalse(model.storageReady)
        XCTAssertTrue(model.computers.isEmpty)
        XCTAssertEqual(TestKeychain.items[ComputerStore.indexAccount], bytes)
        XCTAssertNil(TestKeychain.items[ComputerStore.recoveredIndexAccount])
        XCTAssertEqual(model.feedback, "Secure connection details could not be read. Unlock this iPhone and return to Sotto.")
        TestKeychain.unreadableAccount = nil
    }
    @MainActor private func changeShell(status: String = "idle", requests: [[String: Any]] = [], error: String? = nil, deliveries: [[String: Any]] = []) throws -> Shell {
        var shell = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(HostConnection.shell)) as? [String: Any])
        var host = try XCTUnwrap(shell["host"] as? [String: Any])
        var threads = try XCTUnwrap(host["threads"] as? [[String: Any]])
        threads[0]["status"] = status; threads[0]["requests"] = requests
        host["threads"] = threads; shell["host"] = host; shell["error"] = error
        shell["deliveries"] = deliveries
        HostConnection.shell = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: shell))
        return try HostConnection.shell.decode(Shell.self)
    }
    @MainActor private func modelWithMarker(_ marker: PendingOperation) throws -> AppModel {
        try TestKeychain.store.write([marker], account: ComputerStore.pendingAccount)
        return AppModel(keychain: TestKeychain.store)
    }
    @MainActor func testOwnCompletedReceiptConfirmsAnAnswerEvenWhileItsRequestStillAppears() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        HostConnection.receipt = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "Answer sent.")
        XCTAssertTrue(model.answerConfirmed("request", in: ref), "A Threads card may say Answered")
    }
    @MainActor func testUnknownReceiptAndDisappearedRequestSettleNeutrallyDespiteUnrelatedShellError() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "old", kind: "answer")
        _ = try changeShell(requests: [["id": "next", "kind": "permission", "text": "Read files?", "options": []]], error: "Another thread failed")
        HostConnection.mayAnswer = true
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "That request is no longer waiting.")
        XCTAssertFalse(model.answerConfirmed("old", in: ref), "A request that left without a receipt is not an answer")
        XCTAssertTrue(model.canAnswer(try XCTUnwrap(model.thread(ref)?.requests.first), in: ref))
    }
    @MainActor func testUncertainOrMissingRequestThreadDoesNotConfirmAnAnswer() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": [], "delivery": "uncertain"]])
        HostConnection.receipt = .object(["status": .string("unknown")])
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        XCTAssertEqual(model.pending, [marker])
        let missing = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: "missing", requestID: "request", kind: "answer")
        let missingModel = try modelWithMarker(missing)
        missingModel.phase(.active); await missingModel.waitForActivation()
        XCTAssertTrue(missingModel.pending.isEmpty)
        XCTAssertEqual(missingModel.feedback, "That request is no longer waiting.")
        XCTAssertNotEqual(missingModel.feedback, "Answer sent.")
        model.phase(.background); missingModel.phase(.background)
    }
    @MainActor func testOwnCompletedReceiptConfirmsAnswerAfterPushBeforeCommandReply() async throws {
        let (model, ref) = try fixture()
        HostConnection.mayAnswer = true
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        model.phase(.active); await model.waitForActivation()
        let request = try XCTUnwrap(model.thread(ref)?.requests.first)
        let connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.receipt = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
        connection.afterReply = { op in
            if op == "command" { connection.push(.shell(try! self.changeShell())) }
        }
        await model.answer(request, in: ref, choice: "allow")
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "Answer sent.")
        XCTAssertEqual(connection.operations.filter { $0 == "command" }.count, 1)
        XCTAssertEqual(connection.operations.filter { $0 == "receipt" }.count, 1)
    }
    @MainActor func testReconnectReceiptCheckSurvivesANewerDisappearancePush() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        HostConnection.receipt = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
        HostConnection.afterGreeting = { connection in
            connection.afterReply = { op in
                if op == "shell" { connection.push(.shell(try! self.changeShell())) }
            }
        }
        let model = try modelWithMarker(marker)
        let settled = expectation(description: "The reconnected answer marker settles")
        let observation = model.$pending.filter { $0.isEmpty }.prefix(1).sink { _ in settled.fulfill() }
        defer { observation.cancel(); model.phase(.background) }
        model.phase(.active); await model.waitForActivation()
        await fulfillment(of: [settled], timeout: 10)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "Answer sent.")
        let connection = try XCTUnwrap(HostConnection.instances.last)
        XCTAssertEqual(connection.operations.filter { $0 == "receipt" }.count, 1)
        XCTAssertEqual(connection.operations.filter { $0 == "command" }.count, 0)
    }
    @MainActor func testReconnectReceiptCheckSurvivesADisappearancePushBeforeHelloReturns() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        HostConnection.receipt = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
        HostConnection.afterGreeting = { connection in connection.push(.shell(try! self.changeShell())) }
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "Answer sent.")
        let connection = try XCTUnwrap(HostConnection.instances.last)
        XCTAssertEqual(connection.operations.filter { $0 == "receipt" }.count, 1)
        XCTAssertEqual(connection.operations.filter { $0 == "command" }.count, 0)
    }
    @MainActor func testOlderHostCompletedReceiptDoesNotConfirmAnAnswer() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        HostConnection.receipt = .object(["status": .string("completed")])
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        XCTAssertEqual(model.pending, [marker])
        XCTAssertNotEqual(model.feedback, "Answer sent.")
        try XCTUnwrap(HostConnection.instances.last).push(.shell(try changeShell()))
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "That request is no longer waiting.")
    }
    @MainActor func testRefusedAnswerReceiptFollowedByDesktopResolutionSettlesNeutrally() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        HostConnection.receipt = .object(["status": .string("completed"), "answerDelivered": .bool(false), "error": .object(["code": .string("unavailable"), "message": .string("Answer refused")])])
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        XCTAssertEqual(model.pending, [marker])
        try XCTUnwrap(HostConnection.instances.last).push(.shell(try changeShell()))
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "That request is no longer waiting.")
    }
    @MainActor func testConnectingAgainWaitsForTheAttemptInFlightAndItsReceiptCheck() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        HostConnection.receipt = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
        let model = try modelWithMarker(marker)
        let joined = expectation(description: "The second connect returns once the first has checked its receipts")
        // Activation's own reconnect is the attempt in flight; this asks again before it finishes.
        HostConnection.afterGreeting = { _ in
            HostConnection.afterGreeting = nil
            Task {
                await model.connect(ref.hostID)
                XCTAssertTrue(model.pending.isEmpty)
                XCTAssertEqual(model.feedback, "Answer sent.")
                joined.fulfill()
            }
        }
        model.phase(.active)
        await fulfillment(of: [joined], timeout: 10)
        XCTAssertEqual(HostConnection.instances.last?.operations.filter { $0 == "receipt" }.count, 1, "The second request starts no connect of its own")
    }
    @MainActor func testCompletedReceiptWithErrorDoesNotConfirmAnAnswer() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        HostConnection.receipt = .object(["status": .string("completed"), "error": .object(["code": .string("unavailable"), "message": .string("Answer refused")])])
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        XCTAssertEqual(model.pending, [marker])
        XCTAssertNotEqual(model.feedback, "Answer sent.")
    }
    @MainActor func testLiveReplySettlementPreservesUnrelatedFeedback() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.loseAcknowledgement = true
        model.drafts[ref.id] = "Continue"
        await model.send(ref)
        let marker = try XCTUnwrap(model.pending.first)
        model.feedback = "Studio Mac could not be reached."
        connection.push(.shell(try changeShell(deliveries: [["threadId": ref.threadID, "draftId": try XCTUnwrap(marker.draftID), "status": "accepted"]])))
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "Studio Mac could not be reached.")
    }
    @MainActor func testLiveAnswerSettlementPreservesUnrelatedFeedback() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        model.feedback = "Removed Studio Mac."
        XCTAssertEqual(model.pending, [marker])
        try XCTUnwrap(HostConnection.instances.last).push(.shell(try changeShell()))
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "Removed Studio Mac.")
        XCTAssertFalse(HostConnection.instances.flatMap(\.operations).contains("command"))
    }
    @MainActor func testStopRemainsAvailableAfterAReplyAcknowledgementIsLost() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.loseAcknowledgement = true
        model.drafts[ref.id] = "Continue"
        await model.send(ref)
        XCTAssertEqual(model.pending(for: ref).map(\.kind), ["reply"])
        connection.push(.shell(try changeShell(status: "running")))
        XCTAssertTrue(model.canInterrupt(ref))
        await model.interrupt(ref)
        XCTAssertEqual(model.pending(for: ref).map(\.kind), ["reply", "interrupt"])
        XCTAssertFalse(model.canInterrupt(ref), "An unconfirmed stop must not create duplicate stops")
    }
    @MainActor func testLiveShellSettlesALostReplyWithoutCheckingAgainOrResending() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.loseAcknowledgement = true
        model.drafts[ref.id] = "Continue"
        await model.send(ref)
        let marker = try XCTUnwrap(model.pending.first)
        let accepted = try changeShell(deliveries: [["threadId": ref.threadID, "draftId": try XCTUnwrap(marker.draftID), "status": "accepted"]])
        connection.onPush?(.shell(accepted), 1)
        XCTAssertEqual(model.pending, [marker], "An older shell cannot confirm delivery")
        connection.push(.shell(accepted))
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertTrue(model.canSend(ref))
        XCTAssertNil(model.feedback, "Only this marker's delivery message is cleared")
        XCTAssertEqual(connection.operations.filter { $0 == "command" }.count, 1)
        // One read asks whether the computer is still carrying the command out; it didn't know it, so nothing more.
        XCTAssertEqual(connection.operations.filter { $0 == "receipt" }.count, 1)
        XCTAssertEqual(try TestKeychain.store.read([PendingOperation].self, account: ComputerStore.pendingAccount), [])
    }
    @MainActor func testLiveShellSettlesAnAnswerAndRestoresAFailedReply() async throws {
        let (_, ref) = try fixture()
        let answer = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, requestID: "request", kind: "answer")
        _ = try changeShell(requests: [["id": "request", "kind": "permission", "text": "Read files?", "options": []]])
        let model = try modelWithMarker(answer)
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        connection.push(.shell(try changeShell()))
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.feedback, "That request is no longer waiting.")
        HostConnection.loseAcknowledgement = true
        model.drafts[ref.id] = "Keep this reply"
        await model.send(ref)
        let reply = try XCTUnwrap(model.pending.first)
        connection.push(.shell(try changeShell(deliveries: [["threadId": ref.threadID, "draftId": try XCTUnwrap(reply.draftID), "status": "failed"]])))
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.failedReplies[ref.id], "Keep this reply")
        model.restoreReply(ref)
        XCTAssertEqual(model.drafts[ref.id], "Keep this reply")
        XCTAssertTrue(model.online(ref.hostID))
    }
    @MainActor func testMarkerStorageFailureDuringPushDoesNotDisconnectComputer() async throws {
        let (_, ref) = try fixture()
        let marker = PendingOperation(hostID: ref.hostID, clientID: "phone", threadID: ref.threadID, draftID: "draft", kind: "reply")
        let model = try modelWithMarker(marker)
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        TestKeychain.locked = true
        connection.push(.shell(try changeShell(deliveries: [["threadId": ref.threadID, "draftId": "draft", "status": "accepted"]])))
        TestKeychain.locked = false
        XCTAssertEqual(model.pending, [marker])
        XCTAssertTrue(model.online(ref.hostID))
        XCTAssertEqual(connection.disconnects, 0)
    }
    @MainActor private func shellWithAnswerAuthority(_ allowed: Bool) throws -> Shell {
        var shell = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(HostConnection.shell)) as? [String: Any])
        shell["clientCapabilities"] = ["mayAnswer": allowed]
        return try JSONDecoder().decode(Shell.self, from: JSONSerialization.data(withJSONObject: shell))
    }
    @MainActor func testLiveShellRefreshesAnswerAuthorityAndIgnoresStaleUpdates() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        XCTAssertFalse(model.mayAnswer(ref.hostID))
        connection.push(.shell(try shellWithAnswerAuthority(true)))
        XCTAssertTrue(model.mayAnswer(ref.hostID))
        connection.onPush?(.shell(try shellWithAnswerAuthority(false)), 1)
        XCTAssertTrue(model.mayAnswer(ref.hostID), "An old shell must not revoke newer authority")
        connection.push(.shell(try shellWithAnswerAuthority(false)))
        XCTAssertFalse(model.mayAnswer(ref.hostID))
        connection.push(.shell(try shellWithAnswerAuthority(true)))
        connection.push(.shell(try HostConnection.shell.decode(Shell.self)))
        XCTAssertTrue(model.mayAnswer(ref.hostID), "Older hosts omit the optional field; keep their hello authority")
    }
    @MainActor func testHelloDoesNotReplaceNewerPushedAnswerAuthority() async throws {
        let (model, ref) = try fixture()
        HostConnection.afterGreeting = { connection in
            connection.push(.shell(try! self.shellWithAnswerAuthority(true)))
        }
        model.phase(.active); await model.waitForActivation()
        XCTAssertTrue(model.mayAnswer(ref.hostID))
    }
    @MainActor func testOlderHostHelloSuppliesAuthorityAfterANewerShellPush() async throws {
        let (model, ref) = try fixture()
        HostConnection.mayAnswer = true
        HostConnection.afterGreeting = { connection in
            connection.push(.shell(try! HostConnection.shell.decode(Shell.self)))
        }
        model.phase(.active); await model.waitForActivation()
        XCTAssertTrue(model.mayAnswer(ref.hostID))
    }
    @MainActor func testAThreadReadFailureDoesNotDisconnectItsOnlineComputer() async throws {
        let (model, ref) = try fixture()
        await model.select(ref)
        HostConnection.failDetail = true
        model.phase(.active)
        await model.reconnectAll()
        XCTAssertTrue(model.online(ref.hostID), "The session and shell succeeded; a failed thread read must not require reconnecting")
        XCTAssertEqual(HostConnection.instances.last?.disconnects, 0)
    }
    @MainActor func testOpeningAThreadUsesTheObservedDetailOnce() async throws {
        let (model, ref) = try fixture()
        model.phase(.active)
        await model.reconnectAll()
        await model.select(ref)
        XCTAssertEqual(model.detail(for: ref)?.messages.first?.text, "Ready")
        XCTAssertEqual(HostConnection.instances.last?.operations.filter { $0 == "detail" }.count, 0,
                       "observe already sent the initial detail; do not download it again")
        XCTAssertEqual(HostConnection.instances.last?.operations.filter { $0 == "shell" }.count, 0,
                       "No pending delivery needs another copy of the shell")
    }
    @MainActor func testSeveralMissingDeltaBasesShareOneReadAndCannotRestoreAClosedThread() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation(); await model.select(ref)
        let connection = try XCTUnwrap(HostConnection.instances.last)
        let started = expectation(description: "Full detail read after a revision gap")
        connection.detailStarted = { started.fulfill() }; HostConnection.holdDetail = true
        let delta = try JSONDecoder().decode(ThreadDetailDelta.self, from: Data(#"{"threadId":"t","baseRevision":8,"revision":9,"messageDeltas":[],"activityDeltas":[]}"#.utf8))
        connection.push(.delta(threadID: "t", value: delta))
        connection.push(.delta(threadID: "t", value: delta))
        await fulfillment(of: [started], timeout: 10)
        XCTAssertEqual(connection.operations.filter { $0 == "detail" }.count, 1)
        await model.select(nil)
        connection.heldDetail?.resume(returning: HostConnection.detail); connection.heldDetail = nil
        XCTAssertNil(model.selected)
        XCTAssertNil(model.detail(for: ref))
        XCTAssertTrue(model.online(ref.hostID))
    }
    @MainActor func testFinalDeltaDuringRepairTriggersAnotherRead() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation(); await model.select(ref)
        let connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.holdDetail = true
        let first = expectation(description: "First repair")
        let second = expectation(description: "Repair includes final missed delta")
        connection.detailStarted = { first.fulfill() }
        func delta(_ base: Int, _ revision: Int) throws -> ThreadDetailDelta {
            try JSONDecoder().decode(ThreadDetailDelta.self, from: Data(#"{"threadId":"t","baseRevision":\#(base),"revision":\#(revision),"messageDeltas":[],"activityDeltas":[]}"#.utf8))
        }
        connection.push(.delta(threadID: "t", value: try delta(8, 9)))
        await fulfillment(of: [first], timeout: 10)
        connection.push(.delta(threadID: "t", value: try delta(9, 10)))
        connection.detailStarted = { second.fulfill() }
        let older = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"threadId":"t","revision":9,"messages":[]}"#.utf8))
        connection.heldDetail?.resume(returning: older); connection.heldDetail = nil
        await fulfillment(of: [second], timeout: 10)
        XCTAssertEqual(connection.operations.filter { $0 == "detail" }.count, 2)
        let final = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"threadId":"t","revision":10,"messages":[]}"#.utf8))
        connection.heldDetail?.resume(returning: final); connection.heldDetail = nil
        // No later push can rescue the display: the repair itself must reach the final revision.
        let deadline = Date().addingTimeInterval(10)
        while model.detail(for: ref)?.revision != 10 && Date() < deadline { await Task.yield() }
        XCTAssertEqual(model.detail(for: ref)?.revision, 10)
    }
    @MainActor func testAShellThatChangesNothingRedrawsNothing() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        var published = 0
        let watching = model.objectWillChange.sink { published += 1 }
        defer { watching.cancel() }
        // A working thread's computer sends its list many times a second, most of them the same as the last.
        connection.push(.shell(try HostConnection.shell.decode(Shell.self)))
        connection.push(.shell(try HostConnection.shell.decode(Shell.self)))
        XCTAssertEqual(published, 0, "Every view watches the model, so an unchanged shell must not publish on it")
        connection.push(.shell(try newerShell()))
        XCTAssertGreaterThan(published, 0)
        XCTAssertEqual(model.thread(ref)?.title, "New title")
    }
    @MainActor func testANewRevisionOfTheOpenThreadPublishesOnlyOnItsStore() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation(); await model.select(ref)
        let connection = try XCTUnwrap(HostConnection.instances.last)
        var onModel = 0, onStore = 0
        let watchingModel = model.objectWillChange.sink { onModel += 1 }
        let watchingStore = model.detailStore.objectWillChange.sink { onStore += 1 }
        defer { watchingModel.cancel(); watchingStore.cancel() }
        let delta = try JSONDecoder().decode(ThreadDetailDelta.self, from: Data(#"{"threadId":"t","baseRevision":1,"revision":2,"messageDeltas":[{"id":"m","appendText":" now"}],"activityDeltas":[]}"#.utf8))
        connection.push(.delta(threadID: "t", value: delta))
        XCTAssertEqual(model.detail(for: ref)?.messages.first?.text, "Ready now")
        XCTAssertGreaterThan(onStore, 0)
        XCTAssertEqual(onModel, 0, "A reply arriving a few words at a time redraws the conversation, not every view")
    }
    @MainActor private func newerShell() throws -> Shell {
        let json = String(decoding: try JSONEncoder().encode(HostConnection.shell), as: UTF8.self)
            .replacingOccurrences(of: "\"Thread\"", with: "\"New title\"")
        HostConnection.shell = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return try HostConnection.shell.decode(Shell.self)
    }
    @MainActor func testHelloCannotReplaceAShellReceivedAfterIt() async throws {
        let (model, ref) = try fixture()
        HostConnection.afterGreeting = { connection in connection.push(.shell(try! self.newerShell())) }
        model.phase(.active); await model.waitForActivation()
        XCTAssertEqual(model.thread(ref)?.title, "New title")
    }
    @MainActor func testCommandReplyCannotReplaceANewerShellPush() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        connection.afterReply = { op in if op == "command" { connection.push(.shell(try! self.newerShell())) } }
        model.drafts[ref.id] = "Continue"
        await model.send(ref)
        XCTAssertEqual(model.thread(ref)?.title, "New title")
    }
    @MainActor func testDisconnectDuringHelloCannotMarkComputerOnlineAgain() async throws {
        let (model, ref) = try fixture()
        HostConnection.afterGreeting = { connection in connection.onDisconnect?() }
        model.phase(.active); await model.waitForActivation()
        XCTAssertEqual(model.status(ref.hostID), .unreachable)
    }
    @MainActor func testLiveShellTracksForegroundBackgroundAndCompletedWork() async throws {
        let (model, ref) = try fixture()
        model.phase(.active); await model.waitForActivation()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        let original = String(decoding: try JSONEncoder().encode(HostConnection.shell), as: UTF8.self)
        func push(status: String, extra: String = "") async throws {
            let shell = original.replacingOccurrences(of: #""status":"idle""#, with: #""status":"\#(status)"\#(extra)"#)
            let frame = try await Wire.readFrame(Data(#"{"v":1,"event":"shell","state":\#(shell)}"#.utf8))
            connection.push(frame)
        }
        try await push(status: "running")
        XCTAssertEqual(ThreadState(try XCTUnwrap(model.thread(ref))), .working)
        XCTAssertEqual(ThreadGroups.working(model.lists).map(\.id), [ref.id])
        try await push(status: "idle", extra: #", "backgroundWork":[{"type":"subagent","id":"00000000-0000-4000-8000-000000000002","label":"Checking"}]"#)
        XCTAssertEqual(ThreadState(try XCTUnwrap(model.thread(ref))), .working)
        XCTAssertEqual(ThreadGroups.working(model.lists).map(\.id), [ref.id])
        XCTAssertTrue(ThreadGroups.merged(model.lists, filter: .done).isEmpty)
        try await push(status: "idle", extra: #", "backgroundWork":[]"#)
        XCTAssertEqual(ThreadState(try XCTUnwrap(model.thread(ref))), .done)
        XCTAssertTrue(ThreadGroups.working(model.lists).isEmpty)
        XCTAssertEqual(connection.disconnects, 0)
    }

}

private actor RetryClock {
    private(set) var delays: [UInt64] = []
    private var pending: CheckedContinuation<Void, Error>?
    func record(_ delay: UInt64) -> Int { delays.append(delay); return delays.count }
    func wait(_ delay: UInt64) async throws {
        delays.append(delay)
        try await withCheckedThrowingContinuation { pending = $0 }
    }
    func release() { pending?.resume(); pending = nil }
}
