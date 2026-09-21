import XCTest
@testable import SottoCore

final class ProtocolTests: XCTestCase {
    private let host = "00000000-0000-4000-8000-000000000001"
    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T { try JSONDecoder().decode(type, from: Data(text.utf8)) }
    private func request(_ json: String) throws -> AgentRequest { try decode(AgentRequest.self, json) }

    func testPrivateTLSRouteIsRequired() throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net")
        XCTAssertEqual(endpoint.route("/v1/socket", socket: true).absoluteString, "wss://forge.example.ts.net/v1/socket")
        for address in ["http://forge.example.ts.net", "https://evil.ts.net.example.org", "https://forge.example.ts.net/path", "https://user:secret@forge.example.ts.net", "https://forge.example.ts.net?token=secret", "https://forge.example.ts.net#token", "https://localhost", "https://forge.example.ts.net:8443"] {
            XCTAssertThrowsError(try HostEndpoint(address), address)
        }
    }
    func testUnsupportedProtocolAndOversizeFramesAreRefused() throws {
        XCTAssertThrowsError(try Wire.decode(Data(#"{"v":2,"id":"one","ok":true,"result":null}"#.utf8)))
        XCTAssertThrowsError(try Wire.decode(Data(repeating: 32, count: Wire.maximumFrameBytes + 1)))
        XCTAssertNoThrow(try Wire.decode(Data(#"{"v":1,"id":"one","ok":true,"result":{},"newDisplayField":true}"#.utf8)))
    }
    func testEnvelopePreservesStableCommandIDAndNeverAddsAttribution() throws {
        let data = try Wire.request(id: "stable-command", session: "signed-session", operation: ["op": .string("command"), "command": .object(["type": .string("interrupt"), "threadId": .string("sotto-thread")])])
        let value = try Wire.decode(data)
        XCTAssertEqual(value["id"], .string("stable-command")); XCTAssertEqual(value["session"], .string("signed-session"))
        XCTAssertEqual(value["user"], .null); XCTAssertEqual(value["transport"], .null)
    }
    func testSessionCannotSwitchHostOrClient() throws {
        let pairing = try decode(Pairing.self, "{\"v\":1,\"hostId\":\"\(host)\",\"clientId\":\"phone\",\"token\":\"secret\"}")
        try pairing.validate()
        let other = try decode(HostSession.self, #"{"v":1,"hostId":"other","clientId":"phone","session":"signed","expiresAt":"later"}"#)
        XCTAssertThrowsError(try other.validate(pairing: pairing))
    }
    func testNativePermissionChoiceAndApprovalArePreserved() throws {
        let req = try request(#"{"id":"request","kind":"permission","text":"Run tests?","options":[],"permissionChoices":[{"id":"native-once","label":"Allow once","kind":"allow-once"},{"id":"native-deny","label":"Deny","kind":"deny"}]}"#)
        let allow = try Commands.answer(threadID: "thread", request: req, currentRequests: [req], choice: "native-once")
        XCTAssertEqual(allow["permissionChoice"], .string("native-once")); XCTAssertEqual(allow["approved"], .bool(true))
        let deny = try Commands.answer(threadID: "thread", request: req, currentRequests: [req], choice: "native-deny")
        XCTAssertEqual(deny["approved"], .bool(false)); XCTAssertThrowsError(try Commands.answer(threadID: "thread", request: req, currentRequests: [req], choice: "invented"))
    }
    func testAbsentPermissionChoicesDifferFromEmptyChoices() throws {
        let legacy = try request(#"{"id":"r","kind":"permission","text":"Allow?","options":[]}"#)
        XCTAssertTrue(legacy.supported)
        let result = try Commands.answer(threadID: "t", request: legacy, currentRequests: [legacy], choice: "allow")
        XCTAssertEqual(result["approved"], .bool(true)); XCTAssertEqual(result["permissionChoice"], .null)
        let empty = try request(#"{"id":"r","kind":"permission","text":"Allow?","options":[],"permissionChoices":[]}"#)
        XCTAssertFalse(empty.supported)
    }
    func testUnknownPermissionKindAndUncertainRequestsFailClosed() throws {
        let req = try request(#"{"id":"r","kind":"permission","text":"Allow?","options":[],"permissionChoices":[{"id":"x","label":"Automatic","kind":"automatic"}]}"#)
        XCTAssertFalse(req.supported)
        let uncertain = try request(#"{"id":"r","kind":"question","text":"Choose","options":[],"delivery":"uncertain"}"#)
        XCTAssertFalse(uncertain.supported)
    }
    func testStaleRequestOrChangedActionCannotBeAnswered() throws {
        let old = try request(#"{"id":"r","kind":"permission","text":"Run?","options":[],"context":{"command":"echo safe"}}"#)
        let changed = try request(#"{"id":"r","kind":"permission","text":"Run?","options":[],"context":{"command":"remove files"}}"#)
        XCTAssertThrowsError(try Commands.answer(threadID: "t", request: old, currentRequests: [], choice: "allow"))
        XCTAssertThrowsError(try Commands.answer(threadID: "t", request: old, currentRequests: [changed], choice: "allow"))
    }
    func testStructuredAnswersKeepQuestionAndOptionIDs() throws {
        let req = try request(#"{"id":"r","kind":"question","text":"Choose","options":[],"questions":[{"id":"q","question":"Target?","options":[{"id":"native-a","label":"Phone"},{"id":"native-b","label":"Desktop"}],"multiSelect":false,"allowFreeText":false}]}"#)
        let result = try Commands.answer(threadID: "t", request: req, currentRequests: [req], answers: ["q": QuestionAnswer(optionIds: ["native-a"])])
        XCTAssertEqual(result["questionAnswers"]["q"]["optionIds"], .array([.string("native-a")]))
        XCTAssertThrowsError(try Commands.answer(threadID: "t", request: req, currentRequests: [req], answers: ["q": QuestionAnswer(optionIds: ["native-a", "native-b"])]))
        XCTAssertThrowsError(try Commands.answer(threadID: "t", request: req, currentRequests: [req], answers: ["q": QuestionAnswer(text: "unsupported")]))
        XCTAssertThrowsError(try Commands.answer(threadID: "t", request: req, currentRequests: [req]))
    }
    func testPendingMarkerHasNoPromptAndCannotCrossHosts() throws {
        let pending = PendingOperation(hostID: host, clientID: "phone", threadID: "thread", draftID: UUID().uuidString, kind: "reply", id: "stable")
        let encoded = try JSONEncoder().encode(pending)
        let restored = try JSONDecoder().decode(PendingOperation.self, from: encoded)
        XCTAssertEqual(pending, restored); XCTAssertFalse(restored.matches(hostID: "other", clientID: "phone"))
        let fields = try JSONDecoder().decode([String: JSONValue].self, from: encoded)
        XCTAssertNil(fields["text"]); XCTAssertNil(fields["token"]); XCTAssertNil(fields["command"])
    }
    func testUnknownAfterHostRestartNeverConfirmsDelivery() throws {
        let pending = PendingOperation(hostID: host, clientID: "phone", threadID: "t", kind: "answer")
        let receipt = try decode(Receipt.self, #"{"status":"unknown"}"#)
        XCTAssertFalse(pending.reconciled(receipt: receipt, deliveries: []))
    }
    func testCompletedTransportReceiptDoesNotProvePromptDelivery() throws {
        let draft = UUID().uuidString
        let pending = PendingOperation(hostID: host, clientID: "phone", threadID: "t", draftID: draft, kind: "reply")
        let receipt = try decode(Receipt.self, #"{"status":"completed"}"#)
        XCTAssertFalse(pending.reconciled(receipt: receipt, deliveries: []))
        let uncertain = try decode(Delivery.self, "{\"threadId\":\"t\",\"draftId\":\"\(draft)\",\"status\":\"uncertain\"}")
        XCTAssertFalse(pending.reconciled(receipt: receipt, deliveries: [uncertain]))
        let accepted = try decode(Delivery.self, "{\"threadId\":\"t\",\"draftId\":\"\(draft)\",\"status\":\"accepted\"}")
        XCTAssertTrue(pending.reconciled(receipt: receipt, deliveries: [accepted]))
    }
    func testGenericPostAdmissionFailureStaysUnconfirmed() throws {
        let pending = PendingOperation(hostID: host, clientID: "phone", threadID: "t", kind: "answer")
        let receipt = try decode(Receipt.self, #"{"status":"completed","error":{"code":"unavailable","message":"Unavailable"}}"#)
        XCTAssertFalse(pending.reconciled(receipt: receipt, deliveries: []))
    }
    func testFullDetailIncludesSameLengthReplacementsAndPagination() throws {
        let before = try decode(ThreadDetail.self, #"{"threadId":"t","revision":1,"messages":[{"id":"m","role":"assistant","text":"old"}],"earlierAvailable":true}"#)
        let after = try decode(ThreadDetail.self, #"{"threadId":"t","revision":2,"messages":[{"id":"m","role":"assistant","text":"new"}],"earlierAvailable":true,"newField":42}"#)
        XCTAssertEqual(before.messages[0].id, after.messages[0].id); XCTAssertNotEqual(before.messages[0].text, after.messages[0].text)
        XCTAssertEqual(after.earlierAvailable, true)
    }
    func testLateSnapshotsCannotReplaceNewerPushOrSelection() {
        let epoch = UUID()
        XCTAssertFalse(SnapshotGuard.accepts(requestGeneration: epoch, currentGeneration: epoch, requestedThread: "a", selectedThread: "a", incomingRevision: 3, currentRevision: 4, changedSinceRead: true))
        XCTAssertFalse(SnapshotGuard.accepts(requestGeneration: epoch, currentGeneration: epoch, requestedThread: "a", selectedThread: "b", incomingRevision: 5, currentRevision: nil, changedSinceRead: false))
        XCTAssertTrue(SnapshotGuard.accepts(requestGeneration: epoch, currentGeneration: epoch, requestedThread: "a", selectedThread: "a", incomingRevision: 5, currentRevision: 4, changedSinceRead: true))
    }
    func testForegroundEpochRejectsPriorConnectionAndLateNull() {
        let epoch = UUID()
        XCTAssertFalse(SnapshotGuard.accepts(requestGeneration: UUID(), currentGeneration: epoch, requestedThread: "a", selectedThread: "a", incomingRevision: 10, currentRevision: 1, changedSinceRead: false))
        XCTAssertFalse(SnapshotGuard.accepts(requestGeneration: epoch, currentGeneration: epoch, requestedThread: "a", selectedThread: "a", incomingRevision: nil, currentRevision: 4, changedSinceRead: true))
    }
    func testEmptyAndOversizedPromptsCannotSend() throws {
        for text in ["  ", String(repeating: "x", count: 100_001)] { XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: text, draftID: UUID().uuidString)) }
    }
}
