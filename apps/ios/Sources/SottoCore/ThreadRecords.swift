import Foundation

/// The thread records that changed since the last shell push on this connection (`changed-thread-records`, ADR-0028's
/// October 30 amendment): `changed` holds each record new or changed since the push `base` names, `removed` the IDs of
/// threads that went, and `order` every thread's ID, only when the order moved. A nil base means `changed` is every
/// record, in order. A revision means something only on the connection that carried it.
public struct ChangedThreadRecords: Decodable, Equatable, Sendable {
    public let revision: Int; public let base: Int?; public let changed: [ThreadSummary]
    public let removed: [String]?; public let order: [String]?
    private enum Keys: String, CodingKey { case revision, base, changed, removed, order }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        revision = try c.decode(Int.self, forKey: .revision)
        // A host always sends `base`. Null names every record; read as null, a missing one would drop every thread the
        // push did not list, so a push without one is unreadable and the connection starts again.
        guard c.contains(.base) else { throw DecodingError.keyNotFound(Keys.base, .init(codingPath: c.codingPath, debugDescription: "A push's thread records name their base")) }
        base = try c.decode(Int?.self, forKey: .base)
        changed = try c.decode([ThreadSummary].self, forKey: .changed)
        removed = try c.decodeIfPresent([String].self, forKey: .removed)
        order = try c.decodeIfPresent([String].self, forKey: .order)
    }
}

/// The thread records one connection's last shell push carried. A host that offers `changed-thread-records` sends this
/// phone only the records that changed since its last push, beside a state whose own list is empty, so the connection
/// puts the whole list back before anything reads the shell, as the desktop's client of a paired host does
/// (`src/shared/threadReassembly.ts`). It is kept in socket order, and a reconnect starts with an empty one, just as the
/// host starts the new connection with nothing pushed. A command's answer carries every record and changes nothing held;
/// so do a hello and a shell read, unless the host named the revision of the records they list (`reply-thread-records`),
/// which the connection then holds (`hold(_:)`).
public struct ThreadRecordsCache: Sendable {
    private struct Held: Sendable {
        let revision: Int; let records: [String: ThreadSummary]; let order: [String]; let list: [ThreadSummary]
    }
    private var held: Held?
    public init() {}
    /// Holds the records a hello or a shell read listed whole, under the revision the host named: the next push is
    /// measured from them. Read with the reply's envelope, in socket order, before any push that follows it.
    public mutating func hold(_ records: HeldThreadRecords) {
        held = Held(revision: records.revision, records: Dictionary(records.threads.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last }),
                    order: records.threads.map(\.id), list: records.threads)
    }
    /// `shell` with its whole thread list, which this then holds. A shell that carries no changed records, from a host
    /// without the feature, is returned as it came. One measured from records this connection does not hold, or that
    /// names a thread it cannot place, is nil and changes nothing held: shown, it would read as a computer whose threads
    /// went missing.
    public mutating func whole(_ shell: Shell) -> Shell? {
        guard let records = shell.threadRecords else { return shell }
        guard let next = Self.resolve(held, records) else { return nil }
        held = next
        var restored = shell
        restored.host.threads = next.list
        restored.threadRecords = nil
        return restored
    }
    private static func resolve(_ held: Held?, _ wire: ChangedThreadRecords) -> Held? {
        guard let base = wire.base else {
            return Held(revision: wire.revision, records: Dictionary(wire.changed.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last }),
                        order: wire.changed.map(\.id), list: wire.changed)
        }
        guard let held, base == held.revision else { return nil }
        let updates = Dictionary(wire.changed.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard updates.count == wire.changed.count else { return nil }
        let gone = Set(wire.removed ?? [])
        guard gone.allSatisfy({ held.records[$0] != nil }) else { return nil }
        // Without a new order the threads are the ones held, in the same order: nothing went and nothing is new.
        if wire.order == nil, !gone.isEmpty || wire.changed.contains(where: { held.records[$0.id] == nil }) { return nil }
        let ids = wire.order ?? held.order
        let listed = Set(ids)
        guard listed.count == ids.count else { return nil }
        var list: [ThreadSummary] = []
        list.reserveCapacity(ids.count)
        for id in ids {
            guard let record = updates[id] ?? (gone.contains(id) ? nil : held.records[id]) else { return nil }
            list.append(record)
        }
        // Every changed record has its place, and every held thread is either still listed or said to have gone.
        guard updates.keys.allSatisfy({ listed.contains($0) }), held.order.allSatisfy({ gone.contains($0) != listed.contains($0) }) else { return nil }
        return Held(revision: wire.revision, records: Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last }), order: ids, list: list)
    }
}

/// The thread records a hello or a shell read lists whole, and the revision the host holds them under for this connection
/// (`reply-thread-records`).
public struct HeldThreadRecords: Equatable, Sendable {
    public let revision: Int; public let threads: [ThreadSummary]
    public init(revision: Int, threads: [ThreadSummary]) { self.revision = revision; self.threads = threads }
}

/// The records a reply holds for the connection, read with its envelope: `result.shell` for hello, `result` for a shell
/// read. Nil unless the host named their revision.
struct ReplyThreadRecords: Decodable {
    let held: HeldThreadRecords?
    private enum Keys: String, CodingKey { case shell, host, threads, threadRecordsRevision }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if c.contains(.shell) { held = try c.decode(ReplyThreadRecords.self, forKey: .shell).held; return }
        guard let revision = try c.decodeIfPresent(Int.self, forKey: .threadRecordsRevision) else { held = nil; return }
        let host = try c.nestedContainer(keyedBy: Keys.self, forKey: .host)
        held = HeldThreadRecords(revision: revision, threads: try host.decode([ThreadSummary].self, forKey: .threads))
    }
}
