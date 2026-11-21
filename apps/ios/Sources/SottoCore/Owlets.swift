import Foundation

/// Owlets (ADR-0213): Sotto's own named helpers, an Owl feature. An owlet is one project-bound thread that carries its
/// name and role, in a folder of its own on its home computer. This iPhone reads them from the thread records it already
/// reads, lists them on the Owlets tab rather than on Threads, and makes and changes them with the computer's own
/// `create-owlet` and `set-owlet`. The rules mirror `src/shared/owlets.ts`, which the computer checks again.
public struct ThreadOwlet: Decodable, Equatable, Hashable, Sendable {
    public let name: String
    public let role: String
    public init(name: String, role: String) { self.name = name; self.role = role }
}

public enum Owlets {
    /// The host feature a computer lists while it makes owlets, which this iPhone's hello accepts: only a phone that
    /// accepts it is sent the owlets' threads, so an older iPhone never shows them as ordinary threads.
    public static let feature = "owlets"
    public static let nameMax = 40
    public static let roleMax = 200
    /// The providers an owlet runs on: those whose own memory Sotto turns off in an owlet's folder.
    public static let providers: Set<String> = ["claude", "codex"]
    public static func providerAllowed(_ providerID: String?) -> Bool { providerID.map(providers.contains) ?? false }

    /// How the window names an owlet's folder: the name the user knows it by, not the data folder's path.
    public static func folderLabel(_ name: String) -> String { "Owlets/\(name)" }

    public enum NameProblem: Equatable, Sendable { case empty, long, characters }
    /// Why a name can't be an owlet's, or nil when it can, as the computer reads it (`owletNameProblem`): letters, numbers
    /// (with the marks some scripts write letters with), spaces, hyphens and apostrophes, starting with a letter or number,
    /// and not a name Windows keeps for a device.
    public static func nameProblem(_ name: String) -> NameProblem? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        if trimmed.isEmpty { return .empty }
        if trimmed.utf16.count > nameMax { return .long }
        let range = NSRange(trimmed.startIndex..., in: trimmed)
        if allowed.firstMatch(in: trimmed, range: range) == nil || reserved.firstMatch(in: trimmed, range: range) != nil { return .characters }
        return nil
    }
    private static let allowed = try! NSRegularExpression(pattern: "^[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N} '-]*$")
    private static let reserved = try! NSRegularExpression(pattern: "^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$", options: [.caseInsensitive])
    /// Two owlets on one computer can't share a name, because they would share a folder.
    public static func sameName(_ a: String, _ b: String) -> Bool { key(a) == key(b) }
    private static func key(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping.lowercased()
    }

    /// The face and chest an owlet's mark wears (`owletLook` on the desktop): chosen from the Sotto thread ID it has on its
    /// own computer, so a rename keeps it and every window draws the same one. Five faces and three chests.
    public static func look(threadID: String) -> (face: Int, chest: Int) {
        let own = threadID.components(separatedBy: ":").last ?? threadID
        var hash: UInt32 = 7
        for scalar in own.unicodeScalars { hash = hash &* 31 &+ scalar.value }
        return (Int(hash % 5), Int((hash / 5) % 3))
    }
}

/// The owlets on every computer this iPhone shows, as the Owlets tab lists them: the ones waiting on the user first under
/// Needs you, then the rest newest first, as Recent is on Threads, with one that never ran after those that have, by name.
/// A search finds an owlet by its name, its role or its home computer's name.
public struct OwletList {
    public private(set) var needsYou: [HostedThread] = []
    public private(set) var rest: [HostedThread] = []
    /// Every owlet the computers hold, before any search: whether the tab shows its first-use words.
    public let total: Int
    public var isEmpty: Bool { needsYou.isEmpty && rest.isEmpty }
    public init(_ computers: [ComputerThreads], query: String = "") {
        let rows = ThreadGroups.owlets(computers)
        total = rows.count
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        for row in rows {
            guard let owlet = row.thread.owlet else { continue }
            if !words.isEmpty, ![owlet.name, owlet.role, row.computer].contains(where: { $0.localizedStandardContains(words) }) { continue }
            if row.reachable && ThreadState(row.thread).waitsOnYou { needsYou.append(row) } else { rest.append(row) }
        }
    }
    /// Whether an owlet has news nobody has seen: a finish while nothing showed it, or a failed turn.
    public static func unread(_ row: HostedThread) -> Bool { row.finishedUnread || row.failed }
    /// The owlets waiting on the user, for the tab's badge.
    public var needsYouCount: Int { needsYou.count }
}

extension ThreadGroups {
    /// Every owlet on the computers, newest first; one that never ran sorts after those that have, by name. Owlets are
    /// listed only here: Threads and its Needs you leave them out (ADR-0213).
    public static func owlets(_ computers: [ComputerThreads]) -> [HostedThread] {
        let rows = computers.flatMap(hosted).filter { $0.thread.owlet != nil }
        let dated = rows.map { (row: $0, date: latest($0.thread)) }
        return dated.sorted { a, b in
            switch (a.date, b.date) {
            case let (x?, y?) where x != y: return x > y
            case (.some, nil): return true
            case (nil, .some): return false
            default: return (a.row.thread.owlet?.name ?? "").localizedStandardCompare(b.row.thread.owlet?.name ?? "") == .orderedAscending
            }
        }.map(\.row)
    }
}

extension Commands {
    /// A new owlet on its home computer: its folder, the project there and its one thread, whose ID this iPhone mints. Its
    /// model must be Claude Code's or Codex's and ready there; a permission that lets it act without asking needs the
    /// computer's remote-answer policy, as New thread's does. The computer checks all of it again.
    public static func createOwlet(threadID: String, name: String, role: String, model: ThreadModel, effort: String,
                                   permissionID: String, mayAnswer: Bool) throws -> JSONValue {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        let role = role.trimmingCharacters(in: .whitespacesAndNewlines)
        guard UUID(uuidString: threadID) != nil, Owlets.nameProblem(name) == nil, role.utf16.count <= Owlets.roleMax,
              model.ready, !model.id.isEmpty, model.id.utf16.count <= 6144, Owlets.providerAllowed(model.providerId),
              let permission = model.permissions.first(where: { $0.id == permissionID }), !permission.grants || mayAnswer,
              effort.isEmpty || (model.reasoningEfforts?.contains(effort) == true && effort.utf16.count <= 64) else { throw ClientError.invalidRequest }
        var fields: [String: JSONValue] = ["type": .string("create-owlet"), "threadId": .string(threadID), "name": .string(name),
            "role": .string(role), "modelId": .string(model.id)]
        fields[permission.providerOwned ? "providerMode" : "runtimeMode"] = .string(permission.id)
        if !effort.isEmpty { fields["reasoningEffort"] = .string(effort) }
        return try RemoteCommands.checked(.object(fields))
    }
    /// An owlet's new name, role or both. Its folder keeps the name it was made with.
    public static func setOwlet(threadID: String, name: String? = nil, role: String? = nil) throws -> JSONValue {
        let name = name.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping }
        let role = role.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !threadID.isEmpty, threadID.utf16.count <= 6144, name != nil || role != nil,
              name.map({ Owlets.nameProblem($0) == nil }) ?? true, role.map({ $0.utf16.count <= Owlets.roleMax }) ?? true else { throw ClientError.invalidRequest }
        var fields: [String: JSONValue] = ["type": .string("set-owlet"), "threadId": .string(threadID)]
        if let name { fields["name"] = .string(name) }
        if let role { fields["role"] = .string(role) }
        return try RemoteCommands.checked(.object(fields))
    }
}
