import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, PROVIDER_LABELS, providerIdSchema, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { ThreadOptions } from '../../../src/renderer/src/agents/ThreadOptions'

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
afterEach(cleanup)

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

  it('opens the effort slider at the current level and saves a supported stop without closing', async () => {
    const { command } = mount()
    const chip = screen.getByRole('combobox', { name: 'Thread reasoning' })
    fireEvent.click(chip)
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    const slider = within(panel).getByRole('slider', { name: 'Thread reasoning effort' })
    expect(slider).toHaveAttribute('aria-valuetext', 'High')
    expect(slider).toHaveFocus()
    for (const label of ['Low', 'Medium', 'High', 'Extra high', 'Max']) expect(within(panel).getByRole('button', { name: `${label} effort` })).toBeVisible()
    fireEvent.click(within(panel).getByRole('button', { name: 'Extra high effort' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'xhigh' }))
    expect(panel).toBeInTheDocument()
    fireEvent.keyDown(slider, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Reasoning effort' })).toBeNull()
    expect(chip).toHaveFocus()
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
    fireEvent.click(screen.getByRole('button', { name: 'Ultra effort' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'ultra' }))
    cleanup()
    mount()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(screen.queryByRole('button', { name: 'Ultra effort' })).toBeNull()
  })

  it('keeps the confirmed setting and allows retry when a settings command rejects', async () => {
    const state = fixture()
    const command = vi.fn().mockRejectedValueOnce(new Error('Transport closed')).mockResolvedValue(state)
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Max effort' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm this change. Try again.')
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('High')
    expect(screen.getByRole('dialog', { name: 'Reasoning effort' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Max effort' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('keeps the effort panel mounted while a selection is being confirmed', async () => {
    const state = fixture()
    let release!: () => void
    const command = vi.fn(() => new Promise<typeof state>(resolve => { release = () => resolve(state) }))
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    fireEvent.click(screen.getByRole('button', { name: 'Max effort' }))
    expect(panel).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Low effort' }))
    expect(command).toHaveBeenCalledTimes(1)
    release()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toBeEnabled())
    expect(panel).toBeInTheDocument()
  })

  it('preserves an unavailable saved level until the user chooses a supported one', () => {
    const { command } = mount(fixture({ reasoningEffort: 'legacy' }))
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Legacy')
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(command).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'High effort' })).toBeInTheDocument()
  })

  it('retains the open effort panel when a provider-default choice is confirmed', async () => {
    const state = fixture()
    delete state.host.threads[0]!.reasoningEffort
    delete state.host.models.find(model => model.id === 'claude:model')!.defaultReasoningEffort
    const command = vi.fn(async () => state)
    const { rerender } = render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    fireEvent.click(screen.getByRole('button', { name: 'High effort' }))
    await waitFor(() => expect(command).toHaveBeenCalled())
    state.host.threads[0]!.reasoningEffort = 'high'
    rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    expect(screen.getByRole('dialog', { name: 'Reasoning effort' })).toBe(panel)
  })

  it('adds Ultrathink visibly to a Claude draft without changing thread settings', () => {
    const state = fixture()
    const command = vi.fn(async () => state)
    const onDraftText = vi.fn()
    const { rerender } = render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} draftText="Review this plan." onDraftText={onDraftText} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Ultrathink to prompt' }))
    expect(onDraftText).toHaveBeenCalledWith('Review this plan.\n\nultrathink')
    expect(command).not.toHaveBeenCalled()
    rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} draftText="Review this plan. ULTRATHINK" onDraftText={onDraftText} />)
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
    expect(screen.getByRole('button', { name: 'High effort' })).toHaveAttribute('aria-pressed', 'true')
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
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={vi.fn()} draftText="Review this." onDraftText={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(screen.queryByRole('button', { name: 'Add Ultrathink to prompt' })).toBeNull()
  })

  it('puts focus back on the chip once a choice is confirmed, since the chip was fixed while saving', async () => {
    let release!: () => void
    const state = fixture()
    const command = vi.fn(() => new Promise<typeof state>(resolve => { release = () => resolve(state) }))
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread permissions' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full access' }))
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    await waitFor(() => expect(chip).toBeDisabled())
    // Chromium drops focus from a control the moment it is disabled; jsdom keeps it, so the drop is made explicit.
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

  it('offers every provider in tabs with the reminder while the thread has not sent, and its own alone after', () => {
    mount()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const menu = screen.getByRole('dialog', { name: 'Choose model' })
    expect(within(menu).getByRole('navigation', { name: 'Model providers' })).toBeVisible()
    expect(within(menu).getByText('Any provider until your first message.')).toBeVisible()
    cleanup()
    mount(fixture({ nativeSessionStarted: true }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const started = screen.getByRole('dialog', { name: 'Choose model' })
    expect(within(started).queryByRole('navigation')).toBeNull()
    expect(within(started).getByText('This thread stays with Claude Code.')).toBeVisible()
    expect(within(started).getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Code model'])
  })
})
