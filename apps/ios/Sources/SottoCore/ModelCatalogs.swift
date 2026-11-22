import Foundation

/// A model catalog a host sent whole, under the revision it named (`model-catalog-revision`, ADR-0028's
/// October 3 amendment). A revision means something only on the connection that carried it.
public struct CarriedCatalog: Sendable {
    public let revision: Int
    public let models: [ThreadModel]
    public init(revision: Int, models: [ThreadModel]) { self.revision = revision; self.models = models }
}

/// Antigravity runs Google's Gemini models only (ADR-0212, #2770): drops any non-Gemini or malformed Antigravity
/// model advertised by an older paired host, matching `antigravityCatalogGeminiModel` on the desktop.
public enum AntigravityCatalog {
    public static func allows(providerID: String?, modelID: String) -> Bool {
        guard providerID == "antigravity" else { return true }
        let nativeID: String
        if modelID.hasPrefix("native:") {
            let parts = modelID.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 4, parts[0] == "native", parts[1] == "antigravity", parts[2] == "model", !parts[3].isEmpty,
                  let decoded = strictPercentDecode(String(parts[3])) else { return false }
            nativeID = decoded
        } else if modelID.hasPrefix("antigravity:") {
            nativeID = String(modelID.dropFirst("antigravity:".count))
        } else if modelID.contains(":") {
            return false
        } else {
            nativeID = modelID
        }
        return nativeID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("gemini-")
    }

    public static func allows(_ model: ThreadModel) -> Bool {
        allows(providerID: model.providerId, modelID: model.id)
    }

    public static func filtered(_ models: [ThreadModel]) -> [ThreadModel] {
        models.filter { allows($0) }
    }

    static func providerID(from modelID: String?) -> String? {
        guard let modelID, modelID.hasPrefix("native:") else { return nil }
        let parts = modelID.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0] == "native", parts[2] == "model", !parts[1].isEmpty, !parts[3].isEmpty else { return nil }
        return String(parts[1])
    }

    static func displayName(forRemovedModelID modelID: String) -> String {
        if modelID.hasPrefix("native:") {
            let parts = modelID.split(separator: ":", omittingEmptySubsequences: false)
            if parts.count == 4, parts[0] == "native", parts[1] == "antigravity", parts[2] == "model",
               let decoded = strictPercentDecode(String(parts[3])), !decoded.isEmpty { return decoded }
        }
        return modelID
    }

    private static func strictPercentDecode(_ raw: String) -> String? {
        let scalars = Array(raw.unicodeScalars)
        var bytes: [UInt8] = []
        bytes.reserveCapacity(scalars.count)
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar == "%" {
                guard index + 2 < scalars.count,
                      let high = hexDigit(scalars[index + 1]),
                      let low = hexDigit(scalars[index + 2]) else { return nil }
                bytes.append((high << 4) | low)
                index += 3
            } else if scalar.isASCII {
                bytes.append(UInt8(scalar.value))
                index += 1
            } else {
                bytes.append(contentsOf: String(scalar).utf8)
                index += 1
            }
        }
        return String(bytes: bytes, encoding: .utf8)
    }

    private static func hexDigit(_ scalar: UnicodeScalar) -> UInt8? {
        switch scalar.value {
        case 48...57: return UInt8(scalar.value - 48)
        case 65...70: return UInt8(scalar.value - 55)
        case 97...102: return UInt8(scalar.value - 87)
        default: return nil
        }
    }
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
    public mutating func hold(_ shell: Shell) { if let carried = shell.host.withProviderModes()?.carriedCatalog { held = carried } }
    /// `shell` with its whole catalog. One that carries its catalog, or names no revision (a host without the
    /// feature), is returned as it came; one that names the held revision gets the held catalog back. One that
    /// names any other revision is nil: this connection was never sent that catalog, and showing the shell
    /// without it would read as a computer with no models.
    /// A catalog that names its models' provider modes by place (`provider-mode-lists`) has them put back; one naming a
    /// place its lists do not have is nil, as a revision this connection does not hold is.
    public func whole(_ shell: Shell) -> Shell? {
        guard let host = shell.host.withProviderModes() else { return nil }
        var shell = shell
        shell.host = host
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

extension ThreadModel {
    init(id: String, name: String, provider: String, providerId: String?, ready: Bool, recommended: Bool? = nil,
         reasoningEfforts: [String]? = nil, defaultReasoningEffort: String? = nil, runtimeModes: [String]? = nil,
         providerModes: [ProviderMode]? = nil, supportsImages: Bool? = nil, source: String? = nil) {
        self.id = id; self.name = name; self.provider = provider; self.providerId = providerId
        self.ready = ready; self.recommended = recommended; self.reasoningEfforts = reasoningEfforts
        self.defaultReasoningEffort = defaultReasoningEffort; self.runtimeModes = runtimeModes
        self.providerModes = providerModes; self.supportsImages = supportsImages; self.source = source
    }

    /// `models` with each one's provider modes put back from the list it names by place in `lists`; nil when one names a
    /// place `lists` does not have.
    static func withProviderModes(_ models: [ThreadModel], lists: [[ProviderMode]]) -> [ThreadModel]? {
        var whole = models
        for index in whole.indices {
            guard let place = whole[index].providerModeList else { continue }
            guard lists.indices.contains(place) else { return nil }
            whole[index].providerModes = lists[place]; whole[index].providerModeList = nil
        }
        return whole
    }
}

extension HostSnapshot {
    /// This snapshot with each model's provider modes put back from the list it names (`provider-mode-lists`, ADR-0028's
    /// November 1 amendment), and no lists left; as it is when no model names one. Nil when a model names a list that is
    /// not there, lists sent or not: that catalog cannot be shown whole.
    public func withProviderModes() -> HostSnapshot? {
        var restored = self
        restored.providerModeLists = nil
        if let models {
            guard let whole = ThreadModel.withProviderModes(models, lists: providerModeLists ?? []) else { return nil }
            restored.models = AntigravityCatalog.filtered(whole)
        }
        return restored
    }
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
    private enum Keys: String, CodingKey { case host, shell, models, modelsRevision, providerModeLists }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if c.contains(.shell) { carried = try c.decode(ReplyCatalog.self, forKey: .shell).carried; return }
        guard c.contains(.host) else { carried = nil; return }
        let host = try c.nestedContainer(keyedBy: Keys.self, forKey: .host)
        guard let revision = try host.decodeIfPresent(Int.self, forKey: .modelsRevision),
              let models = try host.decodeIfPresent([ThreadModel].self, forKey: .models) else { carried = nil; return }
        // A catalog that names its models' provider modes by place is held with them put back, and one naming a list it
        // did not send is not held at all.
        let lists = try host.decodeIfPresent([[ThreadModel.ProviderMode]].self, forKey: .providerModeLists) ?? []
        guard let whole = ThreadModel.withProviderModes(models, lists: lists) else { carried = nil; return }
        carried = CarriedCatalog(revision: revision, models: AntigravityCatalog.filtered(whole))
    }
}
