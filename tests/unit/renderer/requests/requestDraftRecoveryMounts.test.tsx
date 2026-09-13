import React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../../src/shared/e2e'
import type { PersonalChat, PersonalChatBridge, PersonalChatState } from '../../../../src/shared/personalChats'
import type { RequestDraft, RequestDraftOwner } from '../../../../src/shared/requestDrafts'
import { useAgents } from '../../../../src/renderer/src/agents/AgentContext'
import { PersonalChatsView } from '../../../../src/renderer/src/agents/personal/PersonalChatsView'
import { PersonalDraftStore } from '../../../../src/renderer/src/agents/personal/personalDrafts'
import { ThreadsView } from '../../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from '../liveAgentState'

vi.mock('../../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const AT = '2026-09-13T17:00:00.000Z'
const form = (id: string, question: string): AgentRequest => ({ id, kind: 'question', text: 'Native form', options: [], questions: [
  { id: 'place', question, multiSelect: false, allowFreeText: true, options: [{ id: 'coast', label: 'Coast' }] },
] })
const vanished = form('vanished-form', 'Where should we go?')
const current = form('live-form', 'Which coast?')

/** Main keeps one answer whose request the provider closed, and one for a request a live card still shows. */
function requestDrafts() {
  const saved = (owner: RequestDraftOwner, request: AgentRequest, text: string): RequestDraft => ({ target: { ...owner, requestId: request.id, questions: request.questions! },
    revision: 2, held: false, selections: { place: { optionIds: [], other: true, text } } })
  const bridge = {
    list: vi.fn(async (owner: RequestDraftOwner) => [saved(owner, vanished, 'Recovered after restart'), saved(owner, current, 'Shown in its live card')]),
    discard: vi.fn(), get: vi.fn(async () => null), save: vi.fn(async (draft: RequestDraft) => draft), check: vi.fn(),
  }
  Object.defineProperty(window, 'sotto', { configurable: true, value: { requestDrafts: bridge } })
  return bridge
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, 'sotto') })

describe('saved answer recovery in its owner view', () => {
  it('appears in the thread pane for the closed request only, with the live form still an ordinary card', async () => {
    const bridge = requestDrafts()
    const state = threadsStateFixture()
    state.assignments = []
    const thread = state.host.threads.find(item => item.id === 'visual-gate')!
    thread.requests = [current]
    vi.mocked(useAgents).mockImplementation(liveAgentState(state).useLive)
    render(<ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} />)
    const recovered = await screen.findByRole('region', { name: 'Saved answer' })
    expect(within(recovered).getByText('Other: Recovered after restart')).toBeVisible()
    expect(within(recovered).queryByRole('button', { name: /send/iu })).toBeNull()
    expect(bridge.list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'thread', ownerId: 'visual-gate' }))
    expect(screen.queryByText('Other: Shown in its live card')).toBeNull()
    expect(screen.getByRole('group', { name: 'Which coast?' })).toBeVisible()
    expect(screen.getAllByRole('region', { name: 'Saved answer' })).toHaveLength(1)
  })

  it('appears in the personal chat, and a disconnected chat does not say the question is gone', async () => {
    const bridge = requestDrafts()
    const chat: PersonalChat = { id: 'trip', kind: 'personal', providerId: 'codex', title: 'Trip ideas', modelId: 'codex:test', createdAt: AT, updatedAt: AT,
      nativeState: 'ready', status: 'idle', requests: [], submissions: [], draft: { revision: 0, text: '', skills: [] }, messages: [] }
    const state: PersonalChatState = { selectedChatId: 'trip', chats: [chat], connected: false, connecting: false, availability: { provider: 'codex', supported: true } }
    const personal = { onState: vi.fn(() => () => undefined), get: vi.fn(async () => state), skills: vi.fn(async () => { throw new Error('offline') }) }
    render(<PersonalChatsView bridge={personal as unknown as PersonalChatBridge} store={new PersonalDraftStore()} now={Date.parse(AT)} />)
    const cards = await waitFor(() => { const found = screen.getAllByRole('region', { name: 'Saved answer' }); expect(found).toHaveLength(2); return found })
    expect(bridge.list).toHaveBeenCalledWith({ kind: 'personal', ownerId: 'trip', providerId: 'codex' })
    expect(within(cards[0]!).getByText('This answer was not sent. Reconnect Codex to see whether its question is still open.')).toBeVisible()
    expect(screen.queryByText(/no longer shows/u)).toBeNull()
  })
})
