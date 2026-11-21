import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { UsageQuotaRead } from '../../shared/usageDashboard'
import { parseAntigravityModels, parseAntigravityQuota, unavailableProviderQuota } from './providerQuota'

/**
 * Antigravity's account limits, read the way T3 Code reads them (the research note, "Usage"): with the sign-in Sotto's
 * own `agy` saved in Sotto's app data folder, Sotto asks Google's Cloud Code hosts for the account's quota summary, and
 * for its models' quotas when the summary has none. The token is read in main, held only in memory, sent only to the
 * hosts below, and never logged or handed to a renderer, an agent or a peer; only the parsed windows leave this module.
 *
 * `agy` 1.5 keeps its sign-in in `antigravity-oauth-token` with no OAuth client, so an expired one cannot be renewed
 * here: the next Antigravity turn renews it. An older `agy` kept `acp_token.json` with its client and refresh token,
 * which is renewed at Google's token host as T3 Code does. Enterprise sign-ins kept only in the system keyring are not
 * read: Node has no keyring access without a new dependency (T3 Code uses ffi-rs and @napi-rs/keyring).
 */
export const ANTIGRAVITY_QUOTA_HOSTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'] as const
/** Where an older `agy`'s refresh token is renewed. Used only when `acp_token.json` exists. */
export const ANTIGRAVITY_TOKEN_HOST = 'https://oauth2.googleapis.com/token'
const REQUEST_TIMEOUT_MS = 10_000
/** A background read answers from a reading this recent rather than ask Google again (#1456). */
const BACKGROUND_REUSE_MS = 5 * 60_000

/** Antigravity's own client name, as T3 Code sends it; the hosts meter by client. */
export function antigravityUserAgent(platform: NodeJS.Platform, architecture: NodeJS.Architecture): string {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${architecture}; cl=963137146)`
}

const cliTokenSchema = z.object({ token: z.object({ access_token: z.string().min(1), expiry: z.string().optional() }) })
const legacyTokenSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1), refresh_token: z.string().min(1), project_id: z.string().optional() })
const refreshedSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() })

type Fetch = typeof fetch
export interface AntigravityQuotaOptions {
  /** Sotto's own `agy` app data folder, `antigravityFolders(directory).appData`. */
  readonly appData: string
  readonly fetch?: Fetch
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  readonly arch?: NodeJS.Architecture
}

type Token = { kind: 'ready'; accessToken: string; project?: string } | { kind: 'none' } | { kind: 'expired' }

export class AntigravityQuotaReader {
  private renewed: { fingerprint: string; accessToken: string; expiresAt: number } | undefined
  private last: { at: number; read: UsageQuotaRead } | undefined
  private generation = 0

  constructor(private readonly options: AntigravityQuotaOptions) {}

  /** The account's windows now, or why there are none. Never throws and never says why in native words. */
  async read(background = false, signal?: AbortSignal): Promise<UsageQuotaRead> {
    const now = this.now()
    if (background && this.last && now - this.last.at < BACKGROUND_REUSE_MS) return this.last.read
    const started = this.generation
    let result: UsageQuotaRead
    try { result = await this.readNow(signal) } catch { result = unavailableProviderQuota('antigravity', 'read-failed', true) }
    if (this.generation === started) this.last = { at: now, read: result }
    return result
  }

  /** Forgets the renewed token and the last reading, as when the user signs out. */
  clear(): void { this.renewed = undefined; this.last = undefined; this.generation++ }

  private now(): number { return (this.options.now ?? Date.now)() }
  private get fetch(): Fetch { return this.options.fetch ?? fetch }

  private async readNow(signal: AbortSignal | undefined): Promise<UsageQuotaRead> {
    const token = await this.token(signal)
    if (token.kind === 'none') return unavailableProviderQuota('antigravity', 'not-connected', true)
    // `agy` renews its own sign-in on its next turn; until then there is nothing to send.
    if (token.kind === 'expired') return unavailableProviderQuota('antigravity', 'refresh-unavailable', true)
    const ask = async (operation: string): Promise<{ value: unknown; requestedAt: number }[]> => {
      const answers = await Promise.all(ANTIGRAVITY_QUOTA_HOSTS.map(async host => {
        const requestedAt = this.now()
        try { return { value: await this.post(`${host}/v1internal:${operation}`, token, signal), requestedAt } } catch { return undefined }
      }))
      return answers.filter(answer => answer !== undefined)
    }
    const observedAt = new Date(this.now()).toISOString()
    const summaries = await ask('retrieveUserQuotaSummary')
    const summary = parseAntigravityQuota(summaries, observedAt)
    if (summary.windows.length) return summary
    const models = await ask('fetchAvailableModels')
    const fallback = parseAntigravityModels(models.map(answer => answer.value), observedAt)
    if (fallback.windows.length) return fallback
    return summaries.length || models.length ? fallback : unavailableProviderQuota('antigravity', 'read-failed', true)
  }

  private async post(url: string, token: Extract<Token, { kind: 'ready' }>, signal: AbortSignal | undefined): Promise<unknown> {
    const response = await this.fetch(url, { method: 'POST', redirect: 'manual', signal: timeout(signal),
      headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json',
        'user-agent': antigravityUserAgent(this.options.platform ?? process.platform, this.options.arch ?? process.arch) },
      body: JSON.stringify(token.project ? { project: token.project } : {}) })
    if (!response.ok) throw new Error('Antigravity quota request failed')
    return await response.json() as unknown
  }

  private async token(signal: AbortSignal | undefined): Promise<Token> {
    const legacy = await readText(join(this.options.appData, 'acp_token.json'))
    if (legacy === undefined) {
      this.renewed = undefined
      const saved = await readText(join(this.options.appData, 'antigravity-oauth-token'))
      if (saved === undefined) return { kind: 'none' }
      const parsed = cliTokenSchema.safeParse(parseJson(saved))
      if (!parsed.success) return { kind: 'none' }
      const expiry = Date.parse(parsed.data.token.expiry ?? '')
      return expiry > this.now() + 60_000 ? { kind: 'ready', accessToken: parsed.data.token.access_token } : { kind: 'expired' }
    }
    const parsed = legacyTokenSchema.safeParse(parseJson(legacy))
    if (!parsed.success) return { kind: 'none' }
    const { client_id, client_secret, refresh_token, project_id } = parsed.data
    const fingerprint = createHash('sha256').update(JSON.stringify([client_id, refresh_token, project_id ?? ''])).digest('hex')
    const project = project_id ? { project: project_id } : {}
    if (this.renewed?.fingerprint === fingerprint && this.renewed.expiresAt > this.now() + 60_000) return { kind: 'ready', accessToken: this.renewed.accessToken, ...project }
    this.renewed = undefined
    const started = this.generation
    const response = await this.fetch(ANTIGRAVITY_TOKEN_HOST, { method: 'POST', redirect: 'manual', signal: timeout(signal),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }).toString() })
    if (!response.ok) return { kind: 'expired' }
    const renewed = refreshedSchema.safeParse(await response.json() as unknown)
    if (!renewed.success) return { kind: 'expired' }
    if (this.generation === started) this.renewed = { fingerprint, accessToken: renewed.data.access_token, expiresAt: this.now() + renewed.data.expires_in * 1000 }
    return { kind: 'ready', accessToken: renewed.data.access_token, ...project }
  }
}

const timeout = (signal: AbortSignal | undefined): AbortSignal => signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch { return undefined }
}
function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}
