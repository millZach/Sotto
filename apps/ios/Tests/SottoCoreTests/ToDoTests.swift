import XCTest
@testable import SottoCore

final class ToDoTests: XCTestCase {
    private let laptop = "11111111-1111-4111-8111-111111111111", forge = "22222222-2222-4222-8222-222222222222"
    private func item(_ id: String, seen: Bool = true) -> ToDoItem { ToDoItem(id: id, title: "Do \(id)", seen: seen) }

    func testAcceptsTheListOnlyInTheHelloThisIPhoneSends() {
        guard case .array(let accepts)? = ToDoWire.accepting(WatcherWire.managementHello)["accepts"] else { return XCTFail("Missing accepts") }
        XCTAssertTrue(accepts.contains(.string("to-dos")))
        guard case .array(let plain)? = WatcherWire.managementHello["accepts"] else { return XCTFail("Missing accepts") }
        XCTAssertFalse(plain.contains(.string("to-dos")))
    }

    func testReadsAPushedListWithWhatAComputerLeavesOut() async throws {
        let data = Data(#"{"v":1,"event":"to-dos","items":[{"id":"a","title":"Hand test","by":"thread","waits":true,"seen":false,"addedAt":"2026-11-04T00:00:00.000Z","threadId":"t1","steps":["One"],"link":{"label":"Open","url":"https://example.com"}},{"id":"b","title":"Mine","by":"user","waits":false,"seen":true,"addedAt":"2026-11-04T00:00:00.000Z"}]}"#.utf8)
        guard case .toDos(let items) = try await Wire.readFrame(data) else { return XCTFail("Not a list") }
        XCTAssertEqual(items.map(\.id), ["a", "b"])
        XCTAssertEqual(items[0].threadId, "t1")
        XCTAssertEqual(items[0].link?.url, "https://example.com")
        XCTAssertNil(items[1].threadId)
        XCTAssertNil(items[1].why)
    }

    func testAPressCarriesOnlyWhatTheHostTakes() {
        XCTAssertEqual(ToDoWire.operation(.seen), ["op": .string("to-do-request"), "request": .object(["kind": .string("seen")])])
        XCTAssertEqual(ToDoWire.operation(.add(title: "Mine")), ["op": .string("to-do-request"), "request": .object(["kind": .string("add"), "title": .string("Mine")])])
        XCTAssertEqual(ToDoWire.operation(.check(id: "a", didNotWork: nil)), ["op": .string("to-do-request"), "request": .object(["kind": .string("check"), "id": .string("a")])])
        XCTAssertEqual(ToDoWire.operation(.check(id: "a", didNotWork: "It opened twice")),
                       ["op": .string("to-do-request"), "request": .object(["kind": .string("check"), "id": .string("a"), "didNotWork": .string("It opened twice")])])
    }

    func testJoinsEachComputersListAndCountsWhatIsLeftAndNew() {
        var book = ToDoBook()
        XCTAssertFalse(book.offered)
        book.take(hostID: laptop, items: [item("a", seen: false), item("b")])
        book.take(hostID: forge, items: [item("c", seen: false)])
        XCTAssertTrue(book.offered)
        XCTAssertEqual(book.firstHost, laptop)
        XCTAssertEqual(book.rows.map(\.item.id), ["a", "b", "c"])
        XCTAssertEqual(book.left, 3)
        XCTAssertEqual(book.unseen, 2)
    }

    func testAComputerThatKeepsNothingYetStillOffersTheList() {
        var book = ToDoBook()
        book.take(hostID: laptop, items: [])
        XCTAssertTrue(book.offered)
        XCTAssertEqual(book.left, 0)
    }

    func testAHeldRowStandsAndIsNotCounted() {
        var book = ToDoBook()
        book.take(hostID: laptop, items: [item("a", seen: false), item("b")])
        let key = ToDoBook.key(hostID: laptop, id: "a")
        book.hold(key)
        XCTAssertEqual(book.rows.count, 2)
        XCTAssertEqual(book.left, 1)
        XCTAssertEqual(book.unseen, 0)
        XCTAssertEqual(book.rows[0].held, true)
        XCTAssertEqual(book.rows[0].sending, false)
        book.sending(key)
        XCTAssertEqual(book.rows[0].sending, true)
        book.release(key)
        XCTAssertEqual(book.left, 2)
    }

    func testAHoldEndsWhenItsItemIsGoneFromUnderIt() {
        var book = ToDoBook()
        book.take(hostID: laptop, items: [item("a"), item("b")])
        let key = ToDoBook.key(hostID: laptop, id: "a")
        book.hold(key)
        XCTAssertEqual(book.take(hostID: laptop, items: [item("b")]), [key])
        XCTAssertEqual(book.rows.map(\.held), [false])
    }

    func testAComputerGoneAwayTakesItsItemsAndHoldsWithIt() {
        var book = ToDoBook()
        book.take(hostID: laptop, items: [item("a")])
        book.take(hostID: forge, items: [item("c")])
        let key = ToDoBook.key(hostID: forge, id: "c")
        book.hold(key)
        XCTAssertEqual(book.forget(hostID: forge), [key])
        XCTAssertEqual(book.rows.map(\.item.id), ["a"])
        XCTAssertEqual(book.firstHost, laptop)
    }

    func testAThreadsPrototypeMarkKeepsThePagesItCanRead() throws {
        let data = Data(#"{"source":"reply:one","pages":[{"token":"t","kind":"file","name":"a.html","start":"a.html"},{"nonsense":true}]}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(PrototypeMark.self, from: data).pages.map(\.name), ["a.html"])
        XCTAssertEqual(try JSONDecoder().decode(PrototypeMark.self, from: Data(#"{"pages":"unknown"}"#.utf8)).pages, [])
    }
}
