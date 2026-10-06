import XCTest
@testable import SottoCore

final class NewThreadsTests: XCTestCase {
    private func model(_ extra: String = "") throws -> ThreadModel {
        try JSONDecoder().decode(ThreadModel.self, from: Data(#"{"id":"opaque-model","name":"Model","provider":"Codex","providerId":"codex","ready":true,"reasoningEfforts":["low","high"],"defaultReasoningEffort":"high","runtimeModes":["approval-required","full-access"]\#(extra)}"#.utf8))
    }
    private func create(_ model: ThreadModel, effort: String = "high", permission: String = "approval-required", mayAnswer: Bool = false) throws -> JSONValue {
        try Commands.createThread(projectID: "opaque-project", threadID: "00000000-0000-4000-8000-000000000001",
                                  model: model, effort: effort, permissionID: permission, mayAnswer: mayAnswer)
    }
    func testCreationUsesThePhoneThreadIDAndExplicitAskingMode() throws {
        let command = try create(model())
        XCTAssertEqual(command["threadId"], .string("00000000-0000-4000-8000-000000000001"))
        XCTAssertEqual(command["projectId"], .string("opaque-project"))
        XCTAssertEqual(command["modelId"], .string("opaque-model"))
        XCTAssertEqual(command["runtimeMode"], .string("approval-required"))
        XCTAssertEqual(command["workingCopy"], .string("shared"))
        XCTAssertEqual(command["managed"], .bool(false))
        XCTAssertEqual(command["titleSource"], .string("default"))
        XCTAssertEqual(command["text"], .null)
    }
    func testUnknownEffortOrPermissionCannotBeSent() throws {
        XCTAssertThrowsError(try create(model(), effort: "ultra"))
        XCTAssertThrowsError(try create(model(), permission: "invented"))
        XCTAssertThrowsError(try Commands.createThread(projectID: "p", threadID: "native-thread", model: model(),
                                                       effort: "high", permissionID: "approval-required", mayAnswer: false))
    }
    func testPermissiveModeNeedsAnswerAuthorityAndIsNeverTheDefault() throws {
        let value = try model()
        XCTAssertEqual(value.startingPermission, "approval-required")
        XCTAssertThrowsError(try create(value, permission: "full-access"))
        XCTAssertEqual(try create(value, permission: "full-access", mayAnswer: true)["runtimeMode"], .string("full-access"))
    }
    func testProviderProfilesUseTheirAllowanceNotTheirNameOrPosition() throws {
        let value = try model(#", "providerModes":[{"id":"bypass","name":"Ask first"},{"id":"safe","name":"Code","allows":"nothing"}]"#)
        XCTAssertEqual(value.startingPermission, "safe")
        let command = try create(value, permission: "safe")
        XCTAssertEqual(command["providerMode"], .string("safe")); XCTAssertEqual(command["runtimeMode"], .null)
        XCTAssertThrowsError(try create(value, permission: "bypass"))
    }
    func testAHostWithoutAnAskingModeDoesNotSelectAGrant() throws {
        let value = try model(#", "providerModes":[{"id":"grant","name":"Code","allows":"everything"}]"#)
        XCTAssertEqual(value.startingPermission, "")
        XCTAssertThrowsError(try create(value, permission: ""))
    }
    func testEffortComesFromTheModelsAdvertisedDefault() throws {
        XCTAssertEqual(try model().startingEffort, "high")
    }
    func testAnUnavailableSavedModelRequiresAChoiceInsteadOfFallingBack() throws {
        let shell = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","configuration":{"newThreadModelId":"missing"},"host":{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"m","name":"Model","provider":"Codex","ready":true,"recommended":true}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}}"#.utf8))
        XCTAssertEqual(NewThreads.startingModelID(shell), "missing")
        XCTAssertEqual(NewThreads.availableModels(shell.host).map(\.id), ["m"])
    }
    func testSavedEffortMapsAcrossTheComputersModelCatalog() throws {
        let shell = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","configuration":{"newThreadModelId":"original","newThreadReasoningEffort":"medium"},"host":{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"original","name":"Original","provider":"Codex","ready":true,"reasoningEfforts":["low","medium","high"]}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}}"#.utf8))
        XCTAssertEqual(NewThreads.startingEffort(try model(), shell: shell), "high")
    }
    func testProjectRegistrationAttachesTheExistingHostFolder() throws {
        let command = try Commands.createProject(providerID: "claude", title: "Panel tools", path: #"D:\Engineering\Panel tools"#)
        XCTAssertEqual(command["path"], .string(#"D:\Engineering\Panel tools"#))
        XCTAssertEqual(command["useExisting"], .bool(true))
        XCTAssertEqual(command["provider"], .string("claude"))
        XCTAssertThrowsError(try Commands.createProject(providerID: "unknown", title: "Project", path: "/tmp/project"))
    }
    func testFolderRequestsDistinguishHomeDrivesAndAHostPath() throws {
        XCTAssertEqual(try NewThreads.folderRequest()["request"], .object([:]))
        XCTAssertEqual(try NewThreads.folderRequest(path: .null)["request"], .object(["path": .null]))
        XCTAssertEqual(try NewThreads.folderRequest(path: .string(#"D:\"#))["request"], .object(["path": .string(#"D:\"#)]))
        XCTAssertThrowsError(try NewThreads.folderRequest(path: .string("")))
    }
    func testFolderIdentityPreservesPOSIXCaseAndWindowsDriveRoots() {
        XCTAssertTrue(NewThreads.sameFolder(#"D:\Panel\"#, "d:/panel", separator: "\\"))
        XCTAssertTrue(NewThreads.sameFolder(#"D:\"#, "d:/", separator: "\\"))
        XCTAssertTrue(NewThreads.sameFolder("/home/zach/project/", "/home/zach/project", separator: "/"))
        XCTAssertFalse(NewThreads.sameFolder("/home/Zach", "/home/zach", separator: "/"))
        XCTAssertFalse(NewThreads.sameFolder("/home/zach", "home/zach", separator: "/"))
        XCTAssertFalse(NewThreads.sameFolder(nil, "/home/zach", separator: "/"))
        XCTAssertFalse(NewThreads.sameFolder("/:Project", "/:project", separator: "/"))
    }
    func testUnavailableProvidersAreNotCreationChoices() throws {
        let host = try JSONDecoder().decode(HostSnapshot.self, from: Data(#"{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"m","name":"Model","provider":"Codex","providerId":"codex","ready":true}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true},"providers":[{"id":"codex","connection":"disconnected","capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}]}"#.utf8))
        XCTAssertTrue(NewThreads.availableModels(host).isEmpty)
    }
    func testFolderStatusesFailClosedAndDrivesCannotBeSelectedAsAProject() throws {
        let missing = try JSONDecoder().decode(FolderResult.self, from: Data(#"{"status":"missing","path":"/gone"}"#.utf8))
        guard case .missing = missing else { return XCTFail("Wrong folder status") }
        XCTAssertThrowsError(try JSONDecoder().decode(FolderResult.self, from: Data(#"{"status":"future"}"#.utf8)))
        let drives = try JSONDecoder().decode(FolderResult.self, from: Data(#"{"status":"listed","path":null,"home":"C:\\Users\\Zach","separator":"\\","crumbs":[{"name":"Drives","path":null}],"folders":[{"name":"D:","path":"D:\\","git":false}],"truncated":false}"#.utf8))
        guard case .listed(let value) = drives else { return XCTFail("Missing drive listing") }
        XCTAssertNil(value.path); XCTAssertEqual(value.folders.first?.path, #"D:\"#)
    }
    func testANewWorktreeChangesOnlyTheWorkingCopy() throws {
        let value = try model()
        let shared = try create(value)
        let worktree = try Commands.createThread(projectID: "opaque-project", threadID: "00000000-0000-4000-8000-000000000001",
                                                 model: value, effort: "high", permissionID: "approval-required", mayAnswer: false,
                                                 workingCopy: .independent)
        XCTAssertEqual(shared["workingCopy"], .string("shared"))
        XCTAssertEqual(worktree["workingCopy"], .string("independent"))
        guard case .object(var sharedFields) = shared, case .object(var worktreeFields) = worktree else { return XCTFail("Not an object") }
        sharedFields["workingCopy"] = nil; worktreeFields["workingCopy"] = nil
        XCTAssertEqual(sharedFields, worktreeFields, "Nothing else in the command changes")
        XCTAssertNil(worktreeFields["baseBranch"], "The host chooses the base branch")
        XCTAssertNil(worktreeFields["startFromOrigin"])
        XCTAssertTrue(RemoteCommands.allowed["create-thread"]?.contains("workingCopy") == true)
    }
    private func shell(saved: String = "") throws -> Shell {
        try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h",\#(saved)"host":{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"first","name":"First","provider":"Codex","ready":true,"recommended":true,"reasoningEfforts":["low","high"]},{"id":"second","name":"Second","provider":"Codex","ready":true,"reasoningEfforts":["low","medium","high"]},{"id":"off","name":"Off","provider":"Codex","ready":false}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}}"#.utf8))
    }
    func testAModelDefaultAppliesOnlyWhereTheComputerOffersIt() throws {
        let saved = try shell(saved: #""configuration":{"newThreadModelId":"first","newThreadReasoningEffort":"low"},"#)
        XCTAssertEqual(NewThreads.startingModelID(saved, defaults: NewThreadDefaults(modelID: "second")), "second")
        XCTAssertEqual(NewThreads.startingModelID(saved, defaults: NewThreadDefaults(modelID: "elsewhere")), "first", "The computer's own choice")
        XCTAssertEqual(NewThreads.startingModelID(saved, defaults: NewThreadDefaults(modelID: "off")), "first", "A model that isn't ready is not offered")
        XCTAssertEqual(NewThreads.startingModelID(try shell(), defaults: NewThreadDefaults()), "first")
    }
    func testAnEffortDefaultAppliesOnlyWhereTheModelOffersIt() throws {
        let saved = try shell(saved: #""configuration":{"newThreadReasoningEffort":"low"},"#)
        let second = try XCTUnwrap(saved.host.models?.first { $0.id == "second" })
        XCTAssertEqual(NewThreads.startingEffort(second, shell: saved, defaults: NewThreadDefaults(effort: "medium")), "medium")
        let first = try XCTUnwrap(saved.host.models?.first { $0.id == "first" })
        XCTAssertEqual(NewThreads.startingEffort(first, shell: saved, defaults: NewThreadDefaults(effort: "medium")), "low", "The computer's own choice")
    }
    func testAPermissionDefaultThatGrantsNeedsCanAnswer() throws {
        let value = try model()
        let full = NewThreadDefaults(permissionID: "full-access")
        XCTAssertEqual(NewThreads.startingPermission(value, defaults: full, mayAnswer: true), StartingPermission(id: "full-access", heldBack: false))
        XCTAssertEqual(NewThreads.startingPermission(value, defaults: full, mayAnswer: false), StartingPermission(id: "approval-required", heldBack: true),
                       "Without Can answer the thread starts by asking, and says why")
        XCTAssertEqual(NewThreads.startingPermission(value, defaults: NewThreadDefaults(permissionID: "auto"), mayAnswer: true),
                       StartingPermission(id: "approval-required", heldBack: false), "A mode this model doesn't offer leaves it asking")
        XCTAssertEqual(NewThreads.startingPermission(value, defaults: NewThreadDefaults(), mayAnswer: true),
                       StartingPermission(id: "approval-required", heldBack: false), "No default never selects a grant")
        let profiles = try model(#", "providerModes":[{"id":"bypass","name":"Bypass"},{"id":"plan","name":"Plan","allows":"nothing"},{"id":"safe","name":"Ask","allows":"nothing"}]"#)
        XCTAssertEqual(NewThreads.startingPermission(profiles, defaults: NewThreadDefaults(permissionID: "safe"), mayAnswer: false).id, "safe",
                       "A mode that grants nothing applies without Can answer")
    }
    func testWorkingCopyStartsSharedUnlessTheDefaultSaysOtherwise() {
        XCTAssertEqual(NewThreads.startingWorkingCopy(NewThreadDefaults()), .shared)
        XCTAssertEqual(NewThreads.startingWorkingCopy(NewThreadDefaults(workingCopy: .independent)), .independent)
    }
    func testCatalogUnionListsEachReadyModelOnce() throws {
        let laptop = try shell().host
        let forge = try JSONDecoder().decode(HostSnapshot.self, from: Data(#"{"name":"Forge","threads":[],"projects":[],"models":[{"id":"second","name":"Second","provider":"Codex","ready":true},{"id":"third","name":"Third","provider":"Codex","ready":true}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}"#.utf8))
        XCTAssertEqual(NewThreads.catalogUnion([laptop, forge]).map(\.id), ["first", "second", "third"])
    }
    func testCreationMarkersPersistOnlyIdentity() throws {
        let marker = PendingOperation(hostID: UUID().uuidString, clientID: "phone", threadID: UUID().uuidString, kind: "create-project")
        let fields = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(marker))
        XCTAssertEqual(Set(fields.keys), ["id", "hostID", "clientID", "threadID", "kind"])
    }
}
