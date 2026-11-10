import Foundation
import CryptoKit

/// What a reply's videos can be on a computer that lists `video-staging` (src/shared/agents.ts; ADR-0131, November 9
/// amendment): 500 MiB a video and 500 MiB of videos a reply, apart from the 50 MiB the photos and other files share. A video
/// still counts toward the eight attachments. It goes as the original file, in the 8 MiB parts a file goes in, up to 63.
public enum VideoLimits {
    public static let bytesEach = 500 * 1024 * 1024
    public static let bytesTogether = 500 * 1024 * 1024
    public static let partsMax = (bytesEach + FileLimits.partBytes - 1) / FileLimits.partBytes
    /// Listed by a computer that takes videos this large, writes their parts to disk, keeps an upload ten minutes for its
    /// client to carry on, and answers `file-upload-progress`. Only one that lists `file-staging` does.
    public static let stagingFeature = "video-staging"
    /// How long a video may take to arrive, from iCloud for one not on this iPhone, before it is left out: ten minutes,
    /// where a photo or a file gets two.
    public static let arrivalLimit: TimeInterval = 10 * 60
}

/// The sentences for a video that can't be attached. The first two are the desktop's (src/shared/agents.ts); the rest are
/// the iPhone's own. All in the interface language (ADR-0123).
public enum VideoWords {
    public static let tooLarge = String(localized: "Each video must be 500 MB or smaller. Nothing was attached. Trim it, or choose a shorter one.", bundle: .module)
    public static let tooLargeInTotal = String(localized: "Videos must total 500 MB or less. Nothing was attached. Send these first, or remove a video.", bundle: .module)
    /// A computer without `video-staging` takes a video only as a file: 25 MB.
    public static func needsUpdate(_ computer: String) -> String {
        String(localized: "\(computer) can’t take videos over 25 MB yet. Update Sotto there to attach this one.", bundle: .module,
               comment: "%@ is the computer's name, such as forge")
    }
    public static let noRoom = String(localized: "This iPhone doesn’t have room to keep a copy of this video while it uploads. Nothing was attached. Free up some space, then attach it again.", bundle: .module)
    public static let tooSlow = String(localized: "This video didn’t arrive within ten minutes, so it wasn’t added. If it’s in iCloud, try again once it has downloaded.", bundle: .module)

    /// The one line beneath the reply box's photo strip for a video: on its way from iCloud, going to its computer, paused
    /// until the connection is back, or up and ready to send.
    public static func line(name: String, sizeBytes: Int, duration: Double?, state: VideoState, computer: String) -> VideoLine {
        switch state {
        case .arriving(let progress):
            let percent = Videos.percent(progress)
            return VideoLine(name: nil, rest: String(localized: "Getting it from iCloud · \(percent)", bundle: .module,
                                                     comment: "A video in the reply box still downloading from iCloud; %@ is how much has come, such as 42%"))
        case .uploading(let sent, let secondsLeft):
            let gone = Files.size(sent), whole = Files.size(sizeBytes)
            let progress = String(localized: "\(gone) of \(whole)", bundle: .module,
                                  comment: "How much of a video has gone to its computer: two sizes, such as 13 MB of 84 MB")
            guard let secondsLeft else { return VideoLine(name: name, rest: progress) }
            return VideoLine(name: name, rest: progress + " · " + timeLeft(secondsLeft))
        case .paused(let sent):
            let share = Double(sent) / Double(max(1, sizeBytes)), percent = Videos.percent(share)
            return VideoLine(name: nil, rest: String(localized: "Paused at \(percent) · waiting for \(computer)", bundle: .module,
                                                     comment: "A video's upload stopped while its computer can't be reached. The first %@ is how much had gone, such as 37%; the second is the computer's name"))
        case .ready:
            let size = Files.size(sizeBytes)
            return VideoLine(name: name, rest: duration.map { Videos.length($0) + " · " + size } ?? size)
        }
    }
    /// About how long the rest of an upload takes: seconds under a minute and a half, whole minutes after.
    static func timeLeft(_ seconds: Int) -> String {
        guard seconds >= 90 else {
            return String(localized: "about \(seconds) s left", bundle: .module, comment: "How long the rest of a video's upload takes, in seconds, such as about 34 s left")
        }
        let minutes = Int((Double(seconds) / 60).rounded())
        return String(localized: "about \(minutes) min left", bundle: .module, comment: "How long the rest of a video's upload takes, in minutes, such as about 3 min left")
    }
}

/// Where a video in the reply box stands, for the line beneath the photo strip.
public enum VideoState: Equatable, Sendable {
    /// On its way from iCloud, with how much has come, from 0 to 1.
    case arriving(Double)
    /// Going to its computer: how many bytes have gone, and about how long the rest takes once that is known.
    case uploading(sent: Int, secondsLeft: Int?)
    /// Stopped with `sent` bytes on its computer, until the connection is back. Nothing was lost.
    case paused(sent: Int)
    /// On its computer, ready to send.
    case ready
}

/// The line beneath the strip: the video's name, which may be cut in the middle, then the rest, which never is.
public struct VideoLine: Equatable, Sendable {
    public let name: String?
    public let rest: String
    public init(name: String?, rest: String) { self.name = name; self.rest = rest }
    public var text: String { name.map { $0 + " · " + rest } ?? rest }
}

/// One attachment as a reply's limits count it: its size, and whether its computer counts it with the videos, as one that
/// lists `video-staging` counts anything whose type starts with `video/`.
public struct AttachmentSize: Equatable, Sendable {
    public let bytes: Int
    public let video: Bool
    public init(bytes: Int, video: Bool = false) { self.bytes = bytes; self.video = video }
}

/// What a computer answers `file-upload-progress` with: how many parts of the upload it holds, which is the next to send.
public struct FileUploadProgress: Decodable, Equatable, Sendable {
    public let parts: Int
    public init(parts: Int) { self.parts = parts }
}

public enum Videos {
    /// Whether an attachment of this type is a video (`isVideoAttachment` in src/shared/agents.ts).
    public static func isVideo(_ mimeType: String?) -> Bool { mimeType?.hasPrefix("video/") == true }
    public static func isVideo(_ attachment: Attachment) -> Bool { isVideo(attachment.mimeType) }
    /// A video's type from its name, as a file's is. One whose name says no video type, which the photo library can hand
    /// over, goes as a QuickTime movie, the type the iPhone's camera writes.
    public static func mimeType(forName name: String) -> String {
        let type = Files.mimeType(forName: name)
        return isVideo(type) ? type : "video/quicktime"
    }

    /// Why attachments of these sizes can't join a reply already carrying `existing`, or nil when they fit. Nothing is
    /// attached when one doesn't. With `staging`, the computer lists `video-staging`: a video may be 500 MB and the videos
    /// 500 MB between them, while the photos and other files keep their 50 MB. Without it, a video is a file to that computer,
    /// so a larger one is refused in words that say to update it.
    public static func refusal(adding added: [AttachmentSize], to existing: [AttachmentSize], computer: String, staging: Bool) -> String? {
        guard staging else {
            if added.contains(where: { $0.video && $0.bytes > FileLimits.bytesEach }) { return VideoWords.needsUpdate(computer) }
            return Files.refusal(adding: added.map(\.bytes), to: existing.map(\.bytes))
        }
        if added.contains(where: { $0.video && $0.bytes > VideoLimits.bytesEach }) { return VideoWords.tooLarge }
        if added.contains(where: { !$0.video && $0.bytes > FileLimits.bytesEach }) { return FileWords.tooLarge }
        if existing.count + added.count > PhotoLimits.count { return existing.isEmpty ? FileWords.tooMany : FileWords.full }
        let all = existing + added
        if all.filter(\.video).reduce(0, { $0 + $1.bytes }) > VideoLimits.bytesTogether { return VideoWords.tooLargeInTotal }
        if all.filter({ !$0.video }).reduce(0, { $0 + $1.bytes }) > FileLimits.bytesTogether { return FileWords.tooLargeInTotal }
        return nil
    }

    /// The request that sends one part of a video to a computer that lists `video-staging`: a file's part, which may name a
    /// video of up to 500 MiB in up to 63 parts. `data` is the part's own bytes, at most 8 MiB.
    public static func stagePart(uploadID: UUID, index: Int, count: Int, name: String, mimeType: String, sizeBytes: Int, digest: String,
                                 data: Data) throws -> [String: JSONValue] {
        guard isVideo(mimeType), (1...VideoLimits.partsMax).contains(count), (1...VideoLimits.bytesEach).contains(sizeBytes)
        else { throw ClientError.invalidRequest }
        return try Files.partRequest(uploadID: uploadID, index: index, count: count, name: name, mimeType: mimeType, sizeBytes: sizeBytes,
                                     digest: digest, data: data)
    }
    /// The request that asks a computer how many parts of an upload it holds, to carry on from there (`video-staging`).
    public static func uploadProgress(uploadID: UUID) -> [String: JSONValue] {
        ["op": .string("file-upload-progress"), "uploadId": .string(uploadID.uuidString.lowercased())]
    }
    /// The part an upload of `count` parts carries on from, given what its computer answered `file-upload-progress` with;
    /// nil when it holds none of it, or answered what no upload of that many parts could hold. It then starts again from
    /// its first part under a new upload ID.
    public static func carryOn(from progress: FileUploadProgress?, count: Int) -> Int? {
        guard let parts = progress?.parts, (1..<count).contains(parts) else { return nil }
        return parts
    }
    /// How many bytes the first `parts` parts of a file of `sizeBytes` hold.
    public static func bytes(inParts parts: Int, of sizeBytes: Int) -> Int { min(sizeBytes, max(0, parts) * FileLimits.partBytes) }

    /// One part of a file on disk, read on its own, so a video is never held whole in memory.
    public static func part(of url: URL, range: Range<Int>) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(range.lowerBound))
        guard let data = try handle.read(upToCount: range.count), data.count == range.count else { throw CocoaError(.fileReadCorruptFile) }
        return data
    }
    /// SHA-256 of a file on disk in lowercase hex, as the host keeps attachments by, read a little at a time.
    public static func digest(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try autoreleasepool(invoking: { try handle.read(upToCount: 1024 * 1024) }), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// About how many seconds the rest of an upload takes at the pace of this stretch of it: `from` bytes had gone at
    /// `since`, and `sent` have gone by `now`. Nil until some of this stretch has gone.
    public static func secondsLeft(sent: Int, of sizeBytes: Int, from: Int, since: Date, now: Date = Date()) -> Int? {
        let elapsed = now.timeIntervalSince(since), moved = sent - from
        guard moved > 0, elapsed > 0, sent < sizeBytes else { return nil }
        return max(1, Int((Double(sizeBytes - sent) / (Double(moved) / elapsed)).rounded()))
    }
    /// A video's length as its badge shows it: 0:48, 12:05, 1:02:03.
    public static func length(_ seconds: Double) -> String {
        let total = seconds.isFinite ? max(0, Int(seconds.rounded())) : 0
        let hours = total / 3600, minutes = total / 60 % 60, rest = total % 60
        func two(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }
        return hours > 0 ? "\(hours):\(two(minutes)):\(two(rest))" : "\(minutes):\(two(rest))"
    }
    /// How much of a video has come or gone, "37%", in the locale's own way, never 100% before all of it has.
    public static func percent(_ progress: Double) -> String {
        // A hair over, so 0.29 reads 29% though it is 28.999… once multiplied.
        let share = min(100, (min(1, max(0, progress)) * 100 + 1e-9).rounded(.down)) / 100
        return share.formatted(.percent.precision(.fractionLength(0)))
    }
    /// Whether a failure to keep a video's copy was this iPhone running out of space, through any error it wraps.
    public static func isOutOfSpace(_ error: Error) -> Bool {
        let error = error as NSError
        if error.domain == NSCocoaErrorDomain, error.code == CocoaError.fileWriteOutOfSpace.rawValue { return true }
        if error.domain == NSPOSIXErrorDomain, error.code == Int(ENOSPC) { return true }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? Error { return isOutOfSpace(underlying) }
        return false
    }
}

/// The protected temporary copy each video in a reply box is uploaded from (ADR-0131, November 9 amendment): moved, as it
/// arrives, into a new folder of random name under the app's temporary directory, under its safe name, unreadable while
/// the phone is locked and kept out of backups. Its bytes are never logged. Each copy lives in its own folder and is removed
/// by that folder alone: when its video leaves the box, when its reply is sent and taken, and, for anything a crash or a
/// force quit left, at the next launch.
public struct ReplyVideoCopies: Sendable {
    public let root: URL
    public init(root: URL = FileManager.default.temporaryDirectory.appendingPathComponent("reply-videos", isDirectory: true)) { self.root = root }
    /// Moves `file` into a folder of its own, or copies it when it must stay where it is, and returns where the copy is.
    /// Nothing of it is left when that fails.
    public func take(_ file: URL, move: Bool) throws -> URL {
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(Files.safeName(file.lastPathComponent), isDirectory: false)
            if move {
                do { try FileManager.default.moveItem(at: file, to: url) } catch { try FileManager.default.copyItem(at: file, to: url) }
            } else {
                try FileManager.default.copyItem(at: file, to: url)
            }
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
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
        guard let folder = folder(of: url) else { return }
        try? FileManager.default.removeItem(at: folder)
    }
    /// Removes every copy but those `kept` names.
    public func removeAll(keeping kept: [URL]) {
        let keep = Set(kept.compactMap { folder(of: $0)?.lastPathComponent })
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for folder in folders where !keep.contains(folder.lastPathComponent) { try? FileManager.default.removeItem(at: folder) }
    }
    /// Removes every copy.
    public func removeAll() { try? FileManager.default.removeItem(at: root) }
    private func folder(of url: URL) -> URL? {
        let folder = url.deletingLastPathComponent().standardizedFileURL
        return folder.deletingLastPathComponent().path == root.standardizedFileURL.path ? folder : nil
    }
}
