import XCTest
@testable import SottoCore

/// The machines line on Watcher's page (#1032, Zach's pick D): what the computer sends and the words the iPhone says.
final class MachinesTests: XCTestCase {
    private let host = "00000000-0000-4000-8000-000000000001"
    private let forge = "0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10"
    private let page = #"{"hostId":"00000000-0000-4000-8000-000000000001","current":null,"conversation":{"messages":[],"revision":0,"earlierAvailable":false},"receiptGroups":[],"watchedThreads":[],"needsYou":[],"inFlight":0,"inFlightLimit":8,"working":false,"recoveryNotice":null,"observedAt":"2026-10-23T12:40:00Z"}"#

    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T { try JSONDecoder().decode(type, from: Data(text.utf8)) }

    private func machine(name: String = "forge", thisComputer: Bool = false, connected: Bool = true, working: Int = 0, starting: Int = 0, isDefault: Bool = false,
                         cpu: String? = "not-busy", memory: String? = "enough") throws -> WatcherMachines.Machine {
        func value(_ text: String?) -> String { text.map { "\"\($0)\"" } ?? "null" }
        let json = """
        {"hostId":"\(thisComputer ? host : forge)","name":"\(name)","thisComputer":\(thisComputer),"connected":\(connected),"working":\(working),"starting":\(starting),\
        "isDefault":\(isDefault),"cpuState":\(value(cpu)),"memoryState":\(value(memory)),"system":"Omarchy (Linux)","logicalCpuCount":24,\
        "totalMemoryBytes":68719476736,"cpuBusyPercent":93,"windowMs":2000,"availableMemoryBytes":44023414784,"loadObservedAt":"2026-10-23T12:39:54Z",\
        "unknownWhy":null,"threads":[{"title":"Linux journeys","who":"Watcher"}]}
        """
        return try decode(WatcherMachines.Machine.self, json)
    }

    func testMachinesAreOptionalOnThePageAndDecodeWhenSent() throws {
        XCTAssertNil(try decode(WatcherPhoneState.self, page).machines)
        let row = #"{"hostId":"00000000-0000-4000-8000-000000000001","name":"This computer","thisComputer":true,"connected":true,"working":2,"starting":0,"isDefault":true,"cpuState":null,"memoryState":null,"system":null,"logicalCpuCount":null,"totalMemoryBytes":null,"cpuBusyPercent":null,"windowMs":null,"availableMemoryBytes":null,"loadObservedAt":null,"unknownWhy":null,"threads":[],"futureField":1}"#
        let sent = String(page.dropLast()) + #","machines":{"readAt":null,"rows":["# + row + "]}}"
        let machines = try XCTUnwrap(try decode(WatcherPhoneState.self, sent).machines)
        XCTAssertNil(machines.readAt)
        XCTAssertEqual(machines.rows.first?.working, 2)
        XCTAssertNil(machines.rows.first?.cpuState)
        // A machine not read yet says nothing of its load: no "load unknown" until a read says so.
        XCTAssertEqual(MachineLine.problems(try XCTUnwrap(machines.rows.first)), [])
    }

    func testTheMachinesFeatureRidesWithManagementAndItsReadAsksForAFreshRead() {
        guard case .array(let accepts)? = WatcherWire.managementHello["accepts"] else { return XCTFail("Missing accepts") }
        XCTAssertTrue(accepts.contains(.string(WatcherWire.machinesFeature)))
        guard case .array(let plain)? = WatcherWire.hello["accepts"] else { return XCTFail("Missing accepts") }
        XCTAssertFalse(plain.contains(.string(WatcherWire.machinesFeature)))
        XCTAssertEqual(WatcherWire.readMachines["op"], .string("watcher-phone-read"))
        XCTAssertEqual(WatcherWire.readMachines["machines"], .bool(true))
    }

    func testProblemWordsComeInThePrototypesOrderAndLoadUnknownOnlyWhenBothHalvesAre() throws {
        XCTAssertEqual(MachineLine.problems(try machine(working: 12, cpu: "busy", memory: "short")), ["may slow down", "busy", "short on memory"])
        XCTAssertEqual(MachineLine.problems(try machine(cpu: "unknown", memory: "unknown")), ["load unknown"])
        // A Mac reports its CPU and not its memory: busy from its CPU, and its memory left to the panel.
        XCTAssertEqual(MachineLine.problems(try machine(cpu: "busy", memory: "unknown")), ["busy"])
        XCTAssertEqual(MachineLine.problems(try machine(cpu: "unknown", memory: "enough")), [])
        XCTAssertEqual(MachineLine.problems(try machine(connected: false, cpu: nil, memory: nil)), ["not connected"])
        XCTAssertEqual(MachineLine.problems(try machine(working: 10)), [])
    }

    func testTheLineSaysCountsAndWordsAndLabelsEachPress() throws {
        let busy = try machine(working: 3, starting: 1, cpu: "busy")
        XCTAssertEqual(MachineLine.text(busy), "forge 3 working, busy")
        XCTAssertEqual(MachineLine.text(busy, starting: true), "forge 3 working, 1 starting, busy")
        XCTAssertEqual(MachineLine.text(try machine(connected: false, cpu: nil, memory: nil)), "forge not connected")
        XCTAssertEqual(MachineLine.text(try machine(name: "studio", working: 2)), "studio 2 working")
        XCTAssertEqual(MachineLine.label(busy), "forge, 3 working, busy. Show forge’s load and what runs there.")
        // This computer goes by the computer's own name on the phone, where "this computer" would be the phone.
        let local = try machine(name: "This computer", thisComputer: true, working: 2)
        XCTAssertEqual(MachineLine.named([local, busy], computer: "Laptop").map(\.name), ["Laptop", "forge"])
    }

    func testThePhoneNamesOnlyTheMachinesWithAProblemOrCountsThemAllWhenNothingIsWrong() throws {
        let local = try machine(name: "Laptop", thisComputer: true, working: 2)
        let forge = try machine(working: 3, cpu: "busy")
        let studio = try machine(name: "studio", working: 1)
        let troubled = MachineLine.short([local, forge, studio])
        XCTAssertEqual(troubled.shown.map(\.name), ["forge"])
        XCTAssertEqual(troubled.more, 2)
        XCTAssertEqual(MachineLine.more(troubled.more), "2 more")
        XCTAssertEqual(MachineLine.moreLabel(1), "1 more machine. Show every machine")
        let calm = MachineLine.short([local, studio])
        XCTAssertTrue(calm.shown.isEmpty)
        XCTAssertEqual(calm.more, 2)
        XCTAssertEqual(MachineLine.calm([local, studio]), "2 machines, 3 working")
        XCTAssertEqual(MachineLine.calmLabel([local, studio]), "2 machines, 3 working, nothing wrong. Show every machine")
        // The computer alone is named, since there is nothing else to count.
        XCTAssertEqual(MachineLine.short([local]).shown.map(\.name), ["Laptop"])
    }

    func testThePanelSaysTheLoadAsTheDesktopDoes() throws {
        let busy = try machine(working: 12, starting: 1, isDefault: true, cpu: "busy")
        XCTAssertEqual(MachineLine.cpu(busy), "93% busy over the last 2 seconds. Busy")
        XCTAssertEqual(MachineLine.memoryRow(busy), "41 GB of 64 GB available")
        XCTAssertEqual(MachineLine.memoryRow(try machine(memory: "unknown")), "unknown")
        XCTAssertEqual(MachineLine.panelCount(busy), "12 working, 1 starting. New workers start here.")
        XCTAssertEqual(MachineLine.over(busy), "More than ten threads are working on forge. It may slow down. Nothing is stopped or held back.")
        XCTAssertNil(MachineLine.over(try machine(working: 10)))
        XCTAssertEqual(MachineLine.memory(1.6 * 1_073_741_824), "1.6 GB")
        XCTAssertEqual(MachineLine.ago(6), "6 s ago")
        XCTAssertEqual(MachineLine.ago(190), "3 min ago")
        XCTAssertEqual(MachineLine.window(60_000), "the last minute")
        let away = try machine(connected: false, isDefault: true, cpu: nil, memory: nil)
        XCTAssertEqual(MachineLine.notConnected(away, computer: "Laptop"),
                       "forge is not connected. It is where new workers start, so until it connects they start on Laptop, and Watcher says so. Connect it on Laptop, in Settings, under Hosts & phones.")
    }
}
