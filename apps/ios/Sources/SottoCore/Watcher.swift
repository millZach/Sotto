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
    public struct DraftDelivery: Decodable, Equatable, Sendable { public let draftId: String; public let status: String }
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
    /// Views opt in to management only when they can present the controls and recover mutation receipts.
    public static var managementHello: [String: JSONValue] {
        var result = hello
        if case .array(let accepts)? = result["accepts"] { result["accepts"] = .array(accepts + [.string(manageFeature)]) }
        return result
    }
    public static func setPermission(runtimeMode: String) throws -> [String: JSONValue] {
        guard ["approval-required", "auto-accept-edits", "auto", "full-access"].contains(runtimeMode) else { throw ClientError.invalidRequest }
        return ["op": .string("watcher-phone-set-permission"), "request": .object(["runtimeMode": .string(runtimeMode)])]
    }
    public static func watch(target: WatcherTarget) -> [String: JSONValue] { watchOperation("watcher-phone-watch", target) }
    public static func unwatch(target: WatcherTarget) -> [String: JSONValue] { watchOperation("watcher-phone-unwatch", target) }
    private static func watchOperation(_ operation: String, _ target: WatcherTarget) -> [String: JSONValue] {
        ["op": .string(operation), "request": .object(["target": .object(["hostId": .string(target.hostId), "threadId": .string(target.threadId)])])]
    }
    /// Ticket 8b opts in when its UI can show the page; existing phones keep their unchanged hello.
    public static var hello: [String: JSONValue] {
        var result = Wire.snapshotHello
        if let value = result["accepts"], case .array(let accepts) = value { result["accepts"] = .array(accepts + [.string(feature), .string(stopFeature)]) }
        return result
    }
    public static let read: [String: JSONValue] = ["op": .string("watcher-phone-read")]
    public static let prepareStop: [String: JSONValue] = ["op": .string("watcher-phone-prepare-stop-all")]
    public static func send(target: WatcherTarget, clientID: String, draftID: String, text: String) -> [String: JSONValue] {
        ["op": .string("watcher-phone-send"), "request": .object([
            "origin": .object(["kind": .string("phone"), "hostId": .string(target.hostId), "clientId": .string(clientID)]),
            "target": .object(["hostId": .string(target.hostId), "threadId": .string(target.threadId)]),
            "draftId": .string(draftID), "text": .string(text)])]
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
