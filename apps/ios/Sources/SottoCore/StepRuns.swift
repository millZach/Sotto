import Foundation

/// A run of steps between two messages as its folded line reads it (ADR-0051, October 5 amendment). While the thread
/// works through the run, the line names the step running now; once the run has ended, it says how many steps it had
/// and how long they took. Pure, so the thread page and the tests read one answer.
public enum StepRun {
    /// What the running step is doing, as the working line says it: a verb, and the command or file it works on.
    public struct Live: Equatable, Sendable {
        public let verb: String
        public let subject: String?
        public init(verb: String, subject: String?) {
            self.verb = verb
            self.subject = subject
        }
        /// "Running npm test", "Thinking".
        public var words: String { subject.map { verb + " " + $0 } ?? verb }
    }

    /// "1 step", "14 steps".
    public static func count(_ steps: Int) -> String { steps == 1 ? "1 step" : "\(steps) steps" }

    /// The step a working run's line shows: the latest one still running, or nil when none is.
    public static func running(_ steps: [Activity]) -> Activity? { steps.last(where: { $0.status == "running" }) }
    /// What the working line says now: the step running, or Thinking between steps (a provider reports its tool calls,
    /// not the thinking between them, so a working thread often has no step running).
    public static func now(_ steps: [Activity]) -> Live { running(steps).map(live) ?? Live(verb: "Thinking", subject: nil) }

    /// What a press on the line does: "Show 14 steps", or "Hide steps" once they are open.
    public static func press(count steps: Int, open: Bool) -> String { open ? "Hide steps" : "Show " + count(steps) }

    // MARK: How long a run took

    /// How long the run took, in seconds: from the first step's start to the end of the last (its start and its
    /// duration) when the steps carry times, otherwise the sum of their durations. Nil when nothing says.
    public static func seconds(_ steps: [Activity], date: (String) -> Date? = Stamp.date) -> TimeInterval? {
        if let span = span(steps, date: date), span > 0 { return span }
        let total = steps.reduce(0.0) { sum, step in sum + max(0, step.durationMs ?? 0) } / 1000
        return total > 0 ? total : nil
    }

    private static func span(_ steps: [Activity], date: (String) -> Date?) -> TimeInterval? {
        guard let stamp = steps.first?.startedAt, let first = date(stamp) else { return nil }
        var end = first
        for step in steps {
            guard let stamp = step.startedAt, let start = date(stamp) else { continue }
            let finish = start.addingTimeInterval(max(0, step.durationMs ?? 0) / 1000)
            if finish > end { end = finish }
        }
        return end.timeIntervalSince(first)
    }

    /// Whole seconds, with anything under a second read as one.
    private static func wholeSeconds(_ seconds: TimeInterval) -> Int { max(1, Int(seconds.rounded())) }

    /// "4s", "1m 32s", "1m 07s", "1h 03m".
    public static func duration(_ seconds: TimeInterval) -> String {
        let total = wholeSeconds(seconds)
        let hours = total / 3600
        let minutes = (total / 60) % 60
        let rest = total % 60
        if hours > 0 { return "\(hours)h \(twoDigits(minutes))m" }
        if minutes > 0 { return "\(minutes)m \(twoDigits(rest))s" }
        return "\(rest)s"
    }

    /// "4 seconds", "1 minute 32 seconds", "1 hour 3 minutes", for VoiceOver.
    public static func spokenDuration(_ seconds: TimeInterval) -> String {
        let total = wholeSeconds(seconds)
        let hours = total / 3600
        let minutes = (total / 60) % 60
        let rest = total % 60
        if hours > 0 {
            return minutes > 0 ? unit(hours, "hour") + " " + unit(minutes, "minute") : unit(hours, "hour")
        }
        if minutes > 0 {
            return rest > 0 ? unit(minutes, "minute") + " " + unit(rest, "second") : unit(minutes, "minute")
        }
        return unit(rest, "second")
    }

    private static func unit(_ value: Int, _ name: String) -> String { value == 1 ? "1 \(name)" : "\(value) \(name)s" }
    private static func twoDigits(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }

    // MARK: The folded line's words

    /// A finished run's line: "14 steps · 1m 32s", or "14 steps" when nothing says how long.
    public static func summary(count steps: Int, seconds: TimeInterval?) -> String {
        guard let seconds else { return count(steps) }
        return count(steps) + " · " + duration(seconds)
    }

    /// A finished run's line for VoiceOver: "14 steps, 1 minute 32 seconds".
    public static func spokenSummary(count steps: Int, seconds: TimeInterval?) -> String {
        guard let seconds else { return count(steps) }
        return count(steps) + ", " + spokenDuration(seconds)
    }

    /// The working run's line for VoiceOver: "Working: Running npm test, 12 steps so far".
    public static func spokenWorking(_ live: Live?, count steps: Int) -> String {
        guard let live else { return "Working, \(count(steps)) so far" }
        return "Working: \(live.words), \(count(steps)) so far"
    }

    // MARK: The running step

    /// The running step as the working line says it. A command reads as Running and the command itself, without the
    /// shell that wraps it; a file change as Editing and the file's name; reasoning as Thinking. Anything else keeps
    /// its own title.
    public static func live(_ step: Activity) -> Live {
        switch step.kind {
        case "command":
            let command = step.command.map(innerCommand) ?? ""
            return Live(verb: "Running", subject: command.isEmpty || command == step.title ? nil : command)
        case "file-change": return Live(verb: "Editing", subject: fileName(step.changes))
        case "reasoning": return Live(verb: "Thinking", subject: nil)
        case "plan": return Live(verb: "Planning", subject: nil)
        case "compaction": return Live(verb: "Compacting context", subject: nil)
        default:
            let title = step.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let command = step.command.map(innerCommand) ?? ""
            let subject = fileName(step.changes) ?? (command.isEmpty || command == title ? nil : command)
            return Live(verb: title.isEmpty ? "Working" : title, subject: subject)
        }
    }

    /// The first changed file by name, and how many more: "TerminalDrawer.tsx and 1 more".
    public static func fileName(_ changes: [Activity.Change]?) -> String? {
        guard let changes, let first = changes.first else { return nil }
        let name = first.path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map { String($0) } ?? first.path
        return changes.count == 1 ? name : "\(name) and \(changes.count - 1) more"
    }

    /// The command a shell was asked to run, without the shell: `"C:\…\powershell.exe" -Command 'npm test'` reads as
    /// `npm test`, and so do `cmd /c npm test` and `bash -lc 'npm test'`. Anything else comes back as it was, trimmed.
    public static func innerCommand(_ command: String) -> String {
        let text = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let split = splitProgram(text) else { return text }
        let flags: [String]
        switch programName(split.program) {
        case "powershell", "pwsh": flags = ["-command", "-c"]
        case "cmd": flags = ["/c", "/k"]
        case "bash", "sh", "zsh": flags = ["-c", "-lc"]
        default: return text
        }
        // The shell's own arguments run up to the one that carries the command; everything after it is the command.
        var remaining = Substring(split.rest).drop(while: { $0 == " " || $0 == "\t" })
        while !remaining.isEmpty {
            let token = remaining.prefix(while: { $0 != " " && $0 != "\t" })
            remaining = remaining.dropFirst(token.count)
            if flags.contains(token.lowercased()) {
                let inner = unquote(String(remaining).trimmingCharacters(in: .whitespacesAndNewlines))
                return inner.isEmpty ? text : inner
            }
            remaining = remaining.drop(while: { $0 == " " || $0 == "\t" })
        }
        return text
    }

    /// The program, quoted or not, and what follows it.
    private static func splitProgram(_ text: String) -> (program: String, rest: String)? {
        guard let first = text.first else { return nil }
        if first == "\"" || first == "'" {
            let body = text.dropFirst()
            guard let close = body.firstIndex(of: first) else { return nil }
            return (program: String(body[..<close]), rest: String(body[body.index(after: close)...]))
        }
        let program = text.prefix(while: { $0 != " " && $0 != "\t" })
        return (program: String(program), rest: String(text.dropFirst(program.count)))
    }

    /// `powershell` for `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`.
    private static func programName(_ program: String) -> String {
        let last = program.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map { String($0) } ?? program
        let name = last.lowercased()
        return name.hasSuffix(".exe") ? String(name.dropLast(4)) : name
    }

    /// Takes off one pair of matching outer quotes. Inside PowerShell's single quotes, two quotes stand for one.
    private static func unquote(_ text: String) -> String {
        guard text.count >= 2, let first = text.first, let last = text.last, first == last, first == "'" || first == "\"" else {
            return text
        }
        let inner = String(text.dropFirst().dropLast())
        return first == "'" ? inner.replacingOccurrences(of: "''", with: "'") : inner
    }
}
