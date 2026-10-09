import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThreadOptionFields } from '../../../../src/renderer/src/agents/ThreadOptions'
import { type AgentCommand, type AgentState } from '../../../../src/shared/agents'
import { fixture, LiveThread, mount, setupThreadOptionsTests, withThread } from '../../../fixtures/renderer/threadOptionsHarness'

setupThreadOptionsTests()

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
describe('a long-context model the catalog does not list', () => {
  const opus = 'native:claude:model:opus'
  const sonnet = 'native:claude:model:sonnet'
  const variant = 'native:claude:model:opus%5B1m%5D'
  function longContext(): AgentState {
    const state = fixture({ modelId: variant, nativeSessionStarted: true, reasoningEffort: 'high' })
    const claude = state.host.models.find(model => model.providerId === 'claude')!
    state.host.models = [...state.host.models.filter(model => model !== claude),
      { ...claude, id: opus, name: 'Opus 5.5', supportsImages: true }, { ...claude, id: sonnet, name: 'Sonnet 4.6', defaultReasoningEffort: 'low' }]
    return state
  }
  const choose = (name: string): void => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose model' })).getByRole('option', { name }))
  }

  it('shows the base model by its name alone, with its efforts, and checks it in the picker', () => {
    mount(longContext())
    const model = screen.getByRole('combobox', { name: 'Thread model' })
    expect(model).toHaveTextContent('Opus 5.5')
    expect(model).not.toHaveTextContent(/1M|context|%5B/iu)
    expect(model.querySelector('svg.provider-mark[data-provider="claude"]')).not.toBeNull()
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('High')
    fireEvent.click(model)
    const menu = screen.getByRole('dialog', { name: 'Choose model' })
    expect(within(menu).getAllByRole('option').map(option => option.textContent)).toEqual(['Opus 5.5', 'Sonnet 4.6'])
    expect(within(menu).getByRole('option', { name: 'Opus 5.5' })).toHaveAttribute('aria-selected', 'true')
    expect(within(menu).getByRole('option', { name: 'Sonnet 4.6' })).toHaveAttribute('aria-selected', 'false')
  })

  it('keeps the thread on its own model when its base entry is pressed again', async () => {
    const { command } = mount(longContext())
    choose('Opus 5.5')
    await act(async () => { await Promise.resolve() })
    expect(command).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('Opus 5.5')
  })

  it('moves to another entry as usual, and a press back to the base entry before it lands returns to its own model', async () => {
    const sent: AgentCommand[] = []
    let release!: () => void
    render(<LiveThread start={longContext()} answer={async (request, current) => {
      sent.push(request)
      await new Promise<void>(resolve => { release = resolve })
      return withThread(current, { modelId: (request as { modelId: string }).modelId })
    }} />)
    choose('Sonnet 4.6')
    expect(sent).toEqual([{ type: 'configure-thread', threadId: 'thread', modelId: sonnet }])
    choose('Opus 5.5')
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('Opus 5.5')
    await act(async () => { release() })
    await waitFor(() => expect(sent).toHaveLength(2))
    // The thread goes back to the long-context model it was on, never to the base model by accident.
    expect(sent[1]).toEqual({ type: 'configure-thread', threadId: 'thread', modelId: variant })
    await act(async () => { release() })
    expect(sent.some(request => 'modelId' in request && request.modelId === opus)).toBe(false)
  })

  it('offers the base model after the thread has moved away from it', async () => {
    const start = longContext()
    const sent: AgentCommand[] = []
    render(<LiveThread start={start} answer={async (request, current) => {
      sent.push(request)
      return withThread(current, { modelId: (request as { modelId: string }).modelId })
    }} />)
    choose('Sonnet 4.6')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('Sonnet 4.6'))
    choose('Opus 5.5')
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toEqual({ type: 'configure-thread', threadId: 'thread', modelId: opus })
  })
})
