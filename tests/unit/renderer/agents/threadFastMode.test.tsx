import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PROVIDER_REJECTED_ACTION, PROVIDER_RESULT_UNCONFIRMED, type AgentModel, type AgentState, type AgentThread } from '../../../../src/shared/agents'
import { fixture, LiveThread, mount, setupThreadOptionsTests, withThread } from '../../../fixtures/renderer/threadOptionsHarness'

setupThreadOptionsTests()

/** The harness's state with fast mode offered on Claude's and Codex's models, Codex's with its own line about the cost. */
function offering(thread: Partial<AgentThread> = {}, models: (model: AgentModel) => AgentModel = model => model): AgentState {
  const state = fixture(thread)
  state.host.models = state.host.models.map(model => models(model.providerId === 'claude' ? { ...model, fastMode: {} }
    : model.providerId === 'codex' ? { ...model, fastMode: { description: '2x speed, increased usage' } } : model))
  return state
}
const toggle = (): HTMLElement => screen.getByRole('button', { name: 'Fast mode' })

describe('fast mode toggle', () => {
  it('sits after the model chip, off on a new thread, and says what it costs', () => {
    mount(offering())
    const bolt = toggle()
    expect(bolt).toHaveAttribute('aria-pressed', 'false')
    expect(bolt).toHaveAttribute('title', 'Fast mode is off. Up to 2.5x faster output, at twice the price per token. Press to turn it on for this thread.')
    // Model, then fast mode, then reasoning: the order the eye and the keyboard take.
    const order = [screen.getByRole('combobox', { name: 'Thread model' }), bolt, screen.getByRole('combobox', { name: 'Thread reasoning' })]
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('turns on with one press, which sends the thread\'s fast mode and keeps focus on the toggle', async () => {
    let commands = 0
    render(<LiveThread start={offering()} answer={async (request, current) => {
      commands += 1
      expect(request).toEqual({ type: 'configure-thread', threadId: 'thread', fastMode: true })
      return withThread(current, { fastMode: true })
    }} />)
    toggle().focus()
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(commands).toBe(1))
    await waitFor(() => expect(toggle()).toHaveAttribute('title', 'Fast mode is on for this thread. Up to 2.5x faster output, at twice the price per token. Press to turn it off.'))
    expect(toggle()).toHaveFocus()
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
  })

  it('turns off from on, and uses Codex\'s own words for the cost', async () => {
    const { command } = mount(offering({ providerId: 'codex', modelId: 'codex:model', fastMode: true }))
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(toggle()).toHaveAttribute('title', 'Fast mode is on for this thread. 2x speed, increased usage. Press to turn it off.')
    fireEvent.click(toggle())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', fastMode: false }))
  })

  it('is not drawn on a model without fast mode, though the thread keeps its choice', () => {
    mount(offering({ fastMode: true }, model => model.providerId === 'claude' ? { ...model, fastMode: undefined } : model))
    expect(screen.queryByRole('button', { name: 'Fast mode' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toBeInTheDocument()
  })

  it('is not drawn for a provider other than Claude Code or Codex, even on a model that says it offers it', () => {
    mount(offering({ providerId: 'grok', modelId: 'grok:model' }, model => ({ ...model, fastMode: {} })))
    expect(screen.queryByRole('button', { name: 'Fast mode' })).toBeNull()
  })

  it('is fixed while a turn runs, as the other chips are', () => {
    mount(offering({ status: 'running', nativeSessionStarted: true }))
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAttribute('title', 'Fast mode is off. Up to 2.5x faster output, at twice the price per token.')
  })

  it('says a refusal in plain words and puts the toggle back', async () => {
    render(<LiveThread start={offering()} answer={async (_request, current) => ({ ...current, error: PROVIDER_REJECTED_ACTION })} />)
    fireEvent.click(toggle())
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude Code did not switch fast mode on. The thread stays at normal speed; nothing else changed.')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
  })

  it('says fast mode did not come on when a model change carrying it went through without it', async () => {
    // A started thread on a Claude model without fast mode, which kept the choice; Opus offers it.
    const start = offering({ modelId: 'claude:plain', fastMode: true, nativeSessionStarted: true })
    start.host.models = [...start.host.models, { ...start.host.models.find(model => model.id === 'claude:model')!, id: 'claude:plain', name: 'Sonnet 5.5' }]
      .map(model => model.id === 'claude:model' ? { ...model, name: 'Opus 5.5' } : model)
    delete start.host.models.at(-1)!.fastMode
    let sent: unknown
    render(<LiveThread start={start} answer={async (request, current) => {
      sent = request
      // Claude Code took the model and refused the fast mode it carried: the thread is on Opus with its choice off.
      return withThread(current, { modelId: 'claude:model', fastMode: undefined })
    }} />)
    expect(screen.queryByRole('button', { name: 'Fast mode' })).toBeNull()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose model' })).getByRole('option', { name: /Opus 5\.5/u }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude Code did not switch fast mode on. The thread is on Opus 5.5 at normal speed.')
    expect(sent).toEqual({ type: 'configure-thread', threadId: 'thread', modelId: 'claude:model' })
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('Opus 5.5')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps an unconfirmed press marked, and says what can still happen meanwhile', async () => {
    render(<LiveThread start={offering()} answer={async (_request, current) => ({ ...current, error: PROVIDER_RESULT_UNCONFIRMED,
      unconfirmedSettings: [{ threadId: 'thread', fastMode: true }] })} />)
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAttribute('data-pending', 'true'))
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Claude Code has not confirmed fast mode. Until it does, a turn can still run at normal speed.')
    expect(toggle()).toHaveAccessibleDescription('Claude Code has not confirmed fast mode. Until it does, a turn can still run at normal speed.')
  })
})
