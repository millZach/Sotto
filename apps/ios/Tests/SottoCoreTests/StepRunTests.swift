import XCTest
@testable import SottoCore

/// A run of steps folded into one line: what the working line says, and the finished line's count and time.
final class StepRunTests: XCTestCase {
    private func step(_ id: String, kind: String = "command", status: String = "completed", title: String = "Command",
                      command: String? = nil, at time: String? = nil, ms: Double? = nil, changes: [String] = []) throws -> Activity {
        var fields: [String: Any] = ["id": id, "sequence": 1, "kind": kind, "status": status, "title": title]
        if let command { fields["command"] = command }
        if let time { fields["startedAt"] = "2026-10-05T10:" + time + "Z" }
        if let ms { fields["durationMs"] = ms }
        if !changes.isEmpty { fields["changes"] = changes.map { ["path": $0, "kind": "update"] } }
        let data = try JSONSerialization.data(withJSONObject: fields)
        return try JSONDecoder().decode(Activity.self, from: data)
    }

    // MARK: The finished line

    func testCountsReadInTheSingularAndThePlural() {
        XCTAssertEqual(StepRun.count(1), "1 step")
        XCTAssertEqual(StepRun.count(2), "2 steps")
        XCTAssertEqual(StepRun.count(14), "14 steps")
    }

    func testSummaryReadsTheCountAndHowLong() {
        XCTAssertEqual(StepRun.summary(count: 14, seconds: 92), "14 steps · 1m 32s")
        XCTAssertEqual(StepRun.summary(count: 1, seconds: 4), "1 step · 4s")
        XCTAssertEqual(StepRun.summary(count: 3, seconds: nil), "3 steps")
        XCTAssertEqual(StepRun.spokenSummary(count: 14, seconds: 92), "14 steps, 1 minute 32 seconds")
        XCTAssertEqual(StepRun.spokenSummary(count: 1, seconds: 1), "1 step, 1 second")
        XCTAssertEqual(StepRun.spokenSummary(count: 2, seconds: nil), "2 steps")
    }

    func testDurationsReadInSecondsMinutesAndHours() {
        XCTAssertEqual(StepRun.duration(4), "4s")
        XCTAssertEqual(StepRun.duration(0.4), "1s", "Under a second reads as one")
        XCTAssertEqual(StepRun.duration(59.4), "59s")
        XCTAssertEqual(StepRun.duration(60), "1m 00s")
        XCTAssertEqual(StepRun.duration(67), "1m 07s")
        XCTAssertEqual(StepRun.duration(92), "1m 32s")
        XCTAssertEqual(StepRun.duration(3780), "1h 03m")
        XCTAssertEqual(StepRun.spokenDuration(4), "4 seconds")
        XCTAssertEqual(StepRun.spokenDuration(60), "1 minute")
        XCTAssertEqual(StepRun.spokenDuration(121), "2 minutes 1 second")
        XCTAssertEqual(StepRun.spokenDuration(3600), "1 hour")
        XCTAssertEqual(StepRun.spokenDuration(3780), "1 hour 3 minutes")
    }

    func testARunLastsFromItsFirstStartToTheEndOfItsLastStep() throws {
        let steps = [try step("think", kind: "reasoning", at: "00:00", ms: 5_000),
                     try step("read", kind: "tool", at: "00:10", ms: 400),
                     try step("test", at: "01:28", ms: 4_000)]
        XCTAssertEqual(StepRun.seconds(steps), 92)
        XCTAssertEqual(StepRun.summary(count: steps.count, seconds: StepRun.seconds(steps)), "3 steps · 1m 32s")
    }

    func testAStepThatEndsLateCountsEvenWhenItIsNotTheLast() throws {
        let steps = [try step("build", at: "00:00", ms: 120_000), try step("lint", at: "00:30", ms: 5_000)]
        XCTAssertEqual(StepRun.seconds(steps), 120)
    }

    func testOneTimedStepTakesItsOwnDuration() throws {
        XCTAssertEqual(StepRun.seconds([try step("test", at: "00:00", ms: 4_000)]), 4)
    }

    func testWithoutTimesARunAddsUpItsDurations() throws {
        let steps = [try step("one", ms: 3_000), try step("two", ms: 2_000), try step("three")]
        XCTAssertEqual(StepRun.seconds(steps), 5)
        XCTAssertEqual(StepRun.summary(count: steps.count, seconds: StepRun.seconds(steps)), "3 steps · 5s")
    }

    func testWithNothingToSayHowLongARunReadsItsCountAlone() throws {
        let untimed = [try step("one"), try step("two")]
        XCTAssertNil(StepRun.seconds(untimed))
        XCTAssertEqual(StepRun.summary(count: untimed.count, seconds: StepRun.seconds(untimed)), "2 steps")
        let started = [try step("only", at: "00:00")]
        XCTAssertNil(StepRun.seconds(started), "A start alone says nothing about how long")
    }

    // MARK: The working line

    func testTheWorkingLineShowsTheLatestRunningStep() throws {
        let steps = [try step("first", status: "running"), try step("done"), try step("now", status: "running"), try step("after")]
        XCTAssertEqual(StepRun.running(steps)?.id, "now")
        XCTAssertNil(StepRun.running([try step("done")]))
    }

    func testTheRunningStepReadsAsAVerbAndWhatItWorksOn() throws {
        let command = try step("test", status: "running",
                               command: #""C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'npm test'"#)
        XCTAssertEqual(StepRun.live(command), StepRun.Live(verb: "Running", subject: "npm test"))
        XCTAssertEqual(StepRun.live(command).words, "Running npm test")
        let edit = try step("edit", kind: "file-change", status: "running", title: "File changes",
                            changes: ["src/renderer/src/agents/TerminalDrawer.tsx", "src/renderer/src/agents/terminalStore.ts"])
        XCTAssertEqual(StepRun.live(edit), StepRun.Live(verb: "Editing", subject: "TerminalDrawer.tsx and 1 more"))
        let think = try step("think", kind: "reasoning", status: "running", title: "Reasoning summary")
        XCTAssertEqual(StepRun.live(think).words, "Thinking")
        let read = try step("read", kind: "tool", status: "running", title: "Read", changes: [#"D:\Sotto\README.md"#])
        XCTAssertEqual(StepRun.live(read).words, "Read README.md")
        let search = try step("search", kind: "tool", status: "running", title: "Web search")
        XCTAssertEqual(StepRun.live(search), StepRun.Live(verb: "Web search", subject: nil))
    }

    func testTheWorkingLineSaysWhatItIsDoingAndHowManyStepsSoFar() throws {
        let live = StepRun.Live(verb: "Running", subject: "npm test")
        XCTAssertEqual(StepRun.spokenWorking(live, count: 12), "Working: Running npm test, 12 steps so far")
        XCTAssertEqual(StepRun.spokenWorking(live, count: 1), "Working: Running npm test, 1 step so far")
        XCTAssertEqual(StepRun.spokenWorking(nil, count: 3), "Working, 3 steps so far")
        XCTAssertEqual(StepRun.press(count: 14, open: false), "Show 14 steps")
        XCTAssertEqual(StepRun.press(count: 1, open: false), "Show 1 step")
        XCTAssertEqual(StepRun.press(count: 14, open: true), "Hide steps")
    }

    // MARK: Commands without their shell

    func testAShellWrapperIsLeftOutOfTheCommand() {
        XCTAssertEqual(StepRun.innerCommand(#""C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'git status --short'"#),
                       "git status --short")
        XCTAssertEqual(StepRun.innerCommand(#""C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "npm run lint""#),
                       "npm run lint")
        XCTAssertEqual(StepRun.innerCommand("powershell.exe -NoLogo -ExecutionPolicy Bypass -Command 'npm test'"), "npm test")
        XCTAssertEqual(StepRun.innerCommand("pwsh -c npm run typecheck"), "npm run typecheck")
        XCTAssertEqual(StepRun.innerCommand(#"C:\Windows\system32\cmd.exe /d /s /c "npm run build""#), "npm run build")
        XCTAssertEqual(StepRun.innerCommand("cmd /C dir"), "dir")
        XCTAssertEqual(StepRun.innerCommand("/bin/bash -lc 'ls -la src'"), "ls -la src")
        XCTAssertEqual(StepRun.innerCommand("bash -c \"make test\""), "make test")
    }

    func testPowerShellsDoubledQuotesReadAsOne() {
        XCTAssertEqual(StepRun.innerCommand(#"powershell.exe -Command 'rg -n ''Ctrl+`'' src'"#), "rg -n 'Ctrl+`' src")
    }

    func testACommandWithoutAWrapperStaysAsItWas() {
        XCTAssertEqual(StepRun.innerCommand("npm test -- tests/unit/renderer/terminalDrawer.test.ts"),
                       "npm test -- tests/unit/renderer/terminalDrawer.test.ts")
        XCTAssertEqual(StepRun.innerCommand("  git diff main --stat \n"), "git diff main --stat")
        XCTAssertEqual(StepRun.innerCommand("powershell -File build.ps1"), "powershell -File build.ps1",
                       "A shell running a script file keeps its words")
        XCTAssertEqual(StepRun.innerCommand("powershell -Command ''"), "powershell -Command ''",
                       "An empty command keeps the words it came with")
        XCTAssertEqual(StepRun.innerCommand(#""C:\unclosed\powershell.exe -Command 'x'"#), #""C:\unclosed\powershell.exe -Command 'x'"#)
        XCTAssertEqual(StepRun.innerCommand(""), "")
    }
}
