import XCTest
import SottoCore

/// Files from a thread's reply box, staged in parts, and sent files brought back for Quick Look (ADR-0131, October 25
/// amendment).
final class FileReplyTests: XCTestCase {
    private let host = "00000000-0000-4000-8000-000000000001"
    private let mebibyte = 1024 * 1024
    private func json(_ value: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(value.utf8)) }
    private func number(_ value: JSONValue) -> Int? { if case .number(let number) = value { return Int(number) }; return nil }

    /// A computer that keeps files: it gathers each upload's parts and answers the last with the file's handle.
    @MainActor private final class FileHost {
        var parts: [JSONValue] = []
        var kept: [String: Data] = [:]
        var refusal: Error?
        var reads: [JSONValue] = []
        /// What `attachment-file` answers for the part it is asked for; nil answers null, as for a file the host let go.
        var sent: ((Int) throws -> JSONValue)?
        private var uploads: [String: Data] = [:]
        func answer(_ op: String, _ fields: JSONValue) throws -> JSONValue {
            if op == "attachment-file" {
                reads.append(fields)
                guard let sent, case .number(let part) = fields["part"] else { return .null }
                return try sent(Int(part))
            }
            if let refusal { throw refusal }
            parts.append(fields)
            guard case .string(let upload) = fields["uploadId"], case .string(let data) = fields["data"], let bytes = Data(base64Encoded: data),
                  case .number(let index) = fields["index"], case .number(let count) = fields["count"],
                  case .string(let digest) = fields["digest"] else { throw ClientError.invalidRequest }
            uploads[upload, default: Data()].append(bytes)
            guard Int(index) == Int(count) - 1 else { return .null }
            kept[digest] = uploads.removeValue(forKey: upload)
            return .object(["id": .string("file-\(kept.count)"), "name": fields["name"], "mimeType": fields["mimeType"],
                            "sizeBytes": fields["sizeBytes"], "digest": .string(digest)])
        }
    }

    @MainActor private func fixture(supportsImages: Bool = true,
                                    features: [String] = ["host-folders", "attachment-staging", "file-staging", "attachment-files"]) async throws -> (AppModel, ThreadRef, FileHost) {
        TestKeychain.items = [:]; TestKeychain.locked = false; TestKeychain.unreadableAccount = nil; TestKeychain.unwritableAccount = nil
        HostConnection.instances = []; HostConnection.afterGreeting = nil; HostConnection.failDetail = false; HostConnection.holdDetail = false
        HostConnection.mayAnswer = false; HostConnection.receipt = .object(["status": .string("unknown")]); HostConnection.receipts = [:]
        HostConnection.loseAcknowledgement = false; HostConnection.features = features
        HostConnection.shells = [:]; HostConnection.commandHandler = nil; HostConnection.folderHandler = nil
        HostConnection.stageHandler = nil; HostConnection.previewHandler = nil
        HostConnection.photoLoadLimit = { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
        let files = FileHost()
        HostConnection.fileHandler = { op, fields in try await files.answer(op, fields) }
        let pairing = try json(#"{"v":1,"hostId":"\#(host)","clientId":"phone","token":"fixture"}"#).decode(Pairing.self)
        try TestKeychain.store.write([host], account: ComputerStore.indexAccount)
        try TestKeychain.store.write(SavedComputer(address: "https://laptop.example.ts.net:8443", pairing: pairing, reportedName: "Laptop"), account: ComputerStore.account(host))
        HostConnection.shell = try json(#"{"hostId":"\#(host)","host":{"hostId":"\#(host)","name":"Laptop","threads":[{"id":"t","projectId":"p","title":"Thread","status":"idle","requests":[],"modelId":"m"}],"projects":[],"models":[{"id":"m","name":"Model","provider":"Claude","ready":true,"supportsImages":\#(supportsImages)}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}}"#)
        HostConnection.detail = try json(#"{"threadId":"t","revision":1,"messages":[]}"#)
        HostConnection.commandHandler = { _, command, id in
            guard case .object(var root) = HostConnection.shell else { throw ClientError.invalidProtocol }
            if command["type"] == .string("manual-send") {
                root["deliveries"] = .array([.object(["threadId": command["threadId"], "draftId": command["draftId"], "status": .string("accepted")])])
            }
            HostConnection.shell = .object(root)
            HostConnection.receipts[id] = .object(["status": .string("completed")])
            return HostConnection.shell
        }
        let model = AppModel(keychain: TestKeychain.store,
                             preparePhoto: { _, name in PreparedPhoto(name: name + ".jpg", mimeType: "image/jpeg", base64: "/9j/AA==", byteCount: 4, dimensions: nil, thumbnail: nil) },
                             receiptSleep: { _ in },
                             photoLoadLimit: { try await HostConnection.photoLoadLimit() })
        model.phase(.active); await model.waitForActivation()
        return (model, ThreadRef(hostID: host, threadID: "t"), files)
    }
    /// A file of `bytes`, with a first and last byte of its own so its parts can be told apart.
    private func contents(_ bytes: Int) -> Data {
        var data = Data(count: bytes); data[0] = 1; data[bytes - 1] = 2; return data
    }
    private func source(_ name: String, _ data: Data, size: Int? = nil, read: (@Sendable () -> Void)? = nil) -> FileSource {
        FileSource(name: name, sizeBytes: size ?? data.count) { read?(); return data }
    }
    @MainActor private func sent(_ connection: HostConnection) -> [JSONValue] {
        connection.commands.filter { $0["type"] == .string("manual-send") }
    }

    @MainActor func testAFileGoesUpInPartsAndItsReplyCarriesItsHandle() async throws {
        let (model, ref, files) = try await fixture()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        let data = contents(9 * mebibyte)
        XCTAssertEqual(model.fileSupport(ref), .available)
        model.attachFiles(ref, from: [source("quarterly-report.pdf", data)])
        await model.waitForPhotos()
        // Two parts of one upload, in order, each naming the whole file.
        XCTAssertEqual(files.parts.map { number($0["index"]) }, [0, 1])
        XCTAssertEqual(Set(files.parts.compactMap { $0["uploadId"].string }).count, 1)
        XCTAssertEqual(files.parts.map { $0["mimeType"] }, [.string("application/pdf"), .string("application/pdf")])
        XCTAssertEqual(files.kept[Files.digest(data)], data, "The computer has the file's exact bytes")
        let file = try XCTUnwrap(model.files(ref).first)
        XCTAssertEqual(file.staged?.id, "file-1")
        XCTAssertNil(file.progress)
        XCTAssertTrue(model.canSendReply(ref), "Files alone are a reply")
        await model.send(ref)
        let replies = sent(connection)
        XCTAssertEqual(replies.count, 1)
        guard case .array(let attachments) = replies[0]["attachments"] else { return XCTFail("The reply carried no file") }
        XCTAssertEqual(attachments.map { $0["id"] }, [.string("file-1")])
        XCTAssertEqual(attachments[0]["name"], .string("quarterly-report.pdf"))
        XCTAssertEqual(number(attachments[0]["sizeBytes"]), data.count)
        XCTAssertEqual(files.parts.count, 2, "A fresh handle is not staged again")
        XCTAssertTrue(model.files(ref).isEmpty)
    }

    @MainActor func testFilesPastTheLimitsAreNotAttachedAndNotRead() async throws {
        let (model, ref, files) = try await fixture()
        final class Reads: @unchecked Sendable { var count = 0 }
        let reads = Reads()
        model.attachFiles(ref, from: [source("small.txt", Data("a".utf8), read: { reads.count += 1 }),
                                      source("recording.mov", Data("b".utf8), size: 64 * mebibyte, read: { reads.count += 1 })])
        await model.waitForPhotos()
        XCTAssertEqual(model.photoNotices[ref.id], "Each file must be 25 MB or smaller. Nothing was attached. Choose a smaller file.")
        XCTAssertTrue(model.files(ref).isEmpty)
        model.attachFiles(ref, from: (0..<9).map { source("note-\($0).txt", Data("n".utf8), read: { reads.count += 1 }) })
        await model.waitForPhotos()
        XCTAssertEqual(model.photoNotices[ref.id], "Attach up to 8 files at a time. Nothing was attached.")
        model.attachFiles(ref, from: [source("a.zip", Data("a".utf8), size: 25 * mebibyte, read: { reads.count += 1 }),
                                      source("b.zip", Data("b".utf8), size: 25 * mebibyte, read: { reads.count += 1 }),
                                      source("c.zip", Data("c".utf8), size: 1, read: { reads.count += 1 })])
        await model.waitForPhotos()
        XCTAssertEqual(model.photoNotices[ref.id], "Attachments must total 50 MB or less. Nothing was attached. Remove a file or choose smaller ones.")
        XCTAssertEqual(reads.count, 0, "Nothing past the limits is read")
        XCTAssertTrue(files.parts.isEmpty)
    }

    @MainActor func testPhotosAndFilesShareTheEight() async throws {
        let (model, ref, _) = try await fixture()
        model.attachFiles(ref, from: (0..<7).map { source("note-\($0).txt", Data("n".utf8)) })
        await model.waitForPhotos()
        model.attachPhotos(ref, from: (0..<2).map { index in PhotoSource(name: "Photo \(index)") { Data([1, 2, 3]) } })
        await model.waitForPhotos()
        XCTAssertEqual(model.photos(ref).count, 1)
        XCTAssertEqual(model.files(ref).count, 7)
        XCTAssertEqual(model.photoNotices[ref.id], "A reply can carry 8 attachments, so the others weren’t added.")
        model.attachFiles(ref, from: [source("one-more.txt", Data("n".utf8))])
        XCTAssertEqual(model.photoNotices[ref.id], "A reply can carry 8 attachments. Remove one to add another.")
        XCTAssertEqual(model.files(ref).count, 7)
    }

    @MainActor func testAComputerThatKeepsNoFilesIsAskedToKeepNone() async throws {
        let (model, ref, files) = try await fixture(features: ["host-folders", "attachment-staging"])
        XCTAssertEqual(model.fileSupport(ref), .needsUpdate)
        model.attachFiles(ref, from: [source("notes.txt", Data("notes".utf8))])
        await model.waitForPhotos()
        XCTAssertTrue(model.files(ref).isEmpty)
        XCTAssertTrue(files.parts.isEmpty)
        XCTAssertFalse(model.opensSentFiles(host))
        let outcome = await model.sentFile(ref, messageID: "m", attachmentID: "a", progress: { _ in }, wanted: { true })
        XCTAssertEqual(outcome, .failed)
        XCTAssertTrue(files.reads.isEmpty, "A computer that hands no files back is not asked for one")
    }

    @MainActor func testAFileGoesToAModelThatCantTakePhotos() async throws {
        let (model, ref, _) = try await fixture(supportsImages: false)
        let connection = try XCTUnwrap(HostConnection.instances.last)
        XCTAssertEqual(model.photoSupport(ref), .modelCannot)
        model.attachFiles(ref, from: [source("server.log", Data("log".utf8))])
        await model.waitForPhotos()
        await model.send(ref)
        XCTAssertEqual(sent(connection).count, 1)
    }

    @MainActor func testAFileTheComputerRefusesLeavesTheBoxWithItsReason() async throws {
        let (model, ref, files) = try await fixture()
        files.refusal = HostRefusal(failure: try JSONDecoder().decode(WireFailure.self, from: Data(#"{"code":"invalid_request","message":"This file could not be kept. Nothing was attached."}"#.utf8)))
        model.attachFiles(ref, from: [source("notes.txt", Data("notes".utf8))])
        await model.waitForPhotos()
        XCTAssertTrue(model.files(ref).isEmpty)
        XCTAssertEqual(model.photoNotices[ref.id], "This file could not be kept. Nothing was attached.")
    }

    @MainActor func testAFileThatCouldntReachItsComputerIsStagedWhenTheReplyIsSent() async throws {
        let (model, ref, files) = try await fixture()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        files.refusal = ClientError.readTimedOut
        model.attachFiles(ref, from: [source("notes.txt", Data("notes".utf8))])
        await model.waitForPhotos()
        XCTAssertNil(model.files(ref).first?.staged, "It stays in the box, unstaged")
        files.refusal = nil
        await model.send(ref)
        XCTAssertEqual(sent(connection).count, 1)
        XCTAssertEqual(files.kept.count, 1)
    }

    @MainActor func testARefusedReplyPutsItsFilesBackToBeStagedAgain() async throws {
        let (model, ref, files) = try await fixture()
        HostConnection.commandHandler = { _, _, _ in
            throw HostRefusal(failure: try JSONDecoder().decode(WireFailure.self, from: Data(#"{"code":"invalid_request","message":"Refused"}"#.utf8)))
        }
        model.attachFiles(ref, from: [source("notes.txt", Data("notes".utf8))])
        await model.waitForPhotos()
        await model.send(ref)
        XCTAssertEqual(model.failedFiles[ref.id]?.count, 1)
        model.restoreReply(ref)
        XCTAssertNil(model.failedFiles[ref.id])
        XCTAssertEqual(model.files(ref).count, 1)
        XCTAssertNil(model.files(ref).first?.staged, "Staged again when it is next sent")
        XCTAssertEqual(files.kept.count, 1)
    }

    @MainActor func testASentFileComesBackInPartsAndIsCheckedBeforeItOpens() async throws {
        let (model, ref, files) = try await fixture()
        let data = contents(9 * mebibyte), digest = Files.digest(data)
        func part(_ index: Int, digest: String) -> JSONValue {
            let range = Files.partRanges(data.count)[index]
            return .object(["name": .string("quarterly-report.pdf"), "mimeType": .string("application/pdf"), "sizeBytes": .number(Double(data.count)),
                            "digest": .string(digest), "part": .number(Double(index)), "parts": .number(2),
                            "data": .string(data.subdata(in: range).base64EncodedString())])
        }
        final class Progress { var seen: [Double] = [] }
        let progress = Progress()
        files.sent = { part($0, digest: digest) }
        let opened = await model.sentFile(ref, messageID: "m", attachmentID: "a", progress: { progress.seen.append($0) }, wanted: { true })
        XCTAssertEqual(opened, .file(name: "quarterly-report.pdf", data: data))
        XCTAssertEqual(progress.seen, [0.5, 1])
        XCTAssertEqual(files.reads.map { number($0["part"]) }, [0, 1])
        XCTAssertEqual(files.reads.first?["messageId"], .string("m"))
        // Bytes that aren't the ones their handle named never open.
        files.sent = { part($0, digest: String(repeating: "e", count: 64)) }
        let forged = await model.sentFile(ref, messageID: "m", attachmentID: "a", progress: { _ in }, wanted: { true })
        XCTAssertEqual(forged, .failed)
        // A file the computer no longer keeps says so.
        files.sent = nil
        let gone = await model.sentFile(ref, messageID: "m", attachmentID: "a", progress: { _ in }, wanted: { true })
        XCTAssertEqual(gone, .notKept)
        // Nothing is asked for once nothing wants it.
        files.reads = []
        let unwanted = await model.sentFile(ref, messageID: "m", attachmentID: "a", progress: { _ in }, wanted: { false })
        XCTAssertEqual(unwanted, .failed)
        XCTAssertTrue(files.reads.isEmpty)
    }
}
