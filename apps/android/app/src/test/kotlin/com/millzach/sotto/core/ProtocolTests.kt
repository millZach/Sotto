package com.millzach.sotto.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

// Port of apps/ios/Tests/SottoCoreTests/ProtocolTests.swift.
class ProtocolTests {
    private val host = "00000000-0000-4000-8000-000000000001"
    private inline fun <reified T> decode(text: String): T = Json.parseToJsonElement(text).decodeAs()
    private fun request(json: String): AgentRequest = decode(json)
    private fun obj(vararg fields: Pair<String, Any>): JsonObject = JsonObject(
        fields.associate { (key, value) ->
            key to when (value) {
                is String -> JsonPrimitive(value)
                is Boolean -> JsonPrimitive(value)
                else -> value as kotlinx.serialization.json.JsonElement
            }
        },
    )

    @Test fun privateTLSRouteIsRequired() {
        val endpoint = HostEndpoint.parse("https://forge.example.ts.net")
        assertEquals("wss://forge.example.ts.net/v1/socket", endpoint.route("/v1/socket", socket = true))
        for (address in listOf(
            "http://forge.example.ts.net", "https://evil.ts.net.example.org", "https://forge.example.ts.net/path",
            "https://user:secret@forge.example.ts.net", "https://forge.example.ts.net?token=secret", "https://forge.example.ts.net#token",
            "https://localhost", "https://localhost:8443", "http://forge.example.ts.net:8443",
        )) {
            assertThrows(address, ClientError::class.java) { HostEndpoint.parse(address) }
        }
    }

    @Test fun onlyPorts443And8443AreAccepted() {
        val desktop = HostEndpoint.parse("https://forge.example.ts.net:8443")
        assertEquals(8443, desktop.port)
        assertEquals("forge.example.ts.net:8443", desktop.address)
        assertEquals("https://forge.example.ts.net:8443/v1/health", desktop.route("/v1/health"))
        assertEquals("wss://forge.example.ts.net:8443/v1/socket", desktop.route("/v1/socket", socket = true))
        val headless = HostEndpoint.parse("https://Forge.Example.ts.net:443/")
        assertEquals(HostEndpoint.parse("https://forge.example.ts.net"), headless)
        assertEquals(443, headless.port)
        assertEquals("forge.example.ts.net", headless.address)
        assertEquals("forge", headless.machine)
        for (port in listOf(80, 444, 8080, 8444, 3000, 4319)) {
            assertThrows("port $port", ClientError::class.java) { HostEndpoint.parse("https://forge.example.ts.net:$port") }
        }
    }

    @Test fun unsupportedProtocolAndOversizeFramesAreRefused() {
        assertThrows(ClientError::class.java) { Wire.decode("""{"v":2,"id":"one","ok":true,"result":null}""") }
        assertThrows(ClientError::class.java) { Wire.decode(" ".repeat(Wire.MAXIMUM_FRAME_BYTES + 1)) }
        Wire.decode("""{"v":1,"id":"one","ok":true,"result":{},"newDisplayField":true}""")
    }

    @Test fun envelopePreservesStableCommandIDAndNeverAddsAttribution() {
        val data = Wire.request(
            id = "stable-command", session = "signed-session",
            operation = obj("op" to "command", "command" to obj("type" to "interrupt", "threadId" to "sotto-thread")),
        )
        val value = Wire.decode(data)
        assertEquals(JsonPrimitive("stable-command"), value["id"]); assertEquals(JsonPrimitive("signed-session"), value["session"])
        assertNull(value["user"]); assertNull(value["transport"])
    }

    @Test fun sessionCannotSwitchHostOrClient() {
        val pairing = decode<Pairing>("{\"v\":1,\"hostId\":\"$host\",\"clientId\":\"phone\",\"token\":\"secret\"}")
        pairing.validate()
        val other = decode<HostSession>("""{"v":1,"hostId":"other","clientId":"phone","session":"signed","expiresAt":"later"}""")
        assertThrows(ClientError::class.java) { other.validate(pairing) }
    }

    @Test fun nativePermissionChoiceAndApprovalArePreserved() {
        val req = request("""{"id":"request","kind":"permission","text":"Run tests?","options":[],"permissionChoices":[{"id":"native-once","label":"Allow once","kind":"allow-once"},{"id":"native-deny","label":"Deny","kind":"deny"}]}""")
        val allow = Commands.answer(threadID = "thread", request = req, currentRequests = listOf(req), choice = "native-once")
        assertEquals(JsonPrimitive("native-once"), allow["permissionChoice"]); assertEquals(JsonPrimitive(true), allow["approved"])
        val deny = Commands.answer(threadID = "thread", request = req, currentRequests = listOf(req), choice = "native-deny")
        assertEquals(JsonPrimitive(false), deny["approved"])
        assertThrows(ClientError::class.java) { Commands.answer(threadID = "thread", request = req, currentRequests = listOf(req), choice = "invented") }
    }

    @Test fun absentPermissionChoicesDifferFromEmptyChoices() {
        val legacy = request("""{"id":"r","kind":"permission","text":"Allow?","options":[]}""")
        assertTrue(legacy.supported)
        val result = Commands.answer(threadID = "t", request = legacy, currentRequests = listOf(legacy), choice = "allow")
        assertEquals(JsonPrimitive(true), result["approved"]); assertNull(result["permissionChoice"])
        val empty = request("""{"id":"r","kind":"permission","text":"Allow?","options":[],"permissionChoices":[]}""")
        assertFalse(empty.supported)
    }

    @Test fun unknownPermissionKindAndUncertainRequestsFailClosed() {
        val req = request("""{"id":"r","kind":"permission","text":"Allow?","options":[],"permissionChoices":[{"id":"x","label":"Automatic","kind":"automatic"}]}""")
        assertFalse(req.supported)
        val uncertain = request("""{"id":"r","kind":"question","text":"Choose","options":[],"delivery":"uncertain"}""")
        assertFalse(uncertain.supported)
    }

    @Test fun staleRequestOrChangedActionCannotBeAnswered() {
        val old = request("""{"id":"r","kind":"permission","text":"Run?","options":[],"context":{"command":"echo safe"}}""")
        val changed = request("""{"id":"r","kind":"permission","text":"Run?","options":[],"context":{"command":"remove files"}}""")
        assertThrows(ClientError::class.java) { Commands.answer(threadID = "t", request = old, currentRequests = emptyList(), choice = "allow") }
        assertThrows(ClientError::class.java) { Commands.answer(threadID = "t", request = old, currentRequests = listOf(changed), choice = "allow") }
    }

    @Test fun structuredAnswersKeepQuestionAndOptionIDs() {
        val req = request("""{"id":"r","kind":"question","text":"Choose","options":[],"questions":[{"id":"q","question":"Target?","options":[{"id":"native-a","label":"Phone"},{"id":"native-b","label":"Desktop"}],"multiSelect":false,"allowFreeText":false}]}""")
        val result = Commands.answer(threadID = "t", request = req, currentRequests = listOf(req), answers = mapOf("q" to QuestionAnswer(optionIds = listOf("native-a"))))
        assertEquals(JsonArray(listOf(JsonPrimitive("native-a"))), result["questionAnswers"]?.jsonObject?.get("q")?.jsonObject?.get("optionIds"))
        assertThrows(ClientError::class.java) {
            Commands.answer(threadID = "t", request = req, currentRequests = listOf(req), answers = mapOf("q" to QuestionAnswer(optionIds = listOf("native-a", "native-b"))))
        }
        assertThrows(ClientError::class.java) {
            Commands.answer(threadID = "t", request = req, currentRequests = listOf(req), answers = mapOf("q" to QuestionAnswer(text = "unsupported")))
        }
        assertThrows(ClientError::class.java) { Commands.answer(threadID = "t", request = req, currentRequests = listOf(req)) }
    }

    @Test fun pendingMarkerHasNoPromptAndCannotCrossHosts() {
        val pending = PendingOperation(hostID = host, clientID = "phone", threadID = "thread", draftID = UUID.randomUUID().toString(), kind = "reply", id = "stable")
        val encoded = SottoJson.encodeToString(PendingOperation.serializer(), pending)
        val restored = SottoJson.decodeFromString(PendingOperation.serializer(), encoded)
        assertEquals(pending, restored); assertFalse(restored.matches(hostID = "other", clientID = "phone"))
        val fields = Json.parseToJsonElement(encoded).jsonObject
        assertNull(fields["text"]); assertNull(fields["token"]); assertNull(fields["command"])
    }

    @Test fun unknownAfterHostRestartNeverConfirmsDelivery() {
        val pending = PendingOperation(hostID = host, clientID = "phone", threadID = "t", kind = "answer")
        val receipt = decode<Receipt>("""{"status":"unknown"}""")
        assertFalse(pending.reconciled(receipt = receipt, deliveries = emptyList()))
    }

    @Test fun completedTransportReceiptDoesNotProvePromptDelivery() {
        val draft = UUID.randomUUID().toString()
        val pending = PendingOperation(hostID = host, clientID = "phone", threadID = "t", draftID = draft, kind = "reply")
        val receipt = decode<Receipt>("""{"status":"completed"}""")
        assertFalse(pending.reconciled(receipt = receipt, deliveries = emptyList()))
        val uncertain = decode<Delivery>("{\"threadId\":\"t\",\"draftId\":\"$draft\",\"status\":\"uncertain\"}")
        assertFalse(pending.reconciled(receipt = receipt, deliveries = listOf(uncertain)))
        val accepted = decode<Delivery>("{\"threadId\":\"t\",\"draftId\":\"$draft\",\"status\":\"accepted\"}")
        assertTrue(pending.reconciled(receipt = receipt, deliveries = listOf(accepted)))
    }

    @Test fun onlyExplicitSuccessfulAnswerOutcomeConfirmsAnAnswer() {
        val pending = PendingOperation(hostID = host, clientID = "phone", threadID = "t", kind = "answer")
        val older = decode<Receipt>("""{"status":"completed"}""")
        assertFalse(pending.reconciled(receipt = older, deliveries = emptyList()))
        val success = decode<Receipt>("""{"status":"completed","answerDelivered":true}""")
        assertTrue(pending.reconciled(receipt = success, deliveries = emptyList()))
        val failure = decode<Receipt>("""{"status":"completed","answerDelivered":false,"error":{"code":"unavailable","message":"Unavailable"}}""")
        assertFalse(pending.reconciled(receipt = failure, deliveries = emptyList()))
    }

    @Test fun genericPostAdmissionFailureStaysUnconfirmed() {
        val pending = PendingOperation(hostID = host, clientID = "phone", threadID = "t", kind = "answer")
        val receipt = decode<Receipt>("""{"status":"completed","error":{"code":"unavailable","message":"Unavailable"}}""")
        assertFalse(pending.reconciled(receipt = receipt, deliveries = emptyList()))
    }

    @Test fun fullDetailIncludesSameLengthReplacementsAndPagination() {
        val before = decode<ThreadDetail>("""{"threadId":"t","revision":1,"messages":[{"id":"m","role":"assistant","text":"old"}],"earlierAvailable":true}""")
        val after = decode<ThreadDetail>("""{"threadId":"t","revision":2,"messages":[{"id":"m","role":"assistant","text":"new"}],"earlierAvailable":true,"newField":42}""")
        assertEquals(before.messages[0].id, after.messages[0].id); assertNotEquals(before.messages[0].text, after.messages[0].text)
        assertEquals(true, after.earlierAvailable)
    }

    // Not ported: the RemoteCommands.needAnswerPolicy assertion. The Kotlin port has no needAnswerPolicy.
    @Test fun onlyHostAllowedCommandsAndFieldsAreBuilt() {
        Commands.interrupt(threadID = "t")
        Commands.loadEarlier(threadID = "t")
        Commands.prompt(threadID = "t", text = "Reply", draftID = UUID.randomUUID().toString())
        // Host-local commands and permission changes are never built, and no command carries an unlisted field.
        for (command in listOf(
            obj("type" to "credential", "slot" to "reasoning", "value" to "key"),
            obj("type" to "configure-thread", "threadId" to "t", "providerMode" to "bypass"),
            obj("type" to "reclaim-thread-worktree", "threadId" to "t", "withUncommittedChanges" to true),
            obj("type" to "interrupt", "threadId" to "t", "runtimeMode" to "full-access"),
        )) {
            assertThrows(ClientError::class.java) { RemoteCommands.checked(command) }
        }
    }

    @Test fun emptyAndOversizedPromptsCannotSend() {
        for (text in listOf("  ", "x".repeat(100_001))) {
            assertThrows(ClientError::class.java) { Commands.prompt(threadID = "t", text = text, draftID = UUID.randomUUID().toString()) }
        }
    }

    @Test fun lateSnapshotsCannotReplaceNewerPushOrSelection() {
        val epoch = Any()
        assertFalse(SnapshotGuard.accepts(epoch, epoch, "a", "a", incomingRevision = 3, currentRevision = 4, changedSinceRead = true))
        assertFalse(SnapshotGuard.accepts(epoch, epoch, "a", "b", incomingRevision = 5, currentRevision = null, changedSinceRead = false))
        assertTrue(SnapshotGuard.accepts(epoch, epoch, "a", "a", incomingRevision = 5, currentRevision = 4, changedSinceRead = true))
    }

    @Test fun foregroundEpochRejectsPriorConnectionAndLateNull() {
        val epoch = Any()
        assertFalse(SnapshotGuard.accepts(Any(), epoch, "a", "a", incomingRevision = 10, currentRevision = 1, changedSinceRead = false))
        assertFalse(SnapshotGuard.accepts(epoch, epoch, "a", "a", incomingRevision = null, currentRevision = 4, changedSinceRead = true))
    }
}
