import XCTest
@testable import SottoCore

/// Videos from the iPhone's reply box (ADR-0131, November 9 amendment): their own limits on a computer that lists
/// `video-staging`, up to 63 parts read one at a time from a protected temporary copy, and an upload that carries on from
/// the last part its computer holds.
final class VideoTests: XCTestCase {
    private let mebibyte = 1024 * 1024
    private func digest(_ character: Character = "d") -> String { String(repeating: character, count: 64) }
    private func number(_ value: JSONValue) -> Int? { if case .number(let number) = value { return Int(number) }; return nil }
    private func video(_ mebibytes: Int, plus bytes: Int = 0) -> AttachmentSize { AttachmentSize(bytes: mebibytes * mebibyte + bytes, video: true) }
    private func file(_ mebibytes: Int) -> AttachmentSize { AttachmentSize(bytes: mebibytes * mebibyte) }
    private func handle(_ id: String, bytes: Int, mimeType: String) -> StagedFile {
        StagedFile(id: id, name: "\(id).mov", mimeType: mimeType, sizeBytes: bytes, digest: digest())
    }
    private func folder(_ name: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testAVideoMayBe500MBAndAReplysVideosHaveTheirOwnTotal() {
        XCTAssertEqual(VideoLimits.bytesEach, 500 * mebibyte)
        XCTAssertEqual(VideoLimits.bytesTogether, 500 * mebibyte)
        XCTAssertEqual(VideoLimits.stagingFeature, "video-staging")
        let refusal = { (added: [AttachmentSize], existing: [AttachmentSize]) in
            Videos.refusal(adding: added, to: existing, computer: "forge", staging: true)
        }
        XCTAssertNil(refusal([video(500)], []))
        XCTAssertEqual(refusal([video(500, plus: 1)], []), "Each video must be 500 MB or smaller. Nothing was attached. Trim it, or choose a shorter one.")
        XCTAssertEqual(refusal([video(300)], [video(300)]), "Videos must total 500 MB or less. Nothing was attached. Send these first, or remove a video.")
        // Videos don't count toward the 50 MB the photos and other files share, and those don't count toward the videos'.
        XCTAssertNil(refusal([video(400)], [file(10), file(25), file(15)]))
        XCTAssertEqual(refusal([file(1)], [file(25), file(25), video(400)]),
                       "Attachments must total 50 MB or less. Nothing was attached. Remove a file or choose smaller ones.")
        XCTAssertEqual(refusal([file(26)], []), "Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file.")
        // A video is still one of the eight.
        XCTAssertEqual(refusal([video(1)], Array(repeating: file(1), count: 8)), "A reply can carry 8 attachments. Remove one to add another.")
        XCTAssertEqual(refusal(Array(repeating: video(1), count: 9), []), "Attach up to 8 files at a time. Nothing was attached.")
        XCTAssertNil(refusal(Array(repeating: video(62), count: 8), []))
    }

    func testAComputerWithoutVideoStagingTakesAVideoAsAFile() {
        let refusal = { (added: [AttachmentSize], existing: [AttachmentSize]) in
            Videos.refusal(adding: added, to: existing, computer: "forge", staging: false)
        }
        XCTAssertNil(refusal([video(25)], [file(25)]))
        XCTAssertEqual(refusal([video(25, plus: 1)], []), "forge can’t take videos over 25 MB yet. Update Sotto there to attach this one.")
        XCTAssertEqual(refusal([video(20)], [file(25), file(10)]),
                       "Attachments must total 50 MB or less. Nothing was attached. Remove a file or choose smaller ones.",
                       "Its videos count toward the 50 MB with everything else")
        XCTAssertEqual(refusal([file(26)], []), "Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file.")
    }

    func testAVideoGoesInUpTo63PartsReadOneAtATimeFromItsFile() throws {
        XCTAssertEqual(VideoLimits.partsMax, 63, "A 500 MiB video takes 63 parts of 8 MiB, as the host allows")
        let ranges = Files.partRanges(VideoLimits.bytesEach)
        XCTAssertEqual(ranges.count, 63)
        XCTAssertEqual(ranges.last, (62 * 8 * mebibyte)..<(500 * mebibyte))
        // The parts come from the file on disk, each read on its own, and the digest from a pass over it.
        let bytes = Data((0..<(9 * mebibyte + 10)).map { UInt8($0 % 251) })
        let url = try folder("video-parts").appendingPathComponent("IMG_0412.MOV")
        try bytes.write(to: url)
        let parts = Files.partRanges(bytes.count)
        XCTAssertEqual(parts.count, 2)
        XCTAssertEqual(try Videos.part(of: url, range: parts[1]), bytes.subdata(in: parts[1]))
        XCTAssertEqual(try Videos.part(of: url, range: parts[0]), bytes.subdata(in: parts[0]))
        XCTAssertThrowsError(try Videos.part(of: url, range: (bytes.count - 1)..<(bytes.count + 1)), "A range past the file's end")
        XCTAssertEqual(try Videos.digest(of: url), Files.digest(bytes))
        let upload = UUID()
        let operation = try Videos.stagePart(uploadID: upload, index: 62, count: 63, name: "IMG_0412.MOV", mimeType: "video/quicktime",
                                             sizeBytes: VideoLimits.bytesEach, digest: digest(), data: Data([1, 2, 3]))
        XCTAssertEqual(operation["op"], .string("stage-file-part"))
        let part = try XCTUnwrap(operation["part"])
        XCTAssertEqual(part["uploadId"], .string(upload.uuidString.lowercased()))
        XCTAssertEqual(number(part["index"]), 62)
        XCTAssertEqual(number(part["count"]), 63)
        XCTAssertEqual(number(part["sizeBytes"]), VideoLimits.bytesEach)
        XCTAssertEqual(part["mimeType"], .string("video/quicktime"))
        XCTAssertEqual(part["data"], .string("AQID"))
        // Nothing the host would refuse is built.
        let stage = { (count: Int, size: Int, mimeType: String) in
            try Videos.stagePart(uploadID: upload, index: 0, count: count, name: "a.mov", mimeType: mimeType, sizeBytes: size, digest: self.digest(), data: Data([1]))
        }
        XCTAssertThrowsError(try stage(64, VideoLimits.bytesEach, "video/quicktime"), "More parts than a 500 MiB video takes")
        XCTAssertThrowsError(try stage(63, VideoLimits.bytesEach + 1, "video/quicktime"), "Larger than a video may be")
        XCTAssertThrowsError(try stage(63, VideoLimits.bytesEach, "application/zip"), "Only a video may go in more than four parts")
        XCTAssertThrowsError(try Files.stagePart(uploadID: upload, index: 0, count: 63, name: "a.mov", mimeType: "video/quicktime",
                                                 sizeBytes: VideoLimits.bytesEach, digest: digest(), data: Data([1])),
                             "A file's part keeps a file's limits")
    }

    func testAnUploadAsksWhereToCarryOnFrom() async throws {
        let upload = UUID()
        let request = Videos.uploadProgress(uploadID: upload)
        XCTAssertEqual(request["op"], .string("file-upload-progress"))
        XCTAssertEqual(request["uploadId"], .string(upload.uuidString.lowercased()))
        XCTAssertEqual(request.count, 2, "The upload's ID beside the operation, nothing else")
        let held = try await Wire.readReply(Data(#"{"v":1,"id":"progress","ok":true,"result":{"parts":5}}"#.utf8), as: Optional<FileUploadProgress>.self)
        XCTAssertEqual(held, FileUploadProgress(parts: 5))
        let none = try await Wire.readReply(Data(#"{"v":1,"id":"progress","ok":true,"result":null}"#.utf8), as: Optional<FileUploadProgress>.self)
        XCTAssertNil(none, "A computer that holds none of it answers null")
        XCTAssertEqual(Videos.carryOn(from: FileUploadProgress(parts: 5), count: 11), 5)
        XCTAssertNil(Videos.carryOn(from: nil, count: 11), "Nothing held: it starts again")
        XCTAssertNil(Videos.carryOn(from: FileUploadProgress(parts: 11), count: 11), "No upload holds all its parts")
        XCTAssertNil(Videos.carryOn(from: FileUploadProgress(parts: 0), count: 11))
        XCTAssertEqual(Videos.bytes(inParts: 2, of: 20 * mebibyte), 16 * mebibyte)
        XCTAssertEqual(Videos.bytes(inParts: 3, of: 20 * mebibyte), 20 * mebibyte)
        XCTAssertEqual(LivenessProgress.requestTimeout(operation: "file-upload-progress"), 30, "A question with a short answer keeps the usual wait")
    }

    func testAReplyCarriesVideosWithinTheirOwnTotal() throws {
        let draft = UUID().uuidString
        let image = StagedImage(id: "photo", name: "photo.png", mimeType: "image/png", sizeBytes: 1_000, digest: digest())
        let pdf = { (id: String, bytes: Int) in StagedFile(id: id, name: "\(id).pdf", mimeType: "application/pdf", sizeBytes: bytes, digest: self.digest()) }
        XCTAssertTrue(handle("v", bytes: VideoLimits.bytesEach, mimeType: "video/quicktime").valid)
        XCTAssertFalse(handle("v", bytes: VideoLimits.bytesEach + 1, mimeType: "video/quicktime").valid)
        XCTAssertFalse(handle("v", bytes: 26 * mebibyte, mimeType: "application/zip").valid, "Only a video may be larger than a file")
        let command = try Commands.prompt(threadID: "t", text: "", draftID: draft, images: [image],
                                          files: [handle("v", bytes: 400 * mebibyte, mimeType: "video/quicktime"), pdf("a", 25 * mebibyte), pdf("b", 24 * mebibyte)])
        guard case .array(let attachments) = command["attachments"] else { return XCTFail("The reply carried nothing") }
        XCTAssertEqual(attachments.map { $0["id"] }, [.string("photo"), .string("v"), .string("a"), .string("b")])
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "x", draftID: draft,
                                                 files: [handle("v", bytes: 300 * mebibyte, mimeType: "video/mp4"), handle("w", bytes: 300 * mebibyte, mimeType: "video/mp4")]))
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "x", draftID: draft, images: [image],
                                                 files: [handle("v", bytes: 1, mimeType: "video/mp4"), pdf("a", 25 * mebibyte), pdf("b", 25 * mebibyte)]))
    }

    func testTheLineBeneathTheStripSaysWhereAVideoStands() {
        let size = 84 * mebibyte
        let line = { (state: VideoState) in VideoWords.line(name: "IMG_0412.MOV", sizeBytes: size, duration: 48.2, state: state, computer: "forge") }
        XCTAssertEqual(line(.ready).text, "IMG_0412.MOV · 0:48 · 84 MB")
        XCTAssertEqual(line(.ready).name, "IMG_0412.MOV", "The name may be cut; the rest never is")
        XCTAssertEqual(VideoWords.line(name: "clip.mp4", sizeBytes: size, duration: nil, state: .ready, computer: "forge").text, "clip.mp4 · 84 MB")
        XCTAssertEqual(line(.uploading(sent: 13 * mebibyte, secondsLeft: 34)).text, "IMG_0412.MOV · 13 MB of 84 MB · about 34 s left")
        XCTAssertEqual(line(.uploading(sent: 13 * mebibyte, secondsLeft: nil)).text, "IMG_0412.MOV · 13 MB of 84 MB")
        XCTAssertEqual(line(.uploading(sent: 13 * mebibyte, secondsLeft: 200)).text, "IMG_0412.MOV · 13 MB of 84 MB · about 3 min left")
        XCTAssertEqual(line(.paused(sent: size * 37 / 100 + 1)).text, "Paused at 37% · waiting for forge")
        XCTAssertNil(line(.paused(sent: 1)).name)
        XCTAssertEqual(line(.arriving(0.42)).text, "Getting it from iCloud · 42%")
        XCTAssertEqual(Videos.percent(0.999), "99%", "Never all of it before it has all gone")
        XCTAssertEqual(Videos.length(48.2), "0:48")
        XCTAssertEqual(Videos.length(725), "12:05")
        XCTAssertEqual(Videos.length(3723), "1:02:03")
        XCTAssertEqual(Videos.length(.nan), "0:00")
        let start = Date()
        XCTAssertEqual(Videos.secondsLeft(sent: 20 * mebibyte, of: size, from: 4 * mebibyte, since: start, now: start.addingTimeInterval(8)), 32)
        XCTAssertNil(Videos.secondsLeft(sent: 4 * mebibyte, of: size, from: 4 * mebibyte, since: start, now: start.addingTimeInterval(8)),
                     "Not until some of this stretch has gone")
    }

    func testAVideoIsKnownByItsType() {
        XCTAssertTrue(Videos.isVideo("video/quicktime"))
        XCTAssertTrue(Videos.isVideo("video/mp4"))
        XCTAssertFalse(Videos.isVideo("image/png"))
        XCTAssertFalse(Videos.isVideo(nil))
        XCTAssertEqual(Videos.mimeType(forName: "IMG_0412.MOV"), "video/quicktime")
        XCTAssertEqual(Videos.mimeType(forName: "clip.mp4"), "video/mp4")
        XCTAssertEqual(Videos.mimeType(forName: "picked"), "video/quicktime", "A name with no video type goes as the camera's")
        XCTAssertTrue(Videos.isOutOfSpace(CocoaError(.fileWriteOutOfSpace)))
        XCTAssertTrue(Videos.isOutOfSpace(NSError(domain: NSCocoaErrorDomain, code: CocoaError.fileWriteUnknown.rawValue,
                                                  userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))])))
        XCTAssertFalse(Videos.isOutOfSpace(CocoaError(.fileReadNoSuchFile)))
    }

    func testTheTemporaryCopyIsMovedInUnderItsSafeNameAndGoes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-reply-videos-\(UUID().uuidString)", isDirectory: true)
        let copies = ReplyVideoCopies(root: root)
        defer { copies.removeAll() }
        let picked = try folder("picked")
        let first = picked.appendingPathComponent("IMG 0412.MOV"), second = picked.appendingPathComponent("clip.mp4")
        try Data("first".utf8).write(to: first)
        try Data("second".utf8).write(to: second)
        let moved = try copies.take(first, move: true)
        XCTAssertEqual(moved.lastPathComponent, "IMG-0412.MOV")
        XCTAssertEqual(moved.deletingLastPathComponent().deletingLastPathComponent().path, root.path, "In a folder of its own under the copies' root")
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path), "The picked file is moved, not copied")
        XCTAssertEqual(try Data(contentsOf: moved), Data("first".utf8))
        XCTAssertEqual(try moved.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        let copied = try copies.take(second, move: false)
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path), "A file that must stay where it is is copied")
        XCTAssertNotEqual(moved.deletingLastPathComponent(), copied.deletingLastPathComponent())
        copies.removeAll(keeping: [copied])
        XCTAssertFalse(FileManager.default.fileExists(atPath: moved.deletingLastPathComponent().path), "A copy nothing keeps goes with its folder")
        XCTAssertEqual(try Data(contentsOf: copied), Data("second".utf8), "and one still kept stays")
        copies.remove(second)
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.path), "Anything that isn't a copy is left alone")
        copies.remove(copied)
        XCTAssertFalse(FileManager.default.fileExists(atPath: copied.deletingLastPathComponent().path))
        copies.removeAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
}
