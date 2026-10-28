import XCTest
import SottoCore

/// What a paste or a share puts in a reply box, and the inbox the share extension leaves it in (ADR-0157).
final class SharedItemTests: XCTestCase {
    func testCopiedWordsStayWordsAndCopiedFilesGoAsFiles() {
        XCTAssertEqual(SharedItemKind(types: ["public.utf8-plain-text"], suggestedName: nil), .words)
        // A page's copied words bring a web archive and HTML with them; they are still words.
        XCTAssertEqual(SharedItemKind(types: ["com.apple.webarchive", "public.html", "public.utf8-plain-text"], suggestedName: nil), .words)
        XCTAssertEqual(SharedItemKind(types: ["public.url", "public.utf8-plain-text"], suggestedName: nil), .words)
        // A text file copied in Files carries its name, which makes it a file.
        XCTAssertEqual(SharedItemKind(types: ["public.plain-text"], suggestedName: "notes.txt"), .file("public.plain-text"))
        XCTAssertEqual(SharedItemKind(types: ["com.adobe.pdf"], suggestedName: nil), .file("com.adobe.pdf"))
        XCTAssertEqual(SharedItemKind(types: ["public.zip-archive"], suggestedName: "build.zip"), .file("public.zip-archive"))
        XCTAssertEqual(SharedItemKind(types: ["public.png"], suggestedName: nil), .photo("public.png"))
        XCTAssertEqual(SharedItemKind(types: ["public.heic"], suggestedName: "IMG_0001.HEIC"), .photo("public.heic"))
        XCTAssertNil(SharedItemKind(types: [], suggestedName: nil))
    }

    func testANameKeepsItsOwnExtensionOrTakesItsTypes() {
        XCTAssertEqual(SharedItemKind.name("Report.pdf", type: "com.adobe.pdf", fallback: "Pasted file"), "Report.pdf")
        XCTAssertEqual(SharedItemKind.name("Report", type: "com.adobe.pdf", fallback: "Pasted file"), "Report.pdf")
        XCTAssertEqual(SharedItemKind.name(nil, type: "com.adobe.pdf", fallback: "Pasted file"), "Pasted file.pdf")
        XCTAssertEqual(SharedItemKind.name("  ", type: "public.png", fallback: "Shared photo"), "Shared photo.png")
    }

    func testAShareFolderNeverTakesTheManifestsNameOrAnotherFilesName() {
        XCTAssertEqual(ShareInbox.safeName("a/b:c.txt", taken: []), "a-b-c.txt")
        XCTAssertEqual(ShareInbox.safeName("share.json", taken: []), "Shared file")
        XCTAssertEqual(ShareInbox.safeName("..", taken: []), "Shared file")
        XCTAssertEqual(ShareInbox.safeName("Photo.png", taken: ["Photo.png"]), "Photo 2.png")
        XCTAssertEqual(ShareInbox.safeName("Notes", taken: ["Notes", "Notes 2"]), "Notes 3")
    }

    func testTheInboxGivesCompleteSharesOldestFirstAndLetsOldOnesGo() throws {
        let container = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: container) }
        let root = ShareInbox.folder(in: container), now = Date()
        func share(_ name: String, sharedAt: Date?) throws -> URL {
            let folder = root.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            if let sharedAt { try ShareInbox.write(.init(words: name, files: [], sharedAt: sharedAt), to: folder) }
            return folder
        }
        _ = try share("newer", sharedAt: now.addingTimeInterval(-10))
        _ = try share("older", sharedAt: now.addingTimeInterval(-60))
        let writing = try share("writing", sharedAt: nil)
        let stale = try share("stale", sharedAt: now.addingTimeInterval(-ShareInbox.keptFor - 1))
        XCTAssertEqual(ShareInbox.pending(in: container, now: now).map(\.manifest.words), ["older", "newer"])
        // One still being written waits; one past a day is removed.
        XCTAssertTrue(FileManager.default.fileExists(atPath: writing.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
    }
}
