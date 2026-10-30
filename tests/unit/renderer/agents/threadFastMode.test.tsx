import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThreadOptions } from '../../../../src/renderer/src/agents/ThreadOptions'
import { PROVIDER_REJECTED_ACTION, PROVIDER_RESULT_UNCONFIRMED, type AgentModel, type AgentState, type AgentThread } from '../../../../src/shared/agents'
import { fixture, LiveThread, mount, setupThreadOptionsTests, withThread } from '../../../fixtures/renderer/threadOptionsHarness'

setupThreadOptionsTests()

/** Fast on both providers, with Codex's own line about the cost and the legacy metadata retained. */
function offering(thread: Partial<AgentThread> = {}, models: (model: AgentModel) => AgentModel = model => model): AgentState {
  const state = fixture(thread)
  state.host.models = state.host.models.map(model => models(model.providerId === 'claude' ? { ...model, fastMode: {}, speeds: [{ id: 'fast', name: 'Fast' }] }
    : model.providerId === 'codex' ? { ...model, fastMode: { description: '2x speed, increased usage' }, speeds: [{ id: 'fast', name: 'Fast', description: '2x speed, increased usage' }] } : model))
  return state
}
/** A Codex thread whose model lists both speeds in Codex's own names and words. */
const bothSpeeds = (thread: Partial<AgentThread> = {}): AgentState => offering({ providerId: 'codex', modelId: 'codex:model', ...thread }, model => model.providerId === 'codex'
  ? { ...model, speeds: [{ id: 'fast', name: 'Fast', description: '2x speed, increased usage' }, { id: 'ultrafast', name: 'Ultrafast', description: '4x speed, highest usage' }] } : model)
const toggle = (): HTMLElement => screen.getByRole('button', { name: /^Thread speed: /u })

describe('speed bolt', () => {
  it('sits after the model chip, at Standard on a new thread, and says what a press costs', () => {
    mount(offering())
    const bolt = toggle()
    expect(bolt).toHaveAccessibleName('Thread speed: Standard')
    expect(bolt).toHaveAttribute('aria-pressed', 'false')
    expect(bolt).toHaveAttribute('title', 'Standard speed. Press for Fast: Up to 2.5x faster output, at twice the price per token.')
    // Model, then speed, then reasoning: the order the eye and the keyboard take.
    const order = [screen.getByRole('combobox', { name: 'Thread model' }), bolt, screen.getByRole('combobox', { name: 'Thread reasoning' })]
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('turns Fast on with one press, which sends the thread\'s speed and keeps focus on the bolt', async () => {
    let commands = 0
    render(<LiveThread start={offering()} answer={async (request, current) => {
      commands += 1
      expect(request).toEqual({ type: 'configure-thread', threadId: 'thread', speed: 'fast' })
      return withThread(current, { speed: 'fast', fastMode: true })
    }} />)
    toggle().focus()
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(commands).toBe(1))
    await waitFor(() => expect(toggle()).toHaveAttribute('title', 'Fast is on for this thread. Up to 2.5x faster output, at twice the price per token. Press for Standard.'))
    expect(toggle()).toHaveFocus()
    expect(toggle()).toHaveAccessibleName('Thread speed: Fast')
  })

  it('reads an older thread\'s fast mode as Fast, goes back to Standard, and uses Codex\'s own words for the cost', async () => {
    const { command } = mount(offering({ providerId: 'codex', modelId: 'codex:model', fastMode: true }))
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(toggle()).toHaveAttribute('title', 'Fast is on for this thread. 2x speed, increased usage. Press for Standard.')
    fireEvent.click(toggle())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', speed: null }))
  })

  it('steps Standard, Fast, Ultra fast and back to Standard where the model offers both, in Codex\'s names', async () => {
    const sent: unknown[] = []
    render(<LiveThread start={bothSpeeds()} answer={async (request, current) => {
      sent.push(request)
      const speed = (request as { speed: AgentThread['speed'] }).speed
      return withThread(current, { speed: speed ?? undefined, fastMode: speed === 'fast' ? true : undefined })
    }} />)
    expect(toggle()).toHaveAttribute('title', 'Standard speed. Press for Fast: 2x speed, increased usage.')
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAttribute('title', 'Fast is on for this thread. 2x speed, increased usage. Press for Ultrafast: 4x speed, highest usage.'))
    expect(toggle()).toHaveAttribute('data-speed', 'fast')
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAccessibleName('Thread speed: Ultrafast'))
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(toggle()).toHaveAttribute('title', 'Ultrafast is on for this thread. 4x speed, highest usage. Press for Standard.')
    expect(toggle().querySelector('.thread-fast__two')).toHaveTextContent('2')
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAccessibleName('Thread speed: Standard'))
    expect(sent).toEqual([{ type: 'configure-thread', threadId: 'thread', speed: 'fast' }, { type: 'configure-thread', threadId: 'thread', speed: 'ultrafast' },
      { type: 'configure-thread', threadId: 'thread', speed: null }])
  })

  it('uses the boolean command to switch Fast on and off on an older host catalog', async () => {
    const sent: unknown[] = []
    render(<LiveThread start={offering({}, model => ({ ...model, speeds: undefined }))} answer={async (request, current) => {
      sent.push(request)
      return withThread(current, { fastMode: (request as { fastMode: boolean }).fastMode })
    }} />)
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAccessibleName('Thread speed: Fast'))
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAccessibleName('Thread speed: Standard'))
    expect(sent).toEqual([{ type: 'configure-thread', threadId: 'thread', fastMode: true }, { type: 'configure-thread', threadId: 'thread', fastMode: false }])
  })

  it('shows Standard where the model lacks the thread\'s chosen speed, which is what runs, and a press goes to the next it offers', async () => {
    const { command } = mount(offering({ providerId: 'codex', modelId: 'codex:model', speed: 'ultrafast' }))
    expect(toggle()).toHaveAccessibleName('Thread speed: Standard')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', speed: 'fast' }))
  })

  it('is not drawn on a model without a speed, though the thread keeps its choice', () => {
    mount(offering({ fastMode: true }, model => model.providerId === 'claude' ? { ...model, fastMode: undefined, speeds: undefined } : model))
    expect(screen.queryByRole('button', { name: /^Thread speed/u })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toBeInTheDocument()
  })

  it('is not drawn for a provider other than Claude Code or Codex, even on a model that says it offers one', () => {
    mount(offering({ providerId: 'grok', modelId: 'grok:model' }, model => ({ ...model, fastMode: {}, speeds: [{ id: 'fast', name: 'Fast' }] })))
    expect(screen.queryByRole('button', { name: /^Thread speed/u })).toBeNull()
  })

  it('is fixed while a turn runs, as the other chips are', () => {
    mount(offering({ status: 'running', nativeSessionStarted: true }))
    expect(toggle()).toBeDisabled()
    expect(toggle()).toHaveAttribute('title', 'Standard speed.')
  })

  it('says a refusal in plain words and puts the bolt back', async () => {
    render(<LiveThread start={offering()} answer={async (_request, current) => ({ ...current, error: PROVIDER_REJECTED_ACTION })} />)
    fireEvent.click(toggle())
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude Code did not switch to Fast. The thread stays on Standard; nothing else changed.')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
  })

  it('says Fast did not come on when a model change carrying it went through without it', async () => {
    // A started thread on a Claude model without fast mode, which kept the choice; Opus offers it.
    const start = offering({ modelId: 'claude:plain', fastMode: true, nativeSessionStarted: true })
    start.host.models = [...start.host.models, { ...start.host.models.find(model => model.id === 'claude:model')!, id: 'claude:plain', name: 'Sonnet 5.5' }]
      .map(model => model.id === 'claude:model' ? { ...model, name: 'Opus 5.5' } : model)
    delete start.host.models.at(-1)!.fastMode
    delete start.host.models.at(-1)!.speeds
    let sent: unknown
    render(<LiveThread start={start} answer={async (request, current) => {
      sent = request
      // Claude Code took the model and refused the fast mode it carried: the thread is on Opus with its choice off.
      return withThread(current, { modelId: 'claude:model', fastMode: undefined })
    }} />)
    expect(screen.queryByRole('button', { name: /^Thread speed/u })).toBeNull()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose model' })).getByRole('option', { name: /Opus 5\.5/u }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Claude Code did not switch to Fast. The thread is on Opus 5.5 at Standard speed.')
    expect(sent).toEqual({ type: 'configure-thread', threadId: 'thread', modelId: 'claude:model' })
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('Opus 5.5')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps an unconfirmed press marked, and says what can still happen meanwhile', async () => {
    render(<LiveThread start={offering()} answer={async (_request, current) => ({ ...current, error: PROVIDER_RESULT_UNCONFIRMED,
      unconfirmedSettings: [{ threadId: 'thread', speed: 'fast' }] })} />)
    fireEvent.click(toggle())
    await waitFor(() => expect(toggle()).toHaveAttribute('data-pending', 'true'))
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Claude Code has not confirmed Fast. Until it does, a turn can still run on Standard.')
    expect(toggle()).toHaveAccessibleDescription('Claude Code has not confirmed Fast. Until it does, a turn can still run on Standard.')
  })
})

// The same setting and confirmation path, drawn in the quiet pill's effort dots.
describe('speed in quiet effort dots', () => {
  function quiet(start = bothSpeeds(), unconfirmed = false) {
    const command = vi.fn()
    function LiveQuiet(): React.ReactElement {
      const [state, setState] = React.useState(start)
      return <ThreadOptions thread={state.host.threads[0]!} state={state} quiet={{ effortScore: 0 }} command={async request => {
        command(request)
        const speed = 'speed' in request ? request.speed ?? undefined : state.host.threads[0]!.speed
        const next = unconfirmed ? { ...state, error: PROVIDER_RESULT_UNCONFIRMED, unconfirmedSettings: [{ threadId: 'thread', speed: 'fast' as const }] }
          : withThread(state, { speed, fastMode: undefined, ...('reasoningEffort' in request ? { reasoningEffort: request.reasoningEffort ?? undefined } : {}) })
        setState(next)
        return next
      }} />
    }
    render(<LiveQuiet />)
    return command
  }
  const dots = (): HTMLElement => screen.getByRole('slider', { name: 'Thread reasoning' })
  const selected = (): HTMLElement => dots().querySelector('[data-level="2"]')!

  it('cycles supported speeds on the selected dot without changing effort or drawing a bolt', async () => {
    const command = quiet()
    expect(screen.queryByRole('button', { name: /^Thread speed/u })).toBeNull()
    expect(dots()).toHaveAttribute('aria-valuetext', 'High · Standard')
    fireEvent.click(selected())
    await waitFor(() => expect(dots()).toHaveAttribute('aria-valuetext', 'High · Fast'))
    expect(selected()).toHaveAttribute('title', 'High · Fast. Fast is on for this thread. 2x speed, increased usage. Press for Ultrafast: 4x speed, highest usage.')
    expect(dots().querySelector('[data-level="1"]')).toHaveAttribute('title', 'Medium · Fast')
    expect([...dots().querySelectorAll('i')].filter(dot => dot !== selected()).map(dot => dot.title))
      .toEqual(['Low · Fast', 'Medium · Fast', 'Extra high · Fast', 'Max · Fast'])
    fireEvent.click(selected())
    await waitFor(() => expect(dots()).toHaveAttribute('aria-valuetext', 'High · Ultrafast'))
    expect(dots().closest('.effort-dots')).toHaveAttribute('data-speed', 'ultrafast')
    fireEvent.click(selected())
    await waitFor(() => expect(dots()).toHaveAttribute('aria-valuetext', 'High · Standard'))
    expect(command.mock.calls.map(call => call[0])).toEqual(['fast', 'ultrafast', null].map(speed => ({ type: 'configure-thread', threadId: 'thread', speed })))
  })

  it('uses Alt arrows for speed in either direction and plain arrows for effort', async () => {
    const command = quiet()
    dots().focus()
    fireEvent.keyDown(dots(), { key: 'ArrowDown', altKey: true })
    await waitFor(() => expect(dots()).toHaveAttribute('aria-valuetext', 'High · Ultrafast'))
    fireEvent.keyDown(dots(), { key: 'ArrowUp', altKey: true })
    await waitFor(() => expect(dots()).toHaveAttribute('aria-valuetext', 'High · Standard'))
    fireEvent.keyDown(dots(), { key: 'ArrowLeft' })
    await waitFor(() => expect(dots()).toHaveAttribute('aria-valuetext', 'Medium · Standard'))
    expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'medium' })
    expect(dots()).toHaveFocus()
  })

  it('keeps a model with no speed tiers in its provider colour and names each effort', () => {
    const command = quiet(offering({}, model => ({ ...model, speeds: [], fastMode: undefined })))
    expect(dots().closest('.effort-dots')).not.toHaveAttribute('data-speed')
    expect(selected()).toHaveAttribute('title', 'High')
    fireEvent.click(selected())
    expect(command).not.toHaveBeenCalled()
  })

  it('keeps speed fixed while running and exposes the selected permission for its shield', () => {
    const command = quiet(bothSpeeds({ speed: 'ultrafast', status: 'running', nativeSessionStarted: true, runtimeMode: 'full-access' }))
    expect(dots()).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toHaveAttribute('data-permission', 'full-access')
    fireEvent.click(selected())
    fireEvent.keyDown(dots(), { key: 'ArrowUp', altKey: true })
    expect(command).not.toHaveBeenCalled()
  })

  it('announces an unconfirmed speed through the dots', async () => {
    quiet(bothSpeeds(), true)
    fireEvent.click(selected())
    await waitFor(() => expect(dots()).toHaveAccessibleDescription('Codex has not confirmed Fast. Until it does, a turn can still run on Standard.'))
    expect(dots().closest('.effort-dots')).toHaveAttribute('data-pending', 'true')
  })
})
