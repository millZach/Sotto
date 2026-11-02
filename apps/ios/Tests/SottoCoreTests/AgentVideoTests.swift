import XCTest
@testable import SottoCore

/// A video an agent wrote, as this iPhone fetches it to play (ADR-0170, part 4): in parts, written to a file as they come,
/// and kept only when the whole is the size and digest its computer named.
final class AgentVideoTests: XCTestCase {
    private let mebibyte = 1024 * 1024
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("agent-video-tests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func part(_ bytes: Data, _ index: Int, _ range: Range<Int>, digest: String, mimeType: String = "video/webm") throws -> AgentVideoPart {
        let json = """
        {"name":"flow.webm","mimeType":"\(mimeType)","sizeBytes":\(bytes.count),"digest":"\(digest)","part":\(index),"parts":2,"data":"\(bytes.subdata(in: range).base64EncodedString())"}
        """
        return try JSONDecoder().decode(AgentVideoPart.self, from: Data(json.utf8))
    }

    func testAVideoIsWrittenPartByPartAndKeptOnlyWhenItIsTheVideoNamed() throws {
        let bytes = Data((0..<(9 * mebibyte)).map { UInt8($0 % 251) })
        let digest = Files.digest(bytes)
        let url = try folder().appendingPathComponent(AgentVideos.fileName(digest: digest, mimeType: "video/webm"))
        XCTAssertTrue(url.lastPathComponent.hasSuffix(".webm"))
        let first = try part(bytes, 0, 0..<(8 * mebibyte), digest: digest), second = try part(bytes, 1, (8 * mebibyte)..<bytes.count, digest: digest)
        let download = try XCTUnwrap(AgentVideoDownload(first: first, url: url))
        XCTAssertEqual(download.progress, 0.5)
        XCTAssertFalse(download.complete)
        XCTAssertTrue(download.add(second))
        XCTAssertTrue(download.finish())
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    func testPartsThatAreNotTheVideoNamedLeaveNothing() throws {
        let bytes = Data((0..<(9 * mebibyte)).map { UInt8($0 % 13) })
        let root = try folder()
        // Bytes that aren't the ones their computer named are removed.
        let forgedURL = root.appendingPathComponent("forged.webm")
        let wrong = String(repeating: "e", count: 64)
        let forged = try XCTUnwrap(AgentVideoDownload(first: try part(bytes, 0, 0..<(8 * mebibyte), digest: wrong), url: forgedURL))
        XCTAssertTrue(forged.add(try part(bytes, 1, (8 * mebibyte)..<bytes.count, digest: wrong)))
        XCTAssertFalse(forged.finish())
        XCTAssertFalse(FileManager.default.fileExists(atPath: forgedURL.path))
        // Out of order, or another type, and nothing is kept.
        let digest = Files.digest(bytes)
        let orderURL = root.appendingPathComponent("order.webm")
        let download = try XCTUnwrap(AgentVideoDownload(first: try part(bytes, 0, 0..<(8 * mebibyte), digest: digest), url: orderURL))
        XCTAssertFalse(download.add(try part(bytes, 0, 0..<(8 * mebibyte), digest: digest)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: orderURL.path))
        XCTAssertNil(AgentVideoDownload(first: try part(bytes, 1, (8 * mebibyte)..<bytes.count, digest: digest), url: root.appendingPathComponent("late.webm")), "A video starts at its first part")
        XCTAssertNil(AgentVideoDownload(first: try part(bytes, 0, 0..<(8 * mebibyte), digest: digest, mimeType: "video/x-matroska"), url: root.appendingPathComponent("mkv.webm")))
    }

    func testThisIPhonePlaysVideosUpToFiftyMebibytesAndAsksForThemByHandle() {
        XCTAssertTrue(AgentVideos.playsHere(sizeBytes: 50 * mebibyte))
        XCTAssertFalse(AgentVideos.playsHere(sizeBytes: 50 * mebibyte + 1))
        XCTAssertFalse(AgentVideos.playsHere(sizeBytes: 0))
        XCTAssertEqual(AgentVideos.part(threadID: "t", activityID: "sotto-written-a", mediaID: "m0", part: 2),
                       ["op": .string("thread-media-part"), "request": .object(["threadId": .string("t"), "activityId": .string("sotto-written-a"), "mediaId": .string("m0"), "part": .number(2)])])
        XCTAssertEqual(AgentVideos.fileName(digest: "a", mimeType: "video/quicktime"), "a.mov")
        XCTAssertEqual(AgentVideos.fileName(digest: "a", mimeType: "video/mp4"), "a.mp4")
    }
}
