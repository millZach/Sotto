import Foundation

/// A to-do: what only the user's hands can do (ADR-0188). Each computer keeps its own and this iPhone joins them, as it does
/// threads. It is not a request: checking one off answers nothing and approves nothing. Only a computer whose Owl answer
/// turns the feature on offers `to-dos`, so anywhere else this reads nothing and shows nothing.
public struct ToDoItem: Decodable, Equatable, Identifiable, Sendable {
    public struct Link: Decodable, Equatable, Sendable {
        public let label: String; public let url: String
        public init(label: String, url: String) { self.label = label; self.url = url }
    }
    public let id: String; public let title: String; public let why: String?; public let link: Link?
    public let steps: [String]?
    /// The thread that added it, by the computer's own ID. Absent on the user's own, on Watcher's, and on one this iPhone isn't sent.
    public let threadId: String?
    /// `thread`, `watcher`, `user` or `prototype`.
    public let by: String
    public let waits: Bool; public let seen: Bool
    public init(id: String, title: String, why: String? = nil, link: Link? = nil, steps: [String]? = nil, threadId: String? = nil, by: String = "thread",
                waits: Bool = false, seen: Bool = false) {
        self.id = id; self.title = title; self.why = why; self.link = link; self.steps = steps; self.threadId = threadId; self.by = by
        self.waits = waits; self.seen = seen
    }
}

/// A press on one computer's list.
public enum ToDoRequest: Equatable, Sendable {
    case add(title: String)
    case check(id: String, didNotWork: String?)
    case seen
}

public enum ToDoWire {
    /// What a computer lists, and this iPhone accepts, to be pushed its list whole.
    public static let feature = "to-dos"
    /// How long a check-off is held with Undo showing before it reaches the computer that holds the item.
    public static let undoSeconds: UInt64 = 5
    public static let titleMax = 200
    public static let noteMax = 2_000
    /// The hello with this iPhone offering to read the list, now that it can show it.
    public static func accepting(_ hello: [String: JSONValue]) -> [String: JSONValue] {
        var result = hello
        if case .array(let accepts)? = result["accepts"] { result["accepts"] = .array(accepts + [.string(feature)]) }
        return result
    }
    public static func operation(_ request: ToDoRequest) -> [String: JSONValue] {
        let body: [String: JSONValue]
        switch request {
        case .add(let title): body = ["kind": .string("add"), "title": .string(title)]
        case .seen: body = ["kind": .string("seen")]
        case .check(let id, let didNotWork):
            body = ["kind": .string("check"), "id": .string(id)].merging(didNotWork.map { ["didNotWork": .string($0)] } ?? [:]) { first, _ in first }
        }
        return ["op": .string("to-do-request"), "request": .object(body)]
    }
}

/// One to-do as the list shows it, with the computer that holds it.
public struct ToDoRow: Equatable, Identifiable, Sendable {
    public let id: String; public let hostID: String; public let item: ToDoItem
    /// Checked off, with Undo standing: nothing has reached the computer that holds it yet.
    public let held: Bool
    /// The wait is over and the press is on its way: it stays until the list says it is gone, so a refusal has somewhere to show.
    public let sending: Bool
}

/// Every computer's list as this iPhone holds it, and which rows are checked off and waiting (ADR-0188, decision 6).
public struct ToDoBook: Equatable, Sendable {
    private var lists: [(hostID: String, items: [ToDoItem])] = []
    /// Each held row, and whether its press has gone.
    private var holds: [String: Bool] = [:]
    public init() {}
    public static func == (lhs: ToDoBook, rhs: ToDoBook) -> Bool {
        lhs.holds == rhs.holds && lhs.lists.map(\.hostID) == rhs.lists.map(\.hostID) && lhs.lists.map(\.items) == rhs.lists.map(\.items)
    }
    public static func key(hostID: String, id: String) -> String { "\(hostID)\u{0}\(id)" }
    /// Whether any computer connected keeps a list, which is what shows the icon.
    public var offered: Bool { !lists.isEmpty }
    /// The user's own goes to the first computer connected (ADR-0188, decision 8).
    public var firstHost: String? { lists.first?.hostID }
    public var rows: [ToDoRow] {
        lists.flatMap { list in list.items.map { item in
            let key = Self.key(hostID: list.hostID, id: item.id)
            return ToDoRow(id: key, hostID: list.hostID, item: item, held: holds[key] != nil, sending: holds[key] == true)
        } }
    }
    /// What the badge counts: rows not checked off.
    public var left: Int { rows.filter { !$0.held }.count }
    public var unseen: Int { rows.filter { !$0.held && !$0.item.seen }.count }
    /// A computer's list, pushed whole. Returns the holds it ended: checked off elsewhere, there is nothing left to send.
    @discardableResult public mutating func take(hostID: String, items: [ToDoItem]) -> [String] {
        if let at = lists.firstIndex(where: { $0.hostID == hostID }) { lists[at].items = items } else { lists.append((hostID, items)) }
        return dropMissing()
    }
    /// A computer gone away: its items aren't shown, and they come back with it.
    @discardableResult public mutating func forget(hostID: String) -> [String] {
        lists.removeAll { $0.hostID == hostID }
        return dropMissing()
    }
    public mutating func hold(_ key: String) { holds[key] = false }
    public mutating func sending(_ key: String) { if holds[key] != nil { holds[key] = true } }
    public mutating func release(_ key: String) { holds[key] = nil }
    private mutating func dropMissing() -> [String] {
        let present = Set(rows.map(\.id))
        let gone = holds.keys.filter { !present.contains($0) }
        for key in gone { holds[key] = nil }
        return gone
    }
}
