import XCTest
@testable import SottoCore

/// A 3D model a thread made, as this iPhone shows it (the Meshy plan's ticket 7): the line read from its message's visual,
/// its view and the computer's news of it, and its still picture and USDZ fetched in parts, kept only when whole.
final class Models3dTests: XCTestCase {
    private let mebibyte = 1024 * 1024
    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("models-3d-tests-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func part(_ bytes: Data, _ range: Range<Int>, digest: String, total: Int? = nil) throws -> Model3dBytes {
        let json = #"{"data":"\#(bytes.subdata(in: range).base64EncodedString())","total":\#(total ?? bytes.count),"digest":"\#(digest)"}"#
        return try JSONDecoder().decode(Model3dBytes.self, from: Data(json.utf8))
    }
    private let view = #"{"id":"barrel","name":"Oak barrel","source":"words","state":"done","credits":30,"folder":"models","still":"Oak barrel.png","files":[{"name":"Oak barrel.png","bytes":2048},{"name":"Oak barrel.glb","bytes":4096},{"name":"Oak barrel.usdz","bytes":8192}]}"#

    func testAMessageReadsA3dModelsLineFromItsVisualAndEveryOtherVisualAsItsWords() throws {
        let line = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"visual:m","role":"assistant","text":"3D model: Oak barrel.","visual":{"id":"m","title":"Oak barrel","kind":"3d-model","source":"barrel"}}"#.utf8))
        XCTAssertEqual(line.model3d, Model3dLine(id: "barrel", name: "Oak barrel"))
        XCTAssertEqual(line.text, "3D model: Oak barrel.")
        // A diagram, a visual this build can't read, and none at all: the message stands as its words.
        for json in [#"{"id":"a","role":"assistant","text":"Flow","visual":{"id":"f","title":"Flow","kind":"diagram","source":"flowchart TD"}}"#,
                     #"{"id":"b","role":"assistant","text":"Odd","visual":{"kind":"3d-model"}}"#,
                     #"{"id":"c","role":"assistant","text":"Plain","createdAt":"2026-11-15T09:00:00.000Z"}"#] {
            let message = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
            XCTAssertNil(message.model3d)
            XCTAssertFalse(message.text.isEmpty)
        }
    }

    func testAViewSaysWhetherItsFilesAreThereAndWhetherThisIPhoneTurnsIt() throws {
        let done = try JSONDecoder().decode(Model3dView.self, from: Data(view.utf8))
        XCTAssertFalse(done.filesGone)
        XCTAssertTrue(done.turnsHere)
        XCTAssertEqual(done.usdz?.name, "Oak barrel.usdz")
        let gone = Model3dView(id: "barrel", name: "Oak barrel", source: "words", state: "done", credits: 30, folder: "models",
                               files: [.init(name: "Oak barrel.glb"), .init(name: "Oak barrel.usdz")])
        XCTAssertTrue(gone.filesGone)
        XCTAssertFalse(gone.turnsHere)
        let large = Model3dView(id: "barrel", name: "Oak barrel", source: "words", state: "done", credits: 30, folder: "models",
                                files: [.init(name: "Oak barrel.usdz", bytes: Models3d.bytesMax + 1)])
        XCTAssertFalse(large.turnsHere, "A USDZ past 64 MB shows its still picture")
        let making = try JSONDecoder().decode(Model3dView.self, from: Data(#"{"id":"barrel","name":"Oak barrel","source":"photo","state":"making","stage":"texture","percent":68,"secondsLeft":40,"credits":30,"folder":"models","files":[]}"#.utf8))
        XCTAssertEqual(making.percent, 68)
        XCTAssertFalse(making.filesGone)
    }

    func testAListedOneCarriesItsWordsAndWhenItWasAskedFor() throws {
        let json = "[" + view.dropLast() + #","threadId":"props","account":"Studio","askedAt":"2026-11-15T09:00:00.000Z","words":"An oak barrel"}]"#
        let listed = try JSONDecoder().decode([Model3dListed].self, from: Data(json.utf8))
        XCTAssertEqual(listed.first?.view.id, "barrel")
        XCTAssertEqual(listed.first?.words, "An oak barrel")
        XCTAssertEqual(listed.first?.askedAt, "2026-11-15T09:00:00.000Z")
        XCTAssertNil(listed.first?.photo)
    }

    func testTheComputersNewsArrivesAsAFrameAndTheHelloAcceptsIt() async throws {
        let frame = try await Wire.readFrame(Data(#"{"v":1,"event":"plugin-meshy-models","news":{"changed":{"threadId":"props","view":\#(view)},"removed":["gone"]}}"#.utf8))
        guard case .models3d(let news) = frame else { return XCTFail("Expected the news of 3D models") }
        XCTAssertEqual(news.changed?.threadId, "props")
        XCTAssertEqual(news.changed?.view.credits, 30)
        XCTAssertEqual(news.removed, ["gone"])
        guard case .array(let accepts) = Wire.snapshotHello["accepts"] else { return XCTFail("Hello has no feature opt-in") }
        XCTAssertEqual(accepts.filter { $0 == .string(Models3d.feature) }.count, 1)
    }

    func testItsRequestsNameA3dModelByIDAndAPartByOffsetAndDigest() {
        XCTAssertEqual(Models3d.view(id: "barrel")["op"], .string("plugin-meshy-model"))
        XCTAssertEqual(Models3d.thread(threadID: "props")["request"]?["threadId"], .string("props"))
        let first = Models3d.bytes(id: "barrel", part: .usdz, offset: 0, digest: nil)
        XCTAssertEqual(first["request"]?["part"], .string("usdz"))
        XCTAssertEqual(first["request"]?["digest"], .null)
        let later = Models3d.bytes(id: "barrel", part: .usdz, offset: 8 * mebibyte, digest: String(repeating: "a", count: 64))
        XCTAssertEqual(later["request"]?["offset"], .number(Double(8 * mebibyte)))
        XCTAssertEqual(later["request"]?["digest"], .string(String(repeating: "a", count: 64)))
        // Named by neither the computer's nor the 3D model's words, one file each.
        XCTAssertNotEqual(Models3d.cacheName(hostID: "a", id: "b"), Models3d.cacheName(hostID: "b", id: "a"))
        XCTAssertTrue(Models3d.cacheName(hostID: "a", id: "b").hasSuffix(".usdz"))
    }

    func testAUSDZIsWrittenPartByPartAndKeptOnlyWhenItIsTheFileNamed() throws {
        let bytes = Data((0..<(9 * mebibyte)).map { UInt8($0 % 251) })
        let digest = Files.digest(bytes)
        let url = try folder().appendingPathComponent("model.usdz")
        let download = try XCTUnwrap(Model3dDownload(first: try part(bytes, 0..<(8 * mebibyte), digest: digest), url: url))
        XCTAssertFalse(download.complete)
        XCTAssertEqual(download.received, 8 * mebibyte)
        XCTAssertTrue(download.add(try part(bytes, (8 * mebibyte)..<bytes.count, digest: digest)))
        XCTAssertTrue(download.finish())
        XCTAssertEqual(try Data(contentsOf: url), bytes)
    }

    func testPartsThatAreNotTheFileNamedLeaveNothing() throws {
        let bytes = Data((0..<(9 * mebibyte)).map { UInt8($0 % 13) })
        let root = try folder()
        // Bytes that aren't the ones their computer named are removed.
        let wrong = String(repeating: "e", count: 64)
        let forgedURL = root.appendingPathComponent("forged.usdz")
        let forged = try XCTUnwrap(Model3dDownload(first: try part(bytes, 0..<(8 * mebibyte), digest: wrong), url: forgedURL))
        XCTAssertTrue(forged.add(try part(bytes, (8 * mebibyte)..<bytes.count, digest: wrong)))
        XCTAssertFalse(forged.finish())
        XCTAssertFalse(FileManager.default.fileExists(atPath: forgedURL.path))
        // A part of another file, or one past the file's size, and nothing is kept.
        let digest = Files.digest(bytes)
        let mixedURL = root.appendingPathComponent("mixed.usdz")
        let mixed = try XCTUnwrap(Model3dDownload(first: try part(bytes, 0..<(8 * mebibyte), digest: digest), url: mixedURL))
        XCTAssertFalse(mixed.add(try part(bytes, (8 * mebibyte)..<bytes.count, digest: wrong)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: mixedURL.path))
        let pastURL = root.appendingPathComponent("past.usdz")
        let past = try XCTUnwrap(Model3dDownload(first: try part(bytes, 0..<(8 * mebibyte), digest: digest), url: pastURL))
        XCTAssertFalse(past.add(try part(bytes, 0..<(8 * mebibyte), digest: digest)))
        // A file past what the computer hands over, or a digest that is not one, is never begun.
        XCTAssertNil(Model3dDownload(first: try part(bytes, 0..<mebibyte, digest: digest, total: Models3d.bytesMax + 1), url: root.appendingPathComponent("large.usdz")))
        XCTAssertNil(Model3dDownload(first: try part(bytes, 0..<mebibyte, digest: "NOT-A-DIGEST"), url: root.appendingPathComponent("odd.usdz")))
        // Cut short: not complete, so not kept.
        let shortURL = root.appendingPathComponent("short.usdz")
        let short = try XCTUnwrap(Model3dDownload(first: try part(bytes, 0..<(8 * mebibyte), digest: digest), url: shortURL))
        XCTAssertFalse(short.finish())
        XCTAssertFalse(FileManager.default.fileExists(atPath: shortURL.path))
    }
}
