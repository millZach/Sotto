import XCTest
@testable import SottoCore

final class FocusThreadsTests: XCTestCase {
    private func thread(_ id: String, _ extra: String = "") throws -> ThreadSummary {
        try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"\#(id)","projectId":"p","title":"\#(id)","status":"idle","requests":[]\#(extra)}"#.utf8))
    }
    func testSettledRequestsAndBackgroundWorkRemainVisible() throws {
        let question = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"q","projectId":"p","title":"Ship","status":"idle","settledAt":"yesterday","requests":[{"id":"r","kind":"question","text":"Which target?","options":[]}]}"#.utf8))
        let work = try thread("background", #", "settledAt":"yesterday", "backgroundWork":[{"type":"subagent"}]"#)
        let done = try thread("finished", #", "settledAt":"yesterday""#)
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [question, work, done])])
        XCTAssertEqual(rows.questions.map(\.id), ["h/q"])
        XCTAssertEqual(rows.requestCount, 1)
        XCTAssertEqual(rows.working.map(\.id), ["h/background"])
        XCTAssertEqual(rows.settled.map(\.id), ["h/finished"])
    }
    func testOfflineSnapshotsDoNotClaimLiveWork() throws {
        let work = try thread("work", #", "backgroundWork":[{"type":"command"}]"#)
        for status in [ComputerStatus.connecting, .unreachable] {
            let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: status, threads: [work])])
            XCTAssertTrue(rows.working.isEmpty)
            XCTAssertEqual(rows.recent.map(\.id), ["h/work"])
        }
    }
    func testSearchIncludesSettledAndRespectsComputerIdentity() throws {
        let done = try thread("Café", #", "settledAt":"yesterday""#)
        let hosts = ["one", "two"].map { ComputerThreads(hostID: $0, name: $0, status: .online, threads: [done]) }
        let rows = FocusThreads(hosts, show: .only("two"), query: "  CAFE  ")
        XCTAssertTrue(rows.searching)
        XCTAssertEqual(rows.settled.map(\.id), ["two/Café"])
        XCTAssertFalse(rows.isEmpty)
        XCTAssertTrue(FocusThreads(hosts, query: "missing").isEmpty)
        XCTAssertFalse(FocusThreads(hosts, query: " \n ").searching)
    }
    func testUnreadFinishedThreadsKeepTheirPlaceAndCountOnlyInRecent() throws {
        let unread = try thread("unread", #", "finishedUnread":true"#)
        let read = try thread("read")
        let settled = try thread("settled", #", "finishedUnread":true, "settledAt":"yesterday""#)
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [read, unread, settled])])
        // The mark changes how a row looks, never which group it is in or where.
        XCTAssertEqual(rows.recent.map(\.id), ["h/read", "h/unread"])
        XCTAssertEqual(rows.settled.map(\.id), ["h/settled"])
        XCTAssertEqual(rows.recent.map(rows.isUnreadFinish), [false, true])
        XCTAssertTrue(rows.isUnreadFinish(rows.settled[0]))
        // A closed Settled shelf would hide what it counted, so the count is Recent's.
        XCTAssertEqual(rows.unreadFinishedCount, 1)
    }
    func testOpeningAThreadReadsItBeforeItsComputerSaysSo() throws {
        let unread = try thread("unread", #", "finishedUnread":true"#)
        let other = try thread("other", #", "finishedUnread":true"#)
        let computers = [ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [unread, other])]
        XCTAssertEqual(FocusThreads(computers).unreadFinishedCount, 2)
        let opened = FocusThreads(computers, opened: ThreadRef(hostID: "h", threadID: "unread"))
        XCTAssertEqual(opened.recent.map(opened.isUnreadFinish), [false, true])
        XCTAssertEqual(opened.unreadFinishedCount, 1)
        // The same thread ID on another computer is another thread.
        XCTAssertEqual(FocusThreads(computers, opened: ThreadRef(hostID: "other", threadID: "unread")).unreadFinishedCount, 2)
    }
    func testUnreadFinishedNeedsAReachableComputerAndAFinishedThread() throws {
        let unread = try thread("unread", #", "finishedUnread":true"#)
        for status in [ComputerStatus.connecting, .unreachable] {
            let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: status, threads: [unread])])
            XCTAssertEqual(rows.recent.map(\.id), ["h/unread"])
            XCTAssertEqual(rows.unreadFinishedCount, 0)
        }
        // A mark that rides on a thread that failed, works or asks is not shown; the thread says what it is doing instead.
        let failed = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"failed","projectId":"p","title":"Failed","status":"error","finishedUnread":true,"requests":[]}"#.utf8))
        let working = try thread("working", #", "finishedUnread":true, "backgroundWork":[{"type":"subagent"}]"#)
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [failed, working])])
        XCTAssertEqual(rows.recent.map(rows.isUnreadFinish), [false])
        XCTAssertEqual(rows.working.map(\.id), ["h/working"])
        XCTAssertEqual(rows.unreadFinishedCount, 0)
        // An older computer never sends the field, and nothing is marked.
        XCTAssertNil(try thread("old").finishedUnread)
    }
    func testWaitingAndCompactionCountAlongsideForegroundWork() throws {
        let waiting = try thread("command", #", "backgroundWork":[{"type":"command"}]"#)
        let compacting = try thread("context", #", "compaction":{"status":"running"}"#)
        let failed = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"failed","projectId":"p","title":"Failed","status":"error","requests":[]}"#.utf8))
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [waiting, compacting, failed])])
        XCTAssertEqual(rows.working.count, 2)
        XCTAssertEqual(rows.recent.map(\.id), ["h/failed"])
    }
}
