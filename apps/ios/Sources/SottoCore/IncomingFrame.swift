import Foundation

/// Local receive order, scoped to one socket connection. It is never a host revision or wire field.
public struct Received<Value: Sendable>: Sendable {
    public let value: Value
    public let sequence: Int
    public init(_ value: Value, sequence: Int) { self.value = value; self.sequence = sequence }
}

/// Decode pushes directly into the fields the phone displays. In particular, shell event pages
/// and unused activity bodies never become recursive JSONValue trees on the UI actor.
public enum IncomingFrame: Sendable {
    /// `catalog` is the model catalog the reply's shell carries whole under a revision, read here in socket order.
    case reply(id: String, data: Data, catalog: CarriedCatalog?)
    case refusal(id: String, failure: WireFailure)
    case shell(Shell)
    case detail(threadID: String, value: ThreadDetail?)
    case delta(threadID: String, value: ThreadDetailDelta)
    case failure(WireFailure)
}

/// Route replies without materializing their result. Their caller supplies its expected type.
private enum FrameEnvelope: Decodable {
    case reply(String, CarriedCatalog?)
    case frame(IncomingFrame)
    private enum Keys: String, CodingKey { case v, id, ok, result, error, event, state, threadId, detail, delta }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        guard try c.decode(Int.self, forKey: .v) == 1 else { throw ClientError.invalidProtocol }
        if let event = try c.decodeIfPresent(String.self, forKey: .event) {
            switch event {
            case "shell": self = .frame(.shell(try c.decode(Shell.self, forKey: .state)))
            case "detail": self = .frame(.detail(threadID: try c.decode(String.self, forKey: .threadId), value: try c.decode(Optional<ThreadDetail>.self, forKey: .detail)))
            case "detail-delta": self = .frame(.delta(threadID: try c.decode(String.self, forKey: .threadId), value: try c.decode(ThreadDetailDelta.self, forKey: .delta)))
            case "error": self = .frame(.failure(try c.decode(WireFailure.self, forKey: .error)))
            default: throw ClientError.invalidProtocol
            }
        } else {
            let id = try c.decode(String.self, forKey: .id)
            if try c.decode(Bool.self, forKey: .ok) {
                guard c.contains(.result) else { throw ClientError.invalidProtocol }
                // Any result that is not a shell or a hello, null included, carries no catalog.
                self = .reply(id, (try? c.decode(ReplyCatalog.self, forKey: .result))?.carried)
            } else { self = .frame(.refusal(id: id, failure: try c.decode(WireFailure.self, forKey: .error))) }
        }
    }
}

private struct ReplyValue<Value: Decodable>: Decodable {
    let value: Value
    private enum Keys: String, CodingKey { case v, id, ok, result }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        guard try c.decode(Int.self, forKey: .v) == 1, try c.decode(Bool.self, forKey: .ok) else { throw ClientError.invalidProtocol }
        _ = try c.decode(String.self, forKey: .id)
        value = try c.decode(Value.self, forKey: .result)
    }
}

public extension Wire {
    /// The phone reads snapshots, not event history. Match the desktop's v1 snapshot-only hello.
    /// `activity-summaries` asks for activity as its rows read it, without command output, text or diffs (#701).
    static let snapshotHello: [String: JSONValue] = ["op": .string("hello"), "afterSeq": .number(9_007_199_254_740_991),
        "accepts": .array([.string("detail-delta"), .string("client-liveness"), .string("activity-summaries"), .string("model-catalog-revision")])]

    // Nonisolated async functions run on the generic executor in this package's Swift 5 mode.
    // Awaiting each frame before receiving the next keeps pushes and replies in socket order.
    static func readFrame(_ data: Data) async throws -> IncomingFrame {
        guard data.count <= maximumFrameBytes else { throw ClientError.invalidProtocol }
        switch try JSONDecoder().decode(FrameEnvelope.self, from: data) {
        case .reply(let id, let catalog): return .reply(id: id, data: data, catalog: catalog)
        case .frame(let frame): return frame
        }
    }
    /// Decode the result once from its original bytes, without a JSONValue round trip.
    static func readReply<T: Decodable & Sendable>(_ data: Data, as type: T.Type) async throws -> T {
        guard data.count <= maximumFrameBytes else { throw ClientError.invalidProtocol }
        return try JSONDecoder().decode(ReplyValue<T>.self, from: data).value
    }
}
