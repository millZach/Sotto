package com.millzach.sotto.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Display data from this computer's own model catalog. IDs are opaque Sotto IDs.
@Serializable
data class ThreadModel(
    val id: String,
    val name: String,
    val provider: String,
    val providerId: String? = null,
    val ready: Boolean,
    val recommended: Boolean? = null,
    val reasoningEfforts: List<String>? = null,
    val defaultReasoningEffort: String? = null,
    val runtimeModes: List<String>? = null,
    val providerModes: List<ProviderMode>? = null,
) {
    @Serializable
    data class ProviderMode(val id: String, val name: String, val allows: String? = null, val asks: String? = null)

    val startingEffort: String
        get() {
            val value = defaultReasoningEffort
            if (value != null && reasoningEfforts?.contains(value) == true) return value
            return reasoningEfforts?.firstOrNull() ?: ""
        }

    val permissions: List<ThreadPermission>
        get() {
            val modes = providerModes
            if (!modes.isNullOrEmpty()) {
                return modes.map { ThreadPermission(it.id, it.name, it.asks, grants = it.allows != "nothing", providerOwned = true) }
            }
            val labels = mapOf(
                "approval-required" to "Ask before actions",
                "auto-accept-edits" to "Allow edits",
                "auto" to "Allow actions",
                "full-access" to "Full access",
            )
            return (runtimeModes ?: emptyList()).mapNotNull { id ->
                labels[id]?.let { ThreadPermission(id, it, null, grants = id != "approval-required", providerOwned = false) }
            }
        }

    // Prefer an asking mode. A grant is never selected just because Can answer is on.
    val startingPermission: String get() = permissions.firstOrNull { !it.grants }?.id ?: ""
}

data class ThreadPermission(val id: String, val name: String, val asks: String?, val grants: Boolean, val providerOwned: Boolean)

@Serializable
data class HostFolder(val name: String, val path: String, val git: Boolean)

@Serializable
data class FolderCrumb(val name: String, val path: String? = null)

@Serializable
data class FolderListing(
    val path: String? = null,
    val home: String,
    val separator: String,
    val crumbs: List<FolderCrumb>,
    val folders: List<HostFolder>,
    val truncated: Boolean,
) {
    // Use the host's spelling, including drive roots; never apply this phone's path rules.
    val projectName: String
        get() {
            val name = crumbs.lastOrNull()?.name ?: "Project"
            return when {
                name.endsWith(":") -> name.dropLast(1) + " drive"
                name == "/" -> "Root"
                else -> name
            }
        }
}

sealed interface FolderResult {
    data class Listed(val listing: FolderListing) : FolderResult
    data object Missing : FolderResult
    data object Unreadable : FolderResult

    companion object {
        fun read(value: JsonElement): FolderResult {
            val o = value as? JsonObject ?: throw ClientError.InvalidProtocol
            return when (o["status"].stringOrNull()) {
                "listed" -> {
                    val listing = value.decodeAs<FolderListing>()
                    if (listing.separator !in setOf("/", "\\") || listing.crumbs.isEmpty() || listing.crumbs.size > 256 ||
                        listing.folders.size > 1000 || (listing.path != null && listing.path.isEmpty())
                    ) throw ClientError.InvalidProtocol
                    Listed(listing)
                }
                "missing" -> Missing
                "unreadable" -> Unreadable
                else -> throw ClientError.InvalidProtocol
            }
        }
    }
}

object NewThreads {
    fun startingModelID(shell: Shell): String {
        val selected = shell.configuration?.newThreadModelId
        if (!selected.isNullOrEmpty()) return selected
        val available = availableModels(shell.host)
        return (available.firstOrNull { it.recommended == true } ?: available.firstOrNull())?.id ?: ""
    }

    fun startingEffort(model: ThreadModel, shell: Shell): String {
        val desired = shell.configuration?.newThreadReasoningEffort
        val offered = model.reasoningEfforts
        if (desired.isNullOrEmpty() || offered.isNullOrEmpty()) return model.startingEffort
        if (desired in offered) return desired
        val reference = shell.host.models?.firstOrNull { it.id == shell.configuration.newThreadModelId }?.reasoningEfforts ?: offered
        val position = reference.indexOf(desired)
        if (position < 0 || reference.size < 2) return model.startingEffort
        return offered[Math.round(position.toDouble() / (reference.size - 1) * (offered.size - 1)).toInt()]
    }

    fun availableModels(host: HostSnapshot): List<ThreadModel> = (host.models ?: emptyList()).filter { model ->
        if (!model.ready) return@filter false
        val providers = host.providers
        if (providers != null) {
            val provider = providers.firstOrNull { it.id == model.providerId } ?: return@filter false
            provider.connection == "connected" && provider.capabilities.threads == true
        } else {
            host.capabilities.threads == true
        }
    }

    // The host declares its path format. Windows compares without case; POSIX preserves it.
    fun sameFolder(lhs: String?, rhs: String, separator: String): Boolean {
        if (lhs == null) return false
        fun key(value: String): String {
            var result = if (separator == "\\") value.replace("\\", "/").lowercase() else value
            while (result.length > 1 && result.endsWith("/")) result = result.dropLast(1)
            return result
        }
        return key(lhs) == key(rhs)
    }

    // `path` absent asks for the host's home folder; JsonNull asks for the top of the machine.
    fun folderRequest(path: JsonElement? = null): JsonObject {
        if (path != null && path !is JsonNull) {
            val value = path.stringOrNull()
            if (value.isNullOrEmpty() || value.length > 4096) throw ClientError.InvalidRequest
        }
        val request = if (path == null) JsonObject(emptyMap()) else JsonObject(mapOf("path" to path))
        return JsonObject(mapOf("op" to JsonPrimitive("host-folders"), "request" to request))
    }
}
