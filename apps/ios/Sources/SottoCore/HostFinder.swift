import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Turns what the user typed when adding a computer into the private HTTPS addresses to try.
/// A bare machine name such as `forge` is looked up through the tailnet's MagicDNS, which the
/// Tailscale app on this iPhone answers, so the lookup never leaves the tailnet. Every address it
/// gives still has to be a certificate-validated `*.ts.net` origin (`HostEndpoint`).
public enum HostFinder {
    /// What was typed: an address with its port, used as typed; a full `.ts.net` name without one;
    /// or a machine name to look up.
    public enum Input: Equatable, Sendable { case address(HostEndpoint), fullName(String), name(String) }
    /// Every name the system resolver gives for a machine name: its canonical name and the
    /// reverse-lookup name of each address. Injected so tests need no network.
    public typealias Lookup = @Sendable (String) async -> [String]
    /// The ports to try for a name, in order: the Tailscale Serve ports phone access uses (8443, or
    /// 10000 when another app holds 8443), then the usual HTTPS port a host run by hand is served on.
    public static let ports = [8443, 10000, 443]

    public static func read(_ typed: String) throws -> Input {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.contains("://") || text.contains(":") {
            let endpoint = try HostEndpoint(text.contains("://") ? text : "https://" + text)
            let typedPort = URLComponents(string: text.contains("://") ? text : "https://" + text)?.port
            return typedPort == nil ? .fullName(endpoint.host) : .address(endpoint)
        }
        if text.contains(".") {
            let bare = text.hasSuffix(".") ? String(text.dropLast()) : text
            guard bare.hasSuffix(".ts.net") else { throw ClientError.invalidHost }
            return .fullName(try HostEndpoint("https://" + bare).host)
        }
        guard isMachineName(text) else { throw ClientError.invalidHost }
        return .name(text)
    }

    /// The full tailnet name a resolver's answer gives, when it names this machine on a tailnet.
    public static func fullName(machine: String, resolvedName: String) -> String? {
        let name = (resolvedName.hasSuffix(".") ? String(resolvedName.dropLast()) : resolvedName).lowercased()
        guard name.hasSuffix(".ts.net"), name.split(separator: ".").first.map(String.init) == machine,
              let endpoint = try? HostEndpoint("https://" + name) else { return nil }
        return endpoint.host
    }

    /// The addresses to try for a full tailnet name, in the order of `ports`.
    public static func endpoints(fullName: String) -> [HostEndpoint] {
        ports.compactMap { try? HostEndpoint("https://\(fullName):\($0)") }
    }

    /// The addresses to check, in order: the one typed with its port, or 8443, 10000, then 443 on the
    /// computer's full name.
    public static func candidates(_ typed: String, lookup: Lookup = SystemLookup.names) async throws -> [HostEndpoint] {
        switch try read(typed) {
        case .address(let endpoint): return [endpoint]
        case .fullName(let name): return endpoints(fullName: name)
        case .name(let machine):
            for name in await lookup(machine) {
                if let full = fullName(machine: machine, resolvedName: name) { return endpoints(fullName: full) }
            }
            throw ClientError.hostNotFound(machine)
        }
    }

    /// Checks each address in order and keeps the first where Sotto answers. Only nothing answering,
    /// or something that isn't Sotto, moves on to the next port. Any other answer proves Sotto is
    /// there (still starting, another protocol version, another host), so it stops and says why.
    /// When no port has Sotto, something that answered says more than nothing answering.
    public static func probe<Found>(_ candidates: [HostEndpoint], check: (HostEndpoint) async throws -> Found) async throws -> (endpoint: HostEndpoint, found: Found) {
        var missed: Error?
        for endpoint in candidates {
            do { return (endpoint, try await check(endpoint)) }
            catch {
                switch error as? ClientError {
                case .hostUnreachable?: if missed == nil { missed = error }
                case .notASottoHost?: missed = error
                default: throw error
                }
            }
        }
        throw missed ?? ClientError.invalidHost
    }

    static func isMachineName(_ text: String) -> Bool {
        guard (1...63).contains(text.count), text.first != "-", text.last != "-" else { return false }
        return text.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "-" }
    }
    /// Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. A name is trusted only
    /// when it resolves into them, so a resolver off the tailnet cannot hand the phone another host.
    public static func isTailnetAddress(_ bytes: [UInt8]) -> Bool {
        if bytes.count == 4 { return bytes[0] == 100 && bytes[1] & 0xC0 == 64 }
        if bytes.count == 16 { return Array(bytes.prefix(6)) == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0] }
        return false
    }
}

#if canImport(Darwin)
/// The system resolver. With Tailscale connected, the tailnet's search domain makes a machine name
/// resolve, and its canonical or reverse-lookup name is the full `machine.tailnet.ts.net`.
public enum SystemLookup {
    /// Gives up after ten seconds; the blocking resolver call is left to finish on its own.
    public static let names: HostFinder.Lookup = { machine in
        await withCheckedContinuation { continuation in
            let once = Once()
            DispatchQueue.global(qos: .userInitiated).async { let found = resolve(machine); if once.claim() { continuation.resume(returning: found) } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) { if once.claim() { continuation.resume(returning: []) } }
        }
    }
    /// Names are taken only from answers that point into the tailnet.
    static func resolve(_ machine: String) -> [String] {
        var hints = addrinfo(); hints.ai_flags = AI_CANONNAME; hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM
        var list: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(machine, "443", &hints, &list) == 0, let first = list else { return [] }
        defer { freeaddrinfo(first) }
        var names: [String] = []
        var cursor: UnsafeMutablePointer<addrinfo>? = first
        while let entry = cursor {
            cursor = entry.pointee.ai_next
            guard let address = entry.pointee.ai_addr, HostFinder.isTailnetAddress(bytes(of: address)) else { continue }
            if names.isEmpty, let canonical = first.pointee.ai_canonname { names.append(String(cString: canonical)) }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, entry.pointee.ai_addrlen, &host, socklen_t(host.count), nil, 0, NI_NAMEREQD) == 0 {
                names.append(host.withUnsafeBufferPointer { String(cString: $0.baseAddress!) })
            }
        }
        return names
    }
    private static func bytes(of address: UnsafeMutablePointer<sockaddr>) -> [UInt8] {
        switch Int32(address.pointee.sa_family) {
        case AF_INET:
            return address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { pointer in
                var value = pointer.pointee.sin_addr
                return withUnsafeBytes(of: &value) { Array($0) }
            }
        case AF_INET6:
            return address.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { pointer in
                var value = pointer.pointee.sin6_addr
                return withUnsafeBytes(of: &value) { Array($0) }
            }
        default: return []
        }
    }
    private final class Once: @unchecked Sendable {
        private let lock = NSLock(); private var done = false
        func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
    }
}
#endif

/// A pairing code as the host makes it: eight characters from an alphabet without look-alikes.
/// The host compares codes exactly, so the phone upper-cases and drops the spaces and dashes people type.
public enum PairingCode {
    public static let length = 8
    static let alphabet = Set("23456789ABCDEFGHJKMNPQRSTVWXYZ")
    /// What the user has typed so far, cleaned: at most eight characters, only from the alphabet.
    public static func cleaned(_ typed: String) -> String {
        String(typed.uppercased().filter { alphabet.contains($0) }.prefix(length))
    }
    public static func normalized(_ typed: String) throws -> String {
        let code = cleaned(typed)
        let kept = typed.uppercased().filter { alphabet.contains($0) }
        let dropped = typed.uppercased().filter { !alphabet.contains($0) && $0 != " " && $0 != "-" }
        guard kept.count == length, dropped.isEmpty else { throw ClientError.invalidCode }
        return code
    }
}
