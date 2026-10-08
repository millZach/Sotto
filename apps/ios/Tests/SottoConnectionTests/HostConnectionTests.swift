import Foundation
import XCTest
import SottoCore

private final class RecordedRoutes: @unchecked Sendable {
    private let lock = NSLock()
    private var routes: [String] = []
    func append(_ route: String) { lock.lock(); defer { lock.unlock() }; routes.append(route) }
    var values: [String] { lock.lock(); defer { lock.unlock() }; return routes }
}

private final class HostResponses: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor final class HostConnectionTests: XCTestCase {
    private let hostID = "11111111-1111-4111-8111-111111111111"
    private func connection() -> HostConnection {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HostResponses.self]
        return HostConnection(configuration: configuration)
    }
    func testConnectValidatesHealthIdentity() async throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net")
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let routes = RecordedRoutes()
        HostResponses.handler = { request in
            routes.append(request.url!.path)
            return (200, #"{"v":1,"status":"ready","hostId":"22222222-2222-4222-8222-222222222222","sottoVersion":"1"}"#)
        }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        do { _ = try await connection.connect(endpoint: endpoint, pairing: pairing); XCTFail("Expected refusal") }
        catch { XCTAssertEqual(error as? ClientError, .invalidIdentity) }
        XCTAssertEqual(routes.values, ["/v1/health"])
    }
    func testConnectReadsHealthBeforeSession() async throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net")
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let routes = RecordedRoutes()
        let expected = hostID
        HostResponses.handler = { request in
            routes.append(request.url!.path)
            if request.url!.path == "/v1/health" { return (200, "{\"v\":1,\"status\":\"ready\",\"hostId\":\"\(expected)\",\"sottoVersion\":\"1\"}") }
            return (503, "{}")
        }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        do { _ = try await connection.connect(endpoint: endpoint, pairing: pairing); XCTFail("Expected unavailable session") }
        catch { XCTAssertEqual(error as? ClientError, .sottoNotRunning("forge")) }
        XCTAssertEqual(routes.values, ["/v1/health", "/v1/session"])
    }
    func testConnectFindsPhoneAccessOnItsOtherServePort() async throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net:8443")
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let routes = RecordedRoutes()
        let expected = hostID
        HostResponses.handler = { request in
            routes.append("\(request.url!.port ?? 443) \(request.url!.path)")
            if request.url!.port == 8443 { throw URLError(.cannotConnectToHost) }
            if request.url!.path == "/v1/health" { return (200, "{\"v\":1,\"status\":\"ready\",\"hostId\":\"\(expected)\"}") }
            return (503, "{}")
        }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        do { _ = try await connection.connect(endpoint: endpoint, pairing: pairing); XCTFail("Expected unavailable session") }
        catch { XCTAssertEqual(error as? ClientError, .sottoNotRunning("forge")) }
        XCTAssertEqual(routes.values, ["8443 /v1/health", "10000 /v1/health", "10000 /v1/session"])
    }
    func testRemoveFindsPhoneAccessOnItsOtherServePort() async throws {
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let routes = RecordedRoutes()
        let expected = hostID
        HostResponses.handler = { request in
            routes.append("\(request.url!.port ?? 443) \(request.url!.path)")
            // Another app's Serve setting on 10000 whose own server is stopped answers 502.
            if request.url!.port == 10000 { return (502, "{}") }
            if request.url!.path == "/v1/health" { return (200, "{\"v\":1,\"status\":\"ready\",\"hostId\":\"\(expected)\"}") }
            return (200, #"{"v":1,"revoked":true}"#)
        }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        try await connection.revoke(endpoint: HostEndpoint("https://forge.example.ts.net:10000"), pairing: pairing)
        XCTAssertEqual(routes.values, ["10000 /v1/health", "8443 /v1/health", "8443 /v1/revoke"])
    }
    func testConnectNeverUsesAnotherHostOnTheOtherServePort() async throws {
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let routes = RecordedRoutes()
        HostResponses.handler = { request in
            routes.append("\(request.url!.port ?? 443) \(request.url!.path)")
            if request.url!.port == 10000 { return (200, #"{"v":1,"status":"ready","hostId":"22222222-2222-4222-8222-222222222222"}"#) }
            throw URLError(.cannotConnectToHost)
        }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        // The saved port's own error is what is said, and no session is asked of the other host.
        do { _ = try await connection.connect(endpoint: HostEndpoint("https://forge.example.ts.net:8443"), pairing: pairing); XCTFail("Expected unreachable") }
        catch { XCTAssertEqual(error as? ClientError, .hostUnreachable("forge")) }
        XCTAssertEqual(routes.values, ["8443 /v1/health", "10000 /v1/health"])
        // A computer saved on 443 is not phone access, so no other port is tried.
        do { _ = try await connection.connect(endpoint: HostEndpoint("https://forge.example.ts.net"), pairing: pairing); XCTFail("Expected unreachable") }
        catch { XCTAssertEqual(error as? ClientError, .hostUnreachable("forge")) }
        XCTAssertEqual(routes.values, ["8443 /v1/health", "10000 /v1/health", "443 /v1/health"])
    }
    func testRemoveUsesReconnectHostCheck() async throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net")
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let routes = RecordedRoutes()
        HostResponses.handler = { request in
            routes.append(request.url!.path)
            return (200, #"{"v":1,"status":"ready","hostId":"22222222-2222-4222-8222-222222222222"}"#)
        }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        do { try await connection.revoke(endpoint: endpoint, pairing: pairing); XCTFail("Expected refusal") }
        catch { XCTAssertEqual(error as? ClientError, .invalidIdentity) }
        XCTAssertEqual(routes.values, ["/v1/health"])
    }
    func testRemoveChecksHealthBeforeRevocation() async throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net")
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let routes = RecordedRoutes()
        let expected = hostID
        HostResponses.handler = { request in
            routes.append(request.url!.path)
            if request.url!.path == "/v1/health" { return (200, "{\"v\":1,\"status\":\"ready\",\"hostId\":\"\(expected)\"}") }
            return (200, #"{"v":1,"revoked":true}"#)
        }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        try await connection.revoke(endpoint: endpoint, pairing: pairing)
        XCTAssertEqual(routes.values, ["/v1/health", "/v1/revoke"])
    }
    func testConnectionFailureMessagesNameTheirCause() {
        XCTAssertEqual(HostConnection.requestFailure(operation: "hello"), .connectionTimedOut)
        XCTAssertEqual(HostConnection.requestFailure(operation: "command"), .uncertain)
        for operation in ["observe", "detail", "shell", "receipt", "host-folders", "events"] {
            XCTAssertEqual(HostConnection.requestFailure(operation: operation), .readTimedOut)
        }
        XCTAssertEqual(ClientError.readTimedOut.errorDescription, "Sotto did not answer in time. Try again.")
        for route in ["/v1/pair", "/v1/session", "/v1/revoke"] {
            XCTAssertEqual(HostConnection.refusal(route: route, status: 429, name: "forge"), .rateLimited)
        }
        XCTAssertEqual(HostConnection.refusal(route: "/v1/pair", status: 401, name: "forge"), .rejected("That code didn't work. Codes work once and last five minutes; get a new one on that computer."))
        XCTAssertEqual(HostConnection.refusal(route: "/v1/session", status: 503, name: "forge"), .sottoNotRunning("forge"))
        XCTAssertEqual(HostConnection.refusal(route: "/v1/session", status: 403, name: "forge"), .rejected("This iPhone is no longer paired with forge. Remove it in Computers and add it again."))
        XCTAssertEqual(ClientError.connectionTimedOut.errorDescription, "The computer didn't finish connecting. Work carries on there. Try connecting again.")
        XCTAssertEqual(ClientError.rateLimited.errorDescription, "Too many connection attempts. Wait a minute and try again.")
    }
    func testSessionRefusedWhilePhoneAccessIsOffKeepsThePairingAndSaysWhy() async throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net")
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let expected = hostID
        let message = "Phone access is off on forge. Your pairing is kept."
        for route in ["/v1/session", "/v1/pair"] {
            HostResponses.handler = { request in
                if request.url!.path == "/v1/health" { return (200, "{\"v\":1,\"status\":\"ready\",\"hostId\":\"\(expected)\"}") }
                return (403, "{\"v\":1,\"error\":{\"code\":\"forbidden\",\"message\":\"\(message)\"}}")
            }
            let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
            do {
                if route == "/v1/pair" { _ = try await connection.pair(endpoint: endpoint, expectedHostID: expected, code: "ABCD2345") }
                else { _ = try await connection.connect(endpoint: endpoint, pairing: pairing) }
                XCTFail("Expected a refusal")
            } catch { XCTAssertEqual(error as? ClientError, .hostRefused(message)) }
        }
        XCTAssertEqual(ClientError.hostRefused(message).errorDescription, message)
    }
    func testHealthRateLimitIsReported() async throws {
        HostResponses.handler = { _ in (429, "{}") }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        do { _ = try await connection.health(endpoint: HostEndpoint("https://forge.example.ts.net")); XCTFail("Expected wait") }
        catch { XCTAssertEqual(error as? ClientError, .rateLimited) }
    }
    func testReconnectingGivesUpOnHealthSoonerThanOnTheSession() async throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net")
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        let expected = hostID
        HostResponses.handler = { request in
            if request.url!.path == "/v1/health" {
                // Five seconds on each of phone access's two ports: a computer that doesn't answer is given up in about ten.
                XCTAssertEqual(request.timeoutInterval, 5)
                return (200, "{\"v\":1,\"status\":\"ready\",\"hostId\":\"\(expected)\"}")
            }
            XCTAssertEqual(request.timeoutInterval, 30)
            return (503, "{}")
        }
        let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
        do { _ = try await connection.connect(endpoint: endpoint, pairing: pairing); XCTFail("Expected unavailable session") }
        catch { XCTAssertEqual(error as? ClientError, .sottoNotRunning("forge")) }
    }

    func testSavedReconnectPreservesStoppedComputerFeedback() async throws {
        let endpoint = try HostEndpoint("https://forge.example.ts.net")
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data("{\"v\":1,\"hostId\":\"\(hostID)\",\"clientId\":\"phone\",\"token\":\"fixture\"}".utf8))
        for status in [502, 503] {
            let routes = RecordedRoutes()
            HostResponses.handler = { request in routes.append(request.url!.path); return (status, "{}") }
            let connection = connection(); defer { connection.close(); HostResponses.handler = nil }
            do { _ = try await connection.connect(endpoint: endpoint, pairing: pairing); XCTFail("Expected stopped computer") }
            catch { XCTAssertEqual(error as? ClientError, .sottoNotRunning("forge")) }
            XCTAssertEqual(routes.values, ["/v1/health"])
            do { _ = try await connection.health(endpoint: endpoint); XCTFail("Expected discovery miss") }
            catch { XCTAssertEqual(error as? ClientError, .notASottoHost("forge")) }
        }
    }

}
