import Foundation
import UniformTypeIdentifiers

/// What a pasted or shared item is to a reply box: words, a photo or a file. Words go in the text field; a photo is made
/// ready as one from the library is; anything else goes as a file (ADR-0131). A copied file carries its own name, which
/// is what tells a text file from copied text, and a page's copied words from the web archive that rides with them.
public enum SharedItemKind: Equatable, Sendable {
    case words
    /// The type identifier to read the photo's bytes as.
    case photo(String)
    /// The type identifier to read the file's bytes as.
    case file(String)

    public init?(types: [String], suggestedName: String?) {
        let known = types.compactMap { identifier in UTType(identifier).map { (identifier, $0) } }
        let named = !((suggestedName ?? "") as NSString).pathExtension.isEmpty || known.contains { $0.1.conforms(to: .fileURL) }
        if !named, known.contains(where: { $0.1.conforms(to: .text) || $0.1.conforms(to: .url) }) { self = .words; return }
        if let image = known.first(where: { $0.1.conforms(to: .image) }) { self = .photo(image.0); return }
        if let data = known.first(where: { !$0.1.conforms(to: .url) && ($0.1.conforms(to: .data) || $0.1.conforms(to: .content)) }) {
            self = .file(data.0); return
        }
        if named, let text = known.first(where: { $0.1.conforms(to: .text) }) { self = .file(text.0); return }
        return nil
    }

    /// The file's name: the one it came with, given the extension its type has when it came without one, or `fallback`.
    public static func name(_ suggestedName: String?, type identifier: String, fallback: String) -> String {
        let base = suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? fallback
        guard (base as NSString).pathExtension.isEmpty, let ext = UTType(identifier)?.preferredFilenameExtension else { return base }
        return base + "." + ext
    }
}

/// Shared items handed from Sotto's share extension to the app, through the App Group's container (ADR-0157). Each share is
/// a folder of its own, named by when it came, holding its files as they came and `share.json`, written last, so a folder
/// without it is a share still being written. The app takes the oldest complete share when it opens or comes forward and
/// removes the folder once its items are in a box.
public enum ShareInbox {
    public static let appGroup = "group.com.millzach.sotto.ios"
    /// The URL the extension opens to bring Sotto forward once a share is written.
    public static let openURL = URL(string: "sotto-share://inbox")!
    public static let manifestName = "share.json"
    /// Most items one share carries: as many as one message can (`PhotoLimits.count`).
    public static let itemsMax = PhotoLimits.count
    /// A share left unclaimed this long is let go, so the container never holds a stranger's files for long.
    public static let keptFor: TimeInterval = 24 * 60 * 60

    public struct Manifest: Codable, Equatable, Sendable {
        /// The words: shared text and links, one to a line, in the order they came.
        public var words: String
        /// The files beside the manifest, by name, in the order they came.
        public var files: [String]
        public var sharedAt: Date
        public init(words: String, files: [String], sharedAt: Date) { self.words = words; self.files = files; self.sharedAt = sharedAt }
    }

    public static func folder(in container: URL) -> URL { container.appendingPathComponent("Shared", isDirectory: true) }

    /// A file name safe to write in a share's folder, kept apart from those already taken there.
    public static func safeName(_ name: String, taken: Set<String>) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        let base = cleaned.isEmpty || cleaned == manifestName ? "Shared file" : String(cleaned.prefix(200))
        guard taken.contains(base) else { return base }
        let stem = (base as NSString).deletingPathExtension, ext = (base as NSString).pathExtension
        var index = 2
        while true {
            let candidate = ext.isEmpty ? "\(stem) \(index)" : "\(stem) \(index).\(ext)"
            if !taken.contains(candidate) { return candidate }
            index += 1
        }
    }

    /// The complete shares in the inbox, oldest first. Folders past `keptFor`, complete or not, are removed.
    public static func pending(in container: URL, now: Date = Date(), fileManager: FileManager = .default) -> [(folder: URL, manifest: Manifest)] {
        let root = folder(in: container)
        guard let folders = try? fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey]) else { return [] }
        var shares: [(folder: URL, manifest: Manifest)] = []
        for share in folders {
            let created = (try? share.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? now
            let manifest = (try? Data(contentsOf: share.appendingPathComponent(manifestName))).flatMap { try? decoder.decode(Manifest.self, from: $0) }
            if now.timeIntervalSince(manifest?.sharedAt ?? created) > keptFor { try? fileManager.removeItem(at: share); continue }
            if let manifest { shares.append((share, manifest)) }
        }
        return shares.sorted { $0.manifest.sharedAt < $1.manifest.sharedAt }
    }

    public static func write(_ manifest: Manifest, to share: URL) throws {
        try encoder.encode(manifest).write(to: share.appendingPathComponent(manifestName), options: .atomic)
    }

    private static let encoder: JSONEncoder = { let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; return encoder }()
    private static let decoder: JSONDecoder = { let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601; return decoder }()
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// What the share extension says, in the interface language (ADR-0123).
public enum ShareWords {
    public static let saving = String(localized: "Adding to Sotto…", bundle: .module, comment: "The share sheet's Sotto card while it saves what was shared")
    public static let done = String(localized: "share.done", defaultValue: "Done", bundle: .module,
                                    comment: "The button that closes Sotto's card on the share sheet. Not a thread's state")
    public static let openSotto = String(localized: "Saved. Open Sotto to add it to your message.", bundle: .module,
                                         comment: "The share sheet couldn't open Sotto; what was shared waits for the app")
    public static let nothing = String(localized: "Sotto can’t take what was shared. Nothing was saved.", bundle: .module)
    public static let failed = String(localized: "This couldn’t be saved for Sotto. Nothing was shared. Try again.", bundle: .module)
}
