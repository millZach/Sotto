import { deferred } from '../../../fixtures/deferred'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { permissionInForceCaption, settingRefusalText, ThreadOptionFields, ThreadOptions, threadOptionsSummary, unconfirmedSettingText } from '../../../../src/renderer/src/agents/ThreadOptions'
import { PROVIDER_REJECTED_ACTION, PROVIDER_RESULT_UNCONFIRMED, type AgentCommand, type AgentState, type AgentThread } from '../../../../src/shared/agents'
import { fixture, LiveThread, mount, setupThreadOptionsTests, withThread } from '../../../fixtures/renderer/threadOptionsHarness'

setupThreadOptionsTests()

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
    expect(chip).toHaveTextContent('Provider default')
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
      await (() => { const pending = deferred<void>(); release = pending.resolve; return pending.promise })()
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
    expect(notice).toHaveTextContent(lost)
    expect(notice).not.toHaveTextContent('did not switch')
    expect(within(notice).queryByRole('button')).toBeNull()
    expect(chip).toHaveAccessibleDescription(lost)
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
    const command = vi.fn(() => deferred<AgentState>().promise)
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
      await (() => { const pending = deferred<void>(); releases.push(pending.resolve); return pending.promise })()
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
      await (() => { const pending = deferred<void>(); release = pending.resolve; return pending.promise })()
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
    const command = vi.fn(async (request: AgentCommand) => { asked.push(request); return deferred<AgentState>().promise })
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
    const command = vi.fn(() => deferred<AgentState>().promise)
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
