import XCTest
import SottoCore

/// Files from the iPhone's reply box, and sent files brought back for Quick Look (ADR-0131, October 25 amendment).
final class FileTests: XCTestCase {
    private let mebibyte = 1024 * 1024
    private func digest(_ character: Character = "d") -> String { String(repeating: character, count: 64) }
    private func file(_ id: String, bytes: Int = 1_000, mimeType: String = "application/pdf") -> StagedFile {
        StagedFile(id: id, name: "\(id).pdf", mimeType: mimeType, sizeBytes: bytes, digest: digest())
    }
    private func image(_ id: String, bytes: Int = 1_000) -> StagedImage {
        StagedImage(id: id, name: "\(id).png", mimeType: "image/png", sizeBytes: bytes, digest: digest())
    }
    private func number(_ value: JSONValue) -> Int? { if case .number(let number) = value { return Int(number) }; return nil }

    func testAFileGoesInEightMiBPartsEachNamingTheWholeFile() throws {
        XCTAssertEqual(Files.partRanges(20 * mebibyte), [0..<(8 * mebibyte), (8 * mebibyte)..<(16 * mebibyte), (16 * mebibyte)..<(20 * mebibyte)])
        XCTAssertEqual(Files.partRanges(5), [0..<5])
        XCTAssertEqual(FileLimits.partsMax, 4, "A 25 MiB file takes four parts, as the host allows")
        let upload = UUID()
        let operation = try Files.stagePart(uploadID: upload, index: 1, count: 3, name: "build-output.zip", mimeType: "application/zip",
                                            sizeBytes: 20 * mebibyte, digest: digest(), data: Data([1, 2, 3]))
        XCTAssertEqual(operation["op"], .string("stage-file-part"))
        let part = try XCTUnwrap(operation["part"])
        XCTAssertEqual(part["uploadId"], .string(upload.uuidString.lowercased()))
        XCTAssertEqual(number(part["index"]), 1)
        XCTAssertEqual(number(part["count"]), 3)
        XCTAssertEqual(part["name"], .string("build-output.zip"))
        XCTAssertEqual(part["mimeType"], .string("application/zip"))
        XCTAssertEqual(number(part["sizeBytes"]), 20 * mebibyte)
        XCTAssertEqual(part["digest"], .string(digest()))
        XCTAssertEqual(part["data"], .string("AQID"))
        // Nothing the host would refuse is built.
        let stage = { (index: Int, count: Int, mimeType: String, data: Data) in
            try Files.stagePart(uploadID: upload, index: index, count: count, name: "a.zip", mimeType: mimeType, sizeBytes: 100, digest: self.digest(), data: data)
        }
        XCTAssertThrowsError(try stage(3, 3, "application/zip", Data([1])), "A part past the last")
        XCTAssertThrowsError(try stage(0, 5, "application/zip", Data([1])), "More parts than a 25 MiB file takes")
        XCTAssertThrowsError(try stage(0, 1, "application/zip", Data()), "An empty part")
        XCTAssertThrowsError(try stage(0, 1, "Application/Zip", Data([1])), "A type the host's schema refuses")
        XCTAssertThrowsError(try stage(0, 1, "application/zip", Data(count: 8 * mebibyte + 1)), "A part larger than a frame takes")
    }

    func testAReplyCarriesPhotosAndFilesWithinTheHostsLimits() throws {
        let draft = UUID().uuidString
        let command = try Commands.prompt(threadID: "t", text: "", draftID: draft, images: [image("photo")], files: [file("report"), file("log")])
        guard case .array(let attachments) = command["attachments"] else { return XCTFail("The reply carried nothing") }
        XCTAssertEqual(attachments.map { $0["id"] }, [.string("photo"), .string("report"), .string("log")])
        XCTAssertEqual(attachments[1]["mimeType"], .string("application/pdf"))
        XCTAssertEqual(command["text"], .string(""), "Files alone are a reply")
        XCTAssertNoThrow(try Commands.queue(threadID: "t", text: "", draftID: draft, files: [file("report", bytes: 25 * mebibyte), file("log", bytes: 25 * mebibyte)]))
        // Eight with the photos, 50 MiB in all, ids once each, and handles the host would take back.
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "x", draftID: draft, images: (0..<4).map { image("p\($0)") }, files: (0..<5).map { file("f\($0)") }))
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "x", draftID: draft, images: [image("photo")],
                                                 files: [file("a", bytes: 25 * mebibyte), file("b", bytes: 25 * mebibyte)]))
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "x", draftID: draft, images: [image("same")], files: [file("same")]))
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "x", draftID: draft, files: [file("big", bytes: 25 * mebibyte + 1)]))
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "x", draftID: draft, files: [file("png", bytes: 11 * mebibyte, mimeType: "image/png")]),
                             "A file of a photo's type is held to a photo's 10 MiB")
    }

    func testFilesPastTheLimitsAreRefusedInTheDesktopsWords() {
        XCTAssertNil(Files.refusal(adding: [25 * mebibyte], to: [25 * mebibyte]))
        XCTAssertEqual(Files.refusal(adding: [1, 25 * mebibyte + 1], to: []), "Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file.")
        XCTAssertEqual(Files.refusal(adding: Array(repeating: 1, count: 9), to: []), "Attach up to 8 files at a time. Nothing was attached.")
        XCTAssertEqual(Files.refusal(adding: Array(repeating: 1, count: 6), to: [1, 1, 1]), "A reply can carry 8 attachments. Remove one to add another.")
        XCTAssertEqual(Files.refusal(adding: [25 * mebibyte, 1], to: [25 * mebibyte]),
                       "Attachments must total 50 MB or less. Nothing was attached. Remove a file or choose smaller ones.")
    }

    func testAFilesTypeComesFromItsExtension() {
        XCTAssertEqual(Files.mimeType(forName: "quarterly-report.pdf"), "application/pdf")
        XCTAssertEqual(Files.mimeType(forName: "settings.JSON"), "application/json")
        XCTAssertEqual(Files.mimeType(forName: "Makefile"), "application/octet-stream")
        XCTAssertEqual(Files.mimeType(forName: "notes.sotto-unknown-type"), "application/octet-stream")
        XCTAssertEqual(Files.mimeType(forName: "screenshot.png"), "image/png", "A photo chosen in Files is still a photo")
    }

    func testWhetherAThreadsBoxTakesFilesAndWhyNot() {
        XCTAssertEqual(FileSupport(online: true, features: ["attachment-staging", "file-staging"]), .available)
        XCTAssertEqual(FileSupport(online: true, features: ["attachment-staging"]), .needsUpdate)
        XCTAssertEqual(FileSupport(online: false, features: ["file-staging"]), .offline)
        XCTAssertNil(FileSupport.available.reason(computer: "Studio PC"))
        XCTAssertEqual(FileSupport.needsUpdate.reason(computer: "Studio PC"), "This computer cannot keep files yet. Update Sotto there to attach them.")
        XCTAssertEqual(FileSupport.offline.reason(computer: "Studio PC"), "Reconnect to Studio PC to attach files.")
    }

    func testAStagedFileIsReadAsTheHostSendsIt() throws {
        let handle = try JSONDecoder().decode(StagedFile.self, from: Data(#"{"id":"file-1","name":"server.log","mimeType":"text/plain","sizeBytes":184320,"digest":"\#(digest())"}"#.utf8))
        XCTAssertTrue(handle.valid)
        XCTAssertEqual(handle.wire["name"], .string("server.log"))
        XCTAssertFalse(StagedFile(id: "a b", name: "x", mimeType: "text/plain", sizeBytes: 1, digest: digest()).valid)
        XCTAssertFalse(StagedFile(id: "a", name: "x", mimeType: "text/plain", sizeBytes: 1, digest: digest("D")).valid)
        XCTAssertFalse(StagedFile(id: "a", name: " ", mimeType: "text/plain", sizeBytes: 1, digest: digest()).valid)
    }

    func testASentFileIsAskedForByPartAndCheckedAgainstItsHandle() throws {
        let request = Files.open(threadID: "t", messageID: "m", attachmentID: "a", part: 2)
        XCTAssertEqual(request["op"], .string("attachment-file"))
        XCTAssertEqual(request["request"]?["messageId"], .string("m"))
        XCTAssertEqual(number(request["request"]?["part"] ?? .null), 2)
        var bytes = Data(count: 8 * mebibyte + 10)
        bytes[0] = 1; bytes[bytes.count - 1] = 2
        let whole = Files.digest(bytes)
        func part(_ index: Int, _ range: Range<Int>, digest: String? = nil, name: String = "report.pdf") throws -> SentFilePart {
            let json = #"{"name":"\#(name)","mimeType":"application/pdf","sizeBytes":\#(bytes.count),"digest":"\#(digest ?? whole)","part":\#(index),"parts":2,"data":"\#(bytes.subdata(in: range).base64EncodedString())"}"#
            return try JSONDecoder().decode(SentFilePart.self, from: Data(json.utf8))
        }
        let first = try part(0, 0..<(8 * mebibyte)), second = try part(1, (8 * mebibyte)..<bytes.count)
        var assembly = try XCTUnwrap(SentFileAssembly(first: first))
        XCTAssertEqual(assembly.progress, 0.5)
        XCTAssertNil(assembly.finish(), "Half a file is not a file")
        XCTAssertFalse(assembly.add(first), "A part again, out of order")
        XCTAssertFalse(assembly.add(try part(1, (8 * mebibyte)..<bytes.count, name: "other.pdf")), "A part of another file")
        XCTAssertTrue(assembly.add(second))
        XCTAssertEqual(assembly.finish(), bytes)
        // Bytes that aren't the ones their handle named are never kept.
        var forged = try XCTUnwrap(SentFileAssembly(first: try part(0, 0..<(8 * mebibyte), digest: digest("e"))))
        XCTAssertTrue(forged.add(try part(1, (8 * mebibyte)..<bytes.count, digest: digest("e"))))
        XCTAssertNil(forged.finish())
        XCTAssertNil(SentFileAssembly(first: second), "A file starts at its first part")
        XCTAssertEqual(Files.digest(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testASafeNameKeepsItsExtensionAndNeverLeavesItsFolder() {
        XCTAssertEqual(Files.safeName("quarterly-report.pdf"), "quarterly-report.pdf")
        XCTAssertEqual(Files.safeName("../../etc/passwd"), "passwd")
        XCTAssertEqual(Files.safeName(#"C:\Users\zach\server log.txt"#), "server-log.txt")
        XCTAssertEqual(Files.safeName("CON.txt"), "_CON.txt")
        XCTAssertEqual(Files.safeName("..."), "file")
        XCTAssertEqual(Files.safeName(".hidden"), "hidden")
        XCTAssertEqual(Files.safeName("evil\u{202E}fdp.exe"), "evil-fdp.exe")
        let long = Files.safeName(String(repeating: "a", count: 200) + ".pdf")
        XCTAssertEqual(long.unicodeScalars.count, 120)
        XCTAssertTrue(long.hasSuffix("a.pdf"))
    }

    func testSizesReadAsTheDesktopsDo() {
        XCTAssertEqual(Files.size(512), "512 B")
        XCTAssertEqual(Files.size(180 * 1024), "180 KB")
        XCTAssertEqual(Files.size(Int(2.4 * Double(mebibyte))), "2.4 MB")
        XCTAssertEqual(Files.size(25 * mebibyte), "25 MB")
    }

    func testTheOpenedCopyIsOneAtATimeAndGoes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("sotto-opened-\(UUID().uuidString)", isDirectory: true)
        let copies = OpenedFileCopies(root: root)
        defer { copies.removeAll() }
        let first = try copies.write(Data("first".utf8), name: "../notes.txt")
        XCTAssertEqual(first.lastPathComponent, "notes.txt")
        XCTAssertEqual(first.deletingLastPathComponent().deletingLastPathComponent().path, root.path,
                       "In a folder of its own under the copies' root, whatever its name said")
        XCTAssertEqual(try Data(contentsOf: first), Data("first".utf8))
        XCTAssertEqual(try first.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        let second = try copies.write(Data("second".utf8), name: "notes.txt")
        XCTAssertNotEqual(first.deletingLastPathComponent(), second.deletingLastPathComponent(), "Each copy has a folder of its own")
        copies.remove(first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.deletingLastPathComponent().path), "Removing one takes its folder")
        XCTAssertEqual(try Data(contentsOf: second), Data("second".utf8), "and leaves the other")
        copies.remove(URL(fileURLWithPath: "/tmp/elsewhere/notes.txt"))
        copies.removeAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    func testAPartOfAFileGoingEitherWayGetsTwoMinutes() {
        XCTAssertEqual(LivenessProgress.requestTimeout(operation: "stage-file-part"), 120)
        XCTAssertEqual(LivenessProgress.requestTimeout(operation: "attachment-file"), 120)
    }

    func testASentAttachmentIsAFileByItsType() throws {
        let attachments = try JSONDecoder().decode([Attachment].self, from: Data(#"[{"id":"a","name":"report.pdf","mimeType":"application/pdf","sizeBytes":10},{"id":"b","name":"shot.png","mimeType":"image/png","sizeBytes":10},{"id":"c","name":"old"}]"#.utf8))
        XCTAssertEqual(attachments.map(Files.isFile), [true, false, false])
    }
}
