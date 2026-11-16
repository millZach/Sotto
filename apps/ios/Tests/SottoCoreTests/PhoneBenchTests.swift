import XCTest
@testable import SottoCore

/// The iPhone benchmarks' data, and the parts of their work SottoCore does (`docs/perf/2026-10-31-iphone-benchmarks.md`).
/// The first tests always run: they hold the benchmark's frames to what a computer sends, so a benchmark never
/// measures frames the phone refuses. The timings run only with `SOTTO_IOS_BENCH=1` (`Scripts/bench.sh`), and print
/// `IOS-CORE <what> <value> <unit>` lines that `Scripts/bench-summary.py` reads.
final class PhoneBenchTests: XCTestCase {
    private let host = "11111111-1111-4111-8111-111111111111"
    private let now = Date(timeIntervalSince1970: 1_793_000_000)
    private var state: Data {
        Data(#"{"hostId":"\#(host)","host":{"hostId":"\#(host)","name":"Laptop","threads":[],"projects":[{"id":"sotto","title":"Sotto"},{"id":"panel","title":"Panel tools"},{"id":"house","title":"House"}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"projects":true,"threads":true}}}"#.utf8)
    }

    private func shell(_ data: Data) async throws -> Shell {
        guard case .shell(let shell) = try await Wire.readFrame(data) else { throw ClientError.invalidProtocol }
        return shell
    }
    private func detail(_ data: Data) async throws -> ThreadDetail {
        guard case .detail(_, let detail?) = try await Wire.readFrame(data) else { throw ClientError.invalidProtocol }
        return detail
    }
    private func delta(_ data: Data) async throws -> ThreadDetailDelta {
        guard case .delta(_, let delta) = try await Wire.readFrame(data) else { throw ClientError.invalidProtocol }
        return delta
    }

    // MARK: The benchmark's frames are ones the phone reads

    func testTheListPushesAreReadAndPutBack() async throws {
        let records = BenchWire.threadRecords(count: 300, hostID: host, now: now)
        var cache = ThreadRecordsCache()
        let whole = try await shell(BenchWire.shellFrame(state: state, revision: 1, base: nil, changed: records))
        let first = try XCTUnwrap(cache.whole(whole))
        XCTAssertEqual(first.host.threads.count, 300)
        XCTAssertEqual(first.host.threads.first?.id, BenchWire.longThreadID)
        XCTAssertNoThrow(try first.validate(hostID: host))
        let changed = BenchWire.shellFrame(state: state, revision: 2, base: 1, changed: [BenchWire.longThreadRecord(hostID: host, now: now.addingTimeInterval(5))])
        let one = try await shell(changed)
        let next = try XCTUnwrap(cache.whole(one))
        XCTAssertEqual(next.host.threads.count, 300)
        XCTAssertEqual(next.host.threads.dropFirst().map(\.id), first.host.threads.dropFirst().map(\.id))
    }

    func testAPushAfterTheFirstNamesItsPartsKeptAndIsPutBackWhole() async throws {
        // The order `AppModel.benchDeliver` reads them in: the kept parts back first, then the thread records.
        var parts = KeptPartsCache(), records = ThreadRecordsCache()
        let sized = BenchWire.hostSizedState(state, now: now)
        let full = try await shell(BenchWire.shellFrame(state: sized, revision: 1, base: nil, changed: BenchWire.threadRecords(count: 300, hostID: host, now: now)))
        let first = try XCTUnwrap(records.whole(try XCTUnwrap(parts.whole(full))))
        let frame = BenchWire.shellFrame(state: BenchWire.keptState(sized), revision: 2, base: 1, changed: [BenchWire.longThreadRecord(hostID: host, now: now)])
        // A host sends a phone 1,826 bytes a push once its parts are kept (`hostPushSizeBudget.perf.test.ts`); the laptop's
        // state names fewer parts, so this push is a little smaller, and smaller than the same push carrying its state whole.
        XCTAssertLessThan(frame.count, 1_826)
        XCTAssertLessThan(frame.count, BenchWire.shellFrame(state: state, revision: 2, base: 1, changed: [BenchWire.longThreadRecord(hostID: host, now: now)]).count)
        let read = try await shell(frame)
        XCTAssertEqual(read.keptParts?.keepsAny, true)
        XCTAssertNil(read.deliveries)
        let whole = try XCTUnwrap(records.whole(try XCTUnwrap(parts.whole(read))))
        XCTAssertEqual(whole.deliveries?.count, 128)
        XCTAssertEqual(whole.deliveredDrafts?.count, 128)
        XCTAssertEqual(whole.followupReceipts?.count, 79)
        XCTAssertEqual(whole.host.name, first.host.name)
        XCTAssertEqual(whole.host.projects, first.host.projects)
        XCTAssertEqual(whole.host.capabilities, first.host.capabilities)
        XCTAssertEqual(whole.host.threads.count, 300)
        XCTAssertNoThrow(try whole.validate(hostID: host))
    }

    func testAListPushTheSizeAHostSendsIsReadAndShowsNothingNew() async throws {
        for part in BenchWire.hostParts {
            XCTAssertEqual(BenchWire.hostPart(part.name, bytes: part.bytes, now: now).utf8.count, part.bytes, part.name)
        }
        let sized = BenchWire.hostSizedState(state, now: now)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: sized) as? [String: Any])
        XCTAssertTrue(Set(object.keys).isSuperset(of: BenchWire.hostParts.map { $0.name }))
        var cache = ThreadRecordsCache()
        let full = try await shell(BenchWire.shellFrame(state: state, revision: 1, base: nil, changed: BenchWire.threadRecords(count: 300, hostID: host, now: now)))
        _ = try XCTUnwrap(cache.whole(full))
        let frame = BenchWire.shellFrame(state: sized, revision: 2, base: 1, changed: [BenchWire.longThreadRecord(hostID: host, now: now)])
        // A host's first push to a phone carries the parts it reads, 66,842 bytes of them: 73,177 bytes a push in
        // `hostPushSizeBudget.perf.test.ts`, where the rest is its projects, providers and settings, kept as the laptop's.
        XCTAssertGreaterThan(frame.count, 66_842)
        XCTAssertLessThan(frame.count, 73_177)
        let read = try await shell(frame)
        XCTAssertEqual(read.deliveries?.count, 128)
        XCTAssertEqual(read.deliveredDrafts?.count, 128)
        XCTAssertEqual(read.followupReceipts?.count, 79)
        XCTAssertEqual(read.deliveries?.allSatisfy { $0.status == "accepted" && $0.setAside == nil }, true)
        let whole = try XCTUnwrap(cache.whole(read))
        XCTAssertEqual(whole.host.threads.count, 300)
        XCTAssertNoThrow(try whole.validate(hostID: host))
        // None of the threads the ledgers name is on the list, so no thread's reply box or queue reads them.
        let listed = Set(whole.host.threads.map(\.id))
        let named = (read.deliveries ?? []).map(\.threadId) + (read.deliveredDrafts ?? []).map(\.threadId) + (read.followupReceipts ?? []).map(\.threadId)
        XCTAssertTrue(named.allSatisfy { !listed.contains($0) })
    }

    func testTheLongThreadAndItsStreamAreRead() async throws {
        var long = try await detail(BenchWire.longDetailFrame(turns: 200, now: now))
        XCTAssertEqual(long.messages.count, 402)
        XCTAssertEqual(long.activities?.count, 801)
        XCTAssertEqual(long.messages.last?.id, BenchWire.streamingMessageID)
        let start = BenchWire.streamStepSequence(turns: 200)
        for chunk in 1...200 {
            let change = try await delta(BenchWire.deltaFrame(chunk: chunk, revision: long.revision, firstSequence: start, now: now))
            long = try XCTUnwrap(long.applying(change), "Chunk \(chunk) must apply")
        }
        XCTAssertEqual(long.revision, 201)
        XCTAssertGreaterThan(long.messages.last?.text.count ?? 0, 800)
        // Ten steps finished while it streamed, and the last one it started still runs.
        let streamed = (long.activities ?? []).filter { $0.id.hasPrefix("bench-step-stream") }
        XCTAssertEqual(streamed.count, 11)
        XCTAssertEqual(streamed.filter { $0.status == "running" }.map(\.id), ["bench-step-stream-10"])
        XCTAssertEqual(ThreadTimeline.items(messages: long.messages, activities: long.activities ?? []).isEmpty, false)
    }

    func testTheIdlePhasesLeaveOneThreadWorkingThenNone() async throws {
        func working(_ shell: Shell) -> [String] { shell.host.threads.filter { ThreadState($0).workInProgress }.map(\.id) }
        var cache = ThreadRecordsCache()
        let full = try await shell(BenchWire.shellFrame(state: state, revision: 1, base: nil, changed: BenchWire.threadRecords(count: 300, hostID: host, now: now)))
        let first = try XCTUnwrap(cache.whole(full))
        XCTAssertEqual(working(first).count, 8)
        // `idle-list`: one list push settles the other seven, and the long thread works alone.
        let others = try await shell(BenchWire.shellFrame(state: state, revision: 2, base: 1, changed: BenchWire.othersSettled(count: 300, hostID: host, now: now)))
        let alone = try XCTUnwrap(cache.whole(others))
        XCTAssertEqual(alone.host.threads.count, 300)
        XCTAssertEqual(working(alone), [BenchWire.longThreadID])
        // `idle-thread`: after a stream, the turn ends with its last step finished and its record settled.
        var long = try await detail(BenchWire.longDetailFrame(turns: 200, now: now))
        let start = BenchWire.streamStepSequence(turns: 200)
        for chunk in 1...200 {
            let change = try await delta(BenchWire.deltaFrame(chunk: chunk, revision: long.revision, firstSequence: start, now: now))
            long = try XCTUnwrap(long.applying(change), "Chunk \(chunk) must apply")
        }
        let running = (long.activities ?? []).filter { $0.status == "running" }
        XCTAssertEqual(running.map(\.id), ["bench-step-stream-10"])
        let end = try await delta(BenchWire.endTurnFrame(finishing: running, revision: long.revision, now: now))
        long = try XCTUnwrap(long.applying(end), "The turn's end must apply")
        XCTAssertEqual((long.activities ?? []).filter { $0.status == "running" }.count, 0)
        XCTAssertEqual((long.activities ?? []).filter { $0.id.hasPrefix("bench-step-stream") }.count, 11)
        let settled = try await shell(BenchWire.shellFrame(state: state, revision: 3, base: 2, changed: [BenchWire.longThreadRecord(hostID: host, now: now, running: false)]))
        let none = try XCTUnwrap(cache.whole(settled))
        XCTAssertEqual(working(none), [])
    }

    // MARK: Timings, with SOTTO_IOS_BENCH=1

    private func timed(_ rounds: Int = 15, _ work: () async throws -> Void) async throws -> Double {
        var times: [Double] = []
        for _ in 0..<rounds {
            let start = DispatchTime.now().uptimeNanoseconds
            try await work()
            times.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }
        return times.sorted()[times.count / 2]
    }
    private func report(_ name: String, _ value: Double, _ unit: String) {
        print(String(format: "IOS-CORE %@ %.4f %@", name, value, unit))
    }

    func testCoreTimings() async throws {
        guard ProcessInfo.processInfo.environment["SOTTO_IOS_BENCH"] == "1" else { throw XCTSkip("Set SOTTO_IOS_BENCH=1 to time the core") }
        // A list push of every record, as on connecting, and one with the long thread's record only, as while it works.
        let records = BenchWire.threadRecords(count: 300, hostID: host, now: now)
        let full = BenchWire.shellFrame(state: state, revision: 1, base: nil, changed: records)
        report("shell-full.bytes", Double(full.count), "B")
        report("shell-full.read", try await timed { var cache = ThreadRecordsCache(); _ = cache.whole(try await self.shell(full)) }, "ms")
        var cache = ThreadRecordsCache()
        let fullShell = try await shell(full)
        let held = try XCTUnwrap(cache.whole(fullShell))
        var revision = 1
        // The same push both times, the second as a running host sends a phone, its parts named kept beside the record
        // (#2390, #2595); its kept parts are put back as `AppModel.benchDeliver` puts them back.
        let one = { (pushed: Data, revision: Int) in BenchWire.shellFrame(state: pushed, revision: revision + 1, base: revision, changed: [BenchWire.longThreadRecord(hostID: self.host, now: self.now)]) }
        report("shell-changed.bytes", Double(one(state, 1).count), "B")
        report("shell-changed.read", try await timed { _ = cache.whole(try await self.shell(one(self.state, revision))); revision += 1 }, "ms")
        // `shell-real` the push with every part whole, as a host sends a connection's first; `shell-kept` each after it,
        // its parts named kept (#2615).
        let sized = BenchWire.hostSizedState(state, now: now), kept = BenchWire.keptState(sized)
        var parts = KeptPartsCache()
        // Reads one list push of `pushed` and puts its kept parts back from the push before it.
        func readPutBack(_ pushed: Data) async throws {
            let read = try await self.shell(one(pushed, revision))
            _ = cache.whole(try XCTUnwrap(parts.whole(read))); revision += 1
        }
        report("shell-real.bytes", Double(one(sized, 1).count), "B")
        report("shell-real.read", try await timed { try await readPutBack(sized) }, "ms")
        report("shell-kept.bytes", Double(one(kept, 1).count), "B")
        report("shell-kept.read", try await timed { try await readPutBack(kept) }, "ms")
        let threads = ComputerThreads(hostID: host, name: "Laptop", status: .online, threads: held.host.threads)
        report("list.merged-300", try await timed { _ = ThreadGroups.merged([threads]) }, "ms")

        // The long thread, read on open, then its timeline and its Markdown as the page builds them.
        let longFrame = BenchWire.longDetailFrame(turns: 200, now: now)
        report("detail-200.bytes", Double(longFrame.count), "B")
        report("detail-200.read", try await timed(7) { _ = try await self.detail(longFrame) }, "ms")
        let long = try await detail(longFrame)
        report("timeline-200.items", try await timed(7) { _ = ThreadTimeline.items(messages: long.messages, activities: long.activities ?? []) }, "ms")
        report("markdown-200.blocks", try await timed(7) { for message in long.messages { _ = Markdown.blocks(message.text) } }, "ms")

        // One streamed word: its bytes, reading it, putting it into the thread, and what the page then works out again.
        let start = BenchWire.streamStepSequence(turns: 200)
        let chunk = BenchWire.deltaFrame(chunk: 7, revision: long.revision, firstSequence: start, now: now)
        report("delta.bytes", Double(chunk.count), "B")
        report("delta.read", try await timed(31) { _ = try await self.delta(chunk) }, "ms")
        let change = try await delta(chunk)
        report("delta.apply-200", try await timed(31) { _ = long.applying(change) }, "ms")
        let grown = try XCTUnwrap(long.applying(change))
        report("delta.timeline-200", try await timed(15) { _ = ThreadTimeline.items(messages: grown.messages, activities: grown.activities ?? []) }, "ms")
        let reply = String(repeating: "The new drive moves the fan to the side wall so the terminal strip fits. ", count: 30)
        report("delta.markdown-2kB", try await timed(31) { _ = Markdown.blocks(reply) }, "ms")
    }
}
