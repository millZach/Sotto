package com.millzach.sotto.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.net.URI

/// Wire v1 mirrors src/shared/hostProtocol.ts, as the iPhone client's SottoCore does. Unknown display
/// fields are ignored; unknown protocol versions, request kinds and permission variants fail closed.
val SottoJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
}

private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
fun isUuid(value: String): Boolean = uuidPattern.matches(value)

/// What went wrong, in the plain words the phone shows.
sealed class ClientError(message: String) : Exception(message) {
    object InvalidHost : ClientError("Enter the computer's name on your tailnet, such as forge, or its full address ending in .ts.net.")
    object InvalidProtocol : ClientError("This computer uses a different connection format. Update Sotto before connecting.")
    object InvalidIdentity : ClientError("A different computer answered at this address. Remove it and add it again if you meant to change computers.")
    object InvalidRequest : ClientError("This request changed or is not supported on this phone. Refresh the thread or answer on the computer.")
    object Disconnected : ClientError("Connection lost. Work carries on on the computer. Reconnect to check the thread.")
    object ConnectionTimedOut : ClientError("The computer didn't finish connecting. Work carries on there. Try connecting again.")
    object ReadTimedOut : ClientError("Sotto did not answer in time. Try again.")
    object RateLimited : ClientError("Too many connection attempts. Wait a minute and try again.")
    object Uncertain : ClientError("Delivery is unconfirmed. Check the thread before sending again.")
    object InvalidCode : ClientError("A pairing code is eight letters and numbers. Check the code on that computer.")
    class Rejected(message: String) : ClientError(message)
    class HostNotFound(name: String) : ClientError("Couldn't find $name on your tailnet. Check that Tailscale is connected on this phone and MagicDNS is on for your tailnet, or enter the full address ending in .ts.net.")
    class HostUnreachable(name: String) : ClientError("Couldn't reach $name. Check that it's online and that Tailscale is connected on this phone.")
    class NotASottoHost(name: String) : ClientError("$name answered, but Sotto isn't listening there. In Sotto on $name, turn on phone access in Settings > Phones. For a host without a screen, check that Tailscale Serve forwards to it.")
    class SottoNotRunning(name: String) : ClientError("$name answered, but Sotto isn't running there. Nothing was lost. Open Sotto on $name and try again.")
}

/// A refusal the host sent for one request: `{ code, message }`, its message plain copy for the user.
class HostRefusal(val failure: WireFailure) : Exception(failure.message)

/// A computer's private HTTPS origin on the tailnet: `https://<machine>.<tailnet>.ts.net`, on port 443
/// or 8443 only. The desktop serves its host through Tailscale Serve on 8443; a host without a screen
/// is usually on 443. Certificate validation is the platform's.
class HostEndpoint private constructor(val host: String, val port: Int) {
    val url: String get() = if (port == 443) "https://$host" else "https://$host:$port"

    /// The machine's name, the first label of its address: `forge`.
    val machine: String get() = host.substringBefore('.')

    /// How the address reads on screen: the full name, with the port when it isn't 443.
    val address: String get() = if (port == 443) host else "$host:$port"

    fun route(path: String, socket: Boolean = false): String {
        val scheme = if (socket) "wss" else "https"
        return if (port == 443) "$scheme://$host$path" else "$scheme://$host:$port$path"
    }

    override fun equals(other: Any?) = other is HostEndpoint && other.host == host && other.port == port
    override fun hashCode() = host.hashCode() * 31 + port
    override fun toString() = url

    companion object {
        val ports = setOf(443, 8443)

        fun parse(input: String): HostEndpoint {
            val uri = try { URI(input.trim()) } catch (_: Exception) { throw ClientError.InvalidHost }
            val host = uri.host?.lowercase() ?: throw ClientError.InvalidHost
            val port = if (uri.port == -1) 443 else uri.port
            val path = uri.rawPath ?: ""
            if (uri.scheme?.lowercase() != "https" || !host.endsWith(".ts.net") || host.length <= 7 ||
                uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
                port !in ports || !(path.isEmpty() || path == "/")
            ) throw ClientError.InvalidHost
            return HostEndpoint(host, port)
        }
    }
}

@Serializable
data class Pairing(val v: Int, val hostId: String, val clientId: String, val token: String) {
    fun validate() {
        if (v != 1) throw ClientError.InvalidProtocol
        if (!isUuid(hostId) || clientId.isEmpty() || token.isEmpty()) throw ClientError.InvalidIdentity
    }
}

@Serializable
data class HostSession(val v: Int, val hostId: String, val clientId: String, val session: String, val expiresAt: String) {
    fun validate(pairing: Pairing) {
        if (v != 1) throw ClientError.InvalidProtocol
        if (hostId != pairing.hostId || clientId != pairing.clientId || session.isEmpty()) throw ClientError.InvalidIdentity
    }
}

/// `GET /v1/health`: read before pairing, so the phone knows it found a Sotto host and which one.
@Serializable
data class Health(
    val v: Int,
    val status: String,
    val hostId: String,
    val sottoVersion: String? = null,
    val features: List<String>? = null,
    val name: String? = null,
) {
    val computerName: String? get() = ComputerName.cleaned(name)
    fun validate() {
        if (v != 1) throw ClientError.InvalidProtocol
        if (!isUuid(hostId)) throw ClientError.InvalidIdentity
        if (status != "ready") throw ClientError.Rejected("Sotto on that computer is still starting. Try again in a moment.")
    }
}

@Serializable
data class WireFailure(val code: String, val message: String)

@Serializable
data class Receipt(val status: String, val error: WireFailure? = null, val answerDelivered: Boolean? = null) {
    /// Older hosts record transport completion only; it cannot confirm the phone's answer.
    val confirmsAnswer: Boolean get() = status == "completed" && error == null && answerDelivered == true
}

@Serializable
data class Capabilities(val mayAnswer: Boolean)

@Serializable
data class Hello(
    val hostId: String,
    val clientId: String,
    val shell: Shell,
    val capabilities: Capabilities,
    val features: List<String>? = null,
)

@Serializable
data class ThreadStartPreferences(val newThreadModelId: String? = null, val newThreadReasoningEffort: String? = null)

@Serializable
data class Shell(
    val hostId: String? = null,
    val host: HostSnapshot,
    val deliveries: List<Delivery>? = null,
    val deliveredDrafts: List<DeliveryReceipt>? = null,
    val globalLaneBusy: Boolean? = null,
    val busyThreadIds: List<String>? = null,
    val error: String? = null,
    /// Authority for this paired client, refreshed with the shell. Older hosts send it only in hello.
    val clientCapabilities: Capabilities? = null,
    val configuration: ThreadStartPreferences? = null,
) {
    fun validate(hostID: String) {
        if (hostId != hostID || host.hostId != hostID || !host.threads.all { it.hostId == null || it.hostId == hostID }) {
            throw ClientError.InvalidIdentity
        }
    }
}

@Serializable
data class HostSnapshot(
    val hostId: String? = null,
    val name: String,
    val threads: List<ThreadSummary>,
    val projects: List<Project>,
    val providers: List<Provider>? = null,
    /// Always whole once a shell leaves HostConnection: a catalog the host named by revision is put back there.
    val models: List<ThreadModel>? = null,
    val modelsRevision: Long? = null,
    val capabilities: ProviderCapabilities,
)

@Serializable
data class Project(
    val id: String,
    val title: String,
    val workspaceSettledAt: String? = null,
    val path: String? = null,
    val providerId: String? = null,
)

@Serializable
data class Provider(val id: String, val connection: String, val capabilities: ProviderCapabilities)

@Serializable
data class ProviderCapabilities(
    val submit: Boolean,
    val interrupt: Boolean,
    val questions: Boolean,
    val permissions: Boolean,
    val projects: Boolean? = null,
    val threads: Boolean? = null,
)

@Serializable
data class ThreadSummary(
    val id: String,
    val hostId: String? = null,
    val projectId: String,
    val title: String,
    val providerId: String? = null,
    val status: String,
    val requests: List<AgentRequest>,
    val earlierAvailable: Boolean? = null,
    val archivedAt: String? = null,
    val summary: Summary? = null,
    val workspaceSettledAt: String? = null,
    val settledAt: String? = null,
    val settledOverride: String? = null,
    /// Current provider-confirmed work only; never infer it from retained activity or messages.
    val backgroundWork: List<BackgroundWork>? = null,
    val compaction: Compaction? = null,
    /// The computer's word that the thread finished while nothing showed it and has not been opened since (ADR-0046).
    val finishedUnread: Boolean? = null,
) {
    @Serializable data class BackgroundWork(val type: String)
    @Serializable data class Compaction(val status: String)
    @Serializable data class Summary(val lastMessageAt: String? = null, val runningTurnStartedAt: String? = null)
}

@Serializable
data class ThreadDetail(
    val threadId: String,
    val revision: Long,
    val messages: List<Message>,
    val earlierAvailable: Boolean? = null,
    val activities: List<Activity>? = null,
)

/// Provider-reported work beside a thread's messages. Observational only: nothing here is an answer or a grant.
@Serializable
data class Activity(
    val id: String,
    val sequence: Long,
    val kind: String,
    val status: String,
    val title: String,
    val command: String? = null,
    val exitCode: Int? = null,
    val durationMs: Double? = null,
    val startedAt: String? = null,
    val changes: List<Change>? = null,
) {
    @Serializable data class Change(val path: String, val kind: String)

    /// The line under the title: the command it ran, or the files it changed.
    val subject: String?
        get() {
            if (!command.isNullOrEmpty()) return command
            val first = changes?.firstOrNull() ?: return null
            return if (changes.size == 1) first.path else "${first.path} and ${changes.size - 1} more"
        }
}

@Serializable
data class Message(
    val id: String,
    val role: String,
    val text: String,
    val commandId: String? = null,
    val attachments: List<Attachment>? = null,
)

@Serializable data class Attachment(val id: String, val name: String)
@Serializable data class DeliveryReceipt(val threadId: String, val draftId: String)
@Serializable data class Delivery(val threadId: String, val draftId: String, val status: String)

@Serializable
data class AgentRequest(
    val id: String,
    val kind: String,
    val text: String,
    val options: List<RequestOption>,
    val questions: List<Question>? = null,
    val permissionChoices: List<PermissionChoice>? = null,
    val context: RequestContext? = null,
    val delivery: String? = null,
) {
    val supported: Boolean
        get() {
            if (delivery == "uncertain") return false
            if (kind == "question") return true
            if (kind == "permission" && permissionChoices == null) return true
            val choices = permissionChoices ?: emptyList()
            return kind == "permission" && choices.isNotEmpty() &&
                choices.all { it.kind in setOf("allow-once", "allow-session", "allow-always", "deny", "cancel") }
        }
}

@Serializable data class RequestOption(val id: String, val label: String, val description: String? = null)

@Serializable
data class Question(
    val id: String,
    val question: String,
    val options: List<RequestOption>,
    val multiSelect: Boolean,
    val allowFreeText: Boolean,
    val required: Boolean? = null,
    val unavailableReason: String? = null,
)

@Serializable data class PermissionChoice(val id: String, val label: String, val kind: String, val description: String? = null)

@Serializable
data class RequestContext(
    val toolName: String? = null,
    val command: String? = null,
    val cwd: String? = null,
    val details: String? = null,
)

object Wire {
    const val MAXIMUM_FRAME_BYTES = 16 * 1024 * 1024

    /// The phone reads snapshots, not event history: the desktop's v1 snapshot-only hello.
    /// `activity-summaries` asks for activity as its rows read it, without command output, text or diffs.
    /// `client-liveness` is left out: OkHttp answers the host's own pings, which every other client keeps.
    val snapshotHello: JsonObject = buildJsonObject {
        put("op", JsonPrimitive("hello"))
        put("afterSeq", JsonPrimitive(9_007_199_254_740_991L))
        put("accepts", kotlinx.serialization.json.JsonArray(listOf("detail-delta", "activity-summaries", "model-catalog-revision").map(::JsonPrimitive)))
    }

    /// A JSON object from a host, refused unless it is v1.
    fun decode(text: String): JsonObject {
        if (text.length > MAXIMUM_FRAME_BYTES || text.encodeToByteArray().size > MAXIMUM_FRAME_BYTES) throw ClientError.InvalidProtocol
        val value = try { SottoJson.parseToJsonElement(text) } catch (_: Exception) { throw ClientError.InvalidProtocol }
        if (value !is JsonObject || (value["v"] as? JsonPrimitive)?.intOrNull != 1) throw ClientError.InvalidProtocol
        return value
    }

    fun request(id: String, session: String, operation: JsonObject): String {
        val fields = operation.toMutableMap()
        fields["v"] = JsonPrimitive(1)
        fields["id"] = JsonPrimitive(id)
        fields["session"] = JsonPrimitive(session)
        return JsonObject(fields).toString()
    }
}

/// Reads a typed value out of a JSON tree, failing closed as the protocol requires.
inline fun <reified T> JsonElement.decodeAs(): T =
    try { SottoJson.decodeFromJsonElement<T>(this) } catch (_: Exception) { throw ClientError.InvalidProtocol }

fun JsonElement?.isNullish(): Boolean = this == null || this is JsonNull
fun JsonElement?.stringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
fun JsonElement?.longValueOrNull(): Long? = (this as? JsonPrimitive)?.let { if (it.isString) null else it.longOrNull }
