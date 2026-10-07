package com.millzach.sotto.net

import com.millzach.sotto.core.ClientError
import com.millzach.sotto.core.Health
import com.millzach.sotto.core.Hello
import com.millzach.sotto.core.HostEndpoint
import com.millzach.sotto.core.HostRefusal
import com.millzach.sotto.core.HostSession
import com.millzach.sotto.core.IncomingFrame
import com.millzach.sotto.core.ModelCatalogCache
import com.millzach.sotto.core.Pairing
import com.millzach.sotto.core.Shell
import com.millzach.sotto.core.Wire
import com.millzach.sotto.core.decodeAs
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// A reply as it arrived: its result, the model catalog this connection held then, and its place in the socket.
class Received<T>(val value: T, val sequence: Int)

// One computer's HTTP and socket. Every method is called on the main thread, and every socket event is
// handed back to it in the order it arrived, so pushes and replies stay in socket order.
class HostConnection(private val clientName: String) {
    var onPush: ((IncomingFrame, Int) -> Unit)? = null
    var onDisconnect: (() -> Unit)? = null

    private val main = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // Credentials never follow a redirect, and nothing is cached or kept in a cookie jar. A pairing POST is
    // never retried by the client on its own, so a one-use code is never spent twice.
    private val http = OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // OkHttp answers the host's pings and sends its own every 25 seconds; a pong that never comes ends the socket.
    private val sockets = http.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    private var session = ""
    private var generation = Any()
    private var received = 0
    private var catalog = ModelCatalogCache()
    private val pending = mutableMapOf<String, CompletableDeferred<Received<Reply>>>()
    private val deadlines = mutableMapOf<String, Job>()

    private class Reply(val result: JsonElement, val catalog: ModelCatalogCache)

    // Confirms Sotto is listening before pairing, reconnecting or removing a computer.
    suspend fun health(endpoint: HostEndpoint, reconnecting: Boolean = false): Health {
        val name = endpoint.machine
        val route = endpoint.route("/v1/health")
        val response = try { execute(Request.Builder().url(route).get().build()) } catch (_: IOException) {
            throw ClientError.HostUnreachable(name)
        }
        response.use {
            if (it.request.url.toString().trimEnd('/') != route.trimEnd('/')) throw ClientError.NotASottoHost(name)
            if (it.code == 429) throw ClientError.RateLimited
            if (reconnecting && it.code in setOf(502, 503)) throw ClientError.SottoNotRunning(name)
            val body = try { readBody(it) } catch (_: IOException) { throw ClientError.HostUnreachable(name) }
            if (it.code !in 200..299) throw ClientError.NotASottoHost(name)
            val health = try { Wire.decode(body).decodeAs<Health>() } catch (_: ClientError) { throw ClientError.NotASottoHost(name) }
            health.validate()
            return health
        }
    }

    // Pairs only with the host `health` found: a different host answering at the same address is refused.
    suspend fun pair(endpoint: HostEndpoint, expectedHostID: String, code: String): Pairing {
        val body = JsonObject(mapOf("v" to JsonPrimitive(1), "code" to JsonPrimitive(code), "name" to JsonPrimitive(clientName)))
        val pairing = post(endpoint, "/v1/pair", body = body).decodeAs<Pairing>()
        pairing.validate()
        if (pairing.hostId != expectedHostID) throw ClientError.InvalidIdentity
        return pairing
    }

    suspend fun revoke(endpoint: HostEndpoint, pairing: Pairing) {
        val health = health(endpoint, reconnecting = true)
        if (health.hostId != pairing.hostId) throw ClientError.InvalidIdentity
        val result = post(endpoint, "/v1/revoke", token = pairing.token)
        if ((result["revoked"] as? JsonPrimitive)?.booleanOrNull != true) throw ClientError.InvalidProtocol
    }

    suspend fun connect(endpoint: HostEndpoint, pairing: Pairing): Received<Hello> {
        disconnect()
        val current = generation
        val health = health(endpoint, reconnecting = true)
        if (current !== generation) throw ClientError.Disconnected
        if (health.hostId != pairing.hostId) throw ClientError.InvalidIdentity
        val access = post(endpoint, "/v1/session", token = pairing.token).decodeAs<HostSession>()
        if (current !== generation) throw ClientError.Disconnected
        access.validate(pairing)
        session = access.session
        val request = Request.Builder().url(endpoint.route("/v1/socket", socket = true))
            .header("Authorization", "Bearer $session").build()
        socket = sockets.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                // Read off the main thread, then handed over in arrival order.
                val frame = try { IncomingFrame.read(text) } catch (_: Exception) { null }
                main.launch {
                    if (current !== generation) return@launch
                    if (frame == null) { drop(); return@launch }
                    receive(frame)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.launch { if (current === generation) drop() }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.launch { if (current === generation) drop() }
            }
        })
        val hello = callReceived(Wire.snapshotHello)
        val greeting = try { hello.value.decodeAs<Hello>() } catch (error: ClientError) { disconnect(); throw error }
        val whole = catalogWhole(greeting, hello.catalog, current)
        if (whole.hostId != pairing.hostId || whole.clientId != pairing.clientId) { disconnect(); throw ClientError.InvalidIdentity }
        whole.shell.validate(pairing.hostId)
        return Received(whole, hello.sequence)
    }

    // Ends the connection for good, when its computer is removed.
    fun close() = disconnect()

    fun disconnect() {
        generation = Any()
        received = 0
        catalog = ModelCatalogCache()
        socket?.close(1001, null)
        socket = null
        session = ""
        val waiting = pending.values.toList()
        pending.clear()
        deadlines.values.forEach { it.cancel() }
        deadlines.clear()
        waiting.forEach { it.completeExceptionally(ClientError.Disconnected) }
    }

    private fun drop() {
        disconnect()
        onDisconnect?.invoke()
    }

    // A reply's result, with the catalog this connection held when it arrived.
    class Result internal constructor(val value: JsonElement, val sequence: Int, internal val catalog: ModelCatalogCache)

    suspend fun call(operation: JsonObject, id: String = UUID.randomUUID().toString()): JsonElement = callReceived(operation, id).value

    suspend fun callReceived(operation: JsonObject, id: String = UUID.randomUUID().toString()): Result {
        val reply = request(operation, id)
        return Result(reply.value.result, reply.sequence, reply.value.catalog)
    }

    // A shell with its model catalog put back from what this connection held when the reply arrived. One
    // naming a catalog this connection was never sent starts the connection again: a new hello carries it whole.
    fun shell(result: Result): Shell {
        val current = generation
        return catalogWhole(result.value.decodeAs<Shell>(), result.catalog, current)
    }

    private fun catalogWhole(shell: Shell, held: ModelCatalogCache, current: Any): Shell =
        held.whole(shell) ?: run {
            if (current === generation) drop()
            throw ClientError.Disconnected
        }

    private fun catalogWhole(hello: Hello, held: ModelCatalogCache, current: Any): Hello =
        held.whole(hello) ?: run {
            if (current === generation) drop()
            throw ClientError.Disconnected
        }

    private suspend fun request(operation: JsonObject, id: String): Received<Reply> {
        val open = socket
        if (open == null || session.isEmpty()) throw ClientError.Disconnected
        val text = Wire.request(id, session, operation)
        if (text.encodeToByteArray().size > Wire.MAXIMUM_FRAME_BYTES) throw ClientError.InvalidRequest
        val name = (operation["op"] as? JsonPrimitive)?.content ?: ""
        val answer = CompletableDeferred<Received<Reply>>()
        pending[id] = answer
        deadlines[id] = main.launch {
            delay(requestTimeout(name))
            finish(id, failure = requestFailure(name))
        }
        if (!open.send(text)) finish(id, failure = requestFailure(name))
        return answer.await()
    }

    private fun receive(frame: IncomingFrame) {
        received += 1
        when (frame) {
            is IncomingFrame.Reply -> {
                frame.catalog?.let { catalog = catalog.holding(it) }
                finish(frame.id, success = Received(Reply(frame.result, catalog), received))
            }
            is IncomingFrame.Refusal -> finish(frame.id, failure = HostRefusal(frame.failure))
            is IncomingFrame.ShellPush -> {
                catalog = catalog.holding(frame.shell)
                val restored = catalog.whole(frame.shell)
                if (restored == null) { drop(); return }
                onPush?.invoke(IncomingFrame.ShellPush(restored), received)
            }
            else -> onPush?.invoke(frame, received)
        }
    }

    private fun finish(id: String, success: Received<Reply>? = null, failure: Exception? = null) {
        deadlines.remove(id)?.cancel()
        val waiting = pending.remove(id) ?: return
        if (success != null) waiting.complete(success) else waiting.completeExceptionally(failure ?: ClientError.Disconnected)
    }

    private suspend fun post(endpoint: HostEndpoint, route: String, token: String? = null, body: JsonObject? = null): JsonObject {
        val url = endpoint.route(route)
        val builder = Request.Builder().url(url)
            .post((body?.toString() ?: "").toRequestBody("application/json".toMediaType()))
        if (token != null) builder.header("Authorization", "Bearer $token")
        val response = try { execute(builder.build()) } catch (_: IOException) { throw ClientError.Disconnected }
        response.use {
            if (it.request.url.toString() != url) throw ClientError.Disconnected
            // Retrying Remove after revocation succeeded but local deletion failed is safe.
            if (route == "/v1/revoke" && it.code == 401) {
                return JsonObject(mapOf("v" to JsonPrimitive(1), "revoked" to JsonPrimitive(true)))
            }
            if (it.code !in 200..299) throw refusal(route, it.code, endpoint.machine)
            val text = try { readBody(it) } catch (_: IOException) { throw ClientError.Disconnected }
            return Wire.decode(text)
        }
    }

    private suspend fun execute(request: Request): Response = suspendCancellableCoroutine { continuation ->
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
            override fun onResponse(call: Call, response: Response) = continuation.resume(response)
        })
    }

    private suspend fun readBody(response: Response): String = withContext(Dispatchers.IO) {
        val body = response.body ?: return@withContext ""
        if (body.contentLength() > Wire.MAXIMUM_FRAME_BYTES) throw IOException("too large")
        body.string()
    }

    companion object {
        // Detail and observe reads may carry a whole thread over a slow link; everything else answers quickly.
        fun requestTimeout(operation: String): Long = if (operation == "detail" || operation == "observe") 120_000 else 30_000

        fun requestFailure(operation: String): ClientError = when (operation) {
            "hello" -> ClientError.ConnectionTimedOut
            "command" -> ClientError.Uncertain
            else -> ClientError.ReadTimedOut
        }

        // What a refused request means. Only 401 and 403 say the pairing is gone; anything else from a
        // computer that answered means Sotto isn't running, apart from a rate limit's explicit wait.
        fun refusal(route: String, status: Int, name: String): ClientError = when {
            status == 429 -> ClientError.RateLimited
            route == "/v1/pair" && status in 400..499 ->
                ClientError.Rejected("That code didn't work. Codes work once and last five minutes; get a new one on that computer.")
            status == 401 || status == 403 ->
                ClientError.Rejected("This phone is no longer paired with $name. Remove it in Computers and add it again.")
            else -> ClientError.SottoNotRunning(name)
        }
    }
}
