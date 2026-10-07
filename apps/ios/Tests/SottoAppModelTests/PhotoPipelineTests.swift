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
}
