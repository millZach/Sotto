import XCTest
@testable import SottoCore

/// The pull request sheet's reading of a host's `git-pull-request` answer (ADR-0102): decoding, the roll-up and the
/// three lines in the desktop's words, the order of checks and files, durations, and the babysitting line.
final class PullRequestTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }
    private let url = "https://github.com/millZach/Sotto/pull/1287"
    /// A detail with these checks and reviews, and `extra`'s `,"key":value` pairs in place of a current host's fields of
    /// those names, so the JSON never holds a key twice.
    private func detail(checks: String = "[]", reviews: String = "[]", extra: String = "") throws -> PullRequestDetail {
        let fields: [(String, String)] = [("number", "1287"), ("url", #""\#(url)""#), ("title", #""Show a thread's pull request""#),
            ("body", ###""## What\nIt reads.""###), ("state", #""open""#), ("draft", "false"), ("baseBranch", #""main""#),
            ("headBranch", #""feat/pr-view""#), ("crossRepository", "false"), ("reviewDecision", "null"), ("reviews", reviews),
            ("mergeable", #""mergeable""#), ("checks", checks), ("checksUnknown", "false"), ("mergeMethods", #"["squash"]"#),
            ("autoMergeAllowed", "true"), ("autoMerge", "null"), ("mergedAt", "null"), ("behindBy", "0"), ("canUpdateBranch", "true"),
            ("linked", "null"), ("branch", "true")]
        let kept = fields.filter { !extra.contains(#""\#($0.0)":"#) }.map { #""\#($0.0)":\#($0.1)"# }
        return try decode(PullRequestDetail.self, "{" + kept.joined(separator: ",") + extra + "}")
    }
    private func check(_ name: String, _ status: String, started: String? = nil, completed: String? = nil) -> String {
        let times = [started.map { #""startedAt":"\#($0)""# }, completed.map { #""completedAt":"\#($0)""# }].compactMap { $0 }
        return #"{"name":"\#(name)","status":"\#(status)","url":null,"description":null\#(times.isEmpty ? "" : "," + times.joined(separator: ","))}"#
    }

    // MARK: Decoding

    func testReadsTheDetailWithEachChecksTimesAndTheChangedFiles() throws {
        let read = try detail(checks: "[" + check("Gates (Windows)", "failure", started: "2026-10-21T10:00:00Z", completed: "2026-10-21T10:14:02Z") + "]",
                              extra: #","files":[{"path":"apps/ios/Sotto/PullRequestViews.swift","additions":286,"deletions":0},{"path":"README.md","additions":1,"deletions":2}],"changedFiles":2"#)
        XCTAssertEqual(read.number, 1287)
        XCTAssertEqual(read.checks.first?.startedAt, "2026-10-21T10:00:00Z")
        XCTAssertEqual(read.files?.map(\.path), ["apps/ios/Sotto/PullRequestViews.swift", "README.md"])
        XCTAssertEqual(read.files?.first?.name, "PullRequestViews.swift")
        XCTAssertEqual(read.files?.first?.folder, "apps/ios/Sotto")
        XCTAssertNil(read.files?.last?.folder, "A file at the top of the repository has no folder")
        XCTAssertEqual(read.changedFiles, 2)
    }

    func testAnOlderHostsAnswerReadsAsNotKnownRatherThanNone() throws {
        let read = try detail(checks: "[" + check("Lint", "success") + "]")
        XCTAssertNil(read.files, "A host before #1281 sends no files: not known, not none")
        XCTAssertNil(read.changedFiles)
        XCTAssertNil(read.checks.first?.startedAt)
        XCTAssertNil(PullRequests.duration(read.checks[0]))
        XCTAssertNil(PullRequests.fileCount(read))
    }

    func testAnItemThisBuildCantReadIsLeftOutAndTheRestStands() throws {
        let read = try detail(checks: #"[{"name":"Lint","status":"success"},{"status":"failure"},7]"#,
                              reviews: #"[{"author":"chloe-r","state":"approved","url":null},{"state":"approved"}]"#,
                              extra: #","files":[{"path":"a.ts","additions":"many","deletions":-3},null],"changedFiles":"two""#)
        XCTAssertEqual(read.checks.map(\.name), ["Lint"])
        XCTAssertEqual(read.reviews.map(\.author), ["chloe-r"])
        XCTAssertEqual(read.files?.count, 1)
        XCTAssertEqual(read.files?.first?.additions, 0, "A count that isn't a number reads as none")
        XCTAssertEqual(read.files?.first?.deletions, 0, "A count is never negative")
        XCTAssertNil(read.changedFiles)
    }

    func testAReadIsTheDetailARateLimitRefusalOrNothing() throws {
        XCTAssertEqual(try decode(PullRequestRead.self, "null"), .noPullRequest)
        XCTAssertEqual(try decode(PullRequestRead.self, #"{"limited":{"retryAt":"2026-10-21T11:00:00Z"}}"#), .limited(retryAt: "2026-10-21T11:00:00Z"))
        guard case .detail(let read) = try decode(PullRequestRead.self, #"{"number":4,"url":"\#(url)","title":"T"}"#) else { return XCTFail("A detail reads as one") }
        XCTAssertEqual(read.state, "open")
        XCTAssertEqual(read.mergeable, "unknown", "A missing mergeability is unknown")
        XCTAssertTrue(read.checks.isEmpty)
    }

    // MARK: Checks

    func testTheRollUpSaysTheWorstFirst() throws {
        let checks = try detail(checks: "[" + [check("a", "success"), check("b", "failure"), check("c", "pending"), check("d", "success"),
                                               check("e", "skipped"), check("f", "cancelled")].joined(separator: ",") + "]").checks
        XCTAssertEqual(PullRequests.rollup(checks), "2 failing, 1 running, 2 passed, 1 skipped")
        XCTAssertEqual(PullRequests.rollup([]), "No checks")
        XCTAssertEqual(PullRequests.ordered(checks).map(\.name), ["b", "f", "c", "e", "a", "d"], "Failing, running, skipped, then passed, each in GitHub's order")
    }

    func testTheChipsDotIsTheWorstCheckAndNothingWithoutChecks() throws {
        XCTAssertEqual(PullRequests.dot(try detail(checks: "[" + check("a", "success") + "," + check("b", "pending") + "]")), .running)
        XCTAssertEqual(PullRequests.dot(try detail(checks: "[" + check("a", "pending") + "," + check("b", "failure") + "]")), .failing)
        XCTAssertEqual(PullRequests.dot(try detail(checks: "[" + check("a", "success") + "]")), .passed)
        XCTAssertNil(PullRequests.dot(try detail()))
        XCTAssertNil(PullRequests.dot(try detail(checks: "[" + check("a", "skipped") + "]")))
    }

    func testACheckSaysHowLongItTookOrHasTakenSoFar() throws {
        let checks = try detail(checks: "[" + [check("done", "success", started: "2026-10-21T10:00:00Z", completed: "2026-10-21T10:14:02Z"),
                                               check("going", "pending", started: "2026-10-21T10:00:00.000Z"),
                                               check("queued", "pending"),
                                               check("stale", "failure", started: "2026-10-21T10:00:00Z")].joined(separator: ",") + "]").checks
        let now = try XCTUnwrap(Stamp.date("2026-10-21T10:06:10Z"))
        XCTAssertEqual(PullRequests.duration(checks[0], now: now), "14m 02s")
        XCTAssertEqual(PullRequests.spokenDuration(checks[0], now: now), "14 minutes 2 seconds")
        XCTAssertEqual(PullRequests.duration(checks[1], now: now), "6m 10s so far")
        XCTAssertNil(PullRequests.duration(checks[2], now: now), "A check that hasn't started has no length")
        XCTAssertNil(PullRequests.duration(checks[3], now: now), "A finished check without an end says nothing rather than a guess")
    }

    func testTheChecksLineSaysWhatHoldsItBack() throws {
        XCTAssertEqual(PullRequests.checksLine(try detail()), PullRequests.Line(.quiet, "No checks", "GitHub reports none for this pull request"))
        XCTAssertEqual(PullRequests.checksLine(try detail(extra: #","checksUnknown":true"#)).title, "Checks unknown")
        let failing = try detail(checks: "[" + check("a", "failure") + "," + check("b", "pending") + "," + check("c", "success") + "]")
        XCTAssertEqual(PullRequests.checksLine(failing), PullRequests.Line(.failing, "A check failed", "1 failing, 1 running, 1 passed"))
        let two = try detail(checks: "[" + check("a", "failure") + "," + check("b", "cancelled") + "]")
        XCTAssertEqual(PullRequests.checksLine(two).title, "2 checks failed")
        let waiting = try detail(checks: "[" + check("Deploy", "action-required") + "]")
        XCTAssertEqual(PullRequests.checksLine(waiting), PullRequests.Line(.running, "A check is waiting", "Deploy is waiting for approval on GitHub"))
        XCTAssertEqual(PullRequests.checksLine(try detail(checks: "[" + check("a", "pending") + "]")).title, "Checks running")
        XCTAssertEqual(PullRequests.checksLine(try detail(checks: "[" + check("a", "success") + "]")), PullRequests.Line(.passed, "Checks passed", "1 passed"))
    }

    // MARK: Review and merge

    func testTheReviewLineNamesWhoDecided() throws {
        let both = #"[{"author":"ollie","state":"approved","url":null},{"author":"chloe","state":"changes_requested","url":null}]"#
        XCTAssertEqual(PullRequests.reviewLine(try detail(reviews: both, extra: #","reviewDecision":"changes_requested""#)),
                       PullRequests.Line(.failing, "Changes requested", "chloe asked for changes"))
        XCTAssertEqual(PullRequests.reviewLine(try detail(reviews: both, extra: #","reviewDecision":"approved""#)).detail, "Approved by ollie")
        XCTAssertEqual(PullRequests.reviewLine(try detail(extra: #","reviewDecision":"review_required""#)).detail, "Nobody has reviewed it yet")
        XCTAssertEqual(PullRequests.reviewLine(try detail(extra: #","reviewDecision":"review_required","draft":true"#)).detail, "Reviewers wait until it is ready")
        XCTAssertEqual(PullRequests.reviewLine(try detail()), PullRequests.Line(.passed, "No review required", "This repository merges without one"))
    }

    func testTheMergeLineSaysConflictsHowFarBehindOrClean() throws {
        XCTAssertEqual(PullRequests.mergeLine(try detail()), PullRequests.Line(.passed, "No conflicts", "Up to date with main and merges cleanly"))
        XCTAssertEqual(PullRequests.mergeLine(try detail(extra: #","behindBy":3"#)),
                       PullRequests.Line(.running, "3 commits behind main", "No conflicts. Merges cleanly into main"))
        XCTAssertEqual(PullRequests.mergeLine(try detail(extra: #","mergeable":"conflicting","behindBy":1"#)),
                       PullRequests.Line(.failing, "Conflicts with main", "Resolve them in the branch and push. It is 1 commit behind main"))
        XCTAssertEqual(PullRequests.mergeLine(try detail(extra: #","mergeable":"unknown""#)).title, "Checking for conflicts")
        XCTAssertEqual(PullRequests.mergeLine(try detail(extra: #","state":"merged""#)), PullRequests.Line(.passed, "Merged", "Merged into main"))
        XCTAssertEqual(PullRequests.mergeLine(try detail(extra: #","state":"closed""#)).title, "Closed")
    }

    // MARK: Files

    func testFilesReadTheMostChangedFirstAndSayWhenGitHubListedOnlySome() throws {
        let read = try detail(extra: #","files":[{"path":"b.ts","additions":1,"deletions":0},{"path":"a.ts","additions":1,"deletions":0},{"path":"big.ts","additions":30,"deletions":4}],"changedFiles":312"#)
        XCTAssertEqual(PullRequests.ordered(read.files ?? []).map(\.path), ["big.ts", "a.ts", "b.ts"])
        XCTAssertEqual(PullRequests.fileCount(read), "3 of 312 files")
        XCTAssertEqual(PullRequests.fileCount(try detail(extra: #","files":[{"path":"a.ts","additions":1,"deletions":0}],"changedFiles":1"#)), "1 file")
    }

    // MARK: Addresses and commands

    func testAPullRequestIsKeyedAsTheHostKeysItAndOnlyGitHubCounts() throws {
        XCTAssertEqual(PullRequests.key(" https://GitHub.com/MillZach/Sotto/pull/1287/files "), "millzach/sotto#1287")
        XCTAssertEqual(PullRequests.key(url), PullRequests.key("https://github.com/millzach/sotto/pull/1287"))
        XCTAssertNil(PullRequests.key("https://example.com/millZach/Sotto/pull/1287"))
        XCTAssertNil(PullRequests.key("http://github.com/millZach/Sotto/pull/1287"))
        XCTAssertNil(PullRequests.key("https://github.com/millZach/Sotto/issues/1287"))
        XCTAssertThrowsError(try PullRequests.request(threadID: "t", url: "https://example.com/x"))
        XCTAssertEqual(try PullRequests.request(threadID: "t", url: url)["request"], .object(["threadId": .string("t"), "reference": .string(url)]))
    }

    func testBabysittingGoesAsTheHostsOwnCommands() throws {
        XCTAssertEqual(try Commands.babysit(threadID: "t", url: url, on: true),
                       .object(["type": .string("babysit-pull-request"), "threadId": .string("t"), "url": .string(url)]))
        XCTAssertEqual(try Commands.babysit(threadID: "t", url: url, on: false)["type"], .string("stop-babysitting"))
        XCTAssertThrowsError(try Commands.babysit(threadID: "t", url: "https://example.com/pull/1", on: true))
        XCTAssertFalse(RemoteCommands.needAnswerPolicy.contains("babysit-pull-request"), "Babysitting grants nothing")
    }

    // MARK: Babysitting

    private let bare = #"{"id":"t","projectId":"p","title":"Thread","status":"idle","requests":[]"#

    func testAThreadReadsWhatItBabysitsAndAnUnreadableRecordNeverFailsIt() throws {
        let thread = try decode(ThreadSummary.self, bare + #","babysitting":[{"url":"\#(url)","number":1287,"startedBy":"user","startedAt":"2026-10-21T10:54:00Z"},{"url":7}],"babysitEnded":"soon"}"#)
        XCTAssertEqual(thread.babysitting?.items.map(\.number), [1287])
        XCTAssertEqual(thread.babysitEnded?.items, [])
        XCTAssertNil(try decode(ThreadSummary.self, bare + "}").babysitting, "An older host sends none")
    }

    func testTheBabysitLineSaysWhoStartedItOrWhyItEnded() throws {
        let clock: (Date) -> String = { _ in "10:54" }
        let started = try XCTUnwrap(Stamp.date("2026-10-21T10:54:00Z"))
        let open = try detail()
        let mine = [try decode(ThreadBabysitting.self, #"{"url":"https://github.com/millzach/sotto/pull/1287","number":1287,"startedBy":"user","startedAt":"2026-10-21T10:54:00Z"}"#)]
        XCTAssertEqual(PullRequests.babysitState(babysitting: mine, ended: [], detail: open, agent: "Codex", now: started.addingTimeInterval(30), clock: clock),
                       .babysitting(title: "Babysitting since 10:54", detail: "Started by you. Sotto sends this thread a wake-up when #1287 needs it."))
        let agents = [try decode(ThreadBabysitting.self, #"{"url":"\#(url)","number":1287,"startedBy":"agent","startedAt":"2026-10-21T10:54:00Z"}"#)]
        guard case .babysitting(_, let words) = PullRequests.babysitState(babysitting: agents, ended: [], detail: open, agent: "Codex", now: started, clock: clock) else {
            return XCTFail("Babysitting the agent started reads as babysitting")
        }
        XCTAssertTrue(words.hasPrefix("Started by Codex."))
        let other = [try decode(ThreadBabysitting.self, #"{"url":"https://github.com/millZach/Sotto/pull/9","number":9,"startedBy":"user","startedAt":"2026-10-21T10:54:00Z"}"#)]
        XCTAssertEqual(PullRequests.babysitState(babysitting: other, ended: [], detail: open, agent: "Codex", now: started, clock: clock),
                       .offered(detail: "Sotto wakes this thread when a check fails, the checks pass, someone reviews, it conflicts or it merges."))
        let ended = [try decode(ThreadBabysitEnded.self, #"{"url":"\#(url)","number":1287,"reason":"comment-limit","endedAt":"2026-10-21T10:54:00Z"}"#)]
        guard case .offered(let again) = PullRequests.babysitState(babysitting: [], ended: ended, detail: open, agent: "Codex", now: started.addingTimeInterval(30), clock: clock) else {
            return XCTFail("An ended babysitting offers it again")
        }
        XCTAssertTrue(again.hasPrefix("Ended at 10:54, after ten wake-ups in a row brought only comments."))
        let merged = try detail(extra: #","state":"merged""#)
        XCTAssertEqual(PullRequests.babysitState(babysitting: [], ended: [], detail: merged, agent: "Codex", now: started, clock: clock),
                       .finished(title: "Nothing to babysit", detail: "It merged into main."))
    }

    // MARK: A read the host could not make

    func testARefusedReadSaysWhatToDoByTheReasonTheHostGave() throws {
        let refusal = try decode(WireFailure.self, #"{"code":"unavailable","message":"The host could not complete this request. Refresh the thread before trying again.","reason":"gh-signed-out"}"#)
        XCTAssertEqual(refusal.reason, "gh-signed-out")
        XCTAssertNil(try decode(WireFailure.self, #"{"code":"unavailable","message":"An older host gives no reason."}"#).reason)
        let words = { (reason: String?) in PullRequests.readFailureWords(reason: reason, computer: "Studio") }
        XCTAssertEqual(words("gh-missing"), "GitHub’s command line tool, gh, isn’t installed on Studio, so Sotto couldn’t read the pull request. Nothing was lost. Install gh there and sign in with gh auth login, then try again.")
        XCTAssertEqual(words("gh-signed-out"), "gh isn’t signed in to GitHub on Studio, so Sotto couldn’t read the pull request. Nothing was lost. Sign in to GitHub on Studio with gh auth login, then try again.")
        XCTAssertEqual(words("offline"), "GitHub can’t be reached from Studio right now, so Sotto couldn’t read the pull request. Nothing was lost. Try again when it’s back online.")
        XCTAssertEqual(words("unreadable"), "GitHub didn’t give Studio this pull request. Nothing was lost. Try again in a moment, or open it on GitHub to check it still exists.")
        // An older host, or a reason a later one adds, gets the words that name every cause.
        let general = "Sotto couldn’t read the pull request from GitHub on Studio. Nothing was lost. Check that gh is installed and signed in there and can reach GitHub, then try again."
        XCTAssertEqual(words(nil), general)
        XCTAssertEqual(words("rate-limited-forever"), general)
        for reason in ["gh-missing", "gh-signed-out", "offline", "unreadable", nil] {
            XCTAssertTrue(words(reason).contains("Nothing was lost."), "Every reason says nothing was lost")
        }
    }

    // MARK: The chip

    func testTheChipKnowsWhichPullRequestItOpensAndCanLeaveItOutOfTheRowsWords() throws {
        let thread = try decode(ThreadSummary.self, bare + #","worktree":{"branch":"feat/x","git":{"branch":"feat/x","changedFiles":1,"insertions":2,"deletions":0,"pullRequest":{"number":1287,"title":"T","url":"\#(url)","state":"open","draft":false}}}}"#)
        let chips = GitChips(thread.worktree)
        XCTAssertEqual(chips.pullRequestURL, url)
        XCTAssertEqual(chips.spoken(includingPullRequest: false), "Branch feat/x. 1 file changed, 2 lines added, 0 removed")
        XCTAssertTrue(chips.spoken.hasSuffix("Pull request 1287, open"))
        let elsewhere = try decode(ThreadSummary.self, bare + #","worktree":{"git":{"pullRequest":{"number":3,"url":"https://example.com/pull/3","state":"open"}}}}"#)
        XCTAssertNil(GitChips(elsewhere.worktree).pullRequestURL, "Only a GitHub pull request opens the sheet")
        XCTAssertNotNil(GitChips(elsewhere.worktree).pullRequest)
    }
}
