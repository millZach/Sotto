import XCTest
@testable import SottoCore

final class RecentCacheTests: XCTestCase {
    func testAKeyAskedForAgainIsNotWorkedOutAgain() {
        let cache = RecentCache<String, Int>(limit: 4)
        var made: [String] = []
        XCTAssertEqual(cache.value(for: "one") { made.append($0); return $0.count }, 3)
        XCTAssertEqual(cache.value(for: "one") { made.append($0); return $0.count }, 3)
        XCTAssertEqual(made, ["one"])
    }

    func testAKeyStaysThroughOneTurnAndGoesAfterTwo() {
        let cache = RecentCache<Int, Int>(limit: 2)
        var made: [Int] = []
        func ask(_ key: Int) { _ = cache.value(for: key) { made.append($0); return $0 } }
        ask(1); ask(2)
        // The third key turns the cache: 1 and 2 are kept from before the turn, and asking for 1 keeps it on.
        ask(3); ask(1)
        XCTAssertEqual(made, [1, 2, 3])
        // Two more turns with 2 never asked for: it is gone and worked out again.
        ask(4); ask(5); ask(6); ask(2)
        XCTAssertEqual(made, [1, 2, 3, 4, 5, 6, 2])
    }

    /// A message streaming in is a new key with every word. Its old versions go once they pass the budget, rather than
    /// staying until the count limit is reached.
    func testTheBudgetStopsAGrowingKeyPilingUp() {
        let cache = RecentCache<String, Int>(limit: 1_000, budget: 1_000) { $0.utf8.count }
        var text = ""
        for _ in 0..<400 {
            text += "word "
            _ = cache.value(for: text) { $0.count }
        }
        // 400 versions, 2,000 bytes for the last: past half the budget each turns the cache, so two are left.
        XCTAssertEqual(cache.held.count, 2)
        XCTAssertLessThanOrEqual(cache.held.cost, 2 * text.utf8.count)
    }
}
