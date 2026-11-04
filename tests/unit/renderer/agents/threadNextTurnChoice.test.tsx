import { act, fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ThreadOptions } from '../../../../src/renderer/src/agents/ThreadOptions'
import type { AgentCommand, AgentState } from '../../../../src/shared/agents'
import { fixture, LiveThread, mount, setupThreadOptionsTests } from '../../../fixtures/renderer/threadOptionsHarness'

// A choice for the next turn (#2158, ADR-0190) is an Owl feature (ADR-0072); each test says whether this build has it.
const gate = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'next-turn-choice' && gate.on,
}))

setupThreadOptionsTests()

const codexRunning = (extra: Parameters<typeof fixture>[0] = {}) => fixture({ providerId: 'codex', modelId: 'codex:model', title: 'Codex work',
  status: 'running', nativeSessionStarted: true, reasoningEffort: 'low', runtimeMode: 'auto-accept-edits', ...extra })
const pendingApproval = { id: 'r1', kind: 'permission' as const, text: 'Run ls?', options: [], since: new Date().toISOString() }
const kept = (state: AgentState, options: NonNullable<AgentState['nextTurnSettings']>[number]): AgentState => ({ ...state, nextTurnSettings: [options] })
const CHIPS = ['Thread model', 'Thread reasoning', 'Thread permissions']

describe('a choice for the next turn while a thread works (#2158)', () => {
  it('leaves the model, effort and permission chips pressable while a turn runs with no request', () => {
    gate.on = true
    mount(codexRunning())
    for (const name of CHIPS) expect(screen.getByRole('combobox', { name })).toBeEnabled()
  })

  it('leaves them pressable while an approval waits', () => {
    gate.on = true
    mount(codexRunning({ requests: [pendingApproval] }))
    for (const name of CHIPS) expect(screen.getByRole('combobox', { name })).toBeEnabled()
  })

  it.each([true, false])('never answers a waiting approval from the permission chip (ADR-0004), Owl %s', on => {
    gate.on = on
    const { command } = mount(codexRunning({ requests: [pendingApproval] }))
    const chip = screen.getByRole('combobox', { name: 'Thread permissions' })
    fireEvent.click(chip)
    const full = screen.queryByRole('option', { name: /^Full access/u })
    if (full) fireEvent.click(full)
    for (const [request] of command.mock.calls as unknown as [AgentCommand][]) expect(request.type).toBe('configure-thread')
    if (on) expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'thread', runtimeMode: 'full-access' })
  })

  it('keeps today’s fixed chips on stable', () => {
    gate.on = false
    mount(codexRunning())
    for (const name of CHIPS) expect(screen.getByRole('combobox', { name })).toBeDisabled()
  })

  it('shows the kept choice on its chip, marked pending, and says what this turn and the next run on', () => {
    gate.on = true
    mount(kept(codexRunning(), { threadId: 'thread', reasoningEffort: 'medium' }))
    const effort = screen.getByRole('combobox', { name: 'Thread reasoning' })
    expect(effort).toHaveTextContent('Medium')
    expect(effort).toHaveAttribute('data-pending', 'true')
    expect(screen.getByRole('combobox', { name: 'Thread model' })).not.toHaveAttribute('data-pending')
    const line = 'This turn runs on Codex model, Low effort, Allow edits. The next turn starts on Medium effort.'
    expect(screen.getByText(line)).toBeInTheDocument()
    expect(effort).toHaveAccessibleDescription(line)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names every part of the choice that differs, in the chips’ order', () => {
    gate.on = true
    mount(kept(codexRunning(), { threadId: 'thread', runtimeMode: 'full-access', reasoningEffort: 'max' }))
    expect(screen.getByText('This turn runs on Codex model, Low effort, Allow edits. The next turn starts on Max effort, Full access.')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Thread permissions' })).toHaveAttribute('data-pending', 'true')
  })

  it('puts the choice away with Keep current settings, by sending the values in force', async () => {
    gate.on = true
    const sent: AgentCommand[] = []
    render(<LiveThread start={kept(codexRunning(), { threadId: 'thread', reasoningEffort: 'max', runtimeMode: 'full-access' })}
      answer={async (request, current) => { sent.push(request); return { ...current, nextTurnSettings: [] } }} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep current settings' })) })
    expect(sent).toEqual([{ type: 'configure-thread', threadId: 'thread', reasoningEffort: 'low', runtimeMode: 'auto-accept-edits' }])
    expect(screen.queryByText(/The next turn starts on/u)).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Thread reasoning' })).toHaveTextContent('Low')
  })

  it('shows nothing of a kept choice on stable', () => {
    gate.on = false
    mount(kept(codexRunning(), { threadId: 'thread', reasoningEffort: 'medium' }))
    const effort = screen.getByRole('combobox', { name: 'Thread reasoning' })
    expect(effort).toHaveTextContent('Low')
    expect(effort).not.toHaveAttribute('data-pending')
    expect(screen.queryByText(/The next turn starts on/u)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Keep current settings' })).toBeNull()
  })

  it('says nothing under the chips while a turn runs and nothing is kept', () => {
    gate.on = true
    const state = codexRunning()
    render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={vi.fn(async () => state)} />)
    expect(screen.queryByText(/The next turn starts on/u)).toBeNull()
    expect(screen.queryByText('Available after this turn finishes.')).toBeNull()
  })
})
