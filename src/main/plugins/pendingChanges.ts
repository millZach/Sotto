import { randomUUID } from 'node:crypto'
import type { AgentRequest } from '../../shared/agents'
import { SOTTO_REQUEST_PREFIX, type SottoThreadRequests } from '../agents/sottoRequests'

/** How long a plugin change waits for the user before it lapses, as the browser's and the cloud iPhone's asks do. */
export const PLUGIN_CHANGE_WAIT_MS = 5 * 60_000
/** Every plugin change's request starts with this, after Sotto's own prefix. */
export const PLUGIN_CHANGE_PREFIX = `${SOTTO_REQUEST_PREFIX}plugin-change:`

/** A change as its card words it: what it does, to what, and the rest in readable lines (ADR-0185). */
export interface PluginChangeCard {
  /** The whole ask in a sentence or two, for a client that shows only a request's text. */
  readonly text: string
  /** What the change does, for the card's head: "Comment on GitHub". */
  readonly action: string
  /** What it acts on: "example-owner/example-repo #12". */
  readonly target: string
  /** Everything else that will be sent, in readable lines. */
  readonly details: string
  /** The plugin's name, for the card's tag. */
  readonly plugin: string
  readonly allow: string
  readonly deny: string
}

/** How an ask ended: the user allowed it or said no, nobody answered in time, or its thread or Sotto went away. */
export type PluginChangeAnswer = 'allowed' | 'denied' | 'lapsed' | 'stopped'

/** What bounds one ask beyond the usual wait: the call it is for, and how long that call's client will wait. */
export interface PluginChangeWait {
  /** Aborts when the tool call the ask is for has gone away; the ask stops, since nobody would hear its result. */
  readonly signal?: AbortSignal
  /** The longest this ask may wait, when that is shorter than the usual wait. */
  readonly waitMs?: number
  /**
   * Whether the ask's thread is still open, for an ask that means more by that than every ask does. The mail card
   * gives the mail grants' own test, so the card and the grant it asks for end at the same moment. The ask stops
   * when this says no.
   */
  readonly stillOpen?: () => boolean
}

interface Waiting {
  readonly threadId: string; readonly request: AgentRequest; readonly settle: (answer: PluginChangeAnswer) => void; readonly timer: ReturnType<typeof setTimeout>
  /** Lets go of the call's signal. */
  readonly release: () => void
  readonly stillOpen: (() => boolean) | undefined
}

/**
 * Plugin changes waiting on the user (ADR-0205, decision 7). A change's tool call is held here until the user answers
 * its card, and nothing reaches the service before that. Each is one of Sotto's own requests in its thread, so it shows
 * and is answered where a provider's permission is, counts in Needs you, reaches a paired phone with the thread, and
 * is answered only by the coordinator's own rules: the user's explicit choice, never a wake-up turn or a client without
 * authority. An ask nobody answers lapses. An ask stops when its tool call goes away, when its thread is deleted,
 * settled or archived, or when Sotto closes: nothing is done for a call nobody is waiting on.
 */
export class PluginChangeRequests implements SottoThreadRequests {
  private readonly waiting = new Map<string, Waiting>()
  private readonly listeners = new Set<() => void>()
  /** Built again only when an ask is added or ends: the coordinator reads this on every publication. */
  private shown: ReadonlyMap<string, readonly AgentRequest[]> = new Map()
  private closed = false
  private checking = false
  /**
   * `open` says whether a thread is still open: not settled, archived or gone. Without it no ask stops for that.
   * `noticed` is called whenever the coordinator reads these requests, which it does on every publication: it is how
   * the mail grants hear that a thread may have been settled, and must cost next to nothing.
   */
  constructor(private readonly options: { readonly waitMs?: number; readonly now?: () => Date; readonly open?: (threadId: string) => boolean; readonly noticed?: () => void } = {}) {}

  /** Shows the card and waits for the user. Resolves once: allowed, denied, lapsed or stopped. */
  ask(threadId: string, card: PluginChangeCard, wait: PluginChangeWait = {}): Promise<PluginChangeAnswer> {
    if (this.closed || wait.signal?.aborted || wait.stillOpen?.() === false) return Promise.resolve('stopped')
    const id = `${PLUGIN_CHANGE_PREFIX}${randomUUID()}`
    const request: AgentRequest = {
      id, kind: 'permission', text: card.text, options: [],
      permissionChoices: [{ id: 'allow', label: card.allow, kind: 'allow-once' }, { id: 'deny', label: card.deny, kind: 'deny' }],
      context: { toolName: card.plugin, action: card.action, target: card.target, details: card.details },
      since: (this.options.now?.() ?? new Date()).toISOString(),
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => this.end(id, 'lapsed'), Math.max(0, Math.min(this.options.waitMs ?? PLUGIN_CHANGE_WAIT_MS, wait.waitMs ?? Infinity)))
      const gone = (): void => { this.end(id, 'stopped') }
      wait.signal?.addEventListener('abort', gone, { once: true })
      this.waiting.set(id, { threadId, request, settle: resolve, timer, release: () => { wait.signal?.removeEventListener('abort', gone) }, stillOpen: wait.stillOpen })
      this.changed()
    })
  }

  /**
   * The coordinator reads this on every publication, and a thread being settled or archived is one. So that read is
   * when the waiting asks look at their threads, once it is over: the read itself changes nothing. With nothing
   * waiting it costs a comparison.
   */
  requests(): ReadonlyMap<string, readonly AgentRequest[]> {
    this.options.noticed?.()
    if (this.waiting.size > 0 && !this.checking) {
      this.checking = true
      queueMicrotask(() => { this.checking = false; this.stopClosed() })
    }
    return this.shown
  }

  /** Stops every ask whose thread is no longer open. A settled thread takes no answer, and one reopened later must not find its old card. */
  stopClosed(): void {
    const open = this.options.open
    for (const [id, waiting] of [...this.waiting]) {
      let still = false
      try { still = (open?.(waiting.threadId) ?? true) && (waiting.stillOpen?.() ?? true) } catch { /* A thread that cannot be read is not taken for open. */ }
      if (!still) this.end(id, 'stopped')
    }
  }

  /** The user's answer. Throws when the request is no longer waiting, as any request's answer does. */
  answer(threadId: string, requestId: string, approved: boolean): void {
    const waiting = this.waiting.get(requestId)
    if (!waiting || waiting.threadId !== threadId) throw new Error('This request is no longer pending. Refresh the thread.')
    this.end(requestId, approved ? 'allowed' : 'denied')
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Deleted threads take their waiting asks with them: each stops, and nothing is done. */
  forgetThreads(threadIds: readonly string[]): void {
    const gone = new Set(threadIds)
    for (const [id, waiting] of [...this.waiting]) if (gone.has(waiting.threadId)) this.end(id, 'stopped')
  }

  /** Sotto is closing: every waiting ask stops, and no new one is taken. */
  close(): void {
    this.closed = true
    for (const id of [...this.waiting.keys()]) this.end(id, 'stopped')
  }

  private end(id: string, answer: PluginChangeAnswer): void {
    const waiting = this.waiting.get(id)
    if (!waiting) return
    clearTimeout(waiting.timer)
    waiting.release()
    this.waiting.delete(id)
    this.changed()
    waiting.settle(answer)
  }

  private changed(): void {
    const next = new Map<string, AgentRequest[]>()
    for (const { threadId, request } of this.waiting.values()) next.set(threadId, [...next.get(threadId) ?? [], request])
    this.shown = next
    for (const listener of [...this.listeners]) listener()
  }
}
