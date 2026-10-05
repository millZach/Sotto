package com.millzach.sotto.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

// The detail-delta extension, requested in hello. Old hosts still send full details.
data class ThreadDetailDelta(
    val threadId: String,
    val baseRevision: Long,
    val revision: Long,
    val messageDeltas: List<MessageDelta>,
    val activityDeltas: List<ActivityDelta>,
) {
    sealed interface MessageDelta {
        data class Whole(val message: Message) : MessageDelta
        data class Append(val id: String, val text: String) : MessageDelta
    }

    sealed interface ActivityDelta {
        data class Record(val record: Activity) : ActivityDelta
        data class Remove(val id: String) : ActivityDelta
    }

    companion object {
        fun read(value: JsonElement): ThreadDetailDelta {
            val o = value as? JsonObject ?: throw ClientError.InvalidProtocol
            val messages = (o["messageDeltas"] as? kotlinx.serialization.json.JsonArray ?: throw ClientError.InvalidProtocol).map { item ->
                val change = item as? JsonObject ?: throw ClientError.InvalidProtocol
                if (change.containsKey("message")) {
                    MessageDelta.Whole(change["message"]!!.decodeAs())
                } else {
                    MessageDelta.Append(
                        change["id"].stringOrNull() ?: throw ClientError.InvalidProtocol,
                        change["appendText"].stringOrNull() ?: throw ClientError.InvalidProtocol,
                    )
                }
            }
            val activities = (o["activityDeltas"] as? kotlinx.serialization.json.JsonArray ?: throw ClientError.InvalidProtocol).map { item ->
                val change = item as? JsonObject ?: throw ClientError.InvalidProtocol
                if (change.containsKey("record")) {
                    ActivityDelta.Record(change["record"]!!.decodeAs())
                } else {
                    if ((change["removed"] as? JsonPrimitive)?.booleanOrNull != true) throw ClientError.InvalidProtocol
                    ActivityDelta.Remove(change["id"].stringOrNull() ?: throw ClientError.InvalidProtocol)
                }
            }
            return ThreadDetailDelta(
                threadId = o["threadId"].stringOrNull() ?: throw ClientError.InvalidProtocol,
                baseRevision = o["baseRevision"].longValueOrNull() ?: throw ClientError.InvalidProtocol,
                revision = o["revision"].longValueOrNull() ?: throw ClientError.InvalidProtocol,
                messageDeltas = messages,
                activityDeltas = activities,
            )
        }
    }
}

// Refuse gaps and unknown append targets atomically: the caller reads one full snapshot.
fun ThreadDetail.applying(delta: ThreadDetailDelta): ThreadDetail? {
    if (delta.threadId != threadId || delta.baseRevision != revision || delta.revision <= revision) return null
    val messages = messages.toMutableList()
    val activities = (activities ?: emptyList()).toMutableList()
    for (change in delta.messageDeltas) {
        when (change) {
            is ThreadDetailDelta.MessageDelta.Whole -> {
                val index = messages.indexOfFirst { it.id == change.message.id }
                if (index >= 0) messages[index] = change.message else messages += change.message
            }
            is ThreadDetailDelta.MessageDelta.Append -> {
                val index = messages.indexOfFirst { it.id == change.id }
                if (index < 0) return null
                messages[index] = messages[index].copy(text = messages[index].text + change.text)
            }
        }
    }
    for (change in delta.activityDeltas) {
        when (change) {
            is ThreadDetailDelta.ActivityDelta.Record -> {
                val index = activities.indexOfFirst { it.id == change.record.id }
                if (index >= 0) activities[index] = change.record else activities += change.record
            }
            is ThreadDetailDelta.ActivityDelta.Remove -> activities.removeAll { it.id == change.id }
        }
    }
    if (delta.activityDeltas.isNotEmpty()) activities.sortBy { it.sequence }
    return ThreadDetail(threadId, delta.revision, messages, earlierAvailable, activities)
}

// A model catalog a host sent whole, under the revision it named (`model-catalog-revision`). A revision
// means something only on the connection that carried it.
data class CarriedCatalog(val revision: Long, val models: List<ThreadModel>)

// The last model catalog one connection was sent whole. A host that names its catalog by revision leaves
// it out of every shell after the first one that carried it, so the connection puts it back before anything
// reads the shell. It is kept in socket order, and a reconnect starts with an empty one.
data class ModelCatalogCache(val held: CarriedCatalog? = null) {
    fun holding(carried: CarriedCatalog) = ModelCatalogCache(carried)
    fun holding(shell: Shell) = shell.host.carriedCatalog?.let { ModelCatalogCache(it) } ?: this

    // `shell` with its whole catalog, or null when it names a revision this connection was never sent:
    // shown without it, the computer would read as having no models.
    fun whole(shell: Shell): Shell? {
        val revision = shell.host.modelsRevision
        if (revision == null || shell.host.models != null) return shell
        val held = held ?: return null
        if (held.revision != revision) return null
        return shell.copy(host = shell.host.copy(models = held.models))
    }

    fun whole(hello: Hello): Hello? = whole(hello.shell)?.let { hello.copy(shell = it) }
}

val HostSnapshot.carriedCatalog: CarriedCatalog?
    get() {
        val revision = modelsRevision ?: return null
        val models = models ?: return null
        return CarriedCatalog(revision, models)
    }

// What arrives on the socket, read into the fields the phone displays.
sealed interface IncomingFrame {
    // `catalog` is the model catalog the reply's shell carries whole under a revision, read in socket order.
    data class Reply(val id: String, val result: JsonElement, val catalog: CarriedCatalog?) : IncomingFrame
    data class Refusal(val id: String, val failure: WireFailure) : IncomingFrame
    data class ShellPush(val shell: Shell) : IncomingFrame
    data class Detail(val threadID: String, val detail: ThreadDetail?) : IncomingFrame
    data class Delta(val threadID: String, val delta: ThreadDetailDelta) : IncomingFrame
    data class Failure(val failure: WireFailure) : IncomingFrame

    companion object {
        fun read(text: String): IncomingFrame {
            val o = Wire.decode(text)
            val event = o["event"]
            if (event != null) {
                return when (event.stringOrNull()) {
                    "shell" -> ShellPush((o["state"] ?: throw ClientError.InvalidProtocol).decodeAs())
                    "detail" -> Detail(
                        o["threadId"].stringOrNull() ?: throw ClientError.InvalidProtocol,
                        o["detail"].let { if (it.isNullish()) null else it!!.decodeAs<ThreadDetail>() },
                    )
                    "detail-delta" -> Delta(
                        o["threadId"].stringOrNull() ?: throw ClientError.InvalidProtocol,
                        ThreadDetailDelta.read(o["delta"] ?: throw ClientError.InvalidProtocol),
                    )
                    "error" -> Failure((o["error"] ?: throw ClientError.InvalidProtocol).decodeAs())
                    else -> throw ClientError.InvalidProtocol
                }
            }
            val id = o["id"].stringOrNull() ?: throw ClientError.InvalidProtocol
            val ok = (o["ok"] as? JsonPrimitive)?.booleanOrNull ?: throw ClientError.InvalidProtocol
            if (!ok) return Refusal(id, (o["error"] ?: throw ClientError.InvalidProtocol).decodeAs())
            val result = o["result"] ?: throw ClientError.InvalidProtocol
            return Reply(id, result, replyCatalog(result))
        }

        // The catalog a reply's shell carries whole: `result.host` for a shell read or a command's answer,
        // `result.shell.host` for hello. Only when the host named a revision with it.
        private fun replyCatalog(result: JsonElement): CarriedCatalog? {
            val o = result as? JsonObject ?: return null
            val host = (if (o.containsKey("shell")) (o["shell"] as? JsonObject)?.get("host") else o["host"]) as? JsonObject ?: return null
            val revision = host["modelsRevision"].longValueOrNull() ?: return null
            val models = host["models"] ?: return null
            if (models.isNullish()) return null
            return try { CarriedCatalog(revision, models.decodeAs()) } catch (_: ClientError) { null }
        }
    }
}

// Full snapshots may race live pushes or a reconnect. Neither an older revision nor a result from an earlier
// connection or selection can replace the thread on screen.
object SnapshotGuard {
    fun accepts(
        requestGeneration: Any,
        currentGeneration: Any?,
        requestedThread: String,
        selectedThread: String?,
        incomingRevision: Long?,
        currentRevision: Long?,
        changedSinceRead: Boolean,
    ): Boolean {
        if (requestGeneration !== currentGeneration || requestedThread != selectedThread) return false
        if (incomingRevision == null) return !changedSinceRead
        if (currentRevision == null) return true
        return incomingRevision >= currentRevision
    }
}
