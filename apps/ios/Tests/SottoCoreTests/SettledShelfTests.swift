import XCTest
@testable import SottoCore

/// `settled-threads-on-request` (ADR-0028's November 1 amendment, part 2): a computer sends this phone its open threads and
/// those settled this week, says how many it left out, and the Settled shelf reads the rest a page at a time.
final class SettledShelfTests: XCTestCase {
    private func record(_ id: String, settledAt: String? = nil, title: String? = nil) -> String {
        let settled = settledAt.map { #","settledAt":"\#($0)""# } ?? ""
        return #"{"hostId":"h","id":"\#(id)","projectId":"p","title":"\#(title ?? "Thread " + id)","status":"idle","requests":[]\#(settled)}"#
    }
    private func page(_ records: [String], next: String?) throws -> SettledThreadsPage {
        let named = next.map { #""\#($0)""# } ?? "null"
        return try JSONDecoder().decode(SettledThreadsPage.self, from: Data(#"{"threads":[\#(records.joined(separator: ","))],"next":\#(named)}"#.utf8))
    }
    private func summaries(_ records: [String]) throws -> [ThreadSummary] {
        try JSONDecoder().decode([ThreadSummary].self, from: Data("[\(records.joined(separator: ","))]".utf8))
    }

    func testAShellSaysHowManySettledThreadsItLeftOut() throws {
        let fields = #"{"hostId":"h","name":"Laptop","threads":[],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}"#
        let held = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","host":\#(fields),"settledHeldBack":584}"#.utf8))
        XCTAssertEqual(held.settledHeldBack, 584)
        let whole = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","host":\#(fields)}"#.utf8))
        XCTAssertNil(whole.settledHeldBack, "A computer without the feature sends every thread and no count")
    }
    func testTheReadNamesItsCursorAndSearchOnlyWhenThereAreThem() {
        XCTAssertEqual(Wire.settledThreads(), ["op": .string("settled-threads")])
        XCTAssertEqual(Wire.settledThreads(after: "123:a", query: "billing"),
                       ["op": .string("settled-threads"), "after": .string("123:a"), "query": .string("billing")])
        XCTAssertEqual(Wire.settledThreads(query: ""), ["op": .string("settled-threads")])
    }
    func testPagesAddUpWithoutRepeatsAndSayWhetherMoreFollow() throws {
        var older = OlderSettled()
        XCTAssertTrue(older.more, "Nothing read yet: the computer has the first page")
        older.add(try page([record("a"), record("b")], next: "2:b"))
        XCTAssertEqual(older.threads.map(\.id), ["a", "b"])
        XCTAssertTrue(older.more)
        older.add(try page([record("b"), record("c")], next: nil))
        XCTAssertEqual(older.threads.map(\.id), ["a", "b", "c"])
        XCTAssertFalse(older.more)
        // A new connection reads from the start, keeping only the thread open here.
        let kept = OlderSettled(keeping: older.threads[1])
        XCTAssertEqual(kept.threads.map(\.id), ["b"])
        XCTAssertTrue(kept.more)
        XCTAssertNil(kept.next)
        XCTAssertTrue(OlderSettled(keeping: nil).threads.isEmpty)
    }
    func testOlderRowsLeaveOutWhatTheListCarriesAndReadNewestSettledFirst() throws {
        let listed = try summaries([record("restored")])
        let laptop = ComputerThreads(hostID: "laptop", name: "Laptop", status: .online, threads: listed, projects: [])
        let forge = ComputerThreads(hostID: "forge", name: "Forge", status: .online, threads: [], projects: [])
        let read = [
            "laptop": try summaries([record("old", settledAt: "2026-09-01T00:00:00Z"), record("restored", settledAt: "2026-10-01T00:00:00Z")]),
            "forge": try summaries([record("newer", settledAt: "2026-10-20T00:00:00Z")]),
        ]
        let rows = ThreadGroups.older([laptop, forge], read: read)
        XCTAssertEqual(rows.map(\.thread.id), ["newer", "old"])
        XCTAssertEqual(rows.map(\.computer), ["Forge", "Laptop"])
        XCTAssertTrue(rows.allSatisfy(\.settled))
        XCTAssertEqual(ThreadGroups.older([laptop, forge], read: read, show: .only("laptop")).map(\.thread.id), ["old"])
    }
    func testListedSettledRowsSplitIntoThisWeekAndOlderByWhenEachWasSettled() throws {
        let now = try XCTUnwrap(Stamp.date("2026-11-01T12:00:00Z"))
        let threads = try summaries([record("fresh", settledAt: "2026-10-30T12:00:00Z"), record("open-here", settledAt: "2026-09-01T00:00:00Z"),
                                     record("untimed")])
        let rows = ThreadGroups.hosted(ComputerThreads(hostID: "laptop", name: "Laptop", status: .online, threads: threads, projects: []))
        let split = ThreadGroups.thisWeek(rows, now: now)
        XCTAssertEqual(split.thisWeek.map(\.thread.id), ["fresh", "untimed"])
        XCTAssertEqual(split.older.map(\.thread.id), ["open-here"])
    }
    func testASearchKeepsWhereEachComputersNextMatchesStart() {
        let search = SettledSearch(query: "billing", found: [:], next: ["laptop": "1:a"])
        XCTAssertEqual(search.next, ["laptop": "1:a"])
        XCTAssertTrue(SettledSearch(query: "billing").next.isEmpty)
    }
    func testASearchSaysWhenAComputerCouldNotBeRead() {
        XCTAssertFalse(SettledSearch(query: "billing").failed)
        let failed = SettledSearch(query: "billing", found: [:], failed: true)
        XCTAssertTrue(failed.failed)
        XCTAssertNotEqual(failed, SettledSearch(query: "billing"), "A search that failed never reads as one that found nothing")
    }
}
