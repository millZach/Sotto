package com.millzach.sotto.core

import java.text.Normalizer
import java.time.Instant
import java.time.OffsetDateTime

// How the phone words and sorts a thread. Pure, so the list, the tabs and the tests read one answer.
enum class ThreadState(val words: String) {
    NeedsAnswer("Needs your answer"),
    Asked("Asked you a question"),
    Working("Working"),
    Waiting("Waiting"),
    Compacting("Compacting context"),
    Failed("Turn failed"),
    Done("Done"),
    ;

    val workInProgress: Boolean get() = this == Working || this == Waiting || this == Compacting
    val waitsOnYou: Boolean get() = this == NeedsAnswer || this == Asked

    companion object {
        fun of(thread: ThreadSummary): ThreadState {
            val request = thread.requests.firstOrNull()
            if (request != null) return if (request.kind == "permission") NeedsAnswer else Asked
            if (thread.status == "error") return Failed
            if (thread.compaction?.status == "running") return Compacting
            if (thread.status == "running") return Working
            val work = thread.backgroundWork
            if (!work.isNullOrEmpty()) return if (work.all { it.type == "command" }) Waiting else Working
            return Done
        }
    }
}

// A thread as the phone names it. Two computers can hold the same thread ID, so the computer's
// host ID is part of every thread's identity: routes, drafts, markers and answers all carry both.
data class ThreadRef(val hostID: String, val threadID: String) {
    val id: String get() = "$hostID/$threadID"
}

// Whether this phone is talking to a paired computer right now.
enum class ComputerStatus(val words: String) {
    Connecting("Connecting…"),
    Online("Online"),
    Unreachable("Can’t reach it"),
}

// One paired computer as the lists read it: its name, whether it can be reached, and the threads it
// last shared. A computer shares only its own threads.
data class ComputerThreads(
    val hostID: String,
    val name: String,
    val status: ComputerStatus,
    val threads: List<ThreadSummary>,
    val projects: List<Project> = emptyList(),
)

// A thread with the computer it lives on, used by Focus rows and request counts.
data class HostedThread(
    val ref: ThreadRef,
    val computer: String,
    val status: ComputerStatus,
    val project: String?,
    val thread: ThreadSummary,
    val settled: Boolean,
) {
    val id: String get() = ref.id
    val reachable: Boolean get() = status == ComputerStatus.Online

    // Finished while nothing showed it, and not opened since on either device, by its computer's word (ADR-0046).
    val finishedUnread: Boolean
        get() = reachable && thread.finishedUnread == true && ThreadState.of(thread) == ThreadState.Done
}

// One request waiting on the user, with the thread and computer it belongs to.
data class Waiting(val thread: HostedThread, val request: AgentRequest) {
    val id: String get() = thread.id + "/" + request.id
}

// The computer menu on Threads: every computer, or one.
sealed interface ComputerFilter {
    fun admits(hostID: String): Boolean

    data object All : ComputerFilter {
        override fun admits(hostID: String) = true
    }

    data class Only(val hostID: String) : ComputerFilter {
        override fun admits(hostID: String) = this.hostID == hostID
    }
}

object ThreadGroups {
    // Every open thread on the computers the filter admits, as one list: most recent first, and the
    // threads of a computer that can't be reached after the rest, as it last shared them.
    fun merged(computers: List<ComputerThreads>, show: ComputerFilter = ComputerFilter.All): List<HostedThread> {
        val rows = computers.filter { show.admits(it.hostID) }.flatMap(::hosted)
        // Parse each timestamp once, not on every comparison. Lists refresh while agents work.
        val dated = rows.mapIndexed { offset, row -> Triple(row, offset, latest(row.thread) ?: Instant.MIN) }
        return dated.sortedWith { a, b ->
            when {
                a.first.reachable != b.first.reachable -> if (a.first.reachable) -1 else 1
                a.third != b.third -> b.third.compareTo(a.third)
                else -> a.second.compareTo(b.second)
            }
        }.map { it.first }
    }

    // Each open request with its thread, on computers that can be reached: a request on a computer that
    // can't be reached can't be answered, so it waits there until the computer is back.
    fun waiting(computers: List<ComputerThreads>, show: ComputerFilter = ComputerFilter.All): List<Waiting> =
        merged(computers, show).filter { it.reachable }.flatMap { row -> row.thread.requests.map { Waiting(row, it) } }

    fun hosted(computer: ComputerThreads): List<HostedThread> {
        val projects = LinkedHashMap<String, Project>()
        computer.projects.forEach { projects.putIfAbsent(it.id, it) }
        return computer.threads.map { thread ->
            HostedThread(
                ref = ThreadRef(computer.hostID, thread.id),
                computer = computer.name,
                status = computer.status,
                project = projects[thread.projectId]?.title,
                thread = thread,
                settled = isSettled(thread, projects[thread.projectId]),
            )
        }
    }

    // Match shared/threadActivity.ts: workspace settlement is inherited, while an explicit active
    // provider override clears provider settlement but never an archive or workspace grouping.
    fun isSettled(thread: ThreadSummary, project: Project? = null): Boolean {
        fun present(value: String?) = !value.isNullOrEmpty()
        return present(thread.workspaceSettledAt) || present(project?.workspaceSettledAt) || present(thread.archivedAt) ||
            (thread.settledOverride != "active" && (thread.settledOverride == "settled" || present(thread.settledAt)))
    }

    // When the thread last moved: its last message or the start of its running turn, whichever is later.
    fun latest(thread: ThreadSummary): Instant? =
        listOfNotNull(thread.summary?.lastMessageAt, thread.summary?.runningTurnStartedAt).mapNotNull(Stamp::date).maxOrNull()
}

// ISO 8601 times as the host writes them, with or without fractional seconds.
object Stamp {
    fun date(iso: String): Instant? = try { OffsetDateTime.parse(iso).toInstant() } catch (_: Exception) { null }
}

// One pass over the lightweight host list. Live requests and work outrank settlement; stale snapshots
// remain readable but never claim to be current work or answerable requests.
class FocusThreads(
    computers: List<ComputerThreads>,
    show: ComputerFilter = ComputerFilter.All,
    query: String = "",
    // The thread open on this phone. It reads as opened at once, before its computer's next list says so.
    val opened: ThreadRef? = null,
) {
    val questions = mutableListOf<HostedThread>()
    val working = mutableListOf<HostedThread>()
    val recent = mutableListOf<HostedThread>()
    val settled = mutableListOf<HostedThread>()
    val searching: Boolean

    init {
        val trimmed = query.trim()
        searching = trimmed.isNotEmpty()
        val needle = folded(trimmed)
        for (row in ThreadGroups.merged(computers, show)) {
            val searchable = listOf(
                row.thread.title, row.project ?: "", row.computer, row.thread.providerId ?: "",
                row.thread.requests.joinToString(" ") { it.text },
            ).joinToString(" ")
            if (searching && !folded(searchable).contains(needle)) continue
            val state = ThreadState.of(row.thread)
            when {
                row.reachable && state.waitsOnYou -> questions += row
                row.reachable && state.workInProgress -> working += row
                row.settled -> settled += row
                else -> recent += row
            }
        }
    }

    val isEmpty: Boolean get() = questions.isEmpty() && working.isEmpty() && recent.isEmpty() && settled.isEmpty()
    val requestCount: Int get() = questions.sumOf { it.thread.requests.size }

    // Recent threads that finished while nothing showed them and have not been opened since: the Threads
    // tab's count. A settled one is marked where it shows but not counted, since the Settled shelf may be closed.
    val unreadFinishedCount: Int get() = recent.count { isUnreadFinish(it) }

    fun isUnreadFinish(row: HostedThread): Boolean = row.finishedUnread && row.ref != opened

    companion object {
        // Case and accent insensitive, as Foundation's localizedStandardContains is.
        fun folded(text: String): String =
            Normalizer.normalize(text, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase()
    }
}
