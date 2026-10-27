import React, { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentModel, AgentState, AgentThreadStart, HandoverCounts, ProviderId } from '../../../src/shared/agents'
import { ForkCard, ForkContext, ForkLandingContext, ForkPress, forkModel, type ForkOptions } from '../../../src/renderer/src/agents/ForkFromHere'
import { StartHandoverCard, ThreadStartNote, threadStartView } from '../../../src/renderer/src/agents/ThreadStart'

// Fork from here (#1028, E5b; the continue prototype's variant B, in place): the press under a reply, its card in the
// transcript, and the note and handover a fork starts with.

afterEach(cleanup)

const models: AgentModel[] = [
  { id: 'native:claude:model:sonnet', provider: 'Claude', providerId: 'claude', name: 'Sonnet 5.5', ready: true },
  { id: 'native:claude:model:opus', provider: 'Claude', providerId: 'claude', name: 'Opus 5.5', ready: true },
  { id: 'native:grok:model:grok-5', provider: 'Grok', providerId: 'grok', name: 'Grok 5', ready: true },
  { id: 'native:codex:model:gpt-5.5', provider: 'Codex', providerId: 'codex', name: 'GPT-5.5', ready: true },
]
const AT = '2026-10-16T12:05:00.000Z'
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const answer = (error: string | null): AgentState => ({ error, host: { threads: [] } } as unknown as AgentState)

function Transcript({ provider, command, busy = false, sourceBranch, ready = models, threadId = 'wav' }: { readonly provider: ProviderId; readonly command: (command: AgentCommand) => Promise<AgentState | null>; readonly busy?: boolean
  readonly sourceBranch?: { readonly currentBranch: string | null }; readonly ready?: readonly AgentModel[]; readonly threadId?: string }) {
  const [openAt, open] = useState<string | null>(null)
  const options: ForkOptions = { threadId, threadTitle: 'WAV preview stall', provider, projectId: 'workshop', where: 'This computer', remote: false, models: ready,
    modelId: provider === 'claude' ? 'native:claude:model:sonnet' : provider === 'grok' ? 'native:grok:model:grok-5' : 'native:codex:model:gpt-5.5', command,
    ...(sourceBranch ? { sourceBranch } : {}), openAt, open, after: new Set(openAt ? ['later'] : []), busy }
  return <ForkContext.Provider value={options}>
    <article className="thread-message" data-message-id="reply"><p>Fixed: the length marker is now patched after every chunk.</p><ForkPress messageId="reply" at={AT} /></article>
    <ForkCard messageId="reply" at={AT} />
    <article className="thread-message" data-message-id="later" data-not-carried={options.after.has('later') || undefined}><p>Here is the full test output.</p></article>
  </ForkContext.Provider>
}

describe('Fork from here', () => {
  it('opens its card under the reply from the keyboard, and Escape puts it away and returns to the press', async () => {
    const user = userEvent.setup()
    const command = vi.fn(async () => answer(null))
    render(<Transcript provider="claude" command={command} sourceBranch={{ currentBranch: 'main' }} />)
    const press = screen.getByRole('button', { name: /^Fork from here: a new thread with this conversation up to this reply/u })
    press.focus()
    await user.keyboard('{Enter}')
    const card = screen.getByRole('region', { name: 'Fork from here' })
    expect(card.textContent).toContain('A new Claude Code thread with everything above this line, through Claude Code’s own fork.')
    expect(card.textContent).toContain('Files aren’t rewound')
    expect(screen.getByRole('button', { name: 'Fork' })).toHaveFocus()
    expect(screen.getByText('Not carried: this stays in WAV preview stall')).toBeTruthy()
    expect(document.querySelector('[data-message-id="later"]')).toHaveAttribute('data-not-carried', 'true')
    // A Claude Code fork lives where its thread's session does, so no new worktree is offered.
    expect(screen.queryByRole('option', { name: /New worktree/u })).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Fork from here' })).toBeNull()
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /^Fork from here/u })).toHaveFocus())
    expect(document.querySelector('[data-message-id="later"]')).not.toHaveAttribute('data-not-carried')
    expect(command).not.toHaveBeenCalled()
  })

  it('asks main for a fork at the reply on the model chosen, in a new worktree where the provider can', async () => {
    const user = userEvent.setup()
    const command = vi.fn(async () => answer(null))
    render(<Transcript provider="codex" command={command} sourceBranch={{ currentBranch: 'sotto/wav' }} />)
    await user.click(screen.getByRole('button', { name: /^Fork from here/u }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Working copy for the forked thread' }), 'New worktree from sotto/wav')
    await user.click(screen.getByRole('button', { name: 'Fork' }))
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'fork-thread', threadId: 'wav', messageId: 'reply', modelId: 'native:codex:model:gpt-5.5', workingCopy: 'independent', baseBranch: 'sotto/wav' }))
    expect(screen.queryByRole('region', { name: 'Fork from here' })).toBeNull()
  })

  it('starts a Grok Build fork from a handover, on its thread’s own model, and says a refusal in the card', async () => {
    const user = userEvent.setup()
    const command = vi.fn(async () => answer('Sotto no longer has that reply in this thread, so nothing was made. Refresh the thread and try again.'))
    render(<Transcript provider="grok" command={command} />)
    await user.click(screen.getByRole('button', { name: /^Fork from here/u }))
    const card = screen.getByRole('region', { name: 'Fork from here' })
    expect(card.textContent).toContain('Grok Build has no fork of its own, so the new Grok Build thread starts from a handover of this conversation up to')
    expect(screen.queryByRole('combobox', { name: 'Model for the forked thread' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Start the Grok Build thread' }))
    const sent = (command.mock.calls[0] as unknown as [AgentCommand])[0]
    expect(sent).toMatchObject({ type: 'fork-thread', messageId: 'reply', workingCopy: 'shared' })
    expect(sent).not.toHaveProperty('modelId')
    expect((await screen.findByRole('alert')).textContent).toBe('Sotto no longer has that reply in this thread, so nothing was made. Refresh the thread and try again.')
  })

  it('waits while a turn runs, saying so on the press', async () => {
    render(<Transcript provider="claude" command={vi.fn()} busy />)
    const press = screen.getByRole('button', { name: 'Fork from here: wait for this turn to finish first' })
    expect(press).toHaveAttribute('aria-disabled', 'true')
    await userEvent.setup().click(press)
    expect(screen.queryByRole('region', { name: 'Fork from here' })).toBeNull()
  })

  it('answers Escape with nothing to press, and returns focus to its own transcript’s press', async () => {
    const user = userEvent.setup()
    // The source and its fork side by side show the same reply under the same ID.
    render(<><div className="thread-transcript" data-testid="source"><Transcript provider="codex" command={vi.fn()} /></div>
      <div className="thread-transcript" data-testid="fork"><Transcript provider="codex" command={vi.fn()} ready={[]} /></div></>)
    const press = screen.getAllByRole('button', { name: /^Fork from here/u })[1]!
    press.focus()
    await user.keyboard('{Enter}')
    const card = screen.getByRole('region', { name: 'Fork from here' })
    expect(screen.getByRole('button', { name: 'Fork' })).toBeDisabled()
    expect(card).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Fork from here' })).toBeNull()
    await vi.waitFor(() => expect(screen.getByTestId('fork').querySelector('[data-fork-at]')).toHaveFocus())
  })

  it('hands the fork to where it lands and puts the cursor in its composer once its pane is drawn, and hands nothing on a refusal', async () => {
    const user = userEvent.setup()
    // A pane showing the fork, drawn once the place it lands takes it, as Watcher's beside pane and Threads' panes are.
    function Room({ command }: { readonly command: (command: AgentCommand) => Promise<AgentState | null> }) {
      const [shown, land] = useState<string | null>(null)
      return <ForkLandingContext.Provider value={land}>
        {shown === null ? <Transcript provider="claude" command={command} threadId={`host:${HOST}:wav`} />
          : <section className="thread-pane" data-thread-id={shown}><div className="thread-workspace__compose"><textarea aria-label="Prompt" /></div></section>}
      </ForkLandingContext.Provider>
    }
    const refused = vi.fn(async () => answer('That model or account is unavailable. Choose a ready model; Sotto will not switch your account. Nothing was made.'))
    const first = render(<Room command={refused} />)
    await user.click(screen.getByRole('button', { name: /^Fork from here/u }))
    await user.click(screen.getByRole('button', { name: 'Fork' }))
    expect(screen.getByRole('alert').textContent).toContain('Nothing was made.')
    expect(screen.getByRole('region', { name: 'Fork from here' })).toBeTruthy()
    expect(document.querySelector('.thread-pane')).toBeNull()
    first.unmount()

    // Main makes the fork on its source's host, and the window lists it under that host's key, as it knows every thread.
    const command = vi.fn(async (request: AgentCommand) => ({ error: null, host: { threads: [{ id: `host:${HOST}:${request.type === 'fork-thread' ? request.newThreadId : ''}` }] } } as unknown as AgentState))
    render(<Room command={command} />)
    await user.click(screen.getByRole('button', { name: /^Fork from here/u }))
    await user.click(screen.getByRole('button', { name: 'Fork' }))
    const sent = (command.mock.calls[0] as unknown as [Extract<AgentCommand, { type: 'fork-thread' }>])[0]
    expect(document.querySelector('.thread-pane')).toHaveAttribute('data-thread-id', `host:${HOST}:${sent.newThreadId}`)
    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus())
  })

  it('offers the new worktree once the thread’s Git status arrives with the card open', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Transcript provider="codex" command={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /^Fork from here/u }))
    expect(screen.queryByRole('option', { name: /New worktree/u })).toBeNull()
    rerender(<Transcript provider="codex" command={vi.fn()} sourceBranch={{ currentBranch: 'sotto/wav' }} />)
    expect(screen.getByRole('option', { name: 'New worktree from sotto/wav' })).toBeTruthy()
  })

  it('starts on the thread’s own model where its provider has it ready', () => {
    expect(forkModel(models, 'claude', 'native:claude:model:opus')).toBe('native:claude:model:opus')
    expect(forkModel(models, 'claude', 'native:claude:model:gone')).toBe('native:claude:model:sonnet')
  })
})

describe('a thread forked at a reply', () => {
  const counts: HandoverCounts = { total: 4, carried: 3, tooLong: 1, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: true }
  const forked: AgentThreadStart = { threadId: 'wav', from: 'turn', route: 'fork', at: AT, messageId: 'reply' }
  const handed: AgentThreadStart = { threadId: 'bench', from: 'turn', route: 'handover', at: AT, messageId: 'reply', handover: { thin: false, counts } }

  it('says where it was forked, under the last reply it copied', () => {
    const view = threadStartView({ id: 'fork', startedFrom: forked, providerId: 'claude' }, { title: 'WAV preview stall', providerId: 'claude' }, vi.fn(), undefined)!
    render(<ThreadStartNote view={view} />)
    expect(screen.getByRole('note').textContent).toBe('Forked from WAV preview stall at Claude Code’s reply above. What follows is this thread’s own. Files weren’t rewound. Open WAV preview stall')
  })

  it('shows the handover a fork without a copy of its own starts from, with what it left out', () => {
    const view = threadStartView({ id: 'fork', startedFrom: handed, providerId: 'grok' }, { title: 'Benchmark rerun', providerId: 'grok' }, vi.fn(), undefined)!
    render(<><ThreadStartNote view={view} /><StartHandoverCard view={view} createdAt={AT} /></>)
    expect(screen.queryByRole('note')).toBeNull()
    const card = screen.getByRole('article', { name: 'Handover this thread started from' })
    expect(card.textContent).toContain('Handover')
    expect(card.textContent).not.toContain('Handover, thin')
    expect(card.textContent).toContain('From Benchmark rerun, up to Grok Build’s reply. Context, not a new request. It goes with your first message.')
    expect(card.textContent).toContain('Carries 3 of 4 messages. Leaves out 1 message too long to carry.')
  })
})
