import SwiftUI
import SottoCore
#if DEBUG && os(iOS)
import Darwin
import UIKit

/// The app's half of the iPhone benchmarks (`Scripts/bench.sh`, `docs/perf/2026-10-31-iphone-benchmarks.md`). It runs
/// only in the UI fixture with `--bench-threads`, and only when `SOTTO_BENCH_FILE` names its report.
///
/// With `--bench-journey all` the app walks the journey itself, so nothing outside it touches the screen: XCUITest
/// turns on and reads the whole accessibility tree, which on a long thread cost more than the thread did. The phases:
/// `launch` to the first frame showing every thread, `list-scroll` down the list and back, `open` the long thread as a
/// notification opens it, `thread-scroll` up through it and back, `stream` a reply into it, then `finished`. Each phase
/// lasts until the screen is quiet, and records its frames, hitches, CPU time, memory and what the probes counted.
/// With `--bench-journey launch` it stops after the first. With `--bench-journey look` it opens the long thread and
/// photographs the page at fixed distances above its end (`look`), so two builds can be held to the same look. It
/// reads and changes nothing the app shows.
@MainActor final class BenchDriver {
    private static var running: BenchDriver?

    static func start(model: AppModel, chunks: Int, journey: String, long: ThreadRef) {
        guard running == nil, let path = ProcessInfo.processInfo.environment["SOTTO_BENCH_FILE"], !path.isEmpty else { return }
        let driver = BenchDriver(model: model, report: URL(fileURLWithPath: path), chunks: chunks, long: long)
        running = driver
        driver.begin(journey: journey)
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
    private var sampler: BenchSampler?
    private let writes = DispatchQueue(label: "com.millzach.sotto.bench.report", qos: .utility)

    private init(model: AppModel, report: URL, chunks: Int, long: ThreadRef) {
        self.model = model; self.report = report; self.chunks = chunks; self.long = long
    }

    private func begin(journey: String) {
        BenchProbe.onBody = { name in MainActor.assumeIsolated { BenchDriver.running?.body(name) } }
        let link = CADisplayLink(target: FrameTarget(self), selector: #selector(FrameTarget.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in MainActor.assumeIsolated { BenchDriver.running?.write() } }
        mark("driver-start")
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--bench-sample"), arguments.indices.contains(index + 1) {
            sampler = BenchSampler(output: URL(fileURLWithPath: arguments[index + 1]))
            sampler?.start(phase: phase)
        }
        Task { await self.journey(journey) }
    }

    private func journey(_ kind: String) async {
        guard await until({ self.marks["first-list"] != nil }) else { return finish("no-list") }
        await quiet()
        if kind == "look" { return await look() }
        guard kind == "all" else { return finish(nil) }

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

        // Back to the list, as Back and a swipe back go: the Threads page comes into sight again under the thread and lets
        // go of the list it held while the reply streamed (`ThreadsView.held`). A journey that can't go back still counts
        // for the phases before; its `back` has no counts.
        next("back")
        if let navigation = Self.threadNavigation(), navigation.popViewController(animated: true) != nil {
            _ = await until({ self.pageInWindow && !self.pageHeld })
            await quiet()
        } else {
            phaseNotes["noBack"] = 1
        }
        finish(nil)
    }

    /// Opens the long thread and photographs the page at its end's distances: inside the latest turns, which are made at
    /// open, at their edge, and among the earlier turns, made as they scroll in. Its end is left out, as the working
    /// line there glows, and so is the bar. Each photo is the report's name and the distance (`look-1-1500.png`).
    private func look() async {
        next("open")
        model?.alertOpened = long
        guard await until({ self.marks["open-rendered"] != nil }) else { return finish("no-thread") }
        await quiet()
        next("look")
        for distance in [1_500, 5_000, 10_000] as [CGFloat] {
            guard let view = Self.pageScroller() else { return finish("no-page") }
            let bottom = view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom
            view.setContentOffset(CGPoint(x: view.contentOffset.x, y: max(-view.adjustedContentInset.top, bottom - distance)), animated: false)
            await quiet()
            try? await Task.sleep(nanoseconds: 500_000_000)
            snap("\(Int(distance))", page: view)
            // Back to the end, so each distance is reached from there as the one before it was.
            let end = view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom
            view.setContentOffset(CGPoint(x: view.contentOffset.x, y: end), animated: false)
            await quiet()
        }
        finish(nil)
    }

    /// The window as drawn below the bar, written beside the report. The bar is left out: its Working light breathes.
    private func snap(_ name: String, page: UIScrollView) {
        guard let window = page.window else { return }
        let top = page.convert(CGPoint(x: 0, y: page.bounds.minY + page.adjustedContentInset.top), to: window).y
        let area = CGRect(x: 0, y: top, width: window.bounds.width, height: window.bounds.height - top)
        let image = UIGraphicsImageRenderer(bounds: area).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let file = URL(fileURLWithPath: report.deletingPathExtension().path + "-" + name + ".png")
        try? image.pngData()?.write(to: file, options: .atomic)
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
        sampler?.phase(name)
        mark("phase-" + name)
        write()
    }

    /// Ends the journey: `finished`, or `failed-<why>` when a phase never got what it waited for, which the script
    /// counts as a failed run and the summary leaves out.
    private func finish(_ failure: String?) {
        // The samples are written before the report says `finished`, which the script waits for.
        sampler?.finish()
        sampler = nil
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

    /// The navigation stack with a thread open on it.
    private static func threadNavigation() -> UINavigationController? {
        func visit(_ controller: UIViewController) -> UINavigationController? {
            if let navigation = controller as? UINavigationController, navigation.viewControllers.count > 1 { return navigation }
            for child in controller.children { if let found = visit(child) { return found } }
            return controller.presentedViewController.flatMap(visit)
        }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        return windows.lazy.compactMap { $0.rootViewController.flatMap(visit) }.first
    }

    // The Threads page's hold (`ThreadsView.held`). The page is in the window while any of it can show: from the start of
    // a push over it to that push's end, and again from the start of a pop. Each turn of the main run loop that ends with
    // the page in the window and drawn from its held list, after Core Animation's commit, counts as `page.stale_frames`:
    // a frame that could have shown an old row. A hold taken while the page is still in the window counts as
    // `page.held_in_window`.
    private var pageHeld = false
    private var pageInWindow = false
    private var staleWatch: CFRunLoopObserver?

    static func pageDrawn(held: Bool) { running?.pageHeld = held }
    static func pageHolding() {
        guard let running else { return }
        BenchProbe.count("page.holds")
        if running.pageInWindow { BenchProbe.count("page.held_in_window") }
    }
    static func pageWindow(_ inWindow: Bool) { running?.pageMoved(inWindow) }
    private func pageMoved(_ inWindow: Bool) {
        pageInWindow = inWindow
        guard inWindow, staleWatch == nil else { return }
        BenchProbe.count("page.shown")
        // Core Animation commits the frame before the run loop waits, at order 2,000,000; this runs after it.
        let observer = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, CFIndex.max) { _, _ in
            MainActor.assumeIsolated { BenchDriver.running?.checkPage() }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        staleWatch = observer
    }
    private func checkPage() {
        if pageInWindow && pageHeld { BenchProbe.count("page.stale_frames"); return }
        if let staleWatch { CFRunLoopRemoveObserver(CFRunLoopGetMain(), staleWatch, .commonModes) }
        staleWatch = nil
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
        let previous = frames.last
        frames.tick(link)
        if link.timestamp - previous > BenchSampler.longFrame { sampler?.longFrame(from: previous, to: link.timestamp) }
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

/// Where the main thread spends each phase of the benchmarks' traced journey (`--bench-sample <file>`, Scripts/bench.sh
/// with BENCH_TRACE=1), for when Instruments cannot record the simulator, as on GitHub's runners. About once a
/// millisecond a background thread suspends the main thread, reads its registers and walks its frame pointers, and
/// resumes it; nothing is allocated while it is suspended, as the main thread may hold the allocator's lock. Each
/// distinct stack is counted under the phase it fell in. At the end it writes the stacks and, for every address in
/// them, the image it lies in and its load address, which `Scripts/bench-sample.py` turns into function names. Each
/// sample's time is kept too, so the frames longer than `longFrame` are written with the stacks sampled while they lasted.
/// It slows the app it samples, so the traced journey's own numbers are not summarized.
final class BenchSampler: @unchecked Sendable {
    private static let depth = 512
    private let output: URL
    /// The main thread, read on the main thread.
    private let target = mach_thread_self()
    private let frames = UnsafeMutablePointer<UInt>.allocate(capacity: BenchSampler.depth)
    private let lock = NSLock()
    private var current = ""
    private var stopping = false
    private var stacks: [String: [[UInt]: Int]] = [:]
    private var order: [String] = []
    private let stopped = DispatchSemaphore(value: 0)
    /// A frame longer than this is kept with the samples taken while it lasted.
    static let longFrame: CFTimeInterval = 0.05
    /// Each sample's time, phase and stack, so the samples inside a long frame can be found again.
    private var timeline: [(time: CFTimeInterval, phase: String, stack: Int)] = []
    private var stackIDs: [[UInt]: Int] = [:]
    private var stackList: [[UInt]] = []
    private var long: [(phase: String, start: CFTimeInterval, end: CFTimeInterval)] = []

    init(output: URL) { self.output = output }

    func start(phase: String) {
        self.phase(phase)
        let thread = Thread { [self] in run() }
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    func phase(_ name: String) {
        lock.lock(); defer { lock.unlock() }
        current = name
        if !order.contains(name) { order.append(name) }
    }

    /// A frame the display link saw come late by more than `longFrame`, in `CACurrentMediaTime`'s clock.
    func longFrame(from start: CFTimeInterval, to end: CFTimeInterval) {
        lock.lock(); defer { lock.unlock() }
        long.append((current, start, end))
    }

    /// Stops sampling and writes what it found. Called on the main thread at the journey's end.
    func finish() {
        lock.lock(); stopping = true; lock.unlock()
        stopped.wait()
        var table: [UInt: Int] = [:]
        var addresses: [[String: Any]] = []
        /// A stack as indexes into `addresses`, each address described once.
        func indexed(_ stack: [UInt]) -> [Int] {
            stack.map { address in
                if let index = table[address] { return index }
                table[address] = addresses.count
                addresses.append(Self.describe(address))
                return addresses.count - 1
            }
        }
        var phases: [[String: Any]] = []
        for name in order {
            guard let counted = stacks[name] else { continue }
            var rows: [[Any]] = []
            var samples = 0
            for (stack, count) in counted {
                samples += count
                rows.append([count, indexed(stack)])
            }
            phases.append(["phase": name, "samples": samples, "stacks": rows])
        }
        // The longest frames of each phase, with the stacks sampled while each lasted.
        var longFrames: [[String: Any]] = []
        for name in order {
            for frame in long.filter({ $0.phase == name }).sorted(by: { $0.end - $0.start > $1.end - $1.start }).prefix(60) {
                var counted: [Int: Int] = [:]
                for sample in timeline where sample.time > frame.start && sample.time <= frame.end { counted[sample.stack, default: 0] += 1 }
                let rows: [[Any]] = counted.map { id, count in [count, indexed(stackList[id])] }
                longFrames.append(["phase": name, "ms": (frame.end - frame.start) * 1000, "stacks": rows])
            }
        }
        let object: [String: Any] = ["phases": phases, "longFrames": longFrames, "addresses": addresses]
        if let data = try? JSONSerialization.data(withJSONObject: object) { try? data.write(to: output, options: .atomic) }
    }

    private func run() {
        while true {
            lock.lock()
            let done = stopping
            let name = current
            lock.unlock()
            if done { break }
            usleep(1_000)
            let time = CACurrentMediaTime()
            let count = capture()
            guard count > 0 else { continue }
            let stack = Array(UnsafeBufferPointer(start: frames, count: count))
            lock.lock()
            stacks[name, default: [:]][stack, default: 0] += 1
            let id: Int
            if let known = stackIDs[stack] { id = known } else { id = stackList.count; stackIDs[stack] = id; stackList.append(stack) }
            timeline.append((time, name, id))
            lock.unlock()
        }
        stopped.signal()
    }

    /// One sample of the main thread's stack into `frames`, leaf first: the program counter, then each return address
    /// less one, so it falls inside the call. Returns how many it read.
    private func capture() -> Int {
        #if arch(arm64)
        guard thread_suspend(target) == KERN_SUCCESS else { return 0 }
        defer { thread_resume(target) }
        var state = arm_thread_state64_t()
        var count = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &state) {
            $0.withMemoryRebound(to: natural_t.self, capacity: Int(count)) {
                thread_get_state(target, thread_state_flavor_t(ARM_THREAD_STATE64), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        frames[0] = UInt(state.__pc)
        var read = 1
        if state.__lr > 1 { frames[1] = UInt(state.__lr) - 1; read = 2 }
        var frame = UInt(state.__fp)
        var pair: (UInt, UInt) = (0, 0)
        while frame != 0, frame % 8 == 0, read < Self.depth {
            var size: vm_size_t = 0
            let copied = withUnsafeMutablePointer(to: &pair) {
                vm_read_overwrite(mach_task_self_, vm_address_t(frame), vm_size_t(16), vm_address_t(UInt(bitPattern: $0)), &size)
            }
            guard copied == KERN_SUCCESS, pair.1 > 1 else { break }
            // The saved link register usually repeats the one already read for the leaf's caller.
            if !(read == 2 && frames[1] == pair.1 - 1) { frames[read] = pair.1 - 1; read += 1 }
            guard pair.0 > frame else { break }
            frame = pair.0
        }
        return read
        #else
        return 0
        #endif
    }

    /// The image an address lies in, its load address, and the nearest exported symbol, for when `atos` has none.
    private static func describe(_ address: UInt) -> [String: Any] {
        var info = Dl_info()
        guard dladdr(UnsafeRawPointer(bitPattern: address), &info) != 0 else { return ["address": String(address, radix: 16)] }
        var result: [String: Any] = ["address": String(address, radix: 16)]
        if let image = info.dli_fname { result["image"] = String(cString: image) }
        if let base = info.dli_fbase { result["base"] = String(UInt(bitPattern: base), radix: 16) }
        if let symbol = info.dli_sname { result["symbol"] = String(cString: symbol) }
        return result
    }
}
#endif

extension View {
    /// Counts, for the benchmarks, each change to the environment that reaches this view, as the body `Environment<name>`:
    /// any value set anywhere above it, made anew on a redraw rather than kept, has every text below it checked again.
    /// Outside a benchmark run it adds nothing; in a build without `DEBUG` it is not there.
    func benchEnvironment(_ name: StaticString) -> some View {
        #if DEBUG && os(iOS)
        background { if BenchProbe.enabled { EnvironmentProbe(name: name) } }
        #else
        self
        #endif
    }
}

#if DEBUG && os(iOS)
/// Reads the whole environment, so SwiftUI runs its body again whenever any value in it changes, and counts each run.
private struct EnvironmentProbe: View {
    let name: StaticString
    @Environment(\.self) private var environment
    var body: some View {
        let _ = BenchProbe.body(name)
        Color.clear.accessibilityHidden(true)
    }
}
#endif

/// The Threads page's hold (`ThreadsView.held`), told to the benchmarks. Outside a benchmark run each does nothing; in a
/// build without `DEBUG` each is empty.
enum BenchPage {
    /// The page drew, from its held list or the model's.
    @MainActor static func drawn(held: Bool) {
        #if DEBUG && os(iOS)
        BenchDriver.pageDrawn(held: held)
        #endif
    }
    /// The page is about to hold its list.
    @MainActor static func holding() {
        #if DEBUG && os(iOS)
        BenchDriver.pageHolding()
        #endif
    }
}

extension View {
    /// Tells the benchmarks when this page enters and leaves the window. Outside a benchmark run it adds nothing; in a
    /// build without `DEBUG` it is not there.
    func benchPageWindow() -> some View {
        #if DEBUG && os(iOS)
        background { if BenchProbe.enabled { PageWindowProbe() } }
        #else
        self
        #endif
    }
}

#if DEBUG && os(iOS)
private struct PageWindowProbe: UIViewRepresentable {
    func makeUIView(context: Context) -> WindowWatcher {
        let view = WindowWatcher()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }
    func updateUIView(_ view: WindowWatcher, context: Context) {}
    final class WindowWatcher: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            BenchDriver.pageWindow(window != nil)
        }
    }
}
#endif
