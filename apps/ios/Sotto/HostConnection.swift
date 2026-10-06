import Foundation
import SottoCore

/// Credentials must never follow redirects, including to another private host.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor final class HostConnection {
    private static let httpTimeout: TimeInterval = 30
    var onPush: ((IncomingFrame, Int) -> Void)?
    var onDisconnect: (() -> Void)?
    var onLiveness: (() -> Void)?
    private var answeredPing: UUID?
    private var liveness = LivenessProgress()
    private let redirects = NoRedirects()
    private var made: URLSession?
    private let configuration: URLSessionConfiguration
    init(configuration: URLSessionConfiguration = .ephemeral) { self.configuration = configuration }
    /// Made on first use. A session holds its delegate until it is invalidated, so `close()` ends it.
    private var network: URLSession {
        if let made { return made }
        configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = Self.httpTimeout
        let session = URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
        made = session
        return session
    }
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var pending: [String: CheckedContinuation<Received<Reply>, Error>] = [:]
    /// A reply's bytes, and the model catalog this connection held when it arrived, which its shell may name.
    private struct Reply: Sendable { let data: Data; let catalog: ModelCatalogCache }
    /// The last model catalog this connection was sent whole. It is kept as frames arrive, so every shell is
    /// read against the catalog that was current at its place in the socket, and a reconnect empties it.
    private var catalog = ModelCatalogCache()
    private var received = 0
    private var deadlines: [String: Task<Void, Never>] = [:]
    private var session = ""
    private var generation = UUID()

    /// Confirms Sotto is listening before pairing, reconnecting or removing a computer.
    func health(endpoint: HostEndpoint, reconnecting: Bool = false) async throws -> Health {
        let name = endpoint.machine
        var request = URLRequest(url: endpoint.route("/v1/health")); request.httpMethod = "GET"; request.timeoutInterval = Self.httpTimeout
        let fetched: (Data, URLResponse)
        do { fetched = try await network.data(for: request) } catch { throw ClientError.hostUnreachable(name) }
        let (data, response) = fetched
        guard let response = response as? HTTPURLResponse, response.url == endpoint.route("/v1/health") else { throw ClientError.notASottoHost(name) }
        if response.statusCode == 429 { throw ClientError.rateLimited }
        if reconnecting && [502, 503].contains(response.statusCode) { throw ClientError.sottoNotRunning(name) }
        guard (200..<300).contains(response.statusCode),
              let health = try? Wire.decode(data).decode(Health.self) else { throw ClientError.notASottoHost(name) }
        try health.validate()
        return health
    }
    /// Pairs only with the host `health` found: a different host answering at the same address is refused.
    func pair(endpoint: HostEndpoint, expectedHostID: String, code: String) async throws -> Pairing {
        let result = try await post(endpoint: endpoint, route: "/v1/pair", body: .object(["v": .number(1), "code": .string(code), "name": .string("iPhone")]))
        let pairing = try result.decode(Pairing.self); try pairing.validate()
        guard pairing.hostId == expectedHostID else { throw ClientError.invalidIdentity }
        return pairing
    }
    func revoke(endpoint: HostEndpoint, pairing: Pairing) async throws {
        let health = try await health(endpoint: endpoint, reconnecting: true)
        guard health.hostId == pairing.hostId else { throw ClientError.invalidIdentity }
        let result = try await post(endpoint: endpoint, route: "/v1/revoke", token: pairing.token)
        guard result["revoked"].bool == true else { throw ClientError.invalidProtocol }
    }
    func connect(endpoint: HostEndpoint, pairing: Pairing) async throws -> Received<Hello> {
        disconnect()
        let current = generation
        let health = try await health(endpoint: endpoint, reconnecting: true)
        guard current == generation else { throw CancellationError() }
        guard health.hostId == pairing.hostId else { throw ClientError.invalidIdentity }
        let result = try await post(endpoint: endpoint, route: "/v1/session", token: pairing.token)
        guard current == generation else { throw CancellationError() }
        let access = try result.decode(HostSession.self); try access.validate(pairing: pairing)
        session = access.session
        var request = URLRequest(url: endpoint.route("/v1/socket", socket: true))
        request.setValue("Bearer " + session, forHTTPHeaderField: "Authorization")
        let task = network.webSocketTask(with: request); task.maximumMessageSize = Wire.maximumFrameBytes
        socket = task; task.resume()
        reader = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    let data: Data
                    switch message { case .string(let text): data = Data(text.utf8); case .data(let bytes): data = bytes; @unknown default: throw ClientError.invalidProtocol }
                    let frame = try await Wire.readFrame(data)
                    guard let self, self.generation == current else { return }
                    self.receive(frame)
                } catch {
                    guard let self, self.generation == current else { return }
                    self.disconnect(); self.onDisconnect?(); return
                }
            }
        }
        heartbeat = Task { [weak self] in
            var interval: UInt64 = 25_000_000_000
            var receivedBytes = task.countOfBytesReceived
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: interval) } catch { return }
                guard let self, self.generation == current else { return }
                let ping = UUID()
                let messages = self.received
                task.sendPing { [weak self] error in
                    Task { @MainActor in
                        guard let self, self.generation == current, error == nil else { return }
                        self.answeredPing = ping
                    }
                }
                do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
                guard self.generation == current else { return }
                // Use byte growth when URLSession exposes it, including between rounds. Keep
                // pending-read protection because partial-frame counters are not guaranteed.
                let bytes = task.countOfBytesReceived
                let bytesAdvanced = bytes > receivedBytes
                receivedBytes = bytes
                let alive = self.received > messages || self.answeredPing == ping || bytesAdvanced
                if self.liveness.shouldDisconnect(now: ProcessInfo.processInfo.systemUptime, messagesAdvanced: self.received > messages, pong: self.answeredPing == ping, bytesAdvanced: bytesAdvanced) {
                    self.disconnect(); self.onDisconnect?(); return
                }
                if alive { self.onLiveness?() }
                interval = 15_000_000_000
            }
        }
        let helloResult = try await callReceived(Wire.snapshotHello, as: Hello.self)
        let hello = helloResult.value
        guard hello.hostId == pairing.hostId, hello.clientId == pairing.clientId else { disconnect(); throw ClientError.invalidIdentity }
        try hello.shell.validate(hostID: pairing.hostId)
        return Received(hello, sequence: helloResult.sequence)
    }
    /// Ends the connection and its URL session for good, when its computer is removed.
    func close() {
        disconnect(); made?.invalidateAndCancel(); made = nil
    }
    func disconnect() {
        generation = UUID(); liveness = LivenessProgress(); received = 0; answeredPing = nil; reader?.cancel(); reader = nil
        catalog = ModelCatalogCache()
        heartbeat?.cancel(); heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil; session = ""
        let waiting = pending; pending.removeAll()
        deadlines.values.forEach { $0.cancel() }; deadlines.removeAll()
        waiting.values.forEach { $0.resume(throwing: ClientError.disconnected) }
    }
    func call(_ operation: [String: JSONValue], id: String = UUID().uuidString) async throws -> JSONValue {
        try await call(operation, as: JSONValue.self, id: id)
    }
    func call<T: Decodable & Sendable>(_ operation: [String: JSONValue], as type: T.Type, id: String = UUID().uuidString) async throws -> T {
        try await callReceived(operation, as: type, id: id).value
    }
    func callReceived<T: Decodable & Sendable>(_ operation: [String: JSONValue], as type: T.Type, id: String = UUID().uuidString) async throws -> Received<T> {
        let current = generation
        let reply = try await request(operation, id: id)
        let value = try await Wire.readReply(reply.value.data, as: type)
        return Received(try whole(value, catalog: reply.value.catalog, generation: current), sequence: reply.sequence)
    }
    /// A shell or hello with its model catalog put back from what this connection held when the reply arrived.
    /// One naming a catalog this connection was never sent cannot be shown whole, and must not read as a
    /// computer with no models, so the connection starts again: the host sends a new connection's hello whole.
    private func whole<T>(_ value: T, catalog: ModelCatalogCache, generation current: UUID) throws -> T {
        let restored: T?
        if let shell = value as? Shell { restored = catalog.whole(shell).flatMap { $0 as? T } }
        else if let hello = value as? Hello { restored = catalog.whole(hello).flatMap { $0 as? T } }
        else { return value }
        if let restored { return restored }
        if generation == current { disconnect(); onDisconnect?() }
        throw ClientError.disconnected
    }
    private func request(_ operation: [String: JSONValue], id: String) async throws -> Received<Reply> {
        guard let socket, !session.isEmpty else { throw ClientError.disconnected }
        let operationName = operation["op"]?.string ?? ""
        let text: String
        if operationName == "stage-attachment" {
            // An image makes a frame of up to 14 MB: made off the main actor, then sent only on the
            // connection it was made for.
            let current = generation
            text = try await Wire.requestTextInBackground(id: id, session: session, operation: operation)
            guard current == generation, self.socket === socket else { throw ClientError.disconnected }
        } else { text = String(decoding: try Wire.request(id: id, session: session, operation: operation), as: UTF8.self) }
        guard text.utf8.count <= Wire.maximumFrameBytes else { throw ClientError.invalidRequest }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            liveness.beginRequest(id: id, operation: operationName, now: ProcessInfo.processInfo.systemUptime)
            let timeout = UInt64(LivenessProgress.requestTimeout(operation: operationName) * 1_000_000_000)
            deadlines[id] = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: timeout) } catch { return }
                self?.finish(id: id, result: .failure(Self.requestFailure(operation: operationName)))
            }
            Task { [weak self] in
                do { try await socket.send(.string(text)) }
                catch { self?.finish(id: id, result: .failure(Self.requestFailure(operation: operationName))) }
            }
        }
    }
    private func receive(_ frame: IncomingFrame) {
        received += 1
        switch frame {
        case .reply(let id, let data, let carried):
            if let carried { catalog.hold(carried) }
            finish(id: id, result: .success(Received(Reply(data: data, catalog: catalog), sequence: received)))
        case .refusal(let id, let failure): finish(id: id, result: .failure(HostRefusal(failure: failure)))
        case .shell(let shell):
            catalog.hold(shell)
            // A shell naming a catalog this connection was never sent: start again rather than show no models.
            guard let restored = catalog.whole(shell) else { disconnect(); onDisconnect?(); return }
            onPush?(.shell(restored), received)
        default: onPush?(frame, received)
        }
    }
    private func finish(id: String, result: Result<Received<Reply>, Error>) {
        liveness.finishRequest(id: id)
        deadlines.removeValue(forKey: id)?.cancel(); pending.removeValue(forKey: id)?.resume(with: result)
    }
    private func post(endpoint: HostEndpoint, route: String, token: String? = nil, body: JSONValue? = nil) async throws -> JSONValue {
        var request = URLRequest(url: endpoint.route(route)); request.httpMethod = "POST"
        request.timeoutInterval = Self.httpTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await network.data(for: request)
        guard let response = response as? HTTPURLResponse, response.url == endpoint.route(route) else { throw ClientError.disconnected }
        // Retrying Forget after revocation succeeded but local deletion failed is safe.
        if route == "/v1/revoke" && response.statusCode == 401 { return .object(["v": .number(1), "revoked": .bool(true)]) }
        guard (200..<300).contains(response.statusCode) else {
            let failure = try? Wire.decode(data)["error"].decode(WireFailure.self)
            throw Self.refusal(route: route, status: response.statusCode, name: endpoint.machine, failure: failure)
        }
        return try Wire.decode(data)
    }
}
extension HostConnection {
    /// What a request that failed means: a timeout's cause, by what the request was for.
    nonisolated static func requestFailure(operation: String) -> ClientError {
        switch operation {
        case "hello": return .connectionTimedOut
        case "command": return .uncertain
        default: return .readTimedOut
        }
    }
    /// What a refused request means. Only 401 and 403 say the pairing is gone; anything else from a
    /// computer that answered means Sotto isn't running, apart from a rate limit's explicit wait. A 403
    /// whose body is `forbidden` with a sentence is the computer keeping the pairing but not letting this
    /// iPhone in now, such as a host with phone access off: the iPhone shows the sentence and keeps trying.
    nonisolated static func refusal(route: String, status: Int, name: String, failure: WireFailure? = nil) -> ClientError {
        if status == 429 { return .rateLimited }
        if status == 403, let failure, failure.code == "forbidden", !failure.message.isEmpty, failure.message.count <= 500 {
            return .hostRefused(failure.message)
        }
        if route == "/v1/pair" && (400..<500).contains(status) {
            return .rejected("That code didn't work. Codes work once and last five minutes; get a new one on that computer.")
        }
        if status == 401 || status == 403 {
            return .rejected("This iPhone is no longer paired with \(name). Remove it in Computers and add it again.")
        }
        return .sottoNotRunning(name)
    }
}
struct HostRefusal: Error, LocalizedError {
    let failure: WireFailure
    var errorDescription: String? { failure.message }
}
