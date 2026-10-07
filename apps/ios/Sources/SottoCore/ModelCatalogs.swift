import Foundation

/// A model catalog a host sent whole, under the revision it named (`model-catalog-revision`, ADR-0028's
/// October 3 amendment). A revision means something only on the connection that carried it.
public struct CarriedCatalog: Sendable {
    public let revision: Int
    public let models: [ThreadModel]
    public init(revision: Int, models: [ThreadModel]) { self.revision = revision; self.models = models }
}

/// The last model catalog one connection was sent whole. A host that names its catalog by revision leaves it
/// out of every shell after the first one that carried it, so the connection puts it back before anything
/// reads the shell, and every reader still sees a whole catalog. It is kept in socket order, and a reconnect
/// starts with an empty one, just as the host starts the new connection with nothing recorded.
public struct ModelCatalogCache: Sendable {
    public private(set) var held: CarriedCatalog?
    public init() {}
    /// Keeps `carried` as the catalog later shells may name.
    public mutating func hold(_ carried: CarriedCatalog) { held = carried }
    /// Keeps the catalog `shell` carries whole under a revision, when it carries one.
    public mutating func hold(_ shell: Shell) { if let carried = shell.host.carriedCatalog { held = carried } }
    /// `shell` with its whole catalog. One that carries its catalog, or names no revision (a host without the
    /// feature), is returned as it came; one that names the held revision gets the held catalog back. One that
    /// names any other revision is nil: this connection was never sent that catalog, and showing the shell
    /// without it would read as a computer with no models.
    public func whole(_ shell: Shell) -> Shell? {
        guard let revision = shell.host.modelsRevision, shell.host.models == nil else { return shell }
        guard let held, held.revision == revision else { return nil }
        var restored = shell
        restored.host.models = held.models
        return restored
    }
    /// `hello` with its shell's whole catalog, by the same rule as a shell.
    public func whole(_ hello: Hello) -> Hello? {
        guard let shell = whole(hello.shell) else { return nil }
        var restored = hello
        restored.shell = shell
        return restored
    }
}

/// A model in a computer's catalog, read as the host reads it (`catalogEntry` in src/shared/modelCatalog.ts): the
/// exact entry, or its base model's for a 1M-context variant (`…[1m]`) the catalog lists only as its base.
public enum CatalogEntry {
    public static func model(_ models: [ThreadModel], id: String?) -> ThreadModel? {
        guard let id else { return nil }
        if let exact = models.first(where: { $0.id == id }) { return exact }
        guard let base = baseID(id) else { return nil }
        return models.first { $0.id == base }
    }
    /// The base of a 1M-context variant: `opus` for `opus[1m]`, and the same inside a public Claude model ID.
    /// Nil for anything else, and for another provider's public ID.
    static func baseID(_ id: String) -> String? {
        let prefix = "native:claude:model:"
        var value = id
        if id.hasPrefix("native:") {
            guard id.hasPrefix(prefix), let decoded = String(id.dropFirst(prefix.count)).removingPercentEncoding else { return nil }
            value = decoded
        }
        guard value.count > 4, value.lowercased().hasSuffix("[1m]") else { return nil }
        let base = String(value.dropLast(4))
        guard id.hasPrefix(prefix) else { return base }
        return prefix + (base.addingPercentEncoding(withAllowedCharacters: uriComponent) ?? base)
    }
    /// What `encodeURIComponent` leaves as it is.
    private static let uriComponent = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
}

extension HostSnapshot {
    /// The catalog this snapshot carries whole under a revision, when it does.
    var carriedCatalog: CarriedCatalog? {
        guard let modelsRevision, let models else { return nil }
        return CarriedCatalog(revision: modelsRevision, models: models)
    }
}

/// The catalog a reply's shell carries whole, read with the reply's envelope so the connection holds it in
/// socket order, before any later push that names it: `result.host` for a shell read or a command's answer,
/// `result.shell.host` for hello. The catalog is decoded only when the host named a revision with it.
struct ReplyCatalog: Decodable {
    let carried: CarriedCatalog?
    private enum Keys: String, CodingKey { case host, shell, models, modelsRevision }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if c.contains(.shell) { carried = try c.decode(ReplyCatalog.self, forKey: .shell).carried; return }
        guard c.contains(.host) else { carried = nil; return }
        let host = try c.nestedContainer(keyedBy: Keys.self, forKey: .host)
        guard let revision = try host.decodeIfPresent(Int.self, forKey: .modelsRevision),
              let models = try host.decodeIfPresent([ThreadModel].self, forKey: .models) else { carried = nil; return }
        carried = CarriedCatalog(revision: revision, models: models)
    }
}
