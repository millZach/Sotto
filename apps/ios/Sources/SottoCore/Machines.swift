import Foundation

/// The machines line on Watcher's page (#1032, Zach's pick D "Names" on October 23, 2026), as the computer that runs
/// Watcher sends it to an iPhone that accepts `watcher-phone-machines`: each machine with its working threads, the work
/// placed there that has not started, and its load as that computer last read it. Optional on the page: a computer
/// without Work across machines sends none, and an older iPhone ignores it. A display record, never a permission.
public struct WatcherMachines: Decodable, Equatable, Sendable {
    /// When the computer last read its machines, or nil before any read: until then only the counts are known.
    public let readAt: String?
    /// This computer first, then each paired machine in the order the computer's Settings lists them.
    public let rows: [Machine]

    public struct Machine: Decodable, Equatable, Identifiable, Sendable {
        public let hostId: String
        public var id: String { hostId }
        /// "This computer", or the name the user saved for the machine on the computer. The iPhone names This computer as
        /// it names the computer itself (`named(_:computer:)`), since on a phone "this computer" would be the phone.
        public var name: String
        public let thisComputer: Bool
        /// Whether the computer is connected to it now.
        public let connected: Bool
        /// Threads working there now.
        public let working: Int
        /// Work placed there that has not started, as its host counts it.
        public let starting: Int
        /// Whether new workers start here: the machine the computer's Settings names.
        public let isDefault: Bool
        /// `busy`, `not-busy` or `unknown`; nil while the machine has not been read, which says nothing of its load.
        public let cpuState: String?
        /// `short`, `enough` or `unknown`; nil while the machine has not been read.
        public let memoryState: String?
        /// The system, as the computer names it: "Windows 11", "Omarchy (Linux)", "macOS 15.3".
        public let system: String?
        public let logicalCpuCount: Int?
        public let totalMemoryBytes: Double?
        public let cpuBusyPercent: Double?
        /// The span the CPU reading covers.
        public let windowMs: Double?
        public let availableMemoryBytes: Double?
        /// When the load was read.
        public let loadObservedAt: String?
        /// Why the load, or half of it, reads unknown, in the computer's own sentence; nil when it is known.
        public let unknownWhy: String?
        /// The first few threads working there, each with who started it, as the computer's panel lists them.
        public let threads: [WorkingThread]
        public struct WorkingThread: Decodable, Equatable, Sendable {
            public let title: String
            /// "Watcher", "delegated by Tailnet reconnect fix" or "your thread".
            public let who: String
        }
    }
}

/// The words of the machines line and a machine's panel, as the desktop's `machineLine.ts` says them. Names and counts
/// never change colour; only a problem's words take the warning ink, and nothing is a pill (ADR-0110).
public enum MachineLine {
    /// Above this many working threads a machine may slow down; Sotto warns and refuses nothing.
    public static let quietMax = 10

    /// The words a problem adds after a machine's count, in the order the prototype set: more than ten working, busy,
    /// short on memory, load unknown. Load unknown only when its CPU and its memory both are (Zach, October 23, 2026):
    /// a Mac says busy from its CPU and leaves its memory to the panel. A machine not connected says only that.
    public static func problems(_ machine: WatcherMachines.Machine) -> [String] {
        guard machine.connected else { return ["not connected"] }
        var words: [String] = []
        if machine.working > quietMax { words.append("may slow down") }
        if machine.cpuState == "busy" { words.append("busy") }
        if machine.memoryState == "short" { words.append("short on memory") }
        if machine.cpuState == "unknown" && machine.memoryState == "unknown" { words.append("load unknown") }
        return words
    }

    /// "3 working", or "3 working, 1 starting" while work placed there has not begun; nothing for a machine not connected.
    public static func count(_ machine: WatcherMachines.Machine, starting: Bool = false) -> String {
        guard machine.connected else { return "" }
        return "\(machine.working) working" + (starting && machine.starting > 0 ? ", \(machine.starting) starting" : "")
    }

    /// What follows a machine's name on the line: "3 working, busy", "not connected".
    public static func tail(_ machine: WatcherMachines.Machine, starting: Bool = false) -> String {
        ([count(machine, starting: starting)] + problems(machine)).filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// One machine as the line reads it: "forge 3 working, busy", "lab not connected".
    public static func text(_ machine: WatcherMachines.Machine, starting: Bool = false) -> String {
        let rest = tail(machine, starting: starting)
        return rest.isEmpty ? machine.name : machine.name + " " + rest
    }

    /// The name's spoken label: what the line shows of the machine, then what a press does.
    public static func label(_ machine: WatcherMachines.Machine) -> String {
        let parts = [machine.name, count(machine)] + problems(machine)
        return parts.filter { !$0.isEmpty }.joined(separator: ", ") + ". Show \(machine.name)’s load and what runs there."
    }

    /// The rows with This computer called by the computer's own name, as the rest of the iPhone calls it.
    public static func named(_ rows: [WatcherMachines.Machine], computer: String) -> [WatcherMachines.Machine] {
        rows.map { row in
            var named = row
            if row.thisComputer { named.name = computer }
            return named
        }
    }

    /// The line on a phone (Zach, October 23, 2026): no "starting" counts, only the machines with a problem, then how many
    /// more. With nothing wrong anywhere no machine is named, and `calm` stands for them all; This computer alone is
    /// named, since there is nothing else.
    public static func short(_ rows: [WatcherMachines.Machine]) -> (shown: [WatcherMachines.Machine], more: Int) {
        let troubled = rows.filter { !problems($0).isEmpty }
        let shown = troubled.isEmpty && rows.count == 1 ? rows : troubled
        return (shown, rows.count - shown.count)
    }

    /// The line when nothing is wrong on any machine: "3 machines, 5 working".
    public static func calm(_ rows: [WatcherMachines.Machine]) -> String {
        let working = rows.reduce(0) { $0 + $1.working }
        return "\(rows.count) machine\(rows.count == 1 ? "" : "s"), \(working) working"
    }

    /// "2 more", the press that shows every machine.
    public static func more(_ count: Int) -> String { "\(count) more" }
    public static func moreLabel(_ count: Int) -> String { "\(count) more machine\(count == 1 ? "" : "s"). Show every machine" }
    public static func calmLabel(_ rows: [WatcherMachines.Machine]) -> String { calm(rows) + ", nothing wrong. Show every machine" }

    // MARK: A machine's panel

    /// "41 GB", "1.6 GB".
    public static func memory(_ bytes: Double) -> String {
        let gb = bytes / 1_073_741_824
        let shown = gb >= 10 ? gb.rounded() : (gb * 10).rounded() / 10
        return (shown == shown.rounded() ? String(Int(shown)) : String(shown)) + " GB"
    }

    /// "6 s ago", "3 min ago", "2 h ago".
    public static func ago(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded()))
        if s < 60 { return "\(s) s ago" }
        let minutes = Int((Double(s) / 60).rounded())
        return minutes < 60 ? "\(minutes) min ago" : "\(Int((Double(minutes) / 60).rounded())) h ago"
    }

    /// "the last 2 seconds", "the last minute".
    public static func window(_ ms: Double) -> String {
        let seconds = max(1, Int((ms / 1000).rounded()))
        if seconds < 60 { return "the last \(seconds) second\(seconds == 1 ? "" : "s")" }
        let minutes = Int((Double(seconds) / 60).rounded())
        return minutes == 1 ? "the last minute" : "the last \(minutes) minutes"
    }

    /// The CPU row: "93% busy over the last 2 seconds. Busy", or "unknown".
    public static func cpu(_ machine: WatcherMachines.Machine) -> String {
        guard let state = machine.cpuState, state != "unknown", let percent = machine.cpuBusyPercent, let window = machine.windowMs else { return "unknown" }
        return "\(Int(percent.rounded()))% busy over \(self.window(window))" + (state == "busy" ? ". Busy" : "")
    }

    /// The memory row: "41 GB of 64 GB available. Short on memory", or "unknown".
    public static func memoryRow(_ machine: WatcherMachines.Machine) -> String {
        guard let state = machine.memoryState, state != "unknown", let available = machine.availableMemoryBytes else { return "unknown" }
        let total = machine.totalMemoryBytes.map { " of " + memory($0) } ?? ""
        return memory(available) + total + " available" + (state == "short" ? ". Short on memory" : "")
    }

    /// The panel's count: "3 working, 1 starting. New workers start here."
    public static func panelCount(_ machine: WatcherMachines.Machine) -> String {
        count(machine, starting: true) + (machine.isDefault ? ". New workers start here." : "")
    }

    /// The warning above ten, in the panel; nil at ten or fewer.
    public static func over(_ machine: WatcherMachines.Machine) -> String? {
        guard machine.working > quietMax else { return nil }
        return "More than ten threads are working on \(machine.name). It may slow down. Nothing is stopped or held back."
    }

    /// What the panel says of a machine not connected, and what that means when new workers start there. `computer` is
    /// the name of the computer that runs Watcher.
    public static func notConnected(_ machine: WatcherMachines.Machine, computer: String) -> String {
        "\(machine.name) is not connected." + (machine.isDefault ? " It is where new workers start, so until it connects they start on \(computer), and Watcher says so." : "")
            + " Connect it on \(computer), in Settings, under Hosts & phones."
    }
}

/// Reads Watcher's page with its machines read afresh: for an iPhone that accepts `watcher-phone-machines`, when the user
/// opens a machine's numbers or Watcher places work. Nothing reads on a timer.
public extension WatcherWire {
    static let machinesFeature = "watcher-phone-machines"
    static let readMachines: [String: JSONValue] = ["op": .string("watcher-phone-read"), "machines": .bool(true)]
}
