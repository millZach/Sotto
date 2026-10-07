import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import type { PhoneAccessTailscale } from '../phones/phoneAccess'
import { serveTarget, type ServeConfig, type ServeResult, type TailscaleStatus } from '../phones/tailscale'

/**
 * An end-to-end run never touches the machine's Tailscale. It reads `e2e-tailscale.json` in its own
 * profile instead, on every call so a spec can change it and press Try again: whether Tailscale is
 * running, and what else holds port 8443. Without the file, Tailscale reads as not installed.
 */
const fixtureSchema = z.object({
  state: z.enum(['running', 'not-running', 'missing']),
  dnsName: z.string().default('laptop-russh2j5.tail5728ca.ts.net'),
  hostName: z.string().default('laptop-russh2j5'),
  /**
   * Another app's proxy target on 8443, the tailnet not having Serve turned on, or Serve refused to an account that is not
   * Tailscale's operator, as Linux refuses it.
   */
  serve: z.enum(['free', 'taken', 'not-enabled', 'denied']).default('free'),
}).strict()

export function e2eTailscale(profile: string): PhoneAccessTailscale {
  const read = (): z.infer<typeof fixtureSchema> => {
    try { return fixtureSchema.parse(JSON.parse(readFileSync(join(profile, 'e2e-tailscale.json'), 'utf8'))) }
    catch { return fixtureSchema.parse({ state: 'missing' }) }
  }
  let mapped: number | null = null
  const config = (): ServeConfig => {
    const fixture = read()
    const target = fixture.serve === 'taken' ? 'http://127.0.0.1:3773' : mapped === null ? null : serveTarget(mapped)
    if (target === null) return {}
    return { TCP: { '8443': { HTTPS: true } }, Web: { [`${fixture.dnsName}:8443`]: { Handlers: { '/': { Proxy: target } } } } }
  }
  return {
    status: async (): Promise<TailscaleStatus> => { const fixture = read(); return fixture.state === 'running' ? { state: 'running', dnsName: fixture.dnsName, hostName: fixture.hostName } : { state: fixture.state } },
    serveStatus: async () => config(),
    serve: async (_port, loopbackPort): Promise<ServeResult> => {
      const serve = read().serve
      if (serve === 'not-enabled') return { ok: false, reason: 'not-enabled', enableUrl: 'https://login.tailscale.com/f/serve?node=e2e' }
      if (serve === 'denied') return { ok: false, reason: 'denied' }
      mapped = loopbackPort
      return { ok: true }
    },
    unserve: async () => { mapped = null; return true },
  }
}
