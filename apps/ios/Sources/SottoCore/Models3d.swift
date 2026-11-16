import Foundation
import CryptoKit

/// A 3D model a thread made with Meshy (ADR-0141), as the iPhone shows it (the Meshy plan's ticket 7): the desktop's line
/// in its thread, which opens a sheet that turns it. The line and its view come from the computer that runs the thread
/// (`plugin-meshy-phone`); its still picture and its USDZ are fetched from there in parts of 8 MiB, the USDZ only when the
/// line is opened and kept in the app's cache, and at most 64 MiB (Zach's pick on #2497, November 15, 2026).
public enum Models3d {
    /// Listed by a computer that keeps 3D models and shows them to phones.
    public static let feature = "plugin-meshy-phone"
    /// A message's visual of this kind is a 3D model's line, by the 3D model's ID.
    public static let visualKind = "3d-model"
    public static let partBytes = 8 * 1024 * 1024
    /// The most a still picture or a USDZ may be to cross the connection, as the computer caps it.
    public static let bytesMax = 64 * 1024 * 1024
    public enum Part: String, Sendable { case still, usdz }

    /// One 3D model's view.
    public static func view(id: String) -> [String: JSONValue] {
        ["op": .string("plugin-meshy-model"), "request": .object(["id": .string(id)])]
    }
    /// One thread's 3D models, with the words each was made from and when it was asked for.
    public static func thread(threadID: String) -> [String: JSONValue] {
        ["op": .string("plugin-meshy-models"), "request": .object(["threadId": .string(threadID)])]
    }
    /// One part of a 3D model's still picture or USDZ, from `offset`; after the first, with the digest it carried.
    public static func bytes(id: String, part: Part, offset: Int, digest: String?) -> [String: JSONValue] {
        var request: [String: JSONValue] = ["id": .string(id), "part": .string(part.rawValue), "offset": .number(Double(offset))]
        if let digest { request["digest"] = .string(digest) }
        return ["op": .string("plugin-meshy-model-bytes"), "request": .object(request)]
    }
    /// The file a 3D model's USDZ is kept under in the app's cache: one per computer and 3D model, named by neither's words.
    public static func cacheName(hostID: String, id: String) -> String {
        SHA256.hash(data: Data((hostID + "\n" + id).utf8)).map { String(format: "%02x", $0) }.joined() + ".usdz"
    }
}

/// A 3D model's line in its thread: the message's visual, by the 3D model's ID, and its name.
public struct Model3dLine: Equatable, Sendable {
    public let id: String; public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

/// A 3D model as its computer shows it: where Meshy is, what it cost, and its files by name and size, never a path.
public struct Model3dView: Decodable, Equatable, Sendable {
    public let id: String; public let name: String
    /// `words` or `photo`.
    public let source: String
    /// `making`, `done`, `failed` or `lost`.
    public let state: String
    /// While it is made: `shape`, `texture` or `files`, Meshy's percent on it, and the seconds left at the rate so far.
    public var stage: String? = nil; public var percent: Int? = nil; public var secondsLeft: Int? = nil
    public let credits: Int
    /// The folder its files are in, inside the thread's, with forward slashes; empty for the thread's folder itself.
    public let folder: String
    public let files: [File]
    public var still: String? = nil
    public var failure: String? = nil
    public struct File: Decodable, Equatable, Sendable {
        public let name: String
        /// Its size now; none when the file is gone.
        public var bytes: Int? = nil
    }
    public init(id: String, name: String, source: String, state: String, stage: String? = nil, percent: Int? = nil, credits: Int, folder: String, files: [File], still: String? = nil, failure: String? = nil) {
        self.id = id; self.name = name; self.source = source; self.state = state; self.stage = stage; self.percent = percent
        self.credits = credits; self.folder = folder; self.files = files; self.still = still; self.failure = failure
    }
    /// Done, with every file it made gone from its folder: moved, renamed or deleted.
    public var filesGone: Bool { state == "done" && !files.isEmpty && files.allSatisfy { $0.bytes == nil } }
    /// The USDZ it made, by name, and its size when it is there.
    public var usdz: File? { files.first { $0.name.lowercased().hasSuffix(".usdz") } }
    /// Whether this iPhone fetches its USDZ to turn it: one that is there and no larger than the computer hands over.
    public var turnsHere: Bool { guard let bytes = usdz?.bytes else { return false }; return bytes > 0 && bytes <= Models3d.bytesMax }
}

/// One of a thread's 3D models as its computer lists it: its view, the words it was made from while the record keeps
/// them (Keep local history), a photo by its file name, and when it was asked for.
public struct Model3dListed: Decodable, Equatable, Sendable {
    public let view: Model3dView
    public let askedAt: String
    public let words: String?
    public let photo: String?
    private enum Keys: String, CodingKey { case askedAt, words, photo }
    public init(from decoder: Decoder) throws {
        view = try Model3dView(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        askedAt = try c.decode(String.self, forKey: .askedAt)
        words = try c.decodeIfPresent(String.self, forKey: .words)
        photo = try c.decodeIfPresent(String.self, forKey: .photo)
    }
}

/// The computer's news of its 3D models (`plugin-meshy-models` push): one's view as it changes, and records that went.
public struct Model3dNews: Decodable, Equatable, Sendable {
    public var changed: Changed? = nil
    public var removed: [String]? = nil
    public struct Changed: Decodable, Equatable, Sendable { public let threadId: String; public let view: Model3dView }
}

/// One part of a still picture or a USDZ as the computer hands it back, from the file it checked, `total` bytes long.
public struct Model3dBytes: Decodable, Sendable {
    public let data: String; public let total: Int; public let digest: String
}

/// A still picture's or a USDZ's parts as they arrive, in order, written to `url` and hashed as they come. Nil from
/// `init`, or false from `add` or `finish`, means the parts don't make the file their first one named, its size and
/// digest: the file is removed and nothing is kept. One download is used by one task at a time, part after part.
public final class Model3dDownload: @unchecked Sendable {
    public let url: URL; public let total: Int; public let digest: String
    private var hasher = SHA256()
    private var handle: FileHandle?
    public private(set) var received = 0

    public init?(first: Model3dBytes, url: URL) {
        guard (1...Models3d.bytesMax).contains(first.total), first.digest.count == 64,
              first.digest.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
        self.url = url; total = first.total; digest = first.digest
        try? FileManager.default.removeItem(at: url)
        guard FileManager.default.createFile(atPath: url.path, contents: nil), let opened = try? FileHandle(forWritingTo: url) else { return nil }
        handle = opened
        guard add(first) else { return nil }
    }
    deinit { try? handle?.close() }

    /// The share of the file in hand, from 0 to 1.
    public var progress: Double { Double(received) / Double(total) }
    public var complete: Bool { received == total }

    /// Writes the next part. False for a part of another file, an empty or oversized one, or one past the file's size.
    public func add(_ part: Model3dBytes) -> Bool {
        guard let handle, part.total == total, part.digest == digest, let data = Data(base64Encoded: part.data), !data.isEmpty,
              data.count <= Models3d.partBytes, received + data.count <= total, (try? handle.write(contentsOf: data)) != nil else { return discard() }
        hasher.update(data: data); received += data.count
        return true
    }

    /// Closes the file once every byte is in, and keeps it only when its bytes are the digest named.
    public func finish() -> Bool {
        guard complete, let handle, (try? handle.close()) != nil else { return discard() }
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
