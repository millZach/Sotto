package com.millzach.sotto.core

import com.millzach.sotto.store.SecureStore
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

// Port of apps/ios/Tests/SottoCoreTests/PhoneTests.swift.
class PhoneTests {
    private inline fun <reified T> decode(text: String): T = Json.parseToJsonElement(text).decodeAs()
    private fun thread(id: String, project: String = "p", status: String = "idle", requests: String = "[]", summary: String? = null): ThreadSummary {
        val stamp = summary?.let { ""","summary":{"lastMessageAt":"$it"}""" } ?: ""
        return decode("""{"id":"$id","projectId":"$project","title":"$id","status":"$status","requests":$requests$stamp}""")
    }

    // ClientError cases with a name are classes without equality: the same case and the same words match.
    private fun assertSameError(expected: ClientError, actual: Throwable?) {
        assertNotNull("Expected $expected", actual)
        assertEquals(expected::class, actual!!::class)
        assertEquals(expected.message, actual.message)
    }

    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

    // Finding the host

    @Test fun machineNameAndFullAddressAreBothAccepted() {
        assertEquals(HostFinder.Input.Name("forge"), HostFinder.read(" Forge "))
        assertEquals(HostFinder.Input.FullName("forge.tail5c2e.ts.net"), HostFinder.read("forge.tail5c2e.ts.net"))
        assertEquals(HostFinder.Input.FullName("forge.tail5c2e.ts.net"), HostFinder.read("forge.tail5c2e.ts.net."))
        assertEquals(HostFinder.Input.FullName("forge.tail5c2e.ts.net"), HostFinder.read("https://forge.tail5c2e.ts.net"))
        assertEquals(HostFinder.Input.Address(HostEndpoint.parse("https://forge.tail5c2e.ts.net")), HostFinder.read("forge.tail5c2e.ts.net:443"))
        assertEquals(HostFinder.Input.Address(HostEndpoint.parse("https://forge.tail5c2e.ts.net:8443")), HostFinder.read("https://forge.tail5c2e.ts.net:8443"))
        for (typed in listOf("", "forge.example.com", "http://forge.tail5c2e.ts.net", "-forge", "for ge", "forge_1", "https://forge.tail5c2e.ts.net/path", "forge.tail5c2e.ts.net:8080", "forge:8443")) {
            assertThrows(typed, Exception::class.java) { HostFinder.read(typed) }
        }
    }

    @Test fun onlyThisMachinesTailnetNameIsUsed() {
        assertEquals("forge.tail5c2e.ts.net", HostFinder.fullName(machine = "forge", resolvedName = "forge.tail5c2e.ts.net."))
        assertEquals("forge.tail5c2e.ts.net", HostFinder.fullName(machine = "forge", resolvedName = "FORGE.tail5c2e.ts.net"))
        assertNull(HostFinder.fullName(machine = "forge", resolvedName = "forge.example.com"))
        assertNull(HostFinder.fullName(machine = "forge", resolvedName = "other.tail5c2e.ts.net"))
        assertNull(HostFinder.fullName(machine = "forge", resolvedName = "forge"))
    }

    @Test fun aNameIsTriedOn8443ThenOn443() = runTest {
        val found = HostFinder.candidates("forge") { listOf("forge", "100.101.102.103", "forge.tail5c2e.ts.net") }
        assertEquals(listOf("https://forge.tail5c2e.ts.net:8443", "https://forge.tail5c2e.ts.net"), found.map { it.url })
        try {
            HostFinder.candidates("forge") { listOf("forge.lan") }
            fail("A name off the tailnet must not be used")
        } catch (error: ClientError) {
            assertSameError(ClientError.HostNotFound("forge"), error)
        }
        val full = HostFinder.candidates("forge.tail5c2e.ts.net") { fail("A full address needs no lookup"); emptyList() }
        assertEquals(listOf(8443, 443), full.map { it.port })
        val typed = HostFinder.candidates("https://forge.tail5c2e.ts.net:443") { fail("A typed port needs no lookup"); emptyList() }
        assertEquals(listOf(443), typed.map { it.port })
    }

    @Test fun theFirstAddressWhereSottoAnswersIsKept() = runTest {
        val candidates = HostFinder.endpoints(fullName = "forge.tail5c2e.ts.net")
        val asked = mutableListOf<Int>()
        val desktop = HostFinder.probe(candidates) { endpoint -> asked += endpoint.port; endpoint.port }
        assertEquals(8443, desktop.first.port); assertEquals(listOf(8443), asked)
        val headless = HostFinder.probe(candidates) { endpoint ->
            if (endpoint.port == 8443) throw ClientError.HostUnreachable("forge")
            endpoint.port
        }
        assertEquals(443, headless.first.port)
    }

    @Test fun whenNoAddressAnswersTheMostTellingErrorIsKept() = runTest {
        val candidates = HostFinder.endpoints(fullName = "forge.tail5c2e.ts.net")
        try {
            HostFinder.probe(candidates) { endpoint ->
                throw if (endpoint.port == 8443) ClientError.HostUnreachable("forge") else ClientError.NotASottoHost("forge")
            }
            fail("Nothing answered")
        } catch (error: ClientError) { assertSameError(ClientError.NotASottoHost("forge"), error) }
        try {
            HostFinder.probe(candidates) { endpoint ->
                throw if (endpoint.port == 8443) ClientError.NotASottoHost("forge") else ClientError.HostUnreachable("forge")
            }
            fail("Nothing answered")
        } catch (error: ClientError) { assertSameError(ClientError.NotASottoHost("forge"), error) }
    }

    @Test fun aSottoThatAnswersOn8443StopsTheSearch() = runTest {
        val candidates = HostFinder.endpoints(fullName = "forge.tail5c2e.ts.net")
        val starting = ClientError.Rejected("Sotto on that computer is still starting. Try again in a moment.")
        for (refusal in listOf(ClientError.InvalidProtocol, ClientError.InvalidIdentity, starting)) {
            val asked = mutableListOf<Int>()
            try {
                HostFinder.probe(candidates) { endpoint ->
                    asked += endpoint.port
                    if (endpoint.port == 8443) throw refusal
                    endpoint.port
                }
                fail("Sotto answered on 8443, so 443 must not be used")
            } catch (error: ClientError) { assertSameError(refusal, error) }
            assertEquals(listOf(8443), asked)
        }
    }

    @Test fun onlyTailscaleAddressesAreTrusted() {
        assertTrue(HostFinder.isTailnetAddress(bytes(100, 101, 102, 103)))
        assertTrue(HostFinder.isTailnetAddress(bytes(100, 127, 255, 1)))
        assertFalse(HostFinder.isTailnetAddress(bytes(100, 128, 0, 1)))
        assertFalse(HostFinder.isTailnetAddress(bytes(192, 168, 1, 20)))
        assertTrue(HostFinder.isTailnetAddress(bytes(0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, *IntArray(10) { 1 })))
        assertFalse(HostFinder.isTailnetAddress(bytes(0xfd, 0x00, *IntArray(14))))
    }

    @Test fun healthMustBeAReadyVersionOneHost() {
        val ready = decode<Health>("""{"v":1,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001","pid":7,"port":4455,"sottoVersion":"0.1.19","features":["detail-delta"]}""")
        ready.validate()
        assertThrows(ClientError::class.java) { decode<Health>("""{"v":2,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001"}""").validate() }
        assertThrows(ClientError::class.java) { decode<Health>("""{"v":1,"status":"ready","hostId":"not-a-host"}""").validate() }
    }

    @Test fun healthNameIsOptionalAndReadsAsOneLine() {
        val desktop = decode<Health>("""{"v":1,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001","name":"  Zach’s\nLaptop  "}""")
        desktop.validate()
        assertEquals("Zach’s Laptop", desktop.computerName)
        val older = decode<Health>("""{"v":1,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001"}""")
        assertNull(older.name); assertNull(older.computerName)
        val blank = decode<Health>("""{"v":1,"status":"ready","hostId":"00000000-0000-4000-8000-000000000001","name":"   "}""")
        assertNull(blank.computerName)
        assertEquals(ComputerName.MAXIMUM_LENGTH, ComputerName.cleaned("a".repeat(80))?.length)
    }

    // Pairing code

    @Test fun pairingCodeIsCleanedToTheHostsAlphabet() {
        assertEquals("K7Q4MX9Z", PairingCode.normalized("k7q4-mx9z"))
        assertEquals("K7Q4MX9Z", PairingCode.normalized(" K7Q4 MX9Z "))
        assertEquals("K7Q4MX9Z", PairingCode.cleaned("k7q4mx9zzz"))
        for (typed in listOf("K7Q4MX9", "K7Q4MX9O", "K7Q4MX91", "K7Q4MX9Z!", "K7Q4MX9ZZ")) {
            assertThrows(typed, ClientError::class.java) { PairingCode.normalized(typed) }
        }
    }

    // Threads

    @Test fun stateWordsPutWaitingRequestsFirst() {
        val permission = """[{"id":"r","kind":"permission","text":"Run?","options":[]}]"""
        val question = """[{"id":"r","kind":"question","text":"Which?","options":[]}]"""
        assertEquals(ThreadState.NeedsAnswer, ThreadState.of(thread("a", status = "running", requests = permission)))
        assertEquals(ThreadState.Asked, ThreadState.of(thread("b", requests = question)))
        assertEquals(ThreadState.Working, ThreadState.of(thread("c", status = "running")))
        assertEquals(ThreadState.Failed, ThreadState.of(thread("d", status = "error")))
        assertEquals("Done", ThreadState.of(thread("e")).words)
    }

    // Not ported: the two `merged(_, filter: .working / .done)` assertions. The Kotlin port has no ThreadFilter.
    @Test fun threadsFromEveryComputerMergeMostRecentFirst() {
        val laptop = ComputerThreads(
            hostID = "laptop", name = "Laptop", status = ComputerStatus.Online,
            threads = listOf(thread("a", summary = "2026-09-26T09:00:00.000Z"), thread("b", status = "running", summary = "2026-09-26T09:30:00Z")),
            projects = decode("""[{"id":"p","title":"Sotto"}]"""),
        )
        val forge = ComputerThreads(hostID = "forge", name = "forge", status = ComputerStatus.Online, threads = listOf(thread("c", project = "q", summary = "2026-09-26T09:10:00.000Z")))
        val rows = ThreadGroups.merged(listOf(laptop, forge))
        assertEquals(listOf("laptop/b", "forge/c", "laptop/a"), rows.map { it.id })
        assertEquals(listOf("Laptop", "forge", "Laptop"), rows.map { it.computer })
        assertEquals("Sotto", rows.first().project); assertNull(rows[1].project)
    }

    @Test fun theStripNarrowsToOneComputer() {
        val laptop = ComputerThreads(hostID = "laptop", name = "Laptop", status = ComputerStatus.Online, threads = listOf(thread("a")))
        val forge = ComputerThreads(hostID = "forge", name = "forge", status = ComputerStatus.Online, threads = listOf(thread("b")))
        assertEquals(listOf("forge/b"), ThreadGroups.merged(listOf(laptop, forge), show = ComputerFilter.Only("forge")).map { it.id })
        assertEquals(2, ThreadGroups.merged(listOf(laptop, forge), show = ComputerFilter.All).size)
        assertTrue(ComputerFilter.All.admits("anything")); assertFalse(ComputerFilter.Only("laptop").admits("forge"))
    }

    @Test fun twoComputersWithTheSameThreadIDStayApart() {
        val question = """[{"id":"r","kind":"question","text":"Which?","options":[]}]"""
        val laptop = ComputerThreads(hostID = "laptop", name = "Laptop", status = ComputerStatus.Online, threads = listOf(thread("same", requests = question)))
        val forge = ComputerThreads(hostID = "forge", name = "forge", status = ComputerStatus.Online, threads = listOf(thread("same", requests = question)))
        val rows = ThreadGroups.merged(listOf(laptop, forge))
        assertEquals(2, rows.map { it.id }.toSet().size)
        assertNotEquals(rows[0].ref, rows[1].ref)
        assertEquals(listOf("same", "same"), rows.map { it.ref.threadID })
        assertEquals(setOf("laptop/same/r", "forge/same/r"), ThreadGroups.waiting(listOf(laptop, forge)).map { it.id }.toSet())
        assertEquals(ThreadRef(hostID = "laptop", threadID = "same"), ThreadRef(hostID = "laptop", threadID = "same"))
        assertNotEquals(ThreadRef(hostID = "laptop", threadID = "same"), ThreadRef(hostID = "forge", threadID = "same"))
    }

    // Not ported: the ThreadGroups.working and ThreadGroups.unreachable assertions. The Kotlin port has neither.
    @Test fun aComputerThatCantBeReachedHidesNothingElse() {
        val permission = """[{"id":"r","kind":"permission","text":"Run?","options":[]}]"""
        val laptop = ComputerThreads(hostID = "laptop", name = "Laptop", status = ComputerStatus.Online, threads = listOf(thread("a", requests = permission), thread("b", status = "running")))
        val forge = ComputerThreads(
            hostID = "forge", name = "forge", status = ComputerStatus.Unreachable,
            threads = listOf(thread("c", status = "running", requests = permission, summary = "2026-09-26T10:00:00.000Z")),
        )
        assertEquals(listOf("laptop/a/r"), ThreadGroups.waiting(listOf(laptop, forge)).map { it.id })
        assertEquals(listOf("laptop/a", "laptop/b", "forge/c"), ThreadGroups.merged(listOf(laptop, forge)).map { it.id })
        assertEquals("Can’t reach it", ComputerStatus.Unreachable.words)
    }

    // Not ported: the ThreadGroups.working assertion. The Kotlin port has no ThreadGroups.working.
    @Test fun waitingListsEveryRequestAndWorkingLeavesThemOut() {
        val two = """[{"id":"r1","kind":"question","text":"One?","options":[]},{"id":"r2","kind":"permission","text":"Two?","options":[]}]"""
        val laptop = ComputerThreads(hostID = "h", name = "Laptop", status = ComputerStatus.Online, threads = listOf(thread("a", status = "running", requests = two), thread("b", status = "running")))
        assertEquals(listOf("h/a/r1", "h/a/r2"), ThreadGroups.waiting(listOf(laptop)).map { it.id })
    }

    // Saved computers

    private fun pairing(n: Int): Pairing =
        decode("""{"v":1,"hostId":"00000000-0000-4000-8000-00000000000$n","clientId":"phone","token":"secret"}""")

    // Not ported: the ComputerStore.plan assertions. The Kotlin port has no migration plan for a legacy item.
    @Test fun theSinglePairingBecomesTheFirstComputer() {
        // The item an earlier build saved under `host`: address and pairing, no names.
        val legacy = decode<SavedComputer>("""{"address":"https://forge.tail5c2e.ts.net","pairing":{"v":1,"hostId":"00000000-0000-4000-8000-000000000001","clientId":"phone","token":"secret"}}""")
        legacy.validate()
        assertEquals("forge", legacy.name); assertNull(legacy.reportedName)
        assertEquals("computer.00000000-0000-4000-8000-000000000001", SecureStore.account(legacy.hostID))
    }

    @Test fun aComputersNameIsTheOneGivenHereThenItsOwnThenItsTailnetName() {
        var computer = SavedComputer(address = "https://laptop.tail5c2e.ts.net:8443", pairing = pairing(2))
        assertEquals("laptop", computer.name)
        assertEquals(8443, computer.endpoint?.port)
        computer = computer.copy(reportedName = "Zach’s Laptop"); assertEquals("Zach’s Laptop", computer.name)
        computer = computer.copy(localName = "Desk"); assertEquals("Desk", computer.name)
        computer = computer.copy(localName = "  "); assertEquals("Zach’s Laptop", computer.name)
        val decoded = SottoJson.decodeFromString(SavedComputer.serializer(), SottoJson.encodeToString(SavedComputer.serializer(), computer))
        assertEquals(computer, decoded)
    }

    // Activity

    @Test fun activityDecodesAndNamesWhatItTouched() {
        val detail = decode<ThreadDetail>(
            """
            {"threadId":"t","revision":3,"messages":[],"activities":[
              {"id":"a","turnId":"u","sequence":2,"kind":"command","status":"running","title":"Running tests","command":"npm test"},
              {"id":"b","turnId":"u","sequence":1,"kind":"file-change","status":"completed","title":"Edited files","changes":[{"path":"src/a.ts","kind":"update"},{"path":"src/b.ts","kind":"add"}],"durationMs":1200},
              {"id":"c","turnId":"u","sequence":3,"kind":"something-new","status":"completed","title":"A later kind"}]}
            """,
        )
        assertNotNull(detail.activities)
        val records = detail.activities!!
        assertEquals(listOf("npm test", "src/a.ts and 1 more", null), records.map { it.subject })
        assertEquals("something-new", records[2].kind)
    }

    @Test fun shellRowsReadTheirSummaryWhenPresent() {
        val row = decode<ThreadSummary>("""{"id":"t","projectId":"p","title":"T","status":"running","requests":[],"summary":{"messageCount":4,"lastMessageAt":"2026-09-26T09:38:00.000Z","activityCount":2,"runningTurnStartedAt":"2026-09-26T09:40:00.000Z"}}""")
        assertEquals("2026-09-26T09:40:00.000Z", row.summary?.runningTurnStartedAt)
        assertNull(thread("bare").summary)
    }
}
