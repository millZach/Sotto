import XCTest
@testable import SottoCore

final class FocusThreadsTests: XCTestCase {
    private func thread(_ id: String, _ extra: String = "", requests: String = "[]", status: String = "idle") throws -> ThreadSummary {
        try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"\#(id)","projectId":"p","title":"\#(id)","status":"\#(status)","requests":\#(requests)\#(extra)}"#.utf8))
    }
    func testSnoozesPartitionWorkAndExpireWithoutHidingRequests() throws {
        let now = try XCTUnwrap(Stamp.date("2026-11-05T09:00:00Z"))
        let snooze = #", "snoozedUntil":"2026-11-05T10:00:00Z""#
        let asleep = try thread("asleep", snooze + #", "updatedAt":"2026-11-05T08:00:00Z""#, status: "running")
        let later = try thread("later", snooze + #", "updatedAt":"2026-11-05T08:30:00Z""#)
        let question = try thread("question", snooze, requests: #"[{"id":"q","kind":"question","text":"Choose","options":[]}]"#)
        let permission = try thread("permission", snooze, requests: #"[{"id":"p","kind":"permission","text":"Approve","options":[]}]"#)
        let failed = try thread("failed", snooze, status: "error")
        let putAway = try thread("settled", snooze + #", "settledAt":"yesterday""#)
        let computer = ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [asleep, later, question, permission, failed, putAway])
        let groups = FocusThreads([computer], now: now)
        XCTAssertEqual(Set(groups.questions.map(\.id)), ["h/question", "h/permission"])
        XCTAssertEqual(groups.requestCount, 2)
        XCTAssertTrue(groups.working.isEmpty)
        XCTAssertEqual(groups.snoozedProjects.first?.rows.map(\.id), ["h/later", "h/asleep"])
        XCTAssertEqual(groups.settled.map(\.id), ["h/settled"])
        XCTAssertEqual(groups.recent.map(\.id), ["h/failed"])
        let awake = FocusThreads([computer], now: now.addingTimeInterval(3600))
        XCTAssertTrue(awake.snoozed.isEmpty)
        XCTAssertEqual(awake.working.map(\.id), ["h/asleep"])
        XCTAssertEqual(FocusThreads([computer], query: "later", now: now).snoozed.map(\.id), ["h/later"])
        XCTAssertNil(try thread("older-host").snoozedUntil)
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
    // MARK: Delegated threads (ADR-0081)

    private func ask(_ kind: String, _ id: String = "r") -> String {
        #"[{"id":"\#(id)","kind":"\#(kind)","text":"\#(kind) from \#(id)","options":[]}]"#
    }
    func testDelegatedThreadsLeaveTheListAtBothLevelsAndRollUpWorking() throws {
        let top = try thread("top")
        let child = try thread("child", #", "delegatedBy":"top", "backgroundWork":[{"type":"subagent"}]"#)
        let grandchild = try thread("grandchild", #", "delegatedBy":"child", "finishedUnread":true"#)
        let computers = [ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, child, grandchild])]
        let rows = FocusThreads(computers)
        XCTAssertTrue(rows.recent.isEmpty)
        XCTAssertEqual(rows.working.map(\.id), ["h/top"])
        XCTAssertEqual(rows.workingIn["h/top"]?.id, "h/child")
        XCTAssertTrue(rows.questions.isEmpty)
        // Counts leave hidden threads out: the grandchild's finish is not the Threads tab's to count.
        XCTAssertEqual(rows.unreadFinishedCount, 0)
        // No search finds a delegated thread by its own name.
        XCTAssertTrue(FocusThreads(computers, query: "grandchild").isEmpty)
        XCTAssertEqual(ThreadGroups.delegationTops(ThreadGroups.merged(computers)), ["h/child": "h/top", "h/grandchild": "h/top"])
        XCTAssertEqual(child.delegatedBy, "top")
        XCTAssertNil(top.delegatedBy)
        // Once every delegated thread is idle, the top returns to Recent.
        let idleChild = try thread("child", #", "delegatedBy":"top""#)
        let idle = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, idleChild, grandchild])])
        XCTAssertEqual(idle.recent.map(\.id), ["h/top"])
        XCTAssertTrue(idle.working.isEmpty)
        XCTAssertTrue(idle.workingIn.isEmpty)
    }
    func testADelegatedThreadWhoseDelegatingThreadIsNotListedNeverLeaksUnlessItWaitsOnYou() throws {
        let orphan = try thread("orphan", #", "delegatedBy":"gone", "finishedUnread":true"#)
        let workingOrphan = try thread("working-orphan", #", "delegatedBy":"gone""#, status: "running")
        // The same thread ID on another computer is another thread, so a bare link names nothing here.
        let elsewhere = try thread("top")
        let other = try thread("other", #", "delegatedBy":"top""#)
        let first = try thread("first", #", "delegatedBy":"second""#)
        let second = try thread("second", #", "delegatedBy":"first""#)
        // An owlet lives on the Owlets tab, so its delegated thread has no Threads parent row.
        let owlet = try thread("owlet", #", "owlet":{"name":"Scout","role":"Watch builds"}"#)
        let owletChild = try thread("owlet-child", #", "delegatedBy":"owlet""#, status: "running")
        let rows = FocusThreads([ComputerThreads(hostID: "one", name: "Laptop", status: .online, threads: [elsewhere, owlet, owletChild]),
                                 ComputerThreads(hostID: "two", name: "Forge", status: .online, threads: [orphan, workingOrphan, other, first, second])])
        XCTAssertEqual(rows.recent.map(\.id), ["one/top"])
        XCTAssertTrue(rows.working.isEmpty)
        XCTAssertTrue(rows.questions.isEmpty)
        XCTAssertTrue(rows.settled.isEmpty)
        XCTAssertEqual(rows.unreadFinishedCount, 0)
        XCTAssertTrue(FocusThreads([ComputerThreads(hostID: "two", name: "Forge", status: .online, threads: [orphan])], query: "orphan").isEmpty)
        // When a delegated thread whose parent is missing or held back waits on the user, it falls back into Needs you so
        // its request remains reachable and answerable (ADR-0081).
        let askingOrphan = try thread("asking-orphan", #", "delegatedBy":"held-back-parent""#, requests: ask("permission", "p"))
        let fallback = FocusThreads([ComputerThreads(hostID: "two", name: "Forge", status: .online, threads: [orphan, askingOrphan])])
        XCTAssertEqual(fallback.questions.map(\.id), ["two/asking-orphan"])
        XCTAssertEqual(fallback.requestCount, 1)
        XCTAssertEqual(fallback.asking(fallback.questions[0]).id, "two/asking-orphan")
        XCTAssertTrue(fallback.recent.isEmpty)
        // An unreachable asking orphan claims no live request and still never leaks into Recent.
        let offlineFallback = FocusThreads([ComputerThreads(hostID: "two", name: "Forge", status: .unreachable, threads: [orphan, askingOrphan])])
        XCTAssertTrue(offlineFallback.questions.isEmpty)
        XCTAssertTrue(offlineFallback.recent.isEmpty)
    }
    func testAnOpenDelegatedThreadUnderASettledOrArchivedParentFoldsUnderIt() throws {
        let top = try thread("top", #", "workspaceSettledAt":"2026-10-21""#)
        let open = try thread("open", #", "delegatedBy":"top""#)
        let working = try thread("working", #", "delegatedBy":"top""#, status: "running")
        let settled = try thread("settled", #", "delegatedBy":"top", "workspaceSettledAt":"2026-10-21""#)
        let archived = try thread("archived", #", "archivedAt":"2026-10-21""#)
        let underArchived = try thread("under-archived", #", "delegatedBy":"archived""#)
        let rows = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, open, working, settled, archived, underArchived])])
        XCTAssertTrue(rows.recent.isEmpty)
        XCTAssertTrue(rows.working.isEmpty, "Settled is quiet: a working delegated thread never moves a settled parent to Working now")
        XCTAssertEqual(Set(rows.settled.map(\.id)), ["h/top", "h/archived"])
        // An open delegated thread waiting on the user lifts its settled parent into Needs you.
        let asking = try thread("asking", #", "delegatedBy":"top""#, requests: ask("question", "q"))
        let needs = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, asking])])
        XCTAssertEqual(needs.questions.map(\.id), ["h/top"])
        XCTAssertEqual(needs.asking(needs.questions[0]).id, "h/asking")
        XCTAssertTrue(needs.settled.isEmpty)
        XCTAssertTrue(needs.recent.isEmpty)
    }
    func testCrossComputerDelegatedThreadsFoldAndRollUpAcrossHostAndRelayLinks() throws {
        let laptopID = "5b0445e9-b649-4480-86fb-ce0a61de1c30"
        let forgeID = "62c79358-687d-4274-a876-1a0d79e1c195"
        let unpairedID = "99999999-9999-4999-8999-999999999999"
        let cutover = try thread("C449D630-6C48-4F71-B1ED-FFB6392BB404")
        let persistentParent = try thread("persistent-parent")
        let hillclimb = try thread("hillclimb")
        // Desktop child delegated by a forge parent (`host:<forgeID>:<id>`), with its own local grandchild.
        let baselines = try thread("baselines", #", "delegatedBy":"host:\#(forgeID):hillclimb""#)
        let baselinesReview = try thread("baselines-review", #", "delegatedBy":"baselines""#, status: "running")
        // Forge child delegated by a laptop parent via legacy `relay:<client>:<caller>` and its own forge grandchild.
        let onForge = try thread("on-forge", #", "delegatedBy":"relay:client-1:C449D630-6C48-4F71-B1ED-FFB6392BB404""#, status: "running")
        let forgeReview = try thread("forge-review", #", "delegatedBy":"on-forge", "finishedUnread":true"#)
        // Forge child delegated via PR #2865 persistent `relay:<client>:host:<desktopHostId>:<callerId>`.
        let persistentChild = try thread("persistent-child", #", "delegatedBy":"relay:old-client:host:\#(laptopID):persistent-parent""#)
        // Unpaired desktop's thread: never leaks into Recent or Working.
        let stranger = try thread("stranger", #", "delegatedBy":"relay:other:host:\#(unpairedID):missing""#, status: "running")

        let computers = [
            ComputerThreads(hostID: laptopID, name: "Laptop", status: .online, threads: [cutover, persistentParent, baselines, baselinesReview]),
            ComputerThreads(hostID: forgeID, name: "Forge", status: .online, threads: [hillclimb, onForge, forgeReview, persistentChild, stranger]),
        ]
        let groups = FocusThreads(computers)
        XCTAssertTrue(groups.questions.isEmpty)
        XCTAssertEqual(Set(groups.working.map(\.id)), ["\(laptopID)/\(cutover.id)", "\(forgeID)/hillclimb"])
        XCTAssertEqual(groups.workingIn["\(laptopID)/\(cutover.id)"]?.id, "\(forgeID)/on-forge")
        XCTAssertEqual(groups.workingIn["\(forgeID)/hillclimb"]?.id, "\(laptopID)/baselines-review")
        XCTAssertEqual(groups.recent.map(\.id), ["\(laptopID)/persistent-parent"])
        XCTAssertEqual(groups.unreadFinishedCount, 0)
        XCTAssertEqual(groups.rowID(for: ThreadRef(hostID: forgeID, threadID: "forge-review")), "\(laptopID)/\(cutover.id)")
        XCTAssertEqual(groups.rowID(for: ThreadRef(hostID: forgeID, threadID: "persistent-child")), "\(laptopID)/persistent-parent")
        XCTAssertEqual(groups.rowID(for: ThreadRef(hostID: laptopID, threadID: "baselines-review")), "\(forgeID)/hillclimb")
        XCTAssertTrue(FocusThreads(computers, query: "forge-review").isEmpty)
        XCTAssertTrue(FocusThreads(computers, query: "stranger").isEmpty)

        // When forge is unreachable, its delegated threads still fold and never claim live work on laptop's parent.
        let forgeOffline = FocusThreads([
            ComputerThreads(hostID: laptopID, name: "Laptop", status: .online, threads: [cutover]),
            ComputerThreads(hostID: forgeID, name: "Forge", status: .unreachable, threads: [onForge, forgeReview]),
        ])
        XCTAssertTrue(forgeOffline.working.isEmpty)
        XCTAssertEqual(forgeOffline.recent.map(\.id), ["\(laptopID)/\(cutover.id)"])
    }
    func testCrossComputerNeedsYouRollUpAndComputerFilterFallback() throws {
        let laptopID = "5b0445e9-b649-4480-86fb-ce0a61de1c30"
        let forgeID = "62c79358-687d-4274-a876-1a0d79e1c195"
        let parent = try thread("parent")
        let child = try thread("child", #", "delegatedBy":"relay:client-1:host:\#(laptopID):parent""#, requests: ask("question", "q"))
        let grandchild = try thread("grandchild", #", "delegatedBy":"child""#, requests: ask("permission", "p"))
        let computers = [
            ComputerThreads(hostID: laptopID, name: "Laptop", status: .online, threads: [parent]),
            ComputerThreads(hostID: forgeID, name: "Forge", status: .online, threads: [child, grandchild]),
        ]
        // All computers: laptop parent stands in Needs you for forge's permission ahead of question.
        let all = FocusThreads(computers)
        XCTAssertEqual(all.questions.map(\.id), ["\(laptopID)/parent"])
        XCTAssertEqual(all.asking(all.questions[0]).id, "\(forgeID)/grandchild")
        XCTAssertEqual(all.requestCount, 1)
        XCTAssertTrue(all.recent.isEmpty)
        XCTAssertEqual(all.asked(all.questions[0]), AskedRequest(thread: ThreadRef(hostID: forgeID, threadID: "grandchild"), requestID: "p"))

        // Even if laptop is unreachable, forge's reachable asking child still rolls up onto laptop's row.
        let laptopOffline = FocusThreads([
            ComputerThreads(hostID: laptopID, name: "Laptop", status: .unreachable, threads: [parent]),
            ComputerThreads(hostID: forgeID, name: "Forge", status: .online, threads: [child, grandchild]),
        ])
        XCTAssertEqual(laptopOffline.questions.map(\.id), ["\(laptopID)/parent"])
        XCTAssertEqual(laptopOffline.asking(laptopOffline.questions[0]).id, "\(forgeID)/grandchild")

        // Filtering to laptop keeps parent and still rolls up forge's asking child.
        let onlyLaptop = FocusThreads(computers, show: .only(laptopID))
        XCTAssertEqual(onlyLaptop.questions.map(\.id), ["\(laptopID)/parent"])
        XCTAssertEqual(onlyLaptop.asking(onlyLaptop.questions[0]).id, "\(forgeID)/grandchild")

        // Filtering to forge hides non-asking delegated rows, while keeping asking children reachable in Needs you.
        let runningChild = try thread("child", #", "delegatedBy":"relay:client-1:host:\#(laptopID):parent""#, status: "running")
        let onlyForge = FocusThreads([
            ComputerThreads(hostID: laptopID, name: "Laptop", status: .online, threads: [parent]),
            ComputerThreads(hostID: forgeID, name: "Forge", status: .online, threads: [runningChild, grandchild]),
        ], show: .only(forgeID))
        XCTAssertTrue(onlyForge.recent.isEmpty)
        XCTAssertTrue(onlyForge.working.isEmpty)
        XCTAssertEqual(onlyForge.questions.map(\.id), ["\(forgeID)/grandchild"])
    }
    func testAmbiguousRelayLinkNeverLeaksUnlessWaitingOnYou() throws {
        let laptopA = "11111111-1111-4111-8111-111111111111"
        let laptopB = "22222222-2222-4222-8222-222222222222"
        let forgeID = "62c79358-687d-4274-a876-1a0d79e1c195"
        let parentA = try thread("shared")
        let parentB = try thread("shared")
        let idle = try thread("ambiguous-idle", #", "delegatedBy":"relay:c:shared""#, status: "running")
        let asking = try thread("ambiguous-asking", #", "delegatedBy":"relay:c:shared""#, requests: ask("question", "q"))
        let groups = FocusThreads([
            ComputerThreads(hostID: laptopA, name: "Laptop A", status: .online, threads: [parentA]),
            ComputerThreads(hostID: laptopB, name: "Laptop B", status: .online, threads: [parentB]),
            ComputerThreads(hostID: forgeID, name: "Forge", status: .online, threads: [idle, asking]),
        ])
        XCTAssertEqual(Set(groups.recent.map(\.id)), ["\(laptopA)/shared", "\(laptopB)/shared"])
        XCTAssertTrue(groups.working.isEmpty)
        XCTAssertEqual(groups.questions.map(\.id), ["\(forgeID)/ambiguous-asking"])
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
        // A delegated thread is marked by its top's row while it shows, whether or not it still asks.
        XCTAssertEqual(rows.rowID(for: ThreadRef(hostID: "h", threadID: "grandchild")), "h/top")
        let answered = FocusThreads([ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [top, try thread("child", #", "delegatedBy":"top""#), try thread("grandchild", #", "delegatedBy":"child""#)])])
        XCTAssertEqual(answered.rowID(for: ThreadRef(hostID: "h", threadID: "grandchild")), "h/top")
        XCTAssertEqual(answered.rowID(for: ThreadRef(hostID: "h", threadID: "top")), "h/top")
    }
    func testADelegatedThreadOffersNoWatchAndItsParentDoes() throws {
        // Watcher talks only to the thread that delegated it, so that thread is the one to watch (#1217, pick B).
        XCTAssertTrue(ThreadGroups.offersWatch(try thread("top")))
        XCTAssertFalse(ThreadGroups.offersWatch(try thread("child", #", "delegatedBy":"top""#)))
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
