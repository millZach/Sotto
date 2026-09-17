import { useSyncExternalStore } from 'react'
import { vi } from 'vitest'
import type { AgentSkillCatalog } from '../../../src/shared/agentSkills'
import { defaultAgentConfiguration, type AgentCommand, type AgentDelivery, type AgentFollowup, type AgentState } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import type { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'

type Connection = ReturnType<typeof useAgents>

/** The Threads design fixture as the coordinator publishes it, with per-thread drafts and deliveries. */
export function threadsStateFixture(): AgentState {
  const fixture = designThreadsFixture()
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true, defaultModelId: 'claude:sonnet' },
    connection: 'connected',
    host: {
      connected: true, name: 'Codex', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [...fixture.models], projects: [...fixture.projects], threads: structuredClone(fixture.threads) as AgentState['host']['threads'],
    },
    assignments: fixture.assignments.map(assignment => ({ ...assignment, contextUpdatedAt: E2E_THREADS_NOW })),
    queue: [{ id: 'visual-gate:visual-gate-permission:permission', threadId: 'visual-gate', kind: 'permission', text: 'Run a command in workshop\nnpm test -- --run tests/unit/agents', requestId: 'visual-gate-permission', createdAt: new Date(E2E_THREADS_NOW).toISOString(), deferred: false }],
    activeThreadId: 'visual-gate', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false, threadDrafts: [], deliveries: [], deliveredDrafts: [],
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true },
    reasoningAccounts: [],
    membership: { status: 'beta', label: 'Development beta', expiresAt: null },
  }
}

type Status = AgentDelivery['status']

/**
 * A published agent state with the controller's draft and delivery rules: a draft save stores the
 * revision by thread, manual-send stores its revision and publishes `queued` on admission, and the
 * test decides when the provider accepts, fails or cannot confirm it.
 */
export function liveAgentState(initial: AgentState, options: {
  readonly holdSaves?: boolean
  /** Queue admissions wait for `admitQueued`, as a slow durable write would. */
  readonly holdQueue?: boolean
  /** The native catalog main publishes for a refresh; omitted leaves the request unanswered until `publishCatalog`. */
  readonly catalog?: (request: Extract<AgentCommand, { type: 'refresh-thread-skills' }>) => AgentSkillCatalog
} = {}) {
  let current: AgentState = { ...initial, threadDrafts: initial.threadDrafts ?? [], deliveries: initial.deliveries ?? [], deliveredDrafts: initial.deliveredDrafts ?? [] }
  const listeners = new Set<() => void>()
  const heldSaves: { readonly command: Extract<AgentCommand, { type: 'save-thread-draft' }>; readonly finish: (error?: string | null) => void }[] = []
  const sends = new Map<string, (state: AgentState) => void>()
  const heldQueue: { readonly command: Extract<AgentCommand, { type: 'queue-followup' }>; readonly finish: (error?: string | null) => void }[] = []
  const heldCatalogs: ((catalog: AgentSkillCatalog | null) => void)[] = []
  const publish = (patch: Partial<AgentState> = {}): AgentState => {
    current = { ...current, ...patch }
    threadDrafts.receive(current)
    listeners.forEach(listener => listener())
    return current
  }
  const now = (): string => new Date().toISOString()
  const setDelivery = (threadId: string, draftId: string, status: Status, patch: Partial<AgentDelivery> = {}): AgentDelivery[] => {
    const previous = current.deliveries!.find(item => item.threadId === threadId && item.draftId === draftId)
    const others = current.deliveries!.filter(item => item !== previous)
    return [...others, { threadId, draftId, createdAt: previous?.createdAt ?? now(), ...previous, ...patch, status: previous?.status === 'accepted' ? 'accepted' : status, updatedAt: now() }]
  }
  const putDraft = (draft: { threadId: string; draftId: string; text: string; attachments?: AgentState['draftAttachments']; skills?: AgentFollowup['skills']; files?: AgentFollowup['files']; requestId?: string | null }): AgentState['threadDrafts'] => {
    const others = current.threadDrafts!.filter(item => item.threadId !== draft.threadId)
    return draft.text.length || draft.attachments?.length
      ? [...others, { threadId: draft.threadId, draftId: draft.draftId, text: draft.text, attachments: draft.attachments ?? [], ...(draft.skills ? { skills: draft.skills } : {}), ...(draft.files ? { files: draft.files } : {}), requestId: draft.requestId ?? null, updatedAt: now() }]
      : others
  }
  const saveDraft = (request: Extract<AgentCommand, { type: 'save-thread-draft' }>, persistError: string | null = null): AgentState => {
    if (current.deliveredDrafts!.some(item => item.threadId === request.threadId && item.draftId === request.draftId)) return current
    const submitted = current.deliveries!.find(item => item.threadId === request.threadId && item.draftId === request.draftId)
    if (submitted && submitted.status !== 'failed') return publish({ error: 'Use a new draft revision when editing a submitted prompt.' })
    // Like the controller: the draft is in published state even when persisting it fails.
    return publish({ threadDrafts: putDraft(request), error: persistError })
  }
  const followups = (): AgentFollowup[] => current.followups ?? []
  const admit = (request: Extract<AgentCommand, { type: 'queue-followup' }>, error: string | null = null): AgentState => {
    if (error !== null) return publish({ error })
    if ((current.followupReceipts ?? []).some(item => item.threadId === request.threadId && item.draftId === request.draftId)) return current
    const at = now()
    const item: AgentFollowup = { id: crypto.randomUUID(), threadId: request.threadId, draftId: request.draftId, text: request.text, attachments: request.attachments ?? [],
      ...(request.skills ? { skills: request.skills } : {}), createdAt: at, updatedAt: at, status: 'queued' }
    return publish({
      followups: [...followups(), item], followupReceipts: [...current.followupReceipts ?? [], { threadId: request.threadId, draftId: request.draftId }],
      threadDrafts: current.threadDrafts!.filter(draft => draft.threadId !== request.threadId || draft.draftId !== request.draftId), error: null,
    })
  }
  const command = vi.fn(async (request: AgentCommand): Promise<AgentState | null> => {
    if (request.type === 'queue-followup') {
      if (!options.holdQueue) return admit(request)
      return new Promise(resolve => { heldQueue.push({ command: request, finish: (error = null) => resolve(admit(request, error)) }) })
    }
    if (request.type === 'edit-followup') {
      return publish({ followups: followups().map(item => item.id === request.itemId ? { ...item, text: request.text, attachments: request.attachments ?? [], ...(request.skills ? { skills: request.skills } : {}), updatedAt: now() } : item) })
    }
    if (request.type === 'remove-followup') return publish({ followups: followups().filter(item => item.id !== request.itemId) })
    if (request.type === 'reorder-followups') {
      const mine = followups().filter(item => item.threadId === request.threadId)
      return publish({ followups: [...followups().filter(item => item.threadId !== request.threadId), ...request.itemIds.map(id => mine.find(item => item.id === id)!)] })
    }
    if (request.type === 'resume-followups') {
      return publish({ followups: followups().map(item => item.threadId === request.threadId && (item.status === 'paused' || item.status === 'failed') ? { ...item, status: 'queued' as const, error: undefined } : item) })
    }
    if (request.type === 'refresh-thread-skills') {
      const publishCatalog = (catalog: AgentSkillCatalog | null): AgentState | null => catalog === null ? null
        : publish({ skillCatalogs: [...(current.skillCatalogs ?? []).filter(item => item.threadId !== catalog.threadId), catalog] })
      if (options.catalog) return publishCatalog(options.catalog(request))
      return new Promise(resolve => { heldCatalogs.push(catalog => resolve(publishCatalog(catalog))) })
    }
    if (request.type === 'save-thread-draft') {
      if (!options.holdSaves) return saveDraft(request)
      return new Promise(resolve => { heldSaves.push({ command: request, finish: (error = null) => resolve(saveDraft(request, error)) }) })
    }
    if (request.type === 'manual-send' || request.type === 'steer') {
      const pending = current.deliveries!.some(item => item.threadId === request.threadId && ['queued', 'submitting', 'uncertain'].includes(item.status))
      if (!pending) publish({ threadDrafts: putDraft({ ...request, draftId: request.draftId! }), deliveries: setDelivery(request.threadId, request.draftId!, 'queued') })
      return new Promise(resolve => { sends.set(`${request.threadId}\n${request.draftId}`, resolve) })
    }
    return current
  })
  const threadDrafts = new ThreadDraftStore(command)
  threadDrafts.receive(current)
  const useLive = (): Connection => {
    const state = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => current)
    return { state, command, threadDrafts, error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(), attention: { items: state.queue, show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) } } as Connection
  }
  const sentDraftId = (threadId: string): string => {
    const call = command.mock.calls.map(([request]) => request).findLast(request => (request.type === 'manual-send' || request.type === 'steer') && request.threadId === threadId)
    if (call?.type !== 'manual-send' && call?.type !== 'steer') throw new Error(`No manual send for ${threadId}`)
    return call.draftId!
  }
  return {
    command,
    useLive,
    get state(): AgentState { return current },
    publish,
    threadDrafts,
    heldSaves,
    heldQueue,
    /** Answer the oldest held catalog refresh; null is a failed IPC reply. */
    publishCatalog(catalog: AgentSkillCatalog | null): void { heldCatalogs.shift()?.(catalog) },
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
