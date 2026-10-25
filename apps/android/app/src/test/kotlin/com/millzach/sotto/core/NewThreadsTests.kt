package com.millzach.sotto.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

// Port of apps/ios/Tests/SottoCoreTests/NewThreadsTests.swift.
class NewThreadsTests {
    private inline fun <reified T> decode(json: String): T = Json.parseToJsonElement(json).decodeAs()
    private fun model(extra: String = ""): ThreadModel =
        decode("""{"id":"opaque-model","name":"Model","provider":"Codex","providerId":"codex","ready":true,"reasoningEfforts":["low","high"],"defaultReasoningEffort":"high","runtimeModes":["approval-required","full-access"]$extra}""")
    private fun create(model: ThreadModel, effort: String = "high", permission: String = "approval-required", mayAnswer: Boolean = false): JsonObject =
        Commands.createThread(
            projectID = "opaque-project", threadID = "00000000-0000-4000-8000-000000000001",
            model = model, effort = effort, permissionID = permission, mayAnswer = mayAnswer,
        )

    @Test fun creationUsesThePhoneThreadIDAndExplicitAskingMode() {
        val command = create(model())
        assertEquals(JsonPrimitive("00000000-0000-4000-8000-000000000001"), command["threadId"])
        assertEquals(JsonPrimitive("opaque-project"), command["projectId"])
        assertEquals(JsonPrimitive("opaque-model"), command["modelId"])
        assertEquals(JsonPrimitive("approval-required"), command["runtimeMode"])
        assertEquals(JsonPrimitive("shared"), command["workingCopy"])
        assertEquals(JsonPrimitive(false), command["managed"])
        assertEquals(JsonPrimitive("default"), command["titleSource"])
        assertNull(command["text"])
    }

    @Test fun unknownEffortOrPermissionCannotBeSent() {
        assertThrows(ClientError::class.java) { create(model(), effort = "ultra") }
        assertThrows(ClientError::class.java) { create(model(), permission = "invented") }
        assertThrows(ClientError::class.java) {
            Commands.createThread(projectID = "p", threadID = "native-thread", model = model(), effort = "high", permissionID = "approval-required", mayAnswer = false)
        }
    }

    @Test fun permissiveModeNeedsAnswerAuthorityAndIsNeverTheDefault() {
        val value = model()
        assertEquals("approval-required", value.startingPermission)
        assertThrows(ClientError::class.java) { create(value, permission = "full-access") }
        assertEquals(JsonPrimitive("full-access"), create(value, permission = "full-access", mayAnswer = true)["runtimeMode"])
    }

    @Test fun providerProfilesUseTheirAllowanceNotTheirNameOrPosition() {
        val value = model(""", "providerModes":[{"id":"bypass","name":"Ask first"},{"id":"safe","name":"Code","allows":"nothing"}]""")
        assertEquals("safe", value.startingPermission)
        val command = create(value, permission = "safe")
        assertEquals(JsonPrimitive("safe"), command["providerMode"]); assertNull(command["runtimeMode"])
        assertThrows(ClientError::class.java) { create(value, permission = "bypass") }
    }

    @Test fun aHostWithoutAnAskingModeDoesNotSelectAGrant() {
        val value = model(""", "providerModes":[{"id":"grant","name":"Code","allows":"everything"}]""")
        assertEquals("", value.startingPermission)
        assertThrows(ClientError::class.java) { create(value, permission = "") }
    }

    @Test fun effortComesFromTheModelsAdvertisedDefault() {
        assertEquals("high", model().startingEffort)
    }

    @Test fun anUnavailableSavedModelRequiresAChoiceInsteadOfFallingBack() {
        val shell = decode<Shell>("""{"hostId":"h","configuration":{"newThreadModelId":"missing"},"host":{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"m","name":"Model","provider":"Codex","ready":true,"recommended":true}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}}""")
        assertEquals("missing", NewThreads.startingModelID(shell))
        assertEquals(listOf("m"), NewThreads.availableModels(shell.host).map { it.id })
    }

    @Test fun savedEffortMapsAcrossTheComputersModelCatalog() {
        val shell = decode<Shell>("""{"hostId":"h","configuration":{"newThreadModelId":"original","newThreadReasoningEffort":"medium"},"host":{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"original","name":"Original","provider":"Codex","ready":true,"reasoningEfforts":["low","medium","high"]}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}}""")
        assertEquals("high", NewThreads.startingEffort(model(), shell = shell))
    }

    @Test fun projectRegistrationAttachesTheExistingHostFolder() {
        val command = Commands.createProject(providerID = "claude", title = "Panel tools", path = """D:\Engineering\Panel tools""")
        assertEquals(JsonPrimitive("""D:\Engineering\Panel tools"""), command["path"])
        assertEquals(JsonPrimitive(true), command["useExisting"])
        assertEquals(JsonPrimitive("claude"), command["provider"])
        assertThrows(ClientError::class.java) { Commands.createProject(providerID = "unknown", title = "Project", path = "/tmp/project") }
    }

    @Test fun projectRegistrationAcceptsOpenCode() {
        val command = Commands.createProject(providerID = "opencode", title = "Panel tools", path = "/home/zach/panel")
        assertEquals(JsonPrimitive("opencode"), command["provider"])
        assertThrows(ClientError::class.java) { Commands.createProject(providerID = "future", title = "Project", path = "/tmp/project") }
    }

    // OpenCode names where it gets each model (ADR-0087). A row reads the source between the agent and the model.
    @Test fun anOpenCodeModelReadsItsSourceAndIsAChoiceWhileOpenCodeIsConnected() {
        val host = decode<HostSnapshot>("""{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"opencode:anthropic/claude-sonnet-4-5","name":"Claude Sonnet 4.5","provider":"OpenCode","providerId":"opencode","source":"Anthropic","ready":true}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true},"providers":[{"id":"opencode","connection":"connected","capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"projects":true,"threads":true}}]}""")
        val opencode = NewThreads.availableModels(host).single()
        assertEquals("Anthropic", opencode.source)
        assertEquals("OpenCode · Anthropic · Claude Sonnet 4.5", opencode.label)
        assertNull("Other providers' models carry no source", model().source)
        assertEquals("Codex · Model", model().label)
        assertEquals("OpenCode · Big Pickle", ThreadModel.labelOf("opencode", "", "Big Pickle"))
    }

    // An older phone reads a provider ID as a plain string, so a provider it doesn't know reads "The agent" and breaks
    // nothing: its threads, projects and models decode, and its models are never offered for a new thread.
    @Test fun aProviderThePhoneDoesNotKnowStillDecodes() {
        val shell = decode<Shell>("""{"hostId":"h","host":{"hostId":"h","name":"Laptop","threads":[{"id":"a","projectId":"p","title":"On OpenCode","providerId":"opencode","status":"idle","requests":[]},{"id":"b","projectId":"p","title":"On a future agent","providerId":"future","status":"running","requests":[]}],"projects":[{"id":"p","title":"Panel","path":"/home/zach/panel","providerId":"future"}],"models":[{"id":"future:model","name":"Model","provider":"Future","providerId":"future","source":"Somewhere","ready":true,"providerModes":[{"id":"ask","name":"Ask","allows":"nothing"}]}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true},"providers":[{"id":"future","connection":"disconnected","capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}]}}""")
        shell.validate("h")
        assertEquals(listOf("opencode", "future"), shell.host.threads.map { it.providerId })
        assertEquals("future", shell.host.projects.single().providerId)
        assertEquals("The agent", AgentNames.name(shell.host.threads.last().providerId))
        assertEquals("The agent · Somewhere · Model", shell.host.models?.single()?.label)
        assertTrue(NewThreads.availableModels(shell.host).isEmpty())
    }

    @Test fun projectRegistrationAcceptsCursor() {
        val command = Commands.createProject(providerID = "cursor", title = "Panel tools", path = "/home/zach/panel")
        assertEquals(JsonPrimitive("cursor"), command["provider"])
    }

    // Cursor names each model's maker in its source (ADR-0128). A row reads the maker between Cursor and the model, so a
    // Cursor thread on Claude never reads as Claude Code.
    @Test fun aCursorModelReadsItsMakerAndIsAChoiceWhileCursorIsConnected() {
        val host = decode<HostSnapshot>("""{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"cursor:claude-sonnet-5-5","name":"Claude Sonnet 5.5","provider":"Cursor","providerId":"cursor","source":"Anthropic","ready":true}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true},"providers":[{"id":"cursor","connection":"connected","capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"projects":true,"threads":true}}]}""")
        val cursor = NewThreads.availableModels(host).single()
        assertEquals("Anthropic", cursor.source)
        assertEquals("Cursor · Anthropic · Claude Sonnet 5.5", cursor.label)
        assertEquals("Cursor's own model reads Cursor once", "Cursor · Auto", ThreadModel.labelOf("cursor", "Cursor", "Auto"))
    }

    @Test fun openCodeHasItsNameAndAProviderThePhoneDoesNotKnowReadsTheAgent() {
        assertEquals("OpenCode", AgentNames.name("opencode"))
        assertEquals("Cursor", AgentNames.name("cursor"))
        assertEquals("Codex", AgentNames.name("codex"))
        assertEquals("The agent", AgentNames.name("future"))
        assertEquals("The agent", AgentNames.name(null))
    }

    @Test fun folderRequestsDistinguishHomeDrivesAndAHostPath() {
        assertEquals(JsonObject(emptyMap()), NewThreads.folderRequest()["request"])
        assertEquals(JsonObject(mapOf("path" to JsonNull)), NewThreads.folderRequest(path = JsonNull)["request"])
        assertEquals(JsonObject(mapOf("path" to JsonPrimitive("""D:\"""))), NewThreads.folderRequest(path = JsonPrimitive("""D:\"""))["request"])
        assertThrows(ClientError::class.java) { NewThreads.folderRequest(path = JsonPrimitive("")) }
    }

    @Test fun folderIdentityPreservesPOSIXCaseAndWindowsDriveRoots() {
        assertTrue(NewThreads.sameFolder("""D:\Panel\""", "d:/panel", separator = "\\"))
        assertTrue(NewThreads.sameFolder("""D:\""", "d:/", separator = "\\"))
        assertTrue(NewThreads.sameFolder("/home/zach/project/", "/home/zach/project", separator = "/"))
        assertFalse(NewThreads.sameFolder("/home/Zach", "/home/zach", separator = "/"))
        assertFalse(NewThreads.sameFolder("/home/zach", "home/zach", separator = "/"))
        assertFalse(NewThreads.sameFolder(null, "/home/zach", separator = "/"))
        assertFalse(NewThreads.sameFolder("/:Project", "/:project", separator = "/"))
    }

    @Test fun unavailableProvidersAreNotCreationChoices() {
        val host = decode<HostSnapshot>("""{"name":"Laptop","threads":[],"projects":[],"models":[{"id":"m","name":"Model","provider":"Codex","providerId":"codex","ready":true}],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true},"providers":[{"id":"codex","connection":"disconnected","capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}]}""")
        assertTrue(NewThreads.availableModels(host).isEmpty())
    }

    @Test fun folderStatusesFailClosedAndDrivesCannotBeSelectedAsAProject() {
        val missing = FolderResult.read(Json.parseToJsonElement("""{"status":"missing","path":"/gone"}"""))
        assertTrue("Wrong folder status", missing is FolderResult.Missing)
        assertThrows(ClientError::class.java) { FolderResult.read(Json.parseToJsonElement("""{"status":"future"}""")) }
        val drives = FolderResult.read(Json.parseToJsonElement("""{"status":"listed","path":null,"home":"C:\\Users\\Zach","separator":"\\","crumbs":[{"name":"Drives","path":null}],"folders":[{"name":"D:","path":"D:\\","git":false}],"truncated":false}"""))
        assertTrue("Missing drive listing", drives is FolderResult.Listed)
        val value = (drives as FolderResult.Listed).listing
        assertNull(value.path); assertEquals("""D:\""", value.folders.firstOrNull()?.path)
    }

    @Test fun creationMarkersPersistOnlyIdentity() {
        val marker = PendingOperation(hostID = UUID.randomUUID().toString(), clientID = "phone", threadID = UUID.randomUUID().toString(), kind = "create-project")
        val fields = Json.parseToJsonElement(SottoJson.encodeToString(PendingOperation.serializer(), marker)).jsonObject
        assertEquals(setOf("id", "hostID", "clientID", "threadID", "kind"), fields.keys)
    }
}
