import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, PROVIDER_LABELS, PROVIDER_REJECTED_ACTION, PROVIDER_RESULT_UNCONFIRMED, providerIdSchema, type AgentCommand, type AgentState, type AgentThread } from '../../../src/shared/agents'
import type { AgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { permissionInForceCaption, settingRefusalText, ThreadOptionFields, unconfirmedSettingText, ThreadOptions, threadOptionsSummary } from '../../../src/renderer/src/agents/ThreadOptions'
import { pendingSettingsStore } from '../../../src/renderer/src/agents/pendingSettings'

const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
function fixture(thread: Partial<AgentThread> = {}): AgentState {
  return {
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'claude', 'grok'] }, connection: 'connected',
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [],
      providers: providerIdSchema.options.map(id => ({ id, name: PROVIDER_LABELS[id], version: '1.2.3', connection: 'connected', capabilities: caps })),
      models: providerIdSchema.options.map(id => ({ id: `${id}:model`, name: `${PROVIDER_LABELS[id]} model`, provider: PROVIDER_LABELS[id], providerId: id, ready: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium', runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] })),
      threads: [{ id: 'thread', providerId: 'claude', projectId: 'project', title: 'Claude work', modelId: 'claude:model', status: 'idle', messages: [], requests: [], nativeSessionStarted: false, reasoningEffort: 'high', runtimeMode: 'auto', ...thread }],
    }, assignments: [], queue: [], activeThreadId: 'thread', activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [], membership: { status: 'beta', label: 'Test', expiresAt: null },
  }
}
function mount(state = fixture()) {
  const command = vi.fn(async () => state)
  render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
  return { command }
}

/**
 * The chips over a thread whose settings actually move when a command is confirmed, the way `AgentContext`
 * moves them: main's answer is applied to the state before the command's own promise resolves. Tests that
 * care what the control shows before and after a confirmation need that, because a static fixture confirms a
 * change and then reports the level it always had.
 */
function Live({ answer }: { answer: (effort: string) => Promise<AgentState | null> }): React.ReactElement {
  const [state, setState] = React.useState(fixture)
  const command: AgentConnection['command'] = async request => {
    const next = await answer('reasoningEffort' in request ? request.reasoningEffort ?? '' : '')
    if (next) setState(next)
    return next
  }
  return <ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />
}
/**
 * The chips over a thread whose state moves when main answers, for any setting. `answer` gets each command and the
 * state the window holds, and returns the state main answers with; the window takes it before the command's own
 * promise resolves, as `AgentContext` does, unless `draw` is false, which is a reply that landed before the broadcast
 * carrying it (#306). `redraw` then commits a state the way that later broadcast would.
 */
function LiveThread({ answer, draw = true, start = fixture(), redraw }: {
  answer: (request: AgentCommand, current: AgentState) => Promise<AgentState | null>; draw?: boolean; start?: AgentState
  redraw?: (commit: (next: AgentState) => void) => void
}): React.ReactElement {
  const [state, setState] = React.useState(start)
  const current = React.useRef(state)
  current.current = state
  React.useEffect(() => { redraw?.(setState) }, [redraw])
  const command: AgentConnection['command'] = async request => {
    const next = await answer(request, current.current)
    if (next && draw) setState(next)
    return next
  }
  return <ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />
}
const withThread = (state: AgentState, patch: Partial<AgentThread>): AgentState =>
  ({ ...state, error: null, host: { ...state.host, threads: [{ ...state.host.threads[0]!, ...patch }] } })
afterEach(() => { cleanup(); pendingSettingsStore.clear() })

describe('composer option chips', () => {
  it('shows the model with its provider mark, the effort and the permissions as three chips', () => {
    mount()
    const model = screen.getByRole('combobox', { name: 'Thread model' })
    expect(model).toHaveTextContent('Claude Code model')
    expect(model.querySelector('svg.provider-mark[data-provider="claude"]')).not.toBeNull()
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('High')
    expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toHaveTextContent('Auto')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens the effort card at the current level, says what the level costs, and saves a step without closing', async () => {
    const { command } = mount()
    const chip = screen.getByRole('combobox', { name: 'Thread reasoning' })
    fireEvent.click(chip)
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    const slider = within(panel).getByRole('slider', { name: 'Thread reasoning effort' })
    expect(slider).toHaveAttribute('aria-valuetext', 'High')
    expect(slider).toHaveFocus()
    expect(slider).toHaveAccessibleDescription('Takes longer and catches more.')
    // The word is set letter by letter so the arrival can light it in turn; read whole, it is the level.
    expect(panel.querySelector('.effort-card__word')).toHaveTextContent(/^High$/u)
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'xhigh' }))
    expect(panel).toBeInTheDocument()
    fireEvent.keyDown(slider, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Reasoning effort' })).toBeNull()
    expect(chip).toHaveFocus()
  })

  it('jumps to a level by its digit and returns to the model default from the Default button', async () => {
    const { command } = mount()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.keyDown(slider, { key: '5' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'max' }))
    const reset = screen.getByRole('button', { name: 'Default' })
    expect(reset).toHaveAttribute('title', "Use Claude Code model's default, Medium")
    fireEvent.click(reset)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'medium' }))
  })

  it('marks the chip and the card at the model’s highest level, and plays the arrival once on reaching it', async () => {
    const state = fixture()
    const command = vi.fn(async () => state)
    const { rerender } = render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    const chip = screen.getByRole('combobox', { name: 'Thread reasoning' })
    expect(chip).toHaveAttribute('data-effort-top', 'false')
    fireEvent.click(chip)
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    expect(panel).toHaveAttribute('data-top', 'false')
    // The line under the word fits the card's width at every level; the Electron spec measures that it does.
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: '4' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'xhigh' }))
    state.host.threads[0]!.reasoningEffort = 'xhigh'
    rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    expect(screen.getByRole('slider', { name: 'Thread reasoning effort' })).toHaveAccessibleDescription('Much longer. For stubborn problems.')
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: 'End' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'max' }))
    state.host.threads[0]!.reasoningEffort = 'max'
    rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    expect(chip).toHaveAttribute('data-effort-top', 'true')
    expect(panel).toHaveAttribute('data-top', 'true')
    expect(panel).toHaveAttribute('data-arriving', 'true')
    expect(screen.getByRole('slider', { name: 'Thread reasoning effort' })).toHaveAccessibleDescription('Everything the model has. Slowest, costliest.')
    // The arrival belongs to the chip's wrapper, which the composer reads, so closing the card does not cut the tide short.
    const anchor = chip.closest('.effort-picker-anchor')!
    expect(anchor).toHaveAttribute('data-effort-arriving', 'true')
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Reasoning effort' })).toBeNull()
    expect(anchor).toHaveAttribute('data-effort-arriving', 'true')
    fireEvent.click(chip)
    expect(screen.getByRole('dialog', { name: 'Reasoning effort' })).toHaveAttribute('data-arriving', 'true')
    // Lowering the level ends the arrival at once; the Electron spec watches it run its course.
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: 'Home' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'low' }))
    state.host.threads[0]!.reasoningEffort = 'low'
    rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    const reopened = screen.getByRole('dialog', { name: 'Reasoning effort' })
    expect(reopened).toHaveAttribute('data-arriving', 'false')
    expect(reopened).toHaveAttribute('data-top', 'false')
    expect(anchor).toHaveAttribute('data-effort-arriving', 'false')
    expect(chip).toHaveAttribute('data-effort-top', 'false')
  })

  it('shows the settled state without an arrival when the card opens already at the highest level', () => {
    mount(fixture({ reasoningEffort: 'max' }))
    const chip = screen.getByRole('combobox', { name: 'Thread reasoning' })
    expect(chip).toHaveAttribute('data-effort-top', 'true')
    fireEvent.click(chip)
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    expect(panel).toHaveAttribute('data-top', 'true')
    expect(panel).toHaveAttribute('data-arriving', 'false')
  })

  it('closes the effort panel when focus leaves it by Tab', () => {
    mount()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    fireEvent.blur(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { relatedTarget: screen.getByRole('combobox', { name: 'Thread permissions' }) })
    expect(screen.queryByRole('dialog', { name: 'Reasoning effort' })).toBeNull()
  })

  it('offers Ultra only when the selected provider model advertises it', async () => {
    const state = fixture({ providerId: 'codex', modelId: 'codex:model' })
    state.host.models.find(model => model.id === 'codex:model')!.reasoningEfforts!.push('ultra')
    const { command } = mount(state)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    expect(slider).toHaveAttribute('max', '5')
    fireEvent.keyDown(slider, { key: 'End' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'ultra' }))
    cleanup()
    mount()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(screen.getByRole('slider', { name: 'Thread reasoning effort' })).toHaveAttribute('max', '4')
  })

  it('keeps the confirmed setting and allows retry when a settings command rejects', async () => {
    const state = fixture()
    const command = vi.fn().mockRejectedValueOnce(new Error('Transport closed')).mockResolvedValue(state)
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.keyDown(slider, { key: 'End' })
    expect(await screen.findByRole('alert')).toHaveTextContent("Sotto did not get Claude Code's answer about Max effort, so the chip shows what the thread last reported. Try again to send it once more.")
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('High')
    expect(screen.getByRole('dialog', { name: 'Reasoning effort' })).toBeInTheDocument()
    expect(slider).toHaveValue('2')
    fireEvent.keyDown(slider, { key: 'End' })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('keeps the effort card mounted and live while a selection is being confirmed', async () => {
    const state = fixture()
    let release!: () => void
    const command = vi.fn(() => new Promise<typeof state>(resolve => { release = () => resolve(state) }))
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.keyDown(slider, { key: 'End' })
    expect(panel).toBeInTheDocument()
    // Nothing waits for the provider: every chip shows a press at once, so every chip has to take another.
    expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toBeEnabled()
    expect(screen.queryByText('Saving...')).toBeNull()
    expect(slider).not.toHaveAttribute('aria-disabled', 'true')
    expect(command).toHaveBeenCalledTimes(1)
    await act(async () => { release() })
    expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toBeEnabled()
    expect(panel).toBeInTheDocument()
  })

  it('shows the level pressed before the provider has confirmed it, and holds it when the answer lands', async () => {
    let release!: () => void
    const asked: string[] = []
    render(<Live answer={async effort => {
      asked.push(effort)
      await new Promise<void>(resolve => { release = resolve })
      return fixture({ reasoningEffort: effort })
    }} />)
    const chip = screen.getByRole('combobox', { name: 'Thread reasoning' })
    fireEvent.click(chip)
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.keyDown(slider, { key: 'End' })
    // Nothing is confirmed yet, and the whole control has already moved: the word, the line, the chip and the
    // top mark that lights the composer are the press itself rather than the provider's answer.
    expect(panel.querySelector('.effort-card__word')).toHaveTextContent(/^Max$/u)
    expect(slider).toHaveAccessibleDescription('Everything the model has. Slowest, costliest.')
    expect(chip).toHaveTextContent('Max')
    expect(chip).toHaveAttribute('data-effort-top', 'true')
    expect(asked).toEqual(['max'])
    await act(async () => { release() })
    // The answer agrees with the press, so nothing moves on the way: no frame shows the level it came from.
    expect(chip).toHaveTextContent('Max')
    expect(panel.querySelector('.effort-card__word')).toHaveTextContent(/^Max$/u)
    expect(slider).toHaveValue('4')
  })

  it('shows the level the provider settled on when it answers with one of its own', async () => {
    let release!: () => void
    render(<Live answer={async () => {
      await new Promise<void>(resolve => { release = resolve })
      // Taken, but the thread is left on a level of the provider's choosing rather than the one asked for.
      return fixture({ reasoningEffort: 'medium' })
    }} />)
    const chip = screen.getByRole('combobox', { name: 'Thread reasoning' })
    fireEvent.click(chip)
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.keyDown(slider, { key: 'End' })
    expect(chip).toHaveTextContent('Max')
    await act(async () => { release() })
    // The provider has spoken, so the press is let go of even though it was not refused.
    expect(chip).toHaveTextContent('Medium')
    expect(slider).toHaveValue('1')
  })

  it('saves where the levels stop rather than every level crossed while a save is in flight', async () => {
    const releases: Array<() => void> = []
    const asked: string[] = []
    render(<Live answer={async effort => {
      asked.push(effort)
      await new Promise<void>(resolve => { releases.push(resolve) })
      return fixture({ reasoningEffort: effort })
    }} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.keyDown(slider, { key: 'End' })
    expect(asked).toEqual(['max'])
    // Two more presses while the provider is still answering the first. A provider refuses a second settings
    // change while one is in flight, so the levels crossed are shown and only the last one is sent.
    fireEvent.keyDown(slider, { key: 'Home' })
    fireEvent.keyDown(slider, { key: '2' })
    expect(asked).toEqual(['max'])
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Medium')
    await act(async () => { releases[0]!() })
    expect(asked).toEqual(['max', 'medium'])
    await act(async () => { releases[1]!() })
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Medium')
    expect(slider).toHaveValue('1')
  })

  it('preserves an unavailable saved level until the user chooses a supported one', () => {
    const { command } = mount(fixture({ reasoningEffort: 'legacy' }))
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Legacy')
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(command).not.toHaveBeenCalled()
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    expect(panel).toHaveAttribute('data-unknown', 'true')
    expect(screen.getByRole('slider', { name: 'Thread reasoning effort' })).toHaveAccessibleDescription('Legacy is set. Choose a level this model offers.')
  })

  it('retains the open effort card when a provider-default choice is confirmed', async () => {
    const state = fixture()
    delete state.host.threads[0]!.reasoningEffort
    delete state.host.models.find(model => model.id === 'claude:model')!.defaultReasoningEffort
    const command = vi.fn(async () => state)
    const { rerender } = render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    expect(screen.queryByRole('button', { name: 'Default' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: '3' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'high' }))
    state.host.threads[0]!.reasoningEffort = 'high'
    rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    expect(screen.getByRole('dialog', { name: 'Reasoning effort' })).toBe(panel)
  })

  it('adds Ultrathink visibly to a Claude draft without changing thread settings', () => {
    const state = fixture()
    const command = vi.fn(async () => state)
    const onDraftText = vi.fn()
    let draftText = 'Review this plan.'
    const { rerender } = render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} getDraftText={() => draftText} onDraftText={onDraftText} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    // Typing does not render these controls again; the click must read the current draft.
    draftText = 'Review this plan and the latest edit.'
    fireEvent.click(screen.getByRole('button', { name: 'Add Ultrathink to prompt' }))
    expect(onDraftText).toHaveBeenCalledWith('Review this plan and the latest edit.\n\nultrathink')
    expect(command).not.toHaveBeenCalled()
    rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} getDraftText={() => 'Review this plan. ULTRATHINK'} onDraftText={onDraftText} />)
    if (!screen.queryByRole('dialog', { name: 'Reasoning effort' })) fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const included = screen.getByRole('button', { name: 'Ultrathink is in this prompt' })
    fireEvent.click(included)
    expect(onDraftText).toHaveBeenCalledTimes(1)
  })

  it('keeps a single supported level stable at both keyboard endpoints', () => {
    const state = fixture()
    state.host.models.find(model => model.id === 'claude:model')!.reasoningEfforts = ['high']
    const { command } = mount(state)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.keyDown(slider, { key: 'End' })
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(slider).toHaveValue('0')
    expect(slider).toHaveAttribute('aria-valuetext', 'High')
    // One level is not a highest level: nothing tints and nothing arrives.
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveAttribute('data-effort-top', 'false')
    expect(command).not.toHaveBeenCalled()
  })

  it('restores the confirmed effort if the thread becomes busy during a drag', () => {
    const state = fixture({ nativeSessionStarted: true })
    const command = vi.fn(async () => state)
    const { rerender } = render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    fireEvent.pointerDown(slider)
    fireEvent.change(slider, { target: { value: '3.8' } })
    expect(slider).toHaveAttribute('aria-valuetext', 'Max')
    state.host.threads[0]!.status = 'running'
    rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.pointerUp(slider)
    expect(slider).toHaveValue('2')
    expect(slider).toHaveAttribute('aria-valuetext', 'High')
    expect(command).not.toHaveBeenCalled()
  })

  it('does not offer a draft action without an editable Claude prompt', () => {
    mount()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(screen.queryByRole('button', { name: 'Add Ultrathink to prompt' })).toBeNull()
    cleanup()
    const state = fixture({ providerId: 'codex', modelId: 'codex:model' })
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={vi.fn()} getDraftText={() => "Review this."} onDraftText={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(screen.queryByRole('button', { name: 'Add Ultrathink to prompt' })).toBeNull()
  })

  it('keeps focus on the chip through a save, and puts it back if it went to the page meanwhile', async () => {
    let release!: () => void
    const state = fixture()
    const command = vi.fn(() => new Promise<typeof state>(resolve => { release = () => resolve(state) }))
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread permissions' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full access' }))
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    // The chip stays live through its save, and the choice hands focus straight back to it.
    expect(chip).toBeEnabled()
    expect(chip).toHaveFocus()
    // Something else takes focus to the page while the provider answers (Chromium does this for a control that
    // goes away or is disabled under it; jsdom never does, so the drop is made explicit).
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere); elsewhere.focus(); elsewhere.remove()
    expect(chip).not.toHaveFocus()
    // Flush the confirmation's render and focus effect together; an enabled DOM
    // button alone does not mean React has run its passive focus-restoration effect.
    await act(async () => { release() })
    expect(chip).toBeEnabled()
    expect(chip).toHaveFocus()
  })

  it('closes an open list on Escape and hands focus back to its chip without saving', () => {
    const { command } = mount()
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    fireEvent.click(chip)
    const list = screen.getByRole('listbox', { name: 'Thread permissions' })
    fireEvent.keyDown(within(list).getByRole('option', { name: 'Auto' }), { key: 'ArrowDown' })
    expect(within(list).getByRole('option', { name: 'Full access' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(chip).toHaveFocus()
    expect(command).not.toHaveBeenCalled()
  })

  it('names the setting on a chip the provider has not set and lists the default as unchoosable', () => {
    const state = fixture()
    delete state.host.threads[0]!.runtimeMode
    delete state.host.threads[0]!.reasoningEffort
    mount(state)
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Medium')
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    expect(chip).toHaveTextContent('Permissions')
    fireEvent.click(chip)
    const option = screen.getByRole('option', { name: 'Provider default' })
    expect(option).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Ask for approval' })).toHaveFocus()
  })

  it("offers a provider's own permission modes, each saying what Sotto still asks about", async () => {
    const state = fixture({ providerId: 'devin', modelId: 'devin:model', providerMode: 'ask-first' })
    const devin = state.host.models.find(model => model.id === 'devin:model')!
    Object.assign(devin, { runtimeModes: [], providerModes: [
      { id: 'ask-first', name: 'Ask first', description: 'Devin writes code and Sotto asks you first.', asks: 'Sotto asks before every edit, command and fetch.' },
      { id: 'bypass', name: 'Bypass permissions', description: 'Auto-approve all tool calls.', asks: 'Sotto asks about nothing. Devin acts without asking you.' },
    ] })
    const { command } = mount(state)
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    expect(chip).toHaveTextContent('Ask first')
    fireEvent.click(chip)
    // The one sentence that keeps "Bypass permissions" from reading as Sotto having stopped asking.
    expect(screen.getByRole('option', { name: /Bypass permissions/ })).toHaveTextContent('Sotto asks about nothing')
    expect(screen.queryByRole('option', { name: 'Ask for approval' })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: /Bypass permissions/ }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', providerMode: 'bypass' }))
  })

  it('shows an unchosen provider mode as the one the thread starts on, never as a provider default', () => {
    const model = { id: 'devin:model', name: 'Devin model', provider: 'Devin', providerId: 'devin' as const, ready: true, runtimeModes: [],
      providerModes: [{ id: 'ask-first', name: 'Ask first', asks: 'Sotto asks before every edit, command and fetch.' }, { id: 'bypass', name: 'Bypass Permissions' }] }
    expect(threadOptionsSummary(model, undefined, undefined, undefined)).toBe('Devin model · Ask first')
    render(<ThreadOptionFields models={[model]} modelId="devin:model" onModel={vi.fn()} onReasoning={vi.fn()} onRuntime={vi.fn()} onProviderMode={vi.fn()} />)
    const permissions = screen.getByRole('combobox', { name: 'Thread permissions' })
    expect(permissions).toHaveValue('ask-first')
    expect(within(permissions).queryByRole('option', { name: 'Provider default' })).toBeNull()
  })

  it('offers every provider on the rail with the reminder while the thread has not sent, and its own alone after', () => {
    mount()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const menu = screen.getByRole('dialog', { name: 'Choose model' })
    expect(within(menu).getByRole('tablist', { name: 'Model providers' })).toBeVisible()
    expect(within(menu).getByText('Any provider until your first message.')).toBeVisible()
    cleanup()
    mount(fixture({ nativeSessionStarted: true }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const started = screen.getByRole('dialog', { name: 'Choose model' })
    expect(within(started).queryByRole('tablist')).toBeNull()
    expect(within(started).getByText('This thread stays with Claude Code.')).toBeVisible()
    expect(within(started).getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Code model'])
  })
})

describe('a pending setting', () => {
  it('shows a permission choice at once, marked as pending with what is still in force, until the window draws it', async () => {
    let release!: () => void
    render(<LiveThread answer={async (request, current) => {
      await new Promise<void>(resolve => { release = resolve })
      return withThread(current, { runtimeMode: (request as { runtimeMode: AgentThread['runtimeMode'] }).runtimeMode })
    }} start={fixture({ runtimeMode: 'approval-required' })} />)
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    expect(chip).not.toHaveAttribute('data-pending')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('option', { name: 'Full access' }))
    // The press is the chip's word from this frame on; the provider has not answered yet.
    expect(chip).toHaveTextContent('Full access')
    expect(chip).toHaveAttribute('data-pending', 'true')
    expect(chip.querySelector('.thread-chip__pending')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Claude Code still asks for approval until it confirms.')
    // The chip is described by the caption itself, so the words are the ones on screen, said once.
    expect(chip).toHaveAccessibleDescription('Claude Code still asks for approval until it confirms.')
    expect(chip).toBeEnabled()
    fireEvent.click(chip)
    expect(screen.getByRole('option', { name: 'Full access' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await act(async () => { release() })
    expect(chip).toHaveTextContent('Full access')
    expect(chip).not.toHaveAttribute('data-pending')
    expect(chip).not.toHaveAccessibleDescription(/until it confirms/u)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the pending mark until the state that confirms it is drawn, when the reply lands first', async () => {
    let commit!: (next: AgentState) => void
    const start = fixture({ runtimeMode: 'approval-required' })
    const confirmed = withThread(start, { runtimeMode: 'full-access' })
    render(<LiveThread draw={false} start={start} redraw={set => { commit = set }} answer={async () => confirmed} />)
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    fireEvent.click(chip)
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Full access' })) })
    // Main has answered; the window has not drawn the broadcast that says so, so nothing is confirmed on screen yet.
    expect(chip).toHaveTextContent('Full access')
    expect(chip).toHaveAttribute('data-pending', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Claude Code still asks for approval until it confirms.')
    act(() => { commit(confirmed) })
    expect(chip).toHaveTextContent('Full access')
    expect(chip).not.toHaveAttribute('data-pending')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('puts a refused permission back, says nothing else changed for a plain refusal, and tries again from the alert', async () => {
    const asked: AgentCommand[] = []
    let refuse = true
    render(<LiveThread start={fixture({ runtimeMode: 'approval-required' })} answer={async (request, current) => {
      asked.push(request)
      return refuse ? { ...current, error: PROVIDER_REJECTED_ACTION } : withThread(current, { runtimeMode: 'full-access' })
    }} />)
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    fireEvent.click(chip)
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Full access' })) })
    expect(chip).toHaveTextContent('Ask for approval')
    expect(chip).not.toHaveAttribute('data-pending')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Claude Code did not switch to Full access. The thread stays on Ask for approval; nothing else changed.')
    refuse = false
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: 'Try again' })) })
    expect(asked).toEqual([
      { type: 'configure-thread', threadId: 'thread', runtimeMode: 'full-access' },
      { type: 'configure-thread', threadId: 'thread', runtimeMode: 'full-access' },
    ])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(chip).toHaveTextContent('Full access')
    expect(chip).toHaveFocus()
  })

  it('keeps a choice the provider never answered on the chip, says what comes next, and offers nothing to press', async () => {
    const lost = 'Claude Code did not confirm the settings change, so Sotto stopped this thread\'s session, and "npm test" stopped with it. The session starts again with the new settings the next time you use the thread.'
    let commit!: (next: AgentState) => void
    const start = fixture({ runtimeMode: 'approval-required' })
    render(<LiveThread start={start} redraw={set => { commit = set }}
      answer={async (_request, current) => ({ ...current, error: lost, unconfirmedSettings: [{ threadId: 'thread', runtimeMode: 'auto' }] })} />)
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    fireEvent.click(chip)
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Auto' })) })
    // Main keeps the change for the thread's next start, so the chip keeps it, still marked as not confirmed.
    expect(chip).toHaveTextContent('Auto')
    expect(chip).toHaveAttribute('data-pending', 'true')
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent(`Claude Code has not confirmed Auto. ${lost}`)
    expect(notice).not.toHaveTextContent('did not switch')
    expect(within(notice).queryByRole('button')).toBeNull()
    expect(chip).toHaveAccessibleDescription(`Claude Code has not confirmed Auto. ${lost}`)
    // Nothing else goes to the thread until main knows, so the chips wait with it.
    expect(chip).toBeDisabled()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    // The thread's next start carries it: the thread shows Auto and main lets the change go.
    act(() => { commit(withThread(start, { runtimeMode: 'auto' })) })
    expect(chip).toHaveTextContent('Auto')
    expect(chip).not.toHaveAttribute('data-pending')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(chip).toBeEnabled()
  })

  it('keeps a refusal under the chips while another chip is pressed', async () => {
    render(<LiveThread start={fixture({ runtimeMode: 'approval-required', reasoningEffort: 'high' })} answer={async (request, current) =>
      'runtimeMode' in request ? { ...current, error: PROVIDER_REJECTED_ACTION } : withThread(current, { reasoningEffort: (request as { reasoningEffort: string }).reasoningEffort })} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread permissions' }))
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Full access' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('The thread stays on Ask for approval')
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    await act(async () => { fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: 'End' }) })
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Max')
    expect(screen.getByRole('alert')).toHaveTextContent('Claude Code did not switch to Full access.')
  })

  it('fixes the chips while a prompt is on its way to the provider, and not for their own save', async () => {
    const start = fixture()
    const sending = { ...start, deliveries: [{ threadId: 'thread', draftId: '00000000-0000-4000-8000-000000000001', status: 'submitting' as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }
    const command = vi.fn(() => new Promise<AgentState>(() => undefined))
    const { rerender } = render(<ThreadOptions thread={sending.host.threads[0]!} state={sending} command={command} />)
    for (const name of ['Thread model', 'Thread reasoning', 'Thread permissions']) expect(screen.getByRole('combobox', { name })).toBeDisabled()
    // The coordinator's busy mark for this thread's own save fixes nothing.
    const busy = { ...start, busyThreadIds: ['thread'] }
    rerender(<ThreadOptions thread={busy.host.threads[0]!} state={busy} command={command} />)
    for (const name of ['Thread model', 'Thread reasoning', 'Thread permissions']) expect(screen.getByRole('combobox', { name })).toBeEnabled()
  })

  it('sends one further save for the last of two presses made during one save', async () => {
    const releases: Array<() => void> = []
    const asked: string[] = []
    render(<LiveThread start={fixture({ runtimeMode: 'approval-required' })} answer={async (request, current) => {
      const mode = (request as { runtimeMode: NonNullable<AgentThread['runtimeMode']> }).runtimeMode
      asked.push(mode)
      await new Promise<void>(resolve => { releases.push(resolve) })
      return withThread(current, { runtimeMode: mode })
    }} />)
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    const choose = (name: string): void => { fireEvent.click(chip); fireEvent.click(screen.getByRole('option', { name })) }
    choose('Full access')
    choose('Allow edits')
    choose('Auto')
    // Every press shows; only the first has gone out.
    expect(chip).toHaveTextContent('Auto')
    expect(asked).toEqual(['full-access'])
    await act(async () => { releases[0]!() })
    expect(asked).toEqual(['full-access', 'auto'])
    // The first change has landed; the last press is still what the chip shows, and still pending.
    expect(chip).toHaveTextContent('Auto')
    expect(chip).toHaveAttribute('data-pending', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Claude Code still runs anything without asking until it confirms.')
    await act(async () => { releases[1]!() })
    expect(asked).toEqual(['full-access', 'auto'])
    expect(chip).toHaveTextContent('Auto')
    expect(chip).not.toHaveAttribute('data-pending')
  })

  it('shows a model choice at once with no pending mark, and the effort it starts on', async () => {
    let release!: () => void
    const start = fixture({ reasoningEffort: 'high' })
    const claude = start.host.models.find(model => model.providerId === 'claude')!
    start.host.models.push({ ...claude, id: 'claude:next', name: 'Claude Code next', defaultReasoningEffort: 'low' })
    render(<LiveThread start={start} answer={async (request, current) => {
      await new Promise<void>(resolve => { release = resolve })
      return withThread(current, { modelId: (request as { modelId: string }).modelId, reasoningEffort: 'low' })
    }} />)
    const model = screen.getByRole('combobox', { name: 'Thread model' })
    fireEvent.click(model)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose model' })).getByRole('option', { name: 'Claude Code next' }))
    expect(model).toHaveTextContent('Claude Code next')
    expect(model).not.toHaveAttribute('data-pending')
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Low')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(model).toBeEnabled()
    expect(screen.queryByText('Saving...')).toBeNull()
    await act(async () => { release() })
    expect(model).toHaveTextContent('Claude Code next')
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Low')
  })

  it('saves an effort pressed during a model change even when it is the level the old model was on', async () => {
    const start = fixture({ reasoningEffort: 'high' })
    const claude = start.host.models.find(model => model.providerId === 'claude')!
    start.host.models.push({ ...claude, id: 'claude:next', name: 'Claude Code next', defaultReasoningEffort: 'low' })
    const asked: AgentCommand[] = []
    const command = vi.fn(async (request: AgentCommand) => { asked.push(request); return new Promise<AgentState>(() => undefined) })
    render(<ThreadOptions thread={start.host.threads[0]!} state={start} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose model' })).getByRole('option', { name: 'Claude Code next' }))
    const effort = screen.getByRole('combobox', { name: 'Thread reasoning' })
    expect(effort).toHaveTextContent('Low')
    fireEvent.click(effort)
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Thread reasoning effort' }), { key: '3' })
    // High is what the thread holds now, but the model change will start it on Low, so High is a change to send.
    expect(effort).toHaveTextContent('High')
    expect(asked).toEqual([
      { type: 'configure-thread', threadId: 'thread', modelId: 'claude:next' },
      { type: 'configure-thread', threadId: 'thread', reasoningEffort: 'high' },
    ])
  })

  it("says a provider's own mode stays in force in that mode's name", () => {
    const state = fixture({ providerId: 'devin', modelId: 'devin:model', providerMode: 'ask-first' })
    Object.assign(state.host.models.find(model => model.id === 'devin:model')!, { runtimeModes: [], providerModes: [
      { id: 'ask-first', name: 'Ask first' }, { id: 'bypass', name: 'Bypass permissions' },
    ] })
    const command = vi.fn(() => new Promise<AgentState>(() => undefined))
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('option', { name: 'Bypass permissions' }))
    expect(chip).toHaveTextContent('Bypass permissions')
    expect(screen.getByRole('status')).toHaveTextContent('Devin stays on Ask first until it confirms.')
    expect(chip).toHaveAccessibleDescription('Devin stays on Ask first until it confirms.')
  })

  it('names what each mode still lets the provider do, and words a refusal by what main said', () => {
    expect(permissionInForceCaption('Claude Code', { runtimeMode: 'approval-required' })).toBe('Claude Code still asks for approval until it confirms.')
    expect(permissionInForceCaption('Codex', { runtimeMode: 'auto-accept-edits' })).toBe('Codex still makes edits without asking until it confirms.')
    expect(permissionInForceCaption('Grok Build', { runtimeMode: 'auto' })).toBe('Grok Build still decides what to ask you about until it confirms.')
    expect(permissionInForceCaption('Claude Code', { runtimeMode: 'full-access' })).toBe('Claude Code still runs anything without asking until it confirms.')
    expect(permissionInForceCaption('Codex', {})).toBe('Codex keeps its own default until it confirms.')
    expect(permissionInForceCaption('Devin', { providerModeName: 'Ask first' })).toBe('Devin stays on Ask first until it confirms.')
    expect(settingRefusalText('Codex', 'Full access', 'Allow edits', PROVIDER_REJECTED_ACTION)).toBe('Codex did not switch to Full access. The thread stays on Allow edits; nothing else changed.')
    expect(settingRefusalText('Codex', 'Full access', 'Allow edits', 'Wait for the thread and resolve pending requests before changing settings.'))
      .toBe('Codex did not switch to Full access. Wait for the thread and resolve pending requests before changing settings.')
    expect(unconfirmedSettingText('Codex', 'Full access', PROVIDER_RESULT_UNCONFIRMED))
      .toBe('Codex has not confirmed Full access. The thread starts on Full access the next time it is used, and Sotto checks it then.')
  })
})

// The controls read a model's levels in the order main hands them over, least to most thorough, and do
// not sort for themselves: the adapters own that order (orderReasoningEfforts). Grok lists its levels
// highest first, and this is what its list looks like once its adapter has turned it round.
describe('effort order contract', () => {
  function grok(reasoningEffort: string): AgentState {
    const state = fixture({ providerId: 'grok', modelId: 'grok:model', title: 'Grok work', reasoningEffort })
    state.host.models = state.host.models.map(model => model.providerId === 'grok' ? { ...model, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high' } : model)
    return state
  }

  it('treats the last level as the highest and the first as the lowest', async () => {
    const { command } = mount(grok('high'))
    const chip = screen.getByRole('combobox', { name: 'Thread reasoning' })
    expect(chip).toHaveAttribute('data-effort-top', 'false')
    fireEvent.click(chip)
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    expect(slider).toHaveAttribute('max', '3')
    expect(slider).toHaveValue('2')
    fireEvent.keyDown(slider, { key: 'End' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'xhigh' }))
    fireEvent.keyDown(slider, { key: 'Home' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'low' }))
    cleanup()
    mount(grok('xhigh'))
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveAttribute('data-effort-top', 'true')
    cleanup()
    mount(grok('low'))
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveAttribute('data-effort-top', 'false')
  })

  it('lists the New thread levels lowest first', () => {
    const models = grok('high').host.models.filter(model => model.providerId === 'grok')
    render(<ThreadOptionFields models={models} modelId="grok:model" onModel={vi.fn()} onReasoning={vi.fn()} onRuntime={vi.fn()} />)
    const reasoning = screen.getByRole('combobox', { name: 'Thread reasoning' })
    expect(within(reasoning).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(reasoning).toHaveValue('high')
  })
})
