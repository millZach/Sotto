// Review-only stand-in for AgentContext: the real workspace reads a synthetic connection that answers the queue,
// steer, draft and skill-catalog commands in memory. Nothing here reaches a provider; it proves presentation only.
import { useSyncExternalStore } from 'react'
import type { AgentCommand, AgentFollowup, AgentState } from '../../../src/shared/agents'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'

export interface AgentConnection {
  readonly state: AgentState | null
  readonly error: string | null
  readonly command: (command: AgentCommand) => Promise<AgentState | null>
  readonly threadDrafts: ThreadDraftStore
}

declare global { interface Window { phaseTwoCommands?: AgentCommand[] } }

let current: AgentState | null = null
const listeners = new Set<() => void>()
const now = (): string => new Date().toISOString()

function apply(state: AgentState, request: AgentCommand): AgentState {
  const followups = [...(state.followups ?? [])]
  switch (request.type) {
    case 'select-thread': return { ...state, activeThreadId: request.threadId }
    case 'save-thread-draft': {
      const drafts = (state.threadDrafts ?? []).filter(item => item.threadId !== request.threadId)
      if (request.text || request.attachments?.length) drafts.push({ threadId: request.threadId, draftId: request.draftId, text: request.text, attachments: [...(request.attachments ?? [])], ...(request.skills?.length ? { skills: [...request.skills] } : {}), requestId: request.requestId ?? null, updatedAt: now() })
      return { ...state, threadDrafts: drafts }
    }
    case 'queue-followup': {
      const item: AgentFollowup = { id: crypto.randomUUID(), threadId: request.threadId, draftId: request.draftId, text: request.text, attachments: [...(request.attachments ?? [])],
        ...(request.skills?.length ? { skills: [...request.skills] } : {}), createdAt: now(), updatedAt: now(), status: 'queued' }
      return { ...state, followups: [...followups, item], followupReceipts: [...(state.followupReceipts ?? []), { threadId: request.threadId, draftId: request.draftId }],
        threadDrafts: (state.threadDrafts ?? []).filter(item => !(item.threadId === request.threadId && item.draftId === request.draftId)) }
    }
    case 'edit-followup': return { ...state, followups: followups.map(item => item.id === request.itemId ? { ...item, text: request.text, skills: request.skills ? [...request.skills] : item.skills, updatedAt: now() } : item) }
    case 'remove-followup': return { ...state, followups: followups.filter(item => item.id !== request.itemId) }
    case 'reorder-followups': return { ...state, followups: [...request.itemIds.map(id => followups.find(item => item.id === id)!), ...followups.filter(item => item.threadId !== request.threadId)] }
    case 'steer': {
      const threads = state.host.threads.map(thread => thread.id === request.threadId
        ? { ...thread, messages: [...thread.messages, { id: crypto.randomUUID(), role: 'user' as const, text: request.text, createdAt: now() }] } : thread)
      return { ...state, host: { ...state.host, threads }, deliveredDrafts: [...(state.deliveredDrafts ?? []), { threadId: request.threadId, draftId: request.draftId }],
        threadDrafts: (state.threadDrafts ?? []).filter(item => !(item.threadId === request.threadId && item.draftId === request.draftId)) }
    }
    default: return state
  }
}

/** How the synthetic catalog request answers: at once, never (loading), or with no state (request failure). */
export type SkillRequestMode = 'answer' | 'hang' | 'fail'
let skillRequests: SkillRequestMode = 'answer'
export function setSkillRequestMode(mode: SkillRequestMode): void { skillRequests = mode }

const command = async (request: AgentCommand): Promise<AgentState | null> => {
  ;(window.phaseTwoCommands ??= []).push(request)
  if (current === null) return null
  if (request.type === 'refresh-thread-skills') {
    if (skillRequests === 'hang') return new Promise<AgentState | null>(() => undefined)
    if (skillRequests === 'fail') return null
  }
  const next = apply(current, request)
  if (next !== current) publishFixtureState(next)
  return current
}
const threadDrafts = new ThreadDraftStore(command)

export function publishFixtureState(state: AgentState): void {
  current = state
  threadDrafts.receive(state)
  listeners.forEach(listener => listener())
}

export function useAgents() {
  const state = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => current)
  return {
    state, command, threadDrafts, error: null, voice: { status: 'off' as const },
    muteVoice: () => undefined, stopSpeech: () => undefined, retryVoice: () => undefined,
    attention: { items: state?.queue ?? [], show: false, dismiss: () => undefined, reopen: () => undefined, next: async () => undefined },
  }
}
export const useOptionalAgents = useAgents
