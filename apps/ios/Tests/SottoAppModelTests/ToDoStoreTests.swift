import XCTest
import SottoCore

@MainActor final class ToDoStoreTests: XCTestCase {
    private let laptop = "11111111-1111-4111-8111-111111111111"
    private func row(_ store: ToDoStore, _ id: String) -> ToDoRow { store.book.rows.first { $0.item.id == id }! }
    private func made(sent: @escaping (ToDoRequest, String) async throws -> Void) -> ToDoStore {
        let store = ToDoStore()
        store.send = sent
        store.undoNanoseconds = 20_000_000
        store.take(hostID: laptop, items: [ToDoItem(id: "a", title: "Do a", seen: false), ToDoItem(id: "b", title: "Do b", seen: true)])
        return store
    }
    private struct Refused: Error {}

    func testTheModelCarriesPressesInEveryBuildNotOnlyTheFixtures() {
        XCTAssertNotNil(AppModel(keychain: TestKeychain.store, receiptSleep: { _ in }).toDoStore.send)
    }

    func testOpeningQuietsTheBadgeOnTheComputerThatHoldsIt() async throws {
        var sent: [ToDoRequest] = []
        let store = made { request, _ in sent.append(request) }
        store.unroll()
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(sent, [.seen])
        XCTAssertTrue(store.marked.contains(ToDoBook.key(hostID: laptop, id: "a")), "What was new stays marked until it rolls up")
        store.rollUp()
        XCTAssertTrue(store.marked.isEmpty)
    }

    func testACheckOffWaitsAndGoesThroughRollingUp() async throws {
        var sent: [ToDoRequest] = []
        let store = made { request, _ in sent.append(request) }
        store.check(row(store, "b"))
        store.rollUp()
        XCTAssertEqual(sent, [], "Nothing goes while Undo stands")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(sent, [.check(id: "b", didNotWork: nil)])
    }

    func testUndoSendsNothing() async throws {
        var sent: [ToDoRequest] = []
        let store = made { request, _ in sent.append(request) }
        store.check(row(store, "b"))
        store.undo(row(store, "b"))
        XCTAssertFalse(row(store, "b").held)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(sent, [])
    }

    func testAComputerGoingAwayLeavesAWaitingCheckOffUnsent() async throws {
        var sent: [ToDoRequest] = []
        let store = made { request, _ in sent.append(request) }
        store.check(row(store, "b"))
        store.forget(hostID: laptop)
        XCTAssertFalse(store.book.offered)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(sent, [])
    }

    func testARefusedCheckOffComesBackAndUnrollsTheListToSaySo() async throws {
        let store = made { request, _ in if case .check = request { throw Refused() } }
        store.check(row(store, "b"))
        XCTAssertFalse(store.open)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(store.failed)
        XCTAssertTrue(store.open)
        XCTAssertFalse(row(store, "b").held)
        store.rollUp()
        XCTAssertFalse(store.failed, "Rolling up reads it")
    }

    func testRefusedWordsComeBackAfterARollUpUnlessNewerOnesAreBeingWritten() async {
        let store = made { request, _ in if case .add = request { throw Refused() } }
        store.draft = "  Call the plant "
        await store.addDraft()
        XCTAssertEqual(store.draft, "Call the plant")
        XCTAssertTrue(store.failed)
        store.rollUp()
        XCTAssertEqual(store.draft, "Call the plant")
    }

    func testTheLastRowGoingRollsUpButAListOpenedEmptyStays() {
        let store = made { _, _ in }
        store.unroll()
        store.rowsChanged(from: 0, to: 0)
        XCTAssertTrue(store.open)
        store.rowsChanged(from: 1, to: 0)
        XCTAssertFalse(store.open)
    }
}
