import { z } from 'zod'
import {
  SIGN_IN_WORDS, signInAttemptRequestSchema, signInFinishRequestSchema, signInKeyRequestSchema, signInMethodRequestSchema, signOutRequestSchema,
  type ModelSources, type SignInDone, type SignInPage, type SignInResult, type SignInStart, type SignInWait,
} from '../../shared/opencodeSignIn'
import { locationQuery, OpenCodeRejected, type OpenCodeClient } from './opencodeClient'
import { OpenCodeUncertain } from './opencodeServer'
import { attemptOf, attemptReplySchema, attemptStatusSchema, credentialsOf, hiddenAnswers, integrationListSchema, KEY_METHOD, modelSourcesOf, safeSignInPage, type Integration } from './opencodeSources'

/** Stable event names a sign-in is logged by. No key, code, address or answer from OpenCode ever reaches a log. */
export type OpenCodeSignInEvent = 'opencode-sign-in-key' | 'opencode-sign-in-browser-started' | 'opencode-sign-in-complete' | 'opencode-sign-in-cancelled'
  | 'opencode-sign-in-expired' | 'opencode-sign-in-failed' | 'opencode-sign-out' | 'opencode-sign-in-unavailable'

/** The server a sign-in runs on: one of Sotto's own OpenCode servers, on Sotto's OpenCode folder (ADR-0087). */
export interface SignInServer { readonly client: OpenCodeClient; readonly closed: Promise<void>; stop(): Promise<void> }
export interface OpenCodeSignInOptions {
  /** Starts a short-lived server; rejects when OpenCode is not connected or cannot start. */
  readonly start: () => Promise<SignInServer>
  /** The folder every request names as its location. */
  readonly location: string
  /**
   * After a sign-in or sign-out: every thread server is outdated, and the catalog is read again on this server so the model
   * menu has what changed. Rejects when the catalog could not be read; the thread servers move on regardless.
   */
  readonly changed: (client: OpenCodeClient) => Promise<void>
  /** Opens an https page in the user's own browser, from main. */
  readonly openExternal: (url: string) => Promise<void>
  readonly log?: ((event: OpenCodeSignInEvent) => void) | undefined
  /** How long the server stays up after its last use while nothing waits on it. */
  readonly idleMs?: number
  readonly now?: () => number
}

const modelListSchema = z.looseObject({ data: z.array(z.looseObject({ providerID: z.string(), enabled: z.boolean().optional(), status: z.string().optional() })) })
const providerListSchema = z.looseObject({ data: z.array(z.looseObject({ id: z.string(), integrationID: z.string().optional() })) })
interface Attempt { readonly sourceId: string; readonly name: string; readonly url: string; readonly server: SignInServer; readonly expiresAt: number }
/** How long a waiting sign-in that OpenCode gave no expiry for keeps the server up. */
const UNTIMED_ATTEMPT_MS = 30 * 60_000

/**
 * Signing Sotto's OpenCode in to model sources, and out again (#1104). Every call runs on one short-lived server of
 * Sotto's own, started on first use and stopped once nothing has used it for a while and no browser sign-in waits on it,
 * since OpenCode keeps a waiting sign-in in that server's memory. A key passes through here once, to that server, and
 * is never kept, logged or returned; credential lists, which carry secrets, are never read.
 */
export class OpenCodeSignIn {
  private server: Promise<SignInServer> | undefined
  private readonly attempts = new Map<string, Attempt>()
  private integrations = new Map<string, Integration>()
  /** The sources signed in at the last read, to notice a sign-in OpenCode finished with nobody waiting on it. */
  private signedIn: string | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private busy = 0
  private closed = false
  /** A new client is on disk, and the server still runs the old one until nothing needs it. */
  private outdated = false
  constructor(private readonly options: OpenCodeSignInOptions) {}

  private get location(): Record<string, string> { return locationQuery(this.options.location) }
  private log(event: OpenCodeSignInEvent): void { this.options.log?.(event) }

  /** Runs `work` on the server, starting it when there is none. A server that cannot start is "not running". */
  private async use<T>(work: (server: SignInServer) => Promise<T>, refused: (message: string) => T): Promise<T> {
    if (this.closed) return refused(SIGN_IN_WORDS.notRunning)
    this.busy += 1
    clearTimeout(this.idle)
    try {
      let server: SignInServer
      try { server = await this.acquire() } catch { this.log('opencode-sign-in-unavailable'); return refused(SIGN_IN_WORDS.notRunning) }
      return await work(server)
    } finally { this.busy -= 1; this.rest() }
  }
  private acquire(): Promise<SignInServer> {
    if (!this.server) {
      const starting = this.options.start()
      this.server = starting
      starting.then(server => {
        void server.closed.then(() => {
          if (this.server !== starting) return
          this.server = undefined; this.outdated = false
          for (const [id, attempt] of this.attempts) if (attempt.server === server) this.attempts.delete(id)
        })
      }, () => { if (this.server === starting) this.server = undefined })
    }
    return this.server
  }
  /**
   * Stops the server once it has been idle for a while, unless a browser sign-in still waits on it. A sign-in nobody asks
   * after, such as one whose window was reloaded, stops holding it once its page has expired.
   */
  private rest(): void {
    clearTimeout(this.idle)
    if (this.busy || !this.server) return
    const now = (this.options.now ?? Date.now)()
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(id)
    if (this.outdated && !this.attempts.size) { void this.stop(); return }
    const idleMs = this.options.idleMs ?? 60_000
    const waitMs = this.attempts.size ? Math.max(idleMs, Math.min(...[...this.attempts.values()].map(attempt => attempt.expiresAt - now))) : idleMs
    this.idle = setTimeout(() => { if (this.busy) return; if (this.attempts.size) this.rest(); else void this.stop() }, Math.min(waitMs, 2_147_483_647))
    this.idle.unref?.()
  }
  private async stop(): Promise<void> {
    const server = this.server
    this.server = undefined; this.attempts.clear(); this.outdated = false
    await server?.then(running => running.stop(), () => undefined)
  }
  /** Stops everything: the server and any sign-in waiting on it. A disconnect or a quit calls this. */
  async close(): Promise<void> { clearTimeout(this.idle); await this.stop() }
  /**
   * A new client is on disk (ADR-0042): the server moves to it at once when nothing uses it, and otherwise once nothing
   * does and no browser sign-in waits on it, since OpenCode keeps a waiting sign-in in that server's memory (ADR-0038).
   */
  renew(): void { if (!this.server) return; this.outdated = true; this.rest() }
  /** OpenCode was connected again: sign-ins may run once more. */
  reopen(): void { this.closed = false }
  /** OpenCode was disconnected: nothing runs until it connects again. */
  async shut(): Promise<void> { this.closed = true; await this.close() }

  private async read(server: SignInServer): Promise<ModelSources & { status: 'ok' }> {
    const [list, models, providers] = await Promise.all([
      server.client.request('GET', '/api/integration', { query: this.location }).then(value => integrationListSchema.parse(value).data),
      server.client.request('GET', '/api/model', { query: this.location }).then(value => modelListSchema.parse(value).data),
      server.client.request('GET', '/api/provider', { query: this.location }).then(value => providerListSchema.parse(value).data).catch(() => []),
    ])
    this.integrations = new Map(list.map(integration => [integration.id, integration]))
    const integrationOf = new Map(providers.map(provider => [provider.id, provider.integrationID ?? provider.id]))
    const shown = models.filter(model => model.enabled !== false && model.status !== 'deprecated')
    // Zen's free models are counted under their own provider; every other model under the source that signs it in.
    const counted = shown.map(model => model.providerID === 'opencode' ? 'opencode' : integrationOf.get(model.providerID) ?? model.providerID)
    const sources = modelSourcesOf(list, counted)
    this.signedIn = sources.sources.filter(source => source.signedIn).map(source => source.id).sort().join(' ')
    return { status: 'ok', ...sources }
  }
  /** The answer once the sign-ins changed: the sources as they are now, and words for a model list that was not read again. */
  private async afterChange(server: SignInServer): Promise<{ status: 'ok'; sources: ModelSources; warning?: string }> {
    const read = await this.options.changed(server.client).then(() => true, () => false)
    const sources = await this.read(server).catch((): ModelSources => ({ status: 'refused', message: SIGN_IN_WORDS.notRunning }))
    return { status: 'ok', sources, ...(read ? {} : { warning: SIGN_IN_WORDS.catalogUnread }) }
  }
  /** The integration a request names, from the last list read, reading again when it is not there. */
  private async integration(server: SignInServer, sourceId: string): Promise<Integration | undefined> {
    if (!this.integrations.has(sourceId)) await this.read(server).catch(() => undefined)
    return this.integrations.get(sourceId)
  }

  /**
   * The sources as OpenCode has them now. A browser sign-in OpenCode finished after its dialog closed changed them with
   * nobody reading the result, so a change since the last read moves the threads to it as any sign-in does.
   */
  sources(): Promise<ModelSources> {
    return this.use(async server => {
      const before = this.signedIn
      let now: ModelSources
      try { now = await this.read(server) } catch { return { status: 'refused', message: SIGN_IN_WORDS.notRunning } }
      if (before === undefined || before === this.signedIn) return now
      return (await this.afterChange(server)).sources
    }, message => ({ status: 'refused', message }))
  }

  signInWithKey(request: unknown): Promise<SignInResult> {
    const { sourceId, key, answer } = signInKeyRequestSchema.parse(request)
    const trimmed = key.trim()
    return this.use(async server => {
      const integration = await this.integration(server, sourceId)
      if (!integration) return { status: 'refused', message: SIGN_IN_WORDS.unknownSource }
      // OpenCode 2.0.31 takes an empty key without a word, so an empty one is refused here.
      if (!trimmed) return { status: 'refused', message: SIGN_IN_WORDS.keyRefused(integration.name) }
      const merged = { ...(answer ?? {}), ...hiddenAnswers(integration, KEY_METHOD) }
      try {
        await server.client.request('POST', `/api/integration/${encodeURIComponent(sourceId)}/connect/key`,
          { query: this.location, body: { key: trimmed, ...(Object.keys(merged).length ? { answer: merged } : {}) } })
      } catch (error) {
        if (error instanceof OpenCodeRejected && error.status < 500) {
          this.log('opencode-sign-in-failed')
          if (error.status === 404) return { status: 'refused', message: SIGN_IN_WORDS.unknownSource }
          if (error.status === 400 && answer && Object.keys(answer).length) return { status: 'refused', message: SIGN_IN_WORDS.formRefused(integration.name) }
          return { status: 'refused', message: SIGN_IN_WORDS.keyRefused(integration.name) }
        }
        if (!(error instanceof OpenCodeUncertain || error instanceof OpenCodeRejected)) throw error
        // No answer, or a server error: OpenCode may have saved the key all the same, so its sign-ins are read again.
        let saved: boolean
        try {
          const now = await this.read(server)
          saved = now.sources.some(source => source.id === sourceId && source.signedIn !== undefined)
        } catch {
          this.log('opencode-sign-in-failed')
          return { status: 'refused', message: SIGN_IN_WORDS.keyUnknown(integration.name) }
        }
        if (!saved) { this.log('opencode-sign-in-failed'); return { status: 'refused', message: SIGN_IN_WORDS.keyNotSaved(integration.name) } }
      }
      this.log('opencode-sign-in-key')
      return await this.afterChange(server)
    }, message => ({ status: 'refused', message }))
  }

  useExternalSignIn(request: unknown): Promise<SignInResult> {
    const { sourceId, methodId, answer } = signInMethodRequestSchema.parse(request)
    return this.use(async server => {
      const integration = await this.integration(server, sourceId)
      if (!integration) return { status: 'refused', message: SIGN_IN_WORDS.unknownSource }
      const merged = { ...(answer ?? {}), ...hiddenAnswers(integration, methodId) }
      try {
        await server.client.request('POST', `/api/integration/${encodeURIComponent(sourceId)}/connect/external`,
          { query: this.location, body: { methodID: methodId, ...(Object.keys(merged).length ? { answer: merged } : {}) } })
      } catch (error) {
        this.log('opencode-sign-in-failed')
        return { status: 'refused', message: error instanceof OpenCodeRejected && error.status === 400 ? SIGN_IN_WORDS.formRefused(integration.name) : SIGN_IN_WORDS.failed(integration.name) }
      }
      this.log('opencode-sign-in-complete')
      return await this.afterChange(server)
    }, message => ({ status: 'refused', message }))
  }

  startBrowserSignIn(request: unknown): Promise<SignInStart> {
    const { sourceId, methodId, answer } = signInMethodRequestSchema.parse(request)
    return this.use(async server => {
      const integration = await this.integration(server, sourceId)
      if (!integration) return { status: 'refused', message: SIGN_IN_WORDS.unknownSource }
      const merged = { ...(answer ?? {}), ...hiddenAnswers(integration, methodId) }
      let reply
      try {
        reply = attemptReplySchema.parse(await server.client.request('POST', `/api/integration/${encodeURIComponent(sourceId)}/connect/oauth`,
          { query: this.location, body: { methodID: methodId, ...(Object.keys(merged).length ? { answer: merged } : {}) } })).data
      } catch (error) {
        this.log('opencode-sign-in-failed')
        return { status: 'refused', message: error instanceof OpenCodeRejected && error.status === 400 ? SIGN_IN_WORDS.formRefused(integration.name) : SIGN_IN_WORDS.startFailed(integration.name) }
      }
      if (!safeSignInPage(reply.url)) {
        await this.cancelNative(server, sourceId, reply.attemptID)
        this.log('opencode-sign-in-failed')
        return { status: 'refused', message: SIGN_IN_WORDS.unsafePage }
      }
      const attempt = attemptOf(sourceId, reply)
      const now = (this.options.now ?? Date.now)()
      // OpenCode's own clock says when its page expires; a little past it, Sotto stops waiting on it.
      const expiresAt = attempt.expiresAt !== undefined && attempt.expiresAt > now ? attempt.expiresAt + 60_000 : now + UNTIMED_ATTEMPT_MS
      this.attempts.set(attempt.id, { sourceId, name: integration.name, url: reply.url, server, expiresAt })
      this.log('opencode-sign-in-browser-started')
      // The page opens when the dialog asks for it with `reopenPage`, so a dialog closed while this started opens none.
      return { status: 'waiting', attempt }
    }, message => ({ status: 'refused', message }))
  }

  /** Where a browser sign-in stands. A finished one reads the catalog again; an ended one is forgotten. */
  wait(request: unknown): Promise<SignInWait> {
    const { attemptId } = signInAttemptRequestSchema.parse(request)
    return this.settle(attemptId, undefined)
  }
  /** Hands OpenCode the code its page showed, then says where the sign-in stands. */
  finish(request: unknown): Promise<SignInWait> {
    const { attemptId, code } = signInFinishRequestSchema.parse(request)
    return this.settle(attemptId, code.trim())
  }
  private async settle(attemptId: string, code: string | undefined): Promise<SignInWait> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return { status: 'refused', message: SIGN_IN_WORDS.notRunning }
    return this.use(async server => {
      if (server !== attempt.server) { this.attempts.delete(attemptId); return { status: 'refused', message: SIGN_IN_WORDS.failed(attempt.name) } }
      const path = `/api/integration/${encodeURIComponent(attempt.sourceId)}/connect/oauth/${encodeURIComponent(attemptId)}`
      if (code !== undefined) {
        if (!code) return { status: 'refused', reason: 'code-refused', message: SIGN_IN_WORDS.codeRefused(attempt.name) }
        try { await server.client.request('POST', `${path}/complete`, { query: this.location, body: { code } }) } catch (error) {
          if (!(error instanceof OpenCodeRejected) || error.status !== 404) {
            this.log('opencode-sign-in-failed')
            return { status: 'refused', reason: 'code-refused', message: SIGN_IN_WORDS.codeRefused(attempt.name) }
          }
        }
      }
      let status: string
      try { status = attemptStatusSchema.parse(await server.client.request('GET', path, { query: this.location })).data.status } catch (error) {
        if (error instanceof OpenCodeRejected && error.status === 404) status = 'missing'
        else return { status: 'pending' }
      }
      if (status === 'pending') return { status: 'pending' }
      this.attempts.delete(attemptId)
      if (status === 'complete') { this.log('opencode-sign-in-complete'); return await this.afterChange(server) }
      if (status === 'expired') { this.log('opencode-sign-in-expired'); return { status: 'expired', message: SIGN_IN_WORDS.expired(attempt.name) } }
      this.log('opencode-sign-in-failed')
      return { status: 'refused', message: SIGN_IN_WORDS.failed(attempt.name) }
    }, message => ({ status: 'refused', message }))
  }
  /**
   * Opens a waiting sign-in's page in the user's browser, from main: first once the dialog has the sign-in, then each time
   * it asks again. A browser that does not open answers with the page's address, to open by hand; the sign-in waits on.
   */
  async reopenPage(request: unknown): Promise<SignInDone> {
    const page = await this.pageAddress(request)
    if (page.status !== 'ok') return page
    try { await this.options.openExternal(page.address); return { status: 'ok' } } catch {
      return { status: 'not-opened', message: SIGN_IN_WORDS.pageNotOpened, address: page.address }
    }
  }
  /**
   * A waiting sign-in's page address, which only https pages ever are, for main to open. A host has no browser, so it
   * answers a desktop's `page` with this, and the desktop opens it in its own (#1107, ADR-0037).
   */
  async pageAddress(request: unknown): Promise<SignInPage> {
    const { attemptId } = signInAttemptRequestSchema.parse(request)
    const attempt = this.attempts.get(attemptId)
    return attempt ? { status: 'ok', address: attempt.url } : { status: 'refused', message: SIGN_IN_WORDS.notRunning }
  }
  /** Stops a waiting browser sign-in. One its page finished just before is OpenCode's now, so it is followed as finished. */
  async cancel(request: unknown): Promise<SignInDone> {
    const { attemptId } = signInAttemptRequestSchema.parse(request)
    const attempt = this.attempts.get(attemptId)
    if (!attempt) return { status: 'ok' }
    this.attempts.delete(attemptId)
    const path = `/api/integration/${encodeURIComponent(attempt.sourceId)}/connect/oauth/${encodeURIComponent(attemptId)}`
    const finished = await attempt.server.client.request('GET', path, { query: this.location })
      .then(value => attemptStatusSchema.parse(value).data.status === 'complete', () => false)
    if (finished) {
      this.log('opencode-sign-in-complete')
      await this.use(server => this.afterChange(server), () => undefined)
      return { status: 'ok' }
    }
    await this.cancelNative(attempt.server, attempt.sourceId, attemptId)
    this.log('opencode-sign-in-cancelled')
    this.rest()
    return { status: 'ok' }
  }
  private async cancelNative(server: SignInServer, sourceId: string, attemptId: string): Promise<void> {
    await server.client.request('DELETE', `/api/integration/${encodeURIComponent(sourceId)}/connect/oauth/${encodeURIComponent(attemptId)}`, { query: this.location }).catch(() => undefined)
  }

  /** Signs out of a source: every credential Sotto's OpenCode holds for it is deleted, then the catalog is read again. */
  signOut(request: unknown): Promise<SignInResult> {
    const { sourceId } = signOutRequestSchema.parse(request)
    return this.use(async server => {
      await this.read(server).catch(() => undefined)
      const integration = this.integrations.get(sourceId)
      if (!integration) return { status: 'refused', message: SIGN_IN_WORDS.unknownSource }
      let deleted = 0
      try {
        for (const credential of credentialsOf(integration)) { await server.client.request('DELETE', `/api/credential/${encodeURIComponent(credential)}`); deleted += 1 }
      } catch {
        this.log('opencode-sign-in-failed')
        if (!deleted) return { status: 'refused', message: SIGN_IN_WORDS.signOutFailed(integration.name) }
        // Some of its sign-ins are gone, so the threads move to what is left, and the list says whether any is.
        const after = await this.afterChange(server)
        const gone = after.sources.status === 'ok' && !after.sources.sources.some(source => source.id === sourceId && source.signedIn)
        if (!gone) return { status: 'refused', message: SIGN_IN_WORDS.signOutFailed(integration.name) }
        this.log('opencode-sign-out')
        return after
      }
      this.log('opencode-sign-out')
      return await this.afterChange(server)
    }, message => ({ status: 'refused', message }))
  }
}
