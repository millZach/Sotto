import XCTest
import SottoCore

final class NewThreadModelTests: XCTestCase {
    private let laptop = "00000000-0000-4000-8000-000000000001"
    private let forge = "00000000-0000-4000-8000-000000000002"
    private func json(_ value: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(value.utf8)) }
    @MainActor private func fixture(twoComputers: Bool = false, projects: Bool = true) async throws -> AppModel {
        TestKeychain.items = [:]; HostConnection.instances = []; HostConnection.afterGreeting = nil
        HostConnection.failDetail = false; HostConnection.holdDetail = false; HostConnection.mayAnswer = false
        TestKeychain.locked = false; TestKeychain.unreadableAccount = nil
        HostConnection.receipt = .object(["status": .string("unknown")]); HostConnection.loseAcknowledgement = false
        HostConnection.features = ["host-folders"]; HostConnection.receipts = [:]
        HostConnection.shells = [:]; HostConnection.commandHandler = nil; HostConnection.folderHandler = nil
        HostConnection.stageHandler = nil; HostConnection.previewHandler = nil
        let store = TestKeychain.store, hosts = twoComputers ? [laptop, forge] : [laptop]
        try store.write(hosts, account: ComputerStore.indexAccount)
        for host in hosts {
            let pairing = try json(#"{"v":1,"hostId":"\#(host)","clientId":"phone","token":"fixture"}"#).decode(Pairing.self)
            try store.write(SavedComputer(address: "https://laptop.example.ts.net:8443", pairing: pairing), account: ComputerStore.account(host))
            HostConnection.shells[host] = try json(#"{"hostId":"\#(host)","host":{"hostId":"\#(host)","name":"Computer","threads":[],"projects":\#(projects ? #"[{"id":"p","title":"Project","path":"D:\\Project"}]"# : "[]"),"models":[{"id":"m","name":"Model","provider":"Codex","providerId":"codex","ready":true,"runtimeModes":["approval-required","full-access"],"reasoningEfforts":["high"]}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"projects":true,"threads":true},"providers":[{"id":"codex","connection":"connected","capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"projects":true,"threads":true}}]}}"#)
        }
        HostConnection.folderHandler = { _, request in
            let path = request["path"].string ?? #"D:\New project"#
            return try self.json(#"{"status":"listed","path":\#(String(decoding: try JSONEncoder().encode(path), as: UTF8.self)),"home":"C:\\Users\\Zach","separator":"\\","crumbs":[{"name":"New project","path":\#(String(decoding: try JSONEncoder().encode(path), as: UTF8.self))}],"folders":[],"truncated":false}"#)
        }
        HostConnection.commandHandler = { host, command, id in
            var result = HostConnection.shells[host]!
            guard case .object(var root) = result, case .object(var source) = root["host"] else { throw ClientError.invalidProtocol }
            if command["type"] == .string("create-project") {
                source["projects"] = .array([.object(["id": .string("added"), "title": command["title"], "path": command["path"], "providerId": command["provider"]])])
            } else if command["type"] == .string("create-thread") {
                let thread = command["threadId"].string!
                source["threads"] = .array([.object(["id": .string(thread), "projectId": command["projectId"], "title": .string("New thread"),
                                                     "providerId": .string("codex"), "status": .string("idle"), "requests": .array([])])])
                HostConnection.detail = try self.json(#"{"threadId":"\#(thread)","revision":1,"messages":[]}"#)
            }
            if command["type"] == .string("manual-send") {
                root["deliveries"] = .array([.object(["threadId": command["threadId"], "draftId": command["draftId"], "status": .string("accepted")])])
            }
            root["host"] = .object(source); result = .object(root)
            HostConnection.shells[host] = result
            HostConnection.receipts[id] = .object(["status": .string("completed")])
            return result
        }
        let model = AppModel(keychain: TestKeychain.store, receiptSleep: { _ in }); model.phase(.active); await model.reconnectAll()
        return model
    }
    @MainActor private func create(_ model: AppModel, host: String? = nil, folder: FolderListing? = nil, permission: String = "approval-required") async -> ThreadRef? {
        await model.createThread(on: host ?? laptop, projectID: folder == nil ? "p" : nil, folder: folder,
                                 modelID: "m", effort: "high", permissionID: permission)
    }
    @MainActor private func folder(_ model: AppModel) async throws -> FolderListing {
        guard case .listed(let result) = try await model.folders(laptop) else { throw ClientError.invalidProtocol }
        return result
    }
    @MainActor func testAnUnconfirmedCreationIsNotFollowedLikeASend() async throws {
        let model = try await fixture()
        let connection = try XCTUnwrap(HostConnection.instances.last)
        HostConnection.loseAcknowledgement = true
        HostConnection.receipt = .object(["status": .string("pending")])
        let created = await create(model)
        XCTAssertNil(created, "Its sheet says the creation is unconfirmed rather than waiting on the receipt")
        XCTAssertEqual(connection.operations.filter { $0 == "receipt" }.count, 0)
        let marker = try XCTUnwrap(model.pendingCreations.first)
        XCTAssertFalse(model.isSending(marker))
    }
    @MainActor func testCreationGoesOnlyToTheChosenComputerWithSharedOpaqueIDs() async throws {
        let model = try await fixture(twoComputers: true)
        let createdRef = await create(model, host: forge)
        let ref = try XCTUnwrap(createdRef)
        XCTAssertEqual(ref.hostID, forge)
        XCTAssertNotNil(model.thread(ref))
        XCTAssertTrue(model.pendingCreations.isEmpty)
        XCTAssertTrue(HostConnection.instances.filter { $0.hostID == laptop }.allSatisfy { $0.commands.isEmpty })
        let command = try XCTUnwrap(HostConnection.instances.first { $0.hostID == forge }?.commands.first)
        XCTAssertEqual(command["projectId"], .string("p")); XCTAssertEqual(command["threadId"], .string(ref.threadID))
        XCTAssertEqual(command["runtimeMode"], .string("approval-required")); XCTAssertEqual(command["managed"], .bool(false))
    }
    @MainActor func testTheFirstMessageRunsOnTheComputerThatCreatedTheThread() async throws {
        let model = try await fixture(twoComputers: true)
        let created = await create(model, host: forge)
        let ref = try XCTUnwrap(created)
        await model.select(ref)
        XCTAssertEqual(model.detail(for: ref)?.threadId, ref.threadID)
        XCTAssertTrue(model.canSend(ref))
        model.drafts[ref.id] = "Start the project"
        await model.send(ref)
        let commands = HostConnection.instances.filter { $0.hostID == forge }.flatMap(\.commands)
        XCTAssertEqual(commands.map { $0["type"].string }, ["create-thread", "manual-send"])
        XCTAssertEqual(commands.last?["threadId"], .string(ref.threadID))
        XCTAssertTrue(HostConnection.instances.filter { $0.hostID == laptop }.flatMap(\.commands).isEmpty)
        XCTAssertTrue(model.pending(for: ref).isEmpty)
    }
    @MainActor func testAFailedFirstMessageKeepsItsReturnTextExplanation() async throws {
        let model = try await fixture()
        let created = await create(model)
        let ref = try XCTUnwrap(created)
        let accepted = HostConnection.commandHandler!
        HostConnection.commandHandler = { host, command, id in
            guard command["type"] == .string("manual-send"),
                  case .object(var shell) = HostConnection.shells[host]! else { return try await accepted(host, command, id) }
            shell["error"] = .string("The provider refused the message.")
            shell["deliveries"] = .array([.object(["threadId": command["threadId"], "draftId": command["draftId"], "status": .string("failed")])])
            HostConnection.shells[host] = .object(shell)
            return .object(shell)
        }
        model.drafts[ref.id] = "Start this project"
        await model.send(ref)
        XCTAssertTrue(model.feedback?.contains("wasn’t sent. Its text is back in that thread.") == true)
        model.restoreReply(ref)
        XCTAssertEqual(model.drafts[ref.id], "Start this project")
        XCTAssertTrue(model.pending(for: ref).isEmpty)
    }
    @MainActor func testAnUnavailableProjectDoesNotSendACreationCommand() async throws {
        let model = try await fixture(projects: false)
        let result = await create(model)
        XCTAssertNil(result)
        XCTAssertTrue(HostConnection.instances.flatMap(\.commands).isEmpty)
        XCTAssertTrue(model.pendingCreations.isEmpty)
    }
    @MainActor func testNewFolderRegistersBeforeCreatingTheThread() async throws {
        let model = try await fixture(projects: false), selected = try await folder(model)
        let createdRef = await create(model, folder: selected)
        let ref = try XCTUnwrap(createdRef)
        let commands = HostConnection.instances.first { $0.hostID == laptop }!.commands
        XCTAssertEqual(commands.map { $0["type"].string }, ["create-project", "create-thread"])
        XCTAssertEqual(commands[0]["path"], .string(#"D:\New project"#)); XCTAssertEqual(commands[0]["useExisting"], .bool(true))
        XCTAssertEqual(commands[1]["projectId"], .string("added"))
        XCTAssertEqual(model.thread(ref)?.projectId, "added")
    }
    @MainActor func testAnAlreadyKnownFolderDoesNotRegisterTwice() async throws {
        let model = try await fixture()
        guard case .listed(let selected) = try await model.folders(laptop, path: .string(#"d:\project\"#)) else { return XCTFail("No listing") }
        let creation1 = await create(model, folder: selected)
        XCTAssertNotNil(creation1)
        XCTAssertEqual(HostConnection.instances.first { $0.hostID == laptop }!.commands.map { $0["type"].string }, ["create-thread"])
    }
    @MainActor func testAChangedOrUnreadableFolderDoesNotCreateAnything() async throws {
        let model = try await fixture(projects: false), selected = try await folder(model)
        HostConnection.folderHandler = { _, _ in try self.json(#"{"status":"missing","path":"D:\\New project"}"#) }
        let creation2 = await create(model, folder: selected)
        XCTAssertNil(creation2)
        XCTAssertTrue(HostConnection.instances.first { $0.hostID == laptop }!.commands.isEmpty)
        XCTAssertTrue(model.pendingCreations.isEmpty)
    }
    @MainActor func testFolderFeatureIsRequiredBeforeAnyListingRequest() async throws {
        let model = try await fixture()
        HostConnection.features = []; await model.connect(laptop)
        XCTAssertFalse(model.canBrowseFolders(laptop))
        do { _ = try await model.folders(laptop); XCTFail("Sent an unsupported feature") } catch {}
        XCTAssertFalse(HostConnection.instances.first { $0.hostID == laptop }!.operations.contains("host-folders"))
    }
    @MainActor func testUnconfirmedCreationBlocksAnotherTapAndReconcilesByItsThreadID() async throws {
        let model = try await fixture()
        let accepted = HostConnection.commandHandler!
        HostConnection.commandHandler = { host, command, id in
            _ = try await accepted(host, command, id)
            HostConnection.receipts[id] = nil
            throw ClientError.disconnected
        }
        let creation3 = await create(model)
        XCTAssertNil(creation3)
        let marker = try XCTUnwrap(model.pendingCreations.first)
        let creation4 = await create(model)
        XCTAssertNil(creation4)
        XCTAssertEqual(HostConnection.instances.first { $0.hostID == laptop }!.commands.count, 1)
        await model.checkDelivery(laptop)
        XCTAssertTrue(model.pendingCreations.isEmpty)
        XCTAssertNotNil(model.thread(ThreadRef(hostID: laptop, threadID: marker.threadID)))
        XCTAssertEqual(HostConnection.instances.first { $0.hostID == laptop }!.commands.count, 1)
    }
    @MainActor func testRestartFindsAnUnconfirmedThreadWithoutReplayingItsCommand() async throws {
        let model = try await fixture()
        let accepted = HostConnection.commandHandler!
        HostConnection.commandHandler = { host, command, id in
            _ = try await accepted(host, command, id); HostConnection.receipts[id] = nil; throw ClientError.disconnected
        }
        _ = await create(model)
        let marker = try XCTUnwrap(model.pendingCreations.first)
        let restarted = AppModel(keychain: TestKeychain.store); restarted.phase(.active); await restarted.reconnectAll()
        XCTAssertTrue(restarted.pendingCreations.isEmpty)
        XCTAssertNotNil(restarted.thread(ThreadRef(hostID: laptop, threadID: marker.threadID)))
        XCTAssertEqual(HostConnection.instances.flatMap(\.commands).count, 1)
    }
    @MainActor func testUnknownProjectRegistrationDoesNotContinueOrResend() async throws {
        let model = try await fixture(projects: false), selected = try await folder(model)
        let accepted = HostConnection.commandHandler!
        HostConnection.commandHandler = { host, command, id in
            _ = try await accepted(host, command, id); HostConnection.receipts[id] = nil; throw ClientError.disconnected
        }
        let creation5 = await create(model, folder: selected)
        XCTAssertNil(creation5)
        await model.checkDelivery(laptop)
        XCTAssertEqual(model.pendingCreations.first?.kind, "create-project")
        let creation6 = await create(model, folder: selected)
        XCTAssertNil(creation6)
        XCTAssertEqual(HostConnection.instances.flatMap(\.commands).map { $0["type"].string }, ["create-project"])
    }
    @MainActor func testAProviderGrantWithoutCanAnswerIsRefusedBeforeRegistration() async throws {
        let model = try await fixture(projects: false), selected = try await folder(model)
        let creation7 = await create(model, folder: selected, permission: "full-access")
        XCTAssertNil(creation7)
        XCTAssertTrue(HostConnection.instances.flatMap(\.commands).isEmpty)
    }
    @MainActor func testRegistrationFailureKeepsTheComputerExplanationWithItsUncertainty() async throws {
        let model = try await fixture(projects: false), selected = try await folder(model)
        HostConnection.commandHandler = { host, _, id in
            guard case .object(var shell) = HostConnection.shells[host]! else { throw ClientError.invalidProtocol }
            shell["error"] = .string("That folder no longer exists. Nothing was added. Choose another folder.")
            HostConnection.shells[host] = .object(shell)
            HostConnection.receipts[id] = .object(["status": .string("completed"), "error": .object(["code": .string("unavailable"), "message": .string("That folder no longer exists.")])])
            return .object(shell)
        }
        let result = await create(model, folder: selected)
        XCTAssertNil(result)
        XCTAssertTrue(model.creationFeedback?.contains("That folder no longer exists.") == true)
        XCTAssertTrue(model.creationFeedback?.contains("Project registration") == true)
        XCTAssertEqual(HostConnection.instances.flatMap(\.commands).map { $0["type"].string }, ["create-project"])
    }
    @MainActor func testHostPermissionRefusalClearsTheMarkerAndDoesNotReportSuccess() async throws {
        let model = try await fixture()
        HostConnection.commandHandler = { _, _, _ in
            throw HostRefusal(failure: try self.json(#"{"code":"forbidden","message":"This iPhone cannot change permissions."}"#).decode(WireFailure.self))
        }
        let creation8 = await create(model)
        XCTAssertNil(creation8)
        XCTAssertTrue(model.pendingCreations.isEmpty)
        XCTAssertEqual(model.creationFeedback, "This iPhone cannot change permissions.")
    }
    @MainActor func testBackgroundDuringCreationRetainsIdentityWithoutOpeningOrResending() async throws {
        let model = try await fixture()
        let accepted = HostConnection.commandHandler!
        HostConnection.commandHandler = { host, command, id in
            let result = try await accepted(host, command, id); model.phase(.background); return result
        }
        let creation9 = await create(model)
        XCTAssertNil(creation9)
        XCTAssertEqual(model.pendingCreations.count, 1)
        model.phase(.active); await model.reconnectAll()
        XCTAssertTrue(model.pendingCreations.isEmpty)
        XCTAssertEqual(HostConnection.instances.flatMap(\.commands).count, 1)
    }
}
