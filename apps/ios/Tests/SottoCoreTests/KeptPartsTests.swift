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

    private func watcherJSON(messages: String, working: Bool = true, observedAt: String = "2026-11-22T12:00:00.000Z", revision: Int = 1) -> String {
        #""watcher":{"hostId":"h","current":null,"conversation":{"messages":[\#(messages)],"earlierAvailable":true,"revision":\#(revision)},"receiptGroups":[],"watchedThreads":[],"needsYou":[],"inFlight":0,"inFlightLimit":8,"working":\#(working),"recoveryNotice":null,"observedAt":"\#(observedAt)"}"#
    }

    func testThePhoneAcceptsWatcherPhoneParts() {
        guard case .array(let accepts)? = WatcherWire.managementHello["accepts"] else { return XCTFail("Missing accepts") }
        XCTAssertEqual(accepts.filter { $0 == .string(WatcherWire.partsFeature) }.count, 1)
    }

    func testWatcherSubPartsAndConversationDeltaReassembleAcrossTopLevelKeepAndWindowSlide() async throws {
        var cache = KeptPartsCache()
        let m1 = #"{"id":"m1","role":"user","text":"First","createdAt":"2026-11-22T12:00:00.000Z"}"#
        let m2 = #"{"id":"m2","role":"assistant","text":"Hello","createdAt":"2026-11-22T12:00:01.000Z"}"#
        let first = try await shell(push(top: wholeTop + "," + watcherJSON(messages: m1 + "," + m2), host: wholeHost, revision: 1, base: nil))
        let appliedFirst = try XCTUnwrap(cache.whole(first))
        XCTAssertEqual(appliedFirst.watcher?.conversation.messages.map(\.text), ["First", "Hello"])

        // Push 2 keeps top-level `watcher` unchanged: `watcherParts` must carry forward for push 3.
        let topKept = try await shell(push(top: #""kept":["deliveries","error","followupReceipts","watcher"]"#, host: keptHost, revision: 2, base: 1))
        let appliedTopKept = try XCTUnwrap(cache.whole(topKept))
        XCTAssertEqual(appliedTopKept.watcher, appliedFirst.watcher)

        // Push 3 streams text into the last message via `conversationDelta` and keeps every other Watcher sub-part.
        let streamWatcher = #""watcher":{"observedAt":"2026-11-22T12:00:02.000Z","kept":["hostId","current","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice"],"conversationDelta":{"dropHead":0,"keep":2,"appendLastText":" world","tail":[],"earlierAvailable":true,"revision":2}}"#
        let streamed = try await shell(push(top: keptTop + "," + streamWatcher, host: keptHost, revision: 3, base: 2))
        let appliedStream = try XCTUnwrap(cache.whole(streamed))
        XCTAssertEqual(appliedStream.watcher?.conversation.messages.map(\.text), ["First", "Hello world"])
        XCTAssertEqual(appliedStream.watcher?.conversation.revision, 2)
        XCTAssertEqual(appliedStream.watcher?.working, true)
        XCTAssertEqual(appliedStream.watcher?.observedAt, "2026-11-22T12:00:02.000Z")
        XCTAssertNil(appliedStream.watcher?.conversationDelta)

        // Push 4 slides the window (`dropHead: 1`), appends a new message, and toggles `working`.
        let m3 = #"{"id":"m3","role":"user","text":"Next","createdAt":"2026-11-22T12:00:03.000Z"}"#
        let slideWatcher = #""watcher":{"working":false,"observedAt":"2026-11-22T12:00:03.000Z","kept":["hostId","current","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","recoveryNotice"],"conversationDelta":{"dropHead":1,"keep":1,"tail":[\#(m3)],"earlierAvailable":true,"revision":3}}"#
        let slid = try await shell(push(top: keptTop + "," + slideWatcher, host: keptHost, revision: 4, base: 3))
        let appliedSlide = try XCTUnwrap(cache.whole(slid))
        XCTAssertEqual(appliedSlide.watcher?.conversation.messages.map(\.id), ["m2", "m3"])
        XCTAssertEqual(appliedSlide.watcher?.conversation.messages.map(\.text), ["Hello world", "Next"])
        XCTAssertEqual(appliedSlide.watcher?.working, false)

        // Push 5 changes only `observedAt` and keeps `conversation` whole in `watcher.kept`.
        let metaWatcher = #""watcher":{"observedAt":"2026-11-22T12:00:04.000Z","kept":["hostId","current","conversation","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice"]}"#
        let meta = try await shell(push(top: keptTop + "," + metaWatcher, host: keptHost, revision: 5, base: 4))
        let appliedMeta = try XCTUnwrap(cache.whole(meta))
        XCTAssertEqual(appliedMeta.watcher?.conversation, appliedSlide.watcher?.conversation)
        XCTAssertEqual(appliedMeta.watcher?.observedAt, "2026-11-22T12:00:04.000Z")
    }

    func testInvalidWatcherDeltaOrUnheldSubPartIsRejectedWithoutMovingHeldState() async throws {
        var cache = KeptPartsCache()
        let m1 = #"{"id":"m1","role":"user","text":"First","createdAt":"2026-11-22T12:00:00.000Z"}"#
        let first = try await shell(push(top: wholeTop + "," + watcherJSON(messages: m1), host: wholeHost, revision: 1, base: nil))
        _ = try XCTUnwrap(cache.whole(first))

        let outOfBounds = try await shell(push(top: keptTop + #","watcher":{"observedAt":"2026-11-22T12:00:01.000Z","kept":["hostId","current","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice"],"conversationDelta":{"dropHead":0,"keep":5,"tail":[],"earlierAvailable":true,"revision":2}}"#, host: keptHost, revision: 2, base: 1))
        let overflowDrop = try await shell(push(top: keptTop + #","watcher":{"observedAt":"2026-11-22T12:00:01.000Z","kept":["hostId","current","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice"],"conversationDelta":{"dropHead":\#(Int.max),"keep":1,"tail":[],"earlierAvailable":true,"revision":2}}"#, host: keptHost, revision: 2, base: 1))
        let overflowKeep = try await shell(push(top: keptTop + #","watcher":{"observedAt":"2026-11-22T12:00:01.000Z","kept":["hostId","current","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice"],"conversationDelta":{"dropHead":1,"keep":\#(Int.max),"tail":[],"earlierAvailable":true,"revision":2}}"#, host: keptHost, revision: 2, base: 1))
        let appendZero = try await shell(push(top: keptTop + #","watcher":{"observedAt":"2026-11-22T12:00:01.000Z","kept":["hostId","current","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice"],"conversationDelta":{"dropHead":0,"keep":0,"appendLastText":"x","tail":[],"earlierAvailable":true,"revision":2}}"#, host: keptHost, revision: 2, base: 1))
        let unheldPart = try await shell(push(top: keptTop + #","watcher":{"observedAt":"2026-11-22T12:00:01.000Z","kept":["hostId","current","conversation","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice","machines"]}"#, host: keptHost, revision: 2, base: 1))
        let conflict = try await shell(push(top: keptTop + #","watcher":{"observedAt":"2026-11-22T12:00:01.000Z","kept":["hostId","current","conversation","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice"],"conversationDelta":{"dropHead":0,"keep":1,"tail":[],"earlierAvailable":true,"revision":2}}"#, host: keptHost, revision: 2, base: 1))

        XCTAssertNil(cache.whole(outOfBounds))
        XCTAssertNil(cache.whole(overflowDrop))
        XCTAssertNil(cache.whole(overflowKeep))
        XCTAssertNil(cache.whole(appendZero))
        XCTAssertNil(cache.whole(unheldPart))
        XCTAssertNil(cache.whole(conflict))

        // Held revision 1 is still intact after all rejections.
        let valid = try await shell(push(top: keptTop + #","watcher":{"observedAt":"2026-11-22T12:00:02.000Z","kept":["hostId","current","conversation","receiptGroups","watchedThreads","needsYou","inFlight","inFlightLimit","working","recoveryNotice"]}"#, host: keptHost, revision: 2, base: 1))
        let restored = try XCTUnwrap(cache.whole(valid))
        XCTAssertEqual(restored.watcher?.conversation.messages.map(\.text), ["First"])
    }
}
