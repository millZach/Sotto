import XCTest
@testable import SottoCore

/// `changed-thread-records`: a host sends this phone only the thread records that changed since its last shell push,
/// beside a state whose own list is empty, and the connection puts the whole list back before anything reads the shell
/// (ADR-0028's October 30 amendment, #996).
final class ThreadRecordsTests: XCTestCase {
    /// A thread record shaped like one a host sends, about 1 KB, as the data-transfer benchmark's are.
    private func record(_ id: String, status: String = "idle", title: String? = nil) -> String {
        #"{"hostId":"h","id":"\#(id)","providerId":"claude","projectId":"h:project","title":"\#(title ?? "Thread " + id)","modelId":"native:claude:model:fake%3Amodel","kind":"project","status":"\#(status)","workspaceSettledAt":null,"nativeSessionStarted":true,"messages":[],"requests":[],"summary":{"messageCount":0},"subagentSummary":{"total":0,"working":0,"completed":0,"failed":0,"interrupted":0,"unknown":0},"usage":{"latest":{"input":1200,"output":560,"cached":820},"total":{"input":19340,"output":5250,"cached":12030},"contextUsed":2200,"contextWindow":200000,"elapsedMs":9800,"estimatedUsd":0.12,"elapsedKind":"api","rateVersions":["synthetic"],"partial":false,"updatedAt":"2026-10-20T12:00:00.000Z","contextUpdatedAt":"2026-10-20T12:00:00.000Z","modelId":"native:claude:model:fake%3Amodel"},"remoteHost":true,"clientConnected":true}"#
    }
    /// A shell push with `threads` as the state's own list and, when given, `records` as its changed thread records.
    private func push(threads: [String] = [], records: String? = nil) -> Data {
        let state = #"{"hostId":"h","host":{"hostId":"h","name":"Forge","threads":[\#(threads.joined(separator: ","))],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}}"#
        return Data((#"{"v":1,"event":"shell","state":\#(state)"# + (records.map { #","threads":\#($0)"# } ?? "") + "}").utf8)
    }
    private func records(revision: Int, base: Int?, changed: [String], removed: [String]? = nil, order: [String]? = nil) -> String {
        var fields = [#""revision":\#(revision)"#, #""base":\#(base.map { String($0) } ?? "null")"#, #""changed":[\#(changed.joined(separator: ","))]"#]
        if let removed { fields.append(#""removed":[\#(removed.map { "\"\($0)\"" }.joined(separator: ","))]"#) }
        if let order { fields.append(#""order":[\#(order.map { "\"\($0)\"" }.joined(separator: ","))]"#) }
        return "{" + fields.joined(separator: ",") + "}"
    }
    private func shell(_ data: Data) async throws -> Shell {
        guard case .shell(let shell) = try await Wire.readFrame(data) else { XCTFail("Expected a shell push"); throw ClientError.invalidProtocol }
        return shell
    }

    func testAPushCarriesItsChangedRecordsBesideTheState() async throws {
        let carried = try await shell(push(records: records(revision: 1, base: nil, changed: [record("a"), record("b")])))
        XCTAssertEqual(carried.host.threads, [])
        XCTAssertEqual(carried.threadRecords?.revision, 1)
        XCTAssertNil(carried.threadRecords?.base)
        XCTAssertEqual(carried.threadRecords?.changed.map(\.id), ["a", "b"])
        let whole = try await shell(push(threads: [record("a")]))
        XCTAssertNil(whole.threadRecords, "A host without the feature sends every record in the state")
    }
    func testAPushWhoseRecordsNameNoBaseIsUnreadable() async {
        // Read as a null base it would list only `a`, and every other thread held would go.
        let unnamed = push(records: #"{"revision":2,"changed":[\#(record("a"))]}"#)
        do { _ = try await Wire.readFrame(unnamed); XCTFail("A push without a base was read") } catch {}
    }
    func testTheWholeListIsPutBackFromTheRecordsHeld() async throws {
        var cache = ThreadRecordsCache()
        let listed = try await shell(push(records: records(revision: 1, base: nil, changed: [record("a"), record("b"), record("c")])))
        let first = try XCTUnwrap(cache.whole(listed))
        XCTAssertEqual(first.host.threads.map(\.id), ["a", "b", "c"])
        XCTAssertNil(first.threadRecords, "Nothing past the connection sees the wire's form")
        // One thread changed: the others are the ones held, in the same order.
        let oneChanged = try await shell(push(records: records(revision: 2, base: 1, changed: [record("b", status: "running")])))
        let changed = try XCTUnwrap(cache.whole(oneChanged))
        XCTAssertEqual(changed.host.threads.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(changed.host.threads.map(\.status), ["idle", "running", "idle"])
        XCTAssertEqual(changed.host.threads[0], first.host.threads[0])
        // A thread went and a new one came first, with the order that says so.
        let reordered = try await shell(push(records: records(revision: 3, base: 2, changed: [record("d")], removed: ["a"], order: ["d", "b", "c"])))
        let moved = try XCTUnwrap(cache.whole(reordered))
        XCTAssertEqual(moved.host.threads.map(\.id), ["d", "b", "c"])
        XCTAssertEqual(moved.host.threads[1].status, "running")
        // Nothing changed: the list held, as it was.
        let nothingChanged = try await shell(push(records: records(revision: 4, base: 3, changed: [])))
        let quiet = try XCTUnwrap(cache.whole(nothingChanged))
        XCTAssertEqual(quiet.host.threads, moved.host.threads)
    }
    func testAPushMeasuredFromRecordsNotHeldIsNotShownAndChangesNothing() async throws {
        var cache = ThreadRecordsCache()
        let unheld = try await shell(push(records: records(revision: 2, base: 1, changed: [record("a")])))
        XCTAssertNil(cache.whole(unheld), "Nothing held yet")
        let listed = try await shell(push(records: records(revision: 1, base: nil, changed: [record("a"), record("b")])))
        XCTAssertNotNil(cache.whole(listed))
        let otherBase = try await shell(push(records: records(revision: 3, base: 2, changed: [record("a", status: "running")])))
        XCTAssertNil(cache.whole(otherBase), "Another base than the one held")
        // What it held is unchanged, so a push measured from it still applies.
        let fromHeld = try await shell(push(records: records(revision: 4, base: 1, changed: [record("b", status: "running")])))
        let next = try XCTUnwrap(cache.whole(fromHeld))
        XCTAssertEqual(next.host.threads.map(\.status), ["idle", "running"])
    }
    func testAPushThatCannotPlaceEveryThreadIsNotShown() async throws {
        for wire in [
            records(revision: 2, base: 1, changed: [record("c")]),
            records(revision: 2, base: 1, changed: [], removed: ["a"]),
            records(revision: 2, base: 1, changed: [], removed: ["z"], order: ["a", "b"]),
            records(revision: 2, base: 1, changed: [], order: ["a", "a", "b"]),
            records(revision: 2, base: 1, changed: [], order: ["a"]),
            records(revision: 2, base: 1, changed: [record("c")], order: ["a", "b"]),
            records(revision: 2, base: 1, changed: [record("a"), record("a")]),
        ] {
            var cache = ThreadRecordsCache()
            let listed = try await shell(push(records: records(revision: 1, base: nil, changed: [record("a"), record("b")])))
            XCTAssertNotNil(cache.whole(listed))
            let unplaceable = try await shell(push(records: wire))
            XCTAssertNil(cache.whole(unplaceable), wire)
        }
    }
    func testAShellWithEveryRecordIsReadAsItCameAndHoldsNothing() async throws {
        var cache = ThreadRecordsCache()
        let whole = try await shell(push(threads: [record("a"), record("b")]))
        XCTAssertEqual(cache.whole(whole), whole)
        let fromWhole = try await shell(push(records: records(revision: 1, base: 0, changed: [])))
        XCTAssertNil(cache.whole(fromWhole), "A whole shell is no base")
    }
    /// What a shell push costs this phone to read while a thread on a computer of 290 threads streams: every record
    /// before, one changed record put back on the ones held after. Both are timed here on the same machine; `swift test`
    /// prints them as THREAD-RECORDS-READ. On the data-transfer benchmark a phone's push fell from 220 KB to 7 KB.
    func testReadingAPushOfChangedRecordsCostsLessThanReadingEveryRecord() async throws {
        let ids = (0..<290).map { "thread-\($0)" }
        let wholePush = push(threads: ids.map { record($0) })
        let firstPush = push(records: records(revision: 1, base: nil, changed: ids.map { record($0) }))
        var cache = ThreadRecordsCache()
        let listedPush = try await shell(firstPush)
        let held = try XCTUnwrap(cache.whole(listedPush))
        let rounds = 30
        var wholeTimes: [Double] = [], changedTimes: [Double] = []
        var last: Shell?
        for round in 0..<rounds {
            let start = DispatchTime.now().uptimeNanoseconds
            last = try await shell(wholePush)
            wholeTimes.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
            let changedPush = push(records: records(revision: round + 2, base: round + 1, changed: [record("thread-7", status: "running", title: "Round \(round)")]))
            let begin = DispatchTime.now().uptimeNanoseconds
            let oneChanged = try await shell(changedPush)
            let restored = try XCTUnwrap(cache.whole(oneChanged))
            changedTimes.append(Double(DispatchTime.now().uptimeNanoseconds - begin) / 1_000_000)
            XCTAssertEqual(restored.host.threads.count, 290)
            XCTAssertEqual(restored.host.threads[7].title, "Round \(round)")
            XCTAssertEqual(restored.host.threads[8], held.host.threads[8])
        }
        XCTAssertEqual(last?.host.threads.count, 290)
        let median = { (times: [Double]) in times.sorted()[times.count / 2] }
        print(String(format: "THREAD-RECORDS-READ whole push %ld bytes %.2f ms, changed push %ld bytes %.2f ms (medians of %ld)",
                     wholePush.count, median(wholeTimes), push(records: records(revision: 2, base: 1, changed: [record("thread-7", status: "running")])).count, median(changedTimes), rounds))
    }

    // `reply-thread-records` (ADR-0028's November 1 amendment): a hello or a shell read names the revision of the records
    // it lists whole, and the push after it carries only what changed since.
    private func reply(_ result: String) async throws -> HeldThreadRecords? {
        let frame = try await Wire.readFrame(Data(#"{"v":1,"id":"reply","ok":true,"result":\#(result)}"#.utf8))
        guard case .reply(_, _, _, let records) = frame else { XCTFail("Expected reply"); return nil }
        return records
    }
    private func listed(_ threads: [String], revision: Int?) -> String {
        let named = revision.map { #""threadRecordsRevision":\#($0),"# } ?? ""
        return #"{"hostId":"h",\#(named)"host":{"hostId":"h","name":"Forge","threads":[\#(threads.joined(separator: ","))],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}}"#
    }
    func testHelloHoldsTheRecordsItListsSoTheFirstPushCarriesOnlyWhatChanged() async throws {
        var cache = ThreadRecordsCache()
        let hello = #"{"hostId":"h","clientId":"phone","capabilities":{"mayAnswer":false},"shell":\#(listed([record("a"), record("b")], revision: 7))}"#
        let held = try await reply(hello)
        XCTAssertEqual(held?.revision, 7)
        XCTAssertEqual(held?.threads.map(\.id), ["a", "b"])
        cache.hold(try XCTUnwrap(held))
        let pushed = try await shell(push(records: records(revision: 8, base: 7, changed: [record("b", status: "running")])))
        let whole = try XCTUnwrap(cache.whole(pushed))
        XCTAssertEqual(whole.host.threads.map(\.id), ["a", "b"])
        XCTAssertEqual(whole.host.threads.map(\.status), ["idle", "running"])
    }
    func testAShellReadReplacesTheRecordsHeldWithTheOnesItLists() async throws {
        var cache = ThreadRecordsCache()
        let first = try await shell(push(records: records(revision: 1, base: nil, changed: [record("a")])))
        XCTAssertNotNil(cache.whole(first))
        let read = try await reply(listed([record("a"), record("c")], revision: 4))
        cache.hold(try XCTUnwrap(read))
        let pushed = try await shell(push(records: records(revision: 5, base: 4, changed: [])))
        XCTAssertEqual(try XCTUnwrap(cache.whole(pushed)).host.threads.map(\.id), ["a", "c"])
        // A push still measured from the records the read replaced is not shown.
        let stale = try await shell(push(records: records(revision: 6, base: 1, changed: [])))
        XCTAssertNil(cache.whole(stale))
    }
    func testAReplyThatNamesNoRevisionHoldsNothing() async throws {
        let hello = #"{"hostId":"h","clientId":"phone","capabilities":{"mayAnswer":false},"shell":\#(listed([record("a")], revision: nil))}"#
        let fromHello = try await reply(hello)
        XCTAssertNil(fromHello)
        let fromRead = try await reply(listed([record("a")], revision: nil))
        XCTAssertNil(fromRead)
        let fromOther = try await reply(#"{"ok":true}"#)
        XCTAssertNil(fromOther)
    }
}
