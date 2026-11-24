import Foundation

/// What a shell push named of its parts (`kept-parts`, ADR-0028's November 10 amendment; `watcher-phone-parts`, ADR-0025),
/// read beside its state in socket order: the parts it left out because they hold what the push before it held, at its top
/// (`kept`), in its host (`host.kept`) and in its Watcher page (`watcher.kept`), and every field it carried.
/// `KeptPartsCache` puts the left-out parts back.
public struct KeptPartNames: Equatable, Sendable {
    public let kept: Set<String>; public let hostKept: Set<String>; public let watcherKept: Set<String>
    /// Every field the push's state, its host and its Watcher page carried.
    let carried: Set<String>; let hostCarried: Set<String>; let watcherCarried: Set<String>
    /// Whether the push left out any part.
    public var keepsAny: Bool { !kept.isEmpty || !hostKept.isEmpty || !watcherKept.isEmpty }
}

/// Reads a push's `KeptPartNames` from its state without reading any part.
struct ShellPartNames: Decodable {
    let names: KeptPartNames
    private struct Field: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    init(from decoder: Decoder) throws {
        let state = try decoder.container(keyedBy: Field.self)
        let host = try state.nestedContainer(keyedBy: Field.self, forKey: Field(stringValue: "host"))
        var watcherKept: Set<String> = []
        var watcherCarried: Set<String> = []
        if let watcher = try? state.nestedContainer(keyedBy: Field.self, forKey: Field(stringValue: "watcher")) {
            watcherKept = Set(try watcher.decodeIfPresent([String].self, forKey: Field(stringValue: "kept")) ?? [])
            watcherCarried = Set(watcher.allKeys.map(\.stringValue))
        }
        names = KeptPartNames(kept: Set(try state.decodeIfPresent([String].self, forKey: Field(stringValue: "kept")) ?? []),
                              hostKept: Set(try host.decodeIfPresent([String].self, forKey: Field(stringValue: "kept")) ?? []),
                              watcherKept: watcherKept,
                              carried: Set(state.allKeys.map(\.stringValue)), hostCarried: Set(host.allKeys.map(\.stringValue)),
                              watcherCarried: watcherCarried)
    }
}

/// The parts of the last shell push one connection applied, which a later push's kept parts go back from (`kept-parts`,
/// ADR-0028's November 10 amendment; `watcher-phone-parts`, ADR-0025), as the desktop's client of a paired host puts them
/// back (`src/shared/keptParts.ts`). A host keeps a push's parts only when its thread records are measured from the push
/// before it, so the parts are held under that push's thread records' revision. Kept in socket order, and a reconnect
/// starts with none held, just as the host starts the new connection with nothing pushed. A hello, a shell read and a
/// command's answer carry every part and change nothing held.
public struct KeptPartsCache: Sendable {
    private struct Held: Sendable {
        let revision: Int; let shell: Shell
        let parts: Set<String>; let hostParts: Set<String>; let watcherParts: Set<String>
    }
    private var held: Held?
    public init() {}
    /// `shell` with each part it left out put back from the push held, which this then holds in its place. A shell that
    /// is not a push is returned as it came. One that left out parts measured from another push, names a part the push
    /// held did not have, or carries an invalid Watcher conversation delta is nil and changes nothing held: shown, it
    /// would read as a computer whose projects, deliveries or Watcher conversation went missing.
    public mutating func whole(_ shell: Shell) -> Shell? {
        guard let names = shell.keptParts else { return shell }
        var restored = shell
        restored.keptParts = nil
        let hasConversationDelta = restored.watcher?.conversationDelta != nil || names.watcherCarried.contains("conversationDelta")
        let hasReceiptDelta = restored.watcher?.receiptGroupsDelta != nil || names.watcherCarried.contains("receiptGroupsDelta")
        let hasWatcherDelta = hasConversationDelta || hasReceiptDelta
        let previousHeld = self.held
        if names.keepsAny || hasWatcherDelta {
            guard let held = previousHeld, let base = shell.threadRecords?.base, base == held.revision,
                  names.kept.isSubset(of: held.parts), names.hostKept.isSubset(of: held.hostParts) else { return nil }
            if !names.watcherKept.isEmpty || hasWatcherDelta {
                guard !names.kept.contains("watcher"), held.parts.contains("watcher") else { return nil }
                if var watcher = restored.watcher, let heldWatcher = held.shell.watcher {
                    guard names.watcherKept.isSubset(of: held.watcherParts),
                          watcher.putBack(names.watcherKept, carried: names.watcherCarried, from: heldWatcher) else { return nil }
                    restored.watcher = watcher
                } else {
                    // Forward-compat tolerant degradation (`Wire.swift` `c.tolerant`): either this push's Watcher page
                    // or the held one could not be decoded by this build, so omit `watcher` rather than reconnecting in a loop.
                    restored.watcher = nil
                }
            }
            restored.putBack(names, from: held.shell)
        }
        // Its parts, whole, are what the next push's go back from, with the thread records it carried.
        if let revision = shell.threadRecords?.revision {
            var parts = restored
            parts.threadRecords = nil
            let nextWatcherParts: Set<String>
            if names.kept.contains("watcher") {
                nextWatcherParts = previousHeld?.watcherParts ?? []
            } else if restored.watcher != nil {
                var deltaRestored: Set<String> = []
                if hasConversationDelta { deltaRestored.insert("conversation") }
                if hasReceiptDelta { deltaRestored.insert("receiptGroups") }
                nextWatcherParts = names.watcherCarried.union(names.watcherKept).union(deltaRestored).subtracting(["kept", "conversationDelta", "receiptGroupsDelta"])
            } else {
                nextWatcherParts = []
            }
            held = Held(revision: revision, shell: parts,
                        parts: names.carried.union(names.kept).subtracting(["kept"]),
                        hostParts: names.hostCarried.union(names.hostKept).subtracting(["kept"]),
                        watcherParts: nextWatcherParts)
        } else { held = nil }
        return restored
    }
}
