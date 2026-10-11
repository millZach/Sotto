import XCTest
import SottoCore

final class TerminalModelTests: XCTestCase {
    private let hostID = "11111111-1111-4111-8111-111111111111"
    private let terminalID = "33333333-3333-4333-8333-333333333333"
    private var ref: TerminalRef { TerminalRef(hostID: hostID, terminalID: terminalID) }
    @MainActor private func fixture(feature: Bool = true, mayAnswer: Bool = true, provider: String = "claude", state: String = "needs-you",
                                   receiptSleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
                                   observationSleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) async throws -> AppModel {
        TestKeychain.items = [:]; TestKeychain.locked = false; TestKeychain.unreadableAccount = nil; TestKeychain.unwritableAccount = nil
        HostConnection.instances = []; HostConnection.features = feature ? ["terminals"] : []
        HostConnection.mayAnswer = mayAnswer; HostConnection.failConnect = false; HostConnection.failDetail = false; HostConnection.holdDetail = false
        HostConnection.shells = [:]; HostConnection.afterGreeting = nil; HostConnection.commandHandler = nil
        HostConnection.receipts = [:]; HostConnection.receipt = .object(["status": .string("unknown")])
        HostConnection.loseAcknowledgement = false; HostConnection.terminalHandler = nil
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data(#"{"v":1,"hostId":"\#(hostID)","clientId":"phone","token":"fixture"}"#.utf8))
        try TestKeychain.store.write([hostID], account: ComputerStore.indexAccount)
        try TestKeychain.store.write(SavedComputer(address: "https://laptop.example.ts.net:8443", pairing: pairing, reportedName: "Laptop"), account: ComputerStore.account(hostID))
        HostConnection.shell = shell(provider: provider, state: state)
        HostConnection.terminalHandler = { op, _, _ in op == "terminal-approval" ? self.preview() : .null }
        let model = AppModel(keychain: TestKeychain.store, receiptSleep: receiptSleep, terminalObservationSleep: observationSleep)
        model.phase(.active); await model.waitForActivation()
        return model
    }
    private func shell(provider: String = "claude", state: String = "needs-you", request: String = "request-1", mayAnswer: Bool? = nil,
                       includeTerminals: Bool = true, includeApproval: Bool = true, fingerprint: String? = String(repeating: "a", count: 64)) -> JSONValue {
        var value: [String: JSONValue] = ["hostId": .string(hostID), "host": .object(["hostId": .string(hostID), "name": .string("Laptop"),
            "threads": .array([]), "projects": .array([.object(["id": .string("p"), "title": .string("Sotto")])]),
            "capabilities": .object(["submit": .bool(true), "interrupt": .bool(true), "questions": .bool(true), "permissions": .bool(true)])])]
        if includeTerminals {
            var terminal: [String: JSONValue] = ["id": .string(terminalID), "projectId": .string("p"), "title": .string("Fix tooltips"),
                "providerId": .string(provider), "state": .string(state), "stateDetection": .string("available"), "openedAt": .number(1_800_000_000_000)]
            if state == "needs-you" && provider == "claude" && includeApproval {
                var approval: [String: JSONValue] = ["runId": .string("run-1"), "requestId": .string(request), "approvalId": .string("approval-1")]
                if let fingerprint { approval["previewId"] = .string(fingerprint) }
                terminal["approval"] = .object(approval)
            }
            value["terminals"] = .array([.object(terminal)])
        }
        if let mayAnswer { value["clientCapabilities"] = .object(["mayAnswer": .bool(mayAnswer)]) }
        return .object(value)
    }
    private func preview(request: String = "request-1", fingerprint: String = String(repeating: "a", count: 64)) -> JSONValue {
        .object(["terminalId": .string(terminalID), "runId": .string("run-1"), "requestId": .string(request), "approvalId": .string("approval-1"),
            "previewId": .string(fingerprint), "lines": .array([.string("Bash command"), .string("  npm run typecheck"), .string("Do you want to proceed?")])])
    }
    @MainActor func testOldHostIsThreadsOnlyEvenIfItSendsUnadvertisedRows() async throws {
        let model = try await fixture(feature: false)
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        XCTAssertTrue(model.terminalRows.isEmpty)
        await model.readTerminalApproval(ref); await model.selectTerminal(ref)
        XCTAssertTrue(try XCTUnwrap(HostConnection.instances.last).terminalCalls.isEmpty)
    }
    @MainActor func testOnlyForegroundDetailObservesAndBackgroundDiscardsPreview() async throws {
        let model = try await fixture(state: "just-finished")
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        let connection = try XCTUnwrap(HostConnection.instances.last)
        XCTAssertEqual(connection.terminalCalls.last?["terminalIds"], .array([]), "A list row is not visible terminal detail")
        await model.selectTerminal(ref)
        XCTAssertEqual(connection.terminalCalls.last?["terminalIds"], .array([.string(terminalID)]))
        await model.selectTerminal(nil)
        XCTAssertEqual(connection.terminalCalls.last?["terminalIds"], .array([]))
        XCTAssertFalse(connection.operations.contains("terminal-approval"))
    }
    @MainActor func testInactivePhoneWithdrawsTerminalObservationAndActiveRestoresIt() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        let connection = try XCTUnwrap(HostConnection.instances.last)
        await model.selectTerminal(ref)
        model.phase(.inactive)
        let deadline = Date().addingTimeInterval(10)
        while connection.terminalCalls.last?["terminalIds"] != .array([]) && Date() < deadline { await Task.yield() }
        XCTAssertEqual(connection.terminalCalls.last?["terminalIds"], .array([]))
        model.phase(.active)
        while connection.terminalCalls.last?["terminalIds"] != .array([.string(terminalID)]) && Date() < deadline { await Task.yield() }
        XCTAssertEqual(connection.terminalCalls.last?["terminalIds"], .array([.string(terminalID)]))
    }
    @MainActor func testClosingThreadDuringTerminalWithdrawalDoesNotObserveItAfterLateReply() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        let connection = try XCTUnwrap(HostConnection.instances.last)
        await model.selectTerminal(ref)
        let withdrawal = expectation(description: "Terminal withdrawal started")
        var reply: CheckedContinuation<JSONValue, Never>?
        HostConnection.terminalHandler = { op, _, _ in
            guard op == "observe-terminals" else { return .null }
            return await withCheckedContinuation { continuation in
                reply = continuation; withdrawal.fulfill()
            }
        }
        let thread = ThreadRef(hostID: hostID, threadID: "alert-thread")
        let opening = Task { await model.select(thread) }
        await fulfillment(of: [withdrawal], timeout: 10)
        XCTAssertEqual(model.selected, thread, "Back must see the local selection before network cleanup finishes")
        opening.cancel()
        await model.select(nil)
        let observations = connection.operations.filter { $0 == "observe" }.count
        reply?.resume(returning: .null)
        await opening.value
        XCTAssertNil(model.selected)
        XCTAssertNil(model.selectedTerminal)
        XCTAssertEqual(connection.operations.filter { $0 == "observe" }.count, observations, "A late cleanup reply must not observe the closed thread")
    }
    @MainActor func testCanAnswerRevocationAndChangedBindingDisableAnswer() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval), connection = try XCTUnwrap(HostConnection.instances.last)
        XCTAssertTrue(model.canAnswerTerminal(ref, approval: approval))
        connection.push(.shell(try shell(mayAnswer: false).decode(Shell.self)))
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: approval))
        await model.answerTerminal(ref, approval: approval, decision: .allow)
        XCTAssertFalse(connection.operations.contains("answer-terminal"))
        connection.push(.shell(try shell(request: "new-request", mayAnswer: true).decode(Shell.self)))
        XCTAssertNil(model.terminalPreviews[ref.id])
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: approval))
    }
    @MainActor func testRefusedWithdrawalRetriesTheLatestSelection() async throws {
        let clock = TerminalObservationClock()
        let model = try await fixture(observationSleep: { _ in await clock.wait() })
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        let connection = try XCTUnwrap(HostConnection.instances.last)
        await model.selectTerminal(ref)
        var visible = true
        var refuse = true
        HostConnection.terminalHandler = { op, operation, _ in
            guard op == "observe-terminals" else { return .null }
            if refuse { throw HostRefusal(failure: try JSONValue.object(["code": .string("busy"), "message": .string("Try again.")]).decode(WireFailure.self)) }
            visible = operation["terminalIds"] != .array([])
            return .null
        }
        await model.selectTerminal(nil)
        XCTAssertTrue(visible, "The refused withdrawal left the host's previous visibility intact")
        let deadline = Date().addingTimeInterval(10)
        while !(await clock.waiting) && Date() < deadline { await Task.yield() }
        let waiting = await clock.waiting
        XCTAssertTrue(waiting)
        // Even another refused selection must not leave the retry holding that terminal ID.
        await model.selectTerminal(ref)
        await model.selectTerminal(nil)
        refuse = false
        await clock.release()
        while visible && Date() < deadline { await Task.yield() }
        XCTAssertFalse(visible)
        XCTAssertEqual(connection.terminalCalls.last?["terminalIds"], .array([]))
    }
    @MainActor func testObservationRetryDoesNotSurviveAConnectionGenerationChange() async throws {
        let clock = TerminalObservationClock()
        let model = try await fixture(observationSleep: { _ in await clock.wait() })
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        let connection = try XCTUnwrap(HostConnection.instances.last)
        await model.selectTerminal(ref)
        HostConnection.terminalHandler = { _, _, _ in throw ClientError.uncertain }
        await model.selectTerminal(nil)
        let deadline = Date().addingTimeInterval(10)
        while !(await clock.waiting) && Date() < deadline { await Task.yield() }
        let waiting = await clock.waiting
        XCTAssertTrue(waiting)
        HostConnection.terminalHandler = { _, _, _ in .null }
        await model.connect(hostID)
        let calls = connection.terminalCalls.count
        await clock.release()
        // Let the canceled retry's continuation finish before comparing calls.
        while !(await clock.released) && Date() < deadline { await Task.yield() }
        await Task.yield()
        XCTAssertEqual(connection.terminalCalls.count, calls)
    }
    @MainActor func testScreenOnlyProvidersHaveNoPreviewOrAnswer() async throws {
        for provider in ["codex", "grok"] {
            let model = try await fixture(provider: provider)
            await model.readTerminalApproval(ref)
            XCTAssertNil(model.terminalPreviews[ref.id])
            XCTAssertFalse(try XCTUnwrap(HostConnection.instances.last).operations.contains("terminal-approval"))
            model.phase(.background)
        }
        HostConnection.terminalHandler = nil
    }
    @MainActor func testUnavailablePreviewOffersNoAnswer() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        HostConnection.terminalHandler = { _, _, _ in .null }
        await model.readTerminalApproval(ref)
        XCTAssertNil(model.terminalPreviews[ref.id]); XCTAssertNotNil(model.terminalPreviewProblems[ref.id])
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: model.terminal(ref)?.approval))
    }
    @MainActor func testManyApprovalCardsQueuePreviewReadsBelowTheHostLimit() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        let connection = try XCTUnwrap(HostConnection.instances.last)
        guard case .object(var state) = shell(), case .array(let rows) = state["terminals"],
              case .object(let original) = rows.first else { return XCTFail("Missing terminal fixture") }
        let refs = (0..<40).map { _ in TerminalRef(hostID: hostID, terminalID: UUID().uuidString) }
        state["terminals"] = .array(refs.map { ref in
            var row = original; row["id"] = .string(ref.terminalID); return .object(row)
        })
        connection.push(.shell(try JSONValue.object(state).decode(Shell.self)))
        var active = 0, peak = 0
        var holding = true
        var replies: [CheckedContinuation<JSONValue, Never>] = []
        HostConnection.terminalHandler = { op, _, _ in
            guard op == "terminal-approval" else { return .null }
            active += 1; peak = max(peak, active)
            defer { active -= 1 }
            if holding { return await withCheckedContinuation { replies.append($0) } }
            return .null
        }
        let reads = refs.map { ref in Task { await model.readTerminalApproval(ref) } }
        let deadline = Date().addingTimeInterval(10)
        while replies.count < 2 && Date() < deadline { await Task.yield() }
        XCTAssertEqual(replies.count, 2, "Only two reads may reach this computer before a reply arrives")
        holding = false
        replies.forEach { $0.resume(returning: .null) }
        for read in reads { await read.value }
        XCTAssertEqual(peak, 2)
        XCTAssertEqual(connection.terminalCalls.filter { $0["op"] == .string("terminal-approval") }.count, 40)
    }
    @MainActor func testHookReceiptConfirmsAnswerAndMarkerNeverStoresScreen() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval)
        var answerID: String?
        HostConnection.terminalHandler = { op, operation, id in
            guard op == "answer-terminal" else { return .null }
            answerID = id
            let marker = try XCTUnwrap(model.pending.first)
            XCTAssertEqual(marker.id, id); XCTAssertEqual(marker.terminalID, self.terminalID)
            let encoded = String(decoding: try JSONEncoder().encode(marker), as: UTF8.self)
            XCTAssertFalse(encoded.contains("npm run")); XCTAssertFalse(encoded.contains("previewId")); XCTAssertFalse(encoded.contains("decision"))
            XCTAssertEqual(operation["answer"]?["decision"], .string("deny"))
            HostConnection.receipts[id] = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
            return .object(["answerDelivered": .bool(true)])
        }
        await model.answerTerminal(ref, approval: approval, decision: .deny)
        XCTAssertNotNil(answerID); XCTAssertTrue(model.pending.isEmpty)
        XCTAssertTrue(model.terminalAnswerConfirmed(approval, in: ref))
        XCTAssertFalse(model.shouldRestoreTerminalApproval(approval, in: ref), "A confirmed request keeps its Answered feedback")
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: approval), "A stale shell cannot answer a confirmed request twice")
    }
    @MainActor func testLostAcknowledgementUsesReceiptWithoutResending() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval)
        var sends = 0
        HostConnection.terminalHandler = { op, _, id in
            if op == "answer-terminal" {
                sends += 1; HostConnection.receipts[id] = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
                throw ClientError.uncertain
            }
            return .null
        }
        await model.answerTerminal(ref, approval: approval, decision: .allow)
        XCTAssertEqual(sends, 1); XCTAssertTrue(model.pending.isEmpty)
        XCTAssertTrue(model.terminalAnswerConfirmed(approval, in: ref))
        await model.checkDelivery(hostID)
        XCTAssertEqual(sends, 1)
    }
    @MainActor func testUnconfirmedAnswerSurvivesRelaunchAndIsNeverResent() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval)
        var sends = 0
        HostConnection.terminalHandler = { op, _, _ in if op == "answer-terminal" { sends += 1; throw ClientError.uncertain }; return .null }
        await model.answerTerminal(ref, approval: approval, decision: .allow)
        XCTAssertEqual(sends, 1); XCTAssertEqual(model.pending.count, 1)
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: approval))
        model.phase(.background)
        XCTAssertTrue(model.terminalPreviews.isEmpty)
        let relaunched = AppModel(keychain: TestKeychain.store)
        relaunched.phase(.active); await relaunched.waitForActivation()
        XCTAssertEqual(relaunched.pending.count, 1); XCTAssertEqual(sends, 1)
        XCTAssertFalse(relaunched.terminalAnswerConfirmed(approval, in: ref))
        relaunched.phase(.background)
    }
    @MainActor func testChangedRequestDoesNotClaimThisPhoneAnsweredIt() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval)
        HostConnection.terminalHandler = { op, _, _ in if op == "answer-terminal" { throw ClientError.uncertain }; return .null }
        await model.answerTerminal(ref, approval: approval, decision: .allow)
        HostConnection.shell = shell(state: "working")
        await model.checkDelivery(hostID)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertFalse(model.terminalAnswerConfirmed(approval, in: ref))
        XCTAssertEqual(model.feedback, "That request is no longer waiting.")
    }
    @MainActor func testUnreadableTerminalRowDoesNotEraseUnconfirmedAnswer() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval)
        HostConnection.terminalHandler = { op, _, _ in if op == "answer-terminal" { throw ClientError.uncertain }; return .null }
        await model.answerTerminal(ref, approval: approval, decision: .allow)
        guard case .object(var next) = shell() else { return XCTFail("Missing fixture shell") }
        next["terminals"] = .array([.object(["id": .string(terminalID), "state": .string("future")])])
        HostConnection.shell = .object(next)
        await model.checkDelivery(hostID)
        XCTAssertEqual(model.pending.count, 1)
        XCTAssertFalse(model.terminalAnswerConfirmed(approval, in: ref))
    }
    @MainActor func testWithheldApprovalBindingKeepsPendingAnswerUntilHookReceiptConfirmsIt() async throws {
        // Script the receipt wait so this regression never waits on a real hook or sleeps for its deadline.
        let model = try await fixture(receiptSleep: { _ in throw CancellationError() })
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval), connection = try XCTUnwrap(HostConnection.instances.last)
        var commandID: String?
        var sends = 0
        HostConnection.terminalHandler = { op, _, id in
            if op == "answer-terminal" { sends += 1; commandID = id; throw ClientError.uncertain }
            return .null
        }
        await model.answerTerminal(ref, approval: approval, decision: .allow)
        let marker = try XCTUnwrap(model.pending.first), id = try XCTUnwrap(commandID)
        XCTAssertEqual(marker.id, id)
        HostConnection.shell = shell(includeApproval: false)
        connection.push(.shell(try HostConnection.shell.decode(Shell.self)))
        XCTAssertNil(model.terminal(ref)?.approval)
        XCTAssertEqual(model.pending, [marker], "A withheld binding while still Needs you does not prove the request left")
        HostConnection.receipts[id] = .object(["status": .string("pending")])
        await model.checkDelivery(hostID)
        XCTAssertEqual(model.pending, [marker])
        XCTAssertEqual(try TestKeychain.store.read([PendingOperation].self, account: ComputerStore.pendingAccount), [marker])
        XCTAssertFalse(model.terminalAnswerConfirmed(approval, in: ref))
        HostConnection.receipts[id] = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
        await model.checkDelivery(hostID)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertTrue(model.terminalAnswerConfirmed(approval, in: ref))
        XCTAssertEqual(sends, 1, "Receipt reconciliation must never resend the answer")
    }
    @MainActor func testChangedScreenFingerprintImmediatelyDisablesOldPreviewThenAcceptsFreshPreview() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let oldApproval = try XCTUnwrap(model.terminal(ref)?.approval), connection = try XCTUnwrap(HostConnection.instances.last)
        XCTAssertTrue(model.canAnswerTerminal(ref, approval: oldApproval))
        let next = String(repeating: "b", count: 64)
        connection.push(.shell(try shell(fingerprint: next).decode(Shell.self)))
        let current = try XCTUnwrap(model.terminal(ref)?.approval)
        XCTAssertEqual(current.id, oldApproval.id)
        XCTAssertNil(model.terminalPreviews[ref.id])
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: current))
        await model.readTerminalApproval(ref)
        XCTAssertNil(model.terminalPreviews[ref.id], "A late old-fingerprint preview is rejected")
        HostConnection.terminalHandler = { op, _, _ in op == "terminal-approval" ? self.preview(fingerprint: next) : .null }
        await model.readTerminalApproval(ref, force: true)
        XCTAssertEqual(model.terminalPreviews[ref.id]?.previewId, next)
        XCTAssertTrue(model.canAnswerTerminal(ref, approval: current))
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: oldApproval))
    }
    @MainActor func testWithdrawnFingerprintClearsCachedScreenAndDisablesAnswers() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let connection = try XCTUnwrap(HostConnection.instances.last)
        connection.push(.shell(try shell(fingerprint: nil).decode(Shell.self)))
        XCTAssertNil(model.terminalPreviews[ref.id], "Withdrawing a known fingerprint clears its cached screen even on a legacy-shaped row")
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: model.terminal(ref)?.approval))
        connection.push(.shell(try shell(includeApproval: false).decode(Shell.self)))
        XCTAssertNil(model.terminalPreviews[ref.id])
        await model.readTerminalApproval(ref)
        XCTAssertFalse(model.canAnswerTerminal(ref, approval: model.terminal(ref)?.approval))
    }
    @MainActor func testScreenFingerprintChangeDoesNotSettleAnUnconfirmedAnswerAsAnotherRequest() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval), connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.terminalHandler = { op, _, _ in if op == "answer-terminal" { throw ClientError.uncertain }; return .null }
        await model.answerTerminal(ref, approval: approval, decision: .allow)
        let marker = try XCTUnwrap(model.pending.first)
        HostConnection.shell = shell(fingerprint: String(repeating: "b", count: 64))
        connection.push(.shell(try HostConnection.shell.decode(Shell.self)))
        await model.checkDelivery(hostID)
        XCTAssertEqual(model.pending, [marker])
        XCTAssertFalse(model.terminalAnswerConfirmed(approval, in: ref))
        XCTAssertFalse(model.shouldRestoreTerminalApproval(approval, in: ref), "An uncertain answer keeps its receipt feedback")
        HostConnection.receipts[marker.id] = .object(["status": .string("completed"), "answerDelivered": .bool(true)])
        await model.checkDelivery(hostID)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertTrue(model.terminalAnswerConfirmed(approval, in: ref))
        XCTAssertTrue(model.terminalAnswerConfirmed(try XCTUnwrap(model.terminal(ref)?.approval), in: ref))
        XCTAssertEqual(connection.terminalCalls.filter { $0["op"] == .string("answer-terminal") }.count, 1)
    }
    @MainActor func testRejectedAnswerRestoresSameRequestAfterScreenRedraw() async throws {
        let model = try await fixture()
        defer { model.phase(.background); HostConnection.terminalHandler = nil }
        await model.readTerminalApproval(ref)
        let approval = try XCTUnwrap(model.terminal(ref)?.approval), connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.terminalHandler = { op, _, _ in
            guard op == "answer-terminal" else { return .null }
            connection.push(.shell(try self.shell(fingerprint: String(repeating: "b", count: 64)).decode(Shell.self)))
            throw HostRefusal(failure: try JSONValue.object(["code": .string("stale_request"), "message": .string("Review the current permission.")]).decode(WireFailure.self))
        }
        await model.answerTerminal(ref, approval: approval, decision: .allow)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertFalse(model.terminalAnswerConfirmed(approval, in: ref))
        XCTAssertTrue(model.shouldRestoreTerminalApproval(approval, in: ref), "The screen changed, but the same request still needs an answer")
        connection.push(.shell(try shell(includeApproval: false).decode(Shell.self)))
        XCTAssertFalse(model.shouldRestoreTerminalApproval(approval, in: ref), "A withdrawn binding cannot restore the old approval controls")
        connection.push(.shell(try shell(request: "request-2").decode(Shell.self)))
        XCTAssertFalse(model.shouldRestoreTerminalApproval(approval, in: ref), "A new request does not inherit the old card")
    }
}

private actor TerminalObservationClock {
    private var pending: CheckedContinuation<Void, Never>?
    private(set) var waiting = false
    private(set) var released = false
    func wait() async {
        await withCheckedContinuation { pending = $0; waiting = true }
        released = true
    }
    func release() { pending?.resume(); pending = nil }
}
