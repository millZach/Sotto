// ADR-0191: the Settings card a Dynamic thread's limits live on. The allowed list is the privacy line, so a save never puts
// back a provider the user just unticked, and a limit's change never makes the list the first-use question is there to ask about.
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../../../src/shared/agents'
import { DEFAULT_DYNAMIC_THREADS, type DynamicThreadSettings } from '../../../../../src/shared/dynamicThreads'
import { useOptionalAgents } from '../../../../../src/renderer/src/agents/AgentContext'
import { companyWords } from '../../../../../src/renderer/src/agents/DynamicSwitch'
import { DynamicThreadsSettings } from '../../../../../src/renderer/src/features/settings/DynamicThreadsSettings'

vi.mock('../../../../../src/renderer/src/agents/AgentContext', () => ({ useOptionalAgents: vi.fn(), useAgents: vi.fn() }))

const state = { connections: [], host: { models: [{ id: 'claude', providerId: 'claude', ready: true }, { id: 'codex', providerId: 'codex', ready: true }, { id: 'opencode', providerId: 'opencode', ready: true }] } } as unknown as AgentState
const payloads = (onSave: ReturnType<typeof vi.fn>): DynamicThreadSettings[] => onSave.mock.calls.map(call => (call[0] as { dynamicThreads: DynamicThreadSettings }).dynamicThreads)
const codex = (): HTMLElement => screen.getByRole('checkbox', { name: /Codex/u })

beforeEach(() => { vi.mocked(useOptionalAgents).mockReturnValue({ state } as never) })
afterEach(cleanup)

describe('the Dynamic threads card', () => {
  it('leaves the list unmade when a limit changes, so the first-use question still asks', () => {
    const onSave = vi.fn(() => new Promise(() => undefined))
    render(<DynamicThreadsSettings settings={DEFAULT_DYNAMIC_THREADS} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Highest effort'), { target: { value: 'high' } })
    expect(payloads(onSave)[0]).toEqual({ ...DEFAULT_DYNAMIC_THREADS, highestEffort: 'high' })
    expect(payloads(onSave)[0]).not.toHaveProperty('providers')
  })

  it('makes the list from what it shows when a provider is ticked or unticked', () => {
    const onSave = vi.fn(() => new Promise(() => undefined))
    render(<DynamicThreadsSettings settings={DEFAULT_DYNAMIC_THREADS} onSave={onSave} />)
    expect(codex()).toBeChecked()
    fireEvent.click(codex())
    expect(payloads(onSave)[0]?.providers).toEqual(['claude'])
    expect(codex()).not.toBeChecked()
  })

  it('never puts back a provider unticked a moment before, while that save is on its way', () => {
    const onSave = vi.fn(() => new Promise(() => undefined))
    render(<DynamicThreadsSettings settings={{ ...DEFAULT_DYNAMIC_THREADS, providers: ['claude', 'codex'] }} onSave={onSave} />)
    fireEvent.click(codex())
    fireEvent.change(screen.getByLabelText('Highest effort'), { target: { value: 'high' } })
    expect(payloads(onSave)[1]).toMatchObject({ providers: ['claude'], highestEffort: 'high' })
  })

  it('takes what was saved once no save is on its way', async () => {
    let land: (saved: boolean) => void = () => undefined
    const onSave = vi.fn(() => new Promise<boolean>(resolve => { land = resolve }))
    const settings = { ...DEFAULT_DYNAMIC_THREADS, providers: ['claude', 'codex'] } as DynamicThreadSettings
    const { rerender } = render(<DynamicThreadsSettings settings={settings} onSave={onSave} />)
    fireEvent.click(codex())
    // Another window's change comes back while this save is on its way, and waits for it.
    rerender(<DynamicThreadsSettings settings={{ ...settings, workersAtOnce: 9 }} onSave={onSave} />)
    expect(codex()).not.toBeChecked()
    // A save that did not land leaves what is held, and the tick goes back with it.
    land(false)
    await vi.waitFor(() => expect(codex()).toBeChecked())
    expect(screen.getByLabelText('Workers at once')).toHaveValue(9)
  })

  it('saves Workers at once when it is left or Enter is pressed, and puts the saved one back rather than a bad one', () => {
    const onSave = vi.fn(() => new Promise(() => undefined))
    render(<DynamicThreadsSettings settings={DEFAULT_DYNAMIC_THREADS} onSave={onSave} />)
    const workers = screen.getByLabelText('Workers at once')
    fireEvent.change(workers, { target: { value: '' } })
    expect(workers).toHaveValue(null)
    fireEvent.blur(workers)
    expect(workers).toHaveValue(4)
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.change(workers, { target: { value: '1000' } })
    fireEvent.keyDown(workers, { key: 'Enter' })
    expect(workers).toHaveValue(4)
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.change(workers, { target: { value: '2' } })
    fireEvent.keyDown(workers, { key: 'Enter' })
    expect(payloads(onSave)[0]?.workersAtOnce).toBe(2)
  })

  it('saves your note once typing pauses or the field is left, as the whole setting, and not when nothing changed', () => {
    vi.useFakeTimers()
    try {
      const onSave = vi.fn(() => new Promise(() => undefined))
      render(<DynamicThreadsSettings settings={{ ...DEFAULT_DYNAMIC_THREADS, providers: ['claude'] }} onSave={onSave} />)
      const note = screen.getByRole('textbox', { name: 'Your note to the overseer' })
      expect(note).toHaveAttribute('maxlength', '600')
      fireEvent.change(note, { target: { value: 'Sol for reviews.' } })
      expect(onSave).not.toHaveBeenCalled()
      vi.advanceTimersByTime(600)
      expect(payloads(onSave)).toEqual([{ ...DEFAULT_DYNAMIC_THREADS, providers: ['claude'], note: 'Sol for reviews.' }])
      fireEvent.change(note, { target: { value: 'Sol for reviews. Opus for debugging.' } })
      fireEvent.blur(note)
      expect(payloads(onSave)[1]?.note).toBe('Sol for reviews. Opus for debugging.')
      fireEvent.blur(note)
      vi.advanceTimersByTime(600)
      expect(onSave).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('keeps your note as typed when its save does not land, and tries again when the field is left', async () => {
    let land: (saved: boolean) => void = () => undefined
    const onSave = vi.fn(() => new Promise<boolean>(resolve => { land = resolve }))
    render(<DynamicThreadsSettings settings={DEFAULT_DYNAMIC_THREADS} onSave={onSave} />)
    const note = screen.getByRole('textbox', { name: 'Your note to the overseer' })
    fireEvent.change(note, { target: { value: 'Sol for reviews.' } })
    fireEvent.blur(note)
    land(false)
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(note).toHaveValue('Sol for reviews.')
    fireEvent.blur(note)
    expect(payloads(onSave)[1]?.note).toBe('Sol for reviews.')
  })

  it('never brings back an older note when its save fails after a newer one was sent', async () => {
    const lands: ((saved: boolean) => void)[] = []
    const onSave = vi.fn(() => new Promise<boolean>(resolve => { lands.push(resolve) }))
    render(<DynamicThreadsSettings settings={DEFAULT_DYNAMIC_THREADS} onSave={onSave} />)
    const note = screen.getByRole('textbox', { name: 'Your note to the overseer' })
    fireEvent.change(note, { target: { value: 'Sol for reviews.' } })
    fireEvent.blur(note)
    fireEvent.change(note, { target: { value: 'Opus for debugging.' } })
    fireEvent.blur(note)
    expect(payloads(onSave).map(item => item.note)).toEqual(['Sol for reviews.', 'Opus for debugging.'])
    lands[0]!(false)
    await Promise.resolve(); await Promise.resolve()
    fireEvent.blur(note)
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  it('names who the work goes to: a company, or for OpenCode, which is a client, its model sources', () => {
    render(<DynamicThreadsSettings settings={DEFAULT_DYNAMIC_THREADS} onSave={vi.fn()} />)
    expect(companyWords('claude')).toBe('Anthropic')
    expect(companyWords('opencode')).toBe('OpenCode\'s model sources')
    expect(screen.getByRole('checkbox', { name: /OpenCode/u }).closest('label')).toHaveTextContent('OpenCode\'s model sources')
  })
})
