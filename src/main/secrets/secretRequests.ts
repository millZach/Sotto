import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AgentRequest } from '../../shared/agents'
import {
  SECRET_KEEP_MS, SECRET_REQUEST_DEFAULT_WAIT_MS, SECRET_REQUEST_ID_PREFIX, SECRET_REQUEST_MAX_WAIT_MS, SECRET_REF_PATTERN, secretRequestFields,
  type RequestSecretInput, type SecretRequestCard, type SecretRequestField, type SecretSite,
} from '../../shared/secretRequests'
import type { SottoThreadRequests } from '../agents/sottoRequests'

/** How a card ended for its agent: saved (with what it gets), declined, closed with its call or thread, or not answered. */
export type SecretOutcome =
  | { readonly status: 'saved'; readonly delivery: 'secretRef'; readonly refs: Readonly<Record<string, string>>; readonly site: string | null }
  | { readonly status: 'saved'; readonly delivery: 'file'; readonly files: Readonly<Record<string, string>> }
  | { readonly status: 'declined' | 'cancelled' | 'timed_out' }

/** What bounds one card beyond its own wait: the call it is for, and how long that call's client will wait. */
export interface SecretWait {
  readonly signal?: AbortSignal
  readonly waitMs?: number
}

interface Waiting {
  readonly threadId: string
  readonly request: AgentRequest
  readonly fields: readonly SecretRequestField[]
  readonly delivery: 'secretRef' | 'file'
  /** The origin of the card's sign-in page, or null when it named none. */
  readonly site: string | null
  readonly settle: (outcome: SecretOutcome) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly release: () => void
  saving: boolean
}

/** A value kept for its agent, by reference or as a file. Values live in this process's memory and nowhere else. */
interface Kept { readonly threadId: string; readonly expiresAt: number; readonly timer: ReturnType<typeof setTimeout> }
/**
 * `site` is the origin of the card's sign-in page: Sotto's browser types the value only on a page at that origin, and
 * asks the user every time when the card named none (ADR-0219, decision 7).
 */
interface KeptRef extends Kept { readonly value: string; readonly site: string | null }

export interface SecretRequestOptions {
  /** Sotto's own folder: secret files go in `secret-files` inside it. */
  readonly directory: string
  /** Whether a thread is still open: not settled, archived or gone. A closed thread's cards and values go. */
  readonly open?: (threadId: string) => boolean
  readonly now?: () => number
  /** How long a saved value is kept unless it is used or let go first. */
  readonly keepMs?: number
  /**
   * Makes the folder readable by the signed-in user alone. Windows ignores a file's mode, so there the folder's inherited
   * entries are replaced by one for the user (`icacls`); elsewhere the folder's mode does it. Best effort: a failure
   * leaves the folder as the user's profile already keeps it.
   */
  readonly protect?: (folder: string) => Promise<void>
}

/** Replaces the folder's inherited permissions with full control for the signed-in user only. Windows only. */
export function protectOnWindows(folder: string): Promise<void> {
  const user = process.env.USERNAME
  if (process.platform !== 'win32' || !user) return Promise.resolve()
  const domain = process.env.USERDOMAIN
  return new Promise(done => {
    execFile('icacls', [folder, '/inheritance:r', '/grant:r', `${domain ? `${domain}\\` : ''}${user}:(OI)(CI)F`], { windowsHide: true, timeout: 10_000 }, () => done())
  })
}

/**
 * Deletes the secret files a Sotto that stopped without closing left in `directory` (ADR-0219). Run at every start,
 * with secret requests on or off, so turning the feature off never strands a value on disk until it is on again.
 */
export async function sweepSecretFiles(directory: string): Promise<void> {
  await rm(join(directory, 'secret-files'), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
}

const DECLINED = new Error('Enter the values on the card in Sotto on your computer, or decline it there.')
const CLOSING = 'Sotto is closing. Nothing was kept.'

/** A field's value as the card sent it: its own property only, so a field named like `toString` is never the object's. */
const fieldValue = (values: Readonly<Record<string, string>>, name: string): string => {
  const value: unknown = Object.hasOwn(values, name) ? values[name] : undefined
  return typeof value === 'string' ? value : ''
}
/** Deletes a file now. On the way out a promise may never run, so a secret file is never left to one. */
const removeNow = (file: string): void => { try { rmSync(file, { force: true }) } catch { /* Swept at the next start. */ } }

/**
 * Secret requests waiting on the user, and the values the user gave (ADR-0219). Each card is one of Sotto's own
 * requests in its thread, so it shows where a permission does, counts in Needs you and reaches a paired phone, which
 * can only decline it: the values are typed on this computer and come in on the window's own channel, never as a
 * request's answer, so no provider, event, log or notification ever holds one. A saved value is kept in this process's
 * memory behind a one-use secret reference, or written to a file in a folder only the user can read; either goes when
 * it is used or let go, when it expires, when its thread closes and when Sotto closes. Nothing survives a restart:
 * the folder is emptied at start.
 */
export class SecretRequests implements SottoThreadRequests {
  private readonly waiting = new Map<string, Waiting>()
  private readonly refs = new Map<string, KeptRef>()
  private readonly files = new Map<string, Kept>()
  private readonly listeners = new Set<() => void>()
  private shown: ReadonlyMap<string, readonly AgentRequest[]> = new Map()
  private closed = false
  private checking = false
  private prepared: Promise<string> | undefined
  constructor(private readonly options: SecretRequestOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now() }
  private get folder(): string { return join(this.options.directory, 'secret-files') }

  /** Empties the folder of files a Sotto that is no longer running left behind: nothing it holds survives a restart. */
  async sweep(): Promise<void> { await sweepSecretFiles(this.options.directory) }

  /** Shows the card and waits for the user. Resolves once: saved, declined, cancelled or timed out. */
  ask(threadId: string, input: RequestSecretInput, wait: SecretWait = {}): Promise<SecretOutcome> {
    if (this.closed || wait.signal?.aborted || this.options.open?.(threadId) === false) return Promise.resolve({ status: 'cancelled' })
    const id = `${SECRET_REQUEST_ID_PREFIX}${randomUUID()}`
    const fields = secretRequestFields(input)
    const delivery = input.delivery ?? 'secretRef'
    const waitMs = Math.max(1_000, Math.min(input.timeoutMs ?? SECRET_REQUEST_DEFAULT_WAIT_MS, SECRET_REQUEST_MAX_WAIT_MS, wait.waitMs ?? Infinity))
    const url = input.url && /^https?:\/\//iu.test(input.url) ? safeUrl(input.url) : undefined
    const card: SecretRequestCard = { label: input.label, reason: input.reason, fields, ...(url ? { url } : {}), delivery, expiresAt: this.now() + waitMs }
    const request: AgentRequest = {
      id, kind: 'permission',
      // A client that knows nothing of the card shows these words and Decline: the values are typed on the computer.
      text: `${input.label}: ${input.reason}\nThe agent asks for ${fields.length === 1 ? 'a value' : `${fields.length} values`} ${delivery === 'file' ? `its commands read from ${fields.length === 1 ? 'a file' : 'files'}, and it is told never to print ${fields.length === 1 ? 'it' : 'them'}` : 'it will not see'}. Enter ${fields.length === 1 ? 'it' : 'them'} in Sotto on the computer, or decline here.`,
      options: [],
      permissionChoices: [{ id: 'decline', label: 'Decline', kind: 'deny' }],
      context: { toolName: 'Sotto', action: input.label },
      secretRequest: card,
      since: new Date(this.now()).toISOString(),
    }
    return new Promise(resolveOutcome => {
      const timer = setTimeout(() => this.end(id, { status: 'timed_out' }), waitMs)
      timer.unref?.()
      const gone = (): void => { this.end(id, { status: 'cancelled' }) }
      wait.signal?.addEventListener('abort', gone, { once: true })
      this.waiting.set(id, { threadId, request, fields, delivery, site: url ? new URL(url).origin : null, settle: resolveOutcome, timer, release: () => { wait.signal?.removeEventListener('abort', gone) }, saving: false })
      this.changed()
    })
  }

  /** The coordinator reads this on every publication: it is when waiting cards look at their threads, once it is over. */
  requests(): ReadonlyMap<string, readonly AgentRequest[]> {
    if ((this.waiting.size > 0 || this.refs.size > 0 || this.files.size > 0) && !this.checking && this.options.open) {
      this.checking = true
      queueMicrotask(() => { this.checking = false; this.stopClosed() })
    }
    return this.shown
  }

  /** Every card, value and file of a thread that is no longer open goes. */
  stopClosed(): void {
    const open = this.options.open
    if (!open) return
    const still = (threadId: string): boolean => { try { return open(threadId) } catch { return false } }
    const closed = new Set<string>()
    for (const entry of [...this.waiting.values(), ...this.refs.values(), ...this.files.values()]) if (!still(entry.threadId)) closed.add(entry.threadId)
    if (closed.size) this.forgetThreads([...closed])
  }

  /**
   * A request's answer through the coordinator: only Decline. A paired phone, and any client that knows nothing of the
   * card, answers this way; the values come only from this computer's window, on its own channel.
   */
  answer(threadId: string, requestId: string, approved: boolean): void {
    const waiting = this.waiting.get(requestId)
    if (!waiting || waiting.threadId !== threadId) throw new Error('This request is no longer pending. Refresh the thread.')
    if (approved) throw DECLINED
    this.end(requestId, { status: 'declined' })
  }

  /** The user pressed Decline on the card. */
  decline(threadId: string, requestId: string): void { this.answer(threadId, requestId, false) }

  /**
   * The user saved the card. Every field needs a value; the values are kept for the agent as references or written to
   * files, and the agent's call is answered with those alone. Throws in words the card shows when nothing was saved.
   */
  async save(threadId: string, requestId: string, values: Readonly<Record<string, string>>): Promise<void> {
    const waiting = this.waiting.get(requestId)
    if (!waiting || waiting.threadId !== threadId) throw new Error('This request is no longer waiting. The agent may have stopped; nothing was saved.')
    if (waiting.saving) throw new Error('This card is already being saved.')
    for (const field of waiting.fields) if (!fieldValue(values, field.name).trim()) throw new Error(`Enter ${field.label}, or decline the card.`)
    waiting.saving = true
    const expiresAt = this.now() + (this.options.keepMs ?? SECRET_KEEP_MS)
    try {
      if (waiting.delivery === 'secretRef') {
        // Without a prototype, a field named like `constructor` or `__proto__` is a key like any other.
        const refs = Object.create(null) as Record<string, string>
        for (const field of waiting.fields) refs[field.name] = this.keepRef(threadId, fieldValue(values, field.name), expiresAt, waiting.site)
        if (!this.end(requestId, { status: 'saved', delivery: 'secretRef', refs, site: waiting.site })) { for (const ref of Object.values(refs)) this.dropRef(ref); throw new Error('The agent stopped waiting before the card was saved. Nothing was kept.') }
        return
      }
      const files = Object.create(null) as Record<string, string>
      try { for (const field of waiting.fields) files[field.name] = await this.keepFile(threadId, fieldValue(values, field.name), expiresAt) }
      catch (error) { for (const file of Object.values(files)) this.dropFile(file); throw error }
      if (!this.end(requestId, { status: 'saved', delivery: 'file', files })) { for (const file of Object.values(files)) this.dropFile(file); throw new Error('The agent stopped waiting before the card was saved. Nothing was kept.') }
    } finally { const still = this.waiting.get(requestId); if (still) still.saving = false }
  }

  /**
   * One use of a reference by one of Sotto's own tools in the thread it was given to: the value, once, and the
   * reference is gone. Null for a reference that is unknown, used, expired or another thread's.
   */
  take(threadId: string, ref: string): string | null {
    const kept = this.kept(threadId, ref)
    if (!kept) return null
    this.dropRef(ref)
    return kept.expiresAt >= this.now() ? kept.value : null
  }

  /**
   * The site a reference's card named, so a tool can check where the value would go before it takes it: the reference
   * is not used. Null for one that is unknown, used, expired or another thread's.
   */
  site(threadId: string, ref: string): SecretSite | null {
    const kept = this.kept(threadId, ref)
    return kept && kept.expiresAt >= this.now() ? { origin: kept.site } : null
  }

  /** The agent is done with these: each of its own references and files goes now. Returns how many went. */
  release(threadId: string, request: { readonly secretRefs?: readonly string[] | undefined; readonly files?: readonly string[] | undefined }): number {
    let released = 0
    for (const ref of request.secretRefs ?? []) if (this.refs.get(ref)?.threadId === threadId) { this.dropRef(ref); released++ }
    for (const given of request.files ?? []) {
      const file = resolve(given)
      if (this.files.get(file)?.threadId === threadId) { this.dropFile(file); released++ }
    }
    return released
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Deleted, settled or archived threads take their cards, references and files with them. */
  forgetThreads(threadIds: readonly string[]): void {
    const gone = new Set(threadIds)
    for (const [id, waiting] of [...this.waiting]) if (gone.has(waiting.threadId)) this.end(id, { status: 'cancelled' })
    for (const [ref, kept] of [...this.refs]) if (gone.has(kept.threadId)) this.dropRef(ref)
    for (const [file, kept] of [...this.files]) if (gone.has(kept.threadId)) this.dropFile(file)
  }

  /** Sotto is closing: every card is cancelled, every value forgotten and every file deleted before it returns. */
  close(): void {
    this.closed = true
    for (const id of [...this.waiting.keys()]) this.end(id, { status: 'cancelled' })
    for (const ref of [...this.refs.keys()]) this.dropRef(ref)
    for (const file of [...this.files.keys()]) this.dropFile(file)
  }

  /** What is held now, for tests and for the window's count: never a value. */
  held(): { readonly waiting: number; readonly refs: number; readonly files: number } { return { waiting: this.waiting.size, refs: this.refs.size, files: this.files.size } }

  private kept(threadId: string, ref: string): KeptRef | null {
    if (!SECRET_REF_PATTERN.test(ref)) return null
    const kept = this.refs.get(ref)
    return kept && kept.threadId === threadId ? kept : null
  }
  private keepRef(threadId: string, value: string, expiresAt: number, site: string | null): string {
    const ref = `secret-ref:${randomBytes(16).toString('hex')}`
    const timer = setTimeout(() => this.dropRef(ref), Math.max(0, expiresAt - this.now()))
    timer.unref?.()
    this.refs.set(ref, { threadId, value, expiresAt, timer, site })
    return ref
  }
  private dropRef(ref: string): void {
    const kept = this.refs.get(ref)
    if (!kept) return
    clearTimeout(kept.timer)
    this.refs.delete(ref)
  }
  private prepare(): Promise<string> {
    this.prepared ??= (async () => {
      const folder = this.folder
      await mkdir(folder, { recursive: true, mode: 0o700 })
      await chmod(folder, 0o700).catch(() => undefined)
      await (this.options.protect ?? protectOnWindows)(folder).catch(() => undefined)
      return folder
    })()
    this.prepared.catch(() => { this.prepared = undefined })
    return this.prepared
  }
  /**
   * Writes one value to its own file. Sotto may close while the folder is made or the file written: then nothing is
   * kept, and a file already on disk is deleted before this returns, since close() could not know of it.
   */
  private async keepFile(threadId: string, value: string, expiresAt: number): Promise<string> {
    if (this.closed) throw new Error(CLOSING)
    const folder = await this.prepare()
    if (this.closed) throw new Error(CLOSING)
    const file = resolve(join(folder, randomBytes(16).toString('hex')))
    // `wx` never follows or replaces a path that is already there.
    try { await writeFile(file, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 }) }
    catch (error) {
      // A write that failed part way may have left part of the value; a path that was already there is not ours.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') removeNow(file)
      throw error
    }
    if (this.closed) { removeNow(file); throw new Error(CLOSING) }
    const timer = setTimeout(() => this.dropFile(file), Math.max(0, expiresAt - this.now()))
    timer.unref?.()
    this.files.set(file, { threadId, expiresAt, timer })
    return file
  }
  /** Forgets a file and deletes it before returning, so a quit right after leaves nothing behind. */
  private dropFile(file: string): void {
    const kept = this.files.get(file)
    if (kept) clearTimeout(kept.timer)
    this.files.delete(file)
    removeNow(file)
  }
  /** Ends a waiting card with its outcome. False when it had already ended, so a late save keeps nothing. */
  private end(id: string, outcome: SecretOutcome): boolean {
    const waiting = this.waiting.get(id)
    if (!waiting) return false
    clearTimeout(waiting.timer)
    waiting.release()
    this.waiting.delete(id)
    this.changed()
    waiting.settle(outcome)
    return true
  }
  private changed(): void {
    const next = new Map<string, AgentRequest[]>()
    for (const { threadId, request } of this.waiting.values()) next.set(threadId, [...next.get(threadId) ?? [], request])
    this.shown = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** The sign-in page as the card's button opens it: an http or https address without a user name or password, else none. */
function safeUrl(input: string): string | undefined {
  try {
    const url = new URL(input)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
