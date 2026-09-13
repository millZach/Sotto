import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { requestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const CHOICES = [
  { id: 'once', label: 'Allow once', kind: 'allow-once' as const },
  { id: 'deny', label: 'Deny', kind: 'deny' as const },
]

/** Visual Gate, unmanaged, with its pending permission offering `choices`. */
function permissionState(choices: typeof CHOICES | [] | undefined): AgentState {
  const state = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = 'visual-gate'
  const thread = state.host.threads.find(item => item.id === 'visual-gate')!
  thread.requests = thread.requests.map(request => request.id === 'visual-gate-permission' ? { ...request, ...(choices ? { permissionChoices: choices } : {}) } : request)
  return state
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  return { live, view: render(<ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} />) }
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => {
  cleanup()
  requestAnswerStore.prune('visual-gate', [])
  vi.restoreAllMocks()
})

describe('the composer beside a pending permission', () => {
  it('sends the reader to the provider’s app when Sotto has no choice to send, without repeating itself', () => {
    mount(permissionState([]))
    const prompt = screen.getByRole('textbox', { name: 'Prompt', exact: true })
    expect(prompt).toHaveAttribute('placeholder', 'Waiting on the request above.')
    expect(prompt).toHaveAccessibleDescription(/Sending returns once the request above is answered in .+’s app\./u)
    expect(screen.queryByText(/Allow or deny/u)).not.toBeInTheDocument()
  })

  it.each([['native choices', CHOICES], ['legacy approval', undefined]] as const)('still asks to allow or deny with %s, once', (_name, choices) => {
    const { view } = mount(permissionState(choices))
    const prompt = screen.getByRole('textbox', { name: 'Prompt', exact: true })
    expect(prompt).toHaveAttribute('placeholder', 'Allow or deny the request above to continue.')
    // The empty prompt already says it; the line under the model picker does not say it again.
    const form = prompt.closest('form')!
    expect(within(form).queryByText(/Allow or deny/u)).not.toBeInTheDocument()
    expect(form.querySelector('.thread-prompt__status')).toBeNull()
    // The request stays answerable in its card.
    const card = view.container.querySelector<HTMLElement>('.agent-request')!
    expect(within(card).getAllByRole('button').length).toBeGreaterThan(0)
  })
})

describe('an answer the provider refused', () => {
  const refusal = 'Claude could not accept that decision right now.'

  it('is told once, in its request card, not again above the transcript', async () => {
    const state = permissionState(CHOICES)
    state.error = refusal
    await act(() => requestAnswerStore.submit('visual-gate', 'visual-gate-permission', 'once', async () => ({ error: refusal })))
    mount(state)
    const alerts = screen.getAllByRole('alert').filter(alert => alert.textContent?.includes(refusal))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.closest('.agent-request')).not.toBeNull()
  })

  it('still shows other command errors above the transcript', () => {
    const state = permissionState(CHOICES)
    state.error = 'Could not refresh the thread.'
    mount(state)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh the thread.')
    expect(screen.getByRole('alert').closest('.agent-request')).toBeNull()
  })
})

describe('Jump to latest beside a request card', () => {
  it('steps aside while a card reaches the band it floats over, and returns once the card is clear', () => {
    let tops = new WeakMap<Element, number>()
    let card = { top: 440, bottom: 700 }
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => 4_000)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 500)
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, Math.max(0, Math.min(value, 3_500))) })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.classList.contains('agent-request') ? card : { top: 0, bottom: 500 }
      return { ...box, left: 0, right: 600, width: 600, height: box.bottom - box.top, x: 0, y: box.top, toJSON: () => box } as DOMRect
    })
    mount(permissionState(CHOICES))
    const transcript = screen.getByRole('log', { name: 'Thread transcript' })
    transcript.scrollTop = 0
    fireEvent.scroll(transcript)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument()
    expect(within(transcript).getByRole('button', { name: 'Allow once' })).toBeVisible()

    card = { top: 120, bottom: 400 }
    transcript.scrollTop = 10
    fireEvent.scroll(transcript)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible()
    tops = new WeakMap()
  })
})
