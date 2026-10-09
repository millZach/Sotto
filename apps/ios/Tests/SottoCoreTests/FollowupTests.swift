import XCTest
@testable import SottoCore

/// Queuing a reply while a thread works, steering or removing it, and compacting a thread's context: the commands this
/// iPhone may build for them, and when the thread page offers each.
final class FollowupTests: XCTestCase {
    private let first = "11111111-1111-4111-8111-111111111111"
    private let second = "22222222-2222-4222-8222-222222222222"
    private let draft = "33333333-3333-4333-8333-333333333333"
    private let stamp = "2026-10-09T10:00:00.000Z"
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(type, from: Data(json.utf8)) }
    private func thread(status: String = "running", requests: String = "[]", _ extra: String = "") throws -> ThreadSummary {
        try decode(ThreadSummary.self, #"{"id":"t","projectId":"p","title":"Thread","status":"\#(status)","requests":\#(requests)\#(extra)}"#)
    }
    private func item(_ id: String, status: String = "queued", thread: String = "t", attachments: String = "[]", _ extra: String = "") -> String {
        #"{"id":"\#(id)","threadId":"\#(thread)","draftId":"\#(draft)","text":"Use the screenshots too.","attachments":\#(attachments),"createdAt":"\#(stamp)","updatedAt":"\#(stamp)","status":"\#(status)"\#(extra)}"#
    }
    private func shell(followups: String = "[]", _ extra: String = "") throws -> Shell {
        try decode(Shell.self, #"{"hostId":"h","host":{"name":"Laptop","threads":[],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"steer":true,"compact":true}},"followups":\#(followups)\#(extra)}"#)
    }
    private func capabilities(_ extra: String) throws -> ProviderCapabilities {
        try decode(ProviderCapabilities.self, #"{"submit":true,"interrupt":true,"questions":true,"permissions":true\#(extra)}"#)
    }

    // MARK: Commands

    func testTheQueueAndCompactionCommandsCarryOnlyTheHostsFields() throws {
        XCTAssertEqual(RemoteCommands.allowed["queue-followup"], ["threadId", "draftId", "text", "attachments", "skills", "files"])
        XCTAssertEqual(RemoteCommands.allowed["steer-followup"], ["threadId", "itemId"])
        XCTAssertEqual(RemoteCommands.allowed["remove-followup"], ["threadId", "itemId"])
        XCTAssertEqual(RemoteCommands.allowed["compact-thread"], ["threadId"])
        let queued = try Commands.queue(threadID: "t", text: "Also check the window", draftID: draft)
        XCTAssertEqual(queued, .object(["type": .string("queue-followup"), "threadId": .string("t"), "text": .string("Also check the window"), "draftId": .string(draft)]))
        XCTAssertEqual(try Commands.steerFollowup(threadID: "t", itemID: first), .object(["type": .string("steer-followup"), "threadId": .string("t"), "itemId": .string(first)]))
        XCTAssertEqual(try Commands.removeFollowup(threadID: "t", itemID: first), .object(["type": .string("remove-followup"), "threadId": .string("t"), "itemId": .string(first)]))
        XCTAssertEqual(try Commands.compact(threadID: "t"), .object(["type": .string("compact-thread"), "threadId": .string("t")]))
        XCTAssertEqual(try Commands.prompt(threadID: "t", text: "Now", draftID: draft)["type"], .string("manual-send"))
        // None of them needs the remote-answer policy, and none carries an unlisted field.
        XCTAssertEqual(RemoteCommands.needAnswerPolicy, ["answer"])
        XCTAssertThrowsError(try RemoteCommands.checked(.object(["type": .string("steer-followup"), "threadId": .string("t"), "itemId": .string(first), "text": .string("x")])))
        XCTAssertThrowsError(try RemoteCommands.checked(.object(["type": .string("compact-thread"), "threadId": .string("t"), "providerMode": .string("bypass")])))
    }

    func testAQueuedReplyIsCheckedLikeAReply() throws {
        for text in ["  ", String(repeating: "x", count: 100_001)] { XCTAssertThrowsError(try Commands.queue(threadID: "t", text: text, draftID: draft)) }
        XCTAssertThrowsError(try Commands.queue(threadID: "t", text: "Hello", draftID: "not-a-draft"))
        XCTAssertThrowsError(try Commands.steerFollowup(threadID: "t", itemID: "not-an-item"))
        XCTAssertThrowsError(try Commands.removeFollowup(threadID: "t", itemID: ""))
    }

    // MARK: Reading the queue

    func testAShellCarriesTheQueueAndTheNewThreadFields() throws {
        let refused = item(second, status: "failed", attachments: #"[{"id":"a"}]"#, #","error":"The provider refused it.","wakeUp":true"#)
        let read = try shell(followups: "[\(item(first)),\(refused)]", #","followupReceipts":[{"threadId":"t","draftId":"\#(draft)"}]"#)
        let items = try XCTUnwrap(read.followups)
        XCTAssertEqual(items.map(\.id), [first, second])
        XCTAssertEqual(items[0].status, "queued"); XCTAssertNil(items[0].wakeUp); XCTAssertEqual(items[0].attachmentCount, 0)
        XCTAssertEqual(items[1].error, "The provider refused it."); XCTAssertEqual(items[1].wakeUp, true); XCTAssertEqual(items[1].attachmentCount, 1)
        XCTAssertEqual(read.followupReceipts, [DeliveryReceipt(threadId: "t", draftId: draft)])
        XCTAssertEqual(read.host.capabilities.steer, true); XCTAssertEqual(read.host.capabilities.compact, true)
        let summary = try thread(#","manualCompactionSupported":false,"nativeSessionStarted":true"#)
        XCTAssertEqual(summary.manualCompactionSupported, false); XCTAssertEqual(summary.nativeSessionStarted, true)
        // An older computer sends none of them.
        let older = try decode(Shell.self, #"{"hostId":"h","host":{"name":"Laptop","threads":[],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}}"#)
        XCTAssertNil(older.followups); XCTAssertNil(older.host.capabilities.steer); XCTAssertNil(older.host.capabilities.compact)
        XCTAssertNil(try thread().manualCompactionSupported)
    }

    func testAThreadShowsOnlyItsOwnQueueAndLeavesADeliveredMessageToTheConversation() throws {
        let delivered = item(second, status: "dispatching", #","messageId":"m-2""#)
        let elsewhere = item("44444444-4444-4444-8444-444444444444", thread: "other")
        let read = try shell(followups: "[\(item(first)),\(delivered),\(elsewhere)]")
        XCTAssertEqual(FollowupQueue.items(read, threadID: "t", messages: nil).map(\.id), [first, second])
        let said = try decode(Message.self, #"{"id":"m-2","role":"user","text":"Use the screenshots too."}"#)
        XCTAssertEqual(FollowupQueue.items(read, threadID: "t", messages: [said]).map(\.id), [first])
        XCTAssertTrue(FollowupQueue.items(nil, threadID: "t", messages: nil).isEmpty)
    }

    func testTheQueueOrItsReceiptConfirmsAQueuedReply() throws {
        XCTAssertTrue(FollowupQueue.holds(try shell(followups: "[\(item(first))]"), threadID: "t", draftID: draft))
        XCTAssertTrue(FollowupQueue.holds(try shell(#","followupReceipts":[{"threadId":"t","draftId":"\#(draft)"}]"#), threadID: "t", draftID: draft))
        XCTAssertFalse(FollowupQueue.holds(try shell(followups: "[\(item(first))]"), threadID: "other", draftID: draft))
        XCTAssertFalse(FollowupQueue.holds(try shell(), threadID: "t", draftID: draft))
    }

    func testEachStateIsSaidInPlainWords() throws {
        let states = ["queued", "dispatching", "uncertain", "failed", "paused"].map { item(first, status: $0) }
        let read = try shell(followups: "[" + states.joined(separator: ",") + "]")
        XCTAssertEqual(try XCTUnwrap(read.followups).map(FollowupQueue.state),
                       ["Queued for after this turn", "Sending…", "Not confirmed", "Couldn’t send", "Paused"])
        XCTAssertEqual(try XCTUnwrap(read.followups).map(FollowupQueue.removable), [true, false, false, true, true])
    }

    // MARK: Steer now

    func testSteerNowIsOfferedForAQueuedMessageWhileAProviderThatSteersWorks() throws {
        let wakeUp = item(second, #","wakeUp":true"#)
        let refused = item(first, status: "failed")
        let read = try shell(followups: "[\(item(first)),\(wakeUp),\(refused)]")
        let items = try XCTUnwrap(read.followups)
        let steers = try capabilities(#","steer":true"#)
        XCTAssertTrue(FollowupQueue.steerOffered(items[0], thread: try thread(), capabilities: steers))
        XCTAssertFalse(FollowupQueue.steerOffered(items[1], thread: try thread(), capabilities: steers), "A wake-up is never steered")
        XCTAssertFalse(FollowupQueue.steerOffered(items[2], thread: try thread(), capabilities: steers), "Only a queued message")
        XCTAssertFalse(FollowupQueue.steerOffered(items[0], thread: try thread(status: "idle"), capabilities: steers), "Only into a running turn")
        XCTAssertFalse(FollowupQueue.steerOffered(items[0], thread: try thread(), capabilities: try capabilities(#","steer":false"#)))
        XCTAssertFalse(FollowupQueue.steerOffered(items[0], thread: try thread(), capabilities: try capabilities("")), "An older computer can't steer")
    }

    func testSteerWaitsForRequestsAndWorkAlreadyOnItsWay() throws {
        XCTAssertTrue(FollowupQueue.steerClear(try shell(followups: "[\(item(first))]"), thread: try thread()))
        XCTAssertFalse(FollowupQueue.steerClear(try shell(), thread: try thread(requests: #"[{"id":"r","kind":"question","text":"Which?","options":[]}]"#)))
        XCTAssertFalse(FollowupQueue.steerClear(try shell(#","busyThreadIds":["t"]"#), thread: try thread()))
        let sending = item(second, status: "dispatching"), unconfirmed = item(second, status: "uncertain")
        XCTAssertFalse(FollowupQueue.steerClear(try shell(followups: "[\(item(first)),\(sending)]"), thread: try thread()))
        XCTAssertFalse(FollowupQueue.steerClear(try shell(followups: "[\(unconfirmed)]"), thread: try thread()))
        XCTAssertFalse(FollowupQueue.steerClear(try shell(#","deliveries":[{"threadId":"t","draftId":"\#(draft)","status":"submitting"}]"#), thread: try thread()))
        XCTAssertTrue(FollowupQueue.steerClear(try shell(#","deliveries":[{"threadId":"other","draftId":"\#(draft)","status":"submitting"}],"busyThreadIds":["other"]"#), thread: try thread()))
    }

    // MARK: Compact context

    func testCompactionIsOfferedWhenTheProviderCompactsAndTheThreadHasNotRefused() throws {
        let compacts = try capabilities(#","compact":true"#)
        XCTAssertTrue(ContextCompaction.offered(compacts, thread: try thread()))
        XCTAssertTrue(ContextCompaction.offered(compacts, thread: try thread(#","manualCompactionSupported":true,"nativeSessionStarted":true"#)))
        XCTAssertFalse(ContextCompaction.offered(compacts, thread: try thread(#","manualCompactionSupported":false"#)))
        XCTAssertFalse(ContextCompaction.offered(compacts, thread: try thread(#","nativeSessionStarted":false"#)))
        XCTAssertFalse(ContextCompaction.offered(try capabilities(#","compact":false"#), thread: try thread()))
        XCTAssertFalse(ContextCompaction.offered(try capabilities(""), thread: try thread()))
        XCTAssertFalse(ContextCompaction.offered(nil, thread: try thread()))
    }

    func testCompactionWaitsAndSaysWhy() throws {
        let asked = try decode(Message.self, #"{"id":"u","role":"user","text":"Compare the drives."}"#)
        let compactOnly = try decode(Message.self, #"{"id":"c","role":"user","text":"  /compact  "}"#)
        let answer = try decode(Message.self, #"{"id":"a","role":"assistant","text":"Done."}"#)
        XCTAssertNil(ContextCompaction.held(try thread(status: "idle"), messages: [asked, answer], earlierAvailable: false))
        XCTAssertEqual(ContextCompaction.held(try thread(), messages: [asked], earlierAvailable: false), "Available when this turn ends")
        XCTAssertEqual(ContextCompaction.held(try thread(status: "idle", #","compaction":{"commandId":"c","status":"running"}"#), messages: [asked], earlierAvailable: false), "Already compacting")
        XCTAssertEqual(ContextCompaction.held(try thread(status: "idle", #","compaction":{"commandId":"c","status":"uncertain"}"#), messages: [asked], earlierAvailable: false), "Already compacting")
        XCTAssertNil(ContextCompaction.held(try thread(status: "idle", #","compaction":{"commandId":"c","status":"completed"}"#), messages: [asked], earlierAvailable: false))
        XCTAssertEqual(ContextCompaction.held(try thread(status: "idle", requests: #"[{"id":"r","kind":"question","text":"Which?","options":[]}]"#), messages: [asked], earlierAvailable: false),
                       "Available once the waiting request is answered")
        XCTAssertEqual(ContextCompaction.held(try thread(status: "idle"), messages: [compactOnly, answer], earlierAvailable: false), "Nothing to compact yet")
        XCTAssertEqual(ContextCompaction.held(try thread(status: "idle"), messages: [], earlierAvailable: false), "Nothing to compact yet")
        XCTAssertNil(ContextCompaction.held(try thread(status: "idle"), messages: [compactOnly], earlierAvailable: true), "Earlier messages are history")
        XCTAssertNil(ContextCompaction.held(try thread(status: "idle"), messages: nil, earlierAvailable: false), "Unread history is the computer's to judge")
        XCTAssertTrue(ContextCompaction.isCompact("/compact"))
        XCTAssertTrue(ContextCompaction.isCompact("/compact keep the plan"))
        XCTAssertFalse(ContextCompaction.isCompact("/compaction notes"))
    }
}
