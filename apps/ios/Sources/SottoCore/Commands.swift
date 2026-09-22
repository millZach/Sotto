import Foundation

public struct QuestionAnswer: Codable, Equatable, Sendable {
    public var optionIds: [String]; public var text: String?
    public init(optionIds: [String] = [], text: String? = nil) { self.optionIds = optionIds; self.text = text }
}
/// The commands this client builds, each with the only fields the host accepts from a paired device.
/// A copy of the rows it uses from the host's closed allow-list in src/host/remoteCommands.ts, which is
/// the authority: anything not listed there is refused. The app builds nothing that list gates behind
/// the remote-answer policy except `answer` (runtime and provider modes, discarding uncommitted work).
public enum RemoteCommands {
    public static let allowed: [String: Set<String>] = [
        "manual-send": ["threadId", "text", "attachments", "skills", "files", "draftId"],
        "interrupt": ["threadId"],
        "load-earlier-messages": ["threadId"],
        "answer": ["threadId", "requestId", "answer", "approved", "questionAnswers", "permissionChoice"],
    ]
    /// Commands the host accepts only from a client holding its remote-answer policy (`mayAnswer`).
    public static let needAnswerPolicy: Set<String> = ["answer"]
    /// Refuses a command the host would refuse, before it is sent.
    public static func checked(_ command: JSONValue) throws -> JSONValue {
        guard case .object(let fields) = command, case .string(let type)? = fields["type"],
              let permitted = Self.allowed[type], Set(fields.keys).subtracting(["type"]).isSubset(of: permitted) else { throw ClientError.invalidRequest }
        return command
    }
}
public enum Commands {
    public static func prompt(threadID: String, text: String, draftID: String) throws -> JSONValue {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 100_000,
              UUID(uuidString: draftID) != nil else { throw ClientError.invalidRequest }
        return try RemoteCommands.checked(.object(["type": .string("manual-send"), "threadId": .string(threadID), "text": .string(text), "draftId": .string(draftID)]))
    }
    public static func interrupt(threadID: String) throws -> JSONValue {
        try RemoteCommands.checked(.object(["type": .string("interrupt"), "threadId": .string(threadID)]))
    }
    public static func loadEarlier(threadID: String) throws -> JSONValue {
        try RemoteCommands.checked(.object(["type": .string("load-earlier-messages"), "threadId": .string(threadID)]))
    }
    public static func answer(threadID: String, request: AgentRequest, currentRequests: [AgentRequest],
                              choice: String? = nil, text: String = "", answers: [String: QuestionAnswer] = [:]) throws -> JSONValue {
        guard request.supported, let current = currentRequests.first(where: { $0.id == request.id }),
              current.supported, current == request else { throw ClientError.invalidRequest }
        var result: [String: JSONValue] = ["type": .string("answer"), "threadId": .string(threadID), "requestId": .string(request.id), "answer": .string(text)]
        if request.kind == "permission" {
            if current.permissionChoices == nil {
                guard choice == "allow" || choice == "deny" else { throw ClientError.invalidRequest }
                result["approved"] = .bool(choice == "allow"); result["answer"] = .string(choice == "allow" ? "Allow" : "Deny")
                return try RemoteCommands.checked(.object(result))
            }
            guard let choice, let option = current.permissionChoices?.first(where: { $0.id == choice }),
                  request.permissionChoices?.contains(where: { $0.id == choice && $0.kind == option.kind && $0.label == option.label }) == true else { throw ClientError.invalidRequest }
            result["permissionChoice"] = .string(choice)
            result["approved"] = .bool(option.kind.hasPrefix("allow-"))
            result["answer"] = .string(option.label)
        } else if let questions = current.questions, !questions.isEmpty {
            guard Set(answers.keys).isSubset(of: Set(questions.map(\.id))) else { throw ClientError.invalidRequest }
            var wire: [String: JSONValue] = [:]
            for q in questions {
                if q.unavailableReason != nil {
                    if q.required == false { continue }
                    throw ClientError.invalidRequest
                }
                let answer = answers[q.id] ?? QuestionAnswer()
                guard Set(answer.optionIds).count == answer.optionIds.count,
                      Set(answer.optionIds).isSubset(of: Set(q.options.map(\.id))),
                      q.multiSelect || answer.optionIds.count <= 1,
                      q.allowFreeText || (answer.text ?? "").isEmpty,
                      (answer.text ?? "").utf16.count <= 100_000,
                      q.required == false || !answer.optionIds.isEmpty || !(answer.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ClientError.invalidRequest }
                var value: [String: JSONValue] = ["optionIds": .array(answer.optionIds.map(JSONValue.string))]
                if let text = answer.text, !text.isEmpty { value["text"] = .string(text) }
                wire[q.id] = .object(value)
            }
            result["questionAnswers"] = .object(wire)
        } else if !current.options.isEmpty {
            guard let choice, current.options.contains(where: { $0.id == choice }) else { throw ClientError.invalidRequest }
            result["answer"] = .string(choice)
        } else {
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 100_000 else { throw ClientError.invalidRequest }
        }
        return try RemoteCommands.checked(.object(result))
    }
}

/// No prompt, answer text or token is persisted in the delivery marker.
/// An unknown receipt after restart NEVER authorizes resubmission.
public struct PendingOperation: Codable, Identifiable, Equatable, Sendable {
    public let id: String; public let hostID: String; public let clientID: String; public let threadID: String
    public let requestID: String?; public let draftID: String?; public let kind: String
    public init(hostID: String, clientID: String, threadID: String, requestID: String? = nil, draftID: String? = nil, kind: String, id: String = UUID().uuidString) {
        self.id = id; self.hostID = hostID; self.clientID = clientID; self.threadID = threadID
        self.requestID = requestID; self.draftID = draftID; self.kind = kind
    }
    public func matches(hostID: String, clientID: String) -> Bool { self.hostID == hostID && self.clientID == clientID }
    public func reconciled(receipt: Receipt, deliveries: [Delivery]) -> Bool {
        // Completed transport receipt only confirms provider delivery when its draft status agrees.
        if let draftID, let delivery = deliveries.first(where: { $0.draftId == draftID && $0.threadId == threadID }) {
            return delivery.status == "accepted" || delivery.status == "failed"
        }
        return draftID == nil && receipt.status == "completed" && receipt.error == nil
    }
}
