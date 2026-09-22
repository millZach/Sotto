import Foundation
import SottoCore

/// Credentials must never follow redirects, including to another private host.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor final class HostConnection {
    var onPush: ((JSONValue) -> Void)?
    var onDisconnect: (() -> Void)?
    private let redirects = NoRedirects()
    private lazy var network: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        return URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
    }()
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var pending: [String: CheckedContinuation<JSONValue, Error>] = [:]
    private var deadlines: [String: Task<Void, Never>] = [:]
    private var session = ""
    private var generation = UUID()

    func pair(endpoint: HostEndpoint, code: String) async throws -> Pairing {
        let result = try await post(endpoint: endpoint, route: "/v1/pair", body: .object(["v": .number(1), "code": .string(code), "name": .string("iPhone")]))
        let pairing = try result.decode(Pairing.self); try pairing.validate(); return pairing
    }
    func revoke(endpoint: HostEndpoint, token: String) async throws {
        let result = try await post(endpoint: endpoint, route: "/v1/revoke", token: token)
        guard result["revoked"].bool == true else { throw ClientError.invalidProtocol }
    }
    func connect(endpoint: HostEndpoint, pairing: Pairing) async throws -> Hello {
        disconnect()
        let current = generation
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
                    let frame = try Wire.decode(data)
                    guard let self, self.generation == current else { return }
                    self.receive(frame)
                } catch {
                    guard let self, self.generation == current else { return }
                    self.disconnect(); self.onDisconnect?(); return
                }
            }
        }
        let hello = try await call(["op": .string("hello")]).decode(Hello.self)
        guard hello.hostId == pairing.hostId, hello.clientId == pairing.clientId else { disconnect(); throw ClientError.invalidIdentity }
        try hello.shell.validate(hostID: pairing.hostId)
        return hello
    }
    func disconnect() {
        generation = UUID(); reader?.cancel(); reader = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil; session = ""
        let waiting = pending; pending.removeAll()
        deadlines.values.forEach { $0.cancel() }; deadlines.removeAll()
        waiting.values.forEach { $0.resume(throwing: ClientError.disconnected) }
    }
    func call(_ operation: [String: JSONValue], id: String = UUID().uuidString) async throws -> JSONValue {
        guard let socket, !session.isEmpty else { throw ClientError.disconnected }
        let data = try Wire.request(id: id, session: session, operation: operation)
        guard data.count <= Wire.maximumFrameBytes else { throw ClientError.invalidRequest }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            deadlines[id] = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
                self?.finish(id: id, result: .failure(ClientError.uncertain))
            }
            Task { [weak self] in
                do { try await socket.send(.string(String(decoding: data, as: UTF8.self))) }
                catch { self?.finish(id: id, result: .failure(ClientError.uncertain)) }
            }
        }
    }
    private func receive(_ frame: JSONValue) {
        if frame["event"].string != nil { onPush?(frame); return }
        guard let id = frame["id"].string else { return }
        if frame["ok"].bool == true { finish(id: id, result: .success(frame["result"])) }
        else if let failure = try? frame["error"].decode(WireFailure.self) {
            // Preserve a typed refusal so the store can distinguish it from lost acknowledgements.
            finish(id: id, result: .failure(HostRefusal(failure: failure)))
        } else { finish(id: id, result: .failure(ClientError.invalidProtocol)) }
    }
    private func finish(id: String, result: Result<JSONValue, Error>) {
        deadlines.removeValue(forKey: id)?.cancel(); pending.removeValue(forKey: id)?.resume(with: result)
    }
    private func post(endpoint: HostEndpoint, route: String, token: String? = nil, body: JSONValue? = nil) async throws -> JSONValue {
        var request = URLRequest(url: endpoint.route(route)); request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await network.data(for: request)
        guard let response = response as? HTTPURLResponse, response.url == endpoint.route(route) else { throw ClientError.disconnected }
        // Retrying Forget after revocation succeeded but local deletion failed is safe.
        if route == "/v1/revoke" && response.statusCode == 401 { return .object(["v": .number(1), "revoked": .bool(true)]) }
        guard (200..<300).contains(response.statusCode) else {
            throw ClientError.rejected(route == "/v1/pair" ? "Pairing failed. Check the address and use a new code from Forge." : "This iPhone is no longer authorized. Pair again on the host.")
        }
        return try Wire.decode(data)
    }
}
struct HostRefusal: Error, LocalizedError {
    let failure: WireFailure
    var errorDescription: String? { failure.message }
}
