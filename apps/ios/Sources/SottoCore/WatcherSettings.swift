import Foundation

// Watcher's model, effort and speed from its box (Zach, October 31, 2026), as the desktop's chips choose them for Watcher
// (`ThreadOptions.tsx` with `watcher`): its own provider's ready models first, then each other provider Watcher runs on,
// whose model starts a new Watcher with a handover of this one; the effort levels and speeds its model offers. A press goes
// through the computer's own Watcher open (`watcher-phone-open`), which keeps the conversation for a change on the same
// provider and replaces it for another.

public enum WatcherSettings {
    /// The providers Watcher runs on (`watcherProviderSchema`).
    public static let providers: [String] = ["codex", "claude", "grok", "muse", "cursor"]

    /// One provider's models in the model menu, the current Watcher's own first.
    public struct Group: Equatable, Sendable, Identifiable {
        public let providerID: String
        public let name: String
        public let models: [ThreadModel]
        /// Whether these are the current Watcher's own provider's: another's starts a new Watcher.
        public let own: Bool
        public var id: String { providerID }
    }

    /// The model Watcher is on, as its computer's catalog names it.
    public static func model(_ current: WatcherPhoneState.Current, catalog: [ThreadModel]) -> ThreadModel? {
        CatalogEntry.model(catalog, id: current.modelId)
    }

    /// The model menu: Watcher's own provider's ready models, with the one it is on even when it isn't reported ready, then
    /// every other provider Watcher runs on that has a ready model, in the catalog's order.
    public static func groups(_ current: WatcherPhoneState.Current, catalog: [ThreadModel]) -> [Group] {
        let on = model(current, catalog: catalog)
        let own = catalog.filter { $0.providerId == current.provider && ($0.ready || $0.id == on?.id) }
        var groups = own.isEmpty ? [] : [Group(providerID: current.provider, name: AgentNames.name(current.provider), models: own, own: true)]
        var seen: Set<String> = [current.provider]
        for entry in catalog {
            guard let provider = entry.providerId, providers.contains(provider), seen.insert(provider).inserted else { continue }
            let ready = catalog.filter { $0.providerId == provider && $0.ready }
            if !ready.isEmpty { groups.append(Group(providerID: provider, name: AgentNames.name(provider), models: ready, own: false)) }
        }
        return groups
    }

    /// What each chip shows: the model's ID, its effort (the model's default where Watcher names none) and its speed.
    /// Permissions are Watcher's own and are not read here.
    public static func values(_ current: WatcherPhoneState.Current, catalog: [ThreadModel]) -> ThreadSettingValues {
        let on = model(current, catalog: catalog)
        return ThreadSettingValues(model: current.modelId, effort: current.reasoningEffort ?? on?.defaultReasoningEffort ?? "",
                                   permissions: "", speed: current.speed ?? ThreadSettings.standard)
    }

    /// The effort levels Watcher's chip offers on a model: the model's own, without Ultracode, which is a person's choice
    /// for a thread and never Watcher's (ADR-0148, decision 6).
    public static func efforts(_ model: ThreadModel?) -> [String] { (model?.reasoningEfforts ?? []).filter { $0 != "ultracode" } }

    /// Whether a model is another provider's, so choosing it starts a new Watcher.
    public static func replaces(_ modelID: String, current: WatcherPhoneState.Current, catalog: [ThreadModel]) -> Bool {
        guard let chosen = CatalogEntry.model(catalog, id: modelID) else { return false }
        return chosen.providerId != nil && chosen.providerId != current.provider
    }

    /// The operation a press sends, or nil where there is nothing to change: a model on its own (Watcher's provider picks
    /// the new model's effort), or the effort or speed on the model Watcher is on. Never the permissions.
    public static func press(_ kind: ThreadSettingKind, value: String, current: WatcherPhoneState.Current, catalog: [ThreadModel]) -> [String: JSONValue]? {
        let shown = values(current, catalog: catalog)
        guard kind != .permissions, shown[kind] != value else { return nil }
        switch kind {
        case .model:
            guard let chosen = CatalogEntry.model(catalog, id: value), let provider = chosen.providerId, providers.contains(provider) else { return nil }
            // The model Watcher is on, listed under its base, leaves it where it is.
            if chosen.id == model(current, catalog: catalog)?.id { return nil }
            return WatcherWire.open(target: current.target, provider: provider, modelID: chosen.id)
        case .effort:
            guard efforts(model(current, catalog: catalog)).contains(value) else { return nil }
            return WatcherWire.open(target: current.target, provider: current.provider, modelID: current.modelId, effort: value)
        case .speed:
            // The model goes with the change, so the effort goes too: a model named alone takes its default effort.
            return WatcherWire.open(target: current.target, provider: current.provider, modelID: current.modelId,
                                    effort: shown.effort, speed: value)
        case .permissions:
            return nil
        }
    }
}
