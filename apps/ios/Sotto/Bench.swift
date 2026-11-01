#if DEBUG && os(iOS)
import Darwin
import UIKit
import SottoCore

/// The app's half of the iPhone benchmarks (`Scripts/bench.sh`, `docs/perf/2026-10-31-iphone-benchmarks.md`). It runs
/// only in the UI fixture with `--bench-threads`, and only when `SOTTO_BENCH_FILE` names its report.
///
/// With `--bench-journey all` the app walks the journey itself, so nothing outside it touches the screen: XCUITest
/// turns on and reads the whole accessibility tree, which on a long thread cost more than the thread did. The phases:
/// `launch` to the first frame showing every thread, `list-scroll` down the list and back, `open` the long thread as a
/// notification opens it, `thread-scroll` up through it and back, `stream` a reply into it, then `finished`. Each phase
/// lasts until the screen is quiet, and records its frames, hitches, CPU time, memory and what the probes counted.
/// With `--bench-journey launch` it stops after the first. It reads and changes nothing the app shows.
@MainActor final class BenchDriver {
    private static var running: BenchDriver?

    static func start(model: AppModel, chunks: Int, journey: String, long: ThreadRef) {
        guard running == nil, let path = ProcessInfo.processInfo.environment["SOTTO_BENCH_FILE"], !path.isEmpty else { return }
        let driver = BenchDriver(model: model, report: URL(fileURLWithPath: path), chunks: chunks, long: long)
        running = driver
        driver.begin(all: journey == "all")
    }
    /// The laptop's whole list has been applied: the next Threads body draws it.
    static func listApplied() { running?.waiting.insert("first-list") }
    /// The long thread's detail has been applied: the next conversation body draws it.
    static func detailApplied() { running?.waiting.insert("open-rendered") }

    private weak var model: AppModel?
    private let report: URL
    private let chunks: Int
    private let long: ThreadRef
    private let launched = BenchDriver.processStart()
    private var phase = "launch"
    private var frames = Frames(from: CACurrentMediaTime())
    private var countsAtPhase: [String: Int] = [:]
    private var cpuAtPhase = 0.0
    private var phases: [String: Any] = [:]
    private var marks: [String: Double] = [:]
    /// Marks waiting for the body that draws them, then for the first display frame after that body's frame was
    /// committed: that frame is the mark.
    private var waiting: Set<String> = []
    private var drawing: Set<String> = []
    private var peakFootprint = 0.0
    private var link: CADisplayLink?
    private var motion: Motion?
    private var timer: Timer?
    private let writes = DispatchQueue(label: "com.millzach.sotto.bench.report", qos: .utility)

    private init(model: AppModel, report: URL, chunks: Int, long: ThreadRef) {
        self.model = model; self.report = report; self.chunks = chunks; self.long = long
    }

    private func begin(all: Bool) {
        BenchProbe.onBody = { name in MainActor.assumeIsolated { BenchDriver.running?.body(name) } }
        let link = CADisplayLink(target: FrameTarget(self), selector: #selector(FrameTarget.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in MainActor.assumeIsolated { BenchDriver.running?.write() } }
        mark("driver-start")
        Task { await journey(all: all) }
    }

    private func journey(all: Bool) async {
        guard await until({ self.marks["first-list"] != nil }) else { return finish("no-list") }
        await quiet()
        guard all else { return finish(nil) }

        next("list-scroll")
        scrolled(await scroll(up: false))
        await quiet()

        next("open")
        mark("open-begin")
        model?.alertOpened = long
        guard await until({ self.marks["open-rendered"] != nil }) else { return finish("no-thread") }
        await quiet()

        next("thread-scroll")
        scrolled(await scroll(up: true))
        await quiet()

        next("stream")
        let started = CACurrentMediaTime()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            model?.benchStream(chunks: chunks) { done.resume() }
        }
        mark("stream-done")
        phaseNotes["wallMs"] = (CACurrentMediaTime() - started) * 1000
        await quiet()
        finish(nil)
    }

    /// Extra numbers for the phase now running, kept in its summary.
    private var phaseNotes: [String: Any] = [:]

    private func next(_ name: String) {
        phases[phase] = summary()
        frames = Frames(from: CACurrentMediaTime())
        countsAtPhase = BenchProbe.snapshot()
        cpuAtPhase = Self.cpuMs()
        phaseNotes = [:]
        phase = name
        mark("phase-" + name)
        write()
    }

    /// Ends the journey: `finished`, or `failed-<why>` when a phase never got what it waited for, which the script
    /// counts as a failed run and the summary leaves out.
    private func finish(_ failure: String?) {
        next(failure.map { "failed-" + $0 } ?? "finished")
        link?.invalidate(); link = nil
        timer?.invalidate(); timer = nil
        write()
    }

    private func scrolled(_ distance: CGFloat?) {
        phaseNotes["scrolledPoints"] = distance.map(Double.init) ?? 0
    }

    /// Waits up to a minute for a condition the main actor sees.
    private func until(_ condition: @escaping () -> Bool) async -> Bool {
        for _ in 0..<1_200 {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return false
    }

    /// Waits until half a second has passed without a late frame, so work a phase started is counted in it; ten
    /// seconds at most.
    private func quiet() async {
        let start = CACurrentMediaTime()
        while CACurrentMediaTime() - start < 10 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            // Frames must be arriving again too: a main thread still blocked has not yet drawn the late frame.
            let now = CACurrentMediaTime()
            if now - frames.last < 0.1, now - max(frames.lastHitch, start) >= 0.5 { return }
        }
    }

    /// Scrolls the page's scroller 12,000 points (or to its end) at 3,000 points a second and back, the offset set
    /// from the clock each frame, so a late frame jumps as a finger's fling would. Returns the distance, or nil when
    /// there was nothing to scroll.
    private func scroll(up: Bool) async -> CGFloat? {
        guard let view = Self.pageScroller() else { return nil }
        let top = -view.adjustedContentInset.top
        let bottom = max(top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
        let from = view.contentOffset.y
        let to = up ? max(top, from - 12_000) : min(bottom, from + 12_000)
        let distance = abs(to - from)
        guard distance > 0 else { return nil }
        for (a, b) in [(from, to), (to, from)] {
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                motion = Motion(view: view, from: a, to: b, seconds: Double(distance) / 3_000, done: done)
            }
        }
        return distance
    }

    /// The scroller the page shows: the tallest visible vertical scroll view that is not a text view.
    private static func pageScroller() -> UIScrollView? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        var best: UIScrollView?
        func visit(_ view: UIView) {
            if view.isHidden || view.alpha == 0 { return }
            if let scroller = view as? UIScrollView, !(scroller is UITextView),
               scroller.contentSize.height > scroller.bounds.height + 100,
               scroller.contentSize.height > (best?.contentSize.height ?? 0) {
                best = scroller
            }
            view.subviews.forEach(visit)
        }
        windows.filter { !$0.isHidden }.forEach(visit)
        return best
    }

    private func body(_ name: String) {
        let drawn: String?
        switch name {
        case "ThreadsView": drawn = waiting.contains("first-list") ? "first-list" : nil
        case "Conversation": drawn = waiting.contains("open-rendered") ? "open-rendered" : nil
        default: drawn = nil
        }
        guard let drawn else { return }
        waiting.remove(drawn)
        // The body runs before layout and the frame's commit, both in this turn of the main run loop. The display link's
        // next frame comes after that commit, once the main thread is free: the mark is taken there.
        drawing.insert(drawn)
    }

    /// The current phase's frames, CPU time, memory and what was counted in it.
    private func summary() -> [String: Any] {
        let now = BenchProbe.snapshot()
        var counts: [String: Int] = [:]
        for (key, value) in now where value != (countsAtPhase[key] ?? 0) {
            counts[key] = key.hasSuffix(".max") ? value : value - (countsAtPhase[key] ?? 0)
        }
        sampleFootprint()
        var result: [String: Any] = ["frames": frames.summary(), "counts": counts, "cpuMs": Self.cpuMs() - cpuAtPhase,
                                     "footprintMB": Self.footprintMB(), "peakFootprintMB": peakFootprint]
        result.merge(phaseNotes) { _, new in new }
        return result
    }

    private func mark(_ name: String) {
        guard marks[name] == nil else { return }
        marks[name] = (Date().timeIntervalSince1970 - launched) * 1000
    }

    fileprivate func tick(_ link: CADisplayLink) {
        frames.tick(link)
        if !drawing.isEmpty {
            drawing.forEach(mark)
            drawing = []
            write()
        }
        if frames.count % 30 == 0 { sampleFootprint() }
        guard let motion else { return }
        if motion.started == 0 { self.motion?.started = link.timestamp }
        let progress = motion.started == 0 ? 0 : min(1, (link.timestamp - motion.started) / max(motion.seconds, 0.001))
        motion.view?.setContentOffset(CGPoint(x: motion.view?.contentOffset.x ?? 0, y: motion.from + (motion.to - motion.from) * progress), animated: false)
        if progress >= 1 || motion.view == nil {
            self.motion = nil
            motion.done.resume()
        }
    }

    /// The kernel's high-water mark of the footprint, so a peak between two samples still counts.
    private func sampleFootprint() { peakFootprint = max(peakFootprint, Self.footprintMB(peak: true)) }

    private func write() {
        let object: [String: Any] = ["phase": phase, "chunks": chunks, "marks": marks, "phases": phases, "current": summary(),
                                     "peakFootprintMB": peakFootprint]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        let report = report
        writes.async { try? data.write(to: report, options: .atomic) }
    }

    /// One scroll the display link moves a frame at a time.
    private struct Motion {
        weak var view: UIScrollView?
        let from: CGFloat, to: CGFloat, seconds: Double
        let done: CheckedContinuation<Void, Never>
        var started: CFTimeInterval = 0
    }

    /// Frames the display drew while a phase lasted, and the hitches: a frame later than one and a half of the frame
    /// times the display link is running at (`targetTimestamp - timestamp`, not its fastest possible `duration`).
    /// It counts from when the phase began, not from its first frame, so a main thread blocked the moment a phase
    /// starts (opening the long thread does) is one long late frame rather than time nobody counted.
    private struct Frames {
        var count = 0, hitches = 0
        var first: CFTimeInterval, last: CFTimeInterval, lastHitch: CFTimeInterval = 0, hitchMs = 0.0, longestMs = 0.0
        init(from start: CFTimeInterval) { first = start; last = start }
        mutating func tick(_ link: CADisplayLink) {
            let now = link.timestamp
            let gap = now - last, expected = link.targetTimestamp - link.timestamp
            if gap > 0 {
                if expected > 0, gap > expected * 1.5 { hitches += 1; hitchMs += (gap - expected) * 1000; lastHitch = CACurrentMediaTime() }
                longestMs = max(longestMs, gap * 1000)
            }
            last = max(last, now); count += 1
        }
        func summary() -> [String: Double] {
            let seconds = max(0, last - first)
            return ["frames": Double(count), "seconds": seconds, "hitches": Double(hitches), "hitchMs": hitchMs,
                    "longestFrameMs": longestMs, "hitchMsPerSecond": seconds > 0 ? hitchMs / seconds : 0]
        }
    }

    /// The display link holds its target strongly; this holds the driver weakly.
    private final class FrameTarget: NSObject {
        weak var driver: BenchDriver?
        init(_ driver: BenchDriver) { self.driver = driver }
        @objc func tick(_ link: CADisplayLink) { MainActor.assumeIsolated { driver?.tick(link) } }
    }

    /// When this process started, from the kernel, so a launch counts from before `main`.
    nonisolated private static func processStart() -> Double {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0 else { return Date().timeIntervalSince1970 }
        let start = info.kp_proc.p_un.__p_starttime
        return Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
    }

    /// CPU time this process has used on every thread, in milliseconds.
    nonisolated private static func cpuMs() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let user = Double(usage.ru_utime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec) / 1000
        let system = Double(usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_stime.tv_usec) / 1000
        return user + system
    }

    /// The memory the system charges this app, as Xcode's memory gauge shows it, or the most it has charged so far.
    nonisolated private static func footprintMB(peak: Bool = false) -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(peak ? UInt64(info.ledger_phys_footprint_peak) : info.phys_footprint) / 1_048_576
    }
}
#endif
