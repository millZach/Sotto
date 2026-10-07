package com.millzach.sotto.core

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Port of apps/ios/Tests/SottoCoreTests/FocusThreadsTests.swift.
class FocusThreadsTests {
    private fun summary(json: String): ThreadSummary = Json.parseToJsonElement(json).decodeAs()
    private fun thread(id: String, extra: String = ""): ThreadSummary =
        summary("""{"id":"$id","projectId":"p","title":"$id","status":"idle","requests":[]$extra}""")
    private fun online(vararg threads: ThreadSummary) = ComputerThreads(hostID = "h", name = "Laptop", status = ComputerStatus.Online, threads = threads.toList())

    @Test fun settledRequestsAndBackgroundWorkRemainVisible() {
        val question = summary("""{"id":"q","projectId":"p","title":"Ship","status":"idle","settledAt":"yesterday","requests":[{"id":"r","kind":"question","text":"Which target?","options":[]}]}""")
        val work = thread("background", """, "settledAt":"yesterday", "backgroundWork":[{"type":"subagent"}]""")
        val done = thread("finished", """, "settledAt":"yesterday"""")
        val rows = FocusThreads(listOf(online(question, work, done)))
        assertEquals(listOf("h/q"), rows.questions.map { it.id })
        assertEquals(1, rows.requestCount)
        assertEquals(listOf("h/background"), rows.working.map { it.id })
        assertEquals(listOf("h/finished"), rows.settled.map { it.id })
    }

    @Test fun offlineSnapshotsDoNotClaimLiveWork() {
        val work = thread("work", """, "backgroundWork":[{"type":"command"}]""")
        for (status in listOf(ComputerStatus.Connecting, ComputerStatus.Unreachable)) {
            val rows = FocusThreads(listOf(ComputerThreads(hostID = "h", name = "Laptop", status = status, threads = listOf(work))))
            assertTrue(rows.working.isEmpty())
            assertEquals(listOf("h/work"), rows.recent.map { it.id })
        }
    }

    @Test fun searchIncludesSettledAndRespectsComputerIdentity() {
        val done = thread("Café", """, "settledAt":"yesterday"""")
        val hosts = listOf("one", "two").map { ComputerThreads(hostID = it, name = it, status = ComputerStatus.Online, threads = listOf(done)) }
        val rows = FocusThreads(hosts, show = ComputerFilter.Only("two"), query = "  CAFE  ")
        assertTrue(rows.searching)
        assertEquals(listOf("two/Café"), rows.settled.map { it.id })
        assertFalse(rows.isEmpty)
        assertTrue(FocusThreads(hosts, query = "missing").isEmpty)
        assertFalse(FocusThreads(hosts, query = " \n ").searching)
    }

    @Test fun unreadFinishedThreadsKeepTheirPlaceAndCountOnlyInRecent() {
        val unread = thread("unread", """, "finishedUnread":true""")
        val read = thread("read")
        val settled = thread("settled", """, "finishedUnread":true, "settledAt":"yesterday"""")
        val rows = FocusThreads(listOf(online(read, unread, settled)))
        // The mark changes how a row looks, never which group it is in or where.
        assertEquals(listOf("h/read", "h/unread"), rows.recent.map { it.id })
        assertEquals(listOf("h/settled"), rows.settled.map { it.id })
        assertEquals(listOf(false, true), rows.recent.map(rows::isUnreadFinish))
        assertTrue(rows.isUnreadFinish(rows.settled[0]))
        // A closed Settled shelf would hide what it counted, so the count is Recent's.
        assertEquals(1, rows.unreadFinishedCount)
    }

    @Test fun openingAThreadReadsItBeforeItsComputerSaysSo() {
        val unread = thread("unread", """, "finishedUnread":true""")
        val other = thread("other", """, "finishedUnread":true""")
        val computers = listOf(online(unread, other))
        assertEquals(2, FocusThreads(computers).unreadFinishedCount)
        val opened = FocusThreads(computers, opened = ThreadRef(hostID = "h", threadID = "unread"))
        assertEquals(listOf(false, true), opened.recent.map(opened::isUnreadFinish))
        assertEquals(1, opened.unreadFinishedCount)
        // The same thread ID on another computer is another thread.
        assertEquals(2, FocusThreads(computers, opened = ThreadRef(hostID = "other", threadID = "unread")).unreadFinishedCount)
    }

    @Test fun unreadFinishedNeedsAReachableComputerAndAFinishedThread() {
        val unread = thread("unread", """, "finishedUnread":true""")
        for (status in listOf(ComputerStatus.Connecting, ComputerStatus.Unreachable)) {
            val rows = FocusThreads(listOf(ComputerThreads(hostID = "h", name = "Laptop", status = status, threads = listOf(unread))))
            assertEquals(listOf("h/unread"), rows.recent.map { it.id })
            assertEquals(0, rows.unreadFinishedCount)
        }
        // A mark that rides on a thread that failed, works or asks is not shown; the thread says what it is doing instead.
        val failed = summary("""{"id":"failed","projectId":"p","title":"Failed","status":"error","finishedUnread":true,"requests":[]}""")
        val working = thread("working", """, "finishedUnread":true, "backgroundWork":[{"type":"subagent"}]""")
        val rows = FocusThreads(listOf(online(failed, working)))
        assertEquals(listOf(false), rows.recent.map(rows::isUnreadFinish))
        assertEquals(listOf("h/working"), rows.working.map { it.id })
        assertEquals(0, rows.unreadFinishedCount)
        // An older computer never sends the field, and nothing is marked.
        assertNull(thread("old").finishedUnread)
    }

    @Test fun waitingAndCompactionCountAlongsideForegroundWork() {
        val waiting = thread("command", """, "backgroundWork":[{"type":"command"}]""")
        val compacting = thread("context", """, "compaction":{"status":"running"}""")
        val failed = summary("""{"id":"failed","projectId":"p","title":"Failed","status":"error","requests":[]}""")
        val rows = FocusThreads(listOf(online(waiting, compacting, failed)))
        assertEquals(2, rows.working.size)
        assertEquals(listOf("h/failed"), rows.recent.map { it.id })
    }
}
