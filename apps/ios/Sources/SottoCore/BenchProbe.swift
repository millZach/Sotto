import Foundation
#if canImport(os)
import os
#endif

/// Counts and times for the iPhone benchmarks (`apps/ios/Scripts/bench.sh`, `docs/perf/2026-10-31-iphone-benchmarks.md`).
/// It is off unless the benchmark fixture turns it on at launch, and off, each call is one read and a branch. It never
/// changes what the app does: it only counts what already happens.
public enum BenchProbe {
    /// Set once at launch by the benchmark fixture, before the first view draws, and by the core benchmarks' tests.
    public static var enabled = false
    /// Called on the main actor with each counted view body's name, for the benchmark driver's marks.
    public static var onBody: ((String) -> Void)?
    private static let lock = NSLock()
    private static var counts: [String: Int] = [:]
    #if canImport(os)
    /// Intervals for a trace taken in Instruments, under the subsystem the benchmark's trace template filters on.
    private static let signposter = OSSignposter(subsystem: "com.millzach.sotto.bench", category: "bench")
    #endif

    /// One evaluation of a view's body.
    @inline(__always) public static func body(_ name: StaticString) {
        guard enabled else { return }
        let key = name.description
        add("body." + key, 1)
        onBody?(key)
    }
    /// Adds `amount` to the counter `name`.
    @inline(__always) public static func count(_ name: @autoclosure () -> String, by amount: @autoclosure () -> Int = 1) {
        guard enabled else { return }
        add(name(), amount())
    }
    /// Runs `work`, and when the probe is on, adds its time to `time.<name>.ns`, its count to `time.<name>.n` and keeps
    /// its longest in `time.<name>.max`.
    @inline(__always) public static func time<T>(_ name: StaticString, _ work: () throws -> T) rethrows -> T {
        guard enabled else { return try work() }
        #if canImport(os)
        let interval = signposter.beginInterval(name)
        defer { signposter.endInterval(name, interval) }
        #endif
        let start = DispatchTime.now().uptimeNanoseconds
        let result = try work()
        record(name.description, nanoseconds: Int(DispatchTime.now().uptimeNanoseconds - start))
        return result
    }
    /// Adds one timed run of `nanoseconds` to `time.<name>`.
    public static func record(_ name: String, nanoseconds: Int) {
        guard enabled else { return }
        lock.lock(); defer { lock.unlock() }
        counts["time." + name + ".ns", default: 0] += nanoseconds
        counts["time." + name + ".n", default: 0] += 1
        counts["time." + name + ".max"] = max(counts["time." + name + ".max"] ?? 0, nanoseconds)
    }
    /// Every counter so far.
    public static func snapshot() -> [String: Int] {
        lock.lock(); defer { lock.unlock() }
        return counts
    }
    public static func reset() {
        lock.lock(); defer { lock.unlock() }
        counts = [:]
    }
    private static func add(_ name: String, _ amount: Int) {
        lock.lock(); defer { lock.unlock() }
        counts[name, default: 0] += amount
    }
}
