import React, { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThreadOptions } from '../../../../src/renderer/src/agents/ThreadOptions'
import type { AgentCommand, AgentModel, AgentState } from '../../../../src/shared/agents'
import { fixture, setupThreadOptionsTests, withThread } from '../../../fixtures/renderer/threadOptionsHarness'

setupThreadOptionsTests()

function multiProviderState(): AgentState {
  const state = fixture({ providerId: 'claude', modelId: 'claude:opus', reasoningEffort: 'high' })
  const claudeBase = state.host.models.find(model => model.providerId === 'claude')!
  const codexBase = state.host.models.find(model => model.providerId === 'codex')!
  const opus: AgentModel = {
    ...claudeBase,
    id: 'claude:opus',
    name: 'Opus 5.5',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    defaultReasoningEffort: 'high',
    speeds: [{ id: 'fast', name: 'Fast' }],
  }
  const haiku: AgentModel = {
    ...claudeBase,
    id: 'claude:haiku',
    name: 'Haiku 5.5',
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    speeds: [],
  }
  const sol: AgentModel = {
    ...codexBase,
    id: 'codex:sol',
    name: 'GPT-6.2-Sol',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    speeds: [{ id: 'fast', name: 'Fast', description: '2x speed, increased usage' }, { id: 'ultrafast', name: 'Ultrafast', description: '4x speed, highest usage' }],
  }
  state.host.models = [opus, haiku, sol]
  return state
}

function mountQuiet(start = multiProviderState()) {
  const sent: AgentCommand[] = []
  function LiveQuiet(): React.ReactElement {
    const [state, setState] = useState(start)
    return <ThreadOptions thread={state.host.threads[0]!} state={state} quiet={{ effortScore: 0 }} command={async request => {
      sent.push(request)
      if (request.type !== 'configure-thread') return state
      const patch: Partial<AgentState['host']['threads'][number]> = {}
      if ('modelId' in request && request.modelId) {
        patch.modelId = request.modelId
        const nextModel = state.host.models.find(model => model.id === request.modelId)
        if (nextModel?.providerId) patch.providerId = nextModel.providerId
        patch.reasoningEffort = request.reasoningEffort ?? nextModel?.defaultReasoningEffort
      } else if ('reasoningEffort' in request) {
        patch.reasoningEffort = request.reasoningEffort ?? undefined
      }
      if ('speed' in request) patch.speed = request.speed ?? undefined
      const next = withThread(state, patch)
      setState(next)
      return next
    }} />
  }
  const view = render(<LiveQuiet />)
  return { sent, view }
}

describe('combined model, effort and speed picker', () => {
  it('opens the same combined dialog from either the model chip or effort word and returns focus to the opener', () => {
    mountQuiet()
    const modelChip = screen.getByRole('combobox', { name: 'Thread model' })
    const effortChip = screen.getByRole('combobox', { name: 'Thread reasoning' })

    fireEvent.click(modelChip)
    const dialog = screen.getByRole('dialog', { name: 'Choose model' })
    expect(dialog).toHaveAttribute('data-combined', 'true')
    expect(within(dialog).getByRole('textbox', { name: 'Search models' })).toHaveFocus()
    expect(within(dialog).getByRole('tablist', { name: 'Model providers' })).toHaveAttribute('aria-orientation', 'horizontal')
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull()
    expect(modelChip).toHaveFocus()

    fireEvent.click(effortChip)
    const fromEffort = screen.getByRole('dialog', { name: 'Choose model' })
    expect(within(fromEffort).getByRole('slider', { name: 'Thread reasoning effort' })).toHaveFocus()
    fireEvent(fromEffort, new Event('cancel', { bubbles: true, cancelable: true }))
    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull()
    expect(effortChip).toHaveFocus()
  })

  it('stays open when picking another model and expands the newly picked model inline with its own gauge and speeds', async () => {
    const { sent } = mountQuiet()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const dialog = screen.getByRole('dialog', { name: 'Choose model' })
    expect(within(dialog).getByRole('slider', { name: 'Thread reasoning effort' })).toHaveAttribute('max', '5')
    expect(within(dialog).getByRole('radio', { name: 'Fast' })).toBeInTheDocument()

    // Switch to Haiku 5.5: picker stays open, expands Haiku's 3-level gauge with no speed control, and moves focus into it.
    fireEvent.click(within(dialog).getByRole('option', { name: 'Haiku 5.5' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('Haiku 5.5'))
    expect(screen.getByRole('dialog', { name: 'Choose model' })).toBeInTheDocument()
    const slider = within(dialog).getByRole('slider', { name: 'Thread reasoning effort' })
    expect(slider).toHaveAttribute('max', '2')
    expect(slider).toHaveAttribute('aria-valuetext', 'Medium')
    expect(slider).toHaveFocus()
    expect(within(dialog).queryByRole('radio')).toBeNull()
    expect(sent).toEqual([{ type: 'configure-thread', threadId: 'thread', modelId: 'claude:haiku' }])
  })

  it('fires Prism Ignition once on arriving at the highest Power Gauge cell and respects reduced motion', async () => {
    vi.useFakeTimers()
    try {
      mountQuiet()
      fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
      const dialog = screen.getByRole('dialog', { name: 'Choose model' })
      const card = dialog.querySelector('.inline-model-card')!
      const slider = within(dialog).getByRole('slider', { name: 'Thread reasoning effort' })

      expect(card).toHaveAttribute('data-highest', 'false')
      expect(card).toHaveAttribute('data-arriving', 'false')
      expect(card.querySelectorAll('.effort-gauge__cell')).toHaveLength(6)
      expect(card.querySelectorAll('.effort-gauge__cell[data-lit="true"]')).toHaveLength(3)

      // Jump to Ultracode (the highest stop): Prism Ignition fires once and settles.
      await act(async () => { fireEvent.keyDown(slider, { key: 'End' }) })
      expect(card).toHaveAttribute('data-highest', 'true')
      expect(card).toHaveAttribute('data-arriving', 'true')
      expect(card.querySelectorAll('.effort-gauge__cell[data-lit="true"]')).toHaveLength(6)

      act(() => { vi.advanceTimersByTime(1500) })
      expect(card).toHaveAttribute('data-arriving', 'false')
      expect(card).toHaveAttribute('data-highest', 'true')

      // Lowering clears highest; climbing back under reduced motion stays quiet.
      await act(async () => { fireEvent.keyDown(slider, { key: 'Home' }) })
      expect(card).toHaveAttribute('data-highest', 'false')

      document.documentElement.dataset.reducedMotion = 'on'
      await act(async () => { fireEvent.keyDown(slider, { key: 'End' }) })
      expect(card).toHaveAttribute('data-highest', 'true')
      expect(card).toHaveAttribute('data-arriving', 'false')
    } finally {
      delete document.documentElement.dataset.reducedMotion
      vi.useRealTimers()
    }
  })

  it('shows a pinned active model bar when browsing another provider and jumps back on click', () => {
    mountQuiet()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const dialog = screen.getByRole('dialog', { name: 'Choose model' })
    expect(dialog.querySelector('.model-picker__pinned')).toBeNull()

    // Browse Codex while Claude Opus 5.5 is active: pinned bar appears.
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Codex' }))
    const pinned = within(dialog).getByRole('button', { name: /Jump to active model, Opus 5\.5/u })
    expect(pinned).toHaveTextContent('Opus 5.5')
    expect(pinned).toHaveTextContent('High')

    // Horizontal arrows move along the provider strip.
    const codexTab = within(dialog).getByRole('tab', { name: 'Codex' })
    codexTab.focus()
    fireEvent.keyDown(codexTab, { key: 'ArrowLeft' })
    expect(within(dialog).getByRole('tab', { name: 'Claude Code' })).toHaveFocus()

    // Switching back to Codex and clicking the pinned bar returns straight to Opus 5.5's gauge.
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Codex' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /Jump to active model, Opus 5\.5/u }))
    expect(within(dialog).getByRole('tab', { name: 'Claude Code' })).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog).getByRole('slider', { name: 'Thread reasoning effort' })).toHaveFocus()
  })

  it('steps effort via clickable stops and mouse wheel on the Power Gauge', async () => {
    const { sent } = mountQuiet()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const dialog = screen.getByRole('dialog', { name: 'Choose model' })
    const slider = within(dialog).getByRole('slider', { name: 'Thread reasoning effort' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Low' }))
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', 'Low'))
    fireEvent.wheel(slider, { deltaY: -120 })
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', 'Medium'))
    expect(sent).toEqual([
      { type: 'configure-thread', threadId: 'thread', reasoningEffort: 'low' },
      { type: 'configure-thread', threadId: 'thread', reasoningEffort: 'medium' },
    ])
  })

  it('closes cleanly if the thread locks while open and never reopens unasked when the turn ends', () => {
    const start = multiProviderState()
    const command = vi.fn(async () => start)
    const { rerender } = render(<ThreadOptions thread={start.host.threads[0]!} state={start} quiet={{ effortScore: 0 }} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    expect(screen.getByRole('dialog', { name: 'Choose model' })).toBeInTheDocument()

    const running = withThread(start, { status: 'running' })
    rerender(<ThreadOptions thread={running.host.threads[0]!} state={running} quiet={{ effortScore: 0 }} command={command} />)
    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull()

    const idleAgain = withThread(start, { status: 'idle' })
    rerender(<ThreadOptions thread={idleAgain.host.threads[0]!} state={idleAgain} quiet={{ effortScore: 0 }} command={command} />)
    expect(screen.queryByRole('dialog', { name: 'Choose model' })).toBeNull()
  })

  it('reaches OpenCode model source rows from Search on ArrowDown and returns focus on Back in combined mode', () => {
    const state = multiProviderState()
    state.host.models = [
      ...state.host.models,
      { id: 'opencode/big-pickle', name: 'Big Pickle', provider: 'OpenCode', providerId: 'opencode', source: 'OpenCode Zen', ready: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' },
    ]
    mountQuiet(state)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    const dialog = screen.getByRole('dialog', { name: 'Choose model' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'OpenCode' }))
    const search = within(dialog).getByRole('textbox', { name: 'Search models' })
    expect(search).toHaveFocus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const zen = within(dialog).getByRole('button', { name: /^Show OpenCode Zen models/u })
    expect(zen).toHaveFocus()
    fireEvent.click(zen)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to model sources' }))
    expect(within(dialog).getByRole('button', { name: /^Show OpenCode Zen models/u })).toHaveFocus()
  })

  it('lands on the first effort level from an unknown saved effort and ignores modified arrows on the gauge', async () => {
    const start = multiProviderState()
    start.host.threads[0]!.reasoningEffort = 'legacy'
    start.host.models[0] = { ...start.host.models[0]!, speeds: [] }
    const { sent } = mountQuiet(start)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread reasoning' }))
    const slider = screen.getByRole('slider', { name: 'Thread reasoning effort' })

    // Modified arrows (Alt/Ctrl/Meta) on a model without speeds do not step effort.
    fireEvent.keyDown(slider, { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(slider, { key: 'ArrowRight', ctrlKey: true })
    fireEvent.keyDown(slider, { key: 'ArrowRight', metaKey: true })
    expect(sent).toEqual([])

    // From an unknown saved effort, ArrowRight lands on the first offered level (low) instead of skipping to medium.
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(sent).toEqual([{ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'low' }]))
  })
})
