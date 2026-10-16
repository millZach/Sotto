import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentModel, AgentState } from '../../../src/shared/agents'
import type { SubagentRow } from '../../../src/shared/subagents'
import { AGENT_FORK_GONE, AGENT_STILL_WORKING } from '../../../src/shared/threadStarts'
import { AgentContinue, AgentContinueContext, agentStartModel, type AgentContinueOptions } from '../../../src/renderer/src/tools/AgentContinue'
import { thinLedger } from '../../../src/renderer/src/agents/ThreadStart'

// Continue as a thread in an agent's row (#1028, the continue prototype's variant B, in place).

afterEach(cleanup)

const models: AgentModel[] = [
  { id: 'native:codex:model:gpt-5.5', provider: 'Codex', providerId: 'codex', name: 'GPT-5.5', ready: true },
  { id: 'native:codex:model:gpt-5.4', provider: 'Codex', providerId: 'codex', name: 'GPT-5.4', ready: true },
  { id: 'native:claude:model:sonnet', provider: 'Claude', providerId: 'claude', name: 'Sonnet 5.5', ready: true },
]
const row = (patch: Partial<SubagentRow> = {}): SubagentRow => ({ id: 'codex-agent-perf', sequence: 1, revision: 1, assignmentId: 'perf-1', assignmentCount: 1,
  title: 'Check streaming performance', description: 'Time each chunk.', model: 'gpt-5.4', status: 'completed', lastObservedAt: '2026-10-16T12:00:00.000Z', ...patch })
function options(command: (command: AgentCommand) => Promise<AgentState | null>, patch: Partial<AgentContinueOptions> = {}): AgentContinueOptions {
  return { threadId: 'audio', threadTitle: 'Audio pipeline review', provider: 'codex', projectId: 'workshop', remote: false, where: 'This computer', models,
    sourceModelId: 'native:codex:model:gpt-5.5', command, workingCopyOptions: async () => ({ isGit: true, currentBranch: 'main', branches: ['main'], worktrees: [] }), ...patch }
}
const answer = (error: string | null): AgentState => ({ error } as AgentState)
function show(value: AgentContinueOptions | null, agent = row()) {
  return render(<AgentContinueContext.Provider value={value}><ul><li className="subagent-item"><div className="subagent-details"><AgentContinue row={agent} /></div></li></ul></AgentContinueContext.Provider>)
}

describe('Continue as a thread', () => {
  it('starts on the agent’s own model where its host has it, else its thread’s', () => {
    const base = { models, provider: 'codex' as const, sourceModelId: 'native:codex:model:gpt-5.5' }
    expect(agentStartModel(base, { model: 'gpt-5.4' }, true)).toBe('native:codex:model:gpt-5.4')
    expect(agentStartModel(base, { model: 'unknown' }, true)).toBe('native:codex:model:gpt-5.5')
    expect(agentStartModel({ ...base, provider: 'claude', sourceModelId: 'native:claude:model:sonnet' }, { model: undefined }, false)).toBe('native:claude:model:sonnet')
  })

  it('offers nothing where the feature is off, and refuses a working agent before any press', () => {
    const { unmount } = show(null)
    expect(screen.queryByRole('button', { name: /as its own thread/u })).toBeNull()
    unmount()
    show(options(vi.fn()), row({ status: 'running' }))
    expect(screen.getByRole('button', { name: 'Continue Check streaming performance as its own thread' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('It’s still working. Continue it once it finishes.')).toBeTruthy()
    void AGENT_STILL_WORKING
  })

  it('opens a fork form in place, from the keyboard, and Escape returns focus to the press', async () => {
    const user = userEvent.setup()
    const command = vi.fn(async () => answer(null))
    show(options(command))
    const press = screen.getByRole('button', { name: 'Continue Check streaming performance as its own thread' })
    press.focus()
    await user.keyboard('{Enter}')
    const form = screen.getByRole('region', { name: 'Fork it into a new Codex thread' })
    expect(form.textContent).toContain('Codex keeps the task encrypted; the fork carries it and Sotto never reads it.')
    expect(screen.getByRole('button', { name: 'Start the thread' })).toHaveFocus()
    expect(screen.getByRole('combobox', { name: 'Model for the forked thread' })).toHaveValue('native:codex:model:gpt-5.4')
    await waitFor(() => expect(screen.getByRole('option', { name: 'New worktree from main' })).toBeTruthy())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Fork it into a new Codex thread' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Continue Check streaming performance as its own thread' })).toHaveFocus()
    expect(command).not.toHaveBeenCalled()
  })

  it('asks main to continue the agent into a new worktree, and offers a thin handover when Codex no longer has it', async () => {
    const user = userEvent.setup()
    const command = vi.fn<(command: AgentCommand) => Promise<AgentState | null>>(async () => answer(AGENT_FORK_GONE))
    show(options(command))
    await user.click(screen.getByRole('button', { name: 'Continue Check streaming performance as its own thread' }))
    await waitFor(() => expect(screen.getByRole('option', { name: 'New worktree from main' })).toBeTruthy())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Working copy for the new thread' }), 'independent')
    await user.click(screen.getByRole('button', { name: 'Start the thread' }))
    expect(command.mock.calls[0]![0]).toMatchObject({ type: 'continue-agent', threadId: 'audio', agentId: 'codex-agent-perf', modelId: 'native:codex:model:gpt-5.4', workingCopy: 'independent', baseBranch: 'main' })
    expect(command.mock.calls[0]![0]).not.toHaveProperty('handover')
    const gone = await screen.findByRole('region', { name: 'Codex can’t fork this agent' })
    expect(gone.textContent).toContain(AGENT_FORK_GONE)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start from a handover' })).toHaveFocus())
    command.mockResolvedValueOnce(answer(null))
    await user.click(screen.getByRole('button', { name: 'Start from a handover' }))
    expect(command.mock.calls[1]![0]).toMatchObject({ type: 'continue-agent', agentId: 'codex-agent-perf', handover: true })
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Codex can’t fork this agent' })).toBeNull())
  })

  it('continues a Claude Code agent from a thin handover on any ready model, and says plainly what it carries', async () => {
    const user = userEvent.setup()
    const command = vi.fn(async () => answer('Sotto no longer lists this agent, so nothing was made. Open Agents again and choose it.'))
    show(options(command, { provider: 'claude', sourceModelId: 'native:claude:model:sonnet', remote: true, where: 'forge', workingCopyOptions: undefined }), row({ id: 'claude-agent-verify', model: 'sonnet' }))
    await user.click(screen.getByRole('button', { name: /as its own thread/u }))
    const form = screen.getByRole('region', { name: 'Continue it from a handover' })
    expect(form.textContent).toContain('This handover is thin.')
    expect(form.textContent).toContain('Carries the task and the result. Leaves out everything the agent did on the way.')
    expect(form.textContent).toContain('forge')
    // A paired host's thread whose Git status has not arrived offers only its own folder.
    expect(screen.queryByRole('option', { name: /New worktree/u })).toBeNull()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['GPT-5.5', 'GPT-5.4', 'Sonnet 5.5', 'Same folder'])
    await user.click(screen.getByRole('button', { name: 'Start the thread' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Sotto no longer lists this agent, so nothing was made. Open Agents again and choose it.')
  })

  it('words a thin handover’s ledger by what it carried', () => {
    const counts = { total: 2, carried: 2, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true }
    expect(thinLedger(counts, 'claude')).toEqual({ carried: 'the task and the result', leftOut: 'everything the agent did on the way' })
    expect(thinLedger({ ...counts, total: 1, carried: 1 }, 'codex')).toEqual({ carried: 'the agent’s title and the result', leftOut: 'its task, which Codex kept encrypted and everything the agent did on the way' })
  })

  it('says a part too long to carry was left out, and never claims it', () => {
    const counts = { total: 2, carried: 1, tooLong: 1, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true }
    expect(thinLedger(counts, 'claude')).toEqual({ carried: 'only one of the task and the result', leftOut: 'the other, too long to carry and everything the agent did on the way' })
    expect(thinLedger({ ...counts, carried: 0, tooLong: 2 }, 'claude')).toEqual({ carried: 'only the agent’s title', leftOut: 'the task and the result, too long to carry and everything the agent did on the way' })
  })

  it('refuses an agent Sotto last saw working before any press', () => {
    show(options(vi.fn()), row({ status: 'unknown' }))
    expect(screen.getByRole('button', { name: 'Continue Check streaming performance as its own thread' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Sotto last saw it working. Continue it once it shows as finished.')).toBeTruthy()
  })

  it('starts a new worktree from the branch its thread works on, on a paired host too', async () => {
    const user = userEvent.setup()
    const command = vi.fn(async () => answer(null))
    show(options(command, { remote: true, where: 'forge', workingCopyOptions: undefined, sourceBranch: { currentBranch: 'sotto/audio' } }))
    await user.click(screen.getByRole('button', { name: /as its own thread/u }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Working copy for the new thread' }), 'New worktree from sotto/audio')
    await user.click(screen.getByRole('button', { name: 'Start the thread' }))
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'continue-agent', workingCopy: 'independent', baseBranch: 'sotto/audio' }))
  })

  it('offers the new worktree once the thread’s Git status arrives with the form open', async () => {
    const user = userEvent.setup()
    const remote = options(vi.fn(), { remote: true, where: 'forge', workingCopyOptions: undefined })
    const { rerender } = show(remote)
    await user.click(screen.getByRole('button', { name: /as its own thread/u }))
    expect(screen.queryByRole('option', { name: /New worktree/u })).toBeNull()
    rerender(<AgentContinueContext.Provider value={{ ...remote, sourceBranch: { currentBranch: 'sotto/audio' } }}><ul><li className="subagent-item"><div className="subagent-details"><AgentContinue row={row()} /></div></li></ul></AgentContinueContext.Provider>)
    expect(screen.getByRole('option', { name: 'New worktree from sotto/audio' })).toBeTruthy()
  })

  it('lets Escape go past the row once the form is closed', async () => {
    const user = userEvent.setup()
    const outside = vi.fn()
    render(<div onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) outside() }}><AgentContinueContext.Provider value={options(vi.fn())}><AgentContinue row={row()} /></AgentContinueContext.Provider></div>)
    await user.click(screen.getByRole('button', { name: /as its own thread/u }))
    await user.keyboard('{Escape}')
    expect(outside).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /as its own thread/u })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(outside).toHaveBeenCalledTimes(1)
  })
})
