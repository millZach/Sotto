// Test-only stand-in for AgentContext: the real Threads page reads a fixture connection instead of main.
import { useSyncExternalStore } from 'react'
import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'

export interface AgentConnection {
  readonly state: AgentState | null
  readonly error: string | null
  readonly command: (command: AgentCommand) => Promise<AgentState | null>
  readonly threadDrafts: ThreadDraftStore
}

let current: AgentState | null = null
const listeners = new Set<() => void>()
const command = async (request: AgentCommand): Promise<AgentState | null> => {
  if (current && request.type === 'select-thread') publishFixtureState({ ...current, activeThreadId: request.threadId })
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
