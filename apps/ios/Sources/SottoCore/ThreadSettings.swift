import Foundation

// A running thread's settings from its reply box (ADR-0166): the model, the effort, the speed and the permissions, as
// the desktop's option chips set them. The iPhone sends the desktop's own `configure-thread` and follows its rules
// (`ThreadOptions.tsx`, `pendingSettings.ts`): only the thread's own provider's models, the chips held still while the
// provider would refuse a change, and a permission change marked until the provider confirms it.

/// A speed a model offers besides Standard (ADR-0143), in the provider's own name and words.
public struct ModelSpeed: Decodable, Equatable, Sendable {
    public let id: String; public let name: String; public let description: String?
    public init(id: String, name: String, description: String? = nil) { self.id = id; self.name = name; self.description = description }
}
/// The older way a catalog said a model has Fast: present only then, with the provider's line about what it costs.
public struct ModelFastMode: Decodable, Equatable, Sendable { public let description: String? }

/// The four things a thread's chips set. Speed is the bolt.
public enum ThreadSettingKind: String, CaseIterable, Sendable { case model, effort, permissions, speed }

/// A thread settings change the provider never gave a result for (`unconfirmedSettings` in the shell): the computer keeps
/// it for the thread's next start and takes no other action on the thread meanwhile. Read by which fields it names; a
/// speed of null is Standard, so naming the field is what counts.
public struct UnconfirmedSetting: Decodable, Equatable, Sendable {
    public let threadId: String
    public let kinds: Set<ThreadSettingKind>
    private enum Keys: String, CodingKey { case threadId, modelId, reasoningEffort, runtimeMode, providerMode, speed, fastMode }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        threadId = try c.decode(String.self, forKey: .threadId)
        var kinds = Set<ThreadSettingKind>()
        if c.contains(.modelId) { kinds.insert(.model) }
        if c.contains(.reasoningEffort) { kinds.insert(.effort) }
        if c.contains(.runtimeMode) || c.contains(.providerMode) { kinds.insert(.permissions) }
        if c.contains(.speed) || c.contains(.fastMode) { kinds.insert(.speed) }
        self.kinds = kinds
    }
}

/// One value per chip, as strings: a model ID, an effort level, a permission mode, and `standard`, `fast` or `ultrafast`.
public struct ThreadSettingValues: Equatable, Sendable {
    public var model: String; public var effort: String; public var permissions: String; public var speed: String
    public init(model: String, effort: String, permissions: String, speed: String) {
        self.model = model; self.effort = effort; self.permissions = permissions; self.speed = speed
    }
    public subscript(kind: ThreadSettingKind) -> String {
        get {
            switch kind { case .model: return model; case .effort: return effort; case .permissions: return permissions; case .speed: return speed }
        }
        set {
            switch kind { case .model: model = newValue; case .effort: effort = newValue; case .permissions: permissions = newValue; case .speed: speed = newValue }
        }
    }
}

/// The rules a thread's chips follow, as the desktop's option chips do: what each shows, what a press sends, which models
/// are offered, and when they are held.
public enum ThreadSettings {
    /// Standard speed, as a chip holds it.
    public static let standard = "standard"
    /// Sotto's own permission modes, the ones a `runtimeMode` may name.
    public static let runtimeModes: Set<String> = ["approval-required", "auto-accept-edits", "auto", "full-access"]

    /// The speed the thread chose (ADR-0143): its own `speed`, else the older `fastMode`, else Standard.
    public static func speed(of thread: ThreadSummary) -> String { thread.speed ?? (thread.fastMode == true ? "fast" : standard) }

    /// Whether the model's permission list is its provider's own, not Sotto's four.
    public static func usesProviderModes(_ model: ThreadModel?) -> Bool { !(model?.providerModes ?? []).isEmpty }

    /// Each chip's value on this thread as its own model reads it: the defaults are the model's.
    public static func values(_ thread: ThreadSummary, model: ThreadModel?) -> ThreadSettingValues {
        let permission = usesProviderModes(model) ? thread.providerMode ?? model?.providerModes?.first?.id : thread.runtimeMode
        return ThreadSettingValues(model: thread.modelId ?? "", effort: thread.reasoningEffort ?? model?.defaultReasoningEffort ?? "",
                                   permissions: permission ?? "", speed: speed(of: thread))
    }

    /// The speeds besides Standard a thread on this model may choose, Fast then Ultra fast: the model's `speeds`, or Fast
    /// alone from the older `fastMode`. Only Claude Code and Codex offer any.
    public static func offeredSpeeds(_ model: ThreadModel?, providerID: String?) -> [ModelSpeed] {
        guard let model, providerID == "claude" || providerID == "codex" else { return [] }
        let listed = model.speeds?.items ?? (model.fastMode.map { [ModelSpeed(id: "fast", name: speedName("fast", offered: []), description: $0.description)] } ?? [])
        return ["fast", "ultrafast"].compactMap { id in listed.first { $0.id == id } }
    }
    /// A speed's name: the provider's where it offers it, Sotto's otherwise, and Standard for the usual speed.
    public static func speedName(_ id: String, offered: [ModelSpeed]) -> String {
        if id == standard { return String(localized: "Standard", bundle: .module, comment: "A thread speed: the model's usual speed and price.") }
        if let own = offered.first(where: { $0.id == id })?.name, !own.isEmpty { return own }
        return id == "ultrafast" ? String(localized: "Ultra fast", bundle: .module, comment: "A thread speed: faster than Fast, at a higher price still.")
            : String(localized: "Fast", bundle: .module, comment: "A thread speed: faster output at a higher price.")
    }
    /// What a speed costs: the provider's own line where it gives one, Sotto's for Claude Code's Fast, a plain one otherwise.
    public static func speedCost(_ speed: ModelSpeed, providerID: String?) -> String {
        if let own = speed.description?.trimmingCharacters(in: .whitespacesAndNewlines), !own.isEmpty {
            return own.last.map { ".!?".contains($0) } == true ? own : own + "."
        }
        return providerID == "claude" && speed.id == "fast"
            ? String(localized: "Up to 2.5x faster output, at twice the price per token.", bundle: .module, comment: "What Claude Code's Fast speed costs.")
            : String(localized: "Faster output, at a higher price.", bundle: .module, comment: "What a faster thread speed costs.")
    }
    /// The speed a press of the bolt steps to: Standard, then each offered speed in turn, then Standard again.
    public static func nextSpeed(_ offered: [ModelSpeed], after value: String) -> String {
        let cycle = [standard] + offered.map(\.id)
        return cycle[((cycle.firstIndex(of: value) ?? 0) + 1) % cycle.count]
    }

    /// The fields a press sends: the model, the effort, the provider's own permission mode or Sotto's, and the speed by
    /// name, or the older `fastMode` to a computer whose catalog names no speeds.
    public static func patch(_ kind: ThreadSettingKind, value: String, model: ThreadModel?) -> [String: JSONValue] {
        switch kind {
        case .model: return ["modelId": .string(value)]
        case .effort: return ["reasoningEffort": .string(value)]
        case .permissions: return usesProviderModes(model) ? ["providerMode": .string(value)] : ["runtimeMode": .string(value)]
        case .speed:
            if model?.speeds == nil, model?.fastMode != nil { return ["fastMode": .bool(value == "fast")] }
            return ["speed": value == standard ? .null : .string(value)]
        }
    }

    /// The models a started thread may change to: its own provider's ready ones, and the one it is on even when its provider
    /// no longer reports it ready. Moving to another provider is a new thread, which the desktop begins (ADR-0089).
    public static func models(for thread: ThreadSummary, in catalog: [ThreadModel]) -> [ThreadModel] {
        let current = CatalogEntry.model(catalog, id: thread.modelId)
        let provider = thread.providerId ?? current?.providerId
        return catalog.filter { model in
            model.id == current?.id || (model.ready && (provider == nil || model.providerId == provider))
        }
    }

    /// The settings on this thread the computer keeps with no result from the provider.
    public static func unconfirmed(_ shell: Shell?, threadID: String) -> Set<ThreadSettingKind> {
        (shell?.unconfirmedSettings?.items ?? []).filter { $0.threadId == threadID }.reduce(into: Set()) { $0.formUnion($1.kinds) }
    }

    /// Whether a prompt to the thread is still on its way to its agent: queued, being sent or not yet confirmed, and not
    /// set aside by the user.
    public static func promptOnItsWay(_ shell: Shell?, threadID: String) -> Bool {
        (shell?.deliveries ?? []).contains { $0.threadId == threadID && $0.setAside != true && ["queued", "submitting", "uncertain"].contains($0.status) }
    }
    /// The model a press of `pressed` asks for: the thread's own ID when it already runs that model as a long-context
    /// variant the catalog lists only as its base, such as `opus[1m]` under Opus, so pressing it leaves the thread where it is.
    public static func modelChoice(_ pressed: String, thread: ThreadSummary, catalog: [ThreadModel]) -> String {
        guard let own = thread.modelId, CatalogEntry.model(catalog, id: own)?.id == pressed else { return pressed }
        return own
    }

    /// Why the chips can't be pressed now, as on the desktop: a turn under way, a request waiting on the user, a settled
    /// or unreachable thread, or a permission change the provider never confirmed. Nil when they can.
    public static func fixed(_ thread: ThreadSummary, providerConnected: Bool, online: Bool, unconfirmed: Set<ThreadSettingKind>,
                             promptOnItsWay: Bool = false) -> FixedReason? {
        if !online || !providerConnected { return .away }
        if thread.archivedAt != nil { return .archived }
        // A prompt still on its way starts a turn, which a change would run behind (`promptOnItsWay` on the desktop).
        if thread.status == "running" || promptOnItsWay { return .working }
        if !thread.requests.isEmpty { return .waiting }
        if unconfirmed.contains(.permissions) { return .unconfirmed }
        return nil
    }
    /// Why the chips are held, each with the hint VoiceOver reads on them in place of what a press does.
    public enum FixedReason: Equatable, Sendable {
        case away, archived, working, waiting, unconfirmed
        /// What a chip's hint says instead of what a press does.
        public var hint: String {
            switch self {
            case .away: return String(localized: "Can change once this thread’s computer and agent are reachable.", bundle: .module)
            case .archived: return String(localized: "This thread is archived, so its settings stay as they are.", bundle: .module)
            case .working: return String(localized: "Can change once this turn ends.", bundle: .module)
            case .waiting: return String(localized: "Can change once you answer what the thread is waiting on.", bundle: .module)
            case .unconfirmed: return String(localized: "Can change once the agent confirms the last permission change.", bundle: .module)
            }
        }
    }
}

/// Effort levels in words, as the desktop says them (`EffortPicker.tsx`).
public enum EffortWords {
    public static func name(_ id: String) -> String {
        switch id {
        case "minimal": return String(localized: "Minimal", bundle: .module, comment: "A reasoning effort level.")
        case "low": return String(localized: "Low", bundle: .module, comment: "A reasoning effort level.")
        case "medium": return String(localized: "Medium", bundle: .module, comment: "A reasoning effort level.")
        case "high": return String(localized: "High", bundle: .module, comment: "A reasoning effort level.")
        case "xhigh": return String(localized: "Extra high", bundle: .module, comment: "A reasoning effort level.")
        case "max": return String(localized: "Max", bundle: .module, comment: "A reasoning effort level, the highest some models offer.")
        // Claude Code's own name, kept as it is (ADR-0148).
        case "ultracode": return "Ultracode"
        default: return id.prefix(1).uppercased() + id.dropFirst()
        }
    }
    /// Whether `level` is the top of `levels`, where the reply box's trace lights, as the desktop's composer does
    /// (`src/shared/topEffort.ts`, ADR-0019): the last level the model offers, whatever its provider, and Max where a level
    /// such as Ultracode sits past it. A model with one level has no top, so a lone Max is not lit either.
    public static func isTop(_ levels: [String], level: String) -> Bool {
        guard levels.count > 1, !level.isEmpty else { return false }
        return levels.last == level || (level == "max" && levels.contains("max"))
    }
    /// One line per level: what it does and what it costs. The top of a longer list gets the top line, whatever its name.
    public static func line(_ id: String, index: Int, count: Int) -> String {
        if id == "ultracode" { return String(localized: "Plans the work and runs it as a team of agents. Uses many more tokens.", bundle: .module, comment: "What the Ultracode effort level does.") }
        if count > 1, index == count - 1 { return String(localized: "Everything the model has. Slowest, costliest.", bundle: .module, comment: "What the highest effort level does.") }
        switch id {
        case "minimal": return String(localized: "Fastest. For the smallest tasks.", bundle: .module, comment: "What the Minimal effort level does.")
        case "low": return String(localized: "Fast. For small, clear tasks.", bundle: .module, comment: "What the Low effort level does.")
        case "medium": return String(localized: "The usual balance of speed and care.", bundle: .module, comment: "What the Medium effort level does.")
        case "high": return String(localized: "Takes longer and catches more.", bundle: .module, comment: "What the High effort level does.")
        case "xhigh": return String(localized: "Much longer. For stubborn problems.", bundle: .module, comment: "What the Extra high effort level does.")
        case "max": return String(localized: "Near the model’s limit. Slow and costly.", bundle: .module, comment: "What the Max effort level does.")
        default: return index == 0 ? String(localized: "Fast. For small, clear tasks.", bundle: .module, comment: "What the Low effort level does.")
            : String(localized: "More time for difficult problems.", bundle: .module, comment: "What an effort level Sotto has no line for does.")
        }
    }
}

/// What the chips say about permissions and about a change that did not land, in the desktop's words
/// (`permissionInForceCaption`, `settingRefusalText`, `unconfirmedSettingText` in `ThreadOptions.tsx`).
public enum ThreadSettingWords {
    /// What a thread does under one of Sotto's modes, said as its agent doing it.
    public static func permissionLine(_ mode: String, provider: String) -> String? {
        switch mode {
        case "approval-required": return String(localized: "Asks before it edits files or runs commands.", bundle: .module, comment: "What a thread does under Ask before actions.")
        case "auto-accept-edits": return String(localized: "Edits files in the project without asking. Asks before commands.", bundle: .module, comment: "What a thread does under Allow edits.")
        case "auto": return String(localized: "\(provider) decides what to ask you about.", bundle: .module, comment: "What a thread does under Allow actions. %@ is the agent's name, such as Codex.")
        case "full-access": return String(localized: "Runs anything without asking, in the project and outside it.", bundle: .module, comment: "What a thread does under Full access.")
        default: return nil
        }
    }
    /// The line above the box while a permission change waits: what is still in force, in the agent's name.
    public static func inForce(provider: String, runtimeMode: String?, providerModeName: String?) -> String {
        if let providerModeName {
            return String(localized: "\(provider) stays on \(providerModeName) until it confirms.", bundle: .module, comment: "The first %@ is the agent's name; the second is the agent's own name for a permission mode.")
        }
        switch runtimeMode {
        case "approval-required": return String(localized: "\(provider) still asks before acting until it confirms.", bundle: .module, comment: "%@ is the agent's name, such as Claude Code.")
        case "auto-accept-edits": return String(localized: "\(provider) still makes edits without asking until it confirms.", bundle: .module, comment: "%@ is the agent's name, such as Claude Code.")
        case "auto": return String(localized: "\(provider) still decides what to ask you about until it confirms.", bundle: .module, comment: "%@ is the agent's name, such as Claude Code.")
        case "full-access": return String(localized: "\(provider) still runs anything without asking until it confirms.", bundle: .module, comment: "%@ is the agent's name, such as Claude Code.")
        default: return String(localized: "\(provider) keeps its own default until it confirms.", bundle: .module, comment: "%@ is the agent's name, such as Claude Code.")
        }
    }
    /// The line after a change the agent did not take, which puts the chip back and offers Try again. With no answer
    /// at all, the chip shows what the thread last reported.
    public static func refusal(provider: String, wanted: String, inForce: String, error: String?) -> String {
        guard let error else {
            return String(localized: "Sotto didn’t get \(provider)’s answer about \(wanted), so this shows what the thread last reported.", bundle: .module, comment: "The first %@ is the agent's name; the second the chosen model, effort, speed or permission mode.")
        }
        if error == providerRejected {
            return String(localized: "\(provider) didn’t switch to \(wanted). The thread stays on \(inForce); nothing else changed.", bundle: .module, comment: "The first %@ is the agent's name; the second and third are a model, effort, speed or permission mode.")
        }
        return String(localized: "\(provider) didn’t switch to \(wanted). \(error)", bundle: .module, comment: "The first %@ is the agent's name, the second the choice; the third is the computer's own reason, in English.")
    }
    /// The line when the agent never gave a result: the computer keeps the change for the thread's next start.
    public static func unconfirmed(provider: String, wanted: String, inForce: String?, error: String?) -> String {
        if let error, ![providerUnconfirmed, settingsUnreconciled].contains(error) { return error }
        if let inForce, inForce != wanted {
            return String(localized: "\(provider) hasn’t confirmed \(wanted). Until it does, a turn can still run on \(inForce).", bundle: .module, comment: "The first %@ is the agent's name; the second and third are a model, effort or speed.")
        }
        return String(localized: "\(provider) hasn’t confirmed \(wanted). The thread starts on it the next time it is used, and Sotto checks it then.", bundle: .module, comment: "The first %@ is the agent's name; the second is a model, effort, speed or permission mode.")
    }
    /// The line when the agent took a model change but not the speed it carried: the thread is on the new model at Standard.
    public static func speedNotCarried(provider: String, wanted: String, model: String) -> String {
        String(localized: "\(provider) didn’t switch to \(wanted). The thread is on \(model) at Standard speed.", bundle: .module, comment: "The first %@ is the agent's name; the second a speed, such as Fast; the third the model the thread is now on.")
    }
    /// What a refusal holds in place of the computer's words when the agent took a model change and dropped its speed.
    public static let speedNotCarriedError = "speed-not-carried"
    /// A chosen effort in a sentence: "High effort".
    public static func effortValue(_ id: String) -> String {
        String(localized: "\(EffortWords.name(id)) effort", bundle: .module, comment: "%@ is a reasoning effort level, such as High.")
    }
    /// The computer's own sentences for a refusal and a lost result (`src/shared/agents.ts`), matched as they come.
    static let providerRejected = "The provider rejected this action. Check its current permissions and account status."
    static let providerUnconfirmed = "The provider did not confirm the result. Sotto will reconcile the existing action when reconnected; it will not resend it."
    static let settingsUnreconciled = "The provider has not confirmed these thread settings in its state. Refresh to reconcile the existing save; it will not be replayed."
}

/// What a thread's chips show between a press and the provider's answer, per setting (`pendingSettings.ts`). A press shows
/// at once. One made while a save of the same setting is on its way waits, and only the last is sent when that save
/// answers. A refusal lets go of the press and keeps what the computer said; a result the agent never gave keeps the
/// press until the thread shows it or the computer lets it go; a confirmed press is held until the thread shows the value
/// the computer answered with, so the chip never steps back through the old value on the way.
public struct PendingThreadSettings: Equatable, Sendable {
    /// A chosen value and the fields that send it.
    public struct Press: Equatable, Sendable { public let value: String; public let patch: [String: JSONValue] }
    public enum Outcome: Equatable, Sendable {
        /// The computer answered and the thread now reads `expected` (nil when the answer no longer lists the thread).
        case confirmed(expected: String?)
        /// The agent or the computer did not take it, in the computer's words, or nil when no answer came back.
        case refused(String?)
        /// The agent never gave a result, and the computer keeps the change for the thread's next start.
        case unconfirmed(String?)
    }
    /// One setting's press while it waits: the newest choice, whether a save is on its way and a press waits behind it,
    /// the value the computer answered with, and a result the agent never gave.
    public struct Entry: Equatable, Sendable {
        public var desired: Press
        public var sending = false
        public var next: Press?
        public var expected: String?
        public var unconfirmed: Unconfirmed?
        /// Counts holds, so a hold's expiry that arrives after a newer press lets go of nothing.
        public var hold = 0
    }
    /// A result the agent never gave: the computer's account, and whether a shell has shown the computer keeping it.
    public struct Unconfirmed: Equatable, Sendable { public let error: String?; public var drawn: Bool }
    /// A change the agent or computer did not take: what was asked for, the fields that ask for it again, and why.
    public struct Refusal: Equatable, Sendable { public let wanted: String; public let patch: [String: JSONValue]; public let error: String? }

    public private(set) var entries: [ThreadSettingKind: Entry] = [:]
    public private(set) var refusals: [ThreadSettingKind: Refusal] = [:]
    /// What the chips last drew, for a save that answers after the thread already shows its value.
    public private(set) var drawn: ThreadSettingValues?
    public init() {}
    public var isEmpty: Bool { entries.isEmpty && refusals.isEmpty }

    /// The value the chip shows because of a press, while there is one.
    public func value(_ kind: ThreadSettingKind) -> String? { entries[kind]?.desired.value }
    /// Whether the agent never gave a result for this setting, and the computer's account of it.
    public func unconfirmed(_ kind: ThreadSettingKind) -> Unconfirmed? { entries[kind]?.unconfirmed }
    /// Whether a save of this setting is on its way now.
    public func sending(_ kind: ThreadSettingKind) -> Bool { entries[kind]?.sending == true }

    /// Chooses `value`. Returns the press to send now, or nil when nothing goes now: the chip already shows it with nothing
    /// pending, or a save of this setting is on its way and this press waits for it.
    public mutating func press(_ kind: ThreadSettingKind, value: String, patch: [String: JSONValue], showing: String, drawn: ThreadSettingValues) -> Press? {
        self.drawn = drawn
        refusals[kind] = nil
        let press = Press(value: value, patch: patch)
        if var entry = entries[kind] {
            if entry.desired.value == value, entry.unconfirmed == nil { return nil }
            entry.desired = press
            entry.unconfirmed = nil
            entry.expected = nil
            entry.hold += 1
            if entry.sending { entry.next = press; entries[kind] = entry; return nil }
            entry.sending = true
            entries[kind] = entry
            return press
        }
        if showing == value { return nil }
        entries[kind] = Entry(desired: press, sending: true)
        return press
    }

    /// A save's answer. Returns the next press to send when a newer one waited for it, which the caller sends in turn.
    public mutating func answered(_ kind: ThreadSettingKind, sent: String, outcome: Outcome) -> Press? {
        guard var entry = entries[kind] else { return nil }
        if let next = entry.next, next.value != sent {
            entry.next = nil
            entries[kind] = entry
            return next
        }
        entry.next = nil
        entry.sending = false
        switch outcome {
        case .unconfirmed(let error):
            entry.unconfirmed = Unconfirmed(error: error, drawn: false)
            entries[kind] = entry
        case .refused(let error):
            entries[kind] = nil
            refusals[kind] = Refusal(wanted: sent, patch: entry.desired.patch, error: error)
        case .confirmed(let expected):
            if expected == nil || drawn?[kind] == expected { entries[kind] = nil }
            else { entry.expected = expected; entry.hold += 1; entries[kind] = entry }
        }
        return nil
    }

    /// The hold token a confirmed press waits under, for the caller to let it go after a while if the thread never shows it.
    public func holdToken(_ kind: ThreadSettingKind) -> Int? {
        guard let entry = entries[kind], !entry.sending, entry.expected != nil else { return nil }
        return entry.hold
    }
    /// Lets go of a confirmed press the thread has not shown in time, unless a newer press took its place.
    public mutating func expire(_ kind: ThreadSettingKind, hold: Int) {
        guard let entry = entries[kind], entry.hold == hold, !entry.sending, entry.expected != nil else { return }
        entries[kind] = nil
    }

    /// The values the thread now shows, and which of its settings the computer keeps unconfirmed. A confirmed press lets
    /// go once they carry what the computer answered with; an unconfirmed one once the thread shows it, or once the
    /// computer, having kept it, no longer does. A refusal goes once the thread shows the value it asked for after all.
    public mutating func observe(_ values: ThreadSettingValues, unconfirmed kept: Set<ThreadSettingKind>) {
        drawn = values
        for kind in ThreadSettingKind.allCases {
            if var entry = entries[kind] {
                if var held = entry.unconfirmed {
                    if kept.contains(kind) { held.drawn = true; entry.unconfirmed = held; entries[kind] = entry }
                    if values[kind] == entry.desired.value || (held.drawn && !kept.contains(kind)) { entries[kind] = nil }
                } else if !entry.sending, let expected = entry.expected, values[kind] == expected {
                    entries[kind] = nil
                }
            }
            if let refusal = refusals[kind], values[kind] == refusal.wanted { refusals[kind] = nil }
        }
    }

    /// What became of a change, read from the shell the computer answered it with. The thread showing the value sent is
    /// the change taken, whatever the shell's shared error says; otherwise an error is the refusal, or a result the agent
    /// never gave where the computer keeps the change. No error and another value is a change taken that something newer
    /// moved on, which the chip shows once the thread does.
    public static func outcome(of reply: Shell, _ kind: ThreadSettingKind, sent: String, threadID: String) -> Outcome {
        guard let thread = reply.host.threads.first(where: { $0.id == threadID }) else {
            return reply.error.map { .refused($0) } ?? .confirmed(expected: nil)
        }
        let now = ThreadSettings.values(thread, model: CatalogEntry.model(reply.host.models ?? [], id: thread.modelId))[kind]
        if now == sent { return .confirmed(expected: now) }
        if let error = reply.error {
            return ThreadSettings.unconfirmed(reply, threadID: threadID).contains(kind) ? .unconfirmed(error) : .refused(error)
        }
        return .confirmed(expected: now)
    }

    /// Records a refusal the caller worked out itself, such as a speed a model change dropped, for its chip's line.
    public mutating func refuse(_ kind: ThreadSettingKind, wanted: String, patch: [String: JSONValue], error: String?) {
        refusals[kind] = Refusal(wanted: wanted, patch: patch, error: error)
    }

    /// Sends a refused press again: what to send, or nil when there is nothing to retry.
    public mutating func retry(_ kind: ThreadSettingKind, drawn: ThreadSettingValues) -> Press? {
        guard let refusal = refusals[kind] else { return nil }
        return press(kind, value: refusal.wanted, patch: refusal.patch, showing: "", drawn: drawn)
    }
}

/// Everything a thread's chips draw, worked out from the thread, its computer's catalog and the presses still pending.
public struct ThreadSettingsPanel: Equatable, Sendable {
    /// The agent's name, or "The provider" when Sotto doesn't know it, for the lines that say what happened.
    public let provider: String
    public let providerID: String?
    /// The models the model chip lists, and the one it shows: the pressed one while a change is on its way.
    public let models: [ThreadModel]
    public let model: ThreadModel?
    public let modelID: String
    /// The levels the model offers, least to most, and the one shown.
    public let efforts: [String]
    public let effort: String
    /// The speeds besides Standard, and the one shown as it runs on this model: a choice the model lacks runs at Standard.
    public let speeds: [ModelSpeed]
    public let speed: String
    public let permissions: [ThreadPermission]
    public let permission: String
    /// Why no chip can be pressed now, or nil; and whether only the model and effort are held, the provider changing a
    /// started thread's permissions alone.
    public let fixed: ThreadSettings.FixedReason?
    public let modelFixed: Bool
    /// Whether this iPhone may choose a mode that lets the thread act without asking.
    public let mayAnswer: Bool
    /// A permission change still waiting on the agent, which marks its chip; and the line saying what is in force.
    public let permissionPending: Bool
    public let caption: String?
    /// Lines under the chips: a change the agent refused, with Try again, or one it never confirmed.
    public let notices: [Notice]
    /// What the chips show with no press pending, which a press is measured against.
    public let drawn: ThreadSettingValues
    public let unpressed: ThreadSettingValues
    /// Whether the effort shown is the model's top, where the reply box's trace lights.
    public var atTopEffort: Bool { EffortWords.isTop(efforts, level: effort) }

    /// A line over the box about one setting, and whether it offers Try again.
    public struct Notice: Equatable, Sendable, Identifiable {
        public let kind: ThreadSettingKind; public let text: String; public let retry: Bool
        public var id: String { kind.rawValue + (retry ? "-refused" : "-unconfirmed") }
    }

    /// The panel for one thread, or nil where its chips stay off the box: a computer that can't change a thread's settings
    /// in place, or a thread whose model its catalog doesn't know.
    public static func make(thread: ThreadSummary, catalog: [ThreadModel], capabilities: ProviderCapabilities?, providerConnected: Bool,
                            online: Bool, mayAnswer: Bool, unconfirmed: Set<ThreadSettingKind>, promptOnItsWay: Bool = false,
                            pending: PendingThreadSettings) -> ThreadSettingsPanel? {
        guard capabilities?.configureThread == true, let confirmed = CatalogEntry.model(catalog, id: thread.modelId) else { return nil }
        let providerID = thread.providerId ?? confirmed.providerId
        let provider = providerID.map { AgentNames.name($0) }
            ?? String(localized: "The provider", bundle: .module, comment: "Stands in for the agent's name at the start of a sentence")
        let drawn = ThreadSettings.values(thread, model: confirmed)
        let modelID = pending.value(.model) ?? drawn.model
        let model = CatalogEntry.model(catalog, id: modelID) ?? confirmed
        // A model change starts on the new model's own default effort, so that is what the effort chip shows meanwhile.
        var unpressed = drawn
        if modelID != drawn.model {
            unpressed = ThreadSettings.values(thread, model: model)
            unpressed.model = modelID
            unpressed.effort = model.defaultReasoningEffort ?? model.reasoningEfforts?.first ?? ""
        }
        let speeds = ThreadSettings.offeredSpeeds(model, providerID: providerID)
        let chosenSpeed = pending.value(.speed) ?? unpressed.speed
        let pendingPermission = pending.value(.permissions) != nil
        let permissionUnconfirmed = pending.unconfirmed(.permissions) != nil
        let caption: String? = pendingPermission && !permissionUnconfirmed
            ? ThreadSettingWords.inForce(provider: provider, runtimeMode: ThreadSettings.usesProviderModes(confirmed) ? nil : drawn.permissions.nilIfEmpty,
                                         providerModeName: ThreadSettings.usesProviderModes(confirmed) ? confirmed.permissions.first { $0.id == drawn.permissions }?.name : nil)
            : nil
        let fixed = ThreadSettings.fixed(thread, providerConnected: providerConnected, online: online, unconfirmed: unconfirmed, promptOnItsWay: promptOnItsWay)
        func named(_ kind: ThreadSettingKind, _ value: String, on owner: ThreadModel) -> String {
            switch kind {
            case .model: return CatalogEntry.model(catalog, id: value)?.name ?? value
            case .effort: return value.isEmpty ? String(localized: "the model’s default effort", bundle: .module) : ThreadSettingWords.effortValue(value)
            case .permissions: return owner.permissions.first { $0.id == value }?.name ?? value
            case .speed: return ThreadSettings.speedName(value, offered: ThreadSettings.offeredSpeeds(owner, providerID: providerID))
            }
        }
        var notices: [Notice] = []
        for kind in ThreadSettingKind.allCases {
            if let held = pending.unconfirmed(kind), let wanted = pending.value(kind) {
                notices.append(Notice(kind: kind, text: ThreadSettingWords.unconfirmed(provider: provider, wanted: named(kind, wanted, on: model),
                    inForce: kind == .permissions ? nil : named(kind, drawn[kind], on: confirmed), error: held.error), retry: false))
            }
            if let refusal = pending.refusals[kind] {
                let text = kind == .speed && refusal.error == ThreadSettingWords.speedNotCarriedError
                    ? ThreadSettingWords.speedNotCarried(provider: provider, wanted: named(.speed, refusal.wanted, on: model), model: confirmed.name)
                    : ThreadSettingWords.refusal(provider: provider, wanted: named(kind, refusal.wanted, on: model),
                                                 inForce: named(kind, drawn[kind], on: confirmed), error: refusal.error)
                notices.append(Notice(kind: kind, text: text, retry: true))
            }
        }
        return ThreadSettingsPanel(
            provider: provider, providerID: providerID, models: ThreadSettings.models(for: thread, in: catalog), model: model, modelID: modelID,
            efforts: model.reasoningEfforts ?? [], effort: pending.value(.effort) ?? unpressed.effort,
            speeds: speeds, speed: speeds.contains { $0.id == chosenSpeed } ? chosenSpeed : ThreadSettings.standard,
            permissions: model.permissions, permission: pending.value(.permissions) ?? unpressed.permissions,
            fixed: fixed, modelFixed: capabilities?.configureThreadModel == false, mayAnswer: mayAnswer,
            permissionPending: pendingPermission, caption: caption, notices: notices, drawn: drawn, unpressed: unpressed)
    }

    /// Whether a chip of this kind can be pressed now.
    public func pressable(_ kind: ThreadSettingKind) -> Bool {
        guard fixed == nil else { return false }
        return !(modelFixed && (kind == .model || kind == .effort))
    }
    /// Whether Try again can send a refused change now: its chip can be pressed, and a permission mode that grants only where
    /// this iPhone may still answer.
    public func canRetry(_ kind: ThreadSettingKind, wanted: String) -> Bool {
        guard pressable(kind) else { return false }
        guard kind == .permissions else { return true }
        return permissions.first { $0.id == wanted }.map(mayChoose) ?? false
    }
    /// Whether this iPhone may choose a permission mode: asking always, a mode that grants only where it may answer.
    public func mayChoose(_ permission: ThreadPermission) -> Bool { !permission.grants || mayAnswer }
    /// The chosen permission mode, as the chip names it.
    public var permissionName: String? { permissions.first { $0.id == permission }?.name }
    /// Whether the chosen permission lets the thread act without asking, which its shield shows.
    public var permissionGrants: Bool { permissions.first { $0.id == permission }?.grants ?? false }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
