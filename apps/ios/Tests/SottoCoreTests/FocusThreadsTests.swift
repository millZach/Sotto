import XCTest
@testable import SottoCore

final class FocusThreadsTests: XCTestCase {
    private func thread(_ id: String, _ extra: String = "", requests: String = "[]") throws -> ThreadSummary {
        try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"\#(id)","projectId":"p","title":"\#(id)","status":"idle","requests":\#(requests)\#(extra)}"#.utf8))
    }
    func testSettledRequestsStayInNeedsYouAndSettledWorkIsQuiet() throws {
        let question = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"q","projectId":"p","title":"Ship","status":"idle","settledAt":"yesterday","requests":[{"id":"r","kind":"question","text":"Which target?","options":[]}]}"#.utf8))
        let work = try thread("background", #", "settledAt":"yesterday", "backgroundWork":[{"type":"subagent"}]"#)
        let running = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"running","projectId":"p","title":"running","status":"running","workspaceSettledAt":"2026-10-21","requests":[]}"#.utf8))
        let done = try thread("finished", #", "settledAt":"yesterday""#)
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [question, work, running, done])])
        // Only the user can answer a request, so it is asked wherever the thread is filed.
        XCTAssertEqual(rows.questions.map(\.id), ["h/q"])
        XCTAssertEqual(rows.requestCount, 1)
        // Settled is quiet: work a settled thread still does sits on the Settled shelf, not in Working now.
        XCTAssertTrue(rows.working.isEmpty)
        XCTAssertEqual(Set(rows.settled.map(\.id)), ["h/background", "h/running", "h/finished"])
    }
    func testSettledThreadsSayNeitherJustFinishedNorTurnFailed() throws {
        let finished = try thread("finished", #", "finishedUnread":true, "workspaceSettledAt":"2026-10-21""#)
        let failed = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"failed","projectId":"p","title":"failed","status":"error","settledAt":"2026-10-21","requests":[]}"#.utf8))
        let inProject = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"project","projectId":"done","title":"project","status":"error","requests":[]}"#.utf8))
        let open = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"open","projectId":"p","title":"open","status":"error","requests":[]}"#.utf8))
        let project = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"done","title":"Done","workspaceSettledAt":"2026-10-21"}"#.utf8))
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [finished, failed, inProject, open], projects: [project])])
        XCTAssertEqual(Set(rows.settled.map(\.id)), ["h/finished", "h/failed", "h/project"])
        XCTAssertEqual(rows.settled.filter { rows.isUnreadFinish($0) || $0.failed }.map(\.id), [])
        XCTAssertEqual(rows.recent.map(\.id), ["h/open"])
        XCTAssertTrue(rows.recent[0].failed)
        XCTAssertEqual(rows.unreadFinishedCount, 0)
    }
    func testAThreadNeverSentToIsListedOnlyWhileOpenOrHeld() throws {
        let unsent = #", "titleSource":"default", "summary":{"messageCount":0}"#
        let empty = try thread("empty", unsent)
        let sent = try thread("sent", #", "titleSource":"default", "summary":{"messageCount":2}"#)
        let renamed = try thread("renamed", #", "titleSource":"user", "summary":{"messageCount":0}"#)
        let older = try thread("older", #", "titleSource":"default""#)
        let settled = try thread("settled", unsent + #", "settledAt":"2026-10-21""#)
        let computer = ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [empty, sent, renamed, older, settled])
        XCTAssertTrue(ThreadGroups.isUnsent(empty))
        XCTAssertFalse(ThreadGroups.isUnsent(older), "A computer that doesn't count messages never hides a thread")
        XCTAssertEqual(Set(FocusThreads([computer]).recent.map(\.id)), ["h/sent", "h/renamed", "h/older"])
        XCTAssertEqual(FocusThreads([computer]).settled.map(\.id), ["h/settled"])
        let open = ThreadRef(hostID: "h", threadID: "empty")
        XCTAssertTrue(FocusThreads([computer], opened: open).recent.contains { $0.id == "h/empty" })
        XCTAssertTrue(FocusThreads([computer], holding: ["h/empty"]).recent.contains { $0.id == "h/empty" })
    }
    func testOfflineSnapshotsDoNotClaimLiveWork() throws {
        let work = try thread("work", #", "backgroundWork":[{"type":"command"}]"#)
        for status in [ComputerStatus.connecting, .unreachable] {
            let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: status, threads: [work])])
            XCTAssertTrue(rows.working.isEmpty)
            XCTAssertEqual(rows.recent.map(\.id), ["h/work"])
        }
    }
    func testSearchIncludesSettledAndRespectsComputerIdentity() throws {
        let done = try thread("Café", #", "settledAt":"yesterday""#)
        let hosts = ["one", "two"].map { ComputerThreads(hostID: $0, name: $0, status: .online, threads: [done]) }
        let rows = FocusThreads(hosts, show: .only("two"), query: "  CAFE  ")
        XCTAssertTrue(rows.searching)
        XCTAssertEqual(rows.settled.map(\.id), ["two/Café"])
        XCTAssertFalse(rows.isEmpty)
        XCTAssertTrue(FocusThreads(hosts, query: "missing").isEmpty)
        XCTAssertFalse(FocusThreads(hosts, query: " \n ").searching)
    }
    func testUnreadFinishedThreadsKeepTheirPlaceAndCountOnlyInRecent() throws {
        let unread = try thread("unread", #", "finishedUnread":true"#)
        let read = try thread("read")
        let settled = try thread("settled", #", "finishedUnread":true, "settledAt":"yesterday""#)
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [read, unread, settled])])
        // The mark changes how a row looks, never which group it is in or where.
        XCTAssertEqual(rows.recent.map(\.id), ["h/read", "h/unread"])
        XCTAssertEqual(rows.settled.map(\.id), ["h/settled"])
        XCTAssertEqual(rows.recent.map(rows.isUnreadFinish), [false, true])
        // Settled is quiet: a settled thread is never marked, whatever its computer says.
        XCTAssertFalse(rows.isUnreadFinish(rows.settled[0]))
        XCTAssertEqual(rows.unreadFinishedCount, 1)
    }
    func testOpeningAThreadReadsItBeforeItsComputerSaysSo() throws {
        let unread = try thread("unread", #", "finishedUnread":true"#)
        let other = try thread("other", #", "finishedUnread":true"#)
        let computers = [ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [unread, other])]
        XCTAssertEqual(FocusThreads(computers).unreadFinishedCount, 2)
        let opened = FocusThreads(computers, opened: ThreadRef(hostID: "h", threadID: "unread"))
        XCTAssertEqual(opened.recent.map(opened.isUnreadFinish), [false, true])
        XCTAssertEqual(opened.unreadFinishedCount, 1)
        // The same thread ID on another computer is another thread.
        XCTAssertEqual(FocusThreads(computers, opened: ThreadRef(hostID: "other", threadID: "unread")).unreadFinishedCount, 2)
    }
    func testUnreadFinishedNeedsAReachableComputerAndAFinishedThread() throws {
        let unread = try thread("unread", #", "finishedUnread":true"#)
        for status in [ComputerStatus.connecting, .unreachable] {
            let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: status, threads: [unread])])
            XCTAssertEqual(rows.recent.map(\.id), ["h/unread"])
            XCTAssertEqual(rows.unreadFinishedCount, 0)
        }
        // A mark that rides on a thread that failed, works or asks is not shown; the thread says what it is doing instead.
        let failed = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"failed","projectId":"p","title":"Failed","status":"error","finishedUnread":true,"requests":[]}"#.utf8))
        let working = try thread("working", #", "finishedUnread":true, "backgroundWork":[{"type":"subagent"}]"#)
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [failed, working])])
        XCTAssertEqual(rows.recent.map(rows.isUnreadFinish), [false])
        XCTAssertEqual(rows.working.map(\.id), ["h/working"])
        XCTAssertEqual(rows.unreadFinishedCount, 0)
        // An older computer never sends the field, and nothing is marked.
        XCTAssertNil(try thread("old").finishedUnread)
    }
    func testWaitingAndCompactionCountAlongsideForegroundWork() throws {
        let waiting = try thread("command", #", "backgroundWork":[{"type":"command"}]"#)
        let compacting = try thread("context", #", "compaction":{"status":"running"}"#)
        let failed = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"failed","projectId":"p","title":"Failed","status":"error","requests":[]}"#.utf8))
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [waiting, compacting, failed])])
        XCTAssertEqual(rows.working.count, 2)
        XCTAssertEqual(rows.recent.map(\.id), ["h/failed"])
    }
    func testAWorkingCardReadsTheAgentsLastWordsOnlyWhileTheyAreTheNewest() throws {
        func messages(_ json: String) throws -> [Message] { try JSONDecoder().decode([Message].self, from: Data(json.utf8)) }
        let replying = try messages(#"[{"id":"p","role":"user","text":"Fix the tooltips."},{"id":"r","role":"assistant","text":"I read the drawer.\n\nNow **checking** the `tooltip` tests\nin the drawer."}]"#)
        XCTAssertEqual(FocusThreads.lastWords(replying), "Now checking the tooltip tests in the drawer.", "The last block, as one line of plain text")
        let listed = try messages(#"[{"id":"r","role":"assistant","text":"Next:\n\n- Run the tests\n- Open the pull request"}]"#)
        XCTAssertEqual(FocusThreads.lastWords(listed), "Open the pull request")
        let asked = try messages(#"[{"id":"r","role":"assistant","text":"Done."},{"id":"p","role":"user","text":"Now the tests."}]"#)
        XCTAssertNil(FocusThreads.lastWords(asked), "The user wrote last, so the agent has said nothing since")
        let code = try messages(#"[{"id":"r","role":"assistant","text":"Running:\n\n```sh\nnpm test\n```"}]"#)
        XCTAssertNil(FocusThreads.lastWords(code), "A line can't show code")
        XCTAssertNil(FocusThreads.lastWords([]))
    }
    // MARK: Delegated threads (ADR-0081)

    private func ask(_ kind: String, _ id: String = "r") -> String {
        #"[{"id":"\#(id)","kind":"\#(kind)","text":"\#(kind) from \#(id)","options":[]}]"#
    }
    func testDelegatedThreadsLeaveTheListAtBothLevels() throws {
        let top = try thread("top")
        let child = try thread("child", #", "delegatedBy":"top", "backgroundWork":[{"type":"subagent"}]"#)
        let grandchild = try thread("grandchild", #", "delegatedBy":"child", "finishedUnread":true"#)
        let computers = [ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, child, grandchild])]
        let rows = FocusThreads(computers)
        XCTAssertEqual(rows.recent.map(\.id), ["h/top"])
        XCTAssertTrue(rows.working.isEmpty)
        XCTAssertTrue(rows.questions.isEmpty)
        // Counts leave hidden threads out: the grandchild's finish is not the Threads tab's to count.
        XCTAssertEqual(rows.unreadFinishedCount, 0)
        // No search finds a delegated thread by its own name.
        XCTAssertTrue(FocusThreads(computers, query: "grandchild").isEmpty)
        XCTAssertEqual(ThreadGroups.delegationTops(ThreadGroups.merged(computers)), ["h/child": "h/top", "h/grandchild": "h/top"])
        XCTAssertEqual(child.delegatedBy, "top")
        XCTAssertNil(top.delegatedBy)
    }
    func testADelegatedThreadWhoseDelegatingThreadIsNotListedKeepsItsRow() throws {
        let orphan = try thread("orphan", #", "delegatedBy":"gone""#)
        // The same thread ID on another computer is another thread, so it delegated nothing here.
        let elsewhere = try thread("top")
        let other = try thread("other", #", "delegatedBy":"top""#)
        let first = try thread("first", #", "delegatedBy":"second""#)
        let second = try thread("second", #", "delegatedBy":"first""#)
        let rows = FocusThreads([ComputerThreads(hostID: "one", name: "Laptop", status: .online, threads: [elsewhere]),
                                 ComputerThreads(hostID: "two", name: "Forge", status: .online, threads: [orphan, other, first, second])])
        XCTAssertEqual(Set(rows.recent.map(\.id)), ["one/top", "two/orphan", "two/other", "two/first", "two/second"])
    }
    func testAnOpenDelegatedThreadUnderASettledOneKeepsItsRow() throws {
        let top = try thread("top", #", "workspaceSettledAt":"2026-10-21""#)
        let open = try thread("open", #", "delegatedBy":"top""#)
        let settled = try thread("settled", #", "delegatedBy":"top", "workspaceSettledAt":"2026-10-21""#)
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, open, settled])])
        XCTAssertEqual(rows.recent.map(\.id), ["h/open"])
        XCTAssertEqual(rows.settled.map(\.id), ["h/top"])
    }
    func testADelegatedThreadWaitingOnYouPutsItsTopInNeedsYou() throws {
        let top = try thread("top", #", "backgroundWork":[{"type":"subagent"}]"#)
        let child = try thread("child", #", "delegatedBy":"top""#, requests: ask("question", "q"))
        let grandchild = try thread("grandchild", #", "delegatedBy":"child""#, requests: ask("permission", "p"))
        let computers = [ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, child, grandchild])]
        let rows = FocusThreads(computers)
        XCTAssertEqual(rows.questions.map(\.id), ["h/top"])
        XCTAssertTrue(rows.working.isEmpty)
        // A permission holds its agent still, so it outranks a question below the same thread.
        XCTAssertEqual(rows.asking(rows.questions[0]).id, "h/grandchild")
        XCTAssertEqual(rows.requestCount, 1)
        // A search finds the row by what it asks.
        XCTAssertEqual(FocusThreads(computers, query: "permission from p").questions.map(\.id), ["h/top"])
        // The row's own request wins over one below it.
        let asking = try thread("top", requests: ask("question", "own"))
        let own = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [asking, child, grandchild])])
        XCTAssertEqual(own.questions.map(\.id), ["h/top"])
        XCTAssertEqual(own.asking(own.questions[0]).id, "h/top")
        XCTAssertEqual(own.requestCount, 1)
    }
    func testASettledThreadWithADelegatedThreadWaitingOnYouStaysInNeedsYou() throws {
        let top = try thread("top", #", "workspaceSettledAt":"2026-10-21""#)
        let child = try thread("child", #", "delegatedBy":"top", "workspaceSettledAt":"2026-10-21""#, requests: ask("permission"))
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, child])])
        XCTAssertEqual(rows.questions.map(\.id), ["h/top"])
        XCTAssertTrue(rows.settled.isEmpty)
        XCTAssertEqual(rows.asking(rows.questions[0]).id, "h/child")
    }
    func testNoRollUpFromAComputerThisIPhoneCannotReach() throws {
        let top = try thread("top")
        let child = try thread("child", #", "delegatedBy":"top""#, requests: ask("permission"))
        for status in [ComputerStatus.connecting, .unreachable] {
            let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: status, threads: [top, child])])
            XCTAssertTrue(rows.questions.isEmpty)
            XCTAssertEqual(rows.recent.map(\.id), ["h/top"])
            XCTAssertEqual(rows.requestCount, 0)
        }
    }
    func testAChoiceIsForTheRequestItWasPickedForAndGoesWhenAnotherTakesOver() throws {
        let top = try thread("top")
        let first = try thread("first", #", "delegatedBy":"top""#, requests: ask("question"))
        let host = "h"
        let before = FocusThreads([ComputerThreads(hostID: host, name: "Laptop", status: .online, threads: [top, first])])
        let askedFirst = try XCTUnwrap(before.asked(before.questions[0]))
        XCTAssertEqual(askedFirst, AskedRequest(thread: ThreadRef(hostID: host, threadID: "first"), requestID: "r"))
        let yes = CardChoice(asked: askedFirst, option: "Yes")
        XCTAssertEqual(yes.chosen(for: askedFirst), "Yes")
        // A permission in another delegated thread takes the row over. Its request has the same ID, which is unique only
        // in its own thread, so the row's card shows another request and the choice picked for the first is gone.
        let second = try thread("second", #", "delegatedBy":"top""#, requests: ask("permission"))
        let after = FocusThreads([ComputerThreads(hostID: host, name: "Laptop", status: .online, threads: [top, first, second])])
        XCTAssertEqual(after.questions.map(\.id), ["h/top"])
        let askedSecond = try XCTUnwrap(after.asked(after.questions[0]))
        XCTAssertEqual(askedSecond, AskedRequest(thread: ThreadRef(hostID: host, threadID: "second"), requestID: "r"))
        XCTAssertNotEqual(askedSecond, askedFirst)
        XCTAssertNil(yes.chosen(for: askedSecond))
        // A thread's own next request is another request too.
        XCTAssertNil(yes.chosen(for: AskedRequest(thread: askedFirst.thread, requestID: "next")))
        // A row with nothing to ask has no request for a card.
        let quiet = FocusThreads([ComputerThreads(hostID: host, name: "Laptop", status: .online, threads: [top])])
        XCTAssertNil(quiet.asked(quiet.recent[0]))
    }
}
