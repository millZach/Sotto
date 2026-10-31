import XCTest
@testable import SottoCore

/// A running thread's chips in its reply box (ADR-0166): what they show, what a press sends, when they are held still,
/// and what a press shows until its agent answers, as the desktop's option chips do.
final class ThreadSettingsTests: XCTestCase {
    private let caps = #""capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true,"configureThread":true}"#
    private let sol = #"{"id":"sol","name":"GPT-6.1 Sol","provider":"Codex","providerId":"codex","ready":true,"reasoningEfforts":["low","medium","high","xhigh"],"defaultReasoningEffort":"high","runtimeModes":["approval-required","auto-accept-edits","full-access"],"speeds":[{"id":"fast","name":"Fast","description":"Uses more of your plan"},{"id":"ultrafast","name":"Ultra fast"},{"id":"hyper","name":"Not yet known"}]}"#
    private let astra = #"{"id":"astra","name":"GPT-6 Astra","provider":"Codex","providerId":"codex","ready":true,"reasoningEfforts":["low","medium"],"defaultReasoningEffort":"medium","runtimeModes":["approval-required","full-access"],"fastMode":{}}"#
    private let luna = #"{"id":"luna","name":"GPT-6.1 Luna","provider":"Codex","providerId":"codex","ready":false}"#
    private let opus = #"{"id":"opus","name":"Opus 5.5","provider":"Claude Code","providerId":"claude","ready":true}"#

    /// A computer's shell with one Codex thread on Sol, as JSON a computer would send.
    private func shell(thread: String = #""status":"idle","runtimeMode":"approval-required""#, extra: String = "", models: String? = nil, modelID: String = "sol", requests: String = "[]") throws -> Shell {
        let json = #"{"hostId":"h","host":{"hostId":"h","name":"Laptop","threads":[{"id":"t","projectId":"p","title":"Thread","providerId":"codex","requests":\#(requests),"modelId":"\#(modelID)",\#(thread)}],"projects":[],"models":[\#(models ?? [sol, astra, luna, opus].joined(separator: ","))],\#(caps)}\#(extra)}"#
        return try JSONDecoder().decode(Shell.self, from: Data(json.utf8))
    }
    /// The chips for the shell's one thread, as the reply box would draw them.
    private func panel(_ shell: Shell, pending: PendingThreadSettings = PendingThreadSettings(), mayAnswer: Bool = true,
                       online: Bool = true, promptOnItsWay: Bool = false) -> ThreadSettingsPanel? {
        ThreadSettingsPanel.make(thread: shell.host.threads[0], catalog: shell.host.models ?? [], capabilities: shell.host.capabilities,
                                 providerConnected: true, online: online, mayAnswer: mayAnswer,
                                 unconfirmed: ThreadSettings.unconfirmed(shell, threadID: "t"), promptOnItsWay: promptOnItsWay, pending: pending)
    }

    func testTheChipsReadTheThreadAndTheDefaultsAreItsModels() throws {
        let value = try XCTUnwrap(panel(shell(thread: #""status":"idle","runtimeMode":"auto-accept-edits","speed":"ultrafast""#)))
        XCTAssertEqual(value.model?.name, "GPT-6.1 Sol")
        XCTAssertEqual(value.effort, "high", "With no effort of its own the thread is on its model's default")
        XCTAssertEqual(value.efforts, ["low", "medium", "high", "xhigh"])
        XCTAssertEqual(value.permission, "auto-accept-edits")
        XCTAssertTrue(value.permissionGrants)
        XCTAssertEqual(value.speed, "ultrafast")
        XCTAssertEqual(value.speeds.map(\.id), ["fast", "ultrafast"], "A speed this build doesn't know is left out")
        XCTAssertEqual(value.models.map(\.id), ["sol", "astra"], "Only the thread's own provider's ready models")
        XCTAssertNil(value.fixed)
    }
    func testAnOlderComputersChipsStayOffTheBox() throws {
        let older = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","host":{"hostId":"h","name":"Laptop","threads":[{"id":"t","projectId":"p","title":"Thread","providerId":"codex","status":"idle","requests":[],"modelId":"sol"}],"projects":[],"models":[\#(sol)],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}}"#.utf8))
        XCTAssertNil(panel(older), "A computer that doesn't say it changes a thread's settings in place gets no chips")
        XCTAssertNil(panel(try shell(thread: #""status":"idle""#, models: astra)), "Nor does a thread whose model its catalog doesn't know")
    }
    func testSpeedIsTheThreadsChoiceAndRunsAtStandardWhereTheModelLacksIt() throws {
        XCTAssertEqual(ThreadSettings.speed(of: try shell(thread: #""status":"idle","fastMode":true"#).host.threads[0]), "fast", "The older fastMode is Fast")
        XCTAssertEqual(ThreadSettings.speed(of: try shell(thread: #""status":"idle","speed":null,"fastMode":false"#).host.threads[0]), "standard")
        let onAstra = try XCTUnwrap(panel(shell(thread: #""status":"idle","speed":"ultrafast""#, modelID: "astra")))
        XCTAssertEqual(onAstra.speed, "standard", "Astra has no Ultra fast, so the thread runs at Standard there")
        XCTAssertEqual(onAstra.speeds.map(\.name), ["Fast"], "An older catalog's fastMode offers Fast")
        XCTAssertTrue(ThreadSettings.offeredSpeeds(try JSONDecoder().decode(ThreadModel.self, from: Data(#"{"id":"g","name":"Grok","provider":"Grok","providerId":"grok","ready":true,"fastMode":{}}"#.utf8)), providerID: "grok").isEmpty,
                      "Only Claude Code and Codex offer a speed")
    }
    func testTheBoltStepsThroughTheSpeedsAndBackToStandard() {
        let offered = [ModelSpeed(id: "fast", name: "Fast"), ModelSpeed(id: "ultrafast", name: "Ultra fast")]
        XCTAssertEqual(ThreadSettings.nextSpeed(offered, after: "standard"), "fast")
        XCTAssertEqual(ThreadSettings.nextSpeed(offered, after: "fast"), "ultrafast")
        XCTAssertEqual(ThreadSettings.nextSpeed(offered, after: "ultrafast"), "standard")
        XCTAssertEqual(ThreadSettings.speedCost(ModelSpeed(id: "fast", name: "Fast", description: "Uses more of your plan"), providerID: "codex"),
                       "Uses more of your plan.", "The provider's own line, ended as a sentence")
        XCTAssertEqual(ThreadSettings.speedCost(ModelSpeed(id: "fast", name: "Fast"), providerID: "claude"), "Up to 2.5x faster output, at twice the price per token.")
    }
    func testEachPressSendsTheDesktopsOwnFields() throws {
        let models = try shell().host.models ?? []
        let sol = models[0], astra = models[1]
        XCTAssertEqual(ThreadSettings.patch(.model, value: "astra", model: sol), ["modelId": .string("astra")])
        XCTAssertEqual(ThreadSettings.patch(.effort, value: "xhigh", model: sol), ["reasoningEffort": .string("xhigh")])
        XCTAssertEqual(ThreadSettings.patch(.permissions, value: "full-access", model: sol), ["runtimeMode": .string("full-access")])
        XCTAssertEqual(ThreadSettings.patch(.speed, value: "standard", model: sol), ["speed": .null], "Standard is a null speed")
        XCTAssertEqual(ThreadSettings.patch(.speed, value: "fast", model: astra), ["fastMode": .bool(true)], "An older catalog takes fastMode")
        let own = try JSONDecoder().decode(ThreadModel.self, from: Data(#"{"id":"d","name":"Devin","provider":"Devin","providerId":"devin","ready":true,"providerModes":[{"id":"safe","name":"Safe","allows":"nothing"}]}"#.utf8))
        XCTAssertEqual(ThreadSettings.patch(.permissions, value: "safe", model: own), ["providerMode": .string("safe")])

        let command = try Commands.configureThread(threadID: "t", patch: ["speed": .null])
        XCTAssertEqual(command["type"], .string("configure-thread"))
        XCTAssertEqual(command["threadId"], .string("t"))
        XCTAssertEqual(command["speed"], .null)
        XCTAssertThrowsError(try Commands.configureThread(threadID: "t", patch: [:]), "A change names something to change")
        XCTAssertThrowsError(try Commands.configureThread(threadID: "t", patch: ["runtimeMode": .string("anything-goes")]))
        XCTAssertThrowsError(try Commands.configureThread(threadID: "t", patch: ["speed": .string("hyper")]))
        XCTAssertThrowsError(try Commands.configureThread(threadID: "t", patch: ["title": .string("Renamed")]), "Only the computer's allow-listed fields")
        XCTAssertThrowsError(try Commands.configureThread(threadID: "t", patch: ["reasoningEffort": .string(String(repeating: "x", count: 65))]))
    }
    func testTheChipsHoldStillWhileTheAgentWouldRefuseAChange() throws {
        XCTAssertEqual(panel(try shell(thread: #""status":"running""#))?.fixed, .working)
        XCTAssertEqual(panel(try shell(requests: #"[{"id":"q","kind":"question","text":"Which?","options":[]}]"#))?.fixed, .waiting)
        XCTAssertEqual(panel(try shell(thread: #""status":"idle","archivedAt":"2026-10-30T10:00:00.000Z""#))?.fixed, .archived)
        XCTAssertEqual(panel(try shell(), online: false)?.fixed, .away)
        let unconfirmed = try shell(extra: #","unconfirmedSettings":[{"threadId":"t","runtimeMode":"full-access"},{"threadId":"other","modelId":"x"}]"#)
        XCTAssertEqual(ThreadSettings.unconfirmed(unconfirmed, threadID: "t"), [.permissions])
        XCTAssertEqual(panel(unconfirmed)?.fixed, .unconfirmed, "A permission change with no result holds the thread")
        let speedOnly = try shell(extra: #","unconfirmedSettings":[{"threadId":"t","speed":null}]"#)
        XCTAssertEqual(ThreadSettings.unconfirmed(speedOnly, threadID: "t"), [.speed], "A null speed still names the speed")
        XCTAssertNil(panel(speedOnly)?.fixed, "A speed with no result holds nothing back")
    }
    func testAPhoneThatCantAnswerCanOnlyKeepTheThreadAsking() throws {
        let value = try XCTUnwrap(panel(shell(), mayAnswer: false))
        XCTAssertTrue(value.mayChoose(try XCTUnwrap(value.permissions.first { $0.id == "approval-required" })))
        XCTAssertFalse(value.mayChoose(try XCTUnwrap(value.permissions.first { $0.id == "full-access" })))
    }
    func testAPressShowsAtOnceAndAPressMadeMeanwhileWaitsForTheFirstAnswer() throws {
        let start = try shell()
        let drawn = try XCTUnwrap(panel(start)).drawn
        var pending = PendingThreadSettings()
        XCTAssertNil(pending.press(.effort, value: "high", patch: [:], showing: "high", drawn: drawn), "Pressing what the chip already shows sends nothing")
        let first = try XCTUnwrap(pending.press(.effort, value: "low", patch: ["reasoningEffort": .string("low")], showing: "high", drawn: drawn))
        XCTAssertEqual(first.value, "low")
        XCTAssertEqual(panel(start, pending: pending)?.effort, "low", "The chip shows the press at once")
        XCTAssertNil(pending.press(.effort, value: "medium", patch: ["reasoningEffort": .string("medium")], showing: "high", drawn: drawn),
                     "A second press waits for the first answer")
        let next = try XCTUnwrap(pending.answered(.effort, sent: "low", outcome: .confirmed(expected: "low")))
        XCTAssertEqual(next.value, "medium", "Only the newest press goes once the first answers")
        XCTAssertNil(pending.answered(.effort, sent: "medium", outcome: .confirmed(expected: "medium")))
        XCTAssertEqual(pending.value(.effort), "medium", "Held until the thread shows it")
        pending.observe(ThreadSettingValues(model: "sol", effort: "medium", permissions: "", speed: "standard"), unconfirmed: [])
        XCTAssertTrue(pending.isEmpty, "Let go once the thread shows what the computer answered with")
    }
    func testAConfirmedPressTheThreadNeverShowsIsLetGoAfterItsHold() throws {
        let drawn = try XCTUnwrap(panel(shell())).drawn
        var pending = PendingThreadSettings()
        _ = pending.press(.model, value: "astra", patch: ["modelId": .string("astra")], showing: "sol", drawn: drawn)
        _ = pending.answered(.model, sent: "astra", outcome: .confirmed(expected: "astra"))
        let hold = try XCTUnwrap(pending.holdToken(.model))
        pending.expire(.model, hold: hold - 1)
        XCTAssertEqual(pending.value(.model), "astra", "An older hold lets go of nothing")
        pending.expire(.model, hold: hold)
        XCTAssertTrue(pending.isEmpty)
    }
    func testARefusalPutsTheChipBackAndSaysWhyWithTryAgain() throws {
        let start = try shell()
        let drawn = try XCTUnwrap(panel(start)).drawn
        var pending = PendingThreadSettings()
        _ = pending.press(.permissions, value: "full-access", patch: ["runtimeMode": .string("full-access")], showing: "approval-required", drawn: drawn)
        let waiting = try XCTUnwrap(panel(start, pending: pending))
        XCTAssertTrue(waiting.permissionPending)
        XCTAssertEqual(waiting.caption, "Codex still asks before acting until it confirms.", "What is still in force, in the agent's name")
        _ = pending.answered(.permissions, sent: "full-access", outcome: .refused(ThreadSettingWords.providerRejected))
        let refused = try XCTUnwrap(panel(start, pending: pending))
        XCTAssertEqual(refused.permission, "approval-required", "The chip goes back to what is in force")
        XCTAssertNil(refused.caption)
        XCTAssertEqual(refused.notices, [ThreadSettingsPanel.Notice(kind: .permissions,
            text: "Codex didn’t switch to Full access. The thread stays on Ask before actions; nothing else changed.", retry: true)])
        let again = try XCTUnwrap(pending.retry(.permissions, drawn: drawn))
        XCTAssertEqual(again.value, "full-access", "Try again sends the same choice")
        XCTAssertTrue(pending.refusals.isEmpty)
        _ = pending.answered(.permissions, sent: "full-access", outcome: .refused(nil))
        XCTAssertEqual(panel(start, pending: pending)?.notices.first?.text,
                       "Sotto didn’t get Codex’s answer about Full access, so this shows what the thread last reported.")
    }
    func testAChangeWithNoResultKeepsItsChoiceUntilTheThreadShowsIt() throws {
        let start = try shell()
        let drawn = try XCTUnwrap(panel(start)).drawn
        var pending = PendingThreadSettings()
        _ = pending.press(.effort, value: "xhigh", patch: ["reasoningEffort": .string("xhigh")], showing: "high", drawn: drawn)
        _ = pending.answered(.effort, sent: "xhigh", outcome: .unconfirmed(ThreadSettingWords.providerUnconfirmed))
        let value = try XCTUnwrap(panel(start, pending: pending))
        XCTAssertEqual(value.effort, "xhigh")
        XCTAssertEqual(value.notices.first?.text, "Codex hasn’t confirmed Extra high effort. Until it does, a turn can still run on High effort.")
        XCTAssertEqual(value.notices.first?.retry, false, "Nothing to press: the computer keeps the change")
        pending.observe(drawn, unconfirmed: [.effort])
        XCTAssertEqual(pending.value(.effort), "xhigh", "Still kept while the computer keeps it")
        pending.observe(drawn, unconfirmed: [])
        XCTAssertTrue(pending.isEmpty, "Let go once the computer, having kept it, no longer does")
    }
    func testWhatBecameOfAChangeIsReadFromTheThreadTheComputerAnswersWith() throws {
        XCTAssertEqual(PendingThreadSettings.outcome(of: try shell(thread: #""status":"idle","reasoningEffort":"low""#, extra: #","error":"An older failure""#),
                                                     .effort, sent: "low", threadID: "t"), .confirmed(expected: "low"),
                       "The thread showing the choice is the change taken, whatever the shared error says")
        XCTAssertEqual(PendingThreadSettings.outcome(of: try shell(extra: #","error":"Refused""#), .effort, sent: "low", threadID: "t"), .refused("Refused"))
        XCTAssertEqual(PendingThreadSettings.outcome(of: try shell(extra: #","error":"Lost","unconfirmedSettings":[{"threadId":"t","reasoningEffort":"low"}]"#),
                                                     .effort, sent: "low", threadID: "t"), .unconfirmed("Lost"))
        XCTAssertEqual(PendingThreadSettings.outcome(of: try shell(), .effort, sent: "low", threadID: "t"), .confirmed(expected: "high"),
                       "No error and another value: something newer moved it, and the chip shows it once the thread does")
    }
    func testAModelChangeShowsTheNewModelsDefaultEffortMeanwhile() throws {
        let start = try shell()
        let drawn = try XCTUnwrap(panel(start)).drawn
        var pending = PendingThreadSettings()
        _ = pending.press(.model, value: "astra", patch: ["modelId": .string("astra")], showing: "sol", drawn: drawn)
        let value = try XCTUnwrap(panel(start, pending: pending))
        XCTAssertEqual(value.model?.name, "GPT-6 Astra")
        XCTAssertEqual(value.efforts, ["low", "medium"])
        XCTAssertEqual(value.effort, "medium")
        XCTAssertEqual(value.unpressed.effort, "medium", "An effort press is measured against the new model's default")
    }
    func testAPromptOnItsWayHoldsTheChipsUntilItHasGone() throws {
        let sending = try shell(extra: #","deliveries":[{"threadId":"t","draftId":"d","status":"submitting"}]"#)
        XCTAssertTrue(ThreadSettings.promptOnItsWay(sending, threadID: "t"))
        XCTAssertEqual(panel(sending, promptOnItsWay: true)?.fixed, .working, "A change would run behind the turn the prompt starts")
        let setAside = try shell(extra: #","deliveries":[{"threadId":"t","draftId":"d","status":"uncertain","setAside":true},{"threadId":"t","draftId":"e","status":"delivered"}]"#)
        XCTAssertFalse(ThreadSettings.promptOnItsWay(setAside, threadID: "t"), "One set aside, or already delivered, waits on nothing")
    }
    func testPressingTheLongContextModelsBaseLeavesTheThreadWhereItIs() throws {
        let catalog = try shell().host.models ?? []
        let opus = try JSONDecoder().decode(ThreadModel.self, from: Data(#"{"id":"native:claude:model:opus","name":"Opus","provider":"Claude Code","providerId":"claude","ready":true}"#.utf8))
        let onVariant = try shell(thread: #""status":"idle""#, models: #"{"id":"native:claude:model:opus","name":"Opus","provider":"Claude Code","providerId":"claude","ready":true}"#,
                                  modelID: "native:claude:model:opus%5B1m%5D").host.threads[0]
        XCTAssertEqual(ThreadSettings.modelChoice("native:claude:model:opus", thread: onVariant, catalog: [opus]), "native:claude:model:opus%5B1m%5D")
        XCTAssertEqual(ThreadSettings.modelChoice("astra", thread: try shell().host.threads[0], catalog: catalog), "astra")
    }
    func testAThreadThatNamesNoProviderListsItsModelsProvider() throws {
        let unnamed = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","host":{"hostId":"h","name":"Laptop","threads":[{"id":"t","projectId":"p","title":"Thread","status":"idle","requests":[],"modelId":"sol"}],"projects":[],"models":[\#([sol, astra, opus].joined(separator: ","))],\#(caps)}}"#.utf8))
        XCTAssertEqual(ThreadSettings.models(for: unnamed.host.threads[0], in: unnamed.host.models ?? []).map(\.id), ["sol", "astra"])
    }
    func testTryAgainOnAGrantNeedsThePhoneToStillAnswer() throws {
        let value = try XCTUnwrap(panel(shell(), mayAnswer: false))
        XCTAssertFalse(value.canRetry(.permissions, wanted: "full-access"))
        XCTAssertTrue(value.canRetry(.permissions, wanted: "approval-required"))
        XCTAssertTrue(value.canRetry(.effort, wanted: "low"))
    }
    func testAModelChangeThatDroppedTheSpeedSaysSo() throws {
        let start = try shell()
        var pending = PendingThreadSettings()
        pending.refuse(.speed, wanted: "fast", patch: ["speed": .string("fast")], error: ThreadSettingWords.speedNotCarriedError)
        XCTAssertEqual(panel(start, pending: pending)?.notices.first?.text, "Codex didn’t switch to Fast. The thread is on GPT-6.1 Sol at Standard speed.")
    }
    func testEffortLevelsReadAsTheDesktopSaysThem() {
        XCTAssertEqual(EffortWords.name("xhigh"), "Extra high")
        XCTAssertEqual(EffortWords.name("ultracode"), "Ultracode")
        XCTAssertEqual(EffortWords.name("turbo"), "Turbo", "A level Sotto has no name for is the provider's, capitalised")
        XCTAssertEqual(EffortWords.line("max", index: 3, count: 4), "Everything the model has. Slowest, costliest.", "The top of the list gets the top line")
        XCTAssertEqual(EffortWords.line("high", index: 2, count: 4), "Takes longer and catches more.")
    }
}

