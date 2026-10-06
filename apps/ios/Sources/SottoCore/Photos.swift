import Foundation

/// What a reply can carry, as the host checks it (src/shared/agents.ts): eight images, 10 MiB each and
/// 20 MiB together, in one of four raster formats. The longest edge is the desktop's screenshot bound
/// (ADR-0030), so a photo from the iPhone reaches a model at the size a screenshot from the desktop does.
public enum PhotoLimits {
    public static let count = 8
    public static let bytesEach = 10 * 1024 * 1024
    public static let bytesTogether = 20 * 1024 * 1024
    public static let longEdge = 2576
    public static let mimeTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]
    /// A host forgets a staged image nothing keeps after an hour, so one older than this is staged again
    /// before it is sent. Staging the same bytes again costs the host nothing: it keeps images by digest.
    public static let restageAfter: TimeInterval = 45 * 60
}

public struct ImageSize: Codable, Equatable, Sendable {
    public let width: Int; public let height: Int
    public init(width: Int, height: Int) { self.width = width; self.height = height }
}
/// The size a photo had on this iPhone and the size it was sent at, so the desktop can say it was resized.
public struct ImageDimensions: Codable, Equatable, Sendable {
    public let original: ImageSize; public let sent: ImageSize
    public init(original: ImageSize, sent: ImageSize) { self.original = original; self.sent = sent }
    var wire: JSONValue {
        .object(["original": .object(["width": .number(Double(original.width)), "height": .number(Double(original.height))]),
                 "sent": .object(["width": .number(Double(sent.width)), "height": .number(Double(sent.height))])])
    }
}

/// A staged image's handle (ADR-0031): what the host answered `stage-attachment` with, and what a reply
/// carries in place of the image. The bytes stay on the thread's computer.
public struct StagedImage: Decodable, Equatable, Sendable {
    public let id: String; public let name: String; public let mimeType: String; public let sizeBytes: Int
    public let digest: String; public let dimensions: ImageDimensions?
    public init(id: String, name: String, mimeType: String, sizeBytes: Int, digest: String, dimensions: ImageDimensions? = nil) {
        self.id = id; self.name = name; self.mimeType = mimeType; self.sizeBytes = sizeBytes; self.digest = digest; self.dimensions = dimensions
    }
    /// Whether this is a handle the host would take back: the shape `agentAttachmentHandleSchema` checks.
    public var valid: Bool {
        let idCharacters = id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
        let validID = !id.isEmpty && id.count <= 128 && idCharacters
        let validName = !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 255
        let validDigest = digest.count == 64 && digest.allSatisfy { $0.isHexDigit && !$0.isUppercase }
        let validSize = (1...PhotoLimits.bytesEach).contains(sizeBytes)
        return validID && validName && validDigest && validSize && PhotoLimits.mimeTypes.contains(mimeType)
    }
    public var wire: JSONValue {
        var fields: [String: JSONValue] = ["id": .string(id), "name": .string(name), "mimeType": .string(mimeType),
                                           "sizeBytes": .number(Double(sizeBytes)), "digest": .string(digest)]
        if let dimensions { fields["dimensions"] = dimensions.wire }
        return .object(fields)
    }
}

/// Whether the reply box of a thread can take photos, and if not, why.
public enum PhotoSupport: Equatable, Sendable {
    case available, offline, needsUpdate, modelCannot, modelUnknown
    /// `features` are the ones the computer listed when it connected; a computer without
    /// `attachment-staging` is a Sotto from before photos could be sent to it.
    public init(online: Bool, thread: ThreadSummary?, host: HostSnapshot?, features: [String]) {
        guard online else { self = .offline; return }
        guard features.contains("attachment-staging") else { self = .needsUpdate; return }
        guard let model = CatalogEntry.model(host?.models ?? [], id: thread?.modelId) else { self = .modelUnknown; return }
        self = model.supportsImages == true ? .available : .modelCannot
    }
    /// Why the photo control does nothing, in words, or nil when it works.
    public func reason(computer: String) -> String? {
        switch self {
        case .available: return nil
        case .offline: return "Reconnect to \(computer) to attach photos."
        case .needsUpdate: return "Update Sotto on \(computer) to send photos from this iPhone."
        case .modelCannot: return "This thread’s model can’t take photos. Change the model on \(computer) to attach them."
        case .modelUnknown: return "\(computer) hasn’t said whether this thread’s model takes photos. Reconnect and try again."
        }
    }
}

/// A sent photo's bytes as the host hands them back for its preview.
public struct PhotoPreview: Decodable, Sendable { public let dataUrl: String }

public enum Photos {
    /// The request that stages one prepared image on a thread's computer. `base64` is the image's bytes.
    public static func stage(name: String, mimeType: String, base64: String, dimensions: ImageDimensions?) throws -> [String: JSONValue] {
        guard PhotoLimits.mimeTypes.contains(mimeType), !base64.isEmpty,
              base64.utf8.count <= (PhotoLimits.bytesEach + 2) / 3 * 4 else { throw ClientError.invalidRequest }
        var image: [String: JSONValue] = ["name": .string(String(name.prefix(255))), "mimeType": .string(mimeType), "data": .string(base64)]
        if let dimensions { image["dimensions"] = dimensions.wire }
        return ["op": .string("stage-attachment"), "image": .object(image)]
    }
    /// The request for one sent photo's preview: the image, by its message and attachment.
    public static func preview(threadID: String, messageID: String, attachmentID: String) -> [String: JSONValue] {
        ["op": .string("preview"), "request": .object(["threadId": .string(threadID), "messageId": .string(messageID), "attachmentId": .string(attachmentID)])]
    }
    /// Whether one more image of `bytes` keeps a reply inside the host's limits.
    public static func fits(_ bytes: Int, with others: [Int]) -> Bool {
        others.count < PhotoLimits.count && bytes > 0 && bytes <= PhotoLimits.bytesEach
            && others.reduce(bytes, +) <= PhotoLimits.bytesTogether
    }
    /// Whether a handle staged at `stagedAt` must be staged again before it is sent.
    public static func needsRestaging(stagedAt: Date, now: Date = Date()) -> Bool {
        now.timeIntervalSince(stagedAt) >= PhotoLimits.restageAfter
    }
    /// An image's bytes from a `data:` URL the host sent, decoded off the main actor. Nil for anything
    /// that is not a base64 raster image Sotto sends.
    public static func bytes(fromDataURL url: String) async -> Data? {
        guard url.hasPrefix("data:"), let comma = url.firstIndex(of: ",") else { return nil }
        let header = url[url.index(url.startIndex, offsetBy: 5)..<comma]
        guard header.hasSuffix(";base64"), PhotoLimits.mimeTypes.contains(String(header.dropLast(";base64".count))) else { return nil }
        return Data(base64Encoded: String(url[url.index(after: comma)...]))
    }
}
