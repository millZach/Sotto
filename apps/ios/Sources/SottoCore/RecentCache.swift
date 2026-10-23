import Foundation

/// Values worked out from their keys, kept for the keys asked for most recently. A view's body asks on every redraw, and
/// a key asked for again is answered without working its value out again. It holds at most twice `limit` values: once
/// `limit` keys have been asked for since the last turn, the values from before that turn go. Safe from any thread.
public final class RecentCache<Key: Hashable, Value>: @unchecked Sendable {
    private let limit: Int
    private var current: [Key: Value] = [:]
    private var previous: [Key: Value] = [:]
    private let lock = NSLock()

    public init(limit: Int) {
        precondition(limit > 0)
        self.limit = limit
    }

    /// The value for `key`, from `make` only when no recent ask holds it.
    public func value(for key: Key, make: (Key) -> Value) -> Value {
        lock.lock(); defer { lock.unlock() }
        if let kept = current[key] { return kept }
        let value = previous[key] ?? make(key)
        if current.count >= limit { previous = current; current = [:] }
        current[key] = value
        return value
    }
}
