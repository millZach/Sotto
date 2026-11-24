import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import SottoCore

/// The real photo pipeline over images drawn here, on macOS, where ImageIO reads and writes them as on the iPhone.
final class PhotoPipelineTests: XCTestCase {
    private func drawn(width: Int, height: Int) throws -> CGImage {
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return try XCTUnwrap(context.makeImage())
    }
    private func encoded(_ images: [CGImage], as type: UTType, file: [CFString: Any] = [:], frame: [CFString: Any] = [:]) throws -> Data {
        let output = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, type.identifier as CFString, images.count, nil))
        CGImageDestinationSetProperties(destination, file as CFDictionary)
        for image in images { CGImageDestinationAddImage(destination, image, frame as CFDictionary) }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }
    private func source(_ data: Data) throws -> CGImageSource { try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil)) }
    private func properties(_ data: Data) throws -> [CFString: Any] {
        (CGImageSourceCopyPropertiesAtIndex(try source(data), 0, nil) as? [CFString: Any]) ?? [:]
    }
    private func sent(_ prepared: PreparedPhoto) throws -> Data { try XCTUnwrap(Data(base64Encoded: prepared.base64)) }

    func testAScreenshotStaysPNGAtItsOwnSize() async throws {
        let prepared = try await PhotoPipeline.prepare(try encoded([drawn(width: 1179, height: 2556)], as: .png), name: "Photo 1")
        XCTAssertEqual(prepared.mimeType, "image/png")
        XCTAssertEqual(prepared.name, "Photo 1.png")
        XCTAssertEqual(prepared.dimensions?.sent, ImageSize(width: 1179, height: 2556))
        XCTAssertEqual(prepared.byteCount, try sent(prepared).count)
        XCTAssertNotNil(prepared.thumbnail)
    }
    func testALargePhotoGoesAsJPEGAtTheScreenshotBoundWithoutItsLocation() async throws {
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 51.5, kCGImagePropertyGPSLatitudeRef: "N",
                                    kCGImagePropertyGPSLongitude: 0.12, kCGImagePropertyGPSLongitudeRef: "W"]
        let original = try encoded([drawn(width: 4032, height: 3024)], as: .jpeg, frame: [kCGImagePropertyGPSDictionary: gps])
        XCTAssertNotNil(try properties(original)[kCGImagePropertyGPSDictionary], "The original carries a location")
        let prepared = try await PhotoPipeline.prepare(original, name: "Photo 1")
        XCTAssertEqual(prepared.mimeType, "image/jpeg")
        XCTAssertEqual(prepared.name, "Photo 1.jpg")
        XCTAssertEqual(prepared.dimensions, ImageDimensions(original: ImageSize(width: 4032, height: 3024), sent: ImageSize(width: 2576, height: 1932)))
        XCTAssertNil(try properties(sent(prepared))[kCGImagePropertyGPSDictionary], "No location leaves the phone")
        XCTAssertLessThanOrEqual(prepared.byteCount, PhotoLimits.bytesEach)
    }
    func testAMovingGIFKeepsItsFrames() async throws {
        let frames = try (0..<3).map { _ in try drawn(width: 64, height: 48) }
        let gif = try encoded(frames, as: .gif, file: [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]],
                              frame: [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.1]])
        let prepared = try await PhotoPipeline.prepare(gif, name: "Photo 1")
        XCTAssertEqual(prepared.mimeType, "image/gif")
        XCTAssertEqual(CGImageSourceGetCount(try source(sent(prepared))), 3)
    }
    func testBytesThatAreNoImageAreRefused() async {
        do {
            _ = try await PhotoPipeline.prepare(Data("not an image".utf8), name: "Photo 1")
            XCTFail("Text was taken for a photo")
        } catch { XCTAssertEqual(error as? PhotoPipelineError, .unreadable) }
    }

    func testThumbnailDiskCacheKeysByDigestAndEdgeAndEvictsLRU() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-thumb-cache-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        final class Clock: @unchecked Sendable {
            var current = Date(timeIntervalSince1970: 1_793_000_000)
            func advance(_ seconds: TimeInterval) { current = current.addingTimeInterval(seconds) }
        }
        let clock = Clock()
        let cache = ThumbnailDiskCache(directory: dir, byteLimit: 500, countLimit: 3, now: { clock.current })
        let d1 = String(repeating: "a", count: 64)
        let d2 = String(repeating: "b", count: 64)
        let d3 = String(repeating: "c", count: 64)
        let d4 = String(repeating: "d", count: 64)

        let p1 = Data(repeating: 1, count: 200)
        let p2 = Data(repeating: 2, count: 200)
        let p3 = Data(repeating: 3, count: 200)
        let p1Small = Data(repeating: 9, count: 50)

        await cache.write(p1, digest: d1, edge: 640)
        clock.advance(10)
        await cache.write(p2, digest: d2, edge: 640)
        clock.advance(10)
        // Touch d1 so d2 becomes the least-recently-used entry.
        let hit1 = await cache.read(digest: d1, edge: 640)
        XCTAssertEqual(hit1, p1)
        let miss320 = await cache.read(digest: d1, edge: 320)
        XCTAssertNil(miss320, "Different edges stay distinct in the cache")

        // Writing p3 exceeds byteLimit (600 > 500), so LRU entry d2 is evicted while touched d1 survives.
        clock.advance(10)
        await cache.write(p3, digest: d3, edge: 640)
        let statsAfterBytePrune = await cache.stats()
        XCTAssertLessThanOrEqual(statsAfterBytePrune.bytes, 500)
        let kept1 = await cache.read(digest: d1, edge: 640)
        XCTAssertEqual(kept1, p1, "Recently read entry survives byte-limit eviction")
        let evicted2 = await cache.read(digest: d2, edge: 640)
        XCTAssertNil(evicted2, "Least-recently-used entry is evicted")
        let kept3 = await cache.read(digest: d3, edge: 640)
        XCTAssertEqual(kept3, p3)

        // Writing a different edge for d1 stays separate, and countLimit (3) is also enforced.
        clock.advance(10)
        await cache.write(p1Small, digest: d1, edge: 320)
        clock.advance(10)
        await cache.write(Data(repeating: 4, count: 40), digest: d4, edge: 640)
        let statsAfterCountPrune = await cache.stats()
        XCTAssertLessThanOrEqual(statsAfterCountPrune.count, 3)
        XCTAssertLessThanOrEqual(statsAfterCountPrune.bytes, 500)
    }

    func testThumbnailDataKeepsCompactBytesAndCompactsOversizedImages() async throws {
        let small = try encoded([drawn(width: 320, height: 240)], as: .jpeg)
        XCTAssertLessThanOrEqual(small.count, ThumbnailDiskCache.directWriteBytes)
        let kept = await PhotoPipeline.thumbnailData(small, edge: PhotoPipeline.thumbnailEdge)
        XCTAssertEqual(kept, small, "Already-compact resized bytes are stored without re-encoding")

        // Build an oversized uncompressed-like PNG (> directWriteBytes) via patterned pixels.
        let width = 1200, height = 800
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let p = i / 4
            pixels[i] = UInt8((p * 31) & 0xff)
            pixels[i + 1] = UInt8((p * 73) & 0xff)
            pixels[i + 2] = UInt8((p * 137) & 0xff)
            pixels[i + 3] = 255
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        let noisy = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                                          bytesPerRow: width * 4, space: space,
                                          bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                          provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent))
        let largePNG = try encoded([noisy], as: .png)
        XCTAssertGreaterThan(largePNG.count, ThumbnailDiskCache.directWriteBytes)
        let compactedData = await PhotoPipeline.thumbnailData(largePNG, edge: PhotoPipeline.thumbnailEdge)
        let compacted = try XCTUnwrap(compactedData)
        XCTAssertLessThan(compacted.count, largePNG.count / 4, "Oversized full-res images are compacted before caching on disk")
        let decodedCompacted = await PhotoPipeline.image(compacted, edge: PhotoPipeline.thumbnailEdge)
        XCTAssertNotNil(decodedCompacted)
    }
}
