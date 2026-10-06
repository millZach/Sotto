import XCTest
import SottoCore

/// Photos from the reply box, and replies that read as sending until their computer answers.
final class PhotoReplyTests: XCTestCase {
    private let host = "00000000-0000-4000-8000-000000000001"
    private func json(_ value: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(value.utf8)) }
    private func refusal(_ code: String, _ message: String) throws -> HostRefusal {
        HostRefusal(failure: try JSONDecoder().decode(WireFailure.self, from: Data(#"{"code":"\#(code)","message":"\#(message)"}"#.utf8)))
    }
    /// Holds what a test's injected closures need to reach once the model exists.
    @MainActor private final class Box { var model: AppModel?; var sleeps = 0; var sendingWhileWaiting: Bool?; var staged = 0 }
    /// Holds a staging request until the test lets it go.
    @MainActor private final class Gate {
        private var held: CheckedContinuation<Void, Never>?
        private var arrival: CheckedContinuation<Void, Never>?
        private(set) var reached = false
        func hold() async {
            reached = true; arrival?.resume(); arrival = nil
            await withCheckedContinuation { held = $0 }
        }
        func arrived() async { if !reached { await withCheckedContinuation { arrival = $0 } } }
        func release() { held?.resume(); held = nil }
    }

    @MainActor private func fixture(supportsImages: Bool = true, features: [String] = ["host-folders", "attachment-staging"],
                                    receiptSleep: (@Sendable (UInt64) async throws -> Void)? = nil) async throws -> (AppModel, ThreadRef) {
        TestKeychain.items = [:]; TestKeychain.locked = false; TestKeychain.unreadableAccount = nil; TestKeychain.unwritableAccount = nil
        HostConnection.instances = []; HostConnection.afterGreeting = nil; HostConnection.failDetail = false; HostConnection.holdDetail = false
        HostConnection.mayAnswer = false; HostConnection.receipt = .object(["status": .string("unknown")]); HostConnection.receipts = [:]
        HostConnection.loseAcknowledgement = false; HostConnection.features = features
        HostConnection.shells = [:]; HostConnection.commandHandler = nil; HostConnection.folderHandler = nil
        HostConnection.stageHandler = nil; HostConnection.previewHandler = nil
        HostConnection.photoLoadLimit = { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
        let pairing = try json(#"{"v":1,"hostId":"\#(host)","clientId":"phone","token":"fixture"}"#).decode(Pairing.self)
        try TestKeychain.store.write([host], account: ComputerStore.indexAccount)
        try TestKeychain.store.write(SavedComputer(address: "https://laptop.example.ts.net:8443", pairing: pairing, reportedName: "Laptop"), account: ComputerStore.account(host))
        HostConnection.shell = try json(#"{"hostId":"\#(host)","host":{"hostId":"\#(host)","name":"Laptop","threads":[{"id":"t","projectId":"p","title":"Thread","status":"idle","requests":[],"modelId":"m"}],"projects":[],"models":[{"id":"m","name":"Model","provider":"Claude","ready":true,"supportsImages":\#(supportsImages)}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}}"#)
        HostConnection.detail = try json(#"{"threadId":"t","revision":1,"messages":[]}"#)
        var staged = 0
        HostConnection.stageHandler = { image in
            staged += 1
            return try self.json(#"{"id":"staged-\#(staged)","name":\#(String(decoding: try JSONEncoder().encode(image["name"]), as: UTF8.self)),"mimeType":"image/jpeg","sizeBytes":4,"digest":"\#(String(repeating: "d", count: 64))"}"#)
        }
        // A reply the computer takes comes back accepted, as the desktop answers once the provider has it.
        HostConnection.commandHandler = { _, command, id in
            guard case .object(var root) = HostConnection.shell else { throw ClientError.invalidProtocol }
            if command["type"] == .string("manual-send") {
                root["deliveries"] = .array([.object(["threadId": command["threadId"], "draftId": command["draftId"], "status": .string("accepted")])])
            }
            HostConnection.shell = .object(root)
            HostConnection.receipts[id] = .object(["status": .string("completed")])
            return HostConnection.shell
        }
        let model = AppModel(keychain: TestKeychain.store,
                             preparePhoto: { _, name in PreparedPhoto(name: name + ".jpg", mimeType: "image/jpeg", base64: "/9j/AA==", byteCount: 4, dimensions: nil, thumbnail: nil) },
                             receiptSleep: receiptSleep ?? { _ in },
                             photoLoadLimit: { try await HostConnection.photoLoadLimit() })
        model.phase(.active); await model.waitForActivation()
        return (model, ThreadRef(hostID: host, threadID: "t"))
    }
    private func source(_ name: String = "Photo 1") -> PhotoSource { PhotoSource(name: name) { Data([1, 2, 3]) } }
    @MainActor private func sent(_ connection: HostConnection) -> [JSONValue] {
        connection.commands.filter { $0["type"] == .string("manual-send") }
    }

    @MainActor func testAPhotoReplyIsSentOnceByHandleEvenWhenPressedTwice() async throws {
        let (model, ref) = try await fixture()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        model.attachPhotos(ref, from: [source()])
        await model.waitForPhotos()
        XCTAssertEqual(model.photos(ref).first?.staged?.id, "staged-1")
        XCTAssertTrue(model.canSendReply(ref), "Photos alone are a reply")
        async let first: Void = model.send(ref)
        async let second: Void = model.send(ref)
        _ = await (first, second)
        let replies = sent(connection)
        XCTAssertEqual(replies.count, 1)
        guard case .array(let images) = replies[0]["attachments"] else { return XCTFail("The reply carried no photos") }
        XCTAssertEqual(images.map { $0["id"] }, [.string("staged-1")])
        XCTAssertEqual(replies[0]["text"], .string(""))
        XCTAssertEqual(connection.operations.filter { $0 == "stage-attachment" }.count, 1, "A fresh handle is not staged again")
        XCTAssertTrue(model.photos(ref).isEmpty)
        XCTAssertTrue(model.pending.isEmpty)
    }
    @MainActor func testASecondPressWhileAPhotoIsStagedAgainSendsNothing() async throws {
        let (model, ref) = try await fixture()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        let working = try XCTUnwrap(HostConnection.stageHandler)
        HostConnection.stageHandler = { _ in throw ClientError.readTimedOut }
        model.attachPhotos(ref, from: [source()])
        await model.waitForPhotos()
        let gate = Gate()
        HostConnection.stageHandler = { image in await gate.hold(); return try await working(image) }
        let first = Task { await model.send(ref) }
        await gate.arrived()
        XCTAssertTrue(model.preparingSends.contains(ref.id))
        XCTAssertFalse(model.canSendReply(ref))
        await model.send(ref)
        XCTAssertTrue(sent(connection).isEmpty, "The second press found the reply already on its way")
        gate.release()
        await first.value
        XCTAssertEqual(sent(connection).count, 1)
        XCTAssertEqual(connection.operations.filter { $0 == "stage-attachment" }.count, 2)
    }
    @MainActor func testAOneMillionContextThreadTakesPhotosLikeItsBaseModel() async throws {
        let (model, ref) = try await fixture()
        guard case .object(var root) = HostConnection.shell, case .object(var host) = root["host"],
              case .array(var threads) = host["threads"], case .object(var thread) = threads[0] else { return XCTFail("Unexpected fixture") }
        thread["modelId"] = .string("m[1m]"); threads[0] = .object(thread); host["threads"] = .array(threads); root["host"] = .object(host)
        try XCTUnwrap(HostConnection.instances.last).push(.shell(try JSONValue.object(root).decode(Shell.self)))
        XCTAssertEqual(model.photoSupport(ref), .available)
    }
    @MainActor func testAPhotoRefusedWhileTheReplyWaitsSendsNothing() async throws {
        let (model, ref) = try await fixture()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        let working = try XCTUnwrap(HostConnection.stageHandler)
        HostConnection.stageHandler = { _ in throw ClientError.readTimedOut }
        model.attachPhotos(ref, from: [source("Photo 1")])
        await model.waitForPhotos()
        // Photo 2's own staging is held, then refused; photo 1, staged again at Send, waits behind it.
        let gate = Gate()
        let refused = try refusal("invalid_request", "Each screenshot must be 10 MB or smaller.")
        var calls = 0
        HostConnection.stageHandler = { image in
            calls += 1
            if calls == 1 { await gate.hold(); throw refused }
            return try await working(image)
        }
        model.attachPhotos(ref, from: [source("Photo 2")])
        await gate.arrived()
        let sending = Task { await model.send(ref) }
        for _ in 0..<1_000 where !model.preparingSends.contains(ref.id) { await Task.yield() }
        XCTAssertTrue(model.preparingSends.contains(ref.id))
        gate.release()
        await sending.value
        XCTAssertTrue(sent(connection).isEmpty, "A reply missing a photo the user pressed Send with is not sent")
        XCTAssertEqual(model.photos(ref).count, 1)
        XCTAssertEqual(model.photoNotices[ref.id], "Each screenshot must be 10 MB or smaller.")
    }
    @MainActor func testAStalledStagingNeverHoldsUpPreparingTheNextPhoto() async throws {
        let (model, ref) = try await fixture()
        let gate = Gate()
        let working = try XCTUnwrap(HostConnection.stageHandler)
        HostConnection.stageHandler = { image in await gate.hold(); return try await working(image) }
        model.attachPhotos(ref, from: [source("Photo 1")])
        await gate.arrived()
        model.attachPhotos(ref, from: [source("Photo 2")])
        for _ in 0..<1_000 where model.photos(ref).contains(where: \.preparing) { await Task.yield() }
        XCTAssertFalse(model.photos(ref).contains(where: \.preparing), "Photo 2 was prepared while photo 1's staging was held")
        HostConnection.stageHandler = working
        gate.release()
        await model.waitForPhotos()
        XCTAssertEqual(model.photos(ref).compactMap(\.staged).count, 2)
    }
    @MainActor func testAPhotoThatNeverReachedTheComputerIsStagedWhenTheReplyIsSent() async throws {
        let (model, ref) = try await fixture()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        let working = HostConnection.stageHandler
        HostConnection.stageHandler = { _ in throw ClientError.readTimedOut }
        model.attachPhotos(ref, from: [source()])
        await model.waitForPhotos()
        XCTAssertEqual(model.photos(ref).count, 1, "A photo that couldn't reach the computer stays in the box")
        XCTAssertNil(model.photos(ref).first?.staged)
        XCTAssertNil(model.photoNotices[ref.id])
        HostConnection.stageHandler = working
        model.drafts[ref.id] = "Here it is"
        await model.send(ref)
        XCTAssertEqual(sent(connection).count, 1)
        XCTAssertEqual(sent(connection).first?["text"], .string("Here it is"))
        XCTAssertEqual(connection.operations.filter { $0 == "stage-attachment" }.count, 2)
    }
    @MainActor func testAPhotoTheComputerRefusesLeavesTheBoxWithItsReason() async throws {
        let (model, ref) = try await fixture()
        let refused = try refusal("invalid_request", "Only PNG, JPEG, GIF, and WebP screenshots can be attached.")
        HostConnection.stageHandler = { _ in throw refused }
        model.attachPhotos(ref, from: [source()])
        await model.waitForPhotos()
        XCTAssertTrue(model.photos(ref).isEmpty)
        XCTAssertEqual(model.photoNotices[ref.id], "Only PNG, JPEG, GIF, and WebP screenshots can be attached.")
        XCTAssertFalse(model.canSendReply(ref))
    }
    @MainActor func testAPhotoThatCantBeReadIsNotAddedAndSaysSo() async throws {
        let (model, ref) = try await fixture()
        model.attachPhotos(ref, from: [PhotoSource(name: "Photo 1") { throw CocoaError(.fileReadCorruptFile) }])
        await model.waitForPhotos()
        XCTAssertTrue(model.photos(ref).isEmpty)
        XCTAssertEqual(model.photoNotices[ref.id], PhotoPipelineError.unreadable.errorDescription)
    }
    @MainActor func testAPhotoThatNeverArrivesIsLeftOutAndTheNextOneStillGoes() async throws {
        let (model, ref) = try await fixture()
        let gate = Gate()
        // The time limit passes as soon as the stuck photo is waiting on it.
        HostConnection.photoLoadLimit = { await gate.hold() }
        model.attachPhotos(ref, from: [PhotoSource(name: "Photo 1") { try await Task.sleep(nanoseconds: 3_600_000_000_000); return Data() }, source("Photo 2")])
        await gate.arrived()
        // The next photo's limit never passes, so it goes on its own arrival.
        HostConnection.photoLoadLimit = { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
        gate.release()
        await model.waitForPhotos()
        XCTAssertEqual(model.photos(ref).count, 1, "The photo that never arrived was left out")
        XCTAssertEqual(model.photos(ref).first?.staged?.id, "staged-1")
        XCTAssertEqual(model.photoNotices[ref.id], PhotoPipelineError.tooSlow.errorDescription)
    }
    @MainActor func testRemovingAPhotoStillLoadingLetsTheNextOneGo() async throws {
        let (model, ref) = try await fixture()
        let loading = Gate()
        model.attachPhotos(ref, from: [PhotoSource(name: "Photo 1") { await loading.hold(); return Data([1]) }, source("Photo 2")])
        await loading.arrived()
        let stuck = try XCTUnwrap(model.photos(ref).first?.id)
        model.removePhoto(stuck, from: ref)
        await model.waitForPhotos()
        XCTAssertEqual(model.photos(ref).count, 1)
        XCTAssertNotEqual(model.photos(ref).first?.id, stuck)
        XCTAssertNotNil(model.photos(ref).first?.staged)
        XCTAssertNil(model.photoNotices[ref.id], "A photo the user removed needs no reason")
        loading.release()
    }
    @MainActor func testAReplyCarriesAtMostEightPhotos() async throws {
        let (model, ref) = try await fixture()
        model.attachPhotos(ref, from: (1...10).map { source("Photo \($0)") })
        XCTAssertEqual(model.photos(ref).count, PhotoLimits.count)
        XCTAssertEqual(model.photoNotices[ref.id], "A reply can carry 8 photos. The others weren’t added.")
        await model.waitForPhotos()
        model.attachPhotos(ref, from: [source()])
        XCTAssertEqual(model.photos(ref).count, PhotoLimits.count)
    }
    @MainActor func testPhotosNeverGoToAModelThatCantTakeThem() async throws {
        let (model, ref) = try await fixture(supportsImages: false)
        XCTAssertEqual(model.photoSupport(ref), .modelCannot)
        model.attachPhotos(ref, from: [source()])
        XCTAssertTrue(model.photos(ref).isEmpty)
        let (older, olderRef) = try await fixture(features: ["host-folders"])
        XCTAssertEqual(older.photoSupport(olderRef), .needsUpdate)
    }
    @MainActor func testARefusedPhotoReplyComesBackWithItsPhotos() async throws {
        let (model, ref) = try await fixture()
        let refused = try refusal("invalid_request", "That reply was refused.")
        HostConnection.commandHandler = { _, _, _ in throw refused }
        model.attachPhotos(ref, from: [source(), source("Photo 2")])
        await model.waitForPhotos()
        await model.send(ref)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.failedReplies[ref.id], "")
        XCTAssertEqual(model.failedPhotos[ref.id]?.count, 2)
        XCTAssertTrue(model.photos(ref).isEmpty)
        model.restoreReply(ref)
        XCTAssertEqual(model.photos(ref).count, 2)
        XCTAssertNil(model.failedPhotos[ref.id])
    }

    @MainActor func testAReplyReadsAsSendingUntilItsComputerAnswers() async throws {
        let (model, ref) = try await fixture()
        let box = Box(); box.model = model
        let answering = HostConnection.commandHandler
        HostConnection.commandHandler = { host, command, id in
            box.sendingWhileWaiting = box.model?.pending.first.map { box.model!.isSending($0) }
            return try await answering!(host, command, id)
        }
        model.drafts[ref.id] = "Continue"
        await model.send(ref)
        XCTAssertEqual(box.sendingWhileWaiting, true, "A reply on its way is not an unconfirmed one")
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertNil(model.feedback)
    }
    @MainActor func testASlowProviderStaysSendingWhileTheComputerSaysItIsWorking() async throws {
        let box = Box()
        let (model, ref) = try await fixture(receiptSleep: { _ in
            await MainActor.run {
                box.sleeps += 1
                box.sendingWhileWaiting = box.model?.pending.first.map { box.model!.isSending($0) }
                // The provider takes the reply while the iPhone waits: the computer finishes the command.
                guard let marker = box.model?.pending.first, case .object(var root) = HostConnection.shell else { return }
                root["deliveries"] = .array([.object(["threadId": .string(marker.threadID), "draftId": .string(marker.draftID!), "status": .string("accepted")])])
                HostConnection.shell = .object(root)
                HostConnection.receipt = .object(["status": .string("completed")])
            }
        })
        box.model = model
        let connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.loseAcknowledgement = true
        HostConnection.receipt = .object(["status": .string("pending")])
        model.drafts[ref.id] = "Continue"
        await model.send(ref)
        XCTAssertEqual(box.sleeps, 1)
        XCTAssertEqual(box.sendingWhileWaiting, true)
        XCTAssertTrue(model.pending.isEmpty, "Its receipt settled it once the computer finished")
        XCTAssertNil(model.feedback)
        XCTAssertEqual(connection.operations.filter { $0 == "command" }.count, 1, "Nothing is sent again")
    }
    @MainActor func testALostReplyTheComputerNeverHeardOfIsUnconfirmed() async throws {
        let (model, ref) = try await fixture()
        HostConnection.loseAcknowledgement = true
        model.drafts[ref.id] = "Continue"
        await model.send(ref)
        let marker = try XCTUnwrap(model.pending.first)
        XCTAssertFalse(model.isSending(marker))
        XCTAssertEqual(model.feedback, "Delivery is unconfirmed. Reconnect and check the thread before sending again.")
    }
    @MainActor func testANewConnectionTakesOverFollowingAReceiptFromAnOldDispatch() async throws {
        let box = Box()
        let gate = Gate()
        let (model, ref) = try await fixture(receiptSleep: { _ in
            let first = await MainActor.run { () -> Bool in box.sleeps += 1; return box.sleeps == 1 }
            if first { await gate.hold(); return }
            // The new connection's follower: the computer finishes the command while it waits.
            await MainActor.run {
                guard let marker = box.model?.pending.first, case .object(var root) = HostConnection.shell else { return }
                root["deliveries"] = .array([.object(["threadId": .string(marker.threadID), "draftId": .string(marker.draftID!), "status": .string("accepted")])])
                HostConnection.shell = .object(root)
                HostConnection.receipt = .object(["status": .string("completed")])
            }
        })
        box.model = model
        HostConnection.loseAcknowledgement = true
        HostConnection.receipt = .object(["status": .string("pending")])
        model.drafts[ref.id] = "Continue"
        let sending = Task { await model.send(ref) }
        await gate.arrived()
        let marker = try XCTUnwrap(model.pending.first)
        // The phone reconnects while the old dispatch's follower sleeps; the computer still says it is working.
        await model.connect(ref.hostID)
        XCTAssertTrue(model.isSending(marker), "The new connection's follower took over")
        gate.release()
        await sending.value
        for _ in 0..<1_000 where !model.pending.isEmpty { await Task.yield() }
        XCTAssertTrue(model.pending.isEmpty, "The new connection's follower settled it")
        XCTAssertGreaterThanOrEqual(box.sleeps, 2)
        XCTAssertEqual(HostConnection.instances.flatMap(\.commands).filter { $0["type"] == .string("manual-send") }.count, 1, "Nothing is sent again")
        XCTAssertNil(model.feedback)
    }
    @MainActor func testAReconnectFindingTheCommandStillRunningShowsItAsSending() async throws {
        let box = Box()
        let (model, ref) = try await fixture(receiptSleep: { _ in
            await MainActor.run {
                box.sleeps += 1
                box.sendingWhileWaiting = box.model?.pending.first.map { box.model!.isSending($0) }
                HostConnection.receipt = .object(["status": .string("completed")])
            }
        })
        box.model = model
        HostConnection.loseAcknowledgement = true
        model.drafts[ref.id] = "Continue"
        await model.send(ref)
        let marker = try XCTUnwrap(model.pending.first)
        XCTAssertFalse(model.isSending(marker))
        // The computer, reached again, says it is still carrying the reply out.
        HostConnection.receipt = .object(["status": .string("pending")])
        await model.checkDelivery(ref.hostID)
        XCTAssertTrue(model.isSending(marker))
        XCTAssertEqual(model.pending, [marker])
        // Once the computer has finished without the reply reaching the provider, it is unconfirmed again.
        for _ in 0..<1_000 where model.isSending(marker) { await Task.yield() }
        XCTAssertEqual(box.sleeps, 1)
        XCTAssertEqual(box.sendingWhileWaiting, true)
        XCTAssertFalse(model.isSending(marker))
        XCTAssertEqual(model.pending, [marker], "Nothing settles a reply the provider never took, and nothing is resent")
        XCTAssertEqual(HostConnection.instances.last?.operations.filter { $0 == "command" }.count, 1)
    }
}
