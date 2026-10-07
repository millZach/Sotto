package com.millzach.sotto.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

// Port of apps/ios/Tests/SottoCoreTests/StreamingTests.swift. Wire.readFrame is IncomingFrame.read here, and a
// reply keeps its result as a JSON tree that the caller decodes, so Wire.readReply is decodeAs on that tree.
// LivenessProgressTests is not ported: the Kotlin client has no LivenessProgress (OkHttp answers the host's pings).
class StreamingTests {
    private inline fun <reified T> decode(json: String): T = Json.parseToJsonElement(json).decodeAs()
    private fun delta(json: String): ThreadDetailDelta = ThreadDetailDelta.read(Json.parseToJsonElement(json))
    private val detail = """{"threadId":"t","revision":2,"earlierAvailable":true,"messages":[{"id":"m","role":"assistant","text":"Hello"}],"activities":[{"id":"a","sequence":1,"kind":"command","status":"running","title":"Testing"}]}"""

    @Test fun streamingAppendAndActivityCompletionKeepHistory() {
        val original = decode<ThreadDetail>(detail)
        val change = delta("""{"threadId":"t","baseRevision":2,"revision":3,"messageDeltas":[{"id":"m","appendText":" world"}],"activityDeltas":[{"record":{"id":"a","sequence":1,"kind":"command","status":"completed","title":"Tested"}}]}""")
        val next = original.applying(change)
        assertNotNull(next); next!!
        assertEquals("Hello world", next.messages.firstOrNull()?.text)
        assertEquals("completed", next.activities?.firstOrNull()?.status)
        assertEquals(true, next.earlierAvailable)
        assertEquals(3L, next.revision)
        assertEquals("Hello", original.messages.firstOrNull()?.text)
    }

    @Test fun missingBaseAndUnknownAppendTargetRequireResync() {
        val original = decode<ThreadDetail>(detail)
        for (json in listOf(
            """{"threadId":"t","baseRevision":1,"revision":3,"messageDeltas":[],"activityDeltas":[]}""",
            """{"threadId":"other","baseRevision":2,"revision":3,"messageDeltas":[],"activityDeltas":[]}""",
            """{"threadId":"t","baseRevision":2,"revision":2,"messageDeltas":[],"activityDeltas":[]}""",
            """{"threadId":"t","baseRevision":2,"revision":3,"messageDeltas":[{"id":"m","appendText":" discarded"},{"id":"missing","appendText":"x"}],"activityDeltas":[]}""",
        )) { assertNull(json, original.applying(delta(json))) }
        assertEquals("Hello", original.messages.firstOrNull()?.text)
    }

    @Test fun newMessagesAndActivityRemoval() {
        val original = decode<ThreadDetail>(detail)
        val change = delta("""{"threadId":"t","baseRevision":2,"revision":4,"messageDeltas":[{"message":{"id":"n","role":"user","text":"Continue"}},{"message":{"id":"m","role":"assistant","text":"Updated"}}],"activityDeltas":[{"id":"a","removed":true}]}""")
        val next = original.applying(change)
        assertNotNull(next); next!!
        assertEquals(listOf("m", "n"), next.messages.map { it.id })
        assertEquals("Updated", next.messages.firstOrNull()?.text)
        assertEquals(0, next.activities?.size)
    }

    @Test fun fullAndIncrementalFramesUseSameProtocol() {
        val full = IncomingFrame.read("{\"v\":1,\"event\":\"detail\",\"threadId\":\"t\",\"detail\":$detail}")
        assertTrue("Expected full detail", full is IncomingFrame.Detail)
        full as IncomingFrame.Detail
        val snapshot = full.detail
        assertEquals("t", full.threadID); assertEquals(2L, snapshot?.revision)
        val incremental = IncomingFrame.read("""{"v":1,"event":"detail-delta","threadId":"t","delta":{"threadId":"t","baseRevision":2,"revision":3,"messageDeltas":[],"activityDeltas":[]}}""")
        assertTrue("Expected delta", incremental is IncomingFrame.Delta)
        incremental as IncomingFrame.Delta
        assertEquals("t", incremental.threadID); assertEquals(3L, snapshot?.applying(incremental.delta)?.revision)
        assertEquals(JsonPrimitive(9_007_199_254_740_991L), Wire.snapshotHello["afterSeq"])
        // Unlike the iPhone, Android leaves out client-liveness: OkHttp answers the host's own pings (Wire.snapshotHello).
        assertEquals(
            JsonArray(listOf("detail-delta", "activity-summaries", "model-catalog-revision").map(::JsonPrimitive)),
            Wire.snapshotHello["accepts"],
        )
    }

    @Test fun invalidFramesAndUnrequestedPushesAreRefused() {
        for (json in listOf(
            """{"v":2,"event":"detail","threadId":"t","detail":null}""",
            """{"v":1,"event":"unrecognized"}""",
            """{"v":1,"id":"r","ok":true}""",
        )) {
            assertThrows("Invalid frame accepted: $json", Exception::class.java) { IncomingFrame.read(json) }
        }
    }

    // Ported in part: the Swift test also counts decodes and checks they run off the main thread, which is
    // Swift plumbing. What carries over is that a revision past a Double's precision survives the reply.
    @Test fun detailReplyDecodesItsResultOnceFromOriginalBytes() {
        val data = """{"v":1,"id":"detail","ok":true,"result":{"threadId":"t","revision":9007199254740993,"messages":[{"id":"m","role":"assistant","text":"Hello"}]}}"""
        val frame = IncomingFrame.read(data)
        assertTrue("Expected reply", frame is IncomingFrame.Reply)
        frame as IncomingFrame.Reply
        assertEquals("detail", frame.id)
        assertNull(frame.catalog)
        val result = frame.result.decodeAs<ThreadDetail>()
        assertEquals(9_007_199_254_740_993L, result.revision.toLong())
        assertEquals("Hello", result.messages.firstOrNull()?.text)
    }

    @Test fun nullDetailReplyAndTypedHello() {
        val empty = IncomingFrame.read("""{"v":1,"id":"detail","ok":true,"result":null}""") as IncomingFrame.Reply
        assertNull(empty.result.decodeAs<ThreadDetail?>())
        val greeting = IncomingFrame.read("""{"v":1,"id":"hello","ok":true,"result":{"hostId":"host","clientId":"phone","capabilities":{"mayAnswer":false},"shell":{"hostId":"host","host":{"hostId":"host","name":"Laptop","threads":[],"projects":[],"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true}}}}}""") as IncomingFrame.Reply
        val hello = greeting.result.decodeAs<Hello>()
        assertEquals("host", hello.hostId)
        assertEquals("phone", hello.clientId)
        assertFalse(hello.capabilities.mayAnswer)
        assertTrue(hello.shell.host.threads.isEmpty())
    }

    @Test fun settledGroupingMatchesDesktopAndKeepsWaitingRequests() {
        val cases = listOf(
            "" to false, """, "workspaceSettledAt":"2026-09-28"""" to true,
            """, "settledAt":"2026-09-28"""" to true, """, "settledOverride":"settled"""" to true,
            """, "settledAt":"2026-09-28", "settledOverride":"active"""" to false,
            """, "archivedAt":"2026-09-28", "settledOverride":"active"""" to true,
            """, "workspaceSettledAt":"", "settledAt":null""" to false,
        )
        for ((extra, expected) in cases) {
            val thread = decode<ThreadSummary>("""{"id":"t","projectId":"p","title":"Thread","status":"idle","requests":[]$extra}""")
            assertEquals(extra, expected, ThreadGroups.isSettled(thread))
        }
        val project = decode<Project>("""{"id":"p","title":"Project","workspaceSettledAt":"2026-09-28"}""")
        val thread = decode<ThreadSummary>("""{"id":"t","projectId":"p","title":"Thread","status":"idle","requests":[{"id":"r","kind":"question","text":"Ready?","options":[]}]}""")
        val computer = ComputerThreads(hostID = "host", name = "Laptop", status = ComputerStatus.Online, threads = listOf(thread), projects = listOf(project))
        val first = ThreadGroups.merged(listOf(computer)).firstOrNull()
        assertNotNull(first); assertTrue(first!!.settled)
        assertEquals("Settlement never hides a waiting question", 1, ThreadGroups.waiting(listOf(computer)).size)
    }
}
