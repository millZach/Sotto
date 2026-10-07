package com.millzach.sotto.core

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// Port of apps/ios/Tests/SottoCoreTests/WorkingStateTests.swift.
// Not ported: every ThreadFilter.working / ThreadFilter.done assertion and every ThreadGroups.working assertion.
// The Kotlin port has neither ThreadFilter nor ThreadGroups.working (FocusThreads.working is the nearest).
class WorkingStateTests {
    private fun thread(extra: String = "", status: String = "idle", requests: String = "[]"): ThreadSummary =
        Json.parseToJsonElement("""{"id":"t","projectId":"p","title":"Thread","status":"$status","requests":$requests$extra}""").decodeAs()

    @Test fun confirmedBackgroundAgentRemainsWorkingAfterItsTurnEnds() {
        val active = thread(""", "backgroundWork":[{"id":"00000000-0000-4000-8000-000000000002","label":"Checking","type":"subagent"}]""")
        assertEquals(ThreadState.Working, ThreadState.of(active))
    }

    @Test fun runningCompactionIsNotDone() {
        val active = thread(""", "compaction":{"commandId":"c","status":"running"}""")
        assertEquals(ThreadState.Compacting, ThreadState.of(active))
        assertEquals("Compacting context", ThreadState.of(active).words)
        assertTrue(ThreadState.of(active).workInProgress)
    }

    @Test fun foregroundTurnIsWorkingAndIdleIsDone() {
        assertEquals(ThreadState.Working, ThreadState.of(thread(status = "running")))
        assertEquals(ThreadState.Done, ThreadState.of(thread()))
    }

    @Test fun backgroundCommandsWaitAndMixedWorkWorks() {
        val command = thread(""", "backgroundWork":[{"type":"command"}]""")
        assertEquals(ThreadState.Waiting, ThreadState.of(command))
        assertEquals("Waiting", ThreadState.of(command).words)
        assertTrue(ThreadState.of(command).workInProgress)
        val mixed = thread(""", "backgroundWork":[{"type":"command"},{"type":"subagent"}]""")
        assertEquals(ThreadState.Working, ThreadState.of(mixed))
        val future = thread(""", "backgroundWork":[{"type":"future-agent"}]""")
        assertEquals(ThreadState.Working, ThreadState.of(future))
    }

    @Test fun requestsAndErrorsOutrankBackgroundWork() {
        val work = """, "backgroundWork":[{"type":"subagent"}],"compaction":{"status":"running"}"""
        val question = thread(work, requests = """[{"id":"q","kind":"question","text":"Ready?","options":[]}]""")
        val permission = thread(work, requests = """[{"id":"p","kind":"permission","text":"Allow?","options":[]}]""")
        assertEquals(ThreadState.Asked, ThreadState.of(question))
        assertEquals(ThreadState.NeedsAnswer, ThreadState.of(permission))
        assertEquals(ThreadState.Failed, ThreadState.of(thread(work, status = "error")))
        val computer = ComputerThreads(hostID = "h", name = "Laptop", status = ComputerStatus.Online, threads = listOf(question))
        assertEquals(1, ThreadGroups.waiting(listOf(computer)).size)
    }

    @Test fun onlyCurrentConfirmedWorkCountsAsWorking() {
        for (extra in listOf(
            """, "backgroundWork":[]""", """, "backgroundWork":null""",
            """, "compaction":{"status":"completed"}""", """, "compaction":{"status":"failed"}""",
            """, "summary":{"runningTurnStartedAt":"2026-09-28T12:00:00Z"},"activities":[{"status":"running"}]""",
            """, "monitoring":[{"id":"m","label":"Watching"}]""",
        )) {
            assertEquals(extra, ThreadState.Done, ThreadState.of(thread(extra)))
        }
    }
}
