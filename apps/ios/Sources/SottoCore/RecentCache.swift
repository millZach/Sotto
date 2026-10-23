import Foundation

/// Values worked out from their keys, kept for the keys asked for most recently. A view's body asks on every redraw, and
/// a key asked for again is answered without working its value out again. The cache turns once `limit` keys, or keys
/// costing `budget` between them, have been asked for since the last turn, and the values from before that turn go: it
/// never holds more than twice either, give or take one key. A message streaming in is a new key with every word, so
/// the budget is what stops its old versions piling up. Safe from any thread.
public final class RecentCache<Key: Hashable, Value>: @unchecked Sendable {
    private let limit: Int
    private let budget: Int
    private let cost: @Sendable (Key) -> Int
    private var current: [Key: Value] = [:]
    private var currentCost = 0
    private var previous: [Key: Value] = [:]
    private var previousCost = 0
    private let lock = NSLock()

    public init(limit: Int, budget: Int = .max, cost: @escaping @Sendable (Key) -> Int = { _ in 0 }) {
        precondition(limit > 0 && budget > 0)
        self.limit = limit
        self.budget = budget
        self.cost = cost
    }

    /// The value for `key`, from `make` only when no recent ask holds it.
    public func value(for key: Key, make: (Key) -> Value) -> Value {
        lock.lock(); defer { lock.unlock() }
        if let kept = current[key] { return kept }
        let value = previous[key] ?? make(key)
        let size = cost(key)
        if !current.isEmpty && (current.count >= limit || currentCost + size > budget) {
            previous = current; previousCost = currentCost
            current = [:]; currentCost = 0
        }
        current[key] = value
        currentCost += size
        return value
    }

    /// How many keys it holds and what they cost between them, for tests.
    var held: (count: Int, cost: Int) {
        lock.lock(); defer { lock.unlock() }
        return (current.count + previous.count, currentCost + previousCost)
    }
}
