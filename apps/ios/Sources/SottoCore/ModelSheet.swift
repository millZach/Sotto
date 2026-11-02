import Foundation

/// A model starred on this iPhone (ADR-0147, amended November 1, 2026): its provider and the provider's own model id.
/// The phone keeps its stars to itself, as the desktop's window keeps its own; neither is sent to the other.
public struct ModelFavorite: Codable, Hashable, Sendable {
    public let provider: String
    public let model: String
    public init(provider: String, model: String) { self.provider = provider; self.model = model }
    public init(_ model: ThreadModel) { self.init(provider: model.providerId ?? model.provider, model: model.id) }
}

/// The phone's favorite models, in the order they were starred, kept as one JSON string in UserDefaults.
public enum ModelFavorites {
    /// What was saved; text that no longer reads keeps no favorites rather than failing the sheet.
    public static func read(_ saved: String) -> [ModelFavorite] {
        guard !saved.isEmpty, let data = saved.data(using: .utf8),
              let list = try? JSONDecoder().decode([ModelFavorite].self, from: data) else { return [] }
        return list
    }

    public static func write(_ list: [ModelFavorite]) -> String {
        guard let data = try? JSONEncoder().encode(list) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Stars the model at the end of the list, or takes its star off where it has one.
    public static func toggled(_ saved: String, _ model: ThreadModel) -> String {
        let key = ModelFavorite(model)
        var list = read(saved)
        if list.contains(key) { list.removeAll { $0 == key } } else { list.append(key) }
        return write(list)
    }

    /// What the sheet lists under Favorites: the starred models it offers, in the order they were starred, leaving out the
    /// one in use, which already heads the sheet. A favorite the sheet doesn't offer, another provider's in a thread's
    /// sheet or one its computer no longer lists, waits until a sheet offers it again.
    public static func offered(_ list: [ModelFavorite], in models: [ThreadModel], current: String?) -> [ThreadModel] {
        list.compactMap { favorite in
            models.first { ModelFavorite($0) == favorite && $0.id != current }
        }
    }
}

/// Which provider the model sheet has open, and whether its Legacy is open too. Every provider starts closed; opening one
/// closes any other, and Legacy closes with its provider.
public struct ModelFolds: Equatable, Sendable {
    public private(set) var provider: String?
    public private(set) var legacy = false
    public init() {}

    public mutating func toggle(_ provider: String) {
        self.provider = self.provider == provider ? nil : provider
        legacy = false
    }

    public mutating func toggleLegacy() {
        guard provider != nil else { return }
        legacy.toggle()
    }
}
