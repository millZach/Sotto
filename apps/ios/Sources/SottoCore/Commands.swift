import Foundation

public struct QuestionAnswer: Codable, Equatable, Sendable {
    public var optionIds: [String]; public var text: String?
    public init(optionIds: [String] = [], text: String? = nil) { self.optionIds = optionIds; self.text = text }
}
/// The commands this client builds, each with the only fields the host accepts from a paired device.
/// A copy of the rows it uses from the host's closed allow-list in src/host/remoteCommands.ts, which is
/// the authority: anything not listed there is refused. A permissive creation mode, like an answer,
/// needs the computer's remote-answer policy. The host checks that policy again when it acts.
public enum RemoteCommands {
    public static let allowed: [String: Set<String>] = [
        "manual-send": ["threadId", "text", "attachments", "skills", "files", "draftId"],
        "queue-followup": ["threadId", "draftId", "text", "attachments", "skills", "files"],
        "steer-followup": ["threadId", "itemId"],
        "remove-followup": ["threadId", "itemId"],
        "interrupt": ["threadId"],
        "compact-thread": ["threadId"],
        // Settle and Restore move a thread on or off the Settled shelf and stop nothing (ADR-0033).
        "settle-thread": ["threadId"],
        "restore-thread": ["threadId"],
        "load-earlier-messages": ["threadId"],
        "answer": ["threadId", "requestId", "answer", "approved", "questionAnswers", "permissionChoice"],
        "create-project": ["provider", "title", "path", "useExisting"],
        "create-thread": ["projectId", "title", "modelId", "titleSource", "threadId", "workingCopy", "reasoningEffort", "runtimeMode", "providerMode", "managed"],
        // A running thread's model, effort, permissions and speed from its reply box (ADR-0166). A mode that lets the
        // thread act without asking needs the computer's remote-answer policy, which the computer checks.
        "configure-thread": ["threadId", "modelId", "reasoningEffort", "runtimeMode", "providerMode", "fastMode", "speed"],
        // The user's own Babysit pull request and Stop babysitting (ADR-0061, ADR-0102). Neither grants anything.
        "babysit-pull-request": ["threadId", "url"],
        "stop-babysitting": ["threadId", "url"],
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
    /// A reply: its words, its staged photos and files, or any of them. Photos and files go by handle, within the host's limits.
    public static func prompt(threadID: String, text: String, draftID: String, images: [StagedImage] = [], files: [StagedFile] = []) throws -> JSONValue {
        try reply("manual-send", threadID: threadID, text: text, draftID: draftID, images: images, files: files)
    }
    /// A reply put in the thread's follow-up queue, to go when the running turn ends. The same words and photos as a
    /// reply, within the same limits.
    public static func queue(threadID: String, text: String, draftID: String, images: [StagedImage] = [], files: [StagedFile] = []) throws -> JSONValue {
        try reply("queue-followup", threadID: threadID, text: text, draftID: draftID, images: images, files: files)
    }
    /// A queued message sent into the running turn now, rather than after it.
    public static func steerFollowup(threadID: String, itemID: String) throws -> JSONValue {
        try followupItem("steer-followup", threadID: threadID, itemID: itemID)
    }
    /// A queued message taken out of the queue unsent.
    public static func removeFollowup(threadID: String, itemID: String) throws -> JSONValue {
        try followupItem("remove-followup", threadID: threadID, itemID: itemID)
    }
    /// Asks the thread's provider to compact its context.
    public static func compact(threadID: String) throws -> JSONValue {
        try RemoteCommands.checked(.object(["type": .string("compact-thread"), "threadId": .string(threadID)]))
    }
    /// Puts the thread on the Settled shelf, or takes it back off.
    public static func settle(threadID: String, settled: Bool) throws -> JSONValue {
        try RemoteCommands.checked(.object(["type": .string(settled ? "settle-thread" : "restore-thread"), "threadId": .string(threadID)]))
    }
    /// Changes one or more of a thread's settings, within what the computer accepts: a model ID, an effort of at most 64
    /// characters, one of Sotto's four modes or a provider's own, and a speed of Fast or Ultra fast, null for Standard.
    public static func configureThread(threadID: String, patch: [String: JSONValue]) throws -> JSONValue {
        guard !patch.isEmpty else { throw ClientError.invalidRequest }
        for (key, value) in patch {
            switch (key, value) {
            case ("modelId", .string(let id)), ("providerMode", .string(let id)):
                guard !id.isEmpty, id.utf16.count <= 6_144 else { throw ClientError.invalidRequest }
            case ("reasoningEffort", .string(let effort)):
                guard !effort.isEmpty, effort.utf16.count <= 64 else { throw ClientError.invalidRequest }
            case ("runtimeMode", .string(let mode)):
                guard ThreadSettings.runtimeModes.contains(mode) else { throw ClientError.invalidRequest }
            case ("speed", .null): break
            case ("speed", .string(let speed)):
                guard ["fast", "ultrafast"].contains(speed) else { throw ClientError.invalidRequest }
            case ("fastMode", .bool): break
            default: throw ClientError.invalidRequest
            }
        }
        return try RemoteCommands.checked(.object(patch.merging(["type": .string("configure-thread"), "threadId": .string(threadID)]) { $1 }))
    }
    /// Starts or stops babysitting one of the thread's pull requests, by its GitHub URL (ADR-0061).
    public static func babysit(threadID: String, url: String, on: Bool) throws -> JSONValue {
        guard PullRequests.address(url) != nil, url.utf16.count <= 2048 else { throw ClientError.invalidRequest }
        return try RemoteCommands.checked(.object(["type": .string(on ? "babysit-pull-request" : "stop-babysitting"),
                                                   "threadId": .string(threadID), "url": .string(url)]))
    }
    private static func followupItem(_ type: String, threadID: String, itemID: String) throws -> JSONValue {
        guard UUID(uuidString: itemID) != nil else { throw ClientError.invalidRequest }
        return try RemoteCommands.checked(.object(["type": .string(type), "threadId": .string(threadID), "itemId": .string(itemID)]))
    }
    /// Photos and files together: eight at most, photos 20 MiB between them and everything 50 MiB (ADR-0131).
    private static func reply(_ type: String, threadID: String, text: String, draftID: String, images: [StagedImage], files: [StagedFile]) throws -> JSONValue {
        let ids = images.map(\.id) + files.map(\.id)
        let imageBytes = images.reduce(0, { $0 + $1.sizeBytes })
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ids.isEmpty, text.utf16.count <= 100_000,
              UUID(uuidString: draftID) != nil, ids.count <= PhotoLimits.count, images.allSatisfy(\.valid), files.allSatisfy(\.valid),
              Set(ids).count == ids.count, imageBytes <= PhotoLimits.bytesTogether,
              files.reduce(imageBytes, { $0 + $1.sizeBytes }) <= FileLimits.bytesTogether else { throw ClientError.invalidRequest }
        var fields: [String: JSONValue] = ["type": .string(type), "threadId": .string(threadID), "text": .string(text), "draftId": .string(draftID)]
        if !ids.isEmpty { fields["attachments"] = .array(images.map(\.wire) + files.map(\.wire)) }
        return try RemoteCommands.checked(.object(fields))
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
              current.supported, current.asksTheSame(as: request) else { throw ClientError.invalidRequest }
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
        if kind == "answer" { return receipt.confirmsAnswer }
        // Completed transport receipt only confirms provider delivery when its draft status agrees.
        if let draftID, let delivery = deliveries.first(where: { $0.draftId == draftID && $0.threadId == threadID }) {
            return delivery.status == "accepted" || delivery.status == "failed"
        }
        return draftID == nil && receipt.status == "completed" && receipt.error == nil
    }
}
