import Foundation

/// The frames a computer would send in the iPhone benchmarks, built as wire bytes so the phone reads them the way it
/// reads a socket's (`docs/perf/2026-10-31-iphone-benchmarks.md`). Used by the benchmark fixture and the core
/// benchmarks' tests, and once in the app's own paths: the thread page's warm-up after launch reads a short
/// `longDetailFrame`, laid out hidden and never shown or sent. The same inputs give the same bytes, so the benchmark on
/// `main` and on a branch read the same data.
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
            records.append(record(id: "bench-\(index)", index: index, hostID: hostID, now: now, running: startsWorking(index), title: threadTitle(index)))
        }
        return records
    }
    /// The records of every thread `threadRecords` lists as working but the long one, settled: one list push of these
    /// leaves the long thread the only one working (`idle-list`, #2400). Given the list's `now`, nothing else in them changes.
    public static func othersSettled(count: Int, hostID: String, now: Date) -> [String] {
        (1..<max(1, count)).filter(startsWorking).map { record(id: "bench-\($0)", index: $0, hostID: hostID, now: now, running: false, title: threadTitle($0)) }
    }
    private static func startsWorking(_ index: Int) -> Bool { index % 40 == 0 }
    private static func threadTitle(_ index: Int) -> String { titles[index % titles.count] + " \(index)" }

    /// The long thread's record, sent again whenever it changes while it works, and settled once its turn ends.
    public static func longThreadRecord(hostID: String, now: Date, running: Bool = true) -> String {
        record(id: longThreadID, index: 0, hostID: hostID, now: now, running: running, title: "Compare motor drive options for the new panel")
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

    /// The long thread's turn ending, as a host sends it: a `detail-delta` that finishes `steps`, the ones still running.
    /// The list push that goes with it carries `longThreadRecord(hostID:now:running: false)` (`idle-thread`, #2400).
    public static func endTurnFrame(finishing steps: [Activity], revision: Int, now: Date) -> Data {
        let finished = steps.map { step -> String in
            var text = #"{"record":{"id":\#(quoted(step.id)),"sequence":\#(step.sequence),"kind":\#(quoted(step.kind)),"status":"completed","title":"Ran","#
            if let command = step.command { text += #""command":\#(quoted(command)),"# }
            return text + #""exitCode":0,"durationMs":1800,"startedAt":\#(quoted(step.startedAt ?? stamp(now, 50)))}}"#
        }
        let delta = #"{"threadId":"\#(longThreadID)","baseRevision":\#(revision),"revision":\#(revision + 1),"messageDeltas":[],"activityDeltas":["#
            + finished.joined(separator: ",") + "]}"
        return Data(#"{"v":1,"event":"detail-delta","threadId":"\#(longThreadID)","delta":\#(delta)}"#.utf8)
    }

    // MARK: What a running host sends whole

    /// What a running host sends a phone beside the records that changed, by name, with the bytes of each that forge's
    /// host sent on November 10, 2026, as `JSON.stringify` counts them (`docs/perf/2026-11-10-performance-and-data-audit.md`,
    /// finding 2): the parts the phone reads. The five it never read went to no phone after #2404, and since #2393 a host
    /// sends these whole in a connection's first list push and names them kept in the pushes after it (`keptState`). The
    /// host's projects, providers and settings stay as the benchmark's laptop has them, so its list and its new thread sheet
    /// do not change.
    public static let hostParts: [(name: String, bytes: Int)] = [("deliveries", 45_933), ("deliveredDrafts", 12_929), ("followupReceipts", 7_980)]

    /// `state`, a shell push's state as a JSON object, with every one of `hostParts` made up at its size: a running host's
    /// first list push to a phone, where the benchmark's laptop sends only the record that changed (#2390). The threads the parts
    /// name are not on the list and every delivery was accepted, so nothing the phone shows changes.
    public static func hostSizedState(_ state: Data, now: Date) -> Data {
        var text = String(decoding: state, as: UTF8.self)
        guard text.hasSuffix("}") else { return state }
        text.removeLast()
        for part in hostParts {
            if !text.hasSuffix("{") { text += "," }
            text += quoted(part.name) + ":" + hostPart(part.name, bytes: part.bytes, now: now)
        }
        return Data((text + "}").utf8)
    }

    /// The parts a host sends in every list push, which a push never names kept: the threads and the catalog's fields
    /// (`withKeptParts` in `src/main/agents/agentStateBroadcast.ts`, ADR-0028's November 10 amendment).
    static let neverKept: Set<String> = ["threads", "models", "modelsRevision", "providerModeLists"]
    /// `state` as a running host sends it to a phone in a list push after one that carried it whole (`kept-parts`, #2393):
    /// each part at its top and in its host named in `kept` and left out, but the threads and the catalog's fields, which
    /// go as they are; the host's threads go empty, as the records that changed carry them. The phone puts the rest back
    /// from the push before (`KeptPartsCache`). A state that is not a JSON object with a host is returned as it came.
    public static func keptState(_ state: Data) -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: state) as? [String: Any],
              let host = object["host"] as? [String: Any] else { return state }
        var top: [String: Any] = ["kept": object.keys.filter { $0 != "host" && !neverKept.contains($0) }.sorted()]
        var hostKept: [String: Any] = ["kept": host.keys.filter { !neverKept.contains($0) }.sorted(), "threads": [Any]()]
        for name in neverKept where name != "threads" {
            if let value = object[name] { top[name] = value }
            if let value = host[name] { hostKept[name] = value }
        }
        top["host"] = hostKept
        return (try? JSONSerialization.data(withJSONObject: top, options: [.sortedKeys])) ?? state
    }

    /// One of `hostParts`, made up `bytes` long. Each receipt is two UUIDs, 100 bytes as forge's are, so the two receipt
    /// ledgers are their size by their count alone; the deliveries are padded to it.
    public static func hostPart(_ name: String, bytes: Int, now: Date) -> String {
        switch name {
        case "deliveries": return sized(bytes, count: 128) { delivery($0, pad: $1, now: now) }
        // The ledgers keep a host's last 128 drafts; forge's follow-up receipts held 79. The delivered drafts are the
        // deliveries' own.
        case "deliveredDrafts": return receipts(128, ledger: 3)
        case "followupReceipts": return receipts(79, ledger: 5)
        default: return "[]"
        }
    }

    /// A JSON list of `count` entries exactly `bytes` long: `entry(index, pad)` writes each, and what the entries leave
    /// short of `bytes` with no pad is shared among them, one byte of the entry for each of its pad, the first entries a
    /// byte longer. Entries already over `bytes` are left as they are.
    static func sized(_ bytes: Int, count: Int, _ entry: (_ index: Int, _ pad: Int) -> String) -> String {
        let bare = (0..<count).map { entry($0, 0) }
        let short = bytes - bare.reduce(2 + max(0, count - 1)) { $0 + $1.utf8.count }
        guard short > 0 else { return "[" + bare.joined(separator: ",") + "]" }
        return "[" + (0..<count).map { entry($0, short / count + ($0 < short % count ? 1 : 0)) }.joined(separator: ",") + "]"
    }
    /// A delivery the provider accepted, as the host keeps it; the pad lengthens its provider message ID.
    private static func delivery(_ index: Int, pad: Int, now: Date) -> String {
        var text = #"{"threadId":"\#(madeUpID(2, index % 40))","draftId":"\#(madeUpID(3, index))","status":"accepted","#
        text += #""createdAt":"\#(stamp(now, Double(index) * 90 + 30))","updatedAt":"\#(stamp(now, Double(index) * 90))","#
        text += #""commandId":"\#(madeUpID(7, index))","messageId":"msg_\#(hex(index, 24 + pad))""#
        if index % 8 == 0 { text += #","packetDigest":"\#(String(repeating: hex(index, 16), count: 4))""# }
        return text + #","localFeedbackMs":\#(40 + index % 60),"providerLatencyMs":\#(1_200 + index * 37 % 4_000)}"#
    }
    /// `count` receipts of the ledger numbered `ledger`, each a thread and one of its drafts.
    private static func receipts(_ count: Int, ledger: Int) -> String {
        "[" + (0..<count).map { #"{"threadId":"\#(madeUpID(2, $0 % 40))","draftId":"\#(madeUpID(ledger, $0))"}"# }.joined(separator: ",") + "]"
    }
    /// A made-up UUID, the same for the same two numbers: `kind` tells the made-up things apart, `index` the entries.
    static func madeUpID(_ kind: Int, _ index: Int) -> String { "\(hex(kind, 8))-0000-4000-8000-\(hex(index, 12))" }
    private static func hex(_ value: Int, _ width: Int) -> String {
        let digits = String(value, radix: 16)
        return String(repeating: "0", count: max(0, width - digits.count)) + digits
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
