import Foundation
import CryptoKit

/// A video an agent wrote (ADR-0170, part 4), as the iPhone plays it: fetched from its computer in parts of 8 MiB with
/// `thread-media-part`, each written to a file as it arrives, so the whole video is never held in memory, and kept only
/// once its bytes are the size and digest its computer named. The desktop plays one up to 200 MiB; this iPhone fetches
/// one up to 50 MiB, and says a larger one plays on the desktop.
public enum AgentVideos {
    /// Listed by a computer that finds the pictures and videos its threads' turns write, and answers for a video's parts.
    public static let feature = "thread-media-video"
    public static let bytesEach = 50 * 1024 * 1024
    public static let partBytes = 8 * 1024 * 1024
    public static let partsMax = (200 * 1024 * 1024 + partBytes - 1) / partBytes
    /// The request for one part of a video a step's handle names.
    public static func part(threadID: String, activityID: String, mediaID: String, part: Int) -> [String: JSONValue] {
        ["op": .string("thread-media-part"), "request": .object([
            "threadId": .string(threadID), "activityId": .string(activityID), "mediaId": .string(mediaID), "part": .number(Double(part)),
        ])]
    }
    /// Whether this iPhone fetches a video of `sizeBytes` to play it.
    public static func playsHere(sizeBytes: Int) -> Bool { sizeBytes > 0 && sizeBytes <= bytesEach }
    /// The file name a video is kept under while it plays: its digest and the extension its type plays with.
    public static func fileName(digest: String, mimeType: String) -> String {
        digest + (mimeType == "video/quicktime" ? ".mov" : mimeType == "video/webm" ? ".webm" : ".mp4")
    }
}

/// One part of a video as its computer hands it back (`thread-media-part`), with what the whole video is.
public struct AgentVideoPart: Decodable, Sendable {
    public let name: String; public let mimeType: String; public let sizeBytes: Int; public let digest: String
    public let part: Int; public let parts: Int; public let data: String
}

/// A video's parts as they arrive, in order, written to `url` and hashed as they come. Nil from `init`, or false from
/// `add` or `finish`, means the parts don't make the video their computer named: the file is removed and nothing is kept.
/// One download is used by one task at a time, part after part, so it is handed between tasks without a lock.
public final class AgentVideoDownload: @unchecked Sendable {
    public let url: URL; public let mimeType: String; public let sizeBytes: Int; public let digest: String; public let parts: Int
    private var hasher = SHA256()
    private var handle: FileHandle?
    private var bytesSoFar = 0
    public private(set) var received = 0

    public init?(first: AgentVideoPart, url: URL) {
        guard first.part == 0, (1...AgentVideos.partsMax).contains(first.parts), AgentVideos.playsHere(sizeBytes: first.sizeBytes),
              first.digest.count == 64, first.digest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
              ["video/mp4", "video/webm", "video/quicktime"].contains(first.mimeType) else { return nil }
        self.url = url; mimeType = first.mimeType; sizeBytes = first.sizeBytes; digest = first.digest; parts = first.parts
        try? FileManager.default.removeItem(at: url)
        guard FileManager.default.createFile(atPath: url.path, contents: nil), let opened = try? FileHandle(forWritingTo: url) else { return nil }
        handle = opened
        guard add(first) else { return nil }
    }
    deinit { try? handle?.close() }

    /// The share of the video in hand, from 0 to 1.
    public var progress: Double { Double(received) / Double(parts) }
    public var complete: Bool { received == parts }

    /// Writes the next part. False for a part out of order, one that names another video, or one past the video's size.
    public func add(_ part: AgentVideoPart) -> Bool {
        guard let handle, part.part == received, part.parts == parts, part.mimeType == mimeType, part.sizeBytes == sizeBytes, part.digest == digest,
              let data = Data(base64Encoded: part.data), !data.isEmpty, data.count <= AgentVideos.partBytes, bytesSoFar + data.count <= sizeBytes,
              (try? handle.write(contentsOf: data)) != nil else { return discard() }
        hasher.update(data: data); bytesSoFar += data.count; received += 1
        return true
    }

    /// Closes the file once every part is in, and keeps it only when its bytes are the size and digest named.
    public func finish() -> Bool {
        guard complete, bytesSoFar == sizeBytes, let handle, (try? handle.close()) != nil else { return discard() }
        self.handle = nil
        let made = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return made == digest ? true : discard()
    }

    private func discard() -> Bool {
        try? handle?.close(); handle = nil
        try? FileManager.default.removeItem(at: url)
        return false
    }
}
