import XCTest
@testable import SottoCore

/// Owlets on the iPhone (ADR-0213, the first slice's second part): read from the thread records, listed apart from Threads,
/// silent in alerts, and made and changed with the computer's own commands.
final class OwletsTests: XCTestCase {
    private let host = "00000000-0000-4000-8000-000000000001"
    private func thread(_ id: String, _ extra: String = "", requests: String = "[]", status: String = "idle") throws -> ThreadSummary {
        try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"\#(id)","projectId":"p","title":"\#(id)","providerId":"claude","status":"\#(status)","requests":\#(requests)\#(extra)}"#.utf8))
    }
    private func owlet(_ id: String, name: String, role: String = "", at: String? = nil, requests: String = "[]") throws -> ThreadSummary {
        let when = at.map { #", "summary":{"lastMessageAt":"\#($0)"}"# } ?? ""
        return try thread(id, #", "owlet":{"name":"\#(name)","role":"\#(role)"}"# + when, requests: requests)
    }
    private func model(_ provider: String, ready: Bool = true) throws -> ThreadModel {
        try JSONDecoder().decode(ThreadModel.self, from: Data(#"{"id":"\#(provider)-model","name":"Model","provider":"\#(provider)","providerId":"\#(provider)","ready":\#(ready),"reasoningEfforts":["low","high"],"defaultReasoningEffort":"high","runtimeModes":["approval-required","full-access"]}"#.utf8))
    }

    func testAThreadRecordCarriesItsOwletAndAnOlderOneNone() throws {
        let tawny = try owlet("t", name: "Tawny", role: "Keeps my inbox")
        XCTAssertEqual(tawny.owlet, ThreadOwlet(name: "Tawny", role: "Keeps my inbox"))
        XCTAssertNil(try thread("plain").owlet)
    }

    func testOwletsListOnTheirOwnTabAndNeverOnThreads() throws {
        let asking = #"[{"id":"r","kind":"permission","text":"Send?","options":[]}]"#
        let threads = [try thread("work", #", "summary":{"lastMessageAt":"2026-11-21T09:00:00Z"}"#),
                       try owlet("tawny", name: "Tawny", role: "Keeps my inbox", at: "2026-11-21T08:00:00Z", requests: asking),
                       try owlet("scops", name: "Scops", role: "Repo upkeep", at: "2026-11-21T10:00:00Z"),
                       try owlet("elf", name: "Elf", role: "Morning brief", at: "2026-11-20T10:00:00Z"),
                       try owlet("barn", name: "Barn"), try owlet("alder", name: "Alder")]
        let computers = [ComputerThreads(hostID: host, name: "forge", status: .online, threads: threads)]
        let groups = FocusThreads(computers)
        XCTAssertEqual(groups.questions.map(\.id), [], "An owlet's card is answered on the Owlets tab")
        XCTAssertEqual(groups.recent.map(\.ref.threadID), ["work"])
        let list = OwletList(computers)
        XCTAssertEqual(list.needsYou.map(\.ref.threadID), ["tawny"])
        // Newest first; the two that never ran after them, by name.
        XCTAssertEqual(list.rest.map(\.ref.threadID), ["scops", "elf", "alder", "barn"])
        XCTAssertEqual(list.total, 5)
        XCTAssertEqual(list.needsYouCount, 1)
        // A search finds an owlet by its name, its role or its home computer.
        XCTAssertEqual(OwletList(computers, query: "inbox").needsYou.map(\.ref.threadID), ["tawny"])
        XCTAssertEqual(OwletList(computers, query: "brief").rest.map(\.ref.threadID), ["elf"])
        XCTAssertEqual(OwletList(computers, query: "forge").rest.count, 4)
        XCTAssertTrue(OwletList(computers, query: "nobody").isEmpty)
    }

    func testAnOwletOnAComputerOutOfReachWaitsOutsideNeedsYou() throws {
        let asking = #"[{"id":"r","kind":"question","text":"Which?","options":[]}]"#
        let computers = [ComputerThreads(hostID: host, name: "forge", status: .unreachable, threads: [try owlet("tawny", name: "Tawny", requests: asking)])]
        let list = OwletList(computers)
        XCTAssertTrue(list.needsYou.isEmpty)
        XCTAssertEqual(list.rest.map(\.ref.threadID), ["tawny"])
    }

    func testAnOwletNeverAlerts() throws {
        var watch = ThreadWatch()
        let all = AlertSwitches(needsYou: true, finished: true, failed: true)
        _ = watch.observe([try owlet("tawny", name: "Tawny"), try thread("work")], hostID: host, computer: "forge", onScreen: nil, switches: all)
        let asking = #"[{"id":"r","kind":"question","text":"Which?","options":[]}]"#
        let alerts = watch.observe([try owlet("tawny", name: "Tawny", requests: asking), try thread("work", requests: asking)],
                                   hostID: host, computer: "forge", onScreen: nil, switches: all)
        XCTAssertEqual(alerts.map(\.ref.threadID), ["work"])
    }

    func testTheMarkWearsTheFaceTheDesktopDrawsForTheSameThread() {
        // Worked out with the desktop's `owletLook` (src/renderer/src/features/owlets/OwletMark.tsx).
        XCTAssertTrue(Owlets.look(threadID: "0b9f5c2e-7d1a-4c3e-9f00-2a6b8e4d1c77") == (4, 1))
        XCTAssertTrue(Owlets.look(threadID: "forge:5e1d9a40-33c2-4b7a-8e15-90c4f2ab6d03") == (2, 0))
        XCTAssertTrue(Owlets.look(threadID: "a") == (4, 2))
        XCTAssertTrue(Owlets.look(threadID: "Ünïcødé") == (0, 2))
    }

    func testANameIsCheckedAsTheComputerChecksIt() {
        XCTAssertNil(Owlets.nameProblem("Tawny"))
        XCTAssertNil(Owlets.nameProblem("Snowy Owl-2"))
        XCTAssertNil(Owlets.nameProblem("Chouette d'Ève"))
        XCTAssertEqual(Owlets.nameProblem("   "), .empty)
        XCTAssertEqual(Owlets.nameProblem(String(repeating: "a", count: 41)), .long)
        XCTAssertEqual(Owlets.nameProblem("-dash"), .characters)
        XCTAssertEqual(Owlets.nameProblem("a/b"), .characters)
        XCTAssertEqual(Owlets.nameProblem("COM1"), .characters)
        XCTAssertTrue(Owlets.sameName(" tawny ", "Tawny"))
        XCTAssertEqual(Owlets.folderLabel("Tawny"), "Owlets/Tawny")
    }

    func testCreateOwletSendsOnlyTheFieldsTheComputerTakes() throws {
        let id = "0b9f5c2e-7d1a-4c3e-9f00-2a6b8e4d1c77"
        let command = try Commands.createOwlet(threadID: id, name: " Tawny ", role: " Keeps my inbox ", model: try model("claude"),
                                               effort: "high", permissionID: "approval-required", mayAnswer: false)
        XCTAssertEqual(command, .object(["type": .string("create-owlet"), "threadId": .string(id), "name": .string("Tawny"),
            "role": .string("Keeps my inbox"), "modelId": .string("claude-model"), "runtimeMode": .string("approval-required"),
            "reasoningEffort": .string("high")]))
        XCTAssertNoThrow(try Commands.createOwlet(threadID: id, name: "Scops", role: "", model: try model("codex"), effort: "", permissionID: "approval-required", mayAnswer: false))
    }

    func testCreateOwletRefusesWhatTheComputerWould() throws {
        let id = "0b9f5c2e-7d1a-4c3e-9f00-2a6b8e4d1c77"
        // Only Claude Code and Codex, whose own memory Sotto turns off in an owlet's folder.
        XCTAssertThrowsError(try Commands.createOwlet(threadID: id, name: "Tawny", role: "", model: try model("grok"), effort: "", permissionID: "approval-required", mayAnswer: true))
        XCTAssertThrowsError(try Commands.createOwlet(threadID: id, name: "Tawny", role: "", model: try model("claude", ready: false), effort: "", permissionID: "approval-required", mayAnswer: true))
        // A permission that lets it act without asking needs the computer's remote-answer policy.
        XCTAssertThrowsError(try Commands.createOwlet(threadID: id, name: "Tawny", role: "", model: try model("claude"), effort: "", permissionID: "full-access", mayAnswer: false))
        XCTAssertNoThrow(try Commands.createOwlet(threadID: id, name: "Tawny", role: "", model: try model("claude"), effort: "", permissionID: "full-access", mayAnswer: true))
        XCTAssertThrowsError(try Commands.createOwlet(threadID: "not-a-uuid", name: "Tawny", role: "", model: try model("claude"), effort: "", permissionID: "approval-required", mayAnswer: false))
        XCTAssertThrowsError(try Commands.createOwlet(threadID: id, name: "a/b", role: "", model: try model("claude"), effort: "", permissionID: "approval-required", mayAnswer: false))
        XCTAssertThrowsError(try Commands.createOwlet(threadID: id, name: "Tawny", role: String(repeating: "r", count: 201), model: try model("claude"), effort: "", permissionID: "approval-required", mayAnswer: false))
    }

    func testSetOwletChangesItsNameOrRoleOrBoth() throws {
        XCTAssertEqual(try Commands.setOwlet(threadID: "t", name: "Tawny"), .object(["type": .string("set-owlet"), "threadId": .string("t"), "name": .string("Tawny")]))
        XCTAssertEqual(try Commands.setOwlet(threadID: "t", role: " Inbox "), .object(["type": .string("set-owlet"), "threadId": .string("t"), "role": .string("Inbox")]))
        XCTAssertThrowsError(try Commands.setOwlet(threadID: "t"))
        XCTAssertThrowsError(try Commands.setOwlet(threadID: "t", name: ""))
    }

    func testTheHelloAcceptsOwlets() {
        guard case .array(let accepts)? = Wire.snapshotHello["accepts"] else { return XCTFail("Hello has no feature opt-in") }
        XCTAssertEqual(accepts.filter { $0 == .string(Owlets.feature) }.count, 1)
    }
}
