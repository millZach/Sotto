import XCTest
@testable import SottoCore

final class PhotoTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T { try JSONDecoder().decode(type, from: Data(text.utf8)) }
    private func handle(_ id: String, bytes: Int = 1_000) -> StagedImage {
        StagedImage(id: id, name: "Photo 1.jpg", mimeType: "image/jpeg", sizeBytes: bytes, digest: String(repeating: "a", count: 64),
                    dimensions: ImageDimensions(original: ImageSize(width: 4032, height: 3024), sent: ImageSize(width: 2576, height: 1932)))
    }

    func testAReplyCarriesItsStagedPhotosByHandleAndNeedsNoWords() throws {
        let command = try Commands.prompt(threadID: "t", text: "", draftID: UUID().uuidString, images: [handle("one"), handle("two")])
        guard case .array(let images) = command["attachments"] else { return XCTFail("The reply carries no photos") }
        XCTAssertEqual(images.count, 2)
        XCTAssertEqual(images[0]["id"], .string("one")); XCTAssertEqual(images[0]["sizeBytes"], .number(1_000))
        XCTAssertEqual(images[0]["digest"], .string(String(repeating: "a", count: 64)))
        XCTAssertEqual(images[0]["dimensions"]["original"]["width"], .number(4032))
        XCTAssertEqual(images[0]["data"], .null, "A reply never carries the image itself")
        // Words alone still send without an attachments field, as before.
        XCTAssertEqual(try Commands.prompt(threadID: "t", text: "Reply", draftID: UUID().uuidString)["attachments"], .null)
    }
    func testAReplyOutsideTheHostsPhotoLimitsIsNeverBuilt() {
        let draft = UUID().uuidString
        let nine = (1...9).map { handle("photo-\($0)") }
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "", draftID: draft, images: nine))
        let heavy = (1...3).map { handle("photo-\($0)", bytes: 8 * 1024 * 1024) }
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "", draftID: draft, images: heavy), "Over 20 MiB together")
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "", draftID: draft, images: [handle("same"), handle("same")]))
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "", draftID: draft, images: [handle("bad id!")]))
        let wrongType = StagedImage(id: "svg", name: "x.svg", mimeType: "image/svg+xml", sizeBytes: 10, digest: String(repeating: "b", count: 64))
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "", draftID: draft, images: [wrongType]))
        XCTAssertThrowsError(try Commands.prompt(threadID: "t", text: "  ", draftID: draft, images: []))
    }
    func testOneMorePhotoFitsOnlyInsideTheLimits() {
        XCTAssertTrue(Photos.fits(2_000_000, with: [2_000_000, 2_000_000]))
        XCTAssertFalse(Photos.fits(PhotoLimits.bytesEach + 1, with: []))
        XCTAssertFalse(Photos.fits(6 * 1024 * 1024, with: [8 * 1024 * 1024, 7 * 1024 * 1024]))
        XCTAssertFalse(Photos.fits(1, with: Array(repeating: 1, count: PhotoLimits.count)))
        XCTAssertFalse(Photos.fits(0, with: []))
    }
    func testAPhotoIsStagedWithItsBytesNameAndSizes() throws {
        let request = try Photos.stage(name: "Photo 1.jpg", mimeType: "image/jpeg", base64: "/9j/4AAQ",
                                       dimensions: ImageDimensions(original: ImageSize(width: 10, height: 20), sent: ImageSize(width: 5, height: 10)))
        let value = JSONValue.object(request)
        XCTAssertEqual(value["op"], .string("stage-attachment"))
        XCTAssertEqual(value["image"]["data"], .string("/9j/4AAQ")); XCTAssertEqual(value["image"]["mimeType"], .string("image/jpeg"))
        XCTAssertEqual(value["image"]["dimensions"]["sent"]["height"], .number(10))
        XCTAssertThrowsError(try Photos.stage(name: "x", mimeType: "image/heic", base64: "AAAA", dimensions: nil), "HEIC is converted on the iPhone first")
        XCTAssertThrowsError(try Photos.stage(name: "x", mimeType: "image/png", base64: "", dimensions: nil))
        let tooLarge = String(repeating: "A", count: (PhotoLimits.bytesEach + 2) / 3 * 4 + 4)
        XCTAssertThrowsError(try Photos.stage(name: "x", mimeType: "image/png", base64: tooLarge, dimensions: nil))
    }
    func testAnImageFrameKeepsItsSlashes() throws {
        let data = try Wire.request(id: "one", session: "s", operation: try Photos.stage(name: "x", mimeType: "image/png", base64: "ab/cd+ef", dimensions: nil))
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("ab/cd+ef"))
        XCTAssertEqual(try Wire.decode(data)["image"]["data"], .string("ab/cd+ef"))
    }
    func testAStagedHandleIsReadAsTheHostSendsIt() throws {
        let staged = try decode(StagedImage.self, #"{"id":"a1","name":"Photo 1.jpg","mimeType":"image/jpeg","sizeBytes":2048,"digest":"\#(String(repeating: "c", count: 64))"}"#)
        XCTAssertTrue(staged.valid); XCTAssertNil(staged.dimensions)
        let invalid = try decode(StagedImage.self, #"{"id":"a1","name":"x","mimeType":"image/jpeg","sizeBytes":2048,"digest":"NOT-A-DIGEST"}"#)
        XCTAssertFalse(invalid.valid)
    }
    func testWhetherAThreadTakesPhotosAndWhyNot() throws {
        let shell = try decode(Shell.self, #"""
        {"hostId":"h","host":{"hostId":"h","name":"Laptop","projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true},
         "models":[{"id":"sees","name":"Sees","provider":"Claude","ready":true,"supportsImages":true},{"id":"blind","name":"Blind","provider":"Grok","ready":true,"supportsImages":false}],
         "threads":[{"id":"a","projectId":"p","title":"A","status":"idle","requests":[],"modelId":"sees"},
                    {"id":"b","projectId":"p","title":"B","status":"idle","requests":[],"modelId":"blind"},
                    {"id":"c","projectId":"p","title":"C","status":"idle","requests":[],"modelId":"gone"}]}}
        """#)
        let threads = shell.host.threads
        let features = ["attachment-staging"]
        XCTAssertEqual(PhotoSupport(online: true, thread: threads[0], host: shell.host, features: features), .available)
        XCTAssertEqual(PhotoSupport(online: true, thread: threads[1], host: shell.host, features: features), .modelCannot)
        XCTAssertEqual(PhotoSupport(online: true, thread: threads[2], host: shell.host, features: features), .modelUnknown)
        XCTAssertEqual(PhotoSupport(online: true, thread: threads[0], host: shell.host, features: ["host-folders"]), .needsUpdate)
        XCTAssertEqual(PhotoSupport(online: false, thread: threads[0], host: shell.host, features: features), .offline)
        XCTAssertNil(PhotoSupport.available.reason(computer: "Laptop"))
        XCTAssertEqual(PhotoSupport.modelCannot.reason(computer: "Laptop"), "This thread’s model can’t take photos. Change the model on Laptop to attach them.")
        XCTAssertEqual(PhotoSupport.needsUpdate.reason(computer: "Laptop"), "Update Sotto on Laptop to send photos from this iPhone.")
    }
    func testASentPhotoIsAskedForByItsMessageAndReadFromItsDataURL() async throws {
        let request = JSONValue.object(Photos.preview(threadID: "t", messageID: "m", attachmentID: "a"))
        XCTAssertEqual(request["op"], .string("preview"))
        XCTAssertEqual(request["request"], .object(["threadId": .string("t"), "messageId": .string("m"), "attachmentId": .string("a")]))
        let bytes = Data([0x89, 0x50, 0x4E, 0x47])
        let decoded = await Photos.bytes(fromDataURL: "data:image/png;base64," + bytes.base64EncodedString())
        XCTAssertEqual(decoded, bytes)
        let svg = await Photos.bytes(fromDataURL: "data:image/svg+xml;base64,PHN2Zz4=")
        XCTAssertNil(svg)
        let plain = await Photos.bytes(fromDataURL: "data:image/png,not-base64")
        XCTAssertNil(plain)
        let remote = await Photos.bytes(fromDataURL: "https://example.com/photo.png")
        XCTAssertNil(remote)
    }
    func testAMessageReadsWhetherItsPhotoIsKeptButNeverItsBytes() throws {
        let message = try decode(Message.self, #"{"id":"m","role":"user","text":"","attachments":[{"id":"a","name":"Photo 1.jpg","mimeType":"image/jpeg","sizeBytes":10,"preview":{"available":true}},{"id":"b","name":"old.png"}]}"#)
        XCTAssertEqual(message.attachments?.map(\.hasPreview), [true, false])
        XCTAssertEqual(message.attachments?.first?.sizeBytes, 10)
    }
    func testAHandleIsStagedAgainBeforeTheHostLetsItGo() {
        let now = Date()
        XCTAssertFalse(Photos.needsRestaging(stagedAt: now.addingTimeInterval(-44 * 60), now: now))
        XCTAssertTrue(Photos.needsRestaging(stagedAt: now.addingTimeInterval(-45 * 60), now: now))
        XCTAssertLessThan(PhotoLimits.restageAfter, 60 * 60, "The host lets an unowned image go after an hour")
    }
    func testAReceiptStillBeingCarriedOutIsNotAnUnconfirmedOne() throws {
        XCTAssertTrue(try decode(Receipt.self, #"{"status":"pending"}"#).stillWorking)
        XCTAssertFalse(try decode(Receipt.self, #"{"status":"unknown"}"#).stillWorking)
        XCTAssertFalse(try decode(Receipt.self, #"{"status":"completed"}"#).stillWorking)
    }
    func testAOneMillionContextThreadReadsItsBaseModelsEntry() throws {
        let models = try decode([ThreadModel].self, #"[{"id":"opus","name":"Opus","provider":"Claude","ready":true,"supportsImages":true},{"id":"native:claude:model:claude-opus-4-7","name":"Opus 4.7","provider":"Claude","ready":true,"supportsImages":true}]"#)
        XCTAssertEqual(CatalogEntry.model(models, id: "opus")?.id, "opus")
        XCTAssertEqual(CatalogEntry.model(models, id: "opus[1m]")?.id, "opus")
        XCTAssertEqual(CatalogEntry.model(models, id: "native:claude:model:claude-opus-4-7%5B1m%5D")?.id, "native:claude:model:claude-opus-4-7")
        XCTAssertNil(CatalogEntry.model(models, id: "native:codex:model:opus%5B1m%5D"), "Only Claude names a 1M-context variant")
        XCTAssertNil(CatalogEntry.model(models, id: "[1m]"))
        XCTAssertEqual(CatalogEntry.model(models, id: "opus[1M]")?.id, "opus", "The suffix is read in either case")
        XCTAssertEqual(CatalogEntry.model(models, id: "native:claude:model:claude-opus-4-7%5b1m%5d")?.id, "native:claude:model:claude-opus-4-7")
        XCTAssertNil(CatalogEntry.model(models, id: "opus[1m][1m]"), "Only one suffix is taken off, as the host does")
        XCTAssertNil(CatalogEntry.model(models, id: "native:claude:model:%E0%A4%A"), "A value that won't decode names nothing")
        XCTAssertNil(CatalogEntry.model(models, id: nil))
    }
    func testAnImageGoingEitherWayGetsTwoMinutes() {
        XCTAssertEqual(LivenessProgress.requestTimeout(operation: "stage-attachment"), 120)
        XCTAssertEqual(LivenessProgress.requestTimeout(operation: "preview"), 120)
    }
}
