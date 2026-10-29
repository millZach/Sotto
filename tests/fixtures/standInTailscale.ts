import type { PhoneAccessTailscale } from '../../src/main/phones/phoneAccess'
import { serveTarget, type ServeConfig, type ServeResult } from '../../src/main/phones/tailscale'

/**
 * A stand-in for one machine's Tailscale, as phone access uses it (ADR-0033, ADR-0050): running, with one Serve setting
 * that a serve sets and an unserve takes away. A test's host runs it in place of the machine's own, which no test touches.
 */
export function standInTailscale(serve: ServeResult = { ok: true }, dnsName = 'forge.tail5728ca.ts.net') {
  let proxy: string | undefined, served: number | undefined
  const calls: string[] = []
  const tailscale: PhoneAccessTailscale = {
    status: async () => { calls.push('status'); return { state: 'running', dnsName, hostName: dnsName.split('.')[0]! } },
    serveStatus: async (): Promise<ServeConfig> => {
      calls.push('serve-status')
      return proxy && served ? { TCP: { [served]: { HTTPS: true } }, Web: { [`${dnsName}:${served}`]: { Handlers: { '/': { Proxy: proxy } } } } } : {}
    },
    // The Serve port is the one asked for, so a test sees which port the host had Tailscale serve.
    serve: async (port, loopback) => { calls.push(`serve ${loopback}`); if (serve.ok) { proxy = serveTarget(loopback); served = port } return serve },
    unserve: async () => { calls.push('unserve'); proxy = undefined; served = undefined; return true },
  }
  return { tailscale, calls, proxied: (): number | undefined => proxy ? Number(new URL(proxy).port) : undefined, served: (): number | undefined => served }
}
