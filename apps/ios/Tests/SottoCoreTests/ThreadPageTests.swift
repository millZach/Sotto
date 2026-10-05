import XCTest
@testable import SottoCore

/// The thread page's own reading of the wire: messages and steps in time order, and the worktree's Git chips.
final class ThreadPageTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private func message(_ id: String, _ role: String, at time: String? = nil) throws -> Message {
        let stamp = time.map { #","createdAt":"2026-10-04T10:\#($0)Z""# } ?? ""
        return try decode(Message.self, #"{"id":"\#(id)","role":"\#(role)","text":"Text"\#(stamp)}"#)
    }
    private func step(_ id: String, _ sequence: Int, at time: String? = nil, kind: String = "command", after: String? = nil) throws -> Activity {
        let stamp = time.map { #","startedAt":"2026-10-04T10:\#($0)Z""# } ?? ""
        let follows = after.map { #","afterMessageId":"\#($0)""# } ?? ""
        return try decode(Activity.self, #"{"id":"\#(id)","sequence":\#(sequence),"kind":"\#(kind)","status":"completed","title":"Ran"\#(stamp)\#(follows)}"#)
    }
    private func order(_ messages: [Message], _ steps: [Activity], earlier: Bool = false) -> [String] {
        ThreadTimeline.merge(messages: messages, activities: steps, earlierAvailable: earlier).map(\.id)
    }

    // MARK: Time order

    func testStepsSitBetweenTheMessagesTheyHappenedBetween() throws {
        let messages = [try message("ask", "user", at: "00:00"), try message("reply", "assistant", at: "03:00"),
                        try message("again", "user", at: "05:00")]
        let steps = [try step("read", 1, at: "01:00"), try step("edit", 2, at: "02:00"), try step("test", 3, at: "06:00"),
                     try step("turn", 4, at: "00:30", kind: "turn")]
        XCTAssertEqual(order(messages, steps),
                       ["message-ask", "step-read", "step-edit", "message-reply", "message-again", "step-test"])
    }

    func testEqualTimesReadMessageFirstAndStepsBySequence() throws {
        let messages = [try message("ask", "user", at: "01:00"), try message("reply", "assistant", at: "02:00")]
        let steps = [try step("second", 2, at: "01:00"), try step("first", 1, at: "01:00"), try step("last", 3, at: "02:00")]
        XCTAssertEqual(order(messages, steps),
                       ["message-ask", "step-first", "step-second", "message-reply", "step-last"])
    }

    func testAStepWithoutATimeFollowsTheStepBeforeIt() throws {
        let messages = [try message("ask", "user", at: "00:00"), try message("reply", "assistant", at: "01:30")]
        let steps = [try step("early", 1), try step("timed", 2, at: "01:00"), try step("untimed", 3), try step("late", 4, at: "02:00")]
        XCTAssertEqual(order(messages, steps),
                       ["message-ask", "step-early", "step-timed", "step-untimed", "message-reply", "step-late"])
    }

    func testStepsKeepTheirOwnOrderWhenTheirTimesDisagree() throws {
        let messages = [try message("ask", "user", at: "00:00"), try message("reply", "assistant", at: "02:00")]
        let steps = [try step("one", 1, at: "03:00"), try step("two", 2, at: "01:00")]
        XCTAssertEqual(order(messages, steps), ["message-ask", "message-reply", "step-one", "step-two"])
    }

    func testWithoutTimesStepsFollowTheLastMessageFromTheUser() throws {
        let messages = [try message("ask", "user"), try message("reply", "assistant"), try message("again", "user"),
                        try message("answer", "assistant")]
        let steps = [try step("read", 1, at: "01:00"), try step("test", 2)]
        XCTAssertEqual(order(messages, steps),
                       ["message-ask", "message-reply", "message-again", "step-read", "step-test", "message-answer"])

        let timedMessages = [try message("ask", "user", at: "00:00"), try message("reply", "assistant", at: "01:00")]
        XCTAssertEqual(order(timedMessages, [try step("read", 1), try step("test", 2)]),
                       ["message-ask", "step-read", "step-test", "message-reply"])
        XCTAssertEqual(order([try message("note", "assistant")], [try step("read", 1)]), ["message-note", "step-read"])
    }

    func testAMessageWithoutATimeKeepsItsPlace() throws {
        let messages = [try message("ask", "user", at: "00:00"), try message("streaming", "assistant"),
                        try message("again", "user", at: "04:00")]
        let steps = [try step("read", 1, at: "02:00")]
        XCTAssertEqual(order(messages, steps), ["message-ask", "message-streaming", "step-read", "message-again"])
    }

    func testTheHostsOwnPlacementWinsAndUnloadedHistoryWaits() throws {
        let messages = [try message("ask", "user", at: "05:00"), try message("reply", "assistant", at: "07:00")]
        let steps = [try step("old", 1, at: "01:00"), try step("hidden", 2, after: "gone"), try step("placed", 3, at: "05:30", after: "ask"),
                     try step("now", 4, at: "06:00")]
        XCTAssertEqual(order(messages, steps, earlier: true), ["message-ask", "step-placed", "step-now", "message-reply"])
        // With the whole history here, a message the host names but this page doesn't hold places nothing.
        XCTAssertEqual(order(messages, steps, earlier: false),
                       ["step-old", "step-hidden", "message-ask", "step-placed", "step-now", "message-reply"])
    }

    func testNoStepsAndNoMessages() throws {
        XCTAssertEqual(order([], []), [])
        XCTAssertEqual(order([try message("ask", "user")], []), ["message-ask"])
        XCTAssertEqual(order([], [try step("read", 1)]), ["step-read"])
    }

    func testConsecutiveStepsGroupIntoOneRun() throws {
        let messages = [try message("ask", "user", at: "00:00"), try message("reply", "assistant", at: "03:00")]
        let steps = [try step("read", 1, at: "01:00"), try step("edit", 2, at: "02:00"), try step("test", 3, at: "04:00")]
        let items = ThreadTimeline.items(messages: messages, activities: steps)
        XCTAssertEqual(items.map(\.id), ["message-ask", "steps-read", "message-reply", "steps-test"])
        guard case .steps(let run) = items[1] else { return XCTFail("Expected a run of steps") }
        XCTAssertEqual(run.map(\.id), ["read", "edit"])
    }

    func testMessagesCarryTheirTimeThroughAStreamedAppend() throws {
        let detail = try decode(ThreadDetail.self, #"{"threadId":"t","revision":1,"messages":[{"id":"m","role":"assistant","text":"Hel","createdAt":"2026-10-04T10:00:00.000Z"}]}"#)
        XCTAssertEqual(detail.messages.first?.createdAt, "2026-10-04T10:00:00.000Z")
        let delta = try decode(ThreadDetailDelta.self, #"{"threadId":"t","baseRevision":1,"revision":2,"messageDeltas":[{"id":"m","appendText":"lo"}],"activityDeltas":[]}"#)
        let next = try XCTUnwrap(detail.applying(delta))
        XCTAssertEqual(next.messages.first?.text, "Hello")
        XCTAssertEqual(next.messages.first?.createdAt, "2026-10-04T10:00:00.000Z")
        XCTAssertNil(try decode(Message.self, #"{"id":"m","role":"user","text":"Hi"}"#).createdAt)
    }

    // MARK: Worktree and Git chips

    private let bare = #"{"id":"t","projectId":"p","title":"Thread","status":"idle","requests":[]"#

    func testAThreadWithAWorktreeReadsItsChips() throws {
        let json = bare + #","worktree":{"mode":"independent","status":"ready","path":"/w","branch":"sotto/abc","git":{"isRepository":true,"branch":"feat/frosted-window","upstream":"origin/feat/frosted-window","hasRemote":true,"defaultBranch":"main","isDefaultBranch":false,"dirty":true,"changedFiles":7,"insertions":212,"deletions":48,"ahead":4,"behind":0,"aheadOfDefault":4,"pullRequest":{"number":721,"title":"Frost the window","url":"https://github.com/o/r/pull/721","state":"open","draft":true},"fetchedAt":null,"readAt":"2026-10-04T10:00:00.000Z"}}}"#
        let thread = try decode(ThreadSummary.self, json)
        XCTAssertEqual(thread.worktree?.mode, "independent")
        XCTAssertEqual(thread.worktree?.git?.ahead, 4)
        XCTAssertEqual(thread.worktree?.git?.dirty, true)
        XCTAssertEqual(thread.worktree?.git?.pullRequest?.title, "Frost the window")
        let chips = GitChips(thread.worktree)
        XCTAssertEqual(chips.branch, "feat/frosted-window")
        XCTAssertEqual(chips.changes, GitChips.Changes(files: 7, insertions: 212, deletions: 48))
        XCTAssertEqual(chips.pullRequest, GitChips.PullRequest(number: 721, state: "draft"))
        XCTAssertEqual(chips.spoken, "Branch feat/frosted-window. 7 files changed, 212 lines added, 48 removed. Pull request 721, draft")
    }

    func testAThreadWithoutAWorktreeHasNoChips() throws {
        let thread = try decode(ThreadSummary.self, bare + "}")
        XCTAssertNil(thread.worktree)
        XCTAssertTrue(GitChips(thread.worktree).isEmpty)
        XCTAssertTrue(GitChips(try decode(ThreadSummary.self, bare + #","worktree":null}"#).worktree).isEmpty)
    }

    func testAMalformedWorktreeNeverFailsTheThread() throws {
        for worktree in [#""ready""#, "42", "[]", #"{"branch":7,"git":"clean"}"#,
                         #"{"branch":"main","git":{"changedFiles":"many","insertions":-1,"pullRequest":{"number":"x"}}}"#] {
            let thread = try decode(ThreadSummary.self, bare + #","worktree":"# + worktree + "}")
            XCTAssertEqual(thread.title, "Thread")
            let chips = GitChips(thread.worktree)
            XCTAssertNil(chips.changes)
            XCTAssertNil(chips.pullRequest)
        }
        let partial = try decode(ThreadSummary.self, bare + #","worktree":{"branch":"main","git":{"changedFiles":"many","insertions":-1,"pullRequest":{"number":"x"}}}}"#)
        XCTAssertEqual(GitChips(partial.worktree).branch, "main")
    }

    func testChipsLeaveOutWhatTheyHaveNothingToSayAbout() throws {
        let clean = try decode(ThreadSummary.self, bare + #","worktree":{"mode":"shared","status":"ready","git":{"branch":"main","changedFiles":0,"insertions":0,"deletions":0,"pullRequest":{"number":12,"title":"Old","url":"u","state":"merged","draft":false}}}}"#)
        let chips = GitChips(clean.worktree)
        XCTAssertEqual(chips.branch, "main")
        XCTAssertNil(chips.changes)
        XCTAssertEqual(chips.pullRequest, GitChips.PullRequest(number: 12, state: "merged"))
        let pending = try decode(ThreadSummary.self, bare + #","worktree":{"mode":"independent","status":"pending","branch":"sotto/k2"}}"#)
        XCTAssertEqual(GitChips(pending.worktree).branch, "sotto/k2")
        XCTAssertEqual(GitChips(pending.worktree).spoken, "Branch sotto/k2")
    }
}
