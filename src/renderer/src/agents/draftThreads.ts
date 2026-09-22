import { useSyncExternalStore } from 'react'
import type { AgentCommand, AgentRuntimeMode, AgentState, AgentThread } from '../../../shared/agents'

/** What a refused creation says when main answered nothing at all. */
export const UNCONFIRMED_CREATION = 'Could not confirm thread creation. Your choices are retained.'

type Command = (command: AgentCommand) => Promise<AgentState | null>

interface Creation {
  readonly ready: Promise<string | null>
  readonly settle: (error: string | null) => void
}

/** The local record for a thread this window has just asked main to create, shaped exactly as main will publish it. */
export function draftThread(values: {
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly modelId: string
  readonly providerId?: AgentThread['providerId']
  readonly reasoningEffort?: string | undefined
  readonly runtimeMode?: AgentRuntimeMode | undefined
  readonly providerMode?: string | undefined
  readonly workingCopy: 'independent' | 'shared'
  readonly baseBranch?: string | undefined
  readonly startFromOrigin?: boolean | undefined
  readonly existingWorktreePath?: string | undefined
}): AgentThread {
  return {
    id: values.id, projectId: values.projectId, title: values.title, modelId: values.modelId,
    ...(values.providerId ? { providerId: values.providerId } : {}),
    ...(values.reasoningEffort ? { reasoningEffort: values.reasoningEffort } : {}),
    ...(values.runtimeMode ? { runtimeMode: values.runtimeMode } : {}),
    ...(values.providerMode ? { providerMode: values.providerMode } : {}),
    worktree: { mode: values.workingCopy, status: 'pending', ...(values.baseBranch ? { baseBranch: values.baseBranch } : {}), ...(values.startFromOrigin !== undefined ? { startFromOrigin: values.startFromOrigin } : {}), ...(values.existingWorktreePath ? { existingWorktreePath: values.existingWorktreePath } : {}) },
    status: 'idle', messages: [], requests: [], workspaceSettledAt: null,
    // Creation has not been dispatched to the provider yet, and there is no history to wait for.
    nativeSessionStarted: false, historyStatus: 'ready',
  }
}

/**
 * Threads this window minted an ID for and is already showing, before main's state carries them.
 *
 * A draft thread is only a local view of a creation already on its way: it grants nothing, starts
 * nothing, and is forgotten the moment main's own state carries the thread or refuses to create it.
 */
class DraftThreadStore {
  private entries: readonly AgentThread[] = []
  private readonly creations = new Map<string, Creation>()
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly get = (): readonly AgentThread[] => this.entries

  /**
   * Show `thread` now. `created` resolves null once main has taken the creation, or with the reason it refused,
   * and a refusal takes the local record away again.
   */
  open(thread: AgentThread, created: Promise<string | null>): void {
    let settle: Creation['settle'] = () => undefined
    const ready = new Promise<string | null>(resolve => { settle = resolve })
    this.creations.set(thread.id, { ready, settle })
    this.entries = [...this.entries, thread]
    this.emit()
    void created.then(error => { if (error === null) this.accept(thread.id); else this.refuse(thread.id, error) },
      () => this.refuse(thread.id, UNCONFIRMED_CREATION))
  }

  /** Main's state carries these threads now, so their local records have nothing left to say. */
  reconcile(state: AgentState | null): void {
    if (state === null) return
    for (const thread of this.entries) {
      if (!state.host.threads.some(item => item.id === thread.id)) continue
      this.accept(thread.id)
      this.forget(thread.id)
    }
  }

  /**
   * Null when main already knows this thread (or never had a draft for it); otherwise a promise that
   * settles with the creation's outcome. A caller waits on it instead of acting on an unknown thread.
   */
  creation(threadId: string): Promise<string | null> | null {
    return this.creations.get(threadId)?.ready ?? null
  }

  /** Test seam: forget every draft thread. */
  reset(): void {
    for (const creation of this.creations.values()) creation.settle(UNCONFIRMED_CREATION)
    this.creations.clear()
    if (this.entries.length === 0) return
    this.entries = []
    this.emit()
  }

  private accept(threadId: string): void {
    const creation = this.creations.get(threadId)
    if (creation === undefined) return
    this.creations.delete(threadId)
    creation.settle(null)
  }

  private refuse(threadId: string, error: string): void {
    const creation = this.creations.get(threadId)
    this.creations.delete(threadId)
    creation?.settle(error)
    this.forget(threadId)
  }

  private forget(threadId: string): void {
    if (!this.entries.some(thread => thread.id === threadId)) return
    this.entries = this.entries.filter(thread => thread.id !== threadId)
    this.emit()
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}

export const draftThreads = new DraftThreadStore()

export function useDraftThreads(store: DraftThreadStore = draftThreads): readonly AgentThread[] {
  return useSyncExternalStore(store.subscribe, store.get)
}

/** The state as the window shows it: main's threads, plus the ones it is still catching up on. */
export function overlayDraftThreads(state: AgentState | null, drafts: readonly AgentThread[]): AgentState | null {
  if (state === null || drafts.length === 0) return state
  const missing = drafts.filter(draft => !state.host.threads.some(thread => thread.id === draft.id))
  if (missing.length === 0) return state
  return { ...state, host: { ...state.host, threads: [...state.host.threads, ...missing] } }
}

/**
 * A command about a thread main has not confirmed yet waits for its creation rather than being refused:
 * creation takes tens of milliseconds, and the user's draft and Send should not have to know that.
 * A refused creation resolves the command as unconfirmed; the thread it named is gone from the window.
 */
export function gateOnCreation(command: Command, store: DraftThreadStore = draftThreads): Command {
  return request => {
    // The creation itself carries the same ID and must never wait for its own draft record.
    const threadId = 'threadId' in request && request.type !== 'create-thread' ? request.threadId : undefined
    const pending = threadId === undefined ? null : store.creation(threadId)
    return pending === null ? command(request) : pending.then(error => error === null ? command(request) : null)
  }
}
