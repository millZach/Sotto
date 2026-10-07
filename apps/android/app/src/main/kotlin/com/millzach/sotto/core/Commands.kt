package com.millzach.sotto.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID

data class QuestionAnswer(val optionIds: List<String> = emptyList(), val text: String? = null)

// The commands this client builds, each with the only fields the host accepts from a paired device. A copy
// of the rows it uses from the host's closed allow-list in src/host/remoteCommands.ts, which is the
// authority: anything not listed there is refused. A permissive creation mode, like an answer, needs the
// computer's remote-answer policy. The host checks that policy again when it acts.
object RemoteCommands {
    val allowed: Map<String, Set<String>> = mapOf(
        "manual-send" to setOf("threadId", "text", "attachments", "skills", "files", "draftId"),
        "interrupt" to setOf("threadId"),
        "load-earlier-messages" to setOf("threadId"),
        "answer" to setOf("threadId", "requestId", "answer", "approved", "questionAnswers", "permissionChoice"),
        "create-project" to setOf("provider", "title", "path", "useExisting"),
        "create-thread" to setOf(
            "projectId", "title", "modelId", "titleSource", "threadId", "workingCopy",
            "reasoningEffort", "runtimeMode", "providerMode", "managed",
        ),
    )

    // Refuses a command the host would refuse, before it is sent.
    fun checked(command: JsonObject): JsonObject {
        val type = command["type"].stringOrNull() ?: throw ClientError.InvalidRequest
        val permitted = allowed[type] ?: throw ClientError.InvalidRequest
        if (!permitted.containsAll(command.keys - "type")) throw ClientError.InvalidRequest
        return command
    }
}

private fun obj(vararg fields: Pair<String, Any>): JsonObject = JsonObject(
    fields.associate { (key, value) ->
        key to when (value) {
            is String -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            is kotlinx.serialization.json.JsonElement -> value
            else -> error("unsupported")
        }
    },
)

private fun isUuidString(value: String) = try { UUID.fromString(value); isUuid(value) } catch (_: Exception) { false }

object Commands {
    fun prompt(threadID: String, text: String, draftID: String): JsonObject {
        if (text.isBlank() || text.length > 100_000 || !isUuidString(draftID)) throw ClientError.InvalidRequest
        return RemoteCommands.checked(obj("type" to "manual-send", "threadId" to threadID, "text" to text, "draftId" to draftID))
    }

    fun interrupt(threadID: String): JsonObject = RemoteCommands.checked(obj("type" to "interrupt", "threadId" to threadID))

    fun loadEarlier(threadID: String): JsonObject = RemoteCommands.checked(obj("type" to "load-earlier-messages", "threadId" to threadID))

    fun answer(
        threadID: String,
        request: AgentRequest,
        currentRequests: List<AgentRequest>,
        choice: String? = null,
        text: String = "",
        answers: Map<String, QuestionAnswer> = emptyMap(),
    ): JsonObject {
        val current = currentRequests.firstOrNull { it.id == request.id }
        if (!request.supported || current == null || !current.supported || current != request) throw ClientError.InvalidRequest
        val result = mutableMapOf<String, kotlinx.serialization.json.JsonElement>(
            "type" to JsonPrimitive("answer"),
            "threadId" to JsonPrimitive(threadID),
            "requestId" to JsonPrimitive(request.id),
            "answer" to JsonPrimitive(text),
        )
        val questions = current.questions
        if (request.kind == "permission") {
            val choices = current.permissionChoices
            if (choices == null) {
                if (choice != "allow" && choice != "deny") throw ClientError.InvalidRequest
                result["approved"] = JsonPrimitive(choice == "allow")
                result["answer"] = JsonPrimitive(if (choice == "allow") "Allow" else "Deny")
                return RemoteCommands.checked(JsonObject(result))
            }
            val option = choices.firstOrNull { it.id == choice } ?: throw ClientError.InvalidRequest
            if (request.permissionChoices?.any { it.id == choice && it.kind == option.kind && it.label == option.label } != true) {
                throw ClientError.InvalidRequest
            }
            result["permissionChoice"] = JsonPrimitive(option.id)
            result["approved"] = JsonPrimitive(option.kind.startsWith("allow-"))
            result["answer"] = JsonPrimitive(option.label)
        } else if (!questions.isNullOrEmpty()) {
            if (!questions.map { it.id }.toSet().containsAll(answers.keys)) throw ClientError.InvalidRequest
            val wire = linkedMapOf<String, kotlinx.serialization.json.JsonElement>()
            for (q in questions) {
                if (q.unavailableReason != null) {
                    if (q.required == false) continue
                    throw ClientError.InvalidRequest
                }
                val answer = answers[q.id] ?: QuestionAnswer()
                val written = answer.text ?: ""
                val valid = answer.optionIds.toSet().size == answer.optionIds.size &&
                    q.options.map { it.id }.toSet().containsAll(answer.optionIds) &&
                    (q.multiSelect || answer.optionIds.size <= 1) &&
                    (q.allowFreeText || written.isEmpty()) &&
                    written.length <= 100_000 &&
                    (q.required == false || answer.optionIds.isNotEmpty() || written.isNotBlank())
                if (!valid) throw ClientError.InvalidRequest
                val value = linkedMapOf<String, kotlinx.serialization.json.JsonElement>("optionIds" to JsonArray(answer.optionIds.map(::JsonPrimitive)))
                if (written.isNotEmpty()) value["text"] = JsonPrimitive(written)
                wire[q.id] = JsonObject(value)
            }
            result["questionAnswers"] = JsonObject(wire)
        } else if (current.options.isNotEmpty()) {
            if (choice == null || current.options.none { it.id == choice }) throw ClientError.InvalidRequest
            result["answer"] = JsonPrimitive(choice)
        } else {
            if (text.isBlank() || text.length > 100_000) throw ClientError.InvalidRequest
        }
        return RemoteCommands.checked(JsonObject(result))
    }

    fun createProject(providerID: String, title: String, path: String): JsonObject {
        if (providerID !in setOf("codex", "claude", "grok", "devin") || title.isBlank() || title.length > 512 ||
            path.isEmpty() || path.length > 4096
        ) throw ClientError.InvalidRequest
        return RemoteCommands.checked(
            obj("type" to "create-project", "provider" to providerID, "title" to title, "path" to path, "useExisting" to true),
        )
    }

    fun createThread(projectID: String, threadID: String, model: ThreadModel, effort: String, permissionID: String, mayAnswer: Boolean): JsonObject {
        val permission = model.permissions.firstOrNull { it.id == permissionID }
        if (projectID.isEmpty() || projectID.length > 6144 || !isUuidString(threadID) || !model.ready || model.id.isEmpty() ||
            model.id.length > 6144 || permission == null || (permission.grants && !mayAnswer) ||
            !(effort.isEmpty() || (model.reasoningEfforts?.contains(effort) == true && effort.length <= 64))
        ) throw ClientError.InvalidRequest
        val fields = linkedMapOf<String, kotlinx.serialization.json.JsonElement>(
            "type" to JsonPrimitive("create-thread"),
            "projectId" to JsonPrimitive(projectID),
            "threadId" to JsonPrimitive(threadID),
            "title" to JsonPrimitive("New thread"),
            "titleSource" to JsonPrimitive("default"),
            "modelId" to JsonPrimitive(model.id),
            "workingCopy" to JsonPrimitive("shared"),
            "managed" to JsonPrimitive(false),
        )
        fields[if (permission.providerOwned) "providerMode" else "runtimeMode"] = JsonPrimitive(permission.id)
        if (effort.isNotEmpty()) fields["reasoningEffort"] = JsonPrimitive(effort)
        return RemoteCommands.checked(JsonObject(fields))
    }
}

// A reply, answer, stop or creation this phone sent that its computer has not confirmed. No prompt, answer
// text or token is kept in it. An unknown receipt after a restart never authorizes sending it again.
@Serializable
data class PendingOperation(
    val hostID: String,
    val clientID: String,
    val threadID: String,
    val requestID: String? = null,
    val draftID: String? = null,
    val kind: String,
    val id: String = UUID.randomUUID().toString(),
) {
    fun matches(hostID: String, clientID: String) = this.hostID == hostID && this.clientID == clientID

    fun reconciled(receipt: Receipt, deliveries: List<Delivery>): Boolean {
        if (kind == "answer") return receipt.confirmsAnswer
        // A completed transport receipt confirms provider delivery only when its draft status agrees.
        if (draftID != null) {
            val delivery = deliveries.firstOrNull { it.draftId == draftID && it.threadId == threadID }
            if (delivery != null) return delivery.status == "accepted" || delivery.status == "failed"
        }
        return draftID == null && receipt.status == "completed" && receipt.error == null
    }
}
