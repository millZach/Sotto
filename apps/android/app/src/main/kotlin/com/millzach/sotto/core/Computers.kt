package com.millzach.sotto.core

import kotlinx.serialization.Serializable

// A computer's name as the phone shows it: one line, trimmed, at most 64 characters.
object ComputerName {
    const val MAXIMUM_LENGTH = 64

    fun cleaned(raw: String?): String? {
        if (raw == null) return null
        val spaced = raw.map { if (Character.isISOControl(it)) ' ' else it }.joinToString("")
        val words = spaced.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        val name = words.take(MAXIMUM_LENGTH).trim()
        return name.ifEmpty { null }
    }
}

// A paired computer as this phone keeps it in secure storage: where it answers, its pairing, and its names.
@Serializable
data class SavedComputer(
    val address: String,
    val pairing: Pairing,
    // The name the computer gave in its health when it was added. Older hosts give none.
    val reportedName: String? = null,
    // A name given on this phone. It wins over the others until it is cleared.
    val localName: String? = null,
) {
    val hostID: String get() = pairing.hostId
    val endpoint: HostEndpoint? get() = try { HostEndpoint.parse(address) } catch (_: ClientError) { null }

    // Its name on the tailnet, the first label of its address: `forge`.
    val machineName: String get() = endpoint?.machine ?: "Computer"

    // The name every list shows: the one given here, else the computer's own, else its tailnet name.
    val name: String get() = ComputerName.cleaned(localName) ?: ComputerName.cleaned(reportedName) ?: machineName

    fun validate() {
        pairing.validate()
        HostEndpoint.parse(address)
    }
}

// A pairing code as the host makes it: eight characters from an alphabet without look-alikes. The host
// compares codes exactly, so the phone upper-cases and drops the spaces and dashes people type.
object PairingCode {
    const val LENGTH = 8
    private val alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ".toSet()

    // What the user has typed so far, cleaned: at most eight characters, only from the alphabet.
    fun cleaned(typed: String): String = typed.uppercase().filter { it in alphabet }.take(LENGTH)

    fun normalized(typed: String): String {
        val upper = typed.uppercase()
        val kept = upper.filter { it in alphabet }
        val dropped = upper.filter { it !in alphabet && it != ' ' && it != '-' }
        if (kept.length != LENGTH || dropped.isNotEmpty()) throw ClientError.InvalidCode
        return kept
    }
}

// Turns what the user typed when adding a computer into the private HTTPS addresses to try. A bare machine
// name such as `forge` is looked up through the tailnet's MagicDNS, which the Tailscale app on this phone
// answers. Every address it gives still has to be a certificate-validated `*.ts.net` origin.
object HostFinder {
    sealed interface Input {
        data class Address(val endpoint: HostEndpoint) : Input
        data class FullName(val name: String) : Input
        data class Name(val machine: String) : Input
    }

    // The ports to try for a name, in order: the desktop's Tailscale Serve port, then the usual HTTPS port
    // a host without a screen is served on.
    val ports = listOf(8443, 443)

    fun read(typed: String): Input {
        val text = typed.trim().lowercase()
        if (text.contains("://") || text.contains(":")) {
            val full = if (text.contains("://")) text else "https://$text"
            val endpoint = HostEndpoint.parse(full)
            val typedPort = try { java.net.URI(full).port } catch (_: Exception) { -1 }
            return if (typedPort == -1) Input.FullName(endpoint.host) else Input.Address(endpoint)
        }
        if (text.contains(".")) {
            val bare = text.removeSuffix(".")
            if (!bare.endsWith(".ts.net")) throw ClientError.InvalidHost
            return Input.FullName(HostEndpoint.parse("https://$bare").host)
        }
        if (!isMachineName(text)) throw ClientError.InvalidHost
        return Input.Name(text)
    }

    // The full tailnet name a resolver's answer gives, when it names this machine on a tailnet.
    fun fullName(machine: String, resolvedName: String): String? {
        val name = resolvedName.removeSuffix(".").lowercase()
        if (!name.endsWith(".ts.net") || name.substringBefore('.') != machine) return null
        return try { HostEndpoint.parse("https://$name").host } catch (_: ClientError) { null }
    }

    // The addresses to try for a full tailnet name, in the order of `ports`.
    fun endpoints(fullName: String): List<HostEndpoint> =
        ports.mapNotNull { try { HostEndpoint.parse("https://$fullName:$it") } catch (_: ClientError) { null } }

    // The addresses to check, in order: the one typed with its port, or 8443 then 443 on the full name.
    suspend fun candidates(typed: String, lookup: suspend (String) -> List<String>): List<HostEndpoint> =
        when (val input = read(typed)) {
            is Input.Address -> listOf(input.endpoint)
            is Input.FullName -> endpoints(input.name)
            is Input.Name -> {
                val full = lookup(input.machine).firstNotNullOfOrNull { fullName(input.machine, it) }
                    ?: throw ClientError.HostNotFound(input.machine)
                endpoints(full)
            }
        }

    // Checks each address in order and keeps the first where Sotto answers. Only nothing answering, or
    // something that isn't Sotto, moves on to the next port. Any other answer proves Sotto is there, so it
    // stops and says why. When no port has Sotto, something that answered says more than nothing answering.
    suspend fun <Found> probe(candidates: List<HostEndpoint>, check: suspend (HostEndpoint) -> Found): Pair<HostEndpoint, Found> {
        var missed: Exception? = null
        for (endpoint in candidates) {
            try {
                return endpoint to check(endpoint)
            } catch (error: ClientError.HostUnreachable) {
                if (missed == null) missed = error
            } catch (error: ClientError.NotASottoHost) {
                missed = error
            }
        }
        throw missed ?: ClientError.InvalidHost
    }

    fun isMachineName(text: String): Boolean {
        if (text.length !in 1..63 || text.first() == '-' || text.last() == '-') return false
        return text.all { (it in 'a'..'z') || (it in 'A'..'Z') || (it in '0'..'9') || it == '-' }
    }

    // Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. A name is trusted only when it
    // resolves into them, so a resolver off the tailnet cannot hand the phone another host.
    fun isTailnetAddress(bytes: ByteArray): Boolean {
        val b = bytes.map { it.toInt() and 0xFF }
        if (b.size == 4) return b[0] == 100 && (b[1] and 0xC0) == 64
        if (b.size == 16) return b.take(6) == listOf(0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0)
        return false
    }
}
