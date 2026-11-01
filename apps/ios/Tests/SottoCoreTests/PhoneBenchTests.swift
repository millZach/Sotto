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
        let one = { (revision: Int) in BenchWire.shellFrame(state: self.state, revision: revision + 1, base: revision, changed: [BenchWire.longThreadRecord(hostID: self.host, now: self.now)]) }
        report("shell-changed.bytes", Double(one(1).count), "B")
        report("shell-changed.read", try await timed { _ = cache.whole(try await self.shell(one(revision))); revision += 1 }, "ms")
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
