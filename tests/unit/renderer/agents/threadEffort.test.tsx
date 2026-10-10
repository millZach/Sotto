import { deferred } from '../../../fixtures/deferred'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThreadOptions } from '../../../../src/renderer/src/agents/ThreadOptions'
import { fixture, Live, mount, setupThreadOptionsTests } from '../../../fixtures/renderer/threadOptionsHarness'

setupThreadOptionsTests()

describe('composer option chips', () => {

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
    const command = vi.fn(() => { const pending = deferred<typeof state>(); release = () => pending.resolve(state); return pending.promise })
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
      await (() => { const pending = deferred<void>(); release = pending.resolve; return pending.promise })()
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
      await (() => { const pending = deferred<void>(); release = pending.resolve; return pending.promise })()
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
      await (() => { const pending = deferred<void>(); releases.push(pending.resolve); return pending.promise })()
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
    const command = vi.fn(() => { const pending = deferred<typeof state>(); release = () => pending.resolve(state); return pending.promise })
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
})
