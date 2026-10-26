import Foundation
import CryptoKit
import UniformTypeIdentifiers

/// What a reply's files can be, as the host checks them (src/shared/agents.ts, ADR-0131): 25 MiB a file, 50 MiB with the
/// photos, and eight attachments with the photos. A file goes to its computer, and comes back for Quick Look, in parts of
/// 8 MiB, since a whole file in base64 can be more than a frame.
public enum FileLimits {
    public static let bytesEach = 25 * 1024 * 1024
    public static let bytesTogether = 50 * 1024 * 1024
    public static let partBytes = 8 * 1024 * 1024
    public static let partsMax = (bytesEach + partBytes - 1) / partBytes
    /// Listed by a computer that keeps files, which only one whose own `attach-any-file` answer is on does.
    public static let stagingFeature = "file-staging"
    /// Listed by a computer that hands a sent file's bytes back for Quick Look (`attachment-file`).
    public static let openingFeature = "attachment-files"
    /// A host forgets a staged file nothing keeps after an hour, as it does an image.
    public static let restageAfter = PhotoLimits.restageAfter
}

/// The desktop's own sentences for a file that can't be attached (src/shared/agents.ts), so the iPhone says what it says,
/// in the interface language (ADR-0123).
public enum FileWords {
    public static let tooLarge = String(localized: "Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file.", bundle: .module)
    public static let tooMany = String(localized: "Attach up to 8 files at a time. Nothing was attached.", bundle: .module)
    public static let tooLargeInTotal = String(localized: "Attachments must total 50 MB or less. Nothing was attached. Remove a file or choose smaller ones.", bundle: .module)
    public static let full = String(localized: "A reply can carry 8 attachments. Remove one to add another.", bundle: .module,
                                    comment: "Attachments are photos and files together")
    /// Some of the photos chosen fitted beside the files already in the reply box.
    public static let othersNotAdded = String(localized: "A reply can carry 8 attachments, so the others weren’t added.", bundle: .module,
                                              comment: "Attachments are photos and files together")
    public static let unreadable = String(localized: "This file couldn’t be read, so it wasn’t added. If it’s in iCloud, try again once it has downloaded.", bundle: .module)
    public static let tooSlow = String(localized: "This file didn’t arrive within two minutes, so it wasn’t added. If it’s in iCloud, try again once it has downloaded.", bundle: .module)
    public static let empty = String(localized: "This file is empty, so it wasn’t added. Choose another file.", bundle: .module)
}

/// A staged file's handle (ADR-0131): what the host answered the last `stage-file-part` with, and what a reply carries in
/// place of the file. The bytes stay on the thread's computer, which saves them in the thread's working folder when the
/// reply is sent.
public struct StagedFile: Decodable, Equatable, Sendable {
    public let id: String; public let name: String; public let mimeType: String; public let sizeBytes: Int; public let digest: String
    public init(id: String, name: String, mimeType: String, sizeBytes: Int, digest: String) {
        self.id = id; self.name = name; self.mimeType = mimeType; self.sizeBytes = sizeBytes; self.digest = digest
    }
    /// Whether this is a handle the host would take back: the shape `agentAttachmentHandleSchema` checks.
    public var valid: Bool {
        let idCharacters = id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
        let validID = !id.isEmpty && id.count <= 128 && idCharacters
        let validName = !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.utf16.count <= 255
        return validID && validName && Files.validDigest(digest) && Files.validMimeType(mimeType)
            && (1...(PhotoLimits.mimeTypes.contains(mimeType) ? PhotoLimits.bytesEach : FileLimits.bytesEach)).contains(sizeBytes)
    }
    public var wire: JSONValue {
        .object(["id": .string(id), "name": .string(name), "mimeType": .string(mimeType), "sizeBytes": .number(Double(sizeBytes)), "digest": .string(digest)])
    }
}

/// Whether a thread's reply box can take files, and if not, why. Files work on any model.
public enum FileSupport: Equatable, Sendable {
    case available, offline, needsUpdate
    public init(online: Bool, features: [String]) {
        guard online else { self = .offline; return }
        self = features.contains(FileLimits.stagingFeature) ? .available : .needsUpdate
    }
    /// Why the Files item does nothing, in words, or nil when it works.
    public func reason(computer: String) -> String? {
        switch self {
        case .available: return nil
        case .offline: return String(localized: "Reconnect to \(computer) to attach files.", bundle: .module, comment: "%@ is the computer's name, such as forge")
        case .needsUpdate: return String(localized: "This computer cannot keep files yet. Update Sotto there to attach them.", bundle: .module)
        }
    }
}

/// One part of a sent file as the host hands it back for Quick Look (`attachment-file`), with what the whole file is.
public struct SentFilePart: Decodable, Sendable {
    public let name: String; public let mimeType: String; public let sizeBytes: Int; public let digest: String
    public let part: Int; public let parts: Int; public let data: String
}

/// A sent file's parts as they arrive, in order, checked against what the first one said the file is. Nil from `init` or
/// `finish`, or false from `add`, means the parts don't make the file their host named, and nothing of them is kept.
public struct SentFileAssembly: Sendable {
    public let name: String; public let mimeType: String; public let sizeBytes: Int; public let digest: String; public let parts: Int
    /// Each part's own bytes, joined only once all are in, so adding one never copies those before it.
    private var chunks: [Data] = []
    private var bytesSoFar = 0
    public init?(first: SentFilePart) {
        guard first.part == 0, (1...FileLimits.partsMax).contains(first.parts), (1...FileLimits.bytesEach).contains(first.sizeBytes),
              Files.validDigest(first.digest) else { return nil }
        name = first.name; mimeType = first.mimeType; sizeBytes = first.sizeBytes; digest = first.digest; parts = first.parts
        guard add(first) else { return nil }
    }
    public var received: Int { chunks.count }
    /// The share of the file in hand, from 0 to 1.
    public var progress: Double { Double(received) / Double(parts) }
    public var complete: Bool { received == parts }
    /// Adds the next part. False for a part out of order, one that names another file, or one past the file's size.
    public mutating func add(_ part: SentFilePart) -> Bool {
        guard part.part == received, part.parts == parts, part.name == name, part.mimeType == mimeType, part.sizeBytes == sizeBytes,
              part.digest == digest, let data = Data(base64Encoded: part.data), !data.isEmpty, data.count <= FileLimits.partBytes,
              bytesSoFar + data.count <= sizeBytes else { return false }
        chunks.append(data); bytesSoFar += data.count
        return true
    }
    /// The whole file, once every part is in and its bytes are the size and digest its host named.
    public func finish() -> Data? {
        guard complete, bytesSoFar == sizeBytes else { return nil }
        var whole = Data(capacity: sizeBytes)
        for chunk in chunks { whole.append(chunk) }
        return Files.digest(whole) == digest ? whole : nil
    }
}

/// What kind of file a name is, for the symbol its pill shows.
public enum FileKind: Equatable, Sendable {
    case archive, code, video, text, other
}

public enum Files {
    /// The request that sends one part of a file to its computer. `data` is the part's own bytes, at most 8 MiB.
    public static func stagePart(uploadID: UUID, index: Int, count: Int, name: String, mimeType: String, sizeBytes: Int, digest: String,
                                 data: Data) throws -> [String: JSONValue] {
        guard (1...FileLimits.partsMax).contains(count), (0..<count).contains(index), (1...FileLimits.bytesEach).contains(sizeBytes),
              !data.isEmpty, data.count <= FileLimits.partBytes, validMimeType(mimeType), validDigest(digest),
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ClientError.invalidRequest }
        return ["op": .string("stage-file-part"), "part": .object([
            "uploadId": .string(uploadID.uuidString.lowercased()), "index": .number(Double(index)), "count": .number(Double(count)),
            "name": .string(wireName(name)), "mimeType": .string(mimeType), "sizeBytes": .number(Double(sizeBytes)),
            "digest": .string(digest), "data": .string(data.base64EncodedString()),
        ])]
    }
    /// The parts a file of `sizeBytes` goes in, as ranges of its bytes.
    public static func partRanges(_ sizeBytes: Int) -> [Range<Int>] {
        stride(from: 0, to: sizeBytes, by: FileLimits.partBytes).map { $0..<min(sizeBytes, $0 + FileLimits.partBytes) }
    }
    /// The request for one part of a sent file, by its message and attachment, for Quick Look.
    public static func open(threadID: String, messageID: String, attachmentID: String, part: Int) -> [String: JSONValue] {
        ["op": .string("attachment-file"), "request": .object([
            "threadId": .string(threadID), "messageId": .string(messageID), "attachmentId": .string(attachmentID), "part": .number(Double(part)),
        ])]
    }
    /// Why files of these sizes can't join a reply already carrying `others` (photos and files, by size), in the desktop's
    /// words, or nil when they fit. Nothing is attached when one doesn't.
    public static func refusal(adding sizes: [Int], to others: [Int]) -> String? {
        if sizes.contains(where: { $0 > FileLimits.bytesEach }) { return FileWords.tooLarge }
        if others.count + sizes.count > PhotoLimits.count { return others.isEmpty ? FileWords.tooMany : FileWords.full }
        if (others + sizes).reduce(0, +) > FileLimits.bytesTogether { return FileWords.tooLargeInTotal }
        return nil
    }
    /// A file's type from its name's extension, or `application/octet-stream` when it has none Sotto knows.
    public static func mimeType(forName name: String) -> String {
        let ext = (name as NSString).pathExtension
        guard !ext.isEmpty, let type = UTType(filenameExtension: ext)?.preferredMIMEType?.lowercased(), validMimeType(type) else {
            return "application/octet-stream"
        }
        return type
    }
    /// SHA-256 of the bytes in lowercase hex, as the host keeps attachments by.
    public static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    /// The desktop's size words (formatAttachmentSize): bytes, whole KB, then MB with one decimal under 10, in the
    /// interface language's units and the locale's digits.
    public static func size(_ bytes: Int) -> String {
        if bytes < 1024 {
            let count = max(0, bytes)
            return String(localized: "\(count) B", bundle: .module, comment: "A file's size in bytes, such as 512 B")
        }
        if bytes < 1024 * 1024 {
            let count = max(1, Int((Double(bytes) / 1024).rounded()))
            return String(localized: "\(count) KB", bundle: .module, comment: "A file's size in kilobytes, such as 180 KB")
        }
        let megabytes = Double(bytes) / (1024 * 1024)
        guard megabytes < 10 else {
            let count = Int(megabytes.rounded())
            return String(localized: "\(count) MB", bundle: .module, comment: "A file's size in whole megabytes, such as 25 MB")
        }
        let tenths: String = ((megabytes * 10).rounded() / 10).formatted(.number.precision(.fractionLength(1)).grouping(.never))
        return String(localized: "\(tenths) MB", bundle: .module, comment: "A file's size in megabytes under 10, with one decimal, such as 2.4 MB")
    }
    public static func kind(of name: String) -> FileKind {
        switch (name as NSString).pathExtension.lowercased() {
        case "zip", "gz", "tgz", "tar", "7z", "rar": return .archive
        case "sql", "yml", "yaml", "json", "js", "ts", "py", "swift", "sh": return .code
        case "mov", "mp4", "m4v": return .video
        case "pdf", "txt", "log", "md", "csv", "rtf": return .text
        default: return .other
        }
    }
    /// Whether a sent attachment is a file rather than a photo: a type Sotto knows that is not one of the four photo types.
    public static func isFile(_ attachment: Attachment) -> Bool {
        attachment.mimeType.map { !PhotoLimits.mimeTypes.contains($0) } ?? false
    }

    private static let unsafe = try! NSRegularExpression(pattern: #"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"/\\|?*\s]+"#)
    private static let device = try! NSRegularExpression(pattern: #"^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\.|$)"#,
                                                         options: [.caseInsensitive])
    /// The name a file is written under, by the desktop's rule (attachedFileSafeName): its base name only, every unsafe run
    /// of characters one `-`, no leading or trailing dots, a Windows device name prefixed with `_`, at most 120 characters
    /// with its extension kept, and `file` when nothing is left. It never holds a separator, so it can't leave its folder.
    public static func safeName(_ name: String) -> String {
        func trimDots(_ text: String) -> String {
            var text = Substring(text)
            while text.first == "." { text = text.dropFirst() }
            while let last = text.last, last == "." || last == " " { text = text.dropLast() }
            return String(text)
        }
        let last = name.precomposedStringWithCanonicalMapping
            .split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? ""
        let base = String(last).trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        let whole = NSRange(base.startIndex..., in: base)
        var safe = trimDots(unsafe.stringByReplacingMatches(in: base, range: whole, withTemplate: "-"))
        if device.firstMatch(in: safe, range: NSRange(safe.startIndex..., in: safe)) != nil { safe = "_" + safe }
        let characters = Array(safe.unicodeScalars)
        if characters.count > 120 {
            let ext = (safe.lastIndex(of: ".").map { safe.distance(from: safe.startIndex, to: $0) > 0 ? Array(safe[$0...].unicodeScalars) : [] }) ?? []
            let kept = ext.count > 1 && ext.count <= 16 ? ext : []
            var head = String.UnicodeScalarView(); head.append(contentsOf: characters.prefix(120 - kept.count))
            var tail = String.UnicodeScalarView(); tail.append(contentsOf: kept)
            safe = trimDots(String(head)) + String(tail)
        }
        let result = trimDots(safe)
        return result.isEmpty ? "file" : result
    }

    /// A name cut to the 255 UTF-16 units the host takes, whole characters only.
    static func wireName(_ name: String) -> String {
        var kept = "", units = 0
        for character in name {
            units += character.utf16.count
            guard units <= 255 else { break }
            kept.append(character)
        }
        return kept
    }
    static func validDigest(_ digest: String) -> Bool { digest.count == 64 && digest.allSatisfy { $0.isHexDigit && !$0.isUppercase } }
    /// The shape `agentMimeTypeSchema` checks: lowercase `type/subtype` of token characters, at most 127.
    static func validMimeType(_ type: String) -> Bool {
        let token = Set("abcdefghijklmnopqrstuvwxyz0123456789!#$&^_.+-")
        let halves = type.split(separator: "/", omittingEmptySubsequences: false)
        return type.count <= 127 && halves.count == 2 && halves.allSatisfy { half in
            guard let first = half.first, first.isASCII, first.isLetter || first.isNumber else { return false }
            return half.allSatisfy { token.contains($0) }
        }
    }
}

/// The copy of a sent file Quick Look reads (ADR-0131, October 25 amendment): written only once its bytes match their
/// handle, into a new folder of random name under the app's temporary directory, protected while the phone is locked and
/// kept out of backups. Each copy lives in its own folder and is removed by that folder alone, so a write that finishes
/// late never touches the copy being shown. Whoever opens it removes it when the preview closes, when another opens, when
/// the app moves to the background and, for anything a crash left, at the next launch.
public struct OpenedFileCopies: Sendable {
    public let root: URL
    public init(root: URL = FileManager.default.temporaryDirectory.appendingPathComponent("Opened files", isDirectory: true)) { self.root = root }
    /// Writes the file into a folder of its own and returns where Quick Look can read it. Nothing of it is left when
    /// writing fails.
    public func write(_ data: Data, name: String) throws -> URL {
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(Files.safeName(name), isDirectory: false)
            #if os(iOS)
            try data.write(to: url, options: [.withoutOverwriting, .completeFileProtection])
            #else
            try data.write(to: url, options: [.withoutOverwriting])
            #endif
            for var item in [root, folder, url] {
                var values = URLResourceValues(); values.isExcludedFromBackup = true
                try item.setResourceValues(values)
            }
            return url
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
    }
    /// Removes one copy, by the folder it was written in. A URL that isn't one of these copies is left alone.
    public func remove(_ url: URL) {
        let folder = url.deletingLastPathComponent().standardizedFileURL
        guard folder.deletingLastPathComponent().path == root.standardizedFileURL.path else { return }
        try? FileManager.default.removeItem(at: folder)
    }
    /// Removes every copy.
    public func removeAll() { try? FileManager.default.removeItem(at: root) }
}
