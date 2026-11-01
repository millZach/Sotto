import Foundation

/// Optional host-v1 page projection. Provider names and display states remain strings for future hosts.
/// These are display records, never permissions; each answer is still checked on its owning computer.
public struct WatcherTarget: Codable, Equatable, Sendable {
    public let hostId: String
    public let threadId: String
    public init(hostId: String, threadId: String) { self.hostId = hostId; self.threadId = threadId }
}
public struct WatcherPhoneState: Decodable, Equatable, Sendable {
    public let hostId: String
    public let current: Current?
    public let conversation: Conversation
    public let receiptGroups: [ReceiptGroup]
    public let watchedThreads: [WatchedThread]
    public let needsYou: [RequestCard]
    public let inFlight: Int
    public let inFlightLimit: Int
    public let working: Bool
    public let recoveryNotice: String?
    public let observedAt: String
    public let draftDeliveries: [DraftDelivery]?
    public let runtimeMode: String?
    public let standingWatches: [StandingWatch]?
    public let ownChanges: [OwnChange]?
    /// The user's own follow-ups waiting in Watcher's queue, first in line first: what goes next, after Watcher's turn.
    /// Nil from a computer that doesn't take a steer from this iPhone (#1229).
    public let followups: [Followup]?
    /// Each machine and what works on it, for the machines line (#1032). Nil from a computer without Work across machines,
    /// or for an iPhone that did not accept `watcher-phone-machines`.
    public let machines: WatcherMachines?
    /// For Watcher's box, nil from an older computer (`watcher-phone-composer`): what New Watcher would answer now
    /// (`available`, `busy` or `empty`), whether a handover of the last Watcher is offered to this one, and whether this
    /// Watcher replaced an earlier conversation.
    public let newWatcher: String?
    public let handoverOffered: Bool?
    public let replaced: Bool?
    /// Watcher's model, effort or speed chosen while it worked, which its next turn starts on (`watcher-phone-settings-later`).
    /// Nil when nothing waits, and from an older computer.
    public let nextTurnOptions: NextTurnOptions?
    public struct DraftDelivery: Decodable, Equatable, Sendable { public let draftId: String; public let status: String }
    /// A choice kept for Watcher's next turn: the model, its effort (nil for the model's default) and its speed, which
    /// stays Watcher's own unless the choice names one (`speedChosen`); a named nil speed is Standard.
    public struct NextTurnOptions: Decodable, Equatable, Sendable {
        public let modelId: String
        public let reasoningEffort: String?
        public let speedChosen: Bool
        public let speed: String?
        public init(modelId: String, reasoningEffort: String?, speedChosen: Bool = false, speed: String? = nil) {
            self.modelId = modelId; self.reasoningEffort = reasoningEffort; self.speedChosen = speedChosen; self.speed = speed
        }
        private enum CodingKeys: String, CodingKey { case modelId, reasoningEffort, speed }
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            modelId = try container.decode(String.self, forKey: .modelId)
            reasoningEffort = try container.decodeIfPresent(String.self, forKey: .reasoningEffort)
            speedChosen = container.contains(.speed)
            speed = try container.decodeIfPresent(String.self, forKey: .speed)
        }
    }
    /// One follow-up waiting for Watcher: its queue item, the draft it went with, its words, and `queued`, `dispatching`,
    /// `uncertain`, `failed` or `paused`.
    public struct Followup: Decodable, Equatable, Identifiable, Sendable {
        public let itemId: String; public var id: String { itemId }
        public let draftId: String; public let text: String; public let status: String
    }
    public struct StandingWatch: Decodable, Equatable, Sendable {
        public let id: String; public let target: WatcherTarget; public let createdAt: String; public let generation: Int
        public let pausedByUserMessageId: String?; public let lastUserMessageId: String?
    }
    public struct OwnChange: Decodable, Equatable, Sendable {
        public let replyMessageId: String; public let turnId: String; public let files: [String]; public let fileCount: Int
        public let reason: String?; public let source: String
    }

    public struct Current: Decodable, Equatable, Sendable {
        public let target: WatcherTarget; public let provider: String; public let modelId: String
        public let reasoningEffort: String?; public let status: String; public let connected: Bool
        public let runtimeMode: String?
        /// Whether Watcher's provider takes a steer into its running turn. Nil from a computer that doesn't say (#1229).
        public let steers: Bool?
        /// Watcher's speed, `fast` or `ultrafast`; nil at Standard, and from a computer that doesn't say.
        public let speed: String?
    }
    public struct Conversation: Decodable, Equatable, Sendable {
        public let messages: [Message]; public let earlierAvailable: Bool; public let revision: Int
    }
    public struct ReceiptGroup: Decodable, Equatable, Sendable {
        public let replyMessageId: String?; public let requestId: String; public let rows: [Receipt]
    }
    public struct Receipt: Decodable, Equatable, Identifiable, Sendable {
        public let operationId: String; public var id: String { operationId }
        public let target: WatcherTarget; public let title: String; public let provider: String?
        public let action: String; public let delivery: String?; public let deliveryState: String
        public let createdAt: String; public let updatedAt: String; public let refusalCode: String?
        /// Where a start or send stands: working, background, answered, failed, stopped, paused or unknown. Nil from a
        /// computer that reports none, and for a stop or settle.
        public let outcome: String?
    }
    public struct WatchedThread: Decodable, Equatable, Sendable {
        public let target: WatcherTarget; public let title: String; public let provider: String?
        public let status: String; public let connected: Bool; public let watched: Bool; public let takenOver: Bool
        public let backgroundWorkCount: Int
        public let paused: Bool?
    }
    public struct RequestCard: Decodable, Equatable, Sendable {
        public let target: WatcherTarget; public let title: String; public let provider: String?
        public let request: AgentRequest; public let connected: Bool; public let mayAnswer: Bool
    }
    /// Only the current Watcher belongs to this serving computer. Workers retain their own host identities.
    public func validate(hostID: String) throws {
        guard hostId == hostID, current == nil || current?.target.hostId == hostID,
              (1...8).contains(inFlightLimit), inFlight >= 0 else { throw ClientError.invalidIdentity }
    }
}

public struct WatcherRefusal: Decodable, Equatable, Sendable {
    public let status: String; public let code: String; public let message: String; public let retryable: Bool
}
private enum WatcherResultStatus: String {
    case ok, refused
    private enum Keys: String, CodingKey { case status }
    static func decode(from decoder: Decoder) throws -> Self {
        let c = try decoder.container(keyedBy: Keys.self)
        guard let status = Self(rawValue: try c.decode(String.self, forKey: .status)) else { throw ClientError.invalidProtocol }
        return status
    }
}
public enum WatcherPhoneResult: Decodable, Sendable {
    case ok(WatcherPhoneState)
    case refused(WatcherRefusal)
    private enum Keys: String, CodingKey { case state }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try WatcherResultStatus.decode(from: decoder) {
        case .ok: self = .ok(try c.decode(WatcherPhoneState.self, forKey: .state))
        case .refused: self = .refused(try WatcherRefusal(from: decoder))
        }
    }
}
public enum WatcherSendResult: Decodable, Sendable {
    case ok(draftID: String, state: WatcherPhoneState)
    case refused(WatcherRefusal)
    private enum Keys: String, CodingKey { case draftId, state }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try WatcherResultStatus.decode(from: decoder) {
        case .ok: self = .ok(draftID: try c.decode(String.self, forKey: .draftId), state: try c.decode(WatcherPhoneState.self, forKey: .state))
        case .refused: self = .refused(try WatcherRefusal(from: decoder))
        }
    }
}
public enum WatcherStopPreviewResult: Decodable, Sendable {
    case ok(WatcherStopPreview)
    case refused(WatcherRefusal)
    public init(from decoder: Decoder) throws {
        switch try WatcherResultStatus.decode(from: decoder) {
        case .ok: self = .ok(try WatcherStopPreview(from: decoder))
        case .refused: self = .refused(try WatcherRefusal(from: decoder))
        }
    }
}
public struct WatcherStopPreview: Decodable, Equatable, Sendable {
    public let confirmationId: String; public let expiresAt: String; public let targets: [Target]
    public struct Target: Decodable, Equatable, Sendable {
        public let hostId: String; public let threadId: String; public let title: String; public let provider: String?
    }
}
public enum WatcherStopResult: Decodable, Sendable {
    case ok(WatcherPhoneState, [StoppedTarget])
    case refused(WatcherRefusal)
    private enum Keys: String, CodingKey { case state, results }
    public struct StoppedTarget: Decodable, Equatable, Sendable {
        public let target: WatcherTarget; public let status: String; public let message: String
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try WatcherResultStatus.decode(from: decoder) {
        case .ok: self = .ok(try c.decode(WatcherPhoneState.self, forKey: .state), try c.decode([StoppedTarget].self, forKey: .results))
        case .refused: self = .refused(try WatcherRefusal(from: decoder))
        }
    }
}
/// A Stop all receipt keeps the exact mutation outcome; read the page again for current state.
public enum WatcherStopReceipt: Decodable, Sendable {
    case ok([WatcherStopResult.StoppedTarget])
    case refused(WatcherRefusal)
    private enum Keys: String, CodingKey { case results }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try WatcherResultStatus.decode(from: decoder) {
        case .ok: self = .ok(try c.decode([WatcherStopResult.StoppedTarget].self, forKey: .results))
        case .refused: self = .refused(try WatcherRefusal(from: decoder))
        }
    }
}
/// Management retries recover their mutation outcome and read fresh page state separately.
public enum WatcherManageReceipt: Decodable, Sendable {
    case ok
    case refused(WatcherRefusal)
    public init(from decoder: Decoder) throws {
        switch try WatcherResultStatus.decode(from: decoder) {
        case .ok: self = .ok
        case .refused: self = .refused(try WatcherRefusal(from: decoder))
        }
    }
}
public enum WatcherWire {
    public static let feature = "watcher-phone"
    public static let stopFeature = "watcher-phone-stop-all"
    public static let manageFeature = "watcher-phone-manage"
    /// Send steers into Watcher's running turn, or the message goes next, and a follow-up waiting for Watcher can be removed (#1229).
    public static let steerFeature = "watcher-phone-steer"
    /// A send may carry the photos this iPhone staged, with words or alone, and a Watcher message's photos are read back
    /// through `preview`: Watcher's thread is never one of this iPhone's own to read (October 23, 2026).
    public static let photosFeature = "watcher-phone-photos"
    /// A send's `images` may also name files this iPhone staged, on a computer that keeps files (ADR-0131, October 28 amendment).
    public static let filesFeature = "watcher-phone-files"
    /// Watcher's box takes the thread box's line (October 31, 2026): its model, effort and speed, another provider's model
    /// starting a new Watcher; New Watcher; Stop on Watcher's own turn; and the handover of the last Watcher.
    public static let composerFeature = "watcher-phone-composer"
    /// The computer keeps a change to Watcher's model, effort or speed made while Watcher works for its next turn, and its
    /// page says what waits (`nextTurnOptions`), rather than refusing it until Watcher rests (November 1, 2026).
    public static let settingsLaterFeature = "watcher-phone-settings-later"
    /// Views opt in to management only when they can present the controls and recover mutation receipts. Steering rides
    /// with it: its Remove recovers its outcome from the same receipt. So does the machines line (#1032), which reads only.
    public static var managementHello: [String: JSONValue] {
        var result = hello
        if case .array(let accepts)? = result["accepts"] { result["accepts"] = .array(accepts + [.string(manageFeature), .string(steerFeature), .string(machinesFeature), .string(composerFeature)]) }
        return result
    }
    public static func setPermission(runtimeMode: String) throws -> [String: JSONValue] {
        guard ["approval-required", "auto-accept-edits", "auto", "full-access"].contains(runtimeMode) else { throw ClientError.invalidRequest }
        return ["op": .string("watcher-phone-set-permission"), "request": .object(["runtimeMode": .string(runtimeMode)])]
    }
    public static func watch(target: WatcherTarget) -> [String: JSONValue] { targetOperation("watcher-phone-watch", target) }
    public static func unwatch(target: WatcherTarget) -> [String: JSONValue] { targetOperation("watcher-phone-unwatch", target) }
    /// Watcher's model, effort or speed, through the computer's own Watcher open: another provider's model starts a new
    /// Watcher there. A speed of `standard` goes as null; nil leaves the speed as it is.
    public static func open(target: WatcherTarget, provider: String, modelID: String, effort: String? = nil, speed: String? = nil) -> [String: JSONValue] {
        var request: [String: JSONValue] = ["target": targetValue(target), "provider": .string(provider), "modelId": .string(modelID)]
        if let effort, !effort.isEmpty { request["reasoningEffort"] = .string(effort) }
        if let speed { request["speed"] = speed == ThreadSettings.standard ? .null : .string(speed) }
        return ["op": .string("watcher-phone-open"), "request": .object(request)]
    }
    /// New Watcher, on the current one's provider, model, effort, speed and permissions, with a handover of this one offered.
    public static func startNew(target: WatcherTarget) -> [String: JSONValue] { targetOperation("watcher-phone-new", target) }
    /// Stops Watcher's own turn.
    public static func stopTurn(target: WatcherTarget) -> [String: JSONValue] { targetOperation("watcher-phone-stop-turn", target) }
    /// Puts the handover offer away: the new Watcher's first message goes without it.
    public static func dismissHandover(target: WatcherTarget) -> [String: JSONValue] { targetOperation("watcher-phone-dismiss-handover", target) }
    /// An operation whose request names one thread: a watched one, or the current Watcher.
    private static func targetOperation(_ operation: String, _ target: WatcherTarget) -> [String: JSONValue] {
        ["op": .string(operation), "request": .object(["target": targetValue(target)])]
    }
    private static func targetValue(_ target: WatcherTarget) -> JSONValue {
        .object(["hostId": .string(target.hostId), "threadId": .string(target.threadId)])
    }
    /// Ticket 8b opts in when its UI can show the page; existing phones keep their unchanged hello.
    public static var hello: [String: JSONValue] {
        var result = Wire.snapshotHello
        if let value = result["accepts"], case .array(let accepts) = value { result["accepts"] = .array(accepts + [.string(feature), .string(stopFeature)]) }
        return result
    }
    public static let read: [String: JSONValue] = ["op": .string("watcher-phone-read")]
    public static let prepareStop: [String: JSONValue] = ["op": .string("watcher-phone-prepare-stop-all")]
    /// With `steer`, only to a computer that offers `steerFeature`: while Watcher works the words steer into its turn, or
    /// go next as their own turn when they can't.
    /// `images` only to a computer that offers `photosFeature`, and `files` only to one that offers `filesFeature`; both go in
    /// the request's `images`, with the words however the words go. `handover` only to a computer that offers
    /// `composerFeature`, while its page offers one: the words go after the last Watcher's handover.
    public static func send(target: WatcherTarget, clientID: String, draftID: String, text: String, steer: Bool = false,
                            images: [StagedImage] = [], files: [StagedFile] = [], handover: Bool = false) -> [String: JSONValue] {
        var request: [String: JSONValue] = [
            "origin": .object(["kind": .string("phone"), "hostId": .string(target.hostId), "clientId": .string(clientID)]),
            "target": .object(["hostId": .string(target.hostId), "threadId": .string(target.threadId)]),
            "draftId": .string(draftID), "text": .string(text)]
        if steer { request["delivery"] = .string("steer") }
        if handover { request["handover"] = .bool(true) }
        if !images.isEmpty || !files.isEmpty { request["images"] = .array(images.map(\.wire) + files.map(\.wire)) }
        return ["op": .string("watcher-phone-send"), "request": .object(request)]
    }
    /// One photo of a message in Watcher's conversation, answered as `Photos.preview` is for a thread.
    public static func preview(target: WatcherTarget, messageID: String, attachmentID: String) -> [String: JSONValue] {
        ["op": .string("watcher-phone-preview"), "request": .object([
            "target": .object(["hostId": .string(target.hostId), "threadId": .string(target.threadId)]),
            "messageId": .string(messageID), "attachmentId": .string(attachmentID)])]
    }
    /// Takes a follow-up out of Watcher's queue before it goes, by its queue item.
    public static func removeFollowup(target: WatcherTarget, itemID: String) -> [String: JSONValue] {
        ["op": .string("watcher-phone-remove-followup"), "request": .object([
            "target": .object(["hostId": .string(target.hostId), "threadId": .string(target.threadId)]), "itemId": .string(itemID)])]
    }
    public static func answer(target: WatcherTarget, command: [String: JSONValue]) throws -> [String: JSONValue] {
        guard command["type"] == .string("answer"), command["threadId"] == .string(target.threadId) else { throw ClientError.invalidRequest }
        return ["op": .string("watcher-phone-answer"), "request": .object([
            "target": .object(["hostId": .string(target.hostId), "threadId": .string(target.threadId)]), "command": .object(command)])]
    }
    public static func stop(confirmationID: String) -> [String: JSONValue] {
        ["op": .string("watcher-phone-stop-all"), "confirmationId": .string(confirmationID)]
    }
}
