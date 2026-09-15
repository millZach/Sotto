import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentConfiguration, AgentState } from '../../shared/agents'
import type { AgentMembership } from './control'
import type { AgentCredentials } from './credentials'

type MembershipState = AgentState['membership']
const timestamp = z.string().datetime({ offset: true })
const sessionSchema = z.object({ version: z.literal(1), endpoint: z.string(), accessToken: z.string().min(1).max(16_384), expiresAt: timestamp })
const entitlementSchema = z.object({
  status: z.enum(['free', 'active', 'expired']), expiresAt: timestamp.nullable(),
  cacheUntil: timestamp, cancelAtPeriodEnd: z.boolean().default(false),
})
const cacheSchema = z.object({
  version: z.literal(1), endpoint: z.string(), sessionFingerprint: z.string(),
  verifiedAt: z.number(), lastSeenAt: z.number(), validUntil: z.number(),
  entitlement: entitlementSchema,
})
const deviceSchema = z.object({
  deviceCode: z.string().min(1).max(16_384), userCode: z.string().min(1).max(128),
  verificationUri: z.string().url(), expiresIn: z.number().int().min(30).max(900),
  interval: z.number().int().min(2).max(60).default(5),
})
const tokenResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorized'), accessToken: z.string().min(1).max(16_384), expiresAt: timestamp }),
  z.object({ status: z.enum(['pending', 'slow_down', 'expired', 'denied']) }),
])
type Session = z.infer<typeof sessionSchema>
type Cache = z.infer<typeof cacheSchema>

// Provisional private-beta ceiling. The service can always issue a shorter
// lease; production policy must be selected and tested before paid launch.
const MAX_OFFLINE_LEASE_MS = 24 * 60 * 60 * 1_000
const CLOCK_ROLLBACK_TOLERANCE_MS = 60_000
const freeState = (label = 'Free dictation'): MembershipState => ({ status: 'free', label, expiresAt: null })
const unavailableState = (label: string): MembershipState => ({ status: 'unavailable', label, expiresAt: null })

export interface AgentMembershipClientOptions {
  configuration: () => Pick<AgentConfiguration, 'membershipEndpoint'>
  credentials: AgentCredentials
  directory: string
  openExternal: (url: string) => Promise<unknown>
  now?: () => number
}

/** Desktop client only: entitlement decisions and billing events belong to the service. */
export class AgentMembershipClient implements AgentMembership {
  private serial: Promise<unknown> = Promise.resolve()
  private pending: { endpoint: string; deviceCode: string; userCode: string; expiresAt: number; nextPollAt: number; intervalMs: number } | null = null
  private readonly invalidatedCaches = new Set<string>()
  private readonly now: () => number

  constructor(private readonly options: AgentMembershipClientOptions) { this.now = options.now ?? Date.now }

  status(): Promise<MembershipState> { return this.enqueue(() => this.readStatus()) }

  action(action: 'refresh' | 'signin' | 'checkout' | 'portal'): Promise<MembershipState> {
    return this.enqueue(async () => {
      if (action === 'refresh') return this.readStatus()
      const endpoint = this.endpoint()
      if (!endpoint) throw new Error('Sotto membership service is not configured. Production checkout is not available yet.')
      if (action === 'signin') {
        if (!this.options.credentials.available()) throw new Error('Unlock secure credential storage before signing in.')
        const device = deviceSchema.parse(await this.request(endpoint, '/v1/device/authorize', { method: 'POST', body: { clientName: 'Sotto desktop' } }))
        const link = this.hostedLink(endpoint, device.verificationUri, false)
        this.pending = { endpoint, deviceCode: device.deviceCode, userCode: device.userCode,
          expiresAt: this.now() + device.expiresIn * 1_000, nextPollAt: this.now() + device.interval * 1_000, intervalMs: device.interval * 1_000 }
        try { await this.options.openExternal(link) } catch { this.pending = null; throw new Error('Could not open Sotto sign-in in your browser. Try again.') }
        return freeState(`Finish sign-in in your browser using ${device.userCode}. Membership will refresh here.`)
      }
      const session = this.session(endpoint)
      if (!session) throw new Error('Sign in to Sotto before opening subscription management.')
      const result = z.object({ url: z.string().url() }).parse(await this.request(endpoint, `/v1/billing/${action}`, { method: 'POST', body: {}, accessToken: session.accessToken }))
      await this.options.openExternal(this.hostedLink(endpoint, result.url, true))
      // A browser redirect is never evidence of a paid subscription.
      return this.readStatus()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation)
    this.serial = next.catch(() => undefined)
    return next
  }

  private endpoint(): string {
    const configured = this.options.configuration().membershipEndpoint.trim()
    if (!configured) return ''
    const url = new URL(configured)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Use the HTTPS origin of the Sotto membership service, with no path, query, or credentials.')
    }
    return url.origin
  }

  private session(endpoint: string): Session | null {
    const raw = this.options.credentials.get('membership')
    if (!raw) return null
    try {
      const session = sessionSchema.parse(JSON.parse(raw))
      if (session.endpoint !== endpoint || Date.parse(session.expiresAt) <= this.now()) return null
      return session
    } catch { return null }
  }

  private cached(endpoint: string, session: Session): Cache | null {
    try {
      if (this.invalidatedCaches.has(this.fingerprint(session))) return null
      const raw = this.options.credentials.get('membership-cache')
      if (!raw) return null
      const cached = cacheSchema.parse(JSON.parse(raw))
      if (cached.endpoint !== endpoint || cached.sessionFingerprint !== this.fingerprint(session) ||
        cached.verifiedAt > this.now() + CLOCK_ROLLBACK_TOLERANCE_MS ||
        cached.lastSeenAt > this.now() + CLOCK_ROLLBACK_TOLERANCE_MS ||
        cached.validUntil > cached.verifiedAt + MAX_OFFLINE_LEASE_MS || cached.validUntil <= this.now()) return null
      return cached
    } catch { return null }
  }

  private fingerprint(session: Session): string {
    return createHash('sha256').update(session.endpoint).update('\0').update(session.accessToken).digest('hex')
  }

  private async readStatus(): Promise<MembershipState> {
    let endpoint: string
    try { endpoint = this.endpoint() } catch {
      return unavailableState('The Sotto membership service address is invalid. Free dictation is available.')
    }
    // Until a membership service exists, every build is private beta: agents stay available and nothing is billed.
    if (!endpoint) return { status: 'beta', label: 'Private beta · no paid entitlement or bundled model usage', expiresAt: null }
    if (!this.options.credentials.available()) return unavailableState('Unlock secure credential storage to verify membership. Free dictation is available.')
    try {
      if (this.pending) {
        const pendingState = await this.pollSignIn(endpoint)
        if (pendingState) return pendingState
      }
      const session = this.session(endpoint)
      if (!session) return freeState('Sign in to Sotto · free dictation is available')
      const cached = this.cached(endpoint, session)
      let receivedAuthoritativeResponse = false
      let authoritativeState: MembershipState | null = null
      try {
        const entitlement = entitlementSchema.parse(await this.request(endpoint, '/v1/entitlement', { accessToken: session.accessToken }))
        receivedAuthoritativeResponse = true
        const verifiedAt = this.now()
        const validUntil = Math.min(Date.parse(entitlement.cacheUntil), verifiedAt + MAX_OFFLINE_LEASE_MS,
          Date.parse(session.expiresAt), entitlement.status === 'active' && entitlement.expiresAt ? Date.parse(entitlement.expiresAt) : Number.POSITIVE_INFINITY)
        if (entitlement.status === 'active' && (!entitlement.expiresAt || validUntil <= verifiedAt)) {
          authoritativeState = { status: 'expired', label: 'Sotto membership needs renewal or verification. Free dictation is available.', expiresAt: entitlement.expiresAt }
          await this.options.credentials.set('membership-cache', '')
          return authoritativeState
        }
        const cache: Cache = { version: 1, endpoint, sessionFingerprint: this.fingerprint(session), verifiedAt, lastSeenAt: verifiedAt, validUntil, entitlement }
        const currentSession = this.session(endpoint)
        if (this.endpoint() !== endpoint || !currentSession || this.fingerprint(currentSession) !== cache.sessionFingerprint) {
          return unavailableState('Membership connection changed. Refresh to verify the current account.')
        }
        authoritativeState = this.stateFor(cache, false)
        await this.options.credentials.set('membership-cache', JSON.stringify(cache))
        this.invalidatedCaches.delete(cache.sessionFingerprint)
        return authoritativeState
      } catch (error) {
        if (error instanceof MembershipHttpError && (error.status === 401 || error.status === 403)) {
          await this.options.credentials.set('membership', '')
          await this.options.credentials.set('membership-cache', '')
          return freeState('Your Sotto sign-in expired. Sign in again; free dictation is available.')
        }
        // Once the service has revoked access, a cache-write failure must never
        // resurrect an older active lease. Failed persistence fails closed.
        if (receivedAuthoritativeResponse) {
          this.invalidatedCaches.add(this.fingerprint(session))
          await this.options.credentials.set('membership-cache', '').catch(() => undefined)
          return authoritativeState?.status !== 'active' && authoritativeState ? authoritativeState :
            unavailableState('Could not securely save membership verification. Free dictation is available.')
        }
        if (cached) {
          cached.lastSeenAt = this.now()
          await this.options.credentials.set('membership-cache', JSON.stringify(cached))
          return this.stateFor(cached, true)
        }
        return unavailableState('Cannot verify Sotto membership. Reconnect to the service; free dictation is available.')
      }
    } catch {
      return unavailableState('Sotto membership could not be loaded securely. Free dictation is available.')
    }
  }

  private stateFor(cache: Cache, offline: boolean): MembershipState {
    const { entitlement } = cache
    if (entitlement.status === 'free') return freeState('Free dictation · provider usage is separate from Sotto membership')
    if (entitlement.status === 'expired') return { status: 'expired', label: 'Sotto membership ended · free dictation is available', expiresAt: entitlement.expiresAt }
    if (cache.validUntil <= this.now()) return unavailableState('Membership verification expired. Connect to verify access; free dictation is available.')
    const label = offline ? `Sotto membership · offline access until ${new Date(cache.validUntil).toLocaleString()}` :
      entitlement.cancelAtPeriodEnd ? `Sotto membership · cancellation scheduled for ${new Date(entitlement.expiresAt!).toLocaleDateString()}` :
        'Sotto membership active · provider usage billed separately'
    return { status: 'active', label, expiresAt: new Date(cache.validUntil).toISOString() }
  }

  private async pollSignIn(endpoint: string): Promise<MembershipState | null> {
    const pending = this.pending!
    if (pending.endpoint !== endpoint || pending.expiresAt <= this.now()) {
      this.pending = null
      return freeState('Sotto sign-in expired. Start sign-in again.')
    }
    if (this.now() < pending.nextPollAt) return freeState(`Waiting for browser sign-in · code ${pending.userCode}`)
    pending.nextPollAt = this.now() + pending.intervalMs
    const token = tokenResponseSchema.parse(await this.request(endpoint, '/v1/device/token', { method: 'POST', body: { deviceCode: pending.deviceCode } }))
    if (token.status === 'authorized') {
      if (Date.parse(token.expiresAt) <= this.now()) throw new Error('The membership service returned an expired sign-in.')
      const session: Session = { version: 1, endpoint, accessToken: token.accessToken, expiresAt: token.expiresAt }
      await this.options.credentials.set('membership', JSON.stringify(session))
      await this.options.credentials.set('membership-cache', '')
      this.pending = null
      return null
    }
    if (token.status === 'expired' || token.status === 'denied') {
      this.pending = null
      return freeState(token.status === 'denied' ? 'Sotto sign-in was declined.' : 'Sotto sign-in expired. Start again.')
    }
    if (token.status === 'slow_down') {
      pending.intervalMs = Math.min(60_000, pending.intervalMs + 5_000)
      pending.nextPollAt = this.now() + pending.intervalMs
    }
    return freeState(`Waiting for browser sign-in · code ${pending.userCode}`)
  }

  private hostedLink(endpoint: string, value: string, allowBillingProvider: boolean): string {
    const link = new URL(value)
    const stripeOrigin = allowBillingProvider && ['https://checkout.stripe.com', 'https://billing.stripe.com'].includes(link.origin)
    if (link.protocol !== 'https:' || link.username || link.password || (link.origin !== endpoint && !stripeOrigin)) {
      throw new Error('The membership service returned an untrusted browser destination.')
    }
    return link.href
  }

  private async request(endpoint: string, path: string, options: { method?: string; body?: unknown; accessToken?: string } = {}): Promise<unknown> {
    const response = await fetch(endpoint + path, {
      method: options.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    })
    if (!response.ok) throw new MembershipHttpError(response.status)
    return response.json()
  }
}

class MembershipHttpError extends Error {
  constructor(readonly status: number) { super(`The Sotto membership service returned HTTP ${status}.`) }
}
