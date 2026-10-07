import Foundation
import CoreGraphics
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
        case .unreadable: return "This photo couldn’t be read, so it wasn’t added. Try another photo."
        case .tooLarge: return "This photo is still over 10 MB after resizing, so it wasn’t added. Try another photo."
        case .tooSlow: return "This photo didn’t arrive within two minutes, so it wasn’t added. If it’s in iCloud, try again once it has downloaded."
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
