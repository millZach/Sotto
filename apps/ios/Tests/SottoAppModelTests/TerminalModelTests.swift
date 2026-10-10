import XCTest
import SottoCore

final class TerminalModelTests: XCTestCase {
    private let hostID = "11111111-1111-4111-8111-111111111111"
    private let terminalID = "33333333-3333-4333-8333-333333333333"
    private var ref: TerminalRef { TerminalRef(hostID: hostID, terminalID: terminalID) }
    @MainActor private func fixture(feature: Bool = true, mayAnswer: Bool = true, provider: String = "claude", state: String = "needs-you") async throws -> AppModel {
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
        let model = AppModel(keychain: TestKeychain.store)
        model.phase(.active); await model.waitForActivation()
        return model
    }
    private func shell(provider: String = "claude", state: String = "needs-you", request: String = "request-1", mayAnswer: Bool? = nil, includeTerminals: Bool = true) -> JSONValue {
        var value: [String: JSONValue] = ["hostId": .string(hostID), "host": .object(["hostId": .string(hostID), "name": .string("Laptop"),
            "threads": .array([]), "projects": .array([.object(["id": .string("p"), "title": .string("Sotto")])]),
            "capabilities": .object(["submit": .bool(true), "interrupt": .bool(true), "questions": .bool(true), "permissions": .bool(true)])])]
        if includeTerminals {
            var terminal: [String: JSONValue] = ["id": .string(terminalID), "projectId": .string("p"), "title": .string("Fix tooltips"),
                "providerId": .string(provider), "state": .string(state), "stateDetection": .string("available"), "openedAt": .number(1_800_000_000_000)]
            if state == "needs-you" && provider == "claude" { terminal["approval"] = .object(["runId": .string("run-1"), "requestId": .string(request), "approvalId": .string("approval-1")]) }
            value["terminals"] = .array([.object(terminal)])
        }
        if let mayAnswer { value["clientCapabilities"] = .object(["mayAnswer": .bool(mayAnswer)]) }
        return .object(value)
    }
    private func preview(request: String = "request-1") -> JSONValue {
        .object(["terminalId": .string(terminalID), "runId": .string("run-1"), "requestId": .string(request), "approvalId": .string("approval-1"),
            "previewId": .string(String(repeating: "a", count: 64)), "lines": .array([.string("Bash command"), .string("  npm run typecheck"), .string("Do you want to proceed?")])])
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
}
