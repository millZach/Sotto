import Foundation

/// A thread's follow-up queue as the reply box shows it, by the desktop's rules (src/renderer/src/agents/ThreadFollowups.tsx).
/// Steering and removing are the user's own presses; nothing here answers a request or sends on its own.
public enum FollowupQueue {
    /// The cards stacked over the reply box before "more queued" says the rest.
    public static let shownCards = 2

    /// The thread's queue, in order. A message already dispatched and in the conversation is left to the conversation.
    public static func items(_ shell: Shell?, threadID: String, messages: [Message]?) -> [Followup] {
        let mine = (shell?.followups ?? []).filter { $0.threadId == threadID }
        let said = Set((messages ?? []).map(\.id))
        return mine.filter { item in
            guard item.status == "dispatching", let message = item.messageId else { return true }
            return !said.contains(message)
        }
    }

    /// Whether the computer holds this queued reply, or has already taken it on: the evidence that a queue command
    /// reached it. A receipt alone is not.
    public static func holds(_ shell: Shell, threadID: String, draftID: String) -> Bool {
        (shell.followups ?? []).contains { $0.threadId == threadID && $0.draftId == draftID }
            || (shell.followupReceipts ?? []).contains { $0.threadId == threadID && $0.draftId == draftID }
    }

    /// What a card says about its message, in a few words.
    public static func state(_ item: Followup) -> String {
        switch item.status {
        case "queued": return "Queued for after this turn"
        case "dispatching": return "Sending…"
        case "uncertain": return "Not confirmed"
        case "failed": return "Couldn’t send"
        case "paused": return "Paused"
        default: return "Queued"
        }
    }

    /// Queued, refused and paused messages can be taken out; one on its way can't. Sotto's wake-up is removed the same way.
    public static func removable(_ item: Followup) -> Bool {
        item.status == "queued" || item.status == "failed" || item.status == "paused"
    }

    /// Whether a card offers Steer now: the user's own queued message, a turn running, and a provider that takes a
    /// message into it. A wake-up waits for the thread to be ready and is never steered.
    public static func steerOffered(_ item: Followup, thread: ThreadSummary, capabilities: ProviderCapabilities?) -> Bool {
        item.status == "queued" && item.wakeUp != true && thread.status == "running" && capabilities?.steer == true
    }

    /// Whether nothing on the computer holds a steer back: no request waiting, no command on the thread's own lane, and
    /// no queued message or reply of the thread's still on its way.
    public static func steerClear(_ shell: Shell, thread: ThreadSummary) -> Bool {
        let id = thread.id
        return thread.requests.isEmpty && !(shell.busyThreadIds ?? []).contains(id)
            && !(shell.followups ?? []).contains { $0.threadId == id && ($0.status == "dispatching" || $0.status == "uncertain") }
            && !(shell.deliveries ?? []).contains { $0.threadId == id && ($0.status == "submitting" || $0.status == "uncertain") }
    }
}

/// Compacting a thread's context on request, by the desktop's rules (src/renderer/src/agents/ThreadCompaction.tsx).
public enum ContextCompaction {
    /// Whether the thread offers Compact context at all. A provider that learns whether it can compact only once the
    /// thread's process starts leaves it unknown, which still offers it; the provider checks before compacting.
    public static func offered(_ capabilities: ProviderCapabilities?, thread: ThreadSummary) -> Bool {
        capabilities?.compact == true && thread.manualCompactionSupported != false && thread.nativeSessionStarted != false
    }

    /// Why the thread can't be compacted now, in a few words, or nil when it can. `messages` is the history this iPhone
    /// has read; nil when it hasn't read the thread, which leaves the history to the computer to judge.
    public static func held(_ thread: ThreadSummary, messages: [Message]?, earlierAvailable: Bool) -> String? {
        if let status = thread.compaction?.status, status == "running" || status == "uncertain" { return "Already compacting" }
        if thread.status == "running" { return "Available when this turn ends" }
        if !thread.requests.isEmpty { return "Available once the waiting request is answered" }
        if let messages, !earlierAvailable, !messages.contains(where: { $0.role == "user" && !isCompact($0.text) }) {
            return "Nothing to compact yet"
        }
        return nil
    }

    /// A message that only asked to compact, which leaves nothing of its own to fold.
    static func isCompact(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/compact") else { return false }
        return trimmed.dropFirst("/compact".count).first.map(\.isWhitespace) ?? true
    }
}
