import { useSyncExternalStore } from 'react'
import { vi } from 'vitest'
import type { AgentCommand, AgentDelivery, AgentState } from '../../../src/shared/agents'
import type { useAgents } from '../../../src/renderer/src/agents/AgentContext'

type Connection = ReturnType<typeof useAgents>
type Status = AgentDelivery['status']

/**
 * A published agent state with the controller's draft and delivery rules: a draft save stores the
 * revision by thread, manual-send stores its revision and publishes `queued` on admission, and the
 * test decides when the provider accepts, fails or cannot confirm it.
 */
export function liveAgentState(initial: AgentState, options: { readonly holdSaves?: boolean } = {}) {
  let current: AgentState = { ...initial, threadDrafts: initial.threadDrafts ?? [], deliveries: initial.deliveries ?? [], deliveredDrafts: initial.deliveredDrafts ?? [] }
  const listeners = new Set<() => void>()
  const heldSaves: { readonly command: Extract<AgentCommand, { type: 'save-thread-draft' }>; readonly finish: (error?: string | null) => void }[] = []
  const sends = new Map<string, (state: AgentState) => void>()
  const publish = (patch: Partial<AgentState> = {}): AgentState => {
    current = { ...current, ...patch }
    listeners.forEach(listener => listener())
    return current
  }
  const now = (): string => new Date().toISOString()
  const setDelivery = (threadId: string, draftId: string, status: Status, patch: Partial<AgentDelivery> = {}): AgentDelivery[] => {
    const previous = current.deliveries!.find(item => item.threadId === threadId && item.draftId === draftId)
    const others = current.deliveries!.filter(item => item !== previous)
    return [...others, { threadId, draftId, createdAt: previous?.createdAt ?? now(), ...previous, ...patch, status: previous?.status === 'accepted' ? 'accepted' : status, updatedAt: now() }]
  }
  const putDraft = (draft: { threadId: string; draftId: string; text: string; attachments?: AgentState['draftAttachments']; requestId?: string | null }): AgentState['threadDrafts'] => {
    const others = current.threadDrafts!.filter(item => item.threadId !== draft.threadId)
    return draft.text.length || draft.attachments?.length
      ? [...others, { threadId: draft.threadId, draftId: draft.draftId, text: draft.text, attachments: draft.attachments ?? [], requestId: draft.requestId ?? null, updatedAt: now() }]
      : others
  }
  const saveDraft = (request: Extract<AgentCommand, { type: 'save-thread-draft' }>, persistError: string | null = null): AgentState => {
    if (current.deliveredDrafts!.some(item => item.threadId === request.threadId && item.draftId === request.draftId)) return current
    const submitted = current.deliveries!.find(item => item.threadId === request.threadId && item.draftId === request.draftId)
    if (submitted && submitted.status !== 'failed') return publish({ error: 'Use a new draft revision when editing a submitted prompt.' })
    // Like the controller: the draft is in published state even when persisting it fails.
    return publish({ threadDrafts: putDraft(request), error: persistError })
  }
  const command = vi.fn(async (request: AgentCommand): Promise<AgentState | null> => {
    if (request.type === 'save-thread-draft') {
      if (!options.holdSaves) return saveDraft(request)
      return new Promise(resolve => { heldSaves.push({ command: request, finish: (error = null) => resolve(saveDraft(request, error)) }) })
    }
    if (request.type === 'manual-send') {
      const pending = current.deliveries!.some(item => item.threadId === request.threadId && ['queued', 'submitting', 'uncertain'].includes(item.status))
      if (!pending) publish({ threadDrafts: putDraft({ ...request, draftId: request.draftId! }), deliveries: setDelivery(request.threadId, request.draftId!, 'queued') })
      return new Promise(resolve => { sends.set(`${request.threadId}\n${request.draftId}`, resolve) })
    }
    return current
  })
  const useLive = (): Connection => {
    const state = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => current)
    return { state, command, error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(), attention: { items: state.queue, show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) } } as Connection
  }
  const sentDraftId = (threadId: string): string => {
    const call = command.mock.calls.map(([request]) => request).findLast(request => request.type === 'manual-send' && request.threadId === threadId)
    if (call?.type !== 'manual-send') throw new Error(`No manual send for ${threadId}`)
    return call.draftId!
  }
  return {
    command,
    useLive,
    get state(): AgentState { return current },
    publish,
    heldSaves,
    sentDraftId,
    manualSends: () => command.mock.calls.filter(([request]) => request.type === 'manual-send').length,
    /** Move a sent revision through the provider's answer; `accepted` echoes the exact message into history. */
    deliver(threadId: string, status: Status, text = ''): void {
      const draftId = sentDraftId(threadId)
      const messageId = `message-${draftId}`
      const patch: Partial<AgentState> = { deliveries: setDelivery(threadId, draftId, status, status === 'accepted' ? { messageId } : {}) }
      if (status === 'accepted') {
        patch.threadDrafts = current.threadDrafts!.filter(item => item.threadId !== threadId || item.draftId !== draftId)
        patch.deliveredDrafts = [...current.deliveredDrafts!, { threadId, draftId }]
        patch.host = { ...current.host, threads: current.host.threads.map(thread => thread.id === threadId ? { ...thread, messages: [...thread.messages, { id: messageId, role: 'user' as const, text, createdAt: now() }] } : thread) }
      }
      const state = publish(patch)
      if (status !== 'submitting') sends.get(`${threadId}\n${draftId}`)?.(status === 'accepted' ? state : { ...state, error: status === 'failed' ? 'The provider rejected this action.' : 'The provider did not confirm the result.' })
    },
  }
}
