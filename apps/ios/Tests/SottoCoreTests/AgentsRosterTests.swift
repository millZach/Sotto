import XCTest
@testable import SottoCore

/// The Agents view (ADR-0101): what a thread's top bar counts and how its sheet orders and words its delegated threads
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
        // A delegated thread whose own delegated thread is settled waits on nothing.
        let settled = try thread("settled", #", "delegatedBy":"docs", "settledAt":"2026-10-20""#, requests: permission)
        let threads = [owner, review, docs, nested, elsewhere, settled]
        XCTAssertEqual(AgentsRoster.count(owner, in: threads), AgentsCount(total: 6, needs: 2))
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

    func testNestedAgentsKeepEveryRowOnceWhateverTheirParents() {
        let rows = [SubagentRow(id: "a", title: "A", status: "running"), SubagentRow(id: "b", parentId: "a", title: "B", status: "running"),
                    SubagentRow(id: "c", parentId: "missing", title: "C", status: "running"), SubagentRow(id: "d", parentId: "e", title: "D", status: "running"),
                    SubagentRow(id: "e", parentId: "d", title: "E", status: "running")]
        let nested = AgentsRoster.nested(rows)
        XCTAssertEqual(nested.map(\.row.id), ["a", "b", "c", "d", "e"])
        XCTAssertEqual(nested.map(\.depth), [0, 1, 0, 0, 1])
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
