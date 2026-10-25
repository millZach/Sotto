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
        /// "Running npm test", "Thinking". Each verb Sotto writes has its own sentence, so a language puts the verb where
        /// it belongs; a step's own title, from its provider, reads before its subject as it always has.
        public var words: String {
            guard let subject else { return verb }
            switch verb {
            case StepRun.runningVerb:
                return String(localized: "Running \(subject)", bundle: .module,
                              comment: "The working line while a command runs; %@ is the command, such as npm test")
            case StepRun.editingVerb:
                return String(localized: "Editing \(subject)", bundle: .module,
                              comment: "The working line while files change; %@ is the file's name, such as TerminalDrawer.tsx and 1 more")
            case StepRun.workingVerb:
                return String(localized: "Working \(subject)", bundle: .module,
                              comment: "The working line for a step with no title; %@ is the command or file it works on")
            default:
                return verb + " " + subject
            }
        }
    }

    // The working line's verbs. A step's own title stands in for any other.
    static let runningVerb = String(localized: "step-verb.running", defaultValue: "Running", bundle: .module,
                                    comment: "The working line's verb while a command runs, as in Running npm test, said alone when the command is the step's own title. Not a check's state.")
    static let editingVerb = String(localized: "Editing", bundle: .module, comment: "The working line's verb while files change")
    static let thinkingVerb = String(localized: "Thinking", bundle: .module, comment: "The working line while the agent reasons between steps")
    static let planningVerb = String(localized: "Planning", bundle: .module, comment: "The working line while the agent updates its plan")
    static let compactingVerb = String(localized: "Compacting context", bundle: .module,
                                       comment: "The working line while the agent shortens the conversation it remembers")
    static let workingVerb = String(localized: "step-verb.working", defaultValue: "Working", bundle: .module,
                                    comment: "The working line's verb for a step with no title of its own, said alone. Not a thread's state.")

    /// "1 step", "14 steps".
    public static func count(_ steps: Int) -> String {
        steps == 1 ? String(localized: "1 step", bundle: .module) : String(localized: "\(steps) steps", bundle: .module)
    }

    /// The step a working run's line shows: the latest one still running, or nil when none is.
    public static func running(_ steps: [Activity]) -> Activity? { steps.last(where: { $0.status == "running" }) }
    /// What the working line says now: the step running, or Thinking between steps (a provider reports its tool calls,
    /// not the thinking between them, so a working thread often has no step running).
    public static func now(_ steps: [Activity]) -> Live { running(steps).map(live) ?? Live(verb: thinkingVerb, subject: nil) }

    /// What a press on the line does: "Show 14 steps", or "Hide steps" once they are open.
    public static func press(count steps: Int, open: Bool) -> String {
        if open { return String(localized: "Hide steps", bundle: .module) }
        return steps == 1 ? String(localized: "Show 1 step", bundle: .module) : String(localized: "Show \(steps) steps", bundle: .module)
    }

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
    public static func duration(_ seconds: TimeInterval) -> String { clock(wholeSeconds(seconds)) }

    /// A length of time in short units: "0s", "4m 07s", "1h 03m", in the interface language's own abbreviations.
    public static func clock(_ seconds: Int) -> String {
        let total = max(0, seconds)
        let hours = total / 3600
        let minutes = (total / 60) % 60
        let rest = total % 60
        if hours > 0 {
            return String(localized: "\(hours)h \(twoDigits(minutes))m", bundle: .module,
                          comment: "A short length of time: hours, then minutes padded to two digits, such as 1h 03m")
        }
        if minutes > 0 {
            return String(localized: "\(minutes)m \(twoDigits(rest))s", bundle: .module,
                          comment: "A short length of time: minutes, then seconds padded to two digits, such as 4m 07s")
        }
        return String(localized: "\(rest)s", bundle: .module, comment: "A short length of time in seconds, such as 8s")
    }

    /// "4 seconds", "1 minute 32 seconds", "1 hour 3 minutes", for VoiceOver.
    public static func spokenDuration(_ seconds: TimeInterval) -> String {
        let total = wholeSeconds(seconds)
        let hours = total / 3600
        let minutes = (total / 60) % 60
        let rest = total % 60
        if hours > 0 { return minutes > 0 ? pair(spokenHours(hours), spokenMinutes(minutes)) : spokenHours(hours) }
        if minutes > 0 { return rest > 0 ? pair(spokenMinutes(minutes), spokenSeconds(rest)) : spokenMinutes(minutes) }
        return spokenSeconds(rest)
    }

    // Each count has its own sentence for one, so English reads right even where the catalog isn't built (the
    // package tests); the counted sentence carries every language's plural forms.
    private static func spokenHours(_ value: Int) -> String {
        value == 1 ? String(localized: "1 hour", bundle: .module) : String(localized: "\(value) hours", bundle: .module)
    }
    private static func spokenMinutes(_ value: Int) -> String {
        value == 1 ? String(localized: "1 minute", bundle: .module) : String(localized: "\(value) minutes", bundle: .module)
    }
    private static func spokenSeconds(_ value: Int) -> String {
        value == 1 ? String(localized: "1 second", bundle: .module) : String(localized: "\(value) seconds", bundle: .module)
    }
    private static func pair(_ larger: String, _ smaller: String) -> String {
        String(localized: "\(larger) \(smaller)", bundle: .module,
               comment: "A spoken length of time in two units, such as 1 hour 3 minutes or 4 minutes 7 seconds")
    }
    /// Minutes or seconds padded to two digits, "07", in the same digits the catalog's `%lld` is written in: both follow
    /// the iPhone's locale, so an Arabic clock never mixes its own digits with Latin ones.
    private static func twoDigits(_ value: Int) -> String { value.formatted(.number.precision(.integerLength(2...)).grouping(.never)) }

    // MARK: The folded line's words

    /// A finished run's line: "14 steps · 1m 32s", or "14 steps" when nothing says how long.
    public static func summary(count steps: Int, seconds: TimeInterval?) -> String {
        guard let seconds else { return count(steps) }
        return count(steps) + " · " + duration(seconds)
    }

    /// A finished run's line for VoiceOver: "14 steps, 1 minute 32 seconds".
    public static func spokenSummary(count steps: Int, seconds: TimeInterval?) -> String {
        guard let seconds else { return count(steps) }
        return String(localized: "\(count(steps)), \(spokenDuration(seconds))", bundle: .module,
                      comment: "A finished run for VoiceOver; the first %@ is how many steps, such as 14 steps, the second how long, such as 1 minute 32 seconds")
    }

    /// The working run's line for VoiceOver: "Working: Running npm test, 12 steps so far".
    public static func spokenWorking(_ live: Live?, count steps: Int) -> String {
        guard let live else {
            return String(localized: "Working, \(count(steps)) so far", bundle: .module,
                          comment: "A working run for VoiceOver; %@ is how many steps, such as 12 steps")
        }
        return String(localized: "Working: \(live.words), \(count(steps)) so far", bundle: .module,
                      comment: "A working run for VoiceOver; the first %@ is the step running, such as Running npm test, the second how many steps, such as 12 steps")
    }

    // MARK: The running step

    /// The running step as the working line says it. A command reads as Running and the command itself, without the
    /// shell that wraps it; a file change as Editing and the file's name; reasoning as Thinking. Anything else keeps
    /// its own title.
    public static func live(_ step: Activity) -> Live {
        switch step.kind {
        case "command":
            let command = step.command.map(innerCommand) ?? ""
            return Live(verb: runningVerb, subject: command.isEmpty || command == step.title ? nil : Interface.isolated(command))
        case "file-change": return Live(verb: editingVerb, subject: fileName(step.changes))
        case "reasoning": return Live(verb: thinkingVerb, subject: nil)
        case "plan": return Live(verb: planningVerb, subject: nil)
        case "compaction": return Live(verb: compactingVerb, subject: nil)
        default:
            let title = step.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let command = step.command.map(innerCommand) ?? ""
            let subject = fileName(step.changes) ?? (command.isEmpty || command == title ? nil : Interface.isolated(command))
            return Live(verb: title.isEmpty ? workingVerb : title, subject: subject)
        }
    }

    /// The first changed file by name, and how many more: "TerminalDrawer.tsx and 1 more".
    public static func fileName(_ changes: [Activity.Change]?) -> String? {
        guard let changes, let first = changes.first else { return nil }
        let name = first.path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map { String($0) } ?? first.path
        return changes.count == 1 ? Interface.isolated(name) : andMore(name, more: changes.count - 1)
    }

    /// "TerminalDrawer.tsx and 1 more": a file's name and how many others changed with it.
    static func andMore(_ name: String, more: Int) -> String {
        let others = more == 1 ? String(localized: "1 more", bundle: .module, comment: "How many other files changed besides the one named")
            : String(localized: "\(more) more", bundle: .module, comment: "How many other files changed besides the one named")
        return String(localized: "\(Interface.isolated(name)) and \(others)", bundle: .module,
                      comment: "The first %@ is a file's name, such as TerminalDrawer.tsx; the second is how many more, such as 1 more")
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
