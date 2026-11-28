// ADR-0218: Settings › Scheduled tasks sets a task up through its editor, says why one can't be saved, closes the editor
// on Escape, and answers a run that waits on the user with the user's own choice and note. Only Synthetic words are used.
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduledTasksSettings } from '../../../src/renderer/src/features/settings/ScheduledTasksSettings'
import type { RunView, ScheduledTaskCommand, ScheduledTasksBridge, ScheduledTasksState } from '../../../src/shared/scheduledTasks'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { threadsStateFixture } from '../../fixtures/agentState'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const RUN_ID = '00000000-0000-4000-8000-000000000001'
const TASK_ID = '00000000-0000-4000-8000-000000000002'
const waitingRun: RunView = {
  id: RUN_ID, taskId: TASK_ID, taskName: 'Synthetic triage', trigger: 'github', eventRef: 'synthetic/repository#7', createdAt: '2026-11-26T09:00:00.000Z',
  state: 'waiting', wait: 'decision', playbook: { id: 'triage', name: 'Synthetic playbook', revision: 'abc' }, threadIds: [],
  steps: [{ id: 'decide', kind: 'decision', title: 'Fix it?', state: 'waiting', attempts: 0, maxAttempts: 1, question: 'Fix Synthetic bug 7?', noteLabel: 'Anything the fix should know', noteRequired: false }],
}

function fakeBridge(initial: Partial<ScheduledTasksState> = {}) {
  let state: ScheduledTasksState = { available: true, enabled: true, tasks: [], runs: [], playbooks: [], playbooksFolder: 'D:/synthetic/playbooks',
    webhooks: { listening: false }, credentials: true, ...initial }
  const listeners = new Set<(next: ScheduledTasksState) => void>()
  const bridge: ScheduledTasksBridge = {
    read: vi.fn(async () => state),
    command: vi.fn(async (command: ScheduledTaskCommand) => {
      if (command.type === 'save') {
        state = { ...state, tasks: [...state.tasks, { ...command.spec, id: TASK_ID, createdAt: '2026-11-26T09:00:00.000Z', updatedAt: '2026-11-26T09:00:00.000Z', paused: false, webhookSecret: false }] }
        for (const listener of listeners) listener(state)
        return { ok: true as const, id: TASK_ID, message: `${command.spec.name} is saved.` }
      }
      if (command.type === 'decide') {
        state = { ...state, runs: state.runs.map(run => run.id === command.run ? { ...run, state: 'running' as const } : run) }
        for (const listener of listeners) listener(state)
      }
      return { ok: true as const }
    }),
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return bridge
}

function setup(bridge: ScheduledTasksBridge) {
  const onUpdateSettings = vi.fn(async () => true)
  render(<ScheduledTasksSettings settings={{ ...DEFAULT_SETTINGS, scheduledTasksEnabled: true }} onUpdateSettings={onUpdateSettings} shown bridge={bridge}
    agentState={threadsStateFixture()} />)
  return { onUpdateSettings }
}

describe('Settings > Scheduled tasks', () => {
  it('sets up a prompt task every two hours in a new thread, and says first what is missing', async () => {
    const bridge = fakeBridge()
    setup(bridge)
    const user = userEvent.setup()
    expect(await screen.findByText('No scheduled tasks yet.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New task' }))
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Give the task a name.')
    expect(bridge.command).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Name'), 'Synthetic review')
    await user.type(screen.getByLabelText('Prompt'), 'Synthetic scheduled prompt')
    await user.selectOptions(screen.getByLabelText('Schedule'), 'every')
    await user.clear(screen.getByLabelText('Every'))
    await user.type(screen.getByLabelText('Every'), '2')
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledTimes(1))
    const [saved] = vi.mocked(bridge.command).mock.calls[0]!
    expect(saved).toMatchObject({ type: 'save', spec: { name: 'Synthetic review', work: { kind: 'prompt', prompt: 'Synthetic scheduled prompt' },
      target: { kind: 'new-thread', workingCopy: 'shared' }, schedule: { kind: 'every', minutes: 120 }, missed: 'run-once', overlap: 'skip', webhook: false, github: null } })
    expect(await screen.findByText('Synthetic review is saved.')).toBeInTheDocument()
    expect(screen.getByText('Synthetic review')).toBeInTheDocument()
    expect(screen.getByText('Every 2 hours')).toBeInTheDocument()
  })

  it('closes the editor on Escape without saving', async () => {
    const bridge = fakeBridge()
    setup(bridge)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'New task' }))
    expect(screen.getByRole('form', { name: 'New scheduled task' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('form', { name: 'New scheduled task' })).toBeNull()
    expect(bridge.command).not.toHaveBeenCalled()
  })

  it('allows an outside-only task to queue overlapping triggers', async () => {
    const bridge = fakeBridge()
    setup(bridge)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'New task' }))
    await user.type(screen.getByLabelText('Name'), 'Synthetic webhook')
    await user.type(screen.getByLabelText('Prompt'), 'Synthetic scheduled prompt')
    await user.selectOptions(screen.getByLabelText('Schedule'), 'none')
    await user.click(screen.getByRole('switch', { name: 'A signed webhook' }))
    await user.selectOptions(screen.getByLabelText('A trigger that comes while the last run is going'), 'queue')
    await user.click(screen.getByRole('button', { name: 'Save task' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({
      type: 'save', spec: expect.objectContaining({ schedule: null, webhook: true, overlap: 'queue' }),
    })))
  })

  it('offers recovery when the only prompt may not have reached its thread', async () => {
    const bridge = fakeBridge({ runs: [{ ...waitingRun, state: 'held', wait: 'uncertain', playbook: undefined, steps: [
      { id: 'prompt', kind: 'agent', title: 'prompt', state: 'uncertain', attempts: 1, maxAttempts: 1, note: 'Synthetic delayed prompt' },
    ] }] })
    setup(bridge)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Do it again' }))
    expect(bridge.command).toHaveBeenCalledWith({ type: 'resolve', run: RUN_ID, step: 'prompt', choice: 'again' })
  })

  it('answers a run waiting on a decision with the user\'s own choice and note', async () => {
    const bridge = fakeBridge({ runs: [waitingRun] })
    setup(bridge)
    const user = userEvent.setup()
    expect(await screen.findByText('Fix Synthetic bug 7?')).toBeInTheDocument()
    expect(screen.getByText('Only you answer these. A webhook, an issue or an agent can’t.')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Anything the fix should know'), 'Synthetic note')
    await user.click(screen.getByRole('button', { name: 'Go on' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ type: 'decide', run: RUN_ID, step: 'decide', choice: 'approve', note: 'Synthetic note' }))
    await waitFor(() => expect(screen.queryByText('Fix Synthetic bug 7?')).toBeNull())
  })

  it('turns scheduled tasks off through the setting and says where this computer runs none', async () => {
    const bridge = fakeBridge()
    const { onUpdateSettings } = setup(bridge)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('switch', { name: /Run scheduled tasks on this computer/u }))
    expect(onUpdateSettings).toHaveBeenCalledWith({ scheduledTasksEnabled: false })
    cleanup()
    setup(fakeBridge({ available: false, unavailable: 'Synthetic: this computer runs no scheduled tasks.' }))
    expect(await screen.findByText('Synthetic: this computer runs no scheduled tasks.')).toBeInTheDocument()
    await act(async () => undefined)
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
  })
})
