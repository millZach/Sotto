package com.millzach.sotto.core

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Port of apps/ios/Tests/SottoCoreTests/ModelCatalogTests.swift.
// `model-catalog-revision`: a host names its model catalog by revision and leaves it out of a shell when this
// connection was already sent it, and the connection puts it back before anything reads the shell.
// ModelCatalogCache is immutable here: `holding` returns the cache that holds the catalog.
class ModelCatalogTests {
    private val first = """{"id":"first","name":"First","provider":"Codex","providerId":"codex","ready":true}"""
    private val second = """{"id":"second","name":"Second","provider":"Claude","providerId":"claude","ready":true}"""

    // A host's fields, with `catalog` (a revision, models or both, each followed by a comma) spliced in.
    private fun host(catalog: String): String =
        """{"hostId":"h","name":"Laptop","threads":[],"projects":[],$catalog"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}"""

    // A revision, the models given, or both, as `host` takes them.
    private fun catalog(revision: Int?, models: String?): String {
        val named = revision?.let { """"modelsRevision":$it,""" } ?: ""
        val listed = models?.let { """"models":[$it],""" } ?: ""
        return named + listed
    }

    private fun shell(revision: Int?, models: String?): Shell =
        Json.parseToJsonElement("""{"hostId":"h","host":${host(catalog(revision, models))}}""").decodeAs()

    private fun hello(revision: Int?, models: String?): Hello =
        Json.parseToJsonElement("""{"hostId":"h","clientId":"phone","capabilities":{"mayAnswer":false},"features":["model-catalog-revision"],"shell":{"hostId":"h","host":${host(catalog(revision, models))}}}""").decodeAs()

    private fun reply(result: String): CarriedCatalog? {
        val frame = IncomingFrame.read("""{"v":1,"id":"reply","ok":true,"result":$result}""")
        assertTrue("Expected reply", frame is IncomingFrame.Reply)
        frame as IncomingFrame.Reply
        assertEquals("reply", frame.id)
        return frame.catalog
    }

    @Test fun aShellNamingTheHeldRevisionGetsTheWholeCatalogBack() {
        var cache = ModelCatalogCache()
        val carried = shell(revision = 3, models = first)
        cache = cache.holding(carried)
        assertEquals(listOf("first"), cache.whole(carried)?.host?.models?.map { it.id })
        val named = shell(revision = 3, models = null)
        assertNull(named.host.models)
        val restored = cache.whole(named)
        assertNotNull(restored); restored!!
        assertEquals(listOf("first"), restored.host.models?.map { it.id })
        assertEquals(3L, restored.host.modelsRevision)
        assertEquals(listOf("first"), NewThreads.availableModels(restored.host).map { it.id })
    }

    @Test fun aShellNamingARevisionThisConnectionWasNeverSentIsNotShownWithoutModels() {
        val named = shell(revision = 4, models = null)
        assertNull("Nothing held yet", ModelCatalogCache().whole(named))
        var cache = ModelCatalogCache()
        cache = cache.holding(shell(revision = 3, models = first))
        assertNull("Another revision than the one held", cache.whole(named))
        assertNull(cache.whole(hello(revision = 4, models = null)))
    }

    @Test fun aChangedCatalogReplacesTheOneHeld() {
        var cache = ModelCatalogCache()
        cache = cache.holding(shell(revision = 3, models = first))
        cache = cache.holding(shell(revision = 4, models = second))
        assertEquals(4L, cache.held?.revision)
        assertEquals(listOf("second"), cache.whole(shell(revision = 4, models = null))?.host?.models?.map { it.id })
        assertNull(cache.whole(shell(revision = 3, models = null)))
    }

    @Test fun aShellFromAHostWithoutTheFeatureIsReadAsItCame() {
        var cache = ModelCatalogCache()
        val whole = shell(revision = null, models = first)
        cache = cache.holding(whole)
        assertNull("A catalog without a revision is not held", cache.held)
        assertNull(whole.host.modelsRevision)
        assertEquals(listOf("first"), cache.whole(whole)?.host?.models?.map { it.id })
    }

    @Test fun helloIsPutBackLikeAShell() {
        var cache = ModelCatalogCache()
        cache = cache.holding(shell(revision = 7, models = second))
        val restored = cache.whole(hello(revision = 7, models = null))
        assertNotNull(restored); restored!!
        assertEquals(listOf("second"), restored.shell.host.models?.map { it.id })
        assertEquals("phone", restored.clientId)
    }

    @Test fun aReplyCarryingACatalogIsReadWithItsEnvelope() {
        val carriedHost = host(catalog(revision = 5, models = first))
        val read = reply("""{"hostId":"h","host":$carriedHost}""")
        assertEquals(5L, read?.revision)
        assertEquals(listOf("first"), read?.models?.map { it.id })
        val helloHost = host(catalog(revision = 6, models = second))
        val greeting = reply("""{"hostId":"h","clientId":"phone","capabilities":{"mayAnswer":false},"shell":{"hostId":"h","host":$helloHost}}""")
        assertEquals(6L, greeting?.revision)
        assertEquals(listOf("second"), greeting?.models?.map { it.id })
        val namedHost = host(catalog(revision = 5, models = null))
        val wholeHost = host(catalog(revision = null, models = first))
        val results = listOf(
            """{"hostId":"h","host":$namedHost}""", """{"hostId":"h","host":$wholeHost}""",
            """{"threadId":"t","revision":1,"messages":[]}""", "null",
        )
        for (result in results) {
            assertNull(result, reply(result))
        }
    }

    @Test fun aPushedShellKeepsItsCatalogForTheConnection() {
        val pushedHost = host(catalog(revision = 8, models = first))
        val frame = IncomingFrame.read("""{"v":1,"event":"shell","state":{"hostId":"h","host":$pushedHost}}""")
        assertTrue("Expected shell", frame is IncomingFrame.ShellPush)
        val pushed = (frame as IncomingFrame.ShellPush).shell
        var cache = ModelCatalogCache()
        cache = cache.holding(pushed)
        assertEquals(8L, cache.held?.revision)
        assertEquals(listOf("first"), cache.whole(shell(revision = 8, models = null))?.host?.models?.map { it.id })
    }
}
