import { join } from 'node:path'
import { z } from 'zod'
import { agentRuntimeModeSchema } from '../../shared/agents'
import type { DelegationNews } from '../../shared/delegation'
import { delegationRemoteAskSchema, type DelegationRemoteAsk, type RelayedReply } from '../../shared/delegationRelay'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { DelegationService, RelayedCaller } from './delegation'

/** A desktop connected to this host whose hello accepted `delegation-remote`: the socket's way to push it news. */
export interface RemoteDesktop {
  readonly clientId: string
  /** Pushes news of a delegation this host holds for one of that desktop's callers; false when the socket would not take it. */
  push(caller: string, news: DelegationNews, replies: readonly RelayedReply[]): boolean
}

const PREFIX = 'relay:'
/** This host's key for a desktop's caller: the desktop's client first, so a desktop can only address the callers it named. */
export const remoteCallerKey = (clientId: string, caller: string): string => `${PREFIX}${clientId}:${caller}`
function parseKey(key: string): { readonly clientId: string; readonly caller: string } | undefined {
  if (!key.startsWith(PREFIX)) return undefined
  const rest = key.slice(PREFIX.length), at = rest.indexOf(':')
  return at > 0 ? { clientId: rest.slice(0, at), caller: rest.slice(at + 1) } : undefined
}

const id = z.string().min(1).max(512)
const callerSchema = z.object({ id, projectId: id, runtimeMode: agentRuntimeModeSchema, levels: z.number().int().min(0).max(8), rootUserMessageId: id,
  callerMessageId: id.optional() }).strict()
const fileSchema = z.object({ version: z.literal(1), callers: z.array(callerSchema).max(100_000) }).strict()
type RemoteFile = z.infer<typeof fileSchema>
/** Callers kept past this many only while one of them has a delegation open. */
const CALLERS_MAX = 1_000
const FORGOTTEN = 'This machine no longer takes delegations from that desktop. Nothing was started or sent.'
const NOT_HELD = 'This machine holds no delegation for that thread, so Sotto cannot prove whether it started. Nothing was sent again.'

/**
 * A headless host's side of a delegation the desktop asks it for (#1316 part 2, ADR-0105 decision 1, Owl
 * `cross-machine-work`): a thread on another machine, the desktop's own or one that asked the desktop through the relay,
 * delegates to a thread here. This host admits it with its own delegation, as if the asking thread were one of its own,
 * under its own rules: the narrower of that thread's permission, as the desktop says it, and the desktop defaults this host
 * was sent, held to Ask for approval as its own threads' starts are (#1310); the desktop's worker roles; and the four
 * briefs per thread per user message, counted here. The record is this host's own delegation record; this keeps only each
 * caller as the desktop last named it, and how its news goes back.
 *
 * News goes to the desktop that asked, while it is connected. One that cannot go is offered again a few times, as
 * delegation's own news is; the desktop reads every open delegation exactly when it connects again, so nothing is lost
 * and nothing is resent (ADR-0058).
 */
export class HostRemoteCallers {
  private readonly store: AtomicJsonStore<RemoteFile>
  private readonly callers = new Map<string, RelayedCaller>()
  private readonly desktops: RemoteDesktop[] = []
  /** Callers whose admission is running now, by how many: never trimmed, so a caller cannot drop itself before it is admitted. */
  private readonly admitting = new Map<string, number>()
  private delegation: Pick<DelegationService, 'delegate' | 'read' | 'cancel' | 'retriedDelegation' | 'hasOpen'> | undefined

  constructor(directory: string, private readonly options: {
    /**
     * Whether a client is still one the launch script recorded as a desktop, read at every ask and every admission. A
     * desktop no longer recorded addresses no caller here: its asks are refused, and a start of its still being admitted
     * is refused when its thread would be made.
     */
    readonly recorded?: (clientId: string) => boolean
    /**
     * Whether a desktop may answer here now (its `remote-answer` grant), read at every admission and at the thread's
     * creation. One that may not has its callers held to Ask for approval, whatever another desktop's defaults allow (#1316 review).
     */
    readonly mayAnswer?: (clientId: string) => boolean
    /** Stable event names only, never a brief, a reply or a thread. */
    readonly log?: (event: 'delegation-remote-news-failed') => void
  } = {}) {
    this.store = new AtomicJsonStore(join(directory, 'delegation-remote-callers.json'), input => fileSchema.parse(input), (): RemoteFile => ({ version: 1, callers: [] }))
  }
  async load(): Promise<void> {
    const file = await this.store.read().catch((): RemoteFile => ({ version: 1, callers: [] }))
    for (const caller of file.callers) this.callers.set(caller.id, caller)
  }
  /** The delegation that admits a desktop's asks: this host's own. */
  useDelegation(delegation: Pick<DelegationService, 'delegate' | 'read' | 'cancel' | 'retriedDelegation' | 'hasOpen'>): void { this.delegation = delegation }

  /** What this host's delegation asks of a caller on another machine: as the desktop last named it, or none. */
  caller(threadId: string): RelayedCaller | undefined {
    const caller = this.callers.get(threadId), key = caller ? parseKey(threadId) : undefined
    if (!caller || !key) return undefined
    // The asking desktop's own standing, read now: a desktop since forgotten names nothing, one without a grant asks first.
    if (this.options.recorded && !this.options.recorded(key.clientId)) return undefined
    return this.options.mayAnswer && !this.options.mayAnswer(key.clientId) ? { ...caller, runtimeMode: 'approval-required' } : caller
  }
  /** A desktop's hello accepted `delegation-remote`: news of its callers' delegations goes to it from now on. */
  desktopConnected(desktop: RemoteDesktop): void {
    const at = this.desktops.indexOf(desktop)
    if (at !== -1) this.desktops.splice(at, 1)
    this.desktops.push(desktop)
  }
  desktopGone(desktop: RemoteDesktop): void {
    const at = this.desktops.indexOf(desktop)
    if (at !== -1) this.desktops.splice(at, 1)
  }
  /** A delegation's news goes to the desktop that asked for it, on its newest socket; rejects when it could not go. */
  async tell(threadId: string, news: DelegationNews, replies: readonly RelayedReply[] = []): Promise<void> {
    const key = parseKey(threadId)
    const desktop = key ? this.desktops.findLast(item => item.clientId === key.clientId) : undefined
    let pushed: boolean
    try { pushed = desktop !== undefined && key !== undefined && desktop.push(key.caller, news, replies) } catch { pushed = false }
    if (!pushed) { this.options.log?.('delegation-remote-news-failed'); throw new Error('The desktop that asked for this delegation is not connected.') }
  }

  /** One ask from the desktop `clientId`, answered as this host's own delegation answers the asking thread. */
  async answer(clientId: string, raw: DelegationRemoteAsk): Promise<unknown> {
    const ask = delegationRemoteAskSchema.parse(raw)
    const delegation = this.delegation
    if (!delegation) return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: 'This machine cannot delegate right now. Nothing was started.' }
    if (this.options.recorded && !this.options.recorded(clientId)) return { status: 'refused', code: 'NOT_ADMITTED', message: FORGOTTEN }
    const key = remoteCallerKey(clientId, ask.caller)
    if (ask.type === 'read') {
      const delegationId = ask.delegation ?? (ask.retryKey ? delegation.retriedDelegation(key, ask.retryKey) : undefined)
      if (!delegationId || !this.callers.has(key)) return { status: 'refused', code: 'UNKNOWN_DELEGATION', message: NOT_HELD }
      return await delegation.read(key, { delegation: delegationId })
    }
    if (ask.type === 'cancel') {
      if (!this.callers.has(key)) return { status: 'refused', code: 'UNKNOWN_DELEGATION', message: NOT_HELD }
      return await delegation.cancel(key, { delegation: ask.delegation })
    }
    // The newest word on the caller stands: its turn's root and permission move with its turns.
    this.callers.delete(key)
    this.callers.set(key, { id: key, projectId: ask.projectId, runtimeMode: ask.runtimeMode, levels: ask.levels, rootUserMessageId: ask.rootUserMessageId,
      ...(ask.callerMessageId ? { callerMessageId: ask.callerMessageId } : {}) })
    this.admitting.set(key, (this.admitting.get(key) ?? 0) + 1)
    try {
      await this.save()
      return await delegation.delegate(key, ask.input, { waitMs: ask.waitMs + 2_000 })
    } finally {
      const count = (this.admitting.get(key) ?? 1) - 1
      if (count > 0) this.admitting.set(key, count); else this.admitting.delete(key)
    }
  }
  /**
   * Keeps the newest callers, dropping only those with nothing open and no admission running, so an open delegation can
   * always be read and told, and a caller being admitted is never dropped before it is (#1316 review).
   */
  private trim(): void {
    let excess = this.callers.size - CALLERS_MAX
    if (excess <= 0) return
    for (const key of [...this.callers.keys()]) {
      if (excess <= 0) break
      if (this.admitting.has(key) || this.delegation?.hasOpen(key) !== false) continue
      this.callers.delete(key); excess--
    }
  }
  private save(): Promise<void> {
    this.trim()
    return this.store.writeLatest(() => ({ version: 1, callers: [...this.callers.values()].map(caller => ({ ...caller })) }))
  }
}
