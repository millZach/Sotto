import Foundation

/// The frames a computer would send in the iPhone benchmarks, built as wire bytes so the phone reads them the way it
/// reads a socket's (`docs/perf/2026-10-31-iphone-benchmarks.md`). Used only by the benchmark fixture and the core
/// benchmarks' tests; nothing in the app's own paths calls it. The same inputs give the same bytes, so the benchmark
/// on `main` and on a branch read the same data.
public enum BenchWire {
    /// The open thread every scenario uses: the newest thread on the list, still working.
    public static let longThreadID = "bench-long"
    /// The reply that grows while it streams, the last message of the long thread.
    public static let streamingMessageID = "bench-reply-stream"

    /// `count` thread records as the host sends them (`ThreadSummary`), the long thread first, newest first, each
    /// about the size a working computer's records are (#1910 measured 820 bytes on average).
    public static func threadRecords(count: Int, hostID: String, now: Date) -> [String] {
        var records = [longThreadRecord(hostID: hostID, now: now)]
        for index in 1..<max(1, count) {
            records.append(record(id: "bench-\(index)", index: index, hostID: hostID, now: now, running: index % 40 == 0, title: titles[index % titles.count] + " \(index)"))
        }
        return records
    }

    /// The long thread's record, sent again whenever it changes while it works.
    public static func longThreadRecord(hostID: String, now: Date) -> String {
        record(id: longThreadID, index: 0, hostID: hostID, now: now, running: true, title: "Compare motor drive options for the new panel")
    }
    /// The sequence the long thread's running step has; the steps a stream starts follow it.
    public static func streamStepSequence(turns: Int, stepsPerTurn: Int = 4) -> Int { turns * stepsPerTurn + 1 }

    /// A shell push whose thread records travel beside its state, as a host that offers `changed-thread-records` sends
    /// them. `state` is the push's state as JSON with an empty `host.threads`; `base` nil lists every record.
    public static func shellFrame(state: Data, revision: Int, base: Int?, changed: [String], order: [String]? = nil) -> Data {
        var text = #"{"v":1,"event":"shell","state":"#
        text += String(decoding: state, as: UTF8.self)
        text += #","threads":{"revision":\#(revision),"base":\#(base.map(String.init) ?? "null"),"changed":["#
        text += changed.joined(separator: ",") + "]"
        if let order { text += #","order":["# + order.map(quoted).joined(separator: ",") + "]" }
        text += "}}"
        return Data(text.utf8)
    }

    /// The long thread as a `detail` push: `turns` turns, each the user's ask, `stepsPerTurn` steps of the agent's
    /// work and a Markdown reply, then the reply that streams, which starts short.
    public static func longDetailFrame(turns: Int, stepsPerTurn: Int = 4, now: Date) -> Data {
        var messages: [String] = [], steps: [String] = []
        messages.reserveCapacity(turns * 2 + 2); steps.reserveCapacity(turns * stepsPerTurn + 1)
        var sequence = 0
        for turn in 0..<turns {
            let base = Double(turns - turn) * 600 + 300
            messages.append(message(id: "bench-ask-\(turn)", role: "user", text: ask(turn), at: stamp(now, base)))
            for step in 0..<stepsPerTurn {
                sequence += 1
                steps.append(activity(turn: turn, step: step, sequence: sequence, at: stamp(now, base - 30 - Double(step) * 20)))
            }
            messages.append(message(id: "bench-reply-\(turn)", role: "assistant", text: reply(turn), at: stamp(now, base - 200)))
        }
        messages.append(message(id: "bench-ask-stream", role: "user", text: "Now write up the panel change for the drawings.", at: stamp(now, 120)))
        sequence += 1
        steps.append(#"{"id":"bench-step-stream","sequence":\#(sequence),"kind":"command","status":"running","title":"Running","command":"python drawings.py --update","startedAt":"\#(stamp(now, 90))"}"#)
        messages.append(message(id: streamingMessageID, role: "assistant", text: "Writing it up.", at: stamp(now, 60)))
        let detail = #"{"threadId":"\#(longThreadID)","revision":1,"earlierAvailable":false,"messages":[\#(messages.joined(separator: ","))],"activities":[\#(steps.joined(separator: ","))]}"#
        return Data(#"{"v":1,"event":"detail","threadId":"\#(longThreadID)","detail":\#(detail)}"#.utf8)
    }

    /// One streamed word for the growing reply, as a `detail-delta` push; every `stepEvery`th chunk also finishes the
    /// running step and starts another, as an agent's work goes on between words.
    public static func deltaFrame(chunk: Int, revision: Int, stepEvery: Int = 20, firstSequence: Int, now: Date) -> Data {
        let word = words[chunk % words.count] + (chunk % 12 == 11 ? ".\\n\\n" : " ")
        var activities = ""
        if chunk > 0, chunk % stepEvery == 0 {
            // The step running since the last one finishes, and the next starts after it.
            let next = chunk / stepEvery
            let id = next == 1 ? "bench-step-stream" : "bench-step-stream-\(next - 1)"
            let finished = #"{"record":{"id":"\#(id)","sequence":\#(firstSequence + next - 1),"kind":"command","status":"completed","title":"Ran","command":"python drawings.py --sheet \#(next)","exitCode":0,"durationMs":1800,"startedAt":"\#(stamp(now, 50))"}}"#
            let started = #"{"record":{"id":"bench-step-stream-\#(next)","sequence":\#(firstSequence + next),"kind":"command","status":"running","title":"Running","command":"python drawings.py --sheet \#(next + 1)","startedAt":"\#(stamp(now, 40))"}}"#
            activities = finished + "," + started
        }
        let delta = #"{"threadId":"\#(longThreadID)","baseRevision":\#(revision),"revision":\#(revision + 1),"messageDeltas":[{"id":"\#(streamingMessageID)","appendText":"\#(word)"}],"activityDeltas":[\#(activities)]}"#
        return Data(#"{"v":1,"event":"detail-delta","threadId":"\#(longThreadID)","delta":\#(delta)}"#.utf8)
    }

    // MARK: Building blocks

    public static func record(id: String, index: Int, hostID: String, now: Date, running: Bool, title: String) -> String {
        let projects = ["sotto", "panel", "house"]
        let last = stamp(now, Double(index) * 420 + 30)
        var summary = #""lastMessageAt":"\#(last)","messageCount":\#(40 + index % 160)"#
        if running { summary += #","runningTurnStartedAt":"\#(stamp(now, Double(index) * 420 + 600))""# }
        var text = #"{"id":"\#(id)","hostId":"\#(hostID)","projectId":"\#(projects[index % 3])","title":\#(quoted(title)),"#
        text += #""providerId":"\#(index % 3 == 0 ? "claude" : "codex")","modelId":"fixture-model","status":"\#(running ? "running" : "idle")","#
        text += #""requests":[],"reasoningEffort":"high","runtimeMode":"approval-required","titleSource":"generated","earlierAvailable":true,"#
        text += #""summary":{\#(summary)},"manualCompactionSupported":true,"nativeSessionStarted":true,"remoteHost":true,"clientConnected":true,"#
        // Fields a host sends that this phone doesn't read, which it still reads past.
        text += #""subagentSummary":{"total":0,"working":0,"completed":0,"failed":0,"interrupted":0,"unknown":0},"#
        text += #""usage":{"latest":{"input":1200,"output":560,"cached":820},"total":{"input":\#(19340 + index),"output":5250,"cached":12030},"contextUsed":2200,"contextWindow":200000,"elapsedMs":9800,"estimatedUsd":0.12,"partial":false,"updatedAt":"\#(last)"}"#
        if index % 2 == 0 {
            let branch = "feat/bench-\(index)-" + title.lowercased().split(separator: " ").prefix(4).joined(separator: "-")
            text += #","worktree":{"mode":"independent","branch":"\#(branch)","git":{"branch":"\#(branch)","changedFiles":\#(index % 9),"insertions":\#(index * 3 % 400),"deletions":\#(index % 70),"ahead":\#(index % 5),"behind":0,"dirty":\#(index % 4 == 0)}}"#
        }
        if !running && index % 5 == 4 { text += #","settledAt":"\#(last)""# }
        if index % 7 == 3 { text += #","finishedUnread":true"# }
        return text + "}"
    }
    private static func message(id: String, role: String, text: String, at: String) -> String {
        #"{"id":"\#(id)","role":"\#(role)","text":\#(quoted(text)),"createdAt":"\#(at)"}"#
    }
    private static func activity(turn: Int, step: Int, sequence: Int, at: String) -> String {
        let head = #"{"id":"bench-step-\#(turn)-\#(step)","sequence":\#(sequence),"status":"completed","startedAt":"\#(at)","#
        switch step % 4 {
        case 0: return head + #""kind":"reasoning","title":"Thought for \#(4 + turn % 20)s"}"#
        case 1: return head + #""kind":"tool","title":"Read","changes":[{"path":"drives/option_\#(turn + 1).md","kind":"read"}]}"#
        case 2: return head + #""kind":"command","title":"Ran","command":"python compare_drives.py --option \#(turn + 1)","exitCode":0,"durationMs":\#(1000 + turn * 37 % 9000)}"#
        default: return head + #""kind":"file-change","title":"Edited","changes":[{"path":"drives/summary.md","kind":"update"},{"path":"drives/option_\#(turn + 1).md","kind":"update"}]}"#
        }
    }
    private static func ask(_ turn: Int) -> String {
        "Compare drive option \(turn + 1) with the last one, and say what changes for the panel, the breaker and the conduit."
    }
    /// A reply in the shapes agents write: a bold lead and bullets, steps and a code block, a table, or a short answer.
    private static func reply(_ turn: Int) -> String {
        switch turn % 4 {
        case 0:
            let bullets = (0..<(3 + turn % 3)).map { "- **Point \($0 + 1):** the drive's rated current, its cooling and the cable run all change, so the breaker and the conduit fill need checking again." }
            return "**Option \(turn + 1) against the last one.**\n" + bullets.joined(separator: "\n")
                + "\n\n1. Check the breaker.\n2. Check the conduit fill.\n\n```sh\npython compare_drives.py --option \(turn + 1) --report\n```"
        case 1:
            return "Option \(turn + 1) runs cooler. The `rated_current` drops to \(12 + turn % 9) A, so the existing breaker holds, and the cable run stays inside the tray. See [the drive sheet](https://example.invalid/drives/\(turn + 1)) for the derating curve.\n\nThe only change on the panel is the fan: it moves from the door to the side wall, which frees the space the terminal strip needs."
        case 2:
            return "| Drive | Current | Breaker | Conduit |\n| --- | ---: | --- | --- |\n| Option \(turn) | \(14 + turn % 7) A | 20 A | 3/4 in |\n| Option \(turn + 1) | \(12 + turn % 9) A | 20 A | 3/4 in |\n| Spare | 10 A | 15 A | 1/2 in |\n\nBoth fit. Option \(turn + 1) leaves more headroom."
        default:
            return "Done: option \(turn + 1) is in the comparison sheet."
        }
    }
    private static let titles = ["Update the lighting plan", "Clean up the wiring schedule", "Fix the login test", "Simplify the settings screen",
                                 "Organize the panel notes", "Write the release notes", "Check the conduit fill", "Refine the iPhone thread view",
                                 "Add keyboard shortcuts", "Review the breaker sizes", "Babysit the pull request", "Draft the commissioning plan"]
    private static let words = "The new drive moves the fan to the side wall so the terminal strip fits and the breaker stays at twenty amps while the conduit fill drops under forty percent".split(separator: " ").map(String.init)
    public static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    public static func stamp(_ now: Date, _ secondsAgo: Double) -> String { formatter.string(from: now.addingTimeInterval(-secondsAgo)) }
}
