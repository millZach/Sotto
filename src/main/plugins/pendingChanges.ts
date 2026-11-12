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

interface Waiting { readonly threadId: string; readonly request: AgentRequest; readonly settle: (answer: PluginChangeAnswer) => void; readonly timer: ReturnType<typeof setTimeout> }

/**
 * Plugin changes waiting on the user (ADR-0205, decision 7). A change's tool call is held here until the user answers
 * its card, and nothing reaches the service before that. Each is one of Sotto's own requests in its thread, so it shows
 * and is answered where a provider's permission is, counts in Needs you, reaches a paired phone with the thread, and
 * is answered only by the coordinator's own rules: the user's explicit choice, never a wake-up turn or a client without
 * authority. An ask nobody answers lapses; an ask whose thread is deleted, or that Sotto closes under, stops.
 */
export class PluginChangeRequests implements SottoThreadRequests {
  private readonly waiting = new Map<string, Waiting>()
  private readonly listeners = new Set<() => void>()
  /** Built again only when an ask is added or ends: the coordinator reads this on every publication. */
  private shown: ReadonlyMap<string, readonly AgentRequest[]> = new Map()
  private closed = false
  constructor(private readonly options: { readonly waitMs?: number; readonly now?: () => Date } = {}) {}

  /** Shows the card and waits for the user. Resolves once: allowed, denied, lapsed or stopped. */
  ask(threadId: string, card: PluginChangeCard): Promise<PluginChangeAnswer> {
    if (this.closed) return Promise.resolve('stopped')
    const id = `${PLUGIN_CHANGE_PREFIX}${randomUUID()}`
    const request: AgentRequest = {
      id, kind: 'permission', text: card.text, options: [],
      permissionChoices: [{ id: 'allow', label: card.allow, kind: 'allow-once' }, { id: 'deny', label: card.deny, kind: 'deny' }],
      context: { toolName: card.plugin, action: card.action, target: card.target, details: card.details },
      since: (this.options.now?.() ?? new Date()).toISOString(),
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => this.end(id, 'lapsed'), this.options.waitMs ?? PLUGIN_CHANGE_WAIT_MS)
      this.waiting.set(id, { threadId, request, settle: resolve, timer })
      this.changed()
    })
  }

  requests(): ReadonlyMap<string, readonly AgentRequest[]> { return this.shown }

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
