import XCTest
@testable import SottoCore

final class TerminalTests: XCTestCase {
    private let terminalID = "33333333-3333-4333-8333-333333333333"
    private let hostID = "11111111-1111-4111-8111-111111111111"
    private func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) throws -> T { try value.decode(type) }
    private func terminal(state: String = "needs-you", provider: String = "claude", detection: String = "available", approval: Bool = true) throws -> TerminalSummary {
        var row: [String: JSONValue] = ["id": .string(terminalID), "projectId": .string("p"), "title": .string("Fix tooltips"),
            "providerId": .string(provider), "state": .string(state), "stateDetection": .string(detection), "openedAt": .number(1_800_000_000_000)]
        if approval { row["approval"] = .object(["runId": .string("run:1"), "requestId": .string("request-1"), "approvalId": .string("approval_1")]) }
        return try decode(TerminalSummary.self, .object(row))
    }
    private func preview(_ fields: [String: JSONValue] = [:]) throws -> TerminalApprovalPreview {
        var value: [String: JSONValue] = ["terminalId": .string(terminalID), "runId": .string("run:1"), "requestId": .string("request-1"),
            "approvalId": .string("approval_1"), "previewId": .string(String(repeating: "a", count: 64)),
            "lines": .array([.string("Bash command"), .string("  npm run typecheck"), .string("Do you want to proceed?")])]
        value.merge(fields) { _, new in new }
        return try decode(TerminalApprovalPreview.self, .object(value))
    }
    func testNewPhoneOptsInAndOldShellStillDecodes() throws {
        guard case .array(let accepts) = Wire.snapshotHello["accepts"] else { return XCTFail("Hello has no feature opt-in") }
        XCTAssertTrue(accepts.contains(.string("terminals")))
        let text = #"{"hostId":"\#(hostID)","host":{"hostId":"\#(hostID)","name":"Laptop","threads":[],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}}"#
        let shell = try JSONDecoder().decode(Shell.self, from: Data(text.utf8))
        try shell.validate(hostID: hostID)
        XCTAssertNil(shell.terminals)
    }
    func testTerminalRowsDecodeAllStatesWithoutScreenOutput() throws {
        for state in ["starting", "working", "idle", "needs-you", "just-finished", "exited"] {
            let row = try terminal(state: state)
            XCTAssertEqual(row.state.rawValue, state)
            XCTAssertEqual(row.openedAt, 1_800_000_000_000)
        }
        XCTAssertThrowsError(try terminal(state: "future-state"))
        XCTAssertEqual(try terminal(state: "just-finished").state.words, "Just finished")
    }
    func testOnlyCurrentSupportedClaudeHookHasAnAnswerChannel() throws {
        XCTAssertTrue(try terminal().hasAnswerChannel)
        for provider in ["codex", "grok", "future"] { XCTAssertFalse(try terminal(provider: provider).hasAnswerChannel) }
        XCTAssertFalse(try terminal(detection: "unavailable").hasAnswerChannel)
        XCTAssertFalse(try terminal(approval: false).hasAnswerChannel)
        for state in ["starting", "working", "idle", "just-finished", "exited"] { XCTAssertFalse(try terminal(state: state).hasAnswerChannel) }
    }
    func testApprovalPreviewAndAnswerBindEveryIdentity() throws {
        let row = try terminal(), current = try preview()
        XCTAssertTrue(current.matches(row))
        for field in ["terminalId", "runId", "requestId", "approvalId", "previewId"] {
            let changed = try preview([field: .string("another")])
            XCTAssertFalse(changed.matches(row), field)
            XCTAssertThrowsError(try Terminals.answer(.allow, terminal: row, preview: changed), field)
        }
        for decision in [TerminalDecision.allow, .deny] {
            let operation = try Terminals.answer(decision, terminal: row, preview: current)
            XCTAssertEqual(operation["op"], .string("answer-terminal"))
            XCTAssertEqual(operation["answer"]?["decision"], .string(decision.rawValue))
            XCTAssertEqual(operation["answer"]?["previewId"], .string(current.previewId))
            XCTAssertEqual(operation["answer"]?["lines"], .null)
            XCTAssertEqual(operation["answer"]?["updatedPermissions"], .null)
        }
    }
    func testPreviewLimitsAreCheckedInUTF16AndRequireHash() throws {
        let row = try terminal()
        XCTAssertTrue(try preview(["lines": .array(Array(repeating: .string(String(repeating: "x", count: 511)), count: 8))]).matches(row))
        for lines in [[], Array(repeating: "x", count: 9), [String(repeating: "x", count: 513)], [String(repeating: "😀", count: 257)], Array(repeating: String(repeating: "x", count: 512), count: 8)] {
            XCTAssertFalse(try preview(["lines": .array(lines.map(JSONValue.string))]).matches(row))
        }
        XCTAssertFalse(try preview(["previewId": .string(String(repeating: "A", count: 64))]).matches(row))
    }
    func testOpaqueBindingsRejectWhitespaceAndNativePayloads() throws {
        for id in ["", "has space", "has\nnewline", "秘密", String(repeating: "x", count: 129), "{\"command\":\"text\"}"] {
            XCTAssertFalse(Terminals.validOpaqueID(id))
        }
        XCTAssertTrue(Terminals.validOpaqueID("run_1.request:approval-2"))
    }
    func testTerminalMarkersPersistOnlyOpaqueIDsAndRequireHookReceipt() throws {
        let marker = PendingOperation(hostID: hostID, clientID: "phone", threadID: "", requestID: "request-1", kind: "terminal-answer",
            id: "stable-envelope", terminalID: terminalID, runID: "run:1", approvalID: "approval_1")
        let data = try JSONEncoder().encode(marker)
        XCTAssertEqual(try JSONDecoder().decode(PendingOperation.self, from: data), marker)
        let fields = try JSONDecoder().decode([String: JSONValue].self, from: data)
        for field in ["lines", "previewId", "decision", "screen", "token", "text"] { XCTAssertNil(fields[field]) }
        for receipt in [#"{"status":"unknown"}"#, #"{"status":"pending","answerDelivered":true}"#, #"{"status":"completed"}"#, #"{"status":"completed","answerDelivered":false}"#] {
            XCTAssertFalse(marker.reconciled(receipt: try JSONDecoder().decode(Receipt.self, from: Data(receipt.utf8)), deliveries: []))
        }
        XCTAssertTrue(marker.reconciled(receipt: try JSONDecoder().decode(Receipt.self, from: Data(#"{"status":"completed","answerDelivered":true}"#.utf8)), deliveries: []))
    }
    func testOldPendingMarkerStillDecodes() throws {
        let marker = try JSONDecoder().decode(PendingOperation.self, from: Data(#"{"id":"stable","hostID":"host","clientID":"phone","threadID":"thread","kind":"answer"}"#.utf8))
        XCTAssertNil(marker.terminalID)
        XCTAssertNil(marker.runID)
        XCTAssertNil(marker.approvalID)
    }
    func testMalformedOrUnknownTerminalDoesNotEraseThreads() throws {
        let text = #"{"hostId":"\#(hostID)","host":{"hostId":"\#(hostID)","name":"Laptop","threads":[{"id":"thread","projectId":"p","title":"Keep this thread","status":"idle","requests":[]}],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}},"terminals":[null,{"id":"invalid","state":"future-state"}]}"#
        let shell = try JSONDecoder().decode(Shell.self, from: Data(text.utf8))
        XCTAssertEqual(shell.host.threads.map(\.title), ["Keep this thread"])
        XCTAssertEqual(shell.terminals, [])
        XCTAssertFalse(shell.terminalsComplete)
    }
    func testFilteringIncludesComputerAndProjectAndKeepsUnreadFirst() throws {
        let done = HostedTerminal(ref: TerminalRef(hostID: hostID, terminalID: terminalID), computer: "Laptop", status: .online,
            project: "Sotto", terminal: try terminal(state: "just-finished"))
        let offline = HostedTerminal(ref: TerminalRef(hostID: "other", terminalID: terminalID), computer: "Studio Mac", status: .unreachable,
            project: "House", terminal: try terminal())
        XCTAssertEqual(Terminals.filtered([offline, done]).map(\.id), [done.id, offline.id])
        XCTAssertEqual(Terminals.filtered([offline, done], query: "Laptop").map(\.id), [done.id])
        XCTAssertEqual(Terminals.filtered([offline, done], query: "House").map(\.id), [offline.id])
        XCTAssertEqual(Terminals.filtered([offline, done], show: .only(hostID)).map(\.id), [done.id])
        XCTAssertEqual(Terminals.filtered([offline, done], query: "terminal").count, 2)
        XCTAssertFalse(offline.finishedUnread)
    }
}
