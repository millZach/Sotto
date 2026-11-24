import Foundation
import AVFoundation
import CoreGraphics
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import SottoCore

/// A photo made ready on this iPhone to go to a thread's computer: at most the screenshot bound on its
/// longest edge, upright, with no location or camera details, in a format the host takes. It lives in
/// memory only and is never written to disk.
struct PreparedPhoto: @unchecked Sendable {
    let name: String
    let mimeType: String
    /// The bytes as the stage request carries them. Kept, so a photo can be staged again.
    let base64: String
    let byteCount: Int
    let dimensions: ImageDimensions?
    /// A small copy for the reply box and the sending row.
    let thumbnail: CGImage?
}

enum PhotoPipelineError: Error, LocalizedError {
    case unreadable, tooLarge, tooSlow
    var errorDescription: String? {
        switch self {
        case .unreadable: return String(localized: "This photo couldn’t be read, so it wasn’t added. Try another photo.")
        case .tooLarge: return String(localized: "This photo is still over 10 MB after resizing, so it wasn’t added. Try another photo.")
        case .tooSlow: return String(localized: "This photo didn’t arrive within two minutes, so it wasn’t added. If it’s in iCloud, try again once it has downloaded.")
        }
    }
}

/// Turns a photo's original bytes into a `PreparedPhoto`. Everything here runs off the main actor:
/// nonisolated async functions run on the generic executor in Swift 5 mode.
enum PhotoPipeline {
    /// The reply box's thumbnails and a sent photo's thumbnail in the thread.
    static let thumbnailEdge = 640
    /// A sent photo opened full screen: about the size of the largest iPhone screen.
    static let screenEdge = 2048
    /// A moving GIF with more frames than this goes as its first frame, so rewriting it stays bounded.
    private static let gifFrames = 500
    private static let uncached: CFDictionary = [kCGImageSourceShouldCache: false] as [CFString: Any] as CFDictionary

    static func prepare(_ data: Data, name base: String) async throws -> PreparedPhoto {
        guard let source = CGImageSourceCreateWithData(data as CFData, Self.uncached),
              CGImageSourceGetCount(source) > 0, let type = CGImageSourceGetType(source) as String?,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else { throw PhotoPipelineError.unreadable }
        // EXIF orientations 5 to 8 turn the picture on its side.
        let turned = ((properties[kCGImagePropertyOrientation] as? Int) ?? 1) >= 5
        let original = turned ? ImageSize(width: height, height: width) : ImageSize(width: width, height: height)
        let longest = max(width, height)
        // A moving GIF that already fits keeps moving, as the desktop leaves GIFs alone (ADR-0030): its frames are
        // written again with their timing and nothing else. Any other moving image is sent as its first frame.
        if type == UTType.gif.identifier, (2...gifFrames).contains(CGImageSourceGetCount(source)), longest <= PhotoLimits.longEdge,
           data.count <= PhotoLimits.bytesEach, let gif = animatedGIF(source), gif.count <= PhotoLimits.bytesEach {
            return PreparedPhoto(name: base + ".gif", mimeType: "image/gif", base64: gif.base64EncodedString(), byteCount: gif.count,
                                 dimensions: nil, thumbnail: scaled(source, edge: thumbnailEdge))
        }
        // Drawing a new image keeps none of the original's metadata: no location, no camera details.
        guard let image = scaled(source, edge: min(longest, PhotoLimits.longEdge)) else { throw PhotoPipelineError.unreadable }
        let sent = ImageSize(width: image.width, height: image.height)
        // A screenshot stays lossless; anything else, HEIC included, goes as JPEG.
        var encoded: (data: Data, mimeType: String, ext: String)?
        if type == UTType.png.identifier, let png = encode(image, as: .png, quality: nil), png.count <= PhotoLimits.bytesEach {
            encoded = (png, "image/png", "png")
        }
        for quality in [0.85, 0.7, 0.5] where encoded == nil {
            if let jpeg = encode(image, as: .jpeg, quality: quality), jpeg.count <= PhotoLimits.bytesEach { encoded = (jpeg, "image/jpeg", "jpg") }
        }
        guard let encoded else { throw PhotoPipelineError.tooLarge }
        return PreparedPhoto(name: base + "." + encoded.ext, mimeType: encoded.mimeType, base64: encoded.data.base64EncodedString(),
                             byteCount: encoded.data.count, dimensions: ImageDimensions(original: original, sent: sent),
                             thumbnail: scaled(source, edge: thumbnailEdge))
    }

    /// A sent photo's bytes from its computer, made small for the thread or the size of the screen to open.
    static func image(_ data: Data, edge: Int) async -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, Self.uncached) else { return nil }
        return scaled(source, edge: edge)
    }

    /// Compact thumbnail bytes suitable for the bounded on-disk cache: keeps already-small resized bytes as-is, and
    /// re-encodes oversized responses (for example from an older host without `thread-media-edge`) to JPEG at `edge`.
    static func thumbnailData(_ data: Data, edge: Int) async -> Data? {
        guard !data.isEmpty else { return nil }
        if data.count <= ThumbnailDiskCache.directWriteBytes { return data }
        guard let source = CGImageSourceCreateWithData(data as CFData, Self.uncached),
              let thumb = scaled(source, edge: edge) else { return nil }
        return encode(thumb, as: .jpeg, quality: 0.82)
    }

    /// An upright image at most `edge` pixels on its longest side, decoded at that size rather than whole.
    private static func scaled(_ source: CGImageSource, edge: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: max(1, edge),
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
    private static func animatedGIF(_ source: CGImageSource) -> Data? {
        let count = CGImageSourceGetCount(source)
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.gif.identifier as CFString, count, nil) else { return nil }
        let file = (CGImageSourceCopyProperties(source, nil) as? [CFString: Any])?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        let loop: [CFString: Any] = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: file?[kCGImagePropertyGIFLoopCount] ?? 0]]
        CGImageDestinationSetProperties(destination, loop as CFDictionary)
        for index in 0..<count {
            guard let frame = CGImageSourceCreateImageAtIndex(source, index, nil) else { return nil }
            let gif = (CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any])?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            var timing: [CFString: Any] = [:]
            for key in [kCGImagePropertyGIFDelayTime, kCGImagePropertyGIFUnclampedDelayTime] { if let value = gif?[key] { timing[key] = value } }
            let frameProperties: [CFString: Any] = [kCGImagePropertyGIFDictionary: timing]
            CGImageDestinationAddImage(destination, frame, frameProperties as CFDictionary)
        }
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
    private static func encode(_ image: CGImage, as type: UTType, quality: Double?) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil) else { return nil }
        let options: [CFString: Any] = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] } ?? [:]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}

/// A video's first frame and its length, read from its temporary copy (ADR-0131, November 9 amendment). Never changed once
/// made, so it crosses tasks freely.
struct VideoFrame: @unchecked Sendable {
    let poster: CGImage?
    let duration: Double?
}

extension PhotoPipeline {
    /// A video's frame is at most this many pixels on its longest side: about 300 points, enough for the sent tile.
    static let posterEdge = 600
    /// The first frame, upright, and the length of the video at `url`. Either is nil when the video doesn't say.
    static func videoFrame(_ url: URL) async -> VideoFrame {
        let asset = AVURLAsset(url: url)
        let duration = try? await asset.load(.duration)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: posterEdge, height: posterEdge)
        let poster = try? await generator.image(at: .zero).image
        let seconds = duration.map(\.seconds).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        return VideoFrame(poster: poster, duration: seconds)
    }
}

/// Bounded LRU disk cache for thread photo and agent picture thumbnails, keyed by `(digest, edge)`.
/// Stored under the app's `Caches` directory (excluded from backup) so reconnects and relaunches reuse unchanged
/// thumbnails without re-downloading them, while iOS may reclaim the folder under storage pressure.
actor ThumbnailDiskCache {
    static let defaultByteLimit = 50 * 1024 * 1024
    static let defaultCountLimit = 1_000
    /// Responses at or below this size are already compact thumbnails and stored without re-encoding.
    static let directWriteBytes = 256 * 1024
    /// Maximum single entry size accepted on disk.
    static let maxEntryBytes = 512 * 1024

    static let shared: ThumbnailDiskCache = {
        let root = (FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory)
            .appendingPathComponent("sotto-thumbnails", isDirectory: true)
        return ThumbnailDiskCache(directory: root)
    }()

    let directory: URL
    let byteLimit: Int
    let countLimit: Int
    private let now: @Sendable () -> Date
    private var prepared = false

    init(directory: URL, byteLimit: Int = ThumbnailDiskCache.defaultByteLimit, countLimit: Int = ThumbnailDiskCache.defaultCountLimit,
         now: @escaping @Sendable () -> Date = Date.init) {
        self.directory = directory
        self.byteLimit = max(1, byteLimit)
        self.countLimit = max(1, countLimit)
        self.now = now
    }

    /// Safe filename for `(digest, edge)`: lowercase 64-hex digest + edge, or SHA-256 of a fallback identity string.
    static func fileName(digest: String, edge: Int) -> String? {
        let normalized = digest.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty, edge > 0 else { return nil }
        let safeKey: String
        if normalized.count == 64 && normalized.allSatisfy({ $0.isHexDigit }) {
            safeKey = normalized
        } else {
            safeKey = sha256Hex(normalized)
        }
        return "\(safeKey)_\(edge).thumb"
    }

    static func fallbackDigest(hostID: String, threadID: String, messageID: String, activityID: String?, attachmentID: String) -> String {
        let raw = activityID.map { "media/\(hostID)/\(threadID)/\($0)/\(attachmentID)" }
            ?? "attachment/\(hostID)/\(threadID)/\(messageID)/\(attachmentID)"
        return sha256Hex(raw)
    }

    private static func sha256Hex(_ string: String) -> String {
        SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func ensureDirectory() {
        guard !prepared else { return }
        var url = directory
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        prepared = true
    }

    /// Reads cached bytes for `(digest, edge)` and updates modification date so recently used thumbnails stay hot.
    func read(digest: String, edge: Int) -> Data? {
        guard let name = Self.fileName(digest: digest, edge: edge) else { return nil }
        let url = directory.appendingPathComponent(name, isDirectory: false)
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
        return data
    }

    /// Writes thumbnail bytes atomically under `(digest, edge)` and evicts least-recently-used entries past the bounds.
    func write(_ data: Data, digest: String, edge: Int) {
        guard !data.isEmpty, data.count <= Self.maxEntryBytes, data.count <= byteLimit,
              let name = Self.fileName(digest: digest, edge: edge) else { return }
        ensureDirectory()
        let url = directory.appendingPathComponent(name, isDirectory: false)
        let temp = directory.appendingPathComponent(UUID().uuidString + ".tmp", isDirectory: false)
        do {
            try data.write(to: temp, options: .atomic)
            try? FileManager.default.removeItem(at: url)
            try FileManager.default.moveItem(at: temp, to: url)
            try? FileManager.default.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
        } catch {
            try? FileManager.default.removeItem(at: temp)
            return
        }
        prune()
    }

    /// Evicts least-recently-used `.thumb` files until total bytes <= `byteLimit` and count <= `countLimit`.
    func prune() {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        struct Entry { let url: URL; let size: Int; let modified: Date }
        var entries: [Entry] = []
        var totalBytes = 0
        for url in urls where url.pathExtension == "thumb" {
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]),
                  values.isRegularFile == true else { continue }
            let size = values.fileSize ?? 0
            let modified = values.contentModificationDate ?? .distantPast
            entries.append(Entry(url: url, size: size, modified: modified))
            totalBytes += size
        }
        guard entries.count > countLimit || totalBytes > byteLimit else { return }
        entries.sort { $0.modified < $1.modified }
        var remainingCount = entries.count
        for entry in entries {
            guard remainingCount > countLimit || totalBytes > byteLimit else { break }
            try? fm.removeItem(at: entry.url)
            totalBytes -= entry.size
            remainingCount -= 1
        }
    }

    /// Current entry count and total bytes on disk.
    func stats() -> (count: Int, bytes: Int) {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return (0, 0) }
        var count = 0, bytes = 0
        for url in urls where url.pathExtension == "thumb" {
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
                  values.isRegularFile == true else { continue }
            count += 1
            bytes += values.fileSize ?? 0
        }
        return (count, bytes)
    }
}
