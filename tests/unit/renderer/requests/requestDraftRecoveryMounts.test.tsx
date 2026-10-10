import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRequest } from '../../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../../src/shared/e2e'
import type { RequestDraft, RequestDraftOwner } from '../../../../src/shared/requestDrafts'
import { useAgents } from '../../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'

vi.mock('../../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/agents/AgentContext')>(),
  useAgents: vi.fn(),
}))

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
    discard: vi.fn(), get: vi.fn(async () => null), status: vi.fn(async () => ({ status: 'missing' as const })),
    save: vi.fn(async (draft: RequestDraft) => draft), check: vi.fn(),
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

    const thread = state.host.threads.find(item => item.id === 'visual-gate')!
    thread.requests = [current]
    vi.mocked(useAgents).mockImplementation(liveAgentState(state).useLive)
    render(<ThreadsView now={E2E_THREADS_NOW} />)
    const recovered = await screen.findByRole('region', { name: 'Saved answer' })
    expect(within(recovered).getByText('Other: Recovered after restart')).toBeVisible()
    expect(within(recovered).queryByRole('button', { name: /send/iu })).toBeNull()
    expect(bridge.list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'thread', ownerId: 'visual-gate' }))
    expect(screen.queryByText('Other: Shown in its live card')).toBeNull()
    expect(screen.getByRole('group', { name: 'Which coast?' })).toBeVisible()
    expect(screen.getAllByRole('region', { name: 'Saved answer' })).toHaveLength(1)
  })

})
