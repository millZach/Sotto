import XCTest

/// The iPhone benchmarks' launch (`docs/perf/2026-10-31-iphone-benchmarks.md`). It runs only from `Scripts/bench.sh`,
/// which builds the app optimized and names a folder for the reports in `SOTTO_BENCH_OUT`; the journeys' run skips it.
///
/// Only the launch is measured here, by XCTest's own launch metric. The rest of the benchmark journey (scrolling,
/// opening the long thread, streaming) runs without XCUITest: the script launches the app with `simctl` and the app
/// walks the journey itself (`Bench.swift`), because XCUITest turns on and reads the accessibility tree, which on a
/// long thread cost more than the thread did.
@MainActor final class PerformanceJourneyTests: XCTestCase {
    static let threads = 300, turns = 200
    private var out: URL!
    private var launches = 0

    override func setUpWithError() throws {
        guard let folder = ProcessInfo.processInfo.environment["SOTTO_BENCH_OUT"], !folder.isEmpty else {
            throw XCTSkip("The benchmarks run from Scripts/bench.sh")
        }
        out = URL(fileURLWithPath: folder)
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
    }

    /// Cold launch to the thread list holding every thread. XCTest times the launch to the first responsive frame;
    /// the app marks the first frame that shows the whole list, counted from the process's start.
    func testLaunchToThreadList() throws {
        let app = XCUIApplication()
        let options = XCTMeasureOptions(); options.iterationCount = 5
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)], options: options) {
            if app.state != .notRunning && app.state != .unknown { app.terminate() }
            self.launches += 1
            let report = self.out.appendingPathComponent("launch-\(self.launches).json")
            try? FileManager.default.removeItem(at: report)
            app.launchArguments = ["--ui-fixture", "--reset-ui-preferences", "--bench-threads", "\(Self.threads)", "--bench-turns", "\(Self.turns)",
                                   "--bench-journey", "launch", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
            app.launchEnvironment["SOTTO_BENCH_FILE"] = report.path
            app.launch()
            XCTAssertTrue(self.waitForPhase("finished", in: report), "The thread list must be drawn")
            app.terminate()
        }
    }

    /// Waits for the app's report to reach `phase`, reading the file the app writes.
    private func waitForPhase(_ phase: String, in report: URL, timeout: TimeInterval = 60) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let data = try? Data(contentsOf: report),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               object["phase"] as? String == phase { return true }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return false
    }
}
