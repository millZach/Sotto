// Ultracode on the effort card (ADR-0148): the stop past Max on a Claude model, chosen and shown like any level, with the
// level it runs at named on the card's line and what it costs said over its stop.
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThreadOptions, effortChoices } from '../../../../src/renderer/src/agents/ThreadOptions'
import { ultracodeLevel } from '../../../../src/renderer/src/agents/ultracodeLevel'
import type { AgentState } from '../../../../src/shared/agents'
import { fixture, mount, setupThreadOptionsTests } from '../../../fixtures/renderer/threadOptionsHarness'

setupThreadOptionsTests()

/** The harness's state with Claude's model offering Ultracode, as the catalog reports a model with Extra high. */
function claudeState(thread: Parameters<typeof fixture>[0] = {}): AgentState {
  const state = fixture(thread)
  state.host.models.find(model => model.id === 'claude:model')!.reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
  return state
}

describe('Ultracode on the effort card', () => {
  it('is the stop past Max, chosen by the slider like any level', async () => {
    const { command } = mount(claudeState())
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })
    expect(slider).toHaveAttribute('max', '5')
    fireEvent.keyDown(slider, { key: 'End' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'ultracode' }))
  })

  it('names itself on the chip and the card, and the level it runs at on the line', () => {
    mount(claudeState({ reasoningEffort: 'ultracode' }))
    const chip = screen.getByRole('combobox', { name: 'Thread reasoning' })
    expect(chip).toHaveTextContent(/^Ultracode$/u)
    expect(chip).toHaveAttribute('title', 'Thread reasoning. Runs a multi-agent workflow; uses many more tokens.')
    fireEvent.click(chip)
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    const slider = within(panel).getByRole('slider', { name: 'Thread reasoning effort' })
    expect(slider).toHaveAttribute('aria-valuetext', 'Ultracode')
    expect(panel.querySelector('.effort-card__word')).toHaveTextContent(/^Ultracode$/u)
    // This computer's setting is Extra high until changed.
    expect(slider).toHaveAccessibleDescription('Plans the work and runs it as a team of agents at Extra high effort. Uses many more tokens.')
    // It is the model's highest level, so it wears the colourway as Max does on a model without it.
    expect(panel).toHaveAttribute('data-top', 'true')
  })

  it('follows this computer\'s Ultracode effort setting', () => {
    const state = claudeState({ reasoningEffort: 'ultracode' })
    state.configuration = { ...state.configuration, claudeUltracodeEffort: 'high' }
    mount(state)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(screen.getByRole('slider', { name: 'Thread reasoning effort' }))
      .toHaveAccessibleDescription('Plans the work and runs it as a team of agents at High effort. Uses many more tokens.')
  })

  it('says what Ultracode costs while the pointer rests on its stop, and only there', () => {
    mount(claudeState())
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    const track = panel.querySelector('.effort-card__track')!
    const hint = panel.querySelector('.effort-card__hint')!
    expect(hint).toHaveTextContent('Runs a multi-agent workflow; uses many more tokens.')
    expect(hint).toHaveAttribute('aria-hidden', 'true')
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 276, height: 26, right: 276, bottom: 26, x: 0, y: 0, toJSON: () => ({}) })
    expect(hint).toHaveAttribute('data-shown', 'false')
    fireEvent.pointerMove(track, { clientX: 270 })
    expect(hint).toHaveAttribute('data-shown', 'true')
    // Max's stop, one to the left, is not Ultracode's.
    fireEvent.pointerMove(track, { clientX: 213 })
    expect(hint).toHaveAttribute('data-shown', 'false')
    fireEvent.pointerMove(track, { clientX: 270 })
    fireEvent.pointerLeave(track)
    expect(hint).toHaveAttribute('data-shown', 'false')
  })

  it('has no stop or hint on a model without it', () => {
    mount(fixture())
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const panel = screen.getByRole('dialog', { name: 'Reasoning effort' })
    expect(within(panel).getByRole('slider', { name: 'Thread reasoning effort' })).toHaveAttribute('max', '4')
    expect(panel.querySelector('.effort-card__hint')).toBeNull()
    cleanup()
    // A thread at Ultracode whose model stopped offering it keeps the level until the user picks one the model has.
    const command = vi.fn(async () => fixture())
    const state = fixture({ reasoningEffort: 'ultracode' })
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent(/^Ultracode$/u)
  })
})

describe('effortChoices', () => {
  const model = claudeState().host.models.find(item => item.id === 'claude:model')!

  it('offers Ultracode only where a person picks a thread\'s own effort', () => {
    expect(effortChoices(model, 'high', { ultracode: true }).map(option => option.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    // Watcher's composer, worker roles and the agent setting keep the levels without it.
    expect(effortChoices(model, 'high').map(option => option.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('ultracodeLevel', () => {
  it('fits this computer\'s setting to the model, and names nothing on a model without Ultracode', () => {
    const state = claudeState()
    const claude = state.host.models.find(item => item.id === 'claude:model')!
    expect(ultracodeLevel(state, {}, claude)).toBe('xhigh')
    expect(ultracodeLevel({ ...state, configuration: { ...state.configuration, claudeUltracodeEffort: 'max' } }, {}, { ...claude, reasoningEfforts: ['low', 'high', 'xhigh', 'ultracode'] })).toBe('xhigh')
    expect(ultracodeLevel(state, {}, state.host.models.find(item => item.id === 'codex:model'))).toBeUndefined()
  })

  it('reads this computer\'s entry in a joined window, and names nothing for a thread on another host', () => {
    const state = claudeState()
    const claude = state.host.models.find(item => item.id === 'claude:model')!
    const joined = { ...state, connections: [{ hostId: 'here', kind: 'local' }, { hostId: 'there', kind: 'remote' }],
      host: { ...state.host, clientHosts: [{ hostId: 'here', claudeUltracodeEffort: 'medium' }] } } as unknown as AgentState
    expect(ultracodeLevel(joined, { hostId: 'here' }, claude)).toBe('medium')
    expect(ultracodeLevel(joined, { hostId: 'there' }, claude)).toBeUndefined()
  })
})
