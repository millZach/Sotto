import Foundation

/// One thing in a thread's conversation: a message, or one step the agent took.
public enum TimelineEntry: Sendable {
    case message(Message)
    case step(Activity)
    public var id: String {
        switch self {
        case .message(let message): return "message-" + message.id
        case .step(let step): return "step-" + step.id
        }
    }
}

/// A message, or the run of steps that sit together between two messages.
public enum TimelineItem: Identifiable, Sendable {
    case message(Message)
    case steps([Activity])
    public var id: String {
        switch self {
        case .message(let message): return "message-" + message.id
        case .steps(let steps): return "steps-" + (steps.first?.id ?? "")
        }
    }
}

/// A thread's messages and the agent's steps as one conversation in time order (ADR-0050). Messages keep their own
/// order, and so do steps, by sequence. A message is placed by `createdAt` and a step by `startedAt`; a step the host
/// gave no time follows the step before it, and one that came before any timed step takes the time of the first.
/// With no times to compare, steps sit after the last message from the user. Turn records are not steps.
public enum ThreadTimeline {
    public static func items(messages: [Message], activities: [Activity], earlierAvailable: Bool = false,
                             date: (String) -> Date? = Stamp.date) -> [TimelineItem] {
        grouped(merge(messages: messages, activities: activities, earlierAvailable: earlierAvailable, date: date))
    }

    /// `earlierAvailable`: the page holds only the latest messages, so a step from before the first of them belongs to
    /// a message it hasn't loaded and is left out until it is.
    public static func merge(messages: [Message], activities: [Activity], earlierAvailable: Bool = false,
                             date: (String) -> Date? = Stamp.date) -> [TimelineEntry] {
        let steps: [Activity] = activities.enumerated()
            .filter { $0.element.kind != "turn" }
            .sorted { a, b in
                if a.element.sequence != b.element.sequence { return a.element.sequence < b.element.sequence }
                return a.offset < b.offset
            }
            .map { $0.element }
        guard !steps.isEmpty else { return messages.map { TimelineEntry.message($0) } }

        // Each message's time, carried forward so a message without one sits where it is. Messages before the first
        // time sit before everything.
        var messageTimes: [Date?] = []
        var latest: Date?
        for message in messages {
            if let stamp = message.createdAt, let own = date(stamp) {
                latest = latest.map { max($0, own) } ?? own
            }
            messageTimes.append(latest)
        }
        let firstMessageTime: Date? = messageTimes.first(where: { $0 != nil }) ?? nil

        // Each step's time, carried forward the same way; steps before the first timed one take its time.
        var stepTimes: [Date?] = []
        var carried: Date?
        for step in steps {
            if let stamp = step.startedAt, let own = date(stamp) {
                carried = carried.map { max($0, own) } ?? own
            }
            stepTimes.append(carried)
        }
        if let firstStepTime = stepTimes.first(where: { $0 != nil }) ?? nil {
            for index in stepTimes.indices where stepTimes[index] == nil { stepTimes[index] = firstStepTime }
        }

        var positions: [String: Int] = [:]
        for (offset, message) in messages.enumerated() where positions[message.id] == nil { positions[message.id] = offset }
        let afterLastUser = messages.lastIndex(where: { $0.role == "user" }).map { $0 + 1 } ?? messages.count
        let byTime = firstMessageTime != nil

        // A step's slot is how many messages come before it. Slots never go back, so steps keep their order.
        var placed: [(step: Activity, slot: Int)] = []
        var floor = 0
        var cursor = 0
        for (index, step) in steps.enumerated() {
            var slot: Int
            if let after = step.afterMessageId, let position = positions[after] {
                slot = position + 1
            } else if step.afterMessageId != nil && earlierAvailable {
                continue
            } else if byTime, let time = stepTimes[index] {
                if earlierAvailable, let first = firstMessageTime, time < first { continue }
                // After every message written no later than the step started: a message and a step at the same
                // moment read message first.
                while cursor < messages.count && (messageTimes[cursor].map({ $0 <= time }) ?? true) { cursor += 1 }
                slot = cursor
            } else {
                slot = afterLastUser
            }
            slot = max(slot, floor)
            floor = slot
            placed.append((step: step, slot: slot))
        }

        var entries: [TimelineEntry] = []
        entries.reserveCapacity(messages.count + placed.count)
        var next = 0
        for (index, message) in messages.enumerated() {
            while next < placed.count && placed[next].slot <= index {
                entries.append(.step(placed[next].step))
                next += 1
            }
            entries.append(.message(message))
        }
        while next < placed.count {
            entries.append(.step(placed[next].step))
            next += 1
        }
        return entries
    }

    /// Consecutive steps as one run.
    public static func grouped(_ entries: [TimelineEntry]) -> [TimelineItem] {
        var items: [TimelineItem] = []
        var run: [Activity] = []
        for entry in entries {
            switch entry {
            case .message(let message):
                if !run.isEmpty {
                    items.append(.steps(run))
                    run = []
                }
                items.append(.message(message))
            case .step(let step):
                run.append(step)
            }
        }
        if !run.isEmpty { items.append(.steps(run)) }
        return items
    }
}
