package com.millzach.sotto.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.millzach.sotto.core.AgentRequest
import com.millzach.sotto.core.ClientError
import com.millzach.sotto.core.Commands
import com.millzach.sotto.core.ComputerFilter
import com.millzach.sotto.core.ComputerName
import com.millzach.sotto.core.ComputerStatus
import com.millzach.sotto.core.ComputerThreads
import com.millzach.sotto.core.FolderListing
import com.millzach.sotto.core.FolderResult
import com.millzach.sotto.core.Health
import com.millzach.sotto.core.HostEndpoint
import com.millzach.sotto.core.HostFinder
import com.millzach.sotto.core.HostRefusal
import com.millzach.sotto.core.IncomingFrame
import com.millzach.sotto.core.NewThreads
import com.millzach.sotto.core.PairingCode
import com.millzach.sotto.core.PendingOperation
import com.millzach.sotto.core.Project
import com.millzach.sotto.core.Provider
import com.millzach.sotto.core.ProviderCapabilities
import com.millzach.sotto.core.QuestionAnswer
import com.millzach.sotto.core.Receipt
import com.millzach.sotto.core.SavedComputer
import com.millzach.sotto.core.Shell
import com.millzach.sotto.core.SnapshotGuard
import com.millzach.sotto.core.ThreadDetail
import com.millzach.sotto.core.ThreadModel
import com.millzach.sotto.core.ThreadRef
import com.millzach.sotto.core.ThreadSummary
import com.millzach.sotto.core.applying
import com.millzach.sotto.core.decodeAs
import com.millzach.sotto.core.isNullish
import com.millzach.sotto.net.HostConnection
import com.millzach.sotto.store.SecureStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import kotlin.math.min

// A computer step 1 of adding found at a private address, with the health it answered.
data class FoundHost(val endpoint: HostEndpoint, val health: Health) {
    // The computer's own name, or its name on the tailnet from a host that sends none.
    val name: String get() = health.computerName ?: endpoint.machine
}

// What this phone knows about one paired computer while the app runs. Nothing here is saved.
data class Live(
    val status: ComputerStatus = ComputerStatus.Connecting,
    val shell: Shell? = null,
    val mayAnswer: Boolean = false,
    val features: List<String> = emptyList(),
    // Why the last connection ended, for the computer's own page.
    val problem: String? = null,
)

// Every paired computer, each with its own connection, session and state. A computer that can't be reached,
// or fails, never holds up the others. Everything that names a thread names its computer too. All of it runs
// on the main thread, as the iPhone's AppModel runs on the main actor.
class AppModel(
    private val store: SecureStore,
    private val clientName: String,
    private val scope: CoroutineScope = MainScope(),
    private val retryJitter: () -> Double = { 0.8 + Math.random() * 0.4 },
) {
    // In the order they were added. Credentials live in secure storage, one item per host ID.
    var computers by mutableStateOf(listOf<SavedComputer>()); private set
    var live by mutableStateOf(mapOf<String, Live>()); private set
    var selected by mutableStateOf<ThreadRef?>(null); private set
    var pending by mutableStateOf(listOf<PendingOperation>()); private set

    // Finding or pairing a computer.
    var working by mutableStateOf(false); private set
    var storageReady by mutableStateOf(false); private set

    // The computer being removed, while its pairing is revoked.
    var removing by mutableStateOf<String?>(null); private set

    // What just happened, shown above whatever page is open.
    var feedback by mutableStateOf<String?>(null); private set
    private var feedbackOperations = setOf<String>()
    private fun say(words: String?) { feedback = words; feedbackOperations = emptySet() }
    fun dismissFeedback() = say(null)

    // What went wrong while finding or pairing a computer.
    var pairFeedback by mutableStateOf<String?>(null)

    // Unsent replies, by ThreadRef.id.
    var drafts by mutableStateOf(mapOf<String, String>())
    var submitted by mutableStateOf(mapOf<String, String>()); private set
    var failedReplies by mutableStateOf(mapOf<String, String>()); private set

    // The computer step 1 of adding found, waiting for its code in step 2.
    var found by mutableStateOf<FoundHost?>(null); private set

    // Whether Add computer is open over the tabs.
    var adding by mutableStateOf(false)
    var creatingHostID by mutableStateOf<String?>(null); private set
    var creationFeedback by mutableStateOf<String?>(null)

    // The computer menu on Threads.
    var show by mutableStateOf<ComputerFilter>(ComputerFilter.All)
    private var openDetail by mutableStateOf<ThreadDetail?>(null)
    var detailProblem by mutableStateOf<String?>(null); private set

    private var indexAccount: String? = SecureStore.INDEX
    // Finds and pairs computers; each paired computer gets its own connection.
    private val finder by lazy { HostConnection(clientName) }
    private val connections = mutableMapOf<String, HostConnection>()
    private val generations = mutableMapOf<String, Any>()
    private var connecting = setOf<String>()
    private val connectWaiters = mutableMapOf<String, MutableList<CompletableDeferred<Unit>>>()
    private var active = false
    private val retries = mutableMapOf<String, Job>()
    private val retryAttempts = mutableMapOf<String, Int>()
    private var pairGeneration = Any()
    private var detailVersion = 0
    private var detailReload: Job? = null
    private var detailReloadID: Any? = null
    private var detailWantedRevision = 0L
    private val shellSequences = mutableMapOf<String, Int>()
    private val dispatchingAnswers = mutableSetOf<String>()
    // More than one check can await the same computer; keep markers until every check returns.
    private val deliveryChecks = mutableMapOf<String, Int>()

    private fun setConnecting(next: Set<String>) {
        connecting = next
        // An attempt ends when its computer leaves `connecting`: it finished, or a disconnect, removal or
        // the app going to the background ended it early.
        for (hostID in connectWaiters.keys.toList()) {
            if (hostID !in connecting) connectWaiters.remove(hostID)?.forEach { it.complete(Unit) }
        }
    }

    init { loadComputers() }

    // Runs an action in the model's own scope, so it finishes even when the screen that started it goes
    // away: pairing replaces the pairing screen with the tabs, and leaving a thread must not cut off a reply.
    fun launch(action: suspend AppModel.() -> Unit): Job = scope.launch { action() }

    // MARK: Reading

    fun computer(hostID: String): SavedComputer? = computers.firstOrNull { it.hostID == hostID }
    fun name(hostID: String): String = computer(hostID)?.name ?: "the computer"
    fun status(hostID: String): ComputerStatus = live[hostID]?.status ?: ComputerStatus.Connecting
    fun online(hostID: String): Boolean = status(hostID) == ComputerStatus.Online
    fun mayAnswer(hostID: String): Boolean = live[hostID]?.mayAnswer ?: false
    fun problem(hostID: String): String? = live[hostID]?.problem
    val anyConnecting: Boolean get() = computers.any { status(it.hostID) == ComputerStatus.Connecting }

    // Every computer as the lists read it, in the order they were added.
    val lists: List<ComputerThreads>
        get() = computers.map { computer ->
            val state = live[computer.hostID]
            ComputerThreads(
                computer.hostID, computer.name, state?.status ?: ComputerStatus.Connecting,
                state?.shell?.host?.threads ?: emptyList(), state?.shell?.host?.projects ?: emptyList(),
            )
        }

    fun thread(ref: ThreadRef): ThreadSummary? = live[ref.hostID]?.shell?.host?.threads?.firstOrNull { it.id == ref.threadID }
    fun detail(ref: ThreadRef): ThreadDetail? = if (selected == ref && openDetail?.threadId == ref.threadID) openDetail else null

    private fun scoped(hostID: String): List<PendingOperation> {
        val computer = computer(hostID) ?: return emptyList()
        return pending.filter { it.matches(hostID, computer.pairing.clientId) }
    }

    fun pending(ref: ThreadRef): List<PendingOperation> = scoped(ref.hostID).filter { it.threadID == ref.threadID }

    fun provider(ref: ThreadRef): Provider? {
        val providerID = thread(ref)?.providerId
        return live[ref.hostID]?.shell?.host?.providers?.firstOrNull { it.id == providerID }
    }

    private fun capabilities(ref: ThreadRef): ProviderCapabilities? = provider(ref)?.capabilities ?: live[ref.hostID]?.shell?.host?.capabilities
    private fun canAct(ref: ThreadRef) = online(ref.hostID) && thread(ref) != null && pending(ref).isEmpty()

    fun canSend(ref: ThreadRef): Boolean {
        val thread = thread(ref) ?: return false
        if (!canAct(ref) || thread.status == "running" || thread.requests.isNotEmpty()) return false
        val source = provider(ref)
        return (capabilities(ref)?.submit ?: false) && (source == null || source.connection == "connected")
    }

    fun canInterrupt(ref: ThreadRef): Boolean =
        online(ref.hostID) && pending(ref).all { it.kind == "reply" } && thread(ref)?.status == "running" &&
            (capabilities(ref)?.interrupt ?: false)

    fun canAnswer(request: AgentRequest, ref: ThreadRef): Boolean {
        if (!canAct(ref) || !mayAnswer(ref.hostID) || !request.supported) return false
        val allowed = capabilities(ref)
        return if (request.kind == "permission") allowed?.permissions ?: false else allowed?.questions ?: false
    }

    // MARK: Starting and stopping

    // Publish nothing until every read succeeds: an item that can't be opened never looks missing.
    private fun loadComputers() {
        if (storageReady) return
        val storageProblem = "Saved connection details could not be read. Unlock this phone and return to Sotto."
        try {
            val warnings = mutableListOf<String>()
            val strings = ListSerializer(String.serializer())
            var resetNotices = false
            val previousNotices = try { store.read(strings, SecureStore.NOTICES) ?: emptyList() } catch (_: SecureStore.Undecodable) {
                resetNotices = true
                emptyList()
            }
            val notices = previousNotices.toMutableSet()
            var unreadable = 0
            fun unreadableComputer(account: String) { if (notices.add(account)) unreadable += 1 }

            var announceRecovery = false
            var index: List<String>?
            var account: String? = SecureStore.INDEX
            var recovered = false
            try {
                index = store.read(strings, SecureStore.INDEX)
            } catch (_: SecureStore.Undecodable) {
                // Keep the damaged original. A separate index keeps the recovered order from now on.
                recovered = true
                account = SecureStore.RECOVERED_INDEX
                announceRecovery = SecureStore.RECOVERED_INDEX !in store.accounts()
                index = try { store.read(strings, SecureStore.RECOVERED_INDEX) } catch (_: SecureStore.Undecodable) {
                    account = null
                    null
                }
                val discovered = store.accounts().filter { it.startsWith("computer.") }.map { it.removePrefix("computer.") }.sorted()
                index = (index ?: emptyList()) + discovered
            }
            val seen = mutableSetOf<String>()
            val order = (index ?: emptyList()).filter { seen.add(it) }
            val kept = mutableListOf<SavedComputer>()
            for (hostID in order) {
                try {
                    val computer = readComputer(SecureStore.account(hostID))
                    if (computer != null && computer.hostID == hostID) kept += computer else unreadableComputer(SecureStore.account(hostID))
                } catch (_: SecureStore.Undecodable) {
                    unreadableComputer(SecureStore.account(hostID))
                }
            }
            val markers = try {
                store.read(ListSerializer(PendingOperation.serializer()), SecureStore.PENDING) ?: emptyList()
            } catch (_: SecureStore.Undecodable) {
                if (notices.add(SecureStore.PENDING)) warnings += MARKERS_UNREADABLE
                emptyList()
            }
            if (account != null && (recovered || order != index)) store.write(strings, order, account)
            if (resetNotices || notices != previousNotices.toSet()) store.write(strings, notices.sorted(), SecureStore.NOTICES)
            pending = markers.filter { marker -> kept.any { marker.matches(it.hostID, it.pairing.clientId) } }
            computers = kept
            indexAccount = account
            live = kept.associate { it.hostID to Live() }
            storageReady = true
            if (unreadable > 0) warnings += pairingWarning(unreadable)
            if (announceRecovery) warnings.add(0, if (kept.isEmpty()) "The saved computer list could not be recovered." else "Recovered the saved computer list.")
            if (warnings.isNotEmpty()) {
                say(warnings.joinToString(" "))
                pairFeedback = feedback
            } else {
                if (feedback == storageProblem) say(null)
                if (pairFeedback == storageProblem) pairFeedback = null
            }
        } catch (_: Exception) {
            say(storageProblem)
            pairFeedback = feedback
        }
    }

    // Invalid records need pairing again. A storage failure still refuses the entire load.
    private fun readComputer(account: String): SavedComputer? {
        val computer = store.read(SavedComputer.serializer(), account) ?: return null
        try { computer.validate() } catch (_: Exception) { throw SecureStore.Undecodable(account) }
        return computer
    }

    // The app came to the front, or went to the background.
    fun phase(foreground: Boolean) {
        if (foreground) {
            val wasReady = storageReady
            loadComputers()
            if (active && (wasReady || !storageReady)) return
            active = true
            if (!storageReady) return
            scope.launch { reconnectAll() }
        } else {
            cancelDetailReload()
            retries.values.forEach { it.cancel() }
            retries.clear()
            retryAttempts.clear()
            active = false
            pairGeneration = Any()
            working = false
            openDetail = null
            for ((hostID, connection) in connections) {
                generations[hostID] = Any()
                connection.disconnect()
            }
            setConnecting(emptySet())
            live = live.mapValues { it.value.copy(status = ComputerStatus.Connecting, mayAnswer = false) }
        }
    }

    suspend fun reconnectAll() = coroutineScope {
        computers.map { it.hostID }.map { async { connect(it) } }.awaitAll()
    }

    // Pull to refresh: reconnects every computer, but returns once the ones that were reachable are back,
    // rather than waiting out one that can't be reached. With none reachable, it waits for all.
    suspend fun refresh() {
        val started = computers.map { online(it.hostID) to scope.async { connect(it.hostID) } }
        val awaited = if (started.any { it.first }) started.filter { it.first } else started
        awaited.forEach { it.second.await() }
    }

    // A fresh session, shell and open-thread detail from one computer. Only that computer's state changes.
    // While the computer is already connecting, this waits for that attempt rather than starting another.
    suspend fun connect(hostID: String) {
        val saved = computer(hostID)
        if (!storageReady || !active || saved == null) return
        if (hostID in connecting) {
            val waiter = CompletableDeferred<Unit>()
            connectWaiters.getOrPut(hostID) { mutableListOf() } += waiter
            waiter.await()
            return
        }
        retries.remove(hostID)?.cancel()
        val current = Any()
        generations[hostID] = current
        setConnecting(connecting + hostID)
        shellSequences[hostID] = 0
        try {
            update(hostID) { it.copy(status = ComputerStatus.Connecting, mayAnswer = false, problem = null) }
            if (selected?.hostID == hostID) { cancelDetailReload(); openDetail = null; detailProblem = null }
            try {
                val endpoint = saved.endpoint ?: throw ClientError.InvalidHost
                val greeting = connection(hostID).connect(endpoint, saved.pairing)
                if (generations[hostID] !== current) return
                applyShell(greeting.value.shell, hostID, greeting.sequence, reconcileAnswers = false)
                update(hostID) {
                    // An older host can push a newer shell before hello finishes, without this field.
                    val allowed = if (it.shell?.clientCapabilities == null) greeting.value.capabilities.mayAnswer else it.mayAnswer
                    it.copy(status = ComputerStatus.Online, mayAnswer = allowed, features = greeting.value.features ?: emptyList())
                }
                retryAttempts.remove(hostID)
                selected?.let { if (it.hostID == hostID && thread(it) == null) selected = null }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (generations[hostID] !== current) return
                update(hostID) { it.copy(status = ComputerStatus.Unreachable, mayAnswer = false, problem = error.message) }
                connections[hostID]?.disconnect()
                if (error is ClientError.InvalidIdentity || error is ClientError.InvalidProtocol ||
                    error is ClientError.InvalidHost || error is ClientError.Rejected
                ) return
                scheduleRetry(hostID)
                return
            }
            retries.remove(hostID)?.cancel()
            // A refused or slow thread read does not mean the computer's connection was lost.
            try { observeAndRead(hostID) } catch (error: CancellationException) { throw error } catch (_: Exception) {
                if (generations[hostID] === current) detailProblem = "This thread could not be loaded. Nothing was lost. Try again."
            }
            checkDelivery(hostID)
        } finally {
            if (generations[hostID] === current) setConnecting(connecting - hostID)
        }
    }

    private fun scheduleRetry(hostID: String) {
        if (!active || computer(hostID) == null || retries[hostID] != null) return
        val attempt = retryAttempts[hostID] ?: 0
        retryAttempts[hostID] = min(attempt + 1, 5)
        val delayMs = (min(30.0, (1 shl min(attempt, 5)) * retryJitter()) * 1000).toLong()
        retries[hostID] = scope.launch {
            delay(delayMs)
            if (!active || computer(hostID) == null) return@launch
            retries.remove(hostID)
            connect(hostID)
        }
    }

    private fun connection(hostID: String): HostConnection = connections.getOrPut(hostID) {
        HostConnection(clientName).apply {
            onPush = { frame, sequence -> push(frame, hostID, sequence) }
            onDisconnect = {
                generations[hostID] = Any()
                setConnecting(connecting - hostID)
                if (selected?.hostID == hostID) cancelDetailReload()
                update(hostID) { it.copy(status = ComputerStatus.Unreachable, mayAnswer = false, problem = ClientError.Disconnected.message) }
                scheduleRetry(hostID)
            }
        }
    }

    private fun update(hostID: String, change: (Live) -> Live) {
        if (computer(hostID) == null) return
        live = live + (hostID to change(live[hostID] ?: Live()))
    }

    // MARK: Adding a computer

    fun startAdding() { found = null; pairFeedback = null; adding = true }

    // Add computer closed. A code already spent still finishes pairing; anything else is dropped.
    fun closeAdding() { adding = false; pairGeneration = Any(); working = false; found = null; pairFeedback = null }

    // Step 1: find the computer from its machine name (or full address) and confirm Sotto answers there:
    // on 8443, where the desktop serves it, then on 443.
    suspend fun find(typed: String) {
        if (working || !storageReady) return
        working = true
        pairFeedback = null
        val current = pairGeneration
        try {
            val candidates = HostFinder.candidates(typed, SystemLookup::names)
            val (endpoint, health) = HostFinder.probe(candidates) { finder.health(it) }
            if (current !== pairGeneration) return
            val existing = computer(health.hostId)
            if (existing != null) {
                pairFeedback = "This phone is already paired with ${existing.name}. To pair it again, remove it in Computers first."
                return
            }
            found = FoundHost(endpoint, health)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (current === pairGeneration) pairFeedback = error.message
        } finally {
            if (current === pairGeneration) working = false
        }
    }

    fun changeComputer() { found = null; pairFeedback = null }

    // Step 2: spend the code on the computer step 1 found.
    suspend fun pair(typed: String) {
        val found = found
        if (working || !storageReady || found == null) return
        working = true
        pairFeedback = null
        val current = pairGeneration
        try {
            val code = PairingCode.normalized(typed)
            store.checkWritable()
            // Kept even if Add computer closed or the app went to the background meanwhile: the code is spent
            // and the computer holds this client.
            val pairing = finder.pair(found.endpoint, found.health.hostId, code)
            val computer = SavedComputer(found.endpoint.url, pairing, found.health.computerName)
            // Markers from an earlier pairing with this computer must never attach to the new client.
            val markers = pending.filter { it.hostID != computer.hostID }
            var savedCredential = false
            try {
                store.write(SavedComputer.serializer(), computer, SecureStore.account(computer.hostID))
                savedCredential = true
                indexAccount?.let { store.write(ListSerializer(String.serializer()), computers.map { it.hostID }.filter { it != computer.hostID } + computer.hostID, it) }
                store.write(ListSerializer(PendingOperation.serializer()), markers, SecureStore.PENDING)
            } catch (error: Exception) {
                if (savedCredential) {
                    runCatching { store.remove(SecureStore.account(computer.hostID)) }
                    indexAccount?.let { account -> runCatching { store.write(ListSerializer(String.serializer()), computers.map { it.hostID }, account) } }
                }
                runCatching { finder.revoke(found.endpoint, pairing) }
                throw error
            }
            pending = markers
            computers = computers.filter { it.hostID != computer.hostID } + computer
            live = live + (computer.hostID to Live())
            // A pairing that finishes after Cancel is saved but leaves a newer Add computer alone.
            if (current === pairGeneration) { this.found = null; working = false; adding = false }
            connect(computer.hostID)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (current === pairGeneration) { pairFeedback = error.message; working = false }
        }
    }

    // MARK: Looking after a computer

    fun rename(hostID: String, typed: String) {
        val computer = computer(hostID)?.copy(localName = ComputerName.cleaned(typed)) ?: return
        try {
            store.write(SavedComputer.serializer(), computer, SecureStore.account(hostID))
            computers = computers.map { if (it.hostID == hostID) computer else it }
        } catch (error: Exception) {
            say(error.message)
        }
    }

    // Revokes this phone on the computer where it can be reached, then forgets the computer here either way.
    suspend fun remove(hostID: String) {
        val saved = computer(hostID)
        if (!storageReady || removing != null || saved == null) return
        removing = hostID
        try {
            val endpoint = saved.endpoint
            val outcome = if (endpoint == null) Revocation.Unconfirmed else try {
                connection(hostID).revoke(endpoint, saved.pairing)
                Revocation.Confirmed
            } catch (error: CancellationException) {
                throw error
            } catch (_: ClientError.HostUnreachable) {
                Revocation.Unreachable
            } catch (_: ClientError.Disconnected) {
                Revocation.Unreachable
            } catch (_: Exception) {
                Revocation.Unconfirmed
            }
            // The item goes first: an index entry without its item is skipped at launch, and markers for a
            // computer that isn't there are dropped then too, so the later writes can fail without harm.
            try { store.remove(SecureStore.account(hostID)) } catch (error: Exception) { say(error.message); return }
            val rest = computers.filter { it.hostID != hostID }
            val markers = pending.filter { it.hostID != hostID }
            indexAccount?.let { account -> runCatching { store.write(ListSerializer(String.serializer()), rest.map { it.hostID }, account) } }
            runCatching { store.write(ListSerializer(PendingOperation.serializer()), markers, SecureStore.PENDING) }
            retries.remove(hostID)?.cancel()
            retryAttempts.remove(hostID)
            generations[hostID] = Any()
            setConnecting(connecting - hostID)
            connections.remove(hostID)?.close()
            val gone = pending.filter { it.hostID == hostID }.map { it.id }.toSet()
            computers = rest
            live = live - hostID
            pending = markers
            if (selected?.hostID == hostID) { cancelDetailReload(); selected = null; openDetail = null; detailProblem = null }
            if (show == ComputerFilter.Only(hostID)) show = ComputerFilter.All
            val prefix = "$hostID/"
            drafts = drafts.filterKeys { !it.startsWith(prefix) }
            failedReplies = failedReplies.filterKeys { !it.startsWith(prefix) }
            submitted = submitted.filterKeys { it !in gone }
            val words = outcome.words(saved.name, saved.pairing.clientId)
            say(words)
            // With nothing left paired the app goes back to the pairing steps, which show this instead.
            if (rest.isEmpty()) pairFeedback = words
        } finally {
            removing = null
        }
    }

    private enum class Revocation {
        Confirmed, Unreachable, Unconfirmed;

        fun words(name: String, clientID: String): String {
            val there = "Remove it there too: in Settings › Phones on $name, or on a host without a screen with its --revoke-client $clientID command."
            return when (this) {
                Confirmed -> "Removed $name."
                Unreachable -> "Removed $name from this phone. It couldn’t be reached, so it still lists this phone. $there"
                Unconfirmed -> "Removed $name from this phone, but couldn’t confirm removal there, so it may still list this phone. $there"
            }
        }
    }

    // MARK: The open thread

    suspend fun select(ref: ThreadRef?) {
        cancelDetailReload()
        val previous = selected
        selected = ref
        openDetail = null
        detailProblem = null
        detailVersion += 1
        if (previous != null && previous.hostID != ref?.hostID && online(previous.hostID)) {
            connections[previous.hostID]?.let { before -> runCatching { before.call(observe(emptyList())) } }
        }
        // Another thread may have been opened, or its computer reconnected, while the last one was let go.
        if (ref == null || selected != ref || !online(ref.hostID)) return
        val current = generations[ref.hostID]
        try { observeAndRead(ref.hostID) } catch (error: CancellationException) { throw error } catch (_: Exception) {
            if (generations[ref.hostID] === current && selected == ref) detailProblem = "This thread could not be loaded. Nothing was lost. Try again."
        }
    }

    private fun observe(threadIDs: List<String>) = JsonObject(
        mapOf("op" to JsonPrimitive("observe"), "threadIds" to JsonArray(threadIDs.map(::JsonPrimitive))),
    )

    private fun detailRequest(threadID: String) = JsonObject(mapOf("op" to JsonPrimitive("detail"), "threadId" to JsonPrimitive(threadID)))

    // Tells one computer which of its threads is open here, and reads that thread.
    private suspend fun observeAndRead(hostID: String) {
        val connection = connections[hostID] ?: return
        val current = generations[hostID] ?: return
        val ref = selected?.takeIf { it.hostID == hostID }
        connection.call(observe(listOfNotNull(ref?.threadID)))
        if (generations[hostID] !== current || ref == null || ref != selected) return
        // observe sends the initial detail before acknowledging. Do not download it twice.
        if (openDetail?.threadId == ref.threadID) return
        val version = detailVersion
        val next = readDetail(connection.call(detailRequest(ref.threadID)))
        applyDetail(next, ref, current, version)
    }

    private fun readDetail(value: JsonElement): ThreadDetail? = if (value.isNullish()) null else value.decodeAs<ThreadDetail>()

    private fun cancelDetailReload() {
        detailReload?.cancel()
        detailReload = null
        detailReloadID = null
        detailWantedRevision = 0L
    }

    // Several deltas can arrive after a gap. One full read repairs the base for all of them.
    private fun reloadDetail(ref: ThreadRef) {
        val connection = connections[ref.hostID]
        val epoch = generations[ref.hostID]
        if (detailReload != null || selected != ref || connection == null || epoch == null) return
        val id = Any()
        detailReloadID = id
        val version = detailVersion
        detailReload = scope.launch {
            var repeatRead = false
            try {
                val next = readDetail(connection.call(detailRequest(ref.threadID)))
                applyDetail(next, ref, epoch, version)
                // A newer delta may have arrived during the read. Do not lose it because a repair was in flight.
                repeatRead = next != null && selected == ref && generations[ref.hostID] === epoch &&
                    (openDetail?.revision ?: 0L) < detailWantedRevision
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                if (selected == ref && generations[ref.hostID] === epoch) detailProblem = "This thread could not be refreshed. Nothing was lost. Try again."
            } finally {
                if (detailReloadID === id) {
                    detailReload = null
                    detailReloadID = null
                    if (repeatRead) reloadDetail(ref)
                }
            }
        }
    }

    // Full snapshots may race live pushes or a reconnect. Neither an older revision nor a result from an
    // earlier connection or selection can replace what is shown.
    private fun applyDetail(next: ThreadDetail?, ref: ThreadRef, epoch: Any, versionAtRead: Int? = null) {
        val now = generations[ref.hostID]
        if (now !== epoch || ref != selected) return
        if (next != null && next.threadId != ref.threadID) throw ClientError.InvalidIdentity
        val accepted = SnapshotGuard.accepts(
            requestGeneration = epoch, currentGeneration = now, requestedThread = ref.id, selectedThread = selected?.id,
            incomingRevision = next?.revision, currentRevision = openDetail?.revision,
            changedSinceRead = versionAtRead != null && versionAtRead != detailVersion,
        )
        if (!accepted) return
        if (next != null && next.revision == openDetail?.revision) return
        openDetail = next
        detailProblem = null
        detailVersion += 1
    }

    suspend fun earlier(ref: ThreadRef) {
        val connection = connections[ref.hostID]
        if (!online(ref.hostID) || selected != ref || connection == null) return
        val current = generations[ref.hostID]
        try {
            connection.call(command(Commands.loadEarlier(ref.threadID)))
            if (generations[ref.hostID] !== current || selected != ref) return
            observeAndRead(ref.hostID)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (generations[ref.hostID] === current) say(error.message)
        }
    }

    private fun command(command: JsonObject) = JsonObject(mapOf("op" to JsonPrimitive("command"), "command" to command))

    // MARK: Replies, answers and stops, each to its thread's own computer

    suspend fun send(ref: ThreadRef) {
        val text = drafts[ref.id]
        val computer = computer(ref.hostID)
        if (!canSend(ref) || text == null || computer == null) return
        val draft = UUID.randomUUID().toString()
        try {
            val command = Commands.prompt(ref.threadID, text, draft)
            val operation = PendingOperation(ref.hostID, computer.pairing.clientId, ref.threadID, draftID = draft, kind = "reply")
            remember(operation)
            submitted = submitted + (operation.id to text)
            drafts = drafts + (ref.id to "")
            dispatch(command, operation)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            say(error.message)
        }
    }

    // Answers a request from the open thread's sheet, after rechecking the computer's authority.
    suspend fun answer(request: AgentRequest, ref: ThreadRef, choice: String? = null, text: String = "", answers: Map<String, QuestionAnswer> = emptyMap()) {
        val thread = thread(ref)
        val computer = computer(ref.hostID)
        if (thread == null || !canAnswer(request, ref) || computer == null) return
        try {
            val command = Commands.answer(ref.threadID, request, thread.requests, choice, text, answers)
            val operation = PendingOperation(ref.hostID, computer.pairing.clientId, ref.threadID, requestID = request.id, kind = "answer")
            remember(operation)
            dispatch(command, operation)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            say(error.message)
        }
    }

    suspend fun interrupt(ref: ThreadRef) {
        val computer = computer(ref.hostID)
        if (!canInterrupt(ref) || computer == null) return
        try {
            val command = Commands.interrupt(ref.threadID)
            val operation = PendingOperation(ref.hostID, computer.pairing.clientId, ref.threadID, kind = "interrupt")
            remember(operation)
            dispatch(command, operation)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            say(error.message)
        }
    }

    private fun remember(operation: PendingOperation) {
        if (pending.size >= 100) throw ClientError.Rejected("Check the unconfirmed actions before sending more.")
        val next = pending + operation
        store.write(ListSerializer(PendingOperation.serializer()), next, SecureStore.PENDING)
        pending = next
    }

    private fun forgetMarker(id: String) {
        val next = pending.filter { it.id != id }
        store.write(ListSerializer(PendingOperation.serializer()), next, SecureStore.PENDING)
        pending = next
        submitted = submitted - id
    }

    private suspend fun dispatch(command: JsonObject, operation: PendingOperation): Shell? {
        val hostID = operation.hostID
        val current = generations[hostID]
        if (operation.kind == "answer") dispatchingAnswers += operation.id
        try {
            val connection = connections[hostID]
            if (connection == null) {
                operationFeedback(ClientError.Uncertain.message, setOf(operation.id))
                return null
            }
            val result = connection.callReceived(command(command), id = operation.id)
            if (generations[hostID] !== current) return null
            val next = connection.shell(result)
            applyShell(next, hostID, result.sequence, reconcileAnswers = false)
            checkDelivery(hostID)
            if (generations[hostID] !== current) return null
            val refused = next.error
            if (refused != null) {
                if (operation.kind.startsWith("create-")) creationFeedback = refused
                return null
            }
            return next
        } catch (error: CancellationException) {
            throw error
        } catch (error: HostRefusal) {
            if (generations[hostID] !== current) return null
            // Revocation can replace an acknowledgement AFTER the action ran. Generic unavailable failures
            // may also follow provider side effects, so only these codes say nothing happened.
            if (error.failure.code in setOf("invalid_request", "stale_request", "forbidden", "busy")) {
                try { rejectOperation(operation) } catch (stored: Exception) { say(stored.message); return null }
            }
            if (error.failure.code == "forbidden") update(hostID) { it.copy(mayAnswer = false) }
            if (error.failure.code == "unauthenticated") update(hostID) { it.copy(status = ComputerStatus.Unreachable, problem = error.message) }
            say(error.message)
        } catch (_: Exception) {
            if (generations[hostID] === current) {
                operationFeedback("Delivery is unconfirmed. Reconnect and check the thread before sending again.", setOf(operation.id))
            }
        } finally {
            dispatchingAnswers -= operation.id
        }
        return null
    }

    suspend fun checkDelivery(hostID: String) {
        val connection = connections[hostID]
        if (!online(hostID) || scoped(hostID).isEmpty() || connection == null) return
        val current = generations[hostID]
        deliveryChecks[hostID] = (deliveryChecks[hostID] ?: 0) + 1
        try {
            val fresh = connection.callReceived(JsonObject(mapOf("op" to JsonPrimitive("shell"))))
            if (generations[hostID] !== current) return
            applyShell(connection.shell(fresh), hostID, fresh.sequence, reconcileAnswers = false)
            for (item in scoped(hostID)) {
                val receipt = connection.call(JsonObject(mapOf("op" to JsonPrimitive("receipt"), "commandId" to JsonPrimitive(item.id)))).decodeAs<Receipt>()
                if (generations[hostID] !== current) return
                if (scoped(hostID).none { it.id == item.id }) continue
                settle(item, receipt, live[hostID]?.shell)
            }
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            if (generations[hostID] === current) {
                operationFeedback("Delivery to ${name(hostID)} could not be checked. Nothing was resent. Reconnect to try again.", scoped(hostID).map { it.id }.toSet())
            }
        } finally {
            deliveryChecks[hostID] = (deliveryChecks[hostID] ?: 1) - 1
        }
    }

    private fun operationFeedback(words: String?, operations: Set<String>) {
        feedback = words
        feedbackOperations = operations
    }

    private fun settle(item: PendingOperation, receipt: Receipt? = null, shell: Shell?) {
        // A phone-minted Sotto ID identifies this exact creation even after its receipt expired.
        if (item.kind == "create-thread" && shell?.host?.threads?.any { it.id == item.threadID } == true) {
            forgetMarker(item.id)
            return
        }
        val delivery = shell?.deliveries?.firstOrNull { it.threadId == item.threadID && it.draftId == item.draftID }
        val delivered = shell?.deliveredDrafts?.any { it.threadId == item.threadID && it.draftId == item.draftID } == true
        val accepted = delivered || delivery?.status == "accepted"
        val thread = shell?.host?.threads?.firstOrNull { it.id == item.threadID }
        // Only this command's own receipt confirms the phone's answer. A request can also leave after a
        // desktop answer, a stopped turn or provider cancellation.
        val noLongerWaiting = item.kind == "answer" && item.requestID != null && shell != null &&
            (thread == null || thread.requests.none { it.id == item.requestID })
        if (item.kind == "answer") {
            val confirmed = receipt?.confirmsAnswer == true
            if (!confirmed && !noLongerWaiting) return
            val mine = feedback == null || item.id in feedbackOperations
            forgetMarker(item.id)
            if (mine) say(if (confirmed) "Answer sent." else REQUEST_NO_LONGER_WAITING)
        } else if (delivery?.status == "failed") {
            rejectOperation(item)
            // Named, because the thread open now may be another one, on another computer.
            val title = thread?.let { "“${it.title}”" } ?: "a thread"
            say("Your reply to $title on ${name(item.hostID)} wasn’t sent. Its text is back in that thread.")
        } else if (accepted || (receipt != null && item.reconciled(receipt, shell?.deliveries ?: emptyList()))) {
            forgetMarker(item.id)
            if (item.id in feedbackOperations) {
                feedbackOperations = feedbackOperations - item.id
                if (feedbackOperations.isEmpty()) feedback = null
            }
        }
    }

    private fun rejectOperation(operation: PendingOperation) {
        val text = submitted[operation.id]
        if (text != null && operation.kind == "reply") {
            failedReplies = failedReplies + (ThreadRef(operation.hostID, operation.threadID).id to text)
        }
        forgetMarker(operation.id)
    }

    fun restoreReply(ref: ThreadRef) {
        val text = failedReplies[ref.id]
        if (!drafts[ref.id].isNullOrEmpty() || text == null) return
        drafts = drafts + (ref.id to text)
        failedReplies = failedReplies - ref.id
    }

    fun acknowledgeUnknown(id: String) {
        try {
            forgetMarker(id)
            say("Unconfirmed action dismissed. Nothing was resent.")
        } catch (error: Exception) {
            say(error.message)
        }
    }

    // MARK: New threads on one computer

    val pendingCreations: List<PendingOperation>
        get() = pending.filter { item ->
            item.kind.startsWith("create-") && computer(item.hostID)?.let { item.matches(it.hostID, it.pairing.clientId) } == true
        }

    fun creationModels(hostID: String): List<ThreadModel> = live[hostID]?.shell?.host?.let(NewThreads::availableModels) ?: emptyList()
    fun initialCreationModelID(hostID: String): String = live[hostID]?.shell?.let(NewThreads::startingModelID) ?: ""
    fun initialCreationEffort(hostID: String, model: ThreadModel): String =
        live[hostID]?.shell?.let { NewThreads.startingEffort(model, it) } ?: model.startingEffort
    fun projects(hostID: String): List<Project> = (live[hostID]?.shell?.host?.projects ?: emptyList()).filter { it.workspaceSettledAt == null }
    fun canBrowseFolders(hostID: String): Boolean = online(hostID) && live[hostID]?.features?.contains("host-folders") == true

    // `path` absent is the computer's home folder; JsonNull is the top of the machine.
    suspend fun folders(hostID: String, path: JsonElement? = null): FolderResult {
        val connection = connections[hostID]
        val epoch = generations[hostID]
        if (!canBrowseFolders(hostID) || connection == null || epoch == null) {
            throw ClientError.Rejected("Folder browsing is unavailable. Reconnect or update Sotto on this computer.")
        }
        val result = FolderResult.read(connection.call(NewThreads.folderRequest(path)))
        if (generations[hostID] !== epoch || !online(hostID)) throw ClientError.Disconnected
        return result
    }

    // Registration and creation are separate commands. Neither is replayed after a lost acknowledgement.
    suspend fun createThread(hostID: String, projectID: String?, folder: FolderListing?, modelID: String, effort: String, permissionID: String): ThreadRef? {
        val computer = computer(hostID)
        val epoch = generations[hostID]
        if (creatingHostID != null || !storageReady || !online(hostID) || pendingCreations.any { it.hostID == hostID } ||
            computer == null || epoch == null
        ) return null
        creatingHostID = hostID
        creationFeedback = null
        val threadID = UUID.randomUUID().toString()
        try {
            val model = creationModels(hostID).firstOrNull { it.id == modelID }
            if ((projectID != null) == (folder != null) || model == null) {
                throw ClientError.Rejected("The project or model changed. Choose it again before opening a thread.")
            }
            // Validate the visible options before registering anything on the computer.
            Commands.createThread(projectID ?: "new-project", threadID, model, effort, permissionID, mayAnswer(hostID))
            var chosenProject = projectID
            val folderPath = folder?.path
            if (folder != null && folderPath != null) {
                val fresh = (folders(hostID, JsonPrimitive(folderPath)) as? FolderResult.Listed)?.listing
                val confirmedPath = fresh?.path
                    ?: throw ClientError.Rejected("This folder can no longer be opened. Nothing was added. Choose another folder.")
                if (generations[hostID] !== epoch || !online(hostID)) throw ClientError.Disconnected
                chosenProject = live[hostID]?.shell?.host?.projects?.firstOrNull { NewThreads.sameFolder(it.path, confirmedPath, fresh.separator) }?.id
                if (chosenProject == null) {
                    val providerID = model.providerId
                    if (providerID == null || live[hostID]?.shell?.host?.providers?.firstOrNull { it.id == providerID }?.capabilities?.projects != true) {
                        throw ClientError.Rejected("This provider cannot add a project folder. Choose another model.")
                    }
                    val register = Commands.createProject(providerID, fresh.projectName, confirmedPath)
                    val marker = PendingOperation(hostID, computer.pairing.clientId, threadID, kind = "create-project")
                    remember(marker)
                    val result = dispatch(register, marker)
                    if (result == null || generations[hostID] !== epoch || pending.any { it.id == marker.id }) {
                        creationFeedback = creationResultWords(hostID, "Project registration")
                        return null
                    }
                    chosenProject = result.host.projects.firstOrNull {
                        NewThreads.sameFolder(it.path, confirmedPath, fresh.separator) && (it.providerId == null || it.providerId == providerID)
                    }?.id
                }
            }
            val currentModel = creationModels(hostID).firstOrNull { it.id == modelID }
            if (generations[hostID] !== epoch || !online(hostID) || chosenProject == null ||
                live[hostID]?.shell?.host?.projects?.any { it.id == chosenProject } != true || currentModel == null
            ) throw ClientError.Rejected("The project or model is no longer available. Reconnect and choose it again.")
            val create = Commands.createThread(chosenProject, threadID, currentModel, effort, permissionID, mayAnswer(hostID))
            val marker = PendingOperation(hostID, computer.pairing.clientId, threadID, kind = "create-thread")
            remember(marker)
            dispatch(create, marker)
            val ref = ThreadRef(hostID, threadID)
            if (generations[hostID] !== epoch || !online(hostID) || thread(ref) == null || pending.any { it.id == marker.id }) {
                creationFeedback = creationResultWords(hostID, "Thread creation")
                return null
            }
            return ref
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            creationFeedback = error.message
            return null
        } finally {
            creatingHostID = null
        }
    }

    private fun creationResultWords(hostID: String, kind: String): String {
        val explanation = creationFeedback?.let { "$it " } ?: ""
        if (pendingCreations.any { it.hostID == hostID }) {
            return "$explanation$kind on ${name(hostID)} is unconfirmed. Nothing was resent. Close this and check Threads before trying again."
        }
        return creationFeedback ?: feedback ?: "$kind did not finish. Choose the project and model again."
    }

    // MARK: Updates from a computer

    private fun applyShell(next: Shell, hostID: String, sequence: Int, reconcileAnswers: Boolean = true) {
        if (computer(hostID) == null) throw ClientError.InvalidIdentity
        next.validate(hostID)
        if (sequence <= (shellSequences[hostID] ?: 0)) return
        shellSequences[hostID] = sequence
        update(hostID) { state -> state.copy(shell = next, mayAnswer = next.clientCapabilities?.mayAnswer ?: state.mayAnswer) }
        // Live evidence can arrive after the acknowledgement timed out. Never resend to settle it.
        for (item in scoped(hostID)) {
            // A connect, dispatch or solicited shell is followed by a receipt check. Keep its answer markers
            // through intervening pushes until their own receipts are read.
            if (item.kind == "answer" && (!reconcileAnswers || hostID in connecting || item.id in dispatchingAnswers || (deliveryChecks[hostID] ?: 0) > 0)) continue
            try { settle(item, shell = next) } catch (error: Exception) { say(error.message) }
        }
        val open = selected
        if (open != null && open.hostID == hostID && next.host.threads.none { it.id == open.threadID }) {
            cancelDetailReload()
            selected = null
            openDetail = null
            detailProblem = null
        }
    }

    private fun push(frame: IncomingFrame, hostID: String, sequence: Int) {
        try {
            when (frame) {
                is IncomingFrame.ShellPush -> applyShell(frame.shell, hostID, sequence)
                is IncomingFrame.Detail -> generations[hostID]?.let { applyDetail(frame.detail, ThreadRef(hostID, frame.threadID), it) }
                is IncomingFrame.Delta -> {
                    if (frame.delta.threadId != frame.threadID) throw ClientError.InvalidIdentity
                    val ref = ThreadRef(hostID, frame.threadID)
                    if (selected != ref) return
                    val held = openDetail
                    if (held != null && frame.delta.revision <= held.revision) return
                    val next = held?.applying(frame.delta)
                    val epoch = generations[hostID]
                    if (next != null && epoch != null) {
                        applyDetail(next, ref, epoch)
                    } else {
                        detailWantedRevision = maxOf(detailWantedRevision, frame.delta.revision)
                        reloadDetail(ref)
                    }
                }
                // The host sends this in place of an update too large for one frame; the connection stays open.
                is IncomingFrame.Failure -> say(frame.failure.message)
                else -> throw ClientError.InvalidProtocol
            }
        } catch (_: Exception) {
            val words = "The update from ${name(hostID)} could not be read. Reconnect to refresh it."
            update(hostID) { it.copy(status = ComputerStatus.Unreachable, mayAnswer = false, problem = words) }
            connections[hostID]?.disconnect()
            say(words)
        }
    }

    companion object {
        const val REQUEST_NO_LONGER_WAITING = "That request is no longer waiting."
        const val MARKERS_UNREADABLE = "Saved unconfirmed actions could not be read. Check your threads before sending again. Nothing was resent."
        fun pairingWarning(count: Int) = if (count == 1) "1 saved computer needs pairing again." else "$count saved computers need pairing again."
    }
}
