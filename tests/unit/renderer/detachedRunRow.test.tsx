import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DetachedRunStopContext, StillWorking, stillWorkingAgents } from '../../../src/renderer/src/agents/DelegatedWork'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import type { AgentBackgroundWork } from '../../../src/shared/agentMonitoring'
import type { AgentMessage } from '../../../src/shared/agents'

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

it('closes the open command on Escape and gives focus back to its summary', () => {
  render(<StillWorking views={undefined} work={[run]} />)
  const summary = screen.getByText('Command')
  const details = summary.closest('details')!
  details.open = true
  fireEvent.keyDown(summary, { key: 'Escape' })
  expect(details.open).toBe(false)
  expect(summary).toHaveFocus()
})

it('keeps a run, its only Stop, whatever else holds the thread: an error, a card waiting on the user', () => {
  expect(stillWorkingAgents([subagent, run], false)).toEqual([run])
  expect(stillWorkingAgents([subagent, run], true)).toEqual([subagent, run])
  expect(stillWorkingAgents([subagent], false)).toBeUndefined()
})

it('keeps the row under the last finished reply while a new turn runs', () => {
  const at = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
  const messages: AgentMessage[] = [
    { id: 'ask', role: 'user', text: 'Start the art director on its own.', createdAt: at(30) },
    { id: 'reply', role: 'assistant', text: 'It is running on its own now.', createdAt: at(29) },
    { id: 'later', role: 'user', text: 'Now fix the title screen.', createdAt: at(1) },
  ]
  const context: ActivityContext = { liveTurn: null, running: true, connected: true, provider: 'claude', onDisclosure: () => undefined }
  render(<MessageList messages={messages} provider="Claude Code" running placement={placeActivities(messages, messages, [])} context={context} backgroundWork={[run]} />)
  const order = [...document.querySelectorAll('[data-message-id], .delegated-work__row')].map(element => element.getAttribute('data-message-id') ?? element.getAttribute('aria-label'))
  expect(order).toEqual(['ask', 'reply', 'Detached run: tetherfall-art-director, Working', 'later'])
})

it('shows the row under the thread\'s only turn while it runs, when there is no finished reply above it', () => {
  const messages: AgentMessage[] = [{ id: 'ask', role: 'user', text: 'Start the art director on its own.', createdAt: new Date(Date.now() - 60_000).toISOString() }]
  const context: ActivityContext = { liveTurn: null, running: true, connected: true, provider: 'claude', onDisclosure: () => undefined }
  render(<MessageList messages={messages} provider="Claude Code" running placement={placeActivities(messages, messages, [])} context={context} backgroundWork={[run]} />)
  expect(screen.getByRole('listitem', { name: 'Detached run: tetherfall-art-director, Working' })).toBeInTheDocument()
})
