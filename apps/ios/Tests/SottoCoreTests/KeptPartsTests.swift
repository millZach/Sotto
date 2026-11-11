import XCTest
@testable import SottoCore

/// `kept-parts`: a host leaves out of a shell push each part that holds what the push before it held, and names it, and
/// the connection puts each back from that push before anything reads the shell (ADR-0028's November 10 amendment, #2393).
final class KeptPartsTests: XCTestCase {
    private let capabilities = #""capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}"#
    /// A push whose state carries `top` beside its host, whose host carries `host`, with thread records `revision` measured from `base`.
    private func push(top: String, host: String, revision: Int?, base: Int?) -> Data {
        let records = revision.map { #","threads":{"revision":\#($0),"base":\#(base.map { String($0) } ?? "null"),"changed":[]}"# } ?? ""
        let separator = top.isEmpty ? "" : ","
        return Data(#"{"v":1,"event":"shell","state":{"hostId":"h"\#(separator)\#(top),"host":{"hostId":"h","threads":[],"modelsRevision":3\#(host.isEmpty ? "" : "," + host)}}\#(records)}"#.utf8)
    }
    /// The parts a push carries whole: deliveries, a follow-up receipt, an empty error, and the host's name, projects, providers and capabilities.
    private var wholeTop: String { #""error":null,"deliveries":[{"id":"d1","threadId":"t","draftId":"00000000-0000-4000-8000-000000000001","status":"accepted","deliveredAt":"2026-11-10T12:00:00.000Z"}],"followupReceipts":[]"# }
    private var wholeHost: String { #""name":"Forge","projects":[{"id":"h:project","title":"Project","workspaceSettledAt":null}],"providers":[{"id":"claude","connection":"connected",\#(capabilities)}],\#(capabilities)"# }
    private let keptTop = #""kept":["deliveries","error","followupReceipts"]"#
    private let keptHost = #""kept":["name","projects","providers","capabilities"]"#
    private func shell(_ data: Data) async throws -> Shell {
        guard case .shell(let shell) = try await Wire.readFrame(data) else { XCTFail("Expected a shell push"); throw ClientError.invalidProtocol }
        return shell
    }

    func testThePhoneAcceptsKeptParts() {
        guard case .array(let accepts) = Wire.snapshotHello["accepts"] else { return XCTFail("Hello has no feature opt-in") }
        XCTAssertEqual(accepts.filter { $0 == .string("kept-parts") }.count, 1)
        XCTAssertEqual(accepts.filter { $0 == .string("changed-thread-records") }.count, 1, "Kept parts ride on changed thread records")
    }
    func testAPushNamesWhatItKeptAndReadsTheHostsKeptPartsEmptyUntilTheyGoBack() async throws {
        let kept = try await shell(push(top: keptTop, host: keptHost, revision: 2, base: 1))
        XCTAssertEqual(kept.keptParts?.kept, ["deliveries", "error", "followupReceipts"])
        XCTAssertEqual(kept.keptParts?.hostKept, ["name", "projects", "providers", "capabilities"])
        XCTAssertEqual(kept.host.name, "")
        XCTAssertEqual(kept.host.projects, [])
        XCTAssertNil(kept.deliveries)
        let whole = try await shell(push(top: wholeTop, host: wholeHost, revision: 1, base: nil))
        XCTAssertEqual(whole.keptParts?.keepsAny, false)
        XCTAssertEqual(whole.host.name, "Forge")
        // A host part that is missing and not named as kept is still unreadable.
        do { _ = try await Wire.readFrame(push(top: "", host: #""projects":[],\#(capabilities)"#, revision: 1, base: nil)); XCTFail("A host without its name was read") } catch {}
    }
    func testKeptPartsGoBackFromThePushBefore() async throws {
        var cache = KeptPartsCache()
        let pushedWhole = try await shell(push(top: wholeTop, host: wholeHost, revision: 1, base: nil))
        let pushedKept = try await shell(push(top: keptTop, host: keptHost, revision: 2, base: 1))
        let pushedAgain = try await shell(push(top: #""kept":["deliveries"]"#, host: #""kept":["name","projects","capabilities"]"#, revision: 3, base: 2))
        let first = try XCTUnwrap(cache.whole(pushedWhole))
        XCTAssertNil(first.keptParts, "Nothing past the connection sees the wire's form")
        let back = try XCTUnwrap(cache.whole(pushedKept))
        XCTAssertNil(back.keptParts)
        XCTAssertEqual(back.deliveries, first.deliveries)
        XCTAssertEqual(back.followupReceipts, first.followupReceipts)
        XCTAssertEqual(back.host.name, "Forge")
        XCTAssertEqual(back.host.projects, first.host.projects)
        XCTAssertEqual(back.host.providers, first.host.providers)
        XCTAssertEqual(back.host.capabilities, first.host.capabilities)
        XCTAssertEqual(back.threadRecords?.revision, 2, "The thread records stay for the records cache")
        // A push measured from that one keeps what it had once its parts were back; a part neither carried nor kept is absent.
        let again = try XCTUnwrap(cache.whole(pushedAgain))
        XCTAssertEqual(again.deliveries, first.deliveries)
        XCTAssertEqual(again.host.name, "Forge")
        XCTAssertNil(again.followupReceipts)
        XCTAssertNil(again.host.providers)
    }
    func testAPushThatCannotBePutBackIsNotShownAndChangesNothing() async throws {
        let whole = try await shell(push(top: wholeTop, host: wholeHost, revision: 1, base: nil))
        let fromNothing = try await shell(push(top: keptTop, host: keptHost, revision: 2, base: 1))
        let fromAnother = try await shell(push(top: keptTop, host: keptHost, revision: 3, base: 2))
        let unheldTop = try await shell(push(top: #""kept":["followups"]"#, host: keptHost, revision: 3, base: 1))
        let unheldHost = try await shell(push(top: keptTop, host: #""kept":["name","projects","capabilities","version"]"#, revision: 3, base: 1))
        let unmeasured = try await shell(push(top: keptTop, host: keptHost, revision: nil, base: nil))
        let next = try await shell(push(top: keptTop, host: keptHost, revision: 4, base: 1))
        var cache = KeptPartsCache()
        XCTAssertNil(cache.whole(fromNothing), "A new connection holds no parts")
        _ = try XCTUnwrap(cache.whole(whole))
        XCTAssertNil(cache.whole(fromAnother), "Measured from another push")
        XCTAssertNil(cache.whole(unheldTop), "Naming a part the push held did not have")
        XCTAssertNil(cache.whole(unheldHost), "Naming a host part the push held did not have")
        XCTAssertNil(cache.whole(unmeasured), "Keeping parts with no thread records to measure them by")
        // None of those moved what is held.
        let back = try XCTUnwrap(cache.whole(next))
        XCTAssertEqual(back.host.name, "Forge")
        XCTAssertEqual(back.deliveries?.count, 1)
    }
    func testAShellThatIsNotAPushIsReadAsItCame() async throws {
        let answer = try await Wire.readReply(Data(#"{"v":1,"id":"read","ok":true,"result":{"hostId":"h","host":{"hostId":"h","threads":[],\#(wholeHost)}}}"#.utf8), as: Shell.self)
        XCTAssertNil(answer.keptParts, "An answer's shell carries every part and names none")
        var cache = KeptPartsCache()
        XCTAssertEqual(cache.whole(answer), answer)
    }
}
