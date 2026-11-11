import type { AgentModel } from '../../shared/agents'
import { randomUUID } from 'node:crypto'
import { PI_SOURCES, type PiSource } from '../../shared/piSignIn'
import { signInAttemptRequestSchema, signInFinishRequestSchema, signInKeyRequestSchema, signInMethodRequestSchema, signOutRequestSchema,
  type SignInDone, type SignInResult, type SignInStart, type SignInWait } from '../../shared/opencodeSignIn'
import { PiAccounts, piAuthCommand } from './piAccounts'
import { PiLoginReader, spawnPiLogin, type PiLoginProcess, type PiLoginSpawner } from './piLogin'

export const PI_SIGN_IN_WORDS = {
  failed: 'Pi could not finish signing in. Check the account and try again. Your threads are kept.',
  unavailable: 'Pi is not available for sign-in. Install Pi and try again. Your threads are kept.',
  busy: 'Another Pi sign-in is still open. Finish or cancel it first.',
  expired: 'The Pi sign-in expired. Open the sign-in page again to start over.',
  page: 'The Pi sign-in page could not be opened. Try Open the page again.',
  gone: 'This Pi sign-in is no longer waiting. Open the sign-in page again to start over.',
  signOut: 'Pi could not confirm sign-out. Check its model sources before trying again.',
} as const
const refused = (message: string): SignInResult & { status: 'refused' } => ({ status: 'refused', message })
interface Attempt {
  id: string; source: PiSource; expiresAt: number; process?: PiLoginProcess; url?: string; code?: string | undefined
  timer?: ReturnType<typeof setTimeout>; outcome?: SignInWait; completion?: Promise<void>; stopped: boolean
}
export interface PiSignInOptions {
  changed(): Promise<void>
  modelsChanged?(models: AgentModel[]): void
  openExternal(url: string): Promise<void>
  spawn?: PiLoginSpawner
  lifetimeMs?: number
}
export class PiSignIn {
  private closed = false
  private active: Attempt | undefined
  private readonly attempts = new Map<string, Attempt>()
  constructor(readonly accounts: PiAccounts, private readonly options: PiSignInOptions) {}
  async sources() { const read = await this.accounts.read(); this.options.modelsChanged?.(read.models); return read.sources }
  private async success(attempt: Attempt): Promise<void> {
    await this.accounts.remember(attempt.source.id, true)
    await this.options.changed()
    attempt.outcome = { status: 'ok', sources: await this.sources() }
  }
  private async launch(source: PiSource, key?: string): Promise<Attempt> {
    if (this.closed) throw new Error(PI_SIGN_IN_WORDS.unavailable)
    if (this.active) throw new Error(PI_SIGN_IN_WORDS.busy)
    const attempt: Attempt = { id: randomUUID(), source, expiresAt: Date.now() + (this.options.lifetimeMs ?? 15 * 60_000), stopped: false }
    this.active = attempt; this.attempts.set(attempt.id, attempt)
    attempt.timer = setTimeout(() => {
      if (attempt.outcome) return
      attempt.outcome = { status: 'expired', message: PI_SIGN_IN_WORDS.expired }; attempt.stopped = true; attempt.process?.kill()
    }, Math.max(1, attempt.expiresAt - Date.now()))
    attempt.timer.unref()
    for (const [id, old] of this.attempts) if (this.attempts.size > 32 && old.outcome) this.attempts.delete(id)
    let pendingKey = key, keyReady = false, domainReady = false
    const writeInputs = () => {
      if (!attempt.process || attempt.stopped) return
      if (keyReady && pendingKey !== undefined) { attempt.process.write(pendingKey + '\r'); pendingKey = undefined; keyReady = false }
      if (domainReady) { attempt.process.write('\r'); domainReady = false }
    }
    const reader = new PiLoginReader(source, {
      keyPrompt: () => { keyReady = true; writeInputs() }, domain: () => { domainReady = true; writeInputs() },
      page: (url, code) => { attempt.url = url; attempt.code = code },
    })
    try {
      const program = await this.accounts.program()
      if (attempt.stopped || this.closed) throw new Error(PI_SIGN_IN_WORDS.gone)
      attempt.process = await (this.options.spawn ?? spawnPiLogin)(program, ['login', source.id, ...(key === undefined ? ['--no-browser'] : ['--api-key'])], this.accounts.directory, chunk => reader.push(chunk))
      if (attempt.stopped || this.closed) attempt.process.kill()
      else writeInputs()
      attempt.completion = attempt.process.ended.then(async ok => {
        if (ok && !attempt.stopped) await this.success(attempt)
        else if (!attempt.outcome) attempt.outcome = refused(PI_SIGN_IN_WORDS.failed)
      }).catch(() => { attempt.outcome = refused(PI_SIGN_IN_WORDS.failed) }).finally(() => { clearTimeout(attempt.timer); if (this.active === attempt) this.active = undefined })
    } catch {
      clearTimeout(attempt.timer); pendingKey = undefined; attempt.outcome = refused(PI_SIGN_IN_WORDS.unavailable)
      if (this.active === attempt) this.active = undefined
    }
    return attempt
  }
  async signInWithKey(input: unknown): Promise<SignInResult> {
    const request = signInKeyRequestSchema.safeParse(input)
    const source = request.success ? PI_SOURCES.find(source => source.id === request.data.sourceId && source.keyLabel) : undefined
    if (!source || !request.success || Array.from(request.data.key).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return refused(PI_SIGN_IN_WORDS.failed)
    if (this.active) return refused(PI_SIGN_IN_WORDS.busy)
    const attempt = await this.launch(source, request.data.key)
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([attempt.completion, new Promise<void>(resolve => { timer = setTimeout(resolve, 30_000); timer.unref() })]) }
    finally { clearTimeout(timer) }
    if (!attempt.outcome) { attempt.stopped = true; attempt.process?.kill(); await attempt.completion }
    this.attempts.delete(attempt.id)
    const outcome = attempt.outcome
    return outcome?.status === 'ok' || outcome?.status === 'refused' ? outcome : refused(PI_SIGN_IN_WORDS.failed)
  }
  async startBrowserSignIn(input: unknown): Promise<SignInStart> {
    const request = signInMethodRequestSchema.safeParse(input)
    const source = request.success ? PI_SOURCES.find(source => source.id === request.data.sourceId && source.oauthLabel && request.data.methodId === 'browser') : undefined
    if (!source) return refused(PI_SIGN_IN_WORDS.failed)
    if (this.active) return refused(PI_SIGN_IN_WORDS.busy)
    const attempt = await this.launch(source)
    const deadline = Date.now() + 20_000
    while (!attempt.url && !attempt.outcome && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    if (!attempt.url || attempt.outcome) { await this.cancel({ attemptId: attempt.id }); return refused(PI_SIGN_IN_WORDS.failed) }
    return { status: 'waiting', attempt: { id: attempt.id, sourceId: source.id, mode: source.mode ?? 'auto', page: new URL(attempt.url).hostname,
      expiresAt: attempt.expiresAt, ...(attempt.code ? { code: attempt.code } : {}) } }
  }
  async wait(input: unknown): Promise<SignInWait> {
    const request = signInAttemptRequestSchema.safeParse(input), attempt = request.success ? this.attempts.get(request.data.attemptId) : undefined
    if (!attempt) return refused(PI_SIGN_IN_WORDS.gone)
    if (!attempt.outcome && Date.now() >= attempt.expiresAt) {
      attempt.outcome = { status: 'expired', message: PI_SIGN_IN_WORDS.expired }; attempt.stopped = true; attempt.process?.kill()
    }
    if (attempt.outcome) { this.attempts.delete(attempt.id); return attempt.outcome }
    return { status: 'pending' }
  }
  async finish(input: unknown): Promise<SignInWait> {
    const request = signInFinishRequestSchema.safeParse(input), attempt = request.success ? this.attempts.get(request.data.attemptId) : undefined
    if (!request.success || !attempt || attempt.source.mode !== 'code' || Array.from(request.data.code).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return refused(PI_SIGN_IN_WORDS.gone)
    const state = await this.wait({ attemptId: attempt.id })
    if (state.status !== 'pending') return state
    attempt.process?.write(request.data.code + '\r')
    return { status: 'pending' }
  }
  async reopenPage(input: unknown): Promise<SignInDone> {
    const request = signInAttemptRequestSchema.safeParse(input), attempt = request.success ? this.attempts.get(request.data.attemptId) : undefined
    if (!attempt?.url || attempt.outcome || attempt.expiresAt <= Date.now()) return refused(PI_SIGN_IN_WORDS.gone)
    try { await this.options.openExternal(attempt.url); return { status: 'ok' } }
    catch { return { status: 'not-opened', message: PI_SIGN_IN_WORDS.page, address: attempt.url } }
  }
  async cancel(input: unknown): Promise<SignInDone> {
    const request = signInAttemptRequestSchema.safeParse(input), attempt = request.success ? this.attempts.get(request.data.attemptId) : undefined
    if (attempt) { attempt.stopped = true; attempt.process?.kill(); await attempt.completion; this.attempts.delete(attempt.id) }
    return { status: 'ok' }
  }
  async signOut(input: unknown): Promise<SignInResult> {
    const request = signOutRequestSchema.safeParse(input)
    if (!request.success || !PI_SOURCES.some(source => source.id === request.data.sourceId)) return refused(PI_SIGN_IN_WORDS.signOut)
    if (this.active) return refused(PI_SIGN_IN_WORDS.busy)
    try {
      const result = await piAuthCommand(await this.accounts.program(), ['logout', request.data.sourceId])
      const check = await this.accounts.check(request.data.sourceId)
      if (!result.success || check.status !== 'not_ready' || check.reason !== 'credentials_not_configured') return refused(PI_SIGN_IN_WORDS.signOut)
      await this.accounts.remember(request.data.sourceId, false); await this.options.changed()
      return { status: 'ok', sources: await this.sources() }
    } catch { return refused(PI_SIGN_IN_WORDS.signOut) }
  }
  async close(): Promise<void> {
    this.closed = true
    const results = await Promise.allSettled([...this.attempts.values()].map(attempt => this.cancel({ attemptId: attempt.id })))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
