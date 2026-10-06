import Foundation

/// A computer's name as the phone shows it: one line, trimmed, at most 64 characters.
public enum ComputerName {
    public static let maximumLength = 64
    public static func cleaned(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let words = raw.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined()
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let name = String(words.prefix(maximumLength)).trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? nil : name
    }
}

/// A paired computer as this iPhone keeps it in the Keychain: where it answers, its pairing, and
/// its names. Each computer is its own Keychain item, keyed by host ID.
public struct SavedComputer: Codable, Equatable, Sendable {
    public let address: String; public let pairing: Pairing
    /// The name the computer gave in its health when it was added. Older hosts give none.
    public var reportedName: String?
    /// A name given on this iPhone. It wins over the others until it is cleared.
    public var localName: String?
    public init(address: String, pairing: Pairing, reportedName: String? = nil, localName: String? = nil) {
        self.address = address; self.pairing = pairing; self.reportedName = reportedName; self.localName = localName
    }
    public var hostID: String { pairing.hostId }
    public var endpoint: HostEndpoint? { try? HostEndpoint(address) }
    /// Its name on the tailnet, the first label of its address: `forge`.
    public var machineName: String { endpoint?.machine ?? "Computer" }
    /// The name every list shows: the one given here, else the computer's own, else its tailnet name.
    public var name: String { ComputerName.cleaned(localName) ?? ComputerName.cleaned(reportedName) ?? machineName }
    public func validate() throws { try pairing.validate(); _ = try HostEndpoint(address) }
}

/// Where the computers live in the Keychain. The index lists host IDs in the order they were added;
/// each computer is the item `computer.<host ID>`. Before many computers there was one item, `host`.
public enum ComputerStore {
    public static let indexAccount = "computers"
    /// A damaged original index is preserved; recovered computers use this index instead.
    public static let recoveredIndexAccount = "computers.recovered"
    public static let legacyAccount = "host"
    public static let pendingAccount = "pending"
    public static func account(_ hostID: String) -> String { "computer." + hostID }

    /// What to write after reading the index and the single pairing from before many computers.
    public struct Plan: Equatable, Sendable {
        /// The index to keep, in order, without repeats.
        public let index: [String]
        /// The old single pairing, to be written as its own computer item before the index names it.
        public let adopt: SavedComputer?
        /// Whether the old `host` item can go once the above is written.
        public let removeLegacy: Bool
    }
    /// The single pairing becomes the first computer. The steps are safe to repeat: if the app stops
    /// between them, the next launch finds the index already naming it and only removes the old item.
    public static func plan(index: [String]?, legacy: SavedComputer?) -> Plan {
        var seen = Set<String>()
        var kept = (index ?? []).filter { seen.insert($0).inserted }
        guard let legacy else { return Plan(index: kept, adopt: nil, removeLegacy: false) }
        if kept.contains(legacy.hostID) { return Plan(index: kept, adopt: nil, removeLegacy: true) }
        kept.append(legacy.hostID)
        return Plan(index: kept, adopt: legacy, removeLegacy: true)
    }
}
