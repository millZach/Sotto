import Foundation

/// The alerts the user has turned on in Settings. Each is off until turned on (ADR-0050).
public struct AlertSwitches: Equatable, Sendable {
    public var needsYou: Bool; public var finished: Bool; public var failed: Bool
    public init(needsYou: Bool = false, finished: Bool = false, failed: Bool = false) {
        self.needsYou = needsYou; self.finished = finished; self.failed = failed
    }
    public var any: Bool { needsYou || finished || failed }
}

/// A local alert about one thread: it needs the user, it finished unread, or it stopped with an error. It names the
/// thread, its agent and its computer, and never carries a message's or request's words.
public struct ThreadAlert: Equatable, Sendable {
    public enum Kind: String, Sendable { case question, permission, finished, failed }
    public let ref: ThreadRef; public let kind: Kind
    /// The thread's title.
    public let title: String
    /// What happened and where, in plain words.
    public let body: String
    /// Unique to the event, so iOS shows each event once and never merges two.
    public let id: String
    public init(ref: ThreadRef, kind: Kind, title: String, body: String, id: String) {
        self.ref = ref; self.kind = kind; self.title = title; self.body = body; self.id = id
    }
}

/// What changed on one computer between the lists this iPhone has read from it since it connected, as alerts.
/// The first list after connecting is what was already there, not news, so it alerts nothing. A request alerts once,
/// when its ID first appears; a finish when `finishedUnread` turns true; an error when the thread's status turns to
/// `error`. The thread on screen never alerts, and neither does a switch that is off, but both still count as seen,
/// so leaving the thread or turning a switch on later never brings up an old event.
public struct ThreadWatch: Sendable {
    private struct Mark: Sendable { let finishedUnread: Bool; let failed: Bool }
    /// Nil until the first list after connecting.
    private var marks: [String: Mark]?
    /// Requests already seen, as `threadID/requestID`.
    private var seenRequests: Set<String> = []
    public init() {}

    /// Reads the next list and returns what is news. `computer` is the computer's name as this iPhone shows it.
    public mutating func observe(_ threads: [ThreadSummary], hostID: String, computer: String,
                                 onScreen: ThreadRef?, switches: AlertSwitches) -> [ThreadAlert] {
        let first = marks == nil
        let before = marks ?? [:]
        var next: [String: Mark] = [:]
        var present = Set<String>()
        var alerts: [ThreadAlert] = []
        for thread in threads {
            let mark = Mark(finishedUnread: thread.finishedUnread == true && ThreadState(thread) == .done,
                            failed: thread.status == "error")
            next[thread.id] = mark
            var fresh: [AgentRequest] = []
            for request in thread.requests {
                let key = thread.id + "/" + request.id
                present.insert(key)
                if seenRequests.insert(key).inserted { fresh.append(request) }
            }
            let ref = ThreadRef(hostID: hostID, threadID: thread.id)
            if first || ref == onScreen { continue }
            // One alert for a thread at a time: a new request first, then an error, then a finish.
            if let request = fresh.first {
                if switches.needsYou { alerts.append(Self.alert(.request(request), thread: thread, ref: ref, computer: computer)) }
                continue
            }
            guard let previous = before[thread.id] else { continue }
            if mark.failed && !previous.failed {
                if switches.failed { alerts.append(Self.alert(.failed, thread: thread, ref: ref, computer: computer)) }
            } else if mark.finishedUnread && !previous.finishedUnread {
                if switches.finished { alerts.append(Self.alert(.finished, thread: thread, ref: ref, computer: computer)) }
            }
        }
        marks = next
        // Requests that have left are forgotten once there are many, so the set stays small over a long session.
        if seenRequests.count > 1000 { seenRequests = seenRequests.intersection(present) }
        return alerts
    }

    private enum Event { case request(AgentRequest), finished, failed }

    private static func alert(_ event: Event, thread: ThreadSummary, ref: ThreadRef, computer: String) -> ThreadAlert {
        let agent = AgentNames.name(thread.providerId)
        let title = thread.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "A thread" : thread.title
        switch event {
        case .request(let request):
            let permission = request.kind == "permission"
            let body = permission ? "\(agent) is asking for permission on \(computer)." : "\(agent) is asking a question on \(computer)."
            return ThreadAlert(ref: ref, kind: permission ? .permission : .question, title: title, body: body,
                               id: ref.id + "/request/" + request.id)
        case .finished:
            return ThreadAlert(ref: ref, kind: .finished, title: title, body: "\(agent) finished on \(computer).",
                               id: ref.id + "/finished/" + UUID().uuidString)
        case .failed:
            return ThreadAlert(ref: ref, kind: .failed, title: title, body: "\(agent) stopped with an error on \(computer).",
                               id: ref.id + "/failed/" + UUID().uuidString)
        }
    }
}

/// An agent's name as Sotto shows it, from its provider ID.
public enum AgentNames {
    public static func name(_ providerID: String?) -> String {
        ["claude": "Claude Code", "codex": "Codex", "grok": "Grok Build", "devin": "Devin"][providerID ?? ""] ?? "The agent"
    }
}
