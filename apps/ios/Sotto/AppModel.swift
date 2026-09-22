import Foundation
import SwiftUI
import SottoCore

@MainActor final class AppModel: ObservableObject {
    @Published private(set) var saved: SavedHost?
    @Published private(set) var shell: Shell?
    @Published private(set) var detail: ThreadDetail?
    @Published private(set) var selectedID: String?
    @Published private(set) var pending: [PendingOperation] = []
    @Published private(set) var online = false
    @Published private(set) var working = false
    @Published private(set) var storageReady = false
    @Published private(set) var mayAnswer = false
    @Published var feedback: String?
    @Published var drafts: [String: String] = [:]
    @Published private(set) var submitted: [String: String] = [:]
    @Published private(set) var failedReplies: [String: String] = [:]
    private let keychain = KeychainStore()
    private let connection = HostConnection()
    private var active = false
    private var generation = UUID()
    private var detailVersion = 0
    private var reconnectTask: Task<Void, Never>?
    var selected: ThreadSummary? { shell?.host.threads.first { $0.id == selectedID } }
    var threads: [ThreadSummary] { shell?.host.threads.filter { $0.archivedAt == nil } ?? [] }
    private var scopedPending: [PendingOperation] {
        guard let saved else { return [] }
        return pending.filter { $0.matches(hostID: saved.pairing.hostId, clientID: saved.pairing.clientId) }
    }
    var selectedPending: [PendingOperation] { scopedPending.filter { $0.threadID == selectedID } }
    var canAct: Bool { online && !working && selected != nil && selectedPending.isEmpty }
    var provider: Provider? { shell?.host.providers?.first { $0.id == selected?.providerId } }
    var canSend: Bool { canAct && selected?.status != "running" && selected?.requests.isEmpty == true && (provider?.capabilities.submit ?? shell?.host.capabilities.submit ?? false) && (provider == nil || provider?.connection == "connected") }
    var canInterrupt: Bool { canAct && selected?.status == "running" && (provider?.capabilities.interrupt ?? shell?.host.capabilities.interrupt ?? false) }
    func canAnswer(_ request: AgentRequest) -> Bool {
        canAct && mayAnswer && request.supported && (request.kind == "permission" ? (provider?.capabilities.permissions ?? shell?.host.capabilities.permissions ?? false) : (provider?.capabilities.questions ?? shell?.host.capabilities.questions ?? false))
    }
    init() {
        do {
            saved = try keychain.read(SavedHost.self, account: "host")
            pending = try keychain.read([PendingOperation].self, account: "pending") ?? []
            if let saved { try saved.pairing.validate(); _ = try HostEndpoint(saved.address)
                pending = pending.filter { $0.matches(hostID: saved.pairing.hostId, clientID: saved.pairing.clientId) }
            }
            storageReady = true
        } catch { feedback = "Secure connection details could not be read. Unlock this iPhone and reopen Sotto." }
        connection.onPush = { [weak self] frame in self?.push(frame) }
        connection.onDisconnect = { [weak self] in self?.online = false; self?.feedback = "Connection lost. Work continues on the host. Reconnect to check the thread." }
    }
    func phase(_ phase: ScenePhase) {
        if phase == .active {
            guard !active else { return }; active = true
            reconnectTask = Task { await reconnect() }
        } else if phase == .background {
            active = false; generation = UUID(); reconnectTask?.cancel(); connection.disconnect()
            online = false; working = false; mayAnswer = false; detail = nil
        }
    }
    func pair(address: String, code: String) async {
        guard !working, storageReady else { return }; working = true; feedback = nil
        let current = generation
        do {
            let endpoint = try HostEndpoint(address)
            let pairing = try await connection.pair(endpoint: endpoint, code: code.trimmingCharacters(in: .whitespacesAndNewlines))
            guard current == generation else { return }
            let host = SavedHost(address: endpoint.url.absoluteString, pairing: pairing)
            // Old orphan markers must never be attached to a newly paired host/client.
            try keychain.write([PendingOperation](), account: "pending")
            try keychain.write(host, account: "host")
            pending = []; saved = host; working = false
            await reconnect()
        } catch { if current == generation { feedback = error.localizedDescription; working = false } }
    }
    func reconnect() async {
        guard let saved, storageReady, !working else { return }
        generation = UUID(); let current = generation
        working = true; online = false; mayAnswer = false; detail = nil; feedback = nil
        defer { if current == generation { working = false } }
        do {
            let hello = try await connection.connect(endpoint: HostEndpoint(saved.address), pairing: saved.pairing)
            guard current == generation else { return }
            shell = hello.shell; mayAnswer = hello.capabilities.mayAnswer; online = true
            if let selectedID, !threads.contains(where: { $0.id == selectedID }) { self.selectedID = nil }
            try await observeAndRead()
            await checkDelivery()
        } catch {
            guard current == generation else { return }
            online = false; feedback = error.localizedDescription; connection.disconnect()
        }
    }
    func select(_ id: String?) async {
        selectedID = id; detail = nil; detailVersion += 1
        guard online else { return }
        do { try await observeAndRead() } catch { feedback = error.localizedDescription }
    }
    private func observeAndRead() async throws {
        let id = selectedID, current = generation
        _ = try await connection.call(["op": .string("observe"), "threadIds": .array(id.map { [.string($0)] } ?? [])])
        guard current == generation, id == selectedID else { return }
        if let id {
            let version = detailVersion
            let result = try await connection.call(["op": .string("detail"), "threadId": .string(id)])
            try applyDetail(result, threadID: id, epoch: current, versionAtRead: version)
        }
    }
    private func applyDetail(_ value: JSONValue, threadID: String, epoch: UUID, versionAtRead: Int? = nil) throws {
        guard epoch == generation, threadID == selectedID else { return }
        let next: ThreadDetail?
        if value == .null { next = nil } else { next = try value.decode(ThreadDetail.self) }
        if let next, next.threadId != threadID { throw ClientError.invalidIdentity }
        guard SnapshotGuard.accepts(requestGeneration: epoch, currentGeneration: generation,
                                    requestedThread: threadID, selectedThread: selectedID,
                                    incomingRevision: next?.revision, currentRevision: detail?.revision,
                                    changedSinceRead: versionAtRead.map { $0 != detailVersion } ?? false) else { return }
        detail = next; detailVersion += 1
    }
    func send() async {
        guard canSend, let thread = selected, let text = drafts[thread.id], let saved else { return }
        let draft = UUID().uuidString
        do {
            let command = try Commands.prompt(threadID: thread.id, text: text, draftID: draft)
            let operation = PendingOperation(hostID: saved.pairing.hostId, clientID: saved.pairing.clientId, threadID: thread.id, draftID: draft, kind: "reply")
            try remember(operation); submitted[operation.id] = text; drafts[thread.id] = ""
            await dispatch(command, operation: operation)
        } catch { feedback = error.localizedDescription }
    }
    func answer(_ request: AgentRequest, choice: String? = nil, text: String = "", answers: [String: QuestionAnswer] = [:]) async {
        guard canAnswer(request), let thread = selected, let saved else { return }
        do {
            let command = try Commands.answer(threadID: thread.id, request: request, currentRequests: thread.requests, choice: choice, text: text, answers: answers)
            let operation = PendingOperation(hostID: saved.pairing.hostId, clientID: saved.pairing.clientId, threadID: thread.id, requestID: request.id, kind: "answer")
            try remember(operation); await dispatch(command, operation: operation)
        } catch { feedback = error.localizedDescription }
    }
    func interrupt() async {
        guard canInterrupt, let thread = selected, let saved else { return }
        do {
            let command = try Commands.interrupt(threadID: thread.id)
            let operation = PendingOperation(hostID: saved.pairing.hostId, clientID: saved.pairing.clientId, threadID: thread.id, kind: "interrupt")
            try remember(operation)
            await dispatch(command, operation: operation)
        } catch { feedback = error.localizedDescription }
    }
    func earlier() async {
        guard online, let id = selectedID else { return }
        let current = generation
        do {
            let command = try Commands.loadEarlier(threadID: id)
            _ = try await connection.call(["op": .string("command"), "command": command])
            guard current == generation, id == selectedID else { return }
            try await observeAndRead()
        } catch { if current == generation { feedback = error.localizedDescription } }
    }
    private func remember(_ operation: PendingOperation) throws {
        guard pending.count < 100 else { throw ClientError.rejected("Check the unconfirmed actions before sending more.") }
        let next = scopedPending + [operation]; try keychain.write(next, account: "pending"); pending = next
    }
    private func forgetMarker(_ id: String) throws {
        let next = pending.filter { $0.id != id }; try keychain.write(next, account: "pending"); pending = next; submitted.removeValue(forKey: id)
    }
    private func dispatch(_ command: JSONValue, operation: PendingOperation) async {
        let current = generation
        do {
            let result = try await connection.call(["op": .string("command"), "command": command], id: operation.id)
            guard current == generation else { return }
            try applyShell(result)
            await checkDelivery()
        } catch let error as HostRefusal {
            guard current == generation else { return }
            // Revocation can replace an acknowledgement AFTER the action ran.
            // Generic unavailable failures may also follow provider side effects.
            if ["invalid_request", "stale_request", "forbidden", "busy"].contains(error.failure.code) {
                do { try rejectOperation(operation) } catch { feedback = error.localizedDescription; return }
            }
            if error.failure.code == "forbidden" { mayAnswer = false }
            if error.failure.code == "unauthenticated" { online = false }
            feedback = error.localizedDescription
        } catch { if current == generation { feedback = "Delivery is unconfirmed. Reconnect and check the thread before sending again." } }
    }
    func checkDelivery() async {
        guard online else { return }
        let current = generation
        do {
            let fresh = try await connection.call(["op": .string("shell")])
            guard current == generation else { return }
            try applyShell(fresh)
            for item in scopedPending {
                let receipt = try await connection.call(["op": .string("receipt"), "commandId": .string(item.id)]).decode(Receipt.self)
                guard current == generation else { return }
                guard scopedPending.contains(where: { $0.id == item.id }) else { continue }
                let delivery = shell?.deliveries?.first { $0.threadId == item.threadID && $0.draftId == item.draftID }
                let accepted = shell?.deliveredDrafts?.contains { $0.threadId == item.threadID && $0.draftId == item.draftID } == true || delivery?.status == "accepted"
                let uncertainRequest = shell?.host.threads.first { $0.id == item.threadID }?.requests.contains { $0.id == item.requestID && $0.delivery == "uncertain" } == true
                if delivery?.status == "failed" {
                    try rejectOperation(item); feedback = "Reply was not sent. Your text is available below."
                } else if accepted || (shell?.error == nil && !uncertainRequest && item.reconciled(receipt: receipt, deliveries: shell?.deliveries ?? [])) {
                    try forgetMarker(item.id)
                    feedback = item.kind == "answer" ? "Answer sent." : nil
                }
            }
        } catch { if current == generation { feedback = "Delivery could not be checked. Nothing was resent. Reconnect to try again." } }
    }
    private func rejectOperation(_ operation: PendingOperation) throws {
        if let text = submitted[operation.id], operation.kind == "reply" { failedReplies[operation.threadID] = text }
        try forgetMarker(operation.id)
    }
    func restoreReply() {
        guard let id = selectedID, (drafts[id] ?? "").isEmpty, let text = failedReplies[id] else { return }
        drafts[id] = text; failedReplies.removeValue(forKey: id)
    }
    func acknowledgeUnknown(_ id: String) {
        do { try forgetMarker(id); feedback = "Unconfirmed action dismissed. Nothing was resent." }
        catch { feedback = error.localizedDescription }
    }
    func forgetHost() async {
        guard let saved, !working else { return }; working = true
        defer { working = false }
        do {
            try await connection.revoke(endpoint: HostEndpoint(saved.address), token: saved.pairing.token)
            try keychain.remove(account: "pending"); try keychain.remove(account: "host")
            generation = UUID(); connection.disconnect(); self.saved = nil; shell = nil; detail = nil; selectedID = nil
            drafts = [:]; submitted = [:]; failedReplies = [:]; pending = []; online = false; mayAnswer = false; feedback = nil
        } catch { feedback = "Could not revoke this iPhone. Connection details are kept so you can retry when the host is reachable." }
    }
    private func applyShell(_ value: JSONValue) throws {
        guard let saved else { throw ClientError.invalidIdentity }
        let next = try value.decode(Shell.self); try next.validate(hostID: saved.pairing.hostId); shell = next
        if let selectedID, !next.host.threads.contains(where: { $0.id == selectedID }) { self.selectedID = nil; detail = nil }
    }
    private func push(_ frame: JSONValue) {
        do {
            if frame["event"].string == "shell" { try applyShell(frame["state"]) }
            else if frame["event"].string == "detail", let id = frame["threadId"].string {
                try applyDetail(frame["detail"], threadID: id, epoch: generation)
            } else if frame["event"].string == "error" {
                // The host sends this in place of an update too large for one frame; the connection stays open.
                feedback = try frame["error"].decode(WireFailure.self).message
            } else { throw ClientError.invalidProtocol }
        } catch { online = false; connection.disconnect(); feedback = "The host update could not be read. Reconnect to refresh this thread." }
    }
}
