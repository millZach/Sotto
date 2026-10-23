import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { t } from '@lingui/core/macro'
import { hostForThread, PROVIDER_LABELS, type AgentMessage, type AgentModel, type AgentRuntimeMode, type AgentState, type AgentThread,
  type ProviderId, type ThreadContinuedIn } from '../../../shared/agents'
import { continuePermission, continueProviderRefusal, type ContinuePermission, type ContinueWorkingCopy } from '../../../shared/continueThread'
import { limitStopOf, type LimitStop } from '../../../shared/limitStops'
import { resolveModel } from '../../../shared/modelCatalog'
import { useOwlFeature } from '../state/owlFeature'
import { newestModelsFirst } from './ModelPicker'

/**
 * Continuing a thread on another provider in the window (ADR-0089, Zach's pick B of the continue prototype, in place):
 * the usage-limit error's provider chips, or "Continue in a new thread on" in the model chip, turn the composer into
 * "Continue on Codex" with a strip above it; the first message sent from there starts the continued thread with the
 * handover ahead of it. This module holds which thread is being continued where, and the facts every part reads.
 */

/** Whether the window offers continuing: the Owl list turns it on and main offered the bridge. */
export function useContinueEnabled(): boolean {
  return useOwlFeature('continue-on-provider') && typeof window !== 'undefined' && window.sotto?.continueThread !== undefined
}

/** A continuation the user has begun in a thread's composer and not yet sent. */
export interface ContinueChoice {
  readonly modelId: string
  readonly reasoningEffort?: string | undefined
  readonly runtimeMode?: AgentRuntimeMode | undefined
  readonly providerMode?: string | undefined
  readonly workingCopy: ContinueWorkingCopy
  /** The continued thread's Sotto thread ID, minted once when the continuation begins, so a retry finds the same thread. */
  readonly newThreadId: string
  readonly sending: boolean
  readonly error: string | null
  /** The model picker opens on the strip as it appears, from the error's More. */
  readonly pick?: true | undefined
  /** Why the permission it started on is narrower than the source's, until the user chooses one. */
  readonly narrowed?: ContinuePermission['narrowed'] | undefined
}

/** The continuations begun in this window, by the thread each continues. Nothing of it is saved. */
export class ContinueStore {
  private readonly choices = new Map<string, ContinueChoice>()
  private readonly listeners = new Set<() => void>()
  get(threadId: string): ContinueChoice | undefined { return this.choices.get(threadId) }
  set(threadId: string, choice: ContinueChoice | undefined): void {
    if (choice === undefined) { if (!this.choices.delete(threadId)) return } else this.choices.set(threadId, choice)
    for (const listener of [...this.listeners]) listener()
  }
  update(threadId: string, patch: Partial<ContinueChoice>): void {
    const choice = this.choices.get(threadId)
    if (choice !== undefined) this.set(threadId, { ...choice, ...patch })
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
}
export const continueStore = new ContinueStore()

/** The continuation begun in this thread's composer, while the window offers continuing. */
export function useContinueChoice(threadId: string, store: ContinueStore = continueStore): ContinueChoice | undefined {
  const enabled = useContinueEnabled()
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const choice = useSyncExternalStore(subscribe, () => store.get(threadId), () => undefined)
  return enabled ? choice : undefined
}

/** The models a thread may continue on: every ready model of every other provider that can start a thread now. */
export function continueModels(state: AgentState, thread: AgentThread): AgentModel[] {
  const host = hostForThread(state.host, thread)
  return host.models.filter(model => model.ready && model.providerId !== undefined && model.providerId !== thread.providerId
    && continueProviderRefusal(host, model.providerId) === null)
}

/** A provider the user turned on that cannot take a continued thread now: why, in full and in a few words for its chip. */
export interface UnavailableProvider { readonly providerId: ProviderId; readonly name: string; readonly reason: string; readonly short: string }

/** The providers the user turned on, other than the thread's own, that cannot take a continued thread now. */
export function unavailableProviders(state: AgentState, thread: AgentThread): UnavailableProvider[] {
  const host = hostForThread(state.host, thread)
  const listed = new Set(host.providers?.map(status => status.id) ?? [])
  const enabled = state.configuration.enabledProviders ?? [state.configuration.provider]
  return enabled.filter(id => id !== thread.providerId && listed.has(id)).flatMap(id => {
    const reason = continueProviderRefusal(host, id)
    if (reason === null) return []
    const status = host.providers?.find(item => item.id === id)
    const short = status?.connection === 'connecting' ? t({ message: 'connecting', comment: 'After a provider\'s name on a chip: why it cannot take a continued thread now.' })
      : status?.problem === 'signed-out' ? t({ message: 'not signed in', comment: 'After a provider\'s name on a chip: why it cannot take a continued thread now.' })
        : status?.problem === 'not-installed' ? t({ message: 'not installed', comment: 'After a provider\'s name on a chip: why it cannot take a continued thread now.' })
          : t({ message: 'not connected', comment: 'After a provider\'s name on a chip: why it cannot take a continued thread now.' })
    return [{ providerId: id, name: PROVIDER_LABELS[id], reason, short }]
  })
}

/** Each provider's model a chip offers: the new-thread default where it is that provider's, else its newest. */
export function providerDefaults(state: AgentState, models: readonly AgentModel[]): AgentModel[] {
  const providers = [...new Set(models.flatMap(model => model.providerId ? [model.providerId] : []))]
  return providers.flatMap(provider => {
    const own = models.filter(model => model.providerId === provider)
    const chosen = own.find(model => model.id === state.configuration.newThreadModelId) ?? newestModelsFirst(own)[0]
    return chosen ? [chosen] : []
  })
}

/**
 * A continuation begun on `modelId`: the model's own default effort, the source's permission mapped to that model and
 * capped by the new-thread default (Zach, October 16; `continuePermission`), the source's folder, and a new thread ID.
 */
export function continueChoiceFor(state: AgentState, thread: AgentThread, modelId: string, previous?: ContinueChoice): ContinueChoice {
  const models = hostForThread(state.host, thread).models
  const permission = continuePermission(thread, resolveModel(models, thread.modelId), resolveModel(models, modelId), state.configuration.newThreadRuntimeMode)
  return { modelId, reasoningEffort: resolveModel(models, modelId)?.defaultReasoningEffort, runtimeMode: permission.runtimeMode, providerMode: permission.providerMode,
    ...(permission.narrowed ? { narrowed: permission.narrowed } : {}),
    workingCopy: previous?.workingCopy ?? (sameFolderOffered(thread) ? 'same' : 'new-worktree'), newThreadId: previous?.newThreadId ?? crypto.randomUUID(), sending: false, error: null }
}

/** Whether the thread's own folder can be the continued thread's: not a worktree that was put away (ADR-0041). */
export function sameFolderOffered(thread: Pick<AgentThread, 'worktree'>): boolean {
  const worktree = thread.worktree
  return worktree?.mode !== 'independent' || (worktree.path !== undefined || worktree.existingWorktreePath !== undefined) && worktree.reclaimedAt === undefined
}

/** The limit the thread's last turn stopped at, when it stopped at one Sotto names. */
export function lastLimitStop(thread: Pick<AgentThread, 'activities'>): LimitStop | undefined {
  const turn = thread.activities?.findLast(record => record.kind === 'turn')
  return turn?.status === 'failed' ? limitStopOf(turn.error) : undefined
}

/** The newest thread that continues this one, once nothing newer has been said in this one. */
export function continuedSince(thread: Pick<AgentThread, 'continuedIn' | 'summary' | 'messages'>): ThreadContinuedIn | undefined {
  const newest = thread.continuedIn?.at(-1)
  if (newest === undefined) return undefined
  const last = thread.summary?.lastMessageAt ?? thread.messages.at(-1)?.createdAt
  return last === undefined || Date.parse(last) <= Date.parse(newest.at) ? newest : undefined
}

/**
 * Where each link to a continued thread sits in this thread's history: after the turn that was the newest when it was
 * made, by the user message that began that turn. A link whose turn is not in the window is left out.
 */
export function continuedInByTurn(links: readonly ThreadContinuedIn[] | undefined, messages: readonly AgentMessage[]): ReadonlyMap<string, readonly ThreadContinuedIn[]> {
  const byTurn = new Map<string, ThreadContinuedIn[]>()
  if (!links?.length || !messages.length) return byTurn
  for (const link of links) {
    const at = Date.parse(link.at)
    const last = messages.findLastIndex(message => Date.parse(message.createdAt) <= at)
    if (last < 0) continue
    const user = messages.slice(0, last + 1).findLast(message => message.role === 'user')
    if (user !== undefined) byTurn.set(user.id, [...byTurn.get(user.id) ?? [], link])
  }
  return byTurn
}

/** What a link between threads reads: the threads as the window holds them, and how to open one. */
export interface ContinueLinks { readonly threads: readonly AgentThread[]; readonly open: (threadId: string) => void }
export const ContinueLinksContext = createContext<ContinueLinks | null>(null)
export function useContinueLinks(): ContinueLinks | null { return useContext(ContinueLinksContext) }
