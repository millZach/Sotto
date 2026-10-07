/**
 * An end-to-end run's stand-in for MagicDNS and Tailscale Serve (ADR-0053): `SOTTO_E2E_TAILNET_MAP` names one or more
 * `<MagicDNS name>=127.0.0.1:<port>` pairs, comma separated, and a tailnet address on a mapped name is opened at that
 * loopback port over plain HTTP, where a spec's proxy stands in front of the host's tailnet listener. Only loopback is
 * ever a target, and the app wires this only in development, like the ssh stand-in.
 */
export function e2eTailnetMap(value: string | undefined): ((address: string) => string) | undefined {
  if (!value) return undefined
  const map = new Map<string, string>()
  for (const pair of value.split(',')) {
    const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net)=127\.0\.0\.1:(\d{1,5})$/u.exec(pair.trim())
    if (!match) throw new Error('The tailnet test stand-in maps a MagicDNS name to a loopback port only.')
    map.set(match[1]!, `http://127.0.0.1:${match[2]!}`)
  }
  return address => map.get(new URL(address).hostname) ?? address
}
