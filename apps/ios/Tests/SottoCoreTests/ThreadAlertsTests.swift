import XCTest
@testable import SottoCore

final class ThreadAlertsTests: XCTestCase {
    private let host = "00000000-0000-4000-8000-000000000001"
    private let all = AlertSwitches(needsYou: true, finished: true, failed: true)

    private func thread(_ id: String = "t", status: String = "idle", requests: [(String, String)] = [],
                        finishedUnread: Bool? = nil, title: String = "Fix the build") throws -> ThreadSummary {
        let rows = requests.map { #"{"id":"\#($0.0)","kind":"\#($0.1)","text":"Run npm ci?","options":[]}"# }.joined(separator: ",")
        let unread = finishedUnread.map { #","finishedUnread":\#($0)"# } ?? ""
        return try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"\#(id)","projectId":"p","title":"\#(title)","providerId":"claude","status":"\#(status)","requests":[\#(rows)]\#(unread)}"#.utf8))
    }
    private func observe(_ watch: inout ThreadWatch, _ threads: [ThreadSummary], onScreen: ThreadRef? = nil,
                         switches: AlertSwitches? = nil) -> [ThreadAlert] {
        watch.observe(threads, hostID: host, computer: "LAPTOP-RUSSH2J5", onScreen: onScreen, switches: switches ?? all)
    }

    func testTheFirstListAfterConnectingIsSilent() throws {
        var watch = ThreadWatch()
        let waiting = try thread(status: "error", requests: [("r1", "question")], finishedUnread: true)
        XCTAssertTrue(observe(&watch, [waiting]).isEmpty, "What was there on connecting is not news")
        XCTAssertTrue(observe(&watch, [waiting]).isEmpty, "Nor is it news on the next list")
    }
    func testANewRequestAlertsOnceWithoutItsWords() throws {
        var watch = ThreadWatch()
        _ = observe(&watch, [try thread()])
        let alerts = observe(&watch, [try thread(requests: [("r1", "question")])])
        XCTAssertEqual(alerts.count, 1)
        let alert = try XCTUnwrap(alerts.first)
        XCTAssertEqual(alert.kind, .question)
        XCTAssertEqual(alert.ref, ThreadRef(hostID: host, threadID: "t"))
        XCTAssertEqual(alert.title, "Fix the build")
        XCTAssertEqual(alert.body, "Claude Code is asking a question on LAPTOP-RUSSH2J5.")
        XCTAssertFalse(alert.body.contains("npm"), "A request's words never reach an alert")
        XCTAssertTrue(observe(&watch, [try thread(requests: [("r1", "question")])]).isEmpty, "The same request again is silent")
        XCTAssertTrue(observe(&watch, [try thread()]).isEmpty)
        XCTAssertTrue(observe(&watch, [try thread(requests: [("r1", "question")])]).isEmpty, "A request seen before never alerts twice")
        let permission = observe(&watch, [try thread(requests: [("r1", "question"), ("r2", "permission")])])
        XCTAssertEqual(permission.map(\.kind), [.permission])
        XCTAssertEqual(permission.first?.body, "Claude Code is asking for permission on LAPTOP-RUSSH2J5.")
    }
    func testFinishingUnreadAlertsWhenItTurnsTrue() throws {
        var watch = ThreadWatch()
        _ = observe(&watch, [try thread(status: "running")])
        XCTAssertTrue(observe(&watch, [try thread(status: "running", finishedUnread: false)]).isEmpty)
        let alerts = observe(&watch, [try thread(finishedUnread: true)])
        XCTAssertEqual(alerts.map(\.kind), [.finished])
        XCTAssertEqual(alerts.first?.body, "Claude Code finished on LAPTOP-RUSSH2J5.")
        XCTAssertTrue(observe(&watch, [try thread(finishedUnread: true)]).isEmpty, "Still unread is the same event")
    }
    func testStoppingWithAnErrorAlertsOnTheTransition() throws {
        var watch = ThreadWatch()
        _ = observe(&watch, [try thread(status: "running")])
        let alerts = observe(&watch, [try thread(status: "error", finishedUnread: true)])
        XCTAssertEqual(alerts.map(\.kind), [.failed], "An error is not also a finish")
        XCTAssertEqual(alerts.first?.body, "Claude Code stopped with an error on LAPTOP-RUSSH2J5.")
        XCTAssertTrue(observe(&watch, [try thread(status: "error")]).isEmpty)
        _ = observe(&watch, [try thread(status: "running")])
        XCTAssertEqual(observe(&watch, [try thread(status: "error")]).map(\.kind), [.failed], "A second failure is a new event")
    }
    func testTheThreadOnScreenIsSilentAndStaysSeen() throws {
        var watch = ThreadWatch()
        let ref = ThreadRef(hostID: host, threadID: "t")
        _ = observe(&watch, [try thread(status: "running"), try thread(id: "other", status: "running")])
        let alerts = observe(&watch, [try thread(status: "error", requests: [("r1", "permission")]),
                                      try thread(id: "other", requests: [("r9", "question")])], onScreen: ref)
        XCTAssertEqual(alerts.map(\.ref.threadID), ["other"], "Only the thread not on screen alerts")
        XCTAssertTrue(observe(&watch, [try thread(status: "error", requests: [("r1", "permission")]),
                                       try thread(id: "other", requests: [("r9", "question")])]).isEmpty,
                      "Leaving the thread doesn't bring up what was already on screen")
    }
    func testSwitchesThatAreOffAreSilentAndDontSaveEventsForLater() throws {
        var watch = ThreadWatch()
        _ = observe(&watch, [try thread(status: "running")])
        let off = AlertSwitches()
        XCTAssertFalse(off.any)
        XCTAssertTrue(observe(&watch, [try thread(status: "error", requests: [("r1", "question")])], switches: off).isEmpty)
        XCTAssertTrue(observe(&watch, [try thread(status: "error", requests: [("r1", "question")])]).isEmpty,
                      "Turning the switches on later doesn't alert old events")
        _ = observe(&watch, [try thread(status: "running")])
        let onlyFinished = AlertSwitches(finished: true)
        XCTAssertTrue(observe(&watch, [try thread(status: "error")], switches: onlyFinished).isEmpty,
                      "An error with its own switch off is not reported as a finish")
    }
    func testANewThreadAlertsOnlyForItsRequests() throws {
        var watch = ThreadWatch()
        _ = observe(&watch, [])
        let alerts = observe(&watch, [try thread(id: "a", status: "error"), try thread(id: "b", finishedUnread: true),
                                      try thread(id: "c", requests: [("r1", "question")])])
        XCTAssertEqual(alerts.map(\.ref.threadID), ["c"])
    }
    func testAgentNamesAndAnUntitledThread() throws {
        var watch = ThreadWatch()
        _ = observe(&watch, [])
        let alert = try XCTUnwrap(observe(&watch, [try thread(requests: [("r1", "question")], title: " ")]).first)
        XCTAssertEqual(alert.title, "A thread")
        XCTAssertEqual(AgentNames.name("codex"), "Codex")
        XCTAssertEqual(AgentNames.name(nil), "The agent")
    }
}
