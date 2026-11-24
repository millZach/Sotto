import Foundation

/// Optional host-v1 page projection. Provider names and display states remain strings for future hosts.
/// These are display records, never permissions; each answer is still checked on its owning computer.
public struct WatcherTarget: Codable, Equatable, Sendable {
    public let hostId: String
    public let threadId: String
    public init(hostId: String, threadId: String) { self.hostId = hostId; self.threadId = threadId }
}
public struct WatcherPhoneState: Decodable, Equatable, Sendable {
    public private(set) var hostId: String
    public private(set) var current: Current?
    public private(set) var conversation: Conversation
    public private(set) var receiptGroups: [ReceiptGroup]
    public private(set) var watchedThreads: [WatchedThread]
    public private(set) var needsYou: [RequestCard]
    public private(set) var inFlight: Int
    public private(set) var inFlightLimit: Int
    public private(set) var working: Bool
    public private(set) var recoveryNotice: String?
    public private(set) var observedAt: String
    public private(set) var draftDeliveries: [DraftDelivery]?
    public private(set) var runtimeMode: String?
    public private(set) var standingWatches: [StandingWatch]?
    public private(set) var ownChanges: [OwnChange]?
    /// The user's own follow-ups waiting in Watcher's queue, first in line first: what goes next, after Watcher's turn.
    /// Nil from a computer that doesn't take a steer from this iPhone (#1229).
    public private(set) var followups: [Followup]?
    /// Each machine and what works on it, for the machines line (#1032). Nil from a computer without Work across machines,
    /// or for an iPhone that did not accept `watcher-phone-machines`.
    public private(set) var machines: WatcherMachines?
    /// For Watcher's box, nil from an older computer (`watcher-phone-composer`): what New Watcher would answer now
    /// (`available`, `busy` or `empty`), whether a handover of the last Watcher is offered to this one, and whether this
    /// Watcher replaced an earlier conversation.
    public private(set) var newWatcher: String?
    public private(set) var handoverOffered: Bool?
    public private(set) var replaced: Bool?
    /// Watcher's model, effort or speed chosen while it worked, which its next turn starts on (`watcher-phone-settings-later`).
    /// Nil when nothing waits, and from an older computer.
    public private(set) var nextTurnOptions: NextTurnOptions?
    /// What changed in `conversation` since the push before (`watcher-phone-parts`). Always nil once a shell leaves
    /// `HostConnection`, which puts the conversation back (`KeptPartsCache`).
    var conversationDelta: ConversationDelta? = nil
    /// What changed in `receiptGroups` since the push before (`watcher-phone-receipt-deltas`). Always nil once a shell
    /// leaves `HostConnection`, which puts the receipt groups back (`KeptPartsCache`).
    var receiptGroupsDelta: ReceiptGroupsDelta? = nil
    public struct ConversationDelta: Decodable, Equatable, Sendable {
        public let dropHead: Int; public let keep: Int; public let appendLastText: String?
        public let tail: [Message]; public let earlierAvailable: Bool; public let revision: Int
    }
    public struct ReceiptGroupsDelta: Decodable, Equatable, Sendable {
        public struct Replacement: Decodable, Equatable, Sendable {
            public let index: Int; public let group: ReceiptGroup
        }
        public let dropHead: Int; public let keep: Int; public let replaced: [Replacement]?; public let tail: [ReceiptGroup]
    }
    private enum Keys: String, CodingKey {
        case hostId, current, conversation, receiptGroups, watchedThreads, needsYou, inFlight, inFlightLimit, working, recoveryNotice, observedAt
        case draftDeliveries, runtimeMode, standingWatches, ownChanges, followups, machines, newWatcher, handoverOffered, replaced, nextTurnOptions
        case kept, conversationDelta, receiptGroupsDelta
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // A push to a phone that accepted `watcher-phone-parts` leaves out unchanged sub-parts named in `kept`, and may
        // replace `conversation` with `conversationDelta` or `receiptGroups` with `receiptGroupsDelta`. Kept required
        // fields read empty until `KeptPartsCache` puts them back.
        let kept = Set(try c.decodeIfPresent([String].self, forKey: .kept) ?? [])
        conversationDelta = try c.decodeIfPresent(ConversationDelta.self, forKey: .conversationDelta)
        receiptGroupsDelta = try c.decodeIfPresent(ReceiptGroupsDelta.self, forKey: .receiptGroupsDelta)
        hostId = kept.contains("hostId") ? (try c.decodeIfPresent(String.self, forKey: .hostId) ?? "") : try c.decode(String.self, forKey: .hostId)
        current = try c.decodeIfPresent(Current.self, forKey: .current)
        if kept.contains("conversation") || conversationDelta != nil {
            conversation = try c.decodeIfPresent(Conversation.self, forKey: .conversation) ?? Conversation(messages: [], earlierAvailable: false, revision: 0)
        } else { conversation = try c.decode(Conversation.self, forKey: .conversation) }
        if kept.contains("receiptGroups") || receiptGroupsDelta != nil {
            receiptGroups = try c.decodeIfPresent([ReceiptGroup].self, forKey: .receiptGroups) ?? []
        } else { receiptGroups = try c.decode([ReceiptGroup].self, forKey: .receiptGroups) }
        watchedThreads = kept.contains("watchedThreads") ? (try c.decodeIfPresent([WatchedThread].self, forKey: .watchedThreads) ?? []) : try c.decode([WatchedThread].self, forKey: .watchedThreads)
        needsYou = kept.contains("needsYou") ? (try c.decodeIfPresent([RequestCard].self, forKey: .needsYou) ?? []) : try c.decode([RequestCard].self, forKey: .needsYou)
        inFlight = kept.contains("inFlight") ? (try c.decodeIfPresent(Int.self, forKey: .inFlight) ?? 0) : try c.decode(Int.self, forKey: .inFlight)
        inFlightLimit = kept.contains("inFlightLimit") ? (try c.decodeIfPresent(Int.self, forKey: .inFlightLimit) ?? 1) : try c.decode(Int.self, forKey: .inFlightLimit)
        working = kept.contains("working") ? (try c.decodeIfPresent(Bool.self, forKey: .working) ?? false) : try c.decode(Bool.self, forKey: .working)
        recoveryNotice = try c.decodeIfPresent(String.self, forKey: .recoveryNotice)
        observedAt = kept.contains("observedAt") ? (try c.decodeIfPresent(String.self, forKey: .observedAt) ?? "") : try c.decode(String.self, forKey: .observedAt)
        draftDeliveries = try c.decodeIfPresent([DraftDelivery].self, forKey: .draftDeliveries)
        runtimeMode = try c.decodeIfPresent(String.self, forKey: .runtimeMode)
        standingWatches = try c.decodeIfPresent([StandingWatch].self, forKey: .standingWatches)
        ownChanges = try c.decodeIfPresent([OwnChange].self, forKey: .ownChanges)
        followups = try c.decodeIfPresent([Followup].self, forKey: .followups)
        machines = try c.decodeIfPresent(WatcherMachines.self, forKey: .machines)
        newWatcher = try c.decodeIfPresent(String.self, forKey: .newWatcher)
        handoverOffered = try c.decodeIfPresent(Bool.self, forKey: .handoverOffered)
        replaced = try c.decodeIfPresent(Bool.self, forKey: .replaced)
        nextTurnOptions = try c.decodeIfPresent(NextTurnOptions.self, forKey: .nextTurnOptions)
    }
    /// Restores each sub-part named in `kept` and applies `conversationDelta` from `held` (`KeptPartsCache`).
    /// Returns false if a delta is out of bounds or conflicts with `conversation` or `kept`.
    mutating func putBack(_ kept: Set<String>, carried: Set<String>, from held: WatcherPhoneState) -> Bool {
        func keeps(_ name: String) -> Bool { kept.contains(name) && !carried.contains(name) }
        if let delta = conversationDelta {
            guard !carried.contains("conversation"), !kept.contains("conversation") else { return false }
            let previous = held.conversation.messages
            guard delta.dropHead >= 0, delta.keep >= 0, delta.dropHead <= previous.count,
                  delta.keep <= previous.count - delta.dropHead else { return false }
            if delta.appendLastText != nil, delta.keep == 0 { return false }
            var messages = Array(previous[delta.dropHead..<(delta.dropHead + delta.keep)])
            if let suffix = delta.appendLastText {
                let old = messages[messages.count - 1]
                messages[messages.count - 1] = Message(id: old.id, role: old.role, text: old.text + suffix, commandId: old.commandId,
                                                       attachments: old.attachments, createdAt: old.createdAt, model3d: old.model3d)
            }
            messages.append(contentsOf: delta.tail)
            conversation = Conversation(messages: messages, earlierAvailable: delta.earlierAvailable, revision: delta.revision)
            conversationDelta = nil
        } else if keeps("conversation") {
            conversation = held.conversation
        }
        if keeps("hostId") { hostId = held.hostId }
        if keeps("current") { current = held.current }
        if let delta = receiptGroupsDelta {
            guard !carried.contains("receiptGroups"), !kept.contains("receiptGroups") else { return false }
            let previous = held.receiptGroups
            guard delta.dropHead >= 0, delta.keep >= 0, delta.dropHead <= previous.count,
                  delta.keep <= previous.count - delta.dropHead else { return false }
            var groups = Array(previous[delta.dropHead..<(delta.dropHead + delta.keep)])
            if let replaced = delta.replaced {
                for patch in replaced {
                    guard patch.index >= 0, patch.index < groups.count else { return false }
                    groups[patch.index] = patch.group
                }
            }
            groups.append(contentsOf: delta.tail)
            receiptGroups = groups
            receiptGroupsDelta = nil
        } else if keeps("receiptGroups") { receiptGroups = held.receiptGroups }
        if keeps("watchedThreads") { watchedThreads = held.watchedThreads }
        if keeps("needsYou") { needsYou = held.needsYou }
        if keeps("inFlight") { inFlight = held.inFlight }
        if keeps("inFlightLimit") { inFlightLimit = held.inFlightLimit }
        if keeps("working") { working = held.working }
        if keeps("recoveryNotice") { recoveryNotice = held.recoveryNotice }
        if keeps("observedAt") { observedAt = held.observedAt }
        if keeps("draftDeliveries") { draftDeliveries = held.draftDeliveries }
        if keeps("runtimeMode") { runtimeMode = held.runtimeMode }
        if keeps("standingWatches") { standingWatches = held.standingWatches }
        if keeps("ownChanges") { ownChanges = held.ownChanges }
        if keeps("followups") { followups = held.followups }
        if keeps("machines") { machines = held.machines }
        if keeps("newWatcher") { newWatcher = held.newWatcher }
        if keeps("handoverOffered") { handoverOffered = held.handoverOffered }
        if keeps("replaced") { replaced = held.replaced }
        if keeps("nextTurnOptions") { nextTurnOptions = held.nextTurnOptions }
        return true
    }
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
    /// Replaces only `machines` from a compact `watcher-phone-machines-read` response.
    public func replacingMachines(_ updated: WatcherMachines) -> WatcherPhoneState {
        var copy = self
        copy.machines = updated
        return copy
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
/// Compact answer to `watcher-phone-read` (`machines: true`) from a computer offering `watcher-phone-machines-read`.
public enum WatcherPhoneMachinesResult: Decodable, Sendable {
    case ok(WatcherMachines)
    case refused(WatcherRefusal)
    private enum Keys: String, CodingKey { case machines }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try WatcherResultStatus.decode(from: decoder) {
        case .ok: self = .ok(try c.decode(WatcherMachines.self, forKey: .machines))
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
    /// A shell push whose Watcher page changed omits unchanged sub-parts (`watcher.kept`) and sends a changed conversation
    /// as `watcher.conversationDelta` when it shares messages with the push before (`KeptPartsCache`).
    public static let partsFeature = "watcher-phone-parts"
    /// A shell push whose `receiptGroups` changed sends `watcher.receiptGroupsDelta` instead of the full list (`KeptPartsCache`).
    public static let receiptDeltasFeature = "watcher-phone-receipt-deltas"
    /// Views opt in to management only when they can present the controls and recover mutation receipts. Steering rides
    /// with it: its Remove recovers its outcome from the same receipt. So does the machines line (#1032), which reads only.
    public static var managementHello: [String: JSONValue] {
        var result = hello
        if case .array(let accepts)? = result["accepts"] {
            result["accepts"] = .array(accepts + [.string(manageFeature), .string(steerFeature), .string(machinesFeature), .string(machinesReadFeature), .string(composerFeature), .string(partsFeature), .string(receiptDeltasFeature)])
        }
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
