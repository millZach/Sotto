import XCTest
@testable import SottoCore

/// The Agents view (ADR-0103): what a thread's top bar counts and how its sheet orders and words its delegated threads
/// and sub-agents, as the desktop's Tools › Agents does.
final class AgentsRosterTests: XCTestCase {
    private func thread(_ id: String, _ extra: String = "", status: String = "idle", requests: String = "[]") throws -> ThreadSummary {
        try JSONDecoder().decode(ThreadSummary.self, from: Data(#"{"id":"\#(id)","projectId":"p","title":"\#(id) title","providerId":"codex","modelId":"sol","status":"\#(status)","requests":\#(requests)\#(extra)}"#.utf8))
    }
    private let permission = #"[{"id":"r","kind":"permission","text":"Run npm test?","options":[]}]"#
    private let question = #"[{"id":"q","kind":"question","text":"Which branch?","options":[]}]"#
    private func at(_ minutesAgo: Double) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60)) }

    func testTheSummaryAndTheReadsAreReadTolerantlyAndNeverFailTheirThread() throws {
        let counted = try thread("owner", #", "subagentSummary":{"total":3,"working":1,"completed":2,"failed":0,"interrupted":0,"unknown":0}"#)
        XCTAssertEqual(counted.subagentSummary, SubagentSummary(total: 3, working: 1, unknown: 0))
        // A summary of another shape, or a count of another type, reads as none rather than losing the thread.
        XCTAssertEqual(try thread("odd", #", "subagentSummary":"three""#).subagentSummary, SubagentSummary())
        XCTAssertEqual(try thread("partial", #", "subagentSummary":{"total":"2","working":1}"#).subagentSummary, SubagentSummary(total: 0, working: 1))
        XCTAssertNil(try thread("older").subagentSummary)

        let read = try JSONDecoder().decode(ThreadDelegations.self, from: Data(#"{"threadId":"owner","threads":[{"thread":"review","by":"owner","work":"code-review","outcome":"working","startedAt":"2026-10-21T10:00:00.000Z","waiting":true,"brief":"Review it."},{"by":"owner"},{"thread":"next","by":"owner","outcome":"settled-somehow","waiting":false}]}"#.utf8))
        XCTAssertEqual(read.threads.map(\.thread), ["review", "next"], "A row this build can't read is left out; the rest still show")
        XCTAssertEqual(read.threads[0].brief, "Review it.")
        XCTAssertEqual(AgentsRoster.outcomeWord(read.threads[1].outcome), "Unknown")

        let page = try JSONDecoder().decode(SubagentPage.self, from: Data(#"{"threadId":"owner","revision":4,"rows":[{"id":"a","sequence":1,"revision":1,"assignmentId":"a1","assignmentCount":1,"title":"Find fixed waits","description":"Find fixed waits","model":"gpt-6.1-sol","status":"completed","startedAt":"2026-10-21T10:00:00.000Z","lastObservedAt":"2026-10-21T10:01:00.000Z","durationMs":48000},{"title":"no id"}],"summary":{"total":1,"working":0,"completed":1,"failed":0,"interrupted":0,"unknown":0},"before":7}"#.utf8))
        XCTAssertEqual(page.rows.map(\.id), ["a"])
        XCTAssertEqual(page.before, 7)
        let assignments = try JSONDecoder().decode(SubagentAssignmentsPage.self, from: Data(#"{"threadId":"owner","agentId":"a","assignments":[{"id":"a1","sequence":1,"title":"Find","status":"completed","prompt":"Find every fixed wait.","result":"Three."}]}"#.utf8))
        XCTAssertEqual(assignments.assignments.first?.result, "Three.")
    }

    func testTheTopBarCountsBothLevelsAndTheAgentsAndSaysWhatWaitsOnYou() throws {
        let owner = try thread("owner", #", "subagentSummary":{"total":2,"working":1,"completed":1,"failed":0,"interrupted":0,"unknown":0}"#)
        let review = try thread("review", #", "delegatedBy":"owner""#, status: "running", requests: permission)
        let docs = try thread("docs", #", "delegatedBy":"owner""#)
        let nested = try thread("nested", #", "delegatedBy":"review""#, requests: question)
        let elsewhere = try thread("elsewhere", #", "delegatedBy":"other""#, requests: permission)
        // A settled delegated thread that waits on the user still needs you: only the user can answer it (ADR-0081).
        let settled = try thread("settled", #", "delegatedBy":"docs", "settledAt":"2026-10-20""#, requests: permission)
        let threads = [owner, review, docs, nested, elsewhere, settled]
        XCTAssertEqual(AgentsRoster.count(owner, in: threads), AgentsCount(total: 6, needs: 3))
        XCTAssertNil(AgentsRoster.count(try thread("alone"), in: threads), "No control without delegated threads or agents")
        XCTAssertEqual(AgentsRoster.count(try thread("agents", #", "subagentSummary":{"total":1}"#), in: threads), AgentsCount(total: 1, needs: 0))
    }

    func testTheSheetListsNewestStartFirstWithEachFamilyTogetherInTheGlossarysWords() throws {
        let owner = try thread("owner")
        let review = try thread("review", #", "delegatedBy":"owner""#, status: "running", requests: permission)
        let docs = try thread("docs", #", "delegatedBy":"owner", "finishedUnread":true"#)
        let check = try thread("check", #", "delegatedBy":"review""#)
        let quick = try thread("quick", #", "delegatedBy":"review""#, status: "running")
        let records = [
            DelegatedThreadRecord(thread: "review", by: "owner", work: "code-review", outcome: "working", startedAt: at(3), brief: "Review the login fix."),
            DelegatedThreadRecord(thread: "docs", by: "owner", work: "research", outcome: "answered", startedAt: at(6), outcomeAt: at(5)),
            DelegatedThreadRecord(thread: "check", by: "review", work: "research", outcome: "stopped", startedAt: at(2), outcomeAt: at(1)),
        ]
        let agents = [
            SubagentRow(id: "waits", title: "Find fixed waits", model: "gpt-6.1-sol", status: "completed", startedAt: at(7), durationMs: 48_000),
            SubagentRow(id: "suite", title: "Run the suite", status: "running", startedAt: at(1)),
            SubagentRow(id: "child", parentId: "suite", title: "Count failures", status: "failed", startedAt: at(0.5)),
        ]
        let models = [try JSONDecoder().decode(ThreadModel.self, from: Data(#"{"id":"sol","name":"GPT-6.1 Sol","provider":"Codex","providerId":"codex","ready":true}"#.utf8))]
        let rows = AgentsRoster.rows(owner: owner, threads: [owner, review, docs, check, quick], delegations: records, agents: agents, models: models)
        // Newest start first: the running agent with its child, then the review with its own (newest first), the docs, the
        // finished agent. A delegated thread the computer said nothing of goes last in its family, worded Unknown or
        // Working as the list says.
        XCTAssertEqual(rows.map(\.id), ["agent:suite", "agent:child", "thread:review", "thread:check", "thread:quick", "thread:docs", "agent:waits"])
        XCTAssertEqual(rows.map(\.level), [1, 2, 1, 2, 2, 1, 1])
        let byID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        XCTAssertEqual(byID["thread:review"]?.status, "Needs your approval")
        XCTAssertEqual(byID["thread:review"]?.tone, .needs)
        XCTAssertEqual(byID["thread:review"]?.waitingFor, "approval")
        XCTAssertEqual(byID["thread:review"]?.preview, "Review the login fix.")
        XCTAssertEqual(byID["thread:review"]?.meta(clock: { _ in "10:51" }), "Codex · Code review · GPT-6.1 Sol · 10:51")
        XCTAssertEqual(byID["thread:review"]?.spokenLabel, "review title, delegated thread on Codex, Needs your approval. Opens it to answer")
        XCTAssertEqual(byID["thread:check"]?.delegatedBy, "review title")
        XCTAssertEqual(byID["thread:check"]?.status, "Stopped")
        XCTAssertEqual(byID["thread:quick"]?.status, "Working")
        XCTAssertEqual(byID["thread:docs"]?.status, "Just finished")
        XCTAssertEqual(byID["agent:waits"]?.status, "Finished")
        XCTAssertEqual(byID["agent:waits"]?.elapsed, .took(48))
        XCTAssertEqual(byID["agent:child"]?.tone, .failed)
        XCTAssertEqual(byID["agent:suite"]?.meta(clock: { _ in "10:53" }), "Model not reported · 10:53")
        XCTAssertEqual(byID["agent:suite"]?.spokenLabel, "Run the suite, agent, Working")
        if case .since = byID["thread:review"]?.elapsed {} else { XCTFail("A thread that waits on you counts up from its start") }
        if case .took(let seconds) = byID["thread:docs"]?.elapsed { XCTAssertEqual(seconds, 60, accuracy: 1) } else { XCTFail("A finished thread says how long it took") }

        let counts = AgentsRoster.countLine(rows, summary: SubagentSummary(total: 3, working: 1))
        XCTAssertEqual(counts.title, "4 delegated threads · 3 agents")
        XCTAssertEqual(counts.detail, "1 needs you · 2 working")
    }

    func testBeforeTheReadNothingIsGuessedAndASettledThreadsAgentsAreQuiet() throws {
        let owner = try thread("owner", #", "settledAt":"2026-10-20""#)
        let done = try thread("done", #", "delegatedBy":"owner""#)
        let asking = try thread("asking", #", "delegatedBy":"owner""#, requests: question)
        let before = AgentsRoster.rows(owner: owner, threads: [owner, done, asking], delegations: nil, agents: [])
        XCTAssertNil(before.first { $0.id == "thread:done" }?.status, "Nothing is said before the computer answers")
        XCTAssertEqual(before.first { $0.id == "thread:done" }?.tone, .quiet)
        XCTAssertEqual(before.first { $0.id == "thread:asking" }?.status, "Needs your answer", "A request still waits on the user")
        let after = AgentsRoster.rows(owner: owner, threads: [owner, done], delegations: [], agents: [SubagentRow(id: "a", title: "", status: "running")])
        XCTAssertEqual(after.first { $0.id == "thread:done" }?.status, "Unknown")
        XCTAssertEqual(after.first { $0.id == "agent:a" }?.title, "Agent task")
        XCTAssertEqual(after.first { $0.id == "agent:a" }?.tone, .quiet)
        XCTAssertEqual(AgentsRoster.countLine(after, summary: nil).detail, "None working")
        XCTAssertEqual(AgentsRoster.countLine([], summary: SubagentSummary(total: 1, unknown: 1)).title, "1 agent")
        XCTAssertEqual(AgentsRoster.countLine([], summary: SubagentSummary(total: 1, unknown: 1)).detail, "Activity not confirmed")
    }

    func testASettledDelegatedThreadKeepsItsRequestButItsWorkIsQuiet() throws {
        let owner = try thread("owner")
        let asking = try thread("asking", #", "delegatedBy":"owner", "settledAt":"2026-10-21""#, status: "running", requests: question)
        let busy = try thread("busy", #", "delegatedBy":"owner", "settledAt":"2026-10-21""#, status: "running")
        let done = try thread("done", #", "delegatedBy":"owner", "settledAt":"2026-10-21", "finishedUnread":true"#)
        let threads = [owner, asking, busy, done]
        XCTAssertEqual(AgentsRoster.count(owner, in: threads), AgentsCount(total: 3, needs: 1))
        let records = [DelegatedThreadRecord(thread: "asking", by: "owner", outcome: "working", startedAt: at(4)),
                       DelegatedThreadRecord(thread: "busy", by: "owner", outcome: "working", startedAt: at(2)),
                       DelegatedThreadRecord(thread: "done", by: "owner", outcome: "answered", startedAt: at(6), outcomeAt: at(5))]
        let rows = Dictionary(uniqueKeysWithValues: AgentsRoster.rows(owner: owner, threads: threads, delegations: records, agents: []).map { ($0.id, $0) })
        XCTAssertEqual(rows["thread:asking"]?.waitingFor, "question")
        XCTAssertEqual(rows["thread:asking"]?.status, "Needs your answer")
        XCTAssertEqual(rows["thread:asking"]?.tone, .needs)
        XCTAssertEqual(rows["thread:busy"]?.status, "Working")
        XCTAssertEqual(rows["thread:busy"]?.tone, .quiet)
        XCTAssertEqual(rows["thread:done"]?.status, "Answered", "Settled is quiet: no Just finished")
        XCTAssertEqual(rows["thread:done"]?.tone, .quiet)
        XCTAssertEqual(AgentsRoster.countLine(Array(rows.values), summary: nil).detail, "1 needs you")
    }

    func testAnUnseenFailureNeedsAttentionWithoutAnythingToAnswer() throws {
        let owner = try thread("owner")
        let failed = try thread("failed", #", "delegatedBy":"owner", "failureId":"f1""#, status: "error")
        let seen = try thread("seen", #", "delegatedBy":"owner", "failureSeen":true"#, status: "error")
        let settled = try thread("settled", #", "delegatedBy":"owner", "settledAt":"2026-10-21""#, status: "error")
        let asking = try thread("asking", #", "delegatedBy":"owner""#, status: "error", requests: permission)
        let threads = [owner, failed, seen, settled, asking]
        XCTAssertEqual(seen.failureSeen, true)
        XCTAssertNil(failed.failureSeen)
        XCTAssertEqual(AgentsRoster.count(owner, in: threads), AgentsCount(total: 4, needs: 2))
        XCTAssertEqual(AgentsRoster.count(owner, in: threads, failuresSeen: false), AgentsCount(total: 4, needs: 1),
                       "A computer that doesn't say which failures were shown can't have one unseen")
        let records = threads.dropFirst().map { DelegatedThreadRecord(thread: $0.id, by: "owner", outcome: "failed", startedAt: at(5), outcomeAt: at(4)) }
        let rows = Dictionary(uniqueKeysWithValues: AgentsRoster.rows(owner: owner, threads: threads, delegations: records, agents: []).map { ($0.id, $0) })
        XCTAssertEqual(rows["thread:failed"]?.status, "Needs attention")
        XCTAssertEqual(rows["thread:failed"]?.tone, .needs)
        XCTAssertNil(rows["thread:failed"]?.waitingFor, "Nothing to answer, so no Open to answer")
        XCTAssertEqual(rows["thread:failed"]?.spokenLabel, "failed title, delegated thread on Codex, Needs attention. Opens it")
        XCTAssertEqual(rows["thread:seen"]?.status, "Failed")
        XCTAssertEqual(rows["thread:seen"]?.tone, .failed)
        XCTAssertEqual(rows["thread:settled"]?.tone, .quiet)
        XCTAssertEqual(rows["thread:asking"]?.status, "Needs your approval")
        XCTAssertEqual(AgentsRoster.countLine(Array(rows.values), summary: nil).detail, "2 needs you")
        let unread = AgentsRoster.rows(owner: owner, threads: threads, delegations: records, agents: [], failuresSeen: false)
        XCTAssertEqual(unread.first { $0.id == "thread:failed" }?.status, "Failed")
    }

    func testAWorkflowsRunListsItsAgentsAndIsNeverCountedAsOne() throws {
        let page = try JSONDecoder().decode(SubagentPage.self, from: Data(#"{"threadId":"owner","rows":[{"id":"flow","sequence":1,"revision":3,"title":"Check the drawer","status":"running","kind":"workflow","startedAt":"2026-10-21T10:00:00.000Z"},{"id":"one","parentId":"flow","sequence":2,"revision":1,"assignmentId":"one-1","title":"Read the tests","status":"running","startedAt":"2026-10-21T10:00:01.000Z"},{"id":"two","parentId":"flow","sequence":3,"revision":2,"assignmentId":"two-1","title":"Read the docs","status":"running","startedAt":"2026-10-21T10:00:02.000Z"}],"summary":{"total":2,"working":2,"unknown":0}}"#.utf8))
        XCTAssertEqual(page.rows.first?.kind, "workflow")
        XCTAssertEqual(page.rows.first?.revision, 3)
        let rows = AgentsRoster.rows(owner: try thread("owner"), threads: [], delegations: nil, agents: page.rows)
        // The agent that started last is first under its workflow, as everywhere in the sheet.
        XCTAssertEqual(rows.map(\.id), ["agent:flow", "agent:two", "agent:one"])
        XCTAssertEqual(rows.map(\.workflow), [true, false, false])
        XCTAssertEqual(rows.map(\.level), [1, 2, 2])
        XCTAssertEqual(rows[0].spokenLabel, "Check the drawer, workflow, Working")
        // Two agents work under the workflow: two, as the toolbar and the desktop say, whether or not the summary is in.
        XCTAssertEqual(AgentsRoster.countLine(rows, summary: page.summary).title, "2 agents")
        XCTAssertEqual(AgentsRoster.countLine(rows, summary: page.summary).detail, "2 working")
        XCTAssertEqual(AgentsRoster.countLine(rows, summary: nil).title, "2 agents")
        XCTAssertEqual(AgentsRoster.countLine(rows, summary: nil).detail, "2 working")
    }

    func testAnOpenedAgentIsReadAgainWhenItsRunChanges() {
        let running = AgentsRoster.agentRow(SubagentRow(id: "a", assignmentId: "a1", title: "A", status: "running", revision: 1), depth: 0, quiet: false)
        let updated = AgentsRoster.agentRow(SubagentRow(id: "a", assignmentId: "a1", title: "A", status: "running", revision: 2), depth: 0, quiet: false)
        let finished = AgentsRoster.agentRow(SubagentRow(id: "a", assignmentId: "a1", title: "A", status: "completed", revision: 2), depth: 0, quiet: false)
        let next = AgentsRoster.agentRow(SubagentRow(id: "a", assignmentId: "a2", title: "A", status: "completed", revision: 2), depth: 0, quiet: false)
        XCTAssertEqual(Set([running, updated, finished, next].compactMap(\.detailsKey)).count, 4)
        XCTAssertEqual(AgentsRoster.agentRow(SubagentRow(id: "a", assignmentId: "a1", title: "A", status: "running", revision: 1), depth: 0, quiet: false).detailsKey,
                       running.detailsKey)
    }

    func testTheSheetReadsAgainWhenADelegatedThreadsLastMonitorEnds() throws {
        let owner = try thread("owner")
        let watching = try thread("claude", #", "delegatedBy":"owner", "monitoring":[{"id":"00000000-0000-4000-8000-000000000009","label":"Watch CI"}]"#)
        let ended = try thread("claude", #", "delegatedBy":"owner", "monitoring":[]"#)
        let gone = try thread("claude", #", "delegatedBy":"owner""#)
        XCTAssertEqual(watching.monitoring, MonitorCount(1))
        XCTAssertEqual(ended.monitoring, MonitorCount(0))
        XCTAssertNil(gone.monitoring)
        XCTAssertEqual(try thread("odd", #", "monitoring":"one""#).monitoring, MonitorCount(0), "A record of another shape never fails its thread")
        // Idle, asking nothing, with no background work or agents: only the monitor moves its outcome to Answered.
        XCTAssertNotEqual(AgentsRoster.refreshSignal(owner, in: [owner, watching]), AgentsRoster.refreshSignal(owner, in: [owner, gone]))
        XCTAssertEqual(AgentsRoster.refreshSignal(owner, in: [owner, ended]), AgentsRoster.refreshSignal(owner, in: [owner, gone]))
        let background = try thread("claude", #", "delegatedBy":"owner", "backgroundWork":[{"type":"subagent"}]"#)
        let agents = try thread("claude", #", "delegatedBy":"owner", "subagentSummary":{"total":1,"working":1}"#)
        XCTAssertNotEqual(AgentsRoster.refreshSignal(owner, in: [owner, background]), AgentsRoster.refreshSignal(owner, in: [owner, gone]))
        XCTAssertNotEqual(AgentsRoster.refreshSignal(owner, in: [owner, agents]), AgentsRoster.refreshSignal(owner, in: [owner, gone]))
    }

    func testNestedAgentsKeepEveryRowOnceWhateverTheirParents() {
        let rows = [SubagentRow(id: "a", title: "A", status: "running"), SubagentRow(id: "b", parentId: "a", title: "B", status: "running"),
                    SubagentRow(id: "c", parentId: "missing", title: "C", status: "running"), SubagentRow(id: "d", parentId: "e", title: "D", status: "running"),
                    SubagentRow(id: "e", parentId: "d", title: "E", status: "running")]
        let nested = AgentsRoster.nested(rows)
        XCTAssertEqual(nested.map(\.row.id), ["a", "b", "c", "d", "e"])
        XCTAssertEqual(nested.map(\.depth), [0, 1, 0, 0, 1])
    }

    func testAgentsUnderOneParentShowNewestFirstWithEachFamilyTogether() throws {
        // The computer sends them oldest first, by sequence.
        let rows = [
            SubagentRow(id: "flow", sequence: 1, title: "Check the drawer", status: "running", startedAt: at(10), kind: "workflow"),
            SubagentRow(id: "older", parentId: "flow", sequence: 2, title: "Read the tests", status: "completed", startedAt: at(9)),
            SubagentRow(id: "helper", parentId: "older", sequence: 3, title: "Count the files", status: "completed", startedAt: at(8.5)),
            SubagentRow(id: "newer", parentId: "flow", sequence: 4, title: "Read the docs", status: "running", startedAt: at(8)),
            SubagentRow(id: "seen", parentId: "flow", sequence: 5, title: "Check the links", status: "unknown", lastObservedAt: at(7)),
            SubagentRow(id: "solo", sequence: 6, title: "Run the suite", status: "running", startedAt: at(2)),
        ]
        let nested = AgentsRoster.nested(rows)
        // An agent whose start was not reported goes by when it was last seen; the older agent keeps its own under it.
        XCTAssertEqual(nested.map(\.row.id), ["solo", "flow", "seen", "newer", "older", "helper"])
        XCTAssertEqual(nested.map(\.depth), [0, 0, 1, 1, 1, 2])
        let sheet = AgentsRoster.rows(owner: try thread("owner"), threads: [], delegations: nil, agents: rows)
        XCTAssertEqual(sheet.map(\.id), ["agent:solo", "agent:flow", "agent:seen", "agent:newer", "agent:older", "agent:helper"])
        XCTAssertEqual(sheet.map(\.level), [1, 1, 2, 2, 2, 3])
    }

    func testWordsMatchTheDesktop() {
        XCTAssertEqual(AgentsRoster.workTitle("ui"), "UI work")
        XCTAssertNil(AgentsRoster.workTitle(nil))
        XCTAssertEqual(AgentsRoster.outcomeWord("background"), "Background work")
        XCTAssertEqual(AgentsRoster.agentWord("unknown"), "Last seen working")
        XCTAssertEqual(AgentNames.known("claude"), "Claude Code")
        XCTAssertNil(AgentNames.known("someone-new"))
    }
}
