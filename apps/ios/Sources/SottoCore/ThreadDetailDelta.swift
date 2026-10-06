import Foundation

/// The existing v1 detail-delta extension, requested in hello. Old hosts still send full details.
public struct ThreadDetailDelta: Decodable, Sendable {
    public let threadId: String; public let baseRevision: Int; public let revision: Int
    public let messageDeltas: [MessageDelta]; public let activityDeltas: [ActivityDelta]

    public enum MessageDelta: Decodable, Sendable {
        case message(Message), append(id: String, text: String)
        private enum Keys: String, CodingKey { case message, id, appendText }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            if c.contains(.message) { self = .message(try c.decode(Message.self, forKey: .message)) }
            else { self = .append(id: try c.decode(String.self, forKey: .id), text: try c.decode(String.self, forKey: .appendText)) }
        }
    }
    public enum ActivityDelta: Decodable, Sendable {
        case record(Activity), remove(String)
        private enum Keys: String, CodingKey { case record, id, removed }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            if c.contains(.record) { self = .record(try c.decode(Activity.self, forKey: .record)) }
            else {
                guard try c.decode(Bool.self, forKey: .removed) else { throw ClientError.invalidProtocol }
                self = .remove(try c.decode(String.self, forKey: .id))
            }
        }
    }
}

public extension ThreadDetail {
    /// Refuse gaps and unknown append targets atomically: the caller reads one full snapshot.
    func applying(_ delta: ThreadDetailDelta) -> ThreadDetail? {
        guard delta.threadId == threadId, delta.baseRevision == revision, delta.revision > revision else { return nil }
        var messages = self.messages, activities = self.activities ?? []
        for change in delta.messageDeltas {
            switch change {
            case .message(let message):
                if let index = messages.firstIndex(where: { $0.id == message.id }) { messages[index] = message }
                else { messages.append(message) }
            case .append(let id, let text):
                guard let index = messages.firstIndex(where: { $0.id == id }) else { return nil }
                let old = messages[index]
                messages[index] = Message(id: old.id, role: old.role, text: old.text + text, commandId: old.commandId, attachments: old.attachments,
                                          createdAt: old.createdAt)
            }
        }
        for change in delta.activityDeltas {
            switch change {
            case .record(let record):
                if let index = activities.firstIndex(where: { $0.id == record.id }) { activities[index] = record }
                else { activities.append(record) }
            case .remove(let id): activities.removeAll { $0.id == id }
            }
        }
        if !delta.activityDeltas.isEmpty { activities.sort { $0.sequence < $1.sequence } }
        return ThreadDetail(threadId: threadId, revision: delta.revision, messages: messages,
                            earlierAvailable: earlierAvailable, activities: activities)
    }
}
