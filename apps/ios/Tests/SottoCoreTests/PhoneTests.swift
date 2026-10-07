import XCTest
@testable import SottoCore

final class PhoneTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T { try JSONDecoder().decode(type, from: Data(text.utf8)) }
    private func thread(_ id: String, project: String = "p", status: String = "idle", requests: String = "[]", summary: String? = nil) throws -> ThreadSummary {
        let stamp = summary.map { #","summary":{"lastMessageAt":"\#($0)"}"# } ?? ""
        return try decode(ThreadSummary.self, #"{"id":"\#(id)","projectId":"\#(project)","title":"\#(id)","status":"\#(status)","requests":\#(requests)\#(stamp)}"#)
    }

    // MARK: Finding the host

    func testMachineNameAndFullAddressAreBothAccepted() throws {
        XCTAssertEqual(try HostFinder.read(" Forge "), .name("forge"))
        XCTAssertEqual(try HostFinder.read("forge.tail5c2e.ts.net"), .fullName("forge.tail5c2e.ts.net"))
        XCTAssertEqual(try HostFinder.read("forge.tail5c2e.ts.net."), .fullName("forge.tail5c2e.ts.net"))
        XCTAssertEqual(try HostFinder.read("https://forge.tail5c2e.ts.net"), .fullName("forge.tail5c2e.ts.net"))
        XCTAssertEqual(try HostFinder.read("forge.tail5c2e.ts.net:443"), .address(try HostEndpoint("https://forge.tail5c2e.ts.net")))
        XCTAssertEqual(try HostFinder.read("https://forge.tail5c2e.ts.net:8443"), .address(try HostEndpoint("https://forge.tail5c2e.ts.net:8443")))
        XCTAssertEqual(try HostFinder.read("forge.tail5c2e.ts.net:10000"), .address(try HostEndpoint("https://forge.tail5c2e.ts.net:10000")))
        for typed in ["", "forge.example.com", "http://forge.tail5c2e.ts.net", "-forge", "for ge", "forge_1", "https://forge.tail5c2e.ts.net/path", "forge.tail5c2e.ts.net:8080", "forge:8443"] {
            XCTAssertThrowsError(try HostFinder.read(typed), typed)
        }
    }
    func testOnlyThisMachinesTailnetNameIsUsed() {
        XCTAssertEqual(HostFinder.fullName(machine: "forge", resolvedName: "forge.tail5c2e.ts.net."), "forge.tail5c2e.ts.net")
        XCTAssertEqual(HostFinder.fullName(machine: "forge", resolvedName: "FORGE.tail5c2e.ts.net"), "forge.tail5c2e.ts.net")
        XCTAssertNil(HostFinder.fullName(machine: "forge", resolvedName: "forge.example.com"))
        XCTAssertNil(HostFinder.fullName(machine: "forge", resolvedName: "other.tail5c2e.ts.net"))
        XCTAssertNil(HostFinder.fullName(machine: "forge", resolvedName: "forge"))
    }
    func testTheSearchOrderIsPhoneAccessPortsThen443() {
        XCTAssertEqual(HostFinder.ports, [8443, 10000, 443])
        XCTAssertEqual(HostEndpoint.ports, [443, 8443, 10000])
    }
    func testANameIsTriedOn8443Then10000ThenOn443() async throws {
        let found = try await HostFinder.candidates("forge") { _ in ["forge", "100.101.102.103", "forge.tail5c2e.ts.net"] }
        XCTAssertEqual(found.map(\.url.absoluteString), ["https://forge.tail5c2e.ts.net:8443", "https://forge.tail5c2e.ts.net:10000", "https://forge.tail5c2e.ts.net"])
        do { _ = try await HostFinder.candidates("forge") { _ in ["forge.lan"] }; XCTFail("A name off the tailnet must not be used") }
        catch { XCTAssertEqual(error as? ClientError, .hostNotFound("forge")) }
        let full = try await HostFinder.candidates("forge.tail5c2e.ts.net") { _ in XCTFail("A full address needs no lookup"); return [] }
        XCTAssertEqual(full.map(\.port), [8443, 10000, 443])
        let typed = try await HostFinder.candidates("https://forge.tail5c2e.ts.net:443") { _ in XCTFail("A typed port needs no lookup"); return [] }
        XCTAssertEqual(typed.map(\.port), [443])
    }
    func testTheFirstAddressWhereSottoAnswersIsKept() async throws {
        let candidates = HostFinder.endpoints(fullName: "forge.tail5c2e.ts.net")
        var asked: [Int] = []
        let desktop = try await HostFinder.probe(candidates) { endpoint -> Int in asked.append(endpoint.port); return endpoint.port }
        XCTAssertEqual(desktop.endpoint.port, 8443); XCTAssertEqual(asked, [8443])
        // Another app on 8443, so phone access fell back to 10000.
        asked = []
        let fallback = try await HostFinder.probe(candidates) { endpoint -> Int in
            asked.append(endpoint.port)
            if endpoint.port == 8443 { throw ClientError.notASottoHost("forge") }
            return endpoint.port
        }
        XCTAssertEqual(fallback.endpoint.port, 10000); XCTAssertEqual(asked, [8443, 10000])
        let byHand = try await HostFinder.probe(candidates) { endpoint -> Int in
            if endpoint.port != 443 { throw ClientError.hostUnreachable("forge") }
            return endpoint.port
        }
        XCTAssertEqual(byHand.endpoint.port, 443)
    }
    func testWhenNoAddressAnswersTheMostTellingErrorIsKept() async {
        let candidates = HostFinder.endpoints(fullName: "forge.tail5c2e.ts.net")
        do {
            _ = try await HostFinder.probe(candidates) { endpoint -> Int in
                throw endpoint.port == 8443 ? ClientError.hostUnreachable("forge") : ClientError.notASottoHost("forge")
            }
            XCTFail("Nothing answered")
        } catch { XCTAssertEqual(error as? ClientError, .notASottoHost("forge")) }
        do {
            _ = try await HostFinder.probe(candidates) { endpoint -> Int in
                throw endpoint.port == 8443 ? ClientError.notASottoHost("forge") : ClientError.hostUnreachable("forge")
            }
            XCTFail("Nothing answered")
        } catch { XCTAssertEqual(error as? ClientError, .notASottoHost("forge")) }
    }
    func testASottoThatAnswersOn8443StopsTheSearch() async {
        let candidates = HostFinder.endpoints(fullName: "forge.tail5c2e.ts.net")
        let starting = ClientError.rejected("Sotto on that computer is still starting. Try again in a moment.")
        for refusal in [ClientError.invalidProtocol, .invalidIdentity, starting] {
            var asked: [Int] = []
            do {
                _ = try await HostFinder.probe(candidates) { endpoint -> Int in
                    asked.append(endpoint.port)
                    if endpoint.port == 8443 { throw refusal }
                    return endpoint.port
                }
                XCTFail("Sotto answered on 8443, so no other port may be used")
            } catch { XCTAssertEqual(error as? ClientError, refusal) }
            XCTAssertEqual(asked, [8443])
        }
    }
    func testASavedComputerIsLookedForOnItsOtherPhoneAccessPortOnly() async throws {
        XCTAssertEqual(HostFinder.phoneAccessPorts, [8443, 10000])
        let misses: [ClientError] = [.hostUnreachable("forge"), .notASottoHost("forge"), .sottoNotRunning("forge")]
        for miss in misses {
            for (saved, other) in [(8443, 10000), (10000, 8443)] {
                var asked: [Int] = []
                let hit = try await HostFinder.reconnect(try HostEndpoint("https://forge.tail5c2e.ts.net:\(saved)")) { endpoint -> Int in
                    asked.append(endpoint.port)
                    if endpoint.port == saved { throw miss }
                    return endpoint.port
                }
                XCTAssertEqual(hit.endpoint.port, other); XCTAssertEqual(asked, [saved, other])
            }
        }
        // Another Sotto at the saved address ends it there, and so does an address that is not phone access.
        let ends: [(String, ClientError)] = [("https://forge.tail5c2e.ts.net:8443", .invalidIdentity), ("https://forge.tail5c2e.ts.net", .hostUnreachable("forge"))]
        for (address, refusal) in ends {
            var asked: [Int] = []
            do {
                _ = try await HostFinder.reconnect(try HostEndpoint(address)) { endpoint -> Int in asked.append(endpoint.port); throw refusal }
                XCTFail("Nothing may be used")
            } catch { XCTAssertEqual(error as? ClientError, refusal) }
            XCTAssertEqual(asked.count, 1, address)
        }
        // When the other port fails too, for any reason, the saved address's error is said.
        do {
            _ = try await HostFinder.reconnect(try HostEndpoint("https://forge.tail5c2e.ts.net:8443")) { endpoint -> Int in
                throw endpoint.port == 8443 ? ClientError.notASottoHost("forge") : ClientError.invalidIdentity
            }
            XCTFail("Nothing answered")
        } catch { XCTAssertEqual(error as? ClientError, .notASottoHost("forge")) }
    }
    func testOnlyTailscaleAddressesAreTrusted() {
        XCTAssertTrue(HostFinder.isTailnetAddress([100, 101, 102, 103]))
        XCTAssertTrue(HostFinder.isTailnetAddress([100, 127, 255, 1]))
        XCTAssertFalse(HostFinder.isTailnetAddress([100, 128, 0, 1]))
        XCTAssertFalse(HostFinder.isTailnetAddress([192, 168, 1, 20]))
        XCTAssertTrue(HostFinder.isTailnetAddress([0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0] + Array(repeating: 1, count: 10)))
        XCTAssertFalse(HostFinder.isTailnetAddress([0xfd, 0x00] + Array(repeating: 0, count: 14)))
    }
    func testHealthMustBeAReadyVersionOneHost() throws {
        let ready = try decode(Health.self, #"{"v":1,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001","pid":7,"port":4455,"sottoVersion":"0.1.19","features":["detail-delta"]}"#)
        XCTAssertNoThrow(try ready.validate())
        XCTAssertThrowsError(try decode(Health.self, #"{"v":2,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001"}"#).validate())
        XCTAssertThrowsError(try decode(Health.self, #"{"v":1,"status":"ready","hostId":"not-a-host"}"#).validate())
    }
    func testHealthNameIsOptionalAndReadsAsOneLine() throws {
        let desktop = try decode(Health.self, #"{"v":1,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001","name":"  Zach’s\nLaptop  "}"#)
        XCTAssertNoThrow(try desktop.validate())
        XCTAssertEqual(desktop.computerName, "Zach’s Laptop")
        let older = try decode(Health.self, #"{"v":1,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001"}"#)
        XCTAssertNil(older.name); XCTAssertNil(older.computerName)
        let blank = try decode(Health.self, #"{"v":1,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001","name":"   "}"#)
        XCTAssertNil(blank.computerName)
        XCTAssertEqual(ComputerName.cleaned(String(repeating: "a", count: 80))?.count, ComputerName.maximumLength)
    }

    // MARK: Pairing code

    func testPairingCodeIsCleanedToTheHostsAlphabet() throws {
        XCTAssertEqual(try PairingCode.normalized("k7q4-mx9z"), "K7Q4MX9Z")
        XCTAssertEqual(try PairingCode.normalized(" K7Q4 MX9Z "), "K7Q4MX9Z")
        XCTAssertEqual(PairingCode.cleaned("k7q4mx9zzz"), "K7Q4MX9Z")
        for typed in ["K7Q4MX9", "K7Q4MX9O", "K7Q4MX91", "K7Q4MX9Z!", "K7Q4MX9ZZ"] { XCTAssertThrowsError(try PairingCode.normalized(typed), typed) }
    }

    // MARK: Threads

    func testStateWordsPutWaitingRequestsFirst() throws {
        let permission = #"[{"id":"r","kind":"permission","text":"Run?","options":[]}]"#
        let question = #"[{"id":"r","kind":"question","text":"Which?","options":[]}]"#
        XCTAssertEqual(ThreadState(try thread("a", status: "running", requests: permission)), .needsAnswer)
        XCTAssertEqual(ThreadState(try thread("b", requests: question)), .asked)
        XCTAssertEqual(ThreadState(try thread("c", status: "running")), .working)
        XCTAssertEqual(ThreadState(try thread("d", status: "error")), .failed)
        XCTAssertEqual(ThreadState(try thread("e")).words, "Done")
    }
    func testThreadsFromEveryComputerMergeMostRecentFirst() throws {
        let laptop = ComputerThreads(hostID: "laptop", name: "Laptop", status: .online, threads: [
            try thread("a", summary: "2026-09-26T09:00:00.000Z"), try thread("b", status: "running", summary: "2026-09-26T09:30:00Z"),
        ], projects: try decode([Project].self, #"[{"id":"p","title":"Sotto"}]"#))
        let forge = ComputerThreads(hostID: "forge", name: "forge", status: .online, threads: [try thread("c", project: "q", summary: "2026-09-26T09:10:00.000Z")])
        let rows = ThreadGroups.merged([laptop, forge])
        XCTAssertEqual(rows.map(\.id), ["laptop/b", "forge/c", "laptop/a"])
        XCTAssertEqual(rows.map(\.computer), ["Laptop", "forge", "Laptop"])
        XCTAssertEqual(rows.first?.project, "Sotto"); XCTAssertNil(rows[1].project)
        XCTAssertEqual(ThreadGroups.merged([laptop, forge], filter: .working).map(\.id), ["laptop/b"])
        XCTAssertEqual(ThreadGroups.merged([laptop, forge], filter: .done).map(\.id), ["forge/c", "laptop/a"])
    }
    func testTheStripNarrowsToOneComputer() throws {
        let laptop = ComputerThreads(hostID: "laptop", name: "Laptop", status: .online, threads: [try thread("a")])
        let forge = ComputerThreads(hostID: "forge", name: "forge", status: .online, threads: [try thread("b")])
        XCTAssertEqual(ThreadGroups.merged([laptop, forge], show: .only("forge")).map(\.id), ["forge/b"])
        XCTAssertEqual(ThreadGroups.merged([laptop, forge], show: .all).count, 2)
        XCTAssertTrue(ComputerFilter.all.admits("anything")); XCTAssertFalse(ComputerFilter.only("laptop").admits("forge"))
    }
    func testTwoComputersWithTheSameThreadIDStayApart() throws {
        let question = #"[{"id":"r","kind":"question","text":"Which?","options":[]}]"#
        let laptop = ComputerThreads(hostID: "laptop", name: "Laptop", status: .online, threads: [try thread("same", requests: question)])
        let forge = ComputerThreads(hostID: "forge", name: "forge", status: .online, threads: [try thread("same", requests: question)])
        let rows = ThreadGroups.merged([laptop, forge])
        XCTAssertEqual(Set(rows.map(\.id)).count, 2)
        XCTAssertNotEqual(rows[0].ref, rows[1].ref)
        XCTAssertEqual(rows.map(\.ref.threadID), ["same", "same"])
        XCTAssertEqual(Set(ThreadGroups.waiting([laptop, forge]).map(\.id)), ["laptop/same/r", "forge/same/r"])
        XCTAssertEqual(ThreadRef(hostID: "laptop", threadID: "same"), ThreadRef(hostID: "laptop", threadID: "same"))
        XCTAssertNotEqual(ThreadRef(hostID: "laptop", threadID: "same"), ThreadRef(hostID: "forge", threadID: "same"))
    }
    func testAComputerThatCantBeReachedHidesNothingElse() throws {
        let permission = #"[{"id":"r","kind":"permission","text":"Run?","options":[]}]"#
        let laptop = ComputerThreads(hostID: "laptop", name: "Laptop", status: .online, threads: [try thread("a", requests: permission), try thread("b", status: "running")])
        let forge = ComputerThreads(hostID: "forge", name: "forge", status: .unreachable,
                                    threads: [try thread("c", status: "running", requests: permission, summary: "2026-09-26T10:00:00.000Z")])
        XCTAssertEqual(ThreadGroups.waiting([laptop, forge]).map(\.id), ["laptop/a/r"])
        XCTAssertEqual(ThreadGroups.working([laptop, forge]).map(\.id), ["laptop/b"])
        XCTAssertEqual(ThreadGroups.merged([laptop, forge]).map(\.id), ["laptop/a", "laptop/b", "forge/c"])
        XCTAssertEqual(ThreadGroups.unreachable([laptop, forge]).map(\.name), ["forge"])
        XCTAssertTrue(ThreadGroups.unreachable([laptop, forge], show: .only("laptop")).isEmpty)
        XCTAssertEqual(ComputerStatus.unreachable.words, "Can’t reach it")
    }
    func testWaitingListsEveryRequestAndWorkingLeavesThemOut() throws {
        let two = #"[{"id":"r1","kind":"question","text":"One?","options":[]},{"id":"r2","kind":"permission","text":"Two?","options":[]}]"#
        let laptop = ComputerThreads(hostID: "h", name: "Laptop", status: .online, threads: [try thread("a", status: "running", requests: two), try thread("b", status: "running")])
        XCTAssertEqual(ThreadGroups.waiting([laptop]).map(\.id), ["h/a/r1", "h/a/r2"])
        XCTAssertEqual(ThreadGroups.working([laptop]).map(\.id), ["h/b"])
    }

    // MARK: Saved computers

    private func pairing(_ n: Int) throws -> Pairing {
        try decode(Pairing.self, #"{"v":1,"hostId":"00000000-0000-4000-8000-00000000000\#(n)","clientId":"phone","token":"secret"}"#)
    }
    func testTheSinglePairingBecomesTheFirstComputer() throws {
        // The item an earlier build saved under `host`: address and pairing, no names.
        let legacy = try decode(SavedComputer.self, #"{"address":"https://forge.tail5c2e.ts.net","pairing":{"v":1,"hostId":"00000000-0000-4000-8000-000000000001","clientId":"phone","token":"secret"}}"#)
        XCTAssertNoThrow(try legacy.validate())
        XCTAssertEqual(legacy.name, "forge"); XCTAssertNil(legacy.reportedName)
        XCTAssertEqual(ComputerStore.plan(index: nil, legacy: legacy), ComputerStore.Plan(index: [legacy.hostID], adopt: legacy, removeLegacy: true))
        // Stopped after writing the index: the next launch only removes the old item.
        XCTAssertEqual(ComputerStore.plan(index: [legacy.hostID], legacy: legacy), ComputerStore.Plan(index: [legacy.hostID], adopt: nil, removeLegacy: true))
        XCTAssertEqual(ComputerStore.plan(index: nil, legacy: nil), ComputerStore.Plan(index: [], adopt: nil, removeLegacy: false))
        let other = SavedComputer(address: "https://laptop.tail5c2e.ts.net:8443", pairing: try pairing(2))
        XCTAssertEqual(ComputerStore.plan(index: [other.hostID, other.hostID], legacy: legacy).index, [other.hostID, legacy.hostID])
        XCTAssertEqual(ComputerStore.account(legacy.hostID), "computer.00000000-0000-4000-8000-000000000001")
    }
    func testAComputersNameIsTheOneGivenHereThenItsOwnThenItsTailnetName() throws {
        var computer = SavedComputer(address: "https://laptop.tail5c2e.ts.net:8443", pairing: try pairing(2))
        XCTAssertEqual(computer.name, "laptop")
        XCTAssertEqual(computer.endpoint?.port, 8443)
        computer.reportedName = "Zach’s Laptop"; XCTAssertEqual(computer.name, "Zach’s Laptop")
        computer.localName = "Desk"; XCTAssertEqual(computer.name, "Desk")
        computer.localName = "  "; XCTAssertEqual(computer.name, "Zach’s Laptop")
        let decoded = try JSONDecoder().decode(SavedComputer.self, from: JSONEncoder().encode(computer))
        XCTAssertEqual(decoded, computer)
    }

    // MARK: Answering from a card

    func testOnlyASingleChoiceQuestionAnswersInOneTap() throws {
        let single = try decode(AgentRequest.self, #"{"id":"r","kind":"question","text":"Q","options":[],"questions":[{"id":"q","question":"Which?","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"multiSelect":false,"allowFreeText":true}]}"#)
        XCTAssertEqual(single.oneTapOptions?.map(\.id), ["a", "b"])
        let multi = try decode(AgentRequest.self, #"{"id":"r","kind":"question","text":"Q","options":[],"questions":[{"id":"q","question":"Which?","options":[{"id":"a","label":"A"}],"multiSelect":true,"allowFreeText":false}]}"#)
        XCTAssertNil(multi.oneTapOptions)
        let words = try decode(AgentRequest.self, #"{"id":"r","kind":"question","text":"Say?","options":[]}"#)
        XCTAssertNil(words.oneTapOptions)
        let legacy = try decode(AgentRequest.self, #"{"id":"r","kind":"question","text":"Pick","options":[{"id":"x","label":"X"}]}"#)
        XCTAssertEqual(legacy.oneTapOptions?.map(\.id), ["x"])
    }
    func testACardOffersOnlyAllowOnceAndDeny() throws {
        let request = try decode(AgentRequest.self, #"{"id":"r","kind":"permission","text":"Run?","options":[],"permissionChoices":[{"id":"1","label":"Allow once","kind":"allow-once"},{"id":"2","label":"Always","kind":"allow-always"},{"id":"3","label":"Deny","kind":"deny"}]}"#)
        XCTAssertEqual(request.cardPermissionChoices?.map(\.id), ["1", "3"])
        let unknown = try decode(AgentRequest.self, #"{"id":"r","kind":"permission","text":"Run?","options":[],"permissionChoices":[{"id":"1","label":"Auto","kind":"automatic"}]}"#)
        XCTAssertNil(unknown.cardPermissionChoices)
    }

    // MARK: Activity

    func testActivityDecodesAndNamesWhatItTouched() throws {
        let detail = try decode(ThreadDetail.self, #"""
        {"threadId":"t","revision":3,"messages":[],"activities":[
          {"id":"a","turnId":"u","sequence":2,"kind":"command","status":"running","title":"Running tests","command":"npm test"},
          {"id":"b","turnId":"u","sequence":1,"kind":"file-change","status":"completed","title":"Edited files","changes":[{"path":"src/a.ts","kind":"update"},{"path":"src/b.ts","kind":"add"}],"durationMs":1200},
          {"id":"c","turnId":"u","sequence":3,"kind":"something-new","status":"completed","title":"A later kind"}]}
        """#)
        let records = try XCTUnwrap(detail.activities)
        XCTAssertEqual(records.map(\.subject), ["npm test", "src/a.ts and 1 more", nil])
        XCTAssertEqual(records[2].kind, "something-new")
    }
    func testShellRowsReadTheirSummaryWhenPresent() throws {
        let row = try decode(ThreadSummary.self, #"{"id":"t","projectId":"p","title":"T","status":"running","requests":[],"summary":{"messageCount":4,"lastMessageAt":"2026-09-26T09:38:00.000Z","activityCount":2,"runningTurnStartedAt":"2026-09-26T09:40:00.000Z"}}"#)
        XCTAssertEqual(row.summary?.runningTurnStartedAt, "2026-09-26T09:40:00.000Z")
        XCTAssertNil(try thread("bare").summary)
    }
}
