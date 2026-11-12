import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DetachedRunStopContext, StillWorking } from '../../../src/renderer/src/agents/DelegatedWork'
import type { AgentBackgroundWork } from '../../../src/shared/agentMonitoring'

afterEach(cleanup)

const run: AgentBackgroundWork = {
  id: 'ced23e61-1ed2-577f-9219-04dcdf869f0d', label: 'tetherfall-art-director', type: 'detached-run', startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  run: { client: 'Claude Code', model: 'claude-fable-5-2', effort: 'high', folder: '/home/zach/Projects/2.5 shooter/.claude/worktrees/art-push',
    command: 'claude -p --name tetherfall-art-director --model claude-fable-5-2 --effort high "Read and do .zstack/studio/art-push/director.md"' },
}
const subagent: AgentBackgroundWork = { id: '0d5c4b7e-3f5a-4f0e-8a51-2b8f1c9d7e60', label: 'Review the diff', type: 'subagent' }

it('shows a detached run under the reply with what Sotto read about it, its command behind a disclosure', () => {
  render(<DetachedRunStopContext.Provider value={vi.fn()}><StillWorking views={undefined} work={[subagent, run]} /></DetachedRunStopContext.Provider>)
  const still = screen.getByRole('region', { name: 'Still working after this reply' })
  const row = within(still).getByRole('listitem', { name: 'Detached run: tetherfall-art-director, Working' })
  expect(row).toHaveTextContent('Claude Code·claude-fable-5-2, high·/home/zach/Projects/2.5 shooter/.claude/worktrees/art-push·running 20m')
  expect(row).toHaveTextContent('Started from this thread and left running after its turn.')
  expect(row).toHaveAccessibleDescription(/Claude Code.*Started from this thread/su)
  const command = within(row).getByText('Command').closest('details')!
  expect(command.open).toBe(false)
  expect(command).toHaveTextContent('Read and do .zstack/studio/art-push/director.md')
  // The provider's own agent keeps its row, with no Stop.
  const agentRow = within(still).getByRole('listitem', { name: 'Subagent: Review the diff, Working' })
  expect(within(agentRow).queryByRole('button')).toBeNull()
})

it('stops a run on a press, and says why when it could not', async () => {
  const stop = vi.fn().mockResolvedValueOnce('That detached run has already ended. Nothing was stopped.').mockResolvedValueOnce(null)
  render(<DetachedRunStopContext.Provider value={stop}><StillWorking views={undefined} work={[run]} /></DetachedRunStopContext.Provider>)
  const button = screen.getByRole('button', { name: 'Stop the detached run tetherfall-art-director' })
  fireEvent.click(button)
  expect(stop).toHaveBeenCalledWith(run.id)
  expect(await screen.findByRole('alert')).toHaveTextContent('That detached run has already ended. Nothing was stopped.')
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(stop).toHaveBeenCalledTimes(2)
})

it('has no Stop where nothing may stop a run', () => {
  render(<StillWorking views={undefined} work={[run]} />)
  expect(screen.queryByRole('button', { name: /Stop/u })).toBeNull()
  expect(screen.getByRole('listitem', { name: 'Detached run: tetherfall-art-director, Working' })).toBeInTheDocument()
})
