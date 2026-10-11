// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import type { HostService } from '../../src/main/agents/hostService'
import { PhoneAccess, type PhoneAccessOptions, type PhoneAccessTailscale } from '../../src/main/phones/phoneAccess'

import { serveTarget, type ServeConfig, type ServeResult, type TailscaleStatus } from '../../src/main/phones/tailscale'

export let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-phone-access-')) })
afterEach(async () => { if (dirname(root) === tmpdir() && root.includes('sotto-phone-access-')) await rm(root, { recursive: true, force: true }) })

export const DNS = 'laptop-russh2j5.tail5728ca.ts.net'
/** A stand-in Tailscale: its Serve settings, one proxy per port (8443 or 10000), Sotto's or someone else's. */
export function fakeTailscale(options: { status?: TailscaleStatus; other?: string; others?: Record<number, string>; serve?: ServeResult } = {}) {
  let status: TailscaleStatus = options.status ?? { state: 'running', dnsName: DNS, hostName: 'laptop-russh2j5' }
  const proxies = new Map<number, string>(Object.entries(options.others ?? {}).map(([port, target]) => [Number(port), target]))
  if (options.other) proxies.set(8443, options.other)
  const calls: string[] = []
  // 8443 keeps the call names the tests have always read; another port names itself.
  const on = (port: number) => port === 8443 ? '' : ` on ${port}`
  const tailscale: PhoneAccessTailscale = {
    status: vi.fn(async () => { calls.push('status'); return status }),
    serveStatus: vi.fn(async (): Promise<ServeConfig> => {
      calls.push('serve-status')
      if (proxies.size === 0) return {}
      const entries = [...proxies]
      return {
        TCP: Object.fromEntries(entries.map(([port]) => [String(port), { HTTPS: true }])),
        Web: Object.fromEntries(entries.map(([port, target]) => [`${DNS}:${port}`, { Handlers: { '/': { Proxy: target } } }])),
      }
    }),
    serve: vi.fn(async (port: number, loopback: number): Promise<ServeResult> => { calls.push(`serve ${loopback}${on(port)}`); const result = options.serve ?? { ok: true }; if (result.ok) proxies.set(port, serveTarget(loopback)); return result }),
    unserve: vi.fn(async (port: number) => { calls.push(`unserve${on(port)}`); proxies.delete(port); return true }),
  }
  return {
    tailscale, calls, proxy: (port = 8443) => proxies.get(port),
    setStatus: (next: TailscaleStatus) => { status = next }, setOther: (target: string, port = 8443) => { proxies.set(port, target) },
  }
}
/** A stand-in listener: its port, the clients connected to it, and whether it was closed. */
export function fakeServer(options: { refusePort?: number } = {}) {
  const started: { port: number; closed: boolean; name: () => string | undefined; admin: unknown; onPaired?: (id: string) => void }[] = []
  let next = 41000
  const startServer = vi.fn(async (input: { port?: number; name?: () => string | undefined; admin?: boolean; onPaired?: (id: string) => void }) => {
    if (input.port !== undefined && input.port !== 0 && input.port === options.refusePort) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    const port = input.port || next++
    const entry = { port, closed: false, name: input.name!, admin: input.admin, ...(input.onPaired ? { onPaired: input.onPaired } : {}) }
    started.push(entry)
    return { descriptor: { port }, connectedClients: () => [], dropRevoked: vi.fn(), refreshCapabilities: vi.fn(), stopServing: () => { entry.closed = true }, close: async () => { entry.closed = true } }
  })
  return { startServer: startServer as unknown as NonNullable<PhoneAccessOptions['startServer']>, started }
}
export function create(options: Partial<PhoneAccessOptions> & { tailscale: PhoneAccessTailscale }, settings = { phoneAccess: true, phoneAccessName: '' }) {
  const current = { ...settings }
  const access = new PhoneAccess({ directory: root, service: {} as HostService, settings: () => current, openExternal: vi.fn(async () => undefined), hostname: () => 'LAPTOP', retryMs: 60_000, ...options })
  return { access, settings: current }
}
export const record = async () => JSON.parse(await readFile(join(root, 'phone-access.json'), 'utf8')) as { port: number | null; mapped: boolean; servePort?: number }
