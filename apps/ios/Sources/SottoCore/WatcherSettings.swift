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

    /// The model menu: Watcher's own provider's ready models, with the one it is on even when it isn't reported ready, then,
    /// with `others`, every other provider Watcher runs on that has a ready model, in the catalog's order. Only a phone that
    /// may answer there lists the others: the same permission mode lets another provider do more.
    public static func groups(_ current: WatcherPhoneState.Current, catalog: [ThreadModel], others: Bool = true) -> [Group] {
        let on = model(current, catalog: catalog)
        let own = catalog.filter { $0.providerId == current.provider && ($0.ready || $0.id == on?.id) }
        var groups = own.isEmpty ? [] : [Group(providerID: current.provider, name: AgentNames.name(current.provider), models: own, own: true)]
        guard others else { return groups }
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

    /// What each chip shows while the computer keeps a choice for Watcher's next turn: that choice, its effort the model's
    /// default where it names none, and its speed where it names one, else Watcher's own.
    public static func values(_ current: WatcherPhoneState.Current, next: WatcherPhoneState.NextTurnOptions?, catalog: [ThreadModel]) -> ThreadSettingValues {
        guard let next else { return values(current, catalog: catalog) }
        let kept = CatalogEntry.model(catalog, id: next.modelId)
        return ThreadSettingValues(model: next.modelId, effort: next.reasoningEffort ?? kept?.defaultReasoningEffort ?? "", permissions: "",
                                   speed: (next.speedChosen ? next.speed : current.speed) ?? ThreadSettings.standard)
    }

    /// What holds the model, effort and speed chips while Watcher is busy. A computer that keeps a change for Watcher's next
    /// turn (`WatcherWire.settingsLaterFeature`) holds them for none of it; an older one refuses a change while Watcher's
    /// turn runs or a card of its own waits (`working`), or while a message to it is on its way.
    public enum BusyHold: Equatable, Sendable { case working, messageOnItsWay }
    public static func busyHold(keptForNextTurn: Bool, working: Bool, messageOnItsWay: Bool) -> BusyHold? {
        if keptForNextTurn { return nil }
        return working ? .working : messageOnItsWay ? .messageOnItsWay : nil
    }
    /// The effort levels Watcher's chip offers on a model: the model's own, without Ultracode, which is a person's choice
    /// for a thread and never Watcher's (ADR-0148, decision 6).
    public static func efforts(_ model: ThreadModel?) -> [String] { (model?.reasoningEfforts ?? []).filter { $0 != "ultracode" } }

    /// Whether the effort Watcher's chip shows is the top its model offers Watcher, where its box's trace lights: Max on
    /// a Claude model, since Ultracode is never Watcher's.
    public static func atTopEffort(_ values: ThreadSettingValues, catalog: [ThreadModel]) -> Bool {
        EffortWords.isTop(efforts(CatalogEntry.model(catalog, id: values.model)), level: values.effort)
    }

    /// Whether a model is another provider's, so choosing it starts a new Watcher.
    public static func replaces(_ modelID: String, current: WatcherPhoneState.Current, catalog: [ThreadModel]) -> Bool {
        guard let chosen = CatalogEntry.model(catalog, id: modelID) else { return false }
        return chosen.providerId != nil && chosen.providerId != current.provider
    }

    /// The operation a press sends, or nil where there is nothing to change: a model on its own (Watcher's provider picks
    /// the new model's effort), or the effort or speed on the model the chips show, which is the one kept for Watcher's next
    /// turn while one waits. Never the permissions.
    public static func press(_ kind: ThreadSettingKind, value: String, current: WatcherPhoneState.Current,
                             next: WatcherPhoneState.NextTurnOptions? = nil, catalog: [ThreadModel]) -> [String: JSONValue]? {
        let shown = values(current, next: next, catalog: catalog)
        guard kind != .permissions, shown[kind] != value else { return nil }
        let shownModel = CatalogEntry.model(catalog, id: shown.model)
        switch kind {
        case .model:
            guard let chosen = CatalogEntry.model(catalog, id: value), let provider = chosen.providerId, providers.contains(provider) else { return nil }
            // The model the chips show, listed under its base, leaves it where it is.
            if chosen.id == shownModel?.id { return nil }
            return WatcherWire.open(target: current.target, provider: provider, modelID: chosen.id)
        case .effort:
            guard efforts(shownModel).contains(value) else { return nil }
            return WatcherWire.open(target: current.target, provider: current.provider, modelID: shown.model, effort: value)
        case .speed:
            // The model goes with the change, so the effort goes too: a model named alone takes its default effort.
            return WatcherWire.open(target: current.target, provider: current.provider, modelID: shown.model,
                                    effort: shown.effort, speed: value)
        case .permissions:
            return nil
        }
    }
}
