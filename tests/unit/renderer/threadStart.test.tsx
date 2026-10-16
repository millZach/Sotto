import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentThreadStart, HandoverCounts } from '../../../src/shared/agents'
import { StartHandoverCard, ThreadStartContext, ThreadStartNote, threadStartView } from '../../../src/renderer/src/agents/ThreadStart'
import { MessageList } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'

// Where a thread that began from another began, as its transcript says it (#1028).

afterEach(cleanup)

const counts: HandoverCounts = { total: 2, carried: 2, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true }
const at = '2026-10-16T14:41:00.000Z'
const forked: AgentThreadStart = { threadId: 'audio', from: 'agent', route: 'fork', at, agentTitle: 'Check streaming performance' }
const handed: AgentThreadStart = { threadId: 'wav', from: 'agent', route: 'handover', at, agentTitle: 'Verify history-off cleanup', agentId: 'claude-agent', assignmentId: 'a-1', handover: { thin: true, counts } }

describe('a thread that began from an agent', () => {
  it('says Codex forked the agent and kept its task encrypted, and opens the thread it came from', async () => {
    const command = vi.fn()
    const view = threadStartView({ id: 'continued', startedFrom: forked, providerId: 'codex' }, { title: 'Audio pipeline review', providerId: 'codex' }, command, undefined)!
    render(<ThreadStartNote view={view} />)
    const note = screen.getByRole('note')
    expect(note.textContent).toMatch(/^Codex forked the agent Check streaming performance from Audio pipeline review into this thread, .+\. It carried the agent’s whole conversation, including its task, which Codex keeps encrypted, so Sotto can’t show it here\. The agent’s row in Audio pipeline review is unchanged\./u)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Audio pipeline review' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'audio' })
  })

  it('names a source that is no longer listed without offering to open it', () => {
    const view = threadStartView({ id: 'continued', startedFrom: handed, providerId: 'claude' }, undefined, vi.fn(), undefined)!
    render(<ThreadStartNote view={view} />)
    expect(screen.getByRole('note').textContent).toBe('Continued from the agent Verify history-off cleanup in a thread that is no longer listed.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the handover waiting for the first message, and reads its words only when asked, folding them on Escape', async () => {
    const user = userEvent.setup()
    const read = vi.fn(async () => ({ text: 'This is a handover from an agent of another Sotto thread.' }))
    const view = threadStartView({ id: 'continued', startedFrom: handed, providerId: 'claude' }, { title: 'WAV preview stall', providerId: 'claude' }, vi.fn(), read)!
    render(<StartHandoverCard view={view} createdAt={at} />)
    const card = screen.getByRole('article', { name: 'Handover this thread started from' })
    expect(card.textContent).toContain('Handover, thin')
    expect(card.textContent).toContain('From the agent Verify history-off cleanup in WAV preview stall. Context, not a new request. It goes with your first message.')
    expect(card.textContent).toContain('Carries the task and the result. Leaves out everything the agent did on the way.')
    expect(read).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Read the handover, word for word' }))
    expect(read).toHaveBeenCalledWith('continued')
    expect(screen.getByRole('region', { name: 'The handover, word for word' }).textContent).toBe('This is a handover from an agent of another Sotto thread.')
    screen.getByRole('region', { name: 'The handover, word for word' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'The handover, word for word' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Read the handover, word for word' })).toHaveFocus()
  })

  it('shows the handover a first message went with, in the past tense, from its own words', async () => {
    const view = threadStartView({ id: 'continued', startedFrom: handed, providerId: 'claude' }, { title: 'WAV preview stall', providerId: 'claude' }, vi.fn(), undefined)!
    render(<StartHandoverCard view={view} createdAt={at} handover={{ text: 'The words as sent.', provider: 'claude', counts }} />)
    const card = screen.getByRole('article', { name: 'Handover this thread started from' })
    expect(card.textContent).toContain('Carried the task and the result. Left out everything the agent did on the way.')
    expect(card.textContent).not.toContain('It goes with your first message.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Read the handover, word for word' }))
    expect(screen.getByRole('region', { name: 'The handover, word for word' }).textContent).toBe('The words as sent.')
  })

  it('names the agent plainly when Keep local history kept no title for it', () => {
    const { agentTitle, ...untitled } = handed; void agentTitle
    const view = threadStartView({ id: 'continued', startedFrom: untitled, providerId: 'claude' }, { title: 'WAV preview stall', providerId: 'claude' }, vi.fn(), undefined)!
    render(<ThreadStartNote view={view} />)
    expect(screen.getByRole('note').textContent).toBe('Continued from one of its agents in WAV preview stall. Open WAV preview stall')
  })

  it('draws no handover at all for a thread that began from another while the feature is off', () => {
    const messages: AgentMessage[] = [{ id: 'first', role: 'user', text: 'Add a test for the drafts.', createdAt: at, handover: { text: 'The handover as sent.', provider: 'claude', counts } }]
    render(<ThreadStartContext.Provider value="off"><MessageList messages={messages} provider="claude" running={false} placement={placeActivities(messages, messages, [])} context={{ liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }} /></ThreadStartContext.Provider>)
    expect(screen.queryByRole('article', { name: 'Handover this thread started from' })).toBeNull()
    expect(screen.queryByText(/Watcher/u)).toBeNull()
    expect(screen.getByText('Add a test for the drafts.')).toBeTruthy()
  })
})
