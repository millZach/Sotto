import XCTest
@testable import SottoCore

final class WatcherTests: XCTestCase {
    func testManagementFieldsAndOperationsStayOptionalForOlderHosts() throws {
        let old = try decode(WatcherPhoneState.self, state)
        XCTAssertNil(old.runtimeMode)
        XCTAssertNil(old.standingWatches)
        XCTAssertNil(old.ownChanges)
        let extra = #", "runtimeMode":"full-access", "standingWatches":[{"id":"watch","target":{"hostId":"host","threadId":"worker"},"createdAt":"now","generation":2,"pausedByUserMessageId":"human"}], "ownChanges":[{"replyMessageId":"reply","turnId":"turn","files":["src/main.ts"],"fileCount":1,"reason":null,"source":"provider-file-change"}]"#
        let expanded = String(state.dropLast()) + extra + "}"
        let page = try decode(WatcherPhoneState.self, expanded)
        XCTAssertEqual(page.runtimeMode, "full-access")
        XCTAssertEqual(page.standingWatches?.first?.pausedByUserMessageId, "human")
        XCTAssertEqual(page.ownChanges?.first?.files, ["src/main.ts"])
        XCTAssertNil(page.ownChanges?.first?.reason)
        XCTAssertEqual(try WatcherWire.setPermission(runtimeMode: "auto")["op"], .string("watcher-phone-set-permission"))
        XCTAssertThrowsError(try WatcherWire.setPermission(runtimeMode: "always"))
        let target = WatcherTarget(hostId: "remote", threadId: "worker")
        XCTAssertEqual(JSONValue.object(WatcherWire.watch(target: target))["request"]["target"]["hostId"], .string("remote"))
        XCTAssertEqual(WatcherWire.unwatch(target: target)["op"], .string("watcher-phone-unwatch"))
        guard case .array(let accepts)? = WatcherWire.managementHello["accepts"] else { return XCTFail("Missing accepts") }
        XCTAssertTrue(accepts.contains(.string(WatcherWire.manageFeature)))
        guard case .ok? = try decode(Receipt.self, #"{"status":"completed","watcherManage":{"status":"ok"}}"#).watcherManage else { return XCTFail("Missing management outcome") }
    }
    func testReceiptOutcomeStaysOptionalForOlderComputers() throws {
        let old = try decode(WatcherPhoneState.self, state)
        XCTAssertNil(old.receiptGroups.first?.rows.first?.outcome)
        let reported = state.replacingOccurrences(of: #""deliveryState":"accepted","#, with: #""deliveryState":"accepted","outcome":"answered","#)
        XCTAssertNotEqual(reported, state)
        XCTAssertEqual(try decode(WatcherPhoneState.self, reported).receiptGroups.first?.rows.first?.outcome, "answered")
    }
    private let host = "00000000-0000-4000-8000-000000000001"
    private let state = #"{"hostId":"00000000-0000-4000-8000-000000000001","current":{"target":{"hostId":"00000000-0000-4000-8000-000000000001","threadId":"watcher"},"provider":"codex","modelId":"model","reasoningEffort":null,"status":"running","connected":true},"conversation":{"messages":[{"id":"reply","role":"assistant","text":"Started a worker.","createdAt":"2026-10-11T10:00:00Z"}],"revision":4,"earlierAvailable":false},"receiptGroups":[{"requestId":"request","replyMessageId":"reply","rows":[{"operationId":"operation","target":{"hostId":"00000000-0000-4000-8000-000000000002","threadId":"worker"},"title":"Worker","provider":"claude","action":"start","deliveryState":"accepted","createdAt":"2026-10-11T10:00:00Z","updatedAt":"2026-10-11T10:00:01Z"}]}],"watchedThreads":[{"target":{"hostId":"00000000-0000-4000-8000-000000000002","threadId":"worker"},"title":"Worker","provider":"claude","status":"idle","connected":true,"watched":true,"takenOver":false,"backgroundWorkCount":0}],"needsYou":[{"target":{"hostId":"00000000-0000-4000-8000-000000000002","threadId":"worker"},"title":"Worker","provider":"claude","request":{"id":"permission","kind":"permission","text":"Run tests?","options":[],"permissionChoices":[{"id":"once","label":"Allow once","kind":"allow-once"}]},"connected":true,"mayAnswer":false}],"inFlight":1,"inFlightLimit":4,"working":true,"recoveryNotice":null,"observedAt":"2026-10-11T10:00:00Z","draftDeliveries":[{"draftId":"draft","status":"accepted"}],"futureDisplayField":true}"#
    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T { try JSONDecoder().decode(type, from: Data(text.utf8)) }

    func testPageKeepsReplyGroupsProvidersAndOwningCards() throws {
        let page = try decode(WatcherPhoneState.self, state)
        try page.validate(hostID: host)
        XCTAssertThrowsError(try page.validate(hostID: "other"))
        XCTAssertEqual(page.receiptGroups.first?.replyMessageId, "reply")
        XCTAssertEqual(page.watchedThreads.first?.provider, "claude")
        XCTAssertEqual(page.needsYou.first?.target.hostId, "00000000-0000-4000-8000-000000000002")
        XCTAssertEqual(page.needsYou.first?.mayAnswer, false)
        XCTAssertEqual(page.needsYou.first?.request.permissionChoices?.first?.id, "once")
        XCTAssertEqual(page.draftDeliveries?.first?.status, "accepted")
    }
    func testOldHelloStaysUnchangedUntilUIOptsIn() {
        guard case .array(let old)? = Wire.snapshotHello["accepts"], case .array(let new)? = WatcherWire.hello["accepts"] else { return XCTFail("Missing accepts") }
        XCTAssertFalse(old.contains(.string(WatcherWire.feature)))
        XCTAssertTrue(new.contains(.string(WatcherWire.feature)))
        XCTAssertTrue(new.contains(.string(WatcherWire.stopFeature)))
    }
    func testSendCarriesExplicitPhoneOriginAndStableDraft() throws {
        let target = WatcherTarget(hostId: host, threadId: "watcher")
        let operation = WatcherWire.send(target: target, clientID: "phone", draftID: "draft", text: "Start a worker")
        let packet = try Wire.decode(Wire.request(id: "send", session: "signed", operation: operation))
        XCTAssertEqual(packet["v"], .number(1))
        XCTAssertEqual(packet["request"]["origin"]["kind"], .string("phone"))
        XCTAssertEqual(packet["request"]["origin"]["clientId"], .string("phone"))
        XCTAssertEqual(packet["request"]["draftId"], .string("draft"))
        XCTAssertEqual(packet["request"]["approved"], .null)
    }
    func testWorkerAnswerPreservesItsNativeChoiceAndNeverUsesWatcherAsOwner() throws {
        let page = try decode(WatcherPhoneState.self, state), card = try XCTUnwrap(page.needsYou.first)
        let answer = try Commands.answer(threadID: card.target.threadId, request: card.request, currentRequests: [card.request], choice: "once")
        guard case .object(let fields) = answer else { return XCTFail("An answer command is a JSON object") }
        let operation = try WatcherWire.answer(target: card.target, command: fields)
        let value = JSONValue.object(operation)
        XCTAssertEqual(value["request"]["command"]["threadId"], .string("worker"))
        XCTAssertEqual(value["request"]["command"]["permissionChoice"], .string("once"))
        XCTAssertEqual(value["request"]["command"]["approved"], .bool(true))
        XCTAssertThrowsError(try WatcherWire.answer(target: WatcherTarget(hostId: host, threadId: "watcher"), command: fields))
    }
    func testRefusalsAndSendAndStopRepliesDecodeWithoutApprovingAnything() throws {
        if case .ok(let page) = try decode(WatcherPhoneResult.self, "{\"status\":\"ok\",\"state\":\(state)}") { XCTAssertTrue(page.working) }
        else { XCTFail("Missing page") }
        if case .ok(let draft, _) = try decode(WatcherSendResult.self, "{\"status\":\"ok\",\"draftId\":\"draft\",\"state\":\(state)}") { XCTAssertEqual(draft, "draft") }
        else { XCTFail("Missing send") }
        let refusal = #"{"status":"refused","code":"TARGET_CHANGED","message":"Review Stop all again.","retryable":false}"#
        if case .refused(let value) = try decode(WatcherStopPreviewResult.self, refusal) { XCTAssertEqual(value.code, "TARGET_CHANGED") }
        else { XCTFail("Missing refusal") }
        if case .ok(let preview) = try decode(WatcherStopPreviewResult.self, #"{"status":"ok","confirmationId":"preview","expiresAt":"later","targets":[{"hostId":"host","threadId":"worker","title":"Worker","provider":"claude"}]}"#) {
            XCTAssertEqual(preview.targets.first?.threadId, "worker")
            XCTAssertEqual(WatcherWire.stop(confirmationID: preview.confirmationId)["confirmationId"], .string("preview"))
        } else { XCTFail("Missing preview") }
        if case .ok(_, let results) = try decode(WatcherStopResult.self, "{\"status\":\"ok\",\"state\":\(state),\"results\":[{\"target\":{\"hostId\":\"host\",\"threadId\":\"worker\"},\"status\":\"uncertain\",\"message\":\"Check this worker.\"}]}") { XCTAssertEqual(results.first?.status, "uncertain") }
        else { XCTFail("Missing stop result") }
        XCTAssertThrowsError(try decode(WatcherPhoneResult.self, #"{"status":"automatic"}"#))
    }
    func testEveryResultRejectsUnknownStatusAndDecodesARefusal() throws {
        let decoders: [(String) throws -> Void] = [
            { _ = try self.decode(WatcherPhoneResult.self, $0) },
            { _ = try self.decode(WatcherSendResult.self, $0) },
            { _ = try self.decode(WatcherStopPreviewResult.self, $0) },
            { _ = try self.decode(WatcherStopResult.self, $0) },
            { _ = try self.decode(WatcherStopReceipt.self, $0) }
        ]
        for decodeResult in decoders {
            for invalid in [#"{"status":"future"}"#, #"{"status":true}"#, #"{}"#] {
                XCTAssertThrowsError(try decodeResult(invalid))
            }
            XCTAssertNoThrow(try decodeResult(#"{"status":"refused","code":"TARGET_CHANGED","message":"Refresh Watcher.","retryable":true}"#))
        }
    }
    func testStopReceiptKeepsPartialResultsWithoutAStalePage() throws {
        XCTAssertNil(try decode(Receipt.self, #"{"status":"completed"}"#).watcherStop)
        let text = #"{"status":"completed","watcherStop":{"status":"ok","results":[{"target":{"hostId":"host","threadId":"worker"},"status":"uncertain","message":"Check this worker."}]}}"#
        let receipt = try decode(Receipt.self, text)
        XCTAssertFalse(receipt.confirmsAnswer)
        guard case .ok(let results)? = receipt.watcherStop else { return XCTFail("Missing Stop all outcome") }
        XCTAssertEqual(results.first?.status, "uncertain")
        let refused = #"{"status":"completed","watcherStop":{"status":"refused","code":"TARGET_CHANGED","message":"Review again.","retryable":false}}"#
        guard case .refused(let value)? = try decode(Receipt.self, refused).watcherStop else { return XCTFail("Missing refusal") }
        XCTAssertEqual(value.code, "TARGET_CHANGED")
    }
    func testOptionalPageCannotBreakAnOrdinaryShell() throws {
        let base = #"{"hostId":"00000000-0000-4000-8000-000000000001","host":{"name":"Laptop","threads":[],"projects":[],"models":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}"#
        XCTAssertNil(try decode(Shell.self, base + "}").watcher)
        XCTAssertNil(try decode(Shell.self, base + ",\"watcher\":{\"future\":true}}").watcher)
        XCTAssertNotNil(try decode(Shell.self, base + ",\"watcher\":\(state)}").watcher)
    }
}
