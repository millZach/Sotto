package com.millzach.sotto.app

import com.millzach.sotto.core.HostFinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull
import java.net.InetAddress

// The system resolver. With Tailscale connected, MagicDNS answers a machine name, and the reverse lookup of
// its tailnet address is the full `machine.tailnet.ts.net`. Names come only from answers inside the tailnet.
object SystemLookup {
    // Gives up after ten seconds; the blocking resolver call is left to finish on its own.
    suspend fun names(machine: String): List<String> {
        val lookup = CoroutineScope(Dispatchers.IO).async { resolve(machine) }
        return withTimeoutOrNull(10_000) { lookup.await() } ?: emptyList()
    }

    private fun resolve(machine: String): List<String> {
        val addresses = try { InetAddress.getAllByName(machine) } catch (_: Exception) { return emptyList() }
        return addresses.filter { HostFinder.isTailnetAddress(it.address) }
            .mapNotNull { address -> address.canonicalHostName.takeIf { it != address.hostAddress } }
    }
}
