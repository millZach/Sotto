import Foundation

public struct ThreadStartPreferences: Decodable, Equatable, Sendable {
    public let newThreadModelId: String?; public let newThreadReasoningEffort: String?
}

/// Display data from this computer's own model catalog. IDs are opaque Sotto IDs.
public struct ThreadModel: Decodable, Identifiable, Equatable, Sendable {
    public let id: String; public let name: String; public let provider: String; public let providerId: String?
    public let ready: Bool; public let recommended: Bool?
    public let reasoningEfforts: [String]?; public let defaultReasoningEffort: String?
    public let runtimeModes: [String]?; public let providerModes: [ProviderMode]?
    /// Whether the model reads images. Only a model that says so is sent photos.
    public let supportsImages: Bool?
    public struct ProviderMode: Decodable, Equatable, Sendable {
        public let id: String; public let name: String; public let allows: String?; public let asks: String?
    }
    public var startingEffort: String {
        if let value = defaultReasoningEffort, reasoningEfforts?.contains(value) == true { return value }
        return reasoningEfforts?.first ?? ""
    }
    public var permissions: [ThreadPermission] {
        if let modes = providerModes, !modes.isEmpty {
            return modes.map { ThreadPermission(id: $0.id, name: $0.name, asks: $0.asks,
                                               grants: $0.allows != "nothing", providerOwned: true) }
        }
        let labels = ["approval-required": "Ask before actions", "auto-accept-edits": "Allow edits",
                      "auto": "Allow actions", "full-access": "Full access"]
        return (runtimeModes ?? []).compactMap { id in
            labels[id].map { ThreadPermission(id: id, name: $0, asks: nil,
                                             grants: id != "approval-required", providerOwned: false) }
        }
    }
    /// Prefer an asking mode. A grant is never selected just because Can answer is on.
    public var startingPermission: String { permissions.first { !$0.grants }?.id ?? "" }
}
public struct ThreadPermission: Identifiable, Sendable {
    public let id: String; public let name: String; public let asks: String?
    public let grants: Bool; public let providerOwned: Bool
}

public struct HostFolder: Decodable, Identifiable, Sendable {
    public let name: String; public let path: String; public let git: Bool
    public var id: String { path }
}
public struct FolderCrumb: Decodable, Sendable { public let name: String; public let path: String? }
public struct FolderListing: Decodable, Sendable {
    public let path: String?; public let home: String; public let separator: String
    public let crumbs: [FolderCrumb]; public let folders: [HostFolder]; public let truncated: Bool
    /// Use the host's spelling, including drive roots; never apply iPhone URL/path rules.
    public var projectName: String {
        let name = crumbs.last?.name ?? "Project"
        return name.hasSuffix(":") ? String(name.dropLast()) + " drive" : name == "/" ? "Root" : name
    }
}
public enum FolderResult: Decodable, Sendable {
    case listed(FolderListing), missing, unreadable
    private enum Keys: String, CodingKey { case status }
    public init(from decoder: Decoder) throws {
        switch try decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .status) {
        case "listed":
            let value = try FolderListing(from: decoder)
            guard ["/", "\\"].contains(value.separator), !value.crumbs.isEmpty,
                  value.crumbs.count <= 256, value.folders.count <= 1000,
                  value.path == nil || !(value.path ?? "").isEmpty else { throw ClientError.invalidProtocol }
            self = .listed(value)
        case "missing": self = .missing
        case "unreadable": self = .unreadable
        default: throw ClientError.invalidProtocol
        }
    }
}

/// Where a new thread works: the project's shared folder, or its own folder on a new branch (`independent`, the
/// host's word for a new worktree).
public enum WorkingCopy: String, CaseIterable, Sendable {
    case shared, independent
}

/// The choices this iPhone keeps for new threads (ADR-0051). Nil where the computer's own choice applies.
public struct NewThreadDefaults: Equatable, Sendable {
    public var modelID: String?; public var effort: String?; public var permissionID: String?; public var workingCopy: WorkingCopy?
    public init(modelID: String? = nil, effort: String? = nil, permissionID: String? = nil, workingCopy: WorkingCopy? = nil) {
        self.modelID = modelID; self.effort = effort; self.permissionID = permissionID; self.workingCopy = workingCopy
    }
}

/// The permission New thread starts on, and whether a default that grants was held back because the computer
/// doesn't let this iPhone answer.
public struct StartingPermission: Equatable, Sendable {
    public let id: String; public let heldBack: Bool
    public init(id: String, heldBack: Bool) { self.id = id; self.heldBack = heldBack }
}

public enum NewThreads {
    public static func startingModelID(_ shell: Shell) -> String {
        if let selected = shell.configuration?.newThreadModelId, !selected.isEmpty { return selected }
        let available = availableModels(shell.host)
        return (available.first { $0.recommended == true } ?? available.first)?.id ?? ""
    }
    public static func startingEffort(_ model: ThreadModel, shell: Shell) -> String {
        guard let desired = shell.configuration?.newThreadReasoningEffort, !desired.isEmpty,
              let offered = model.reasoningEfforts, !offered.isEmpty else { return model.startingEffort }
        if offered.contains(desired) { return desired }
        let reference = shell.host.models?.first { $0.id == shell.configuration?.newThreadModelId }?.reasoningEfforts ?? offered
        guard let position = reference.firstIndex(of: desired), reference.count >= 2 else { return model.startingEffort }
        return offered[Int((Double(position) / Double(reference.count - 1) * Double(offered.count - 1)).rounded())]
    }
    /// The model New thread starts on: this iPhone's default where the computer offers it ready, otherwise the
    /// computer's own saved choice (ADR-0051).
    public static func startingModelID(_ shell: Shell, defaults: NewThreadDefaults) -> String {
        if let preferred = defaults.modelID, availableModels(shell.host).contains(where: { $0.id == preferred }) { return preferred }
        return startingModelID(shell)
    }
    /// The effort New thread starts on: this iPhone's default where the model offers it, otherwise the computer's.
    public static func startingEffort(_ model: ThreadModel, shell: Shell, defaults: NewThreadDefaults) -> String {
        if let preferred = defaults.effort, model.reasoningEfforts?.contains(preferred) == true { return preferred }
        return startingEffort(model, shell: shell)
    }
    /// The permission New thread starts on. This iPhone's default applies where the model offers it, but one that
    /// lets the thread act without asking applies only while the computer lets this iPhone answer (ADR-0033);
    /// otherwise the thread starts by asking, and `heldBack` says why the default didn't apply.
    public static func startingPermission(_ model: ThreadModel, defaults: NewThreadDefaults, mayAnswer: Bool) -> StartingPermission {
        let asking = model.startingPermission
        guard let preferred = defaults.permissionID,
              let permission = model.permissions.first(where: { $0.id == preferred }) else { return StartingPermission(id: asking, heldBack: false) }
        if permission.grants && !mayAnswer { return StartingPermission(id: asking, heldBack: true) }
        return StartingPermission(id: permission.id, heldBack: false)
    }
    /// Every computer offers both working copies; without a default a thread shares the project's folder.
    public static func startingWorkingCopy(_ defaults: NewThreadDefaults) -> WorkingCopy { defaults.workingCopy ?? .shared }
    /// The ready models of several computers as one list, each model once, in the order the computers list them.
    public static func catalogUnion(_ hosts: [HostSnapshot]) -> [ThreadModel] {
        var seen = Set<String>()
        var models: [ThreadModel] = []
        for host in hosts {
            for model in availableModels(host) where seen.insert(model.id).inserted { models.append(model) }
        }
        return models
    }
    public static func availableModels(_ host: HostSnapshot) -> [ThreadModel] {
        (host.models ?? []).filter { model in
            guard model.ready else { return false }
            if let providers = host.providers {
                guard let provider = providers.first(where: { $0.id == model.providerId }) else { return false }
                return provider.connection == "connected" && provider.capabilities.threads == true
            }
            return host.capabilities.threads == true
        }
    }
    /// The host declares its path format. Windows compares without case; POSIX preserves it.
    public static func sameFolder(_ lhs: String?, _ rhs: String, separator: String) -> Bool {
        guard let lhs else { return false }
        func key(_ value: String) -> String {
            let normalized = separator == "\\" ? value.replacingOccurrences(of: "\\", with: "/").lowercased() : value
            var result = normalized
            while result.count > 1 && result.hasSuffix("/") { result.removeLast() }
            return result
        }
        return key(lhs) == key(rhs)
    }
    public static func folderRequest(path: JSONValue? = nil) throws -> [String: JSONValue] {
        if let path, path != .null {
            guard let value = path.string, !value.isEmpty, value.utf16.count <= 4096 else { throw ClientError.invalidRequest }
        }
        return ["op": .string("host-folders"), "request": .object(path.map { ["path": $0] } ?? [:])]
    }
}
extension Commands {
    public static func createProject(providerID: String, title: String, path: String) throws -> JSONValue {
        guard ["codex", "claude", "grok", "devin"].contains(providerID),
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.utf16.count <= 512,
              !path.isEmpty, path.utf16.count <= 4096 else { throw ClientError.invalidRequest }
        return try RemoteCommands.checked(.object(["type": .string("create-project"), "provider": .string(providerID),
            "title": .string(title), "path": .string(path), "useExisting": .bool(true)]))
    }
    /// A manual thread in the project. `workingCopy` is the project's shared folder or a new worktree; the host
    /// chooses the new worktree's base branch, as it does for the desktop's own default.
    public static func createThread(projectID: String, threadID: String, model: ThreadModel,
                                    effort: String, permissionID: String, mayAnswer: Bool,
                                    workingCopy: WorkingCopy = .shared) throws -> JSONValue {
        guard !projectID.isEmpty, projectID.utf16.count <= 6144, UUID(uuidString: threadID) != nil,
              model.ready, !model.id.isEmpty, model.id.utf16.count <= 6144,
              let permission = model.permissions.first(where: { $0.id == permissionID }),
              !permission.grants || mayAnswer,
              effort.isEmpty || (model.reasoningEfforts?.contains(effort) == true && effort.utf16.count <= 64) else { throw ClientError.invalidRequest }
        var fields: [String: JSONValue] = ["type": .string("create-thread"), "projectId": .string(projectID),
            "threadId": .string(threadID), "title": .string("New thread"), "titleSource": .string("default"),
            "modelId": .string(model.id), "workingCopy": .string(workingCopy.rawValue), "managed": .bool(false)]
        fields[permission.providerOwned ? "providerMode" : "runtimeMode"] = .string(permission.id)
        if !effort.isEmpty { fields["reasoningEffort"] = .string(effort) }
        return try RemoteCommands.checked(.object(fields))
    }
}
