import Foundation
import SottoCore

/// Scripted dependencies for the real AppModel.swift, compiled into this test target only.
@MainActor enum TestKeychain {
    static var items: [String: Data] = [:]
    static var locked = false
    static var unreadableAccount: String?
    static var unwritableAccount: String?
    static var store: KeychainStore {
        KeychainStore(readData: { account in
            if locked || account == unreadableAccount { throw KeychainStore.failure }
            return items[account]
        }, writeData: { data, account in
            if locked || account == unwritableAccount { throw KeychainStore.failure }
            items[account] = data
        }, removeItem: { account in
            if locked { throw KeychainStore.failure }
            items[account] = nil
        }, listAccounts: {
            if locked { throw KeychainStore.failure }
            return Array(items.keys)
        })
    }
}

struct HostRefusal: Error, LocalizedError {
    let failure: WireFailure
    var errorDescription: String? { failure.message }
}

@MainActor final class HostConnection {
    static var instances: [HostConnection] = []
    static var failDetail = false
    static var failConnect = false
    /// Every attempt to connect, failed ones included.
    static var connectAttempts = 0
    static var revokeFailure: ClientError?
    static var revokeHandler: ((Pairing) async throws -> Void)?
    static var foundHealth: Health?
    static var freshPairing: Pairing?
    static var pairCalls = 0
    static var revoked: [String] = []
    static var holdDetail = false
    static var shell: JSONValue = .null
    static var detail: JSONValue = .null
    static var afterGreeting: ((HostConnection) -> Void)?
    static var mayAnswer = false
    static var receipt: JSONValue = .object(["status": .string("unknown")])
    static var loseAcknowledgement = false
    static var shells: [String: JSONValue] = [:]
    static var features = ["host-folders"]
    static var commandHandler: ((String, JSONValue, String) async throws -> JSONValue)?
    static var folderHandler: ((String, JSONValue) async throws -> JSONValue)?
    /// The computer's answer to `stage-attachment` and `preview`, given the request's image or preview fields.
    static var stageHandler: ((JSONValue) async throws -> JSONValue)?
    static var previewHandler: ((JSONValue) async throws -> JSONValue)?
    static var terminalHandler: ((String, [String: JSONValue], String) async throws -> JSONValue)?
    /// The photo load limit the photo tests give the model: never passing, unless a test says otherwise.
    static var photoLoadLimit: @Sendable () async throws -> Void = { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
    static var receipts: [String: JSONValue] = [:]
    var onPush: ((IncomingFrame, Int) -> Void)?
    var onLiveness: (() -> Void)?
    var onDisconnect: (() -> Void)?
    var operations: [String] = []
    var commands: [JSONValue] = []
    var terminalCalls: [[String: JSONValue]] = []
    var hostID = ""
    var disconnects = 0
    var detailStarted: (() -> Void)?
    var heldDetail: CheckedContinuation<JSONValue, Error>?
    var afterReply: ((String) -> Void)?
    var received = 0
    init() { Self.instances.append(self) }
    func connect(endpoint: HostEndpoint, pairing: Pairing) async throws -> Received<Hello> {
        Self.connectAttempts += 1
        if Self.failConnect { throw URLError(.networkConnectionLost) }
        hostID = pairing.hostId
        let hello = try JSONValue.object(["hostId": .string(pairing.hostId), "clientId": .string(pairing.clientId),
            "shell": Self.shells[hostID] ?? Self.shell, "features": .array(Self.features.map(JSONValue.string)),
            "capabilities": .object(["mayAnswer": .bool(Self.mayAnswer)])]).decode(Hello.self)
        received += 1; let sequence = received
        Self.afterGreeting?(self)
        return Received(hello, sequence: sequence)
    }
    func push(_ frame: IncomingFrame) { received += 1; onPush?(frame, received) }
    func callReceived<T: Decodable & Sendable>(_ operation: [String: JSONValue], as type: T.Type, id: String = UUID().uuidString) async throws -> Received<T> {
        let value = try await call(operation, id: id)
        received += 1; let sequence = received
        afterReply?(operation["op"]?.string ?? "")
        return Received(try value.decode(type), sequence: sequence)
    }
    func call<T: Decodable & Sendable>(_ operation: [String: JSONValue], as type: T.Type, id: String = UUID().uuidString) async throws -> T {
        try await call(operation, id: id).decode(type)
    }
    func call(_ operation: [String: JSONValue], id: String = UUID().uuidString) async throws -> JSONValue {
        let op = operation["op"]?.string ?? ""
        operations.append(op)

        if ["terminal-approval", "answer-terminal", "observe-terminals"].contains(op) {
            terminalCalls.append(operation)
            if let handler = Self.terminalHandler { return try await handler(op, operation, id) }
            return .null
        }

        if op == "observe", case .array(let ids) = operation["threadIds"], let id = ids.first?.string {
            if Self.failDetail { throw ClientError.rejected("Thread read refused") }
            push(.detail(threadID: id, value: try Self.detail.decode(ThreadDetail.self)))
        }
        if op == "detail" {
            if Self.holdDetail {
                return try await withCheckedThrowingContinuation { continuation in
                    heldDetail = continuation; detailStarted?()
                }
            }
            return Self.detail
        }
        if op == "command" {
            let command = operation["command"] ?? .null; commands.append(command)
            if Self.loseAcknowledgement { throw ClientError.uncertain }
            if let handler = Self.commandHandler { return try await handler(hostID, command, id) }
            return Self.shells[hostID] ?? Self.shell
        }
        if op == "shell" { return Self.shells[hostID] ?? Self.shell }
        if op == "receipt" { return Self.receipts[operation["commandId"]?.string ?? ""] ?? Self.receipt }
        if op == "host-folders", let handler = Self.folderHandler { return try await handler(hostID, operation["request"] ?? .null) }
        if op == "stage-attachment", let handler = Self.stageHandler { return try await handler(operation["image"] ?? .null) }
        if op == "preview", let handler = Self.previewHandler { return try await handler(operation["request"] ?? .null) }
        return .null
    }
    func disconnect() { disconnects += 1 }
    func close() { disconnect() }
    func health(endpoint: HostEndpoint) async throws -> Health { guard let health = Self.foundHealth else { throw ClientError.disconnected }; return health }
    func pair(endpoint: HostEndpoint, expectedHostID: String, code: String) async throws -> Pairing { Self.pairCalls += 1; guard let pairing = Self.freshPairing else { throw ClientError.disconnected }; return pairing }
    func revoke(endpoint: HostEndpoint, pairing: Pairing) async throws {
        Self.revoked.append(pairing.clientId)
        if let failure = Self.revokeFailure { throw failure }
        try await Self.revokeHandler?(pairing)
    }
}
