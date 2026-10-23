import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitActionButton } from '../../../src/renderer/src/agents/GitActionButton'
import { BringBackDismissals, bringBackDismissals, bringBackView, outcomeWords, readyWords } from '../../../src/renderer/src/agents/bringChangesBack.logic'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import type { AgentCommand, AgentState, AgentThread, AgentWorktree } from '../../../src/shared/agents'
import type { BringBack } from '../../../src/shared/bringChangesBack'
import type { GitStatus } from '../../../src/shared/gitStatus'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

// Bring changes to <branch> (#1030, pick B, in place): the strip above a delegated thread's composer and the same press in
// the Git action's menu. Each reads the records; the press is a command, and what it did comes back on the thread's record.

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
const owl = (on: boolean): void => {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { 'cross-machine-work': on } },
    actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
}
const ACTION = '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b'
const status = (branch: string, over: Partial<GitStatus> = {}): GitStatus => ({ isRepository: true, branch, upstream: null, hasRemote: false, defaultBranch: 'main', isDefaultBranch: branch === 'main',
  dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: 3, pullRequest: null, fetchedAt: null, readAt: '2026-10-17T00:00:00.000Z', ...over })
const parent: AgentThread = { id: 'parent', projectId: 'project', title: 'WAV preview stall', modelId: 'claude:opus', providerId: 'claude', status: 'idle', messages: [], requests: [], nativeSessionStarted: true,
  worktree: { mode: 'shared', status: 'ready', path: '/repo', branch: 'main', git: status('main') } } as AgentThread
const worktree = (over: Partial<AgentWorktree> = {}): AgentWorktree => ({ mode: 'independent', status: 'ready', path: '/worktrees/child', repositoryRoot: '/repo', branch: 'sotto/wav-mid-chunk',
  baseBranch: 'main', git: status('sotto/wav-mid-chunk'), ...over })
const child = (over: Partial<AgentThread> = {}): AgentThread => ({ id: 'child', projectId: 'project', title: 'WAV mid-chunk test', modelId: 'codex:model', providerId: 'codex', status: 'idle',
  messages: [], requests: [], nativeSessionStarted: true, delegatedBy: 'parent', worktree: worktree(), ...over }) as AgentThread
const record = (over: Partial<BringBack>): BringBack => ({ actionId: ACTION, status: 'done', target: 'main', branch: 'sotto/wav-mid-chunk', at: '2026-10-17T00:00:00.000Z', ...over })

function mount(current: AgentThread) {
  vi.stubGlobal('sotto', { agents: { gitChangedFiles: vi.fn(async () => ({ isRepository: true, files: [{ path: 'a.txt', status: 'modified', insertions: 1, deletions: 0 }], truncated: false })) } })
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => ({ error: null } as AgentState))
  const element = (thread: AgentThread) => <GitActionButton thread={thread} threads={[parent, thread]} command={command} noticeSlot={null} />
  const view = render(element(current))
  return { ...view, command, rerender: (next: AgentThread) => view.rerender(element(next)) }
}
const sent = (command: ReturnType<typeof vi.fn>): AgentCommand[] => command.mock.calls.map(([request]) => request as AgentCommand)
const strip = (): HTMLElement => screen.getByRole('region', { name: 'Bring changes back' })

beforeEach(() => owl(true))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(useOptionalApp).mockReset(); bringBackDismissals.clear() })

describe('the strip above a delegated thread’s composer', () => {
  it('names the parent’s branch and where it is checked out, and a press sends the command and nothing else', async () => {
    const { command } = mount(child())
    expect(strip()).toHaveTextContent('sotto/wav-mid-chunk was made from main. main is checked out in the project folder, where WAV preview stall works.')
    const bring = within(strip()).getByRole('button', { name: 'Bring changes to main' })
    fireEvent.click(bring)
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(sent(command)[0]).toEqual({ type: 'bring-changes-back', threadId: 'child', actionId: expect.any(String) })
  })

  it('shows nothing while the Owl list keeps it off, and nothing for a thread not made from its parent’s branch', () => {
    owl(false)
    const off = mount(child())
    expect(screen.queryByRole('region', { name: 'Bring changes back' })).toBeNull()
    off.unmount()
    owl(true)
    mount(child({ worktree: worktree({ baseBranch: 'release' }) }))
    expect(screen.queryByRole('region', { name: 'Bring changes back' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More Git actions' }))
    expect(within(screen.getByRole('menu', { name: 'More Git actions' })).queryByRole('menuitem', { name: /Bring changes/u })).toBeNull()
  })

  it('keeps the keyboard in the order the eye reads it: the press, then Hide', async () => {
    const user = userEvent.setup()
    mount(child())
    within(strip()).getByRole('button', { name: 'Bring changes to main' }).focus()
    await user.tab()
    expect(within(strip()).getByRole('button', { name: 'Hide until this branch changes' })).toHaveFocus()
  })

  it('says to commit first while the worktree has uncommitted changes, and Commit… opens the commit dialog', async () => {
    const { command } = mount(child({ worktree: worktree({ git: status('sotto/wav-mid-chunk', { dirty: true, changedFiles: 2 }) }) }))
    expect(strip()).toHaveTextContent('sotto/wav-mid-chunk has uncommitted changes in 2 files. Commit them first; Sotto won’t bring back uncommitted work.')
    const bring = within(strip()).getByRole('button', { name: 'Bring changes to main' })
    expect(bring).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(bring)
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(within(strip()).getByRole('button', { name: 'Commit…' }))
    expect(await screen.findByRole('dialog', { name: 'Commit changes' })).toBeInTheDocument()
  })

  it('hides until the branch changes', () => {
    const { rerender } = mount(child())
    fireEvent.click(within(strip()).getByRole('button', { name: 'Hide until this branch changes' }))
    expect(screen.queryByRole('region', { name: 'Bring changes back' })).toBeNull()
    rerender(child({ worktree: worktree({ git: status('sotto/wav-mid-chunk', { aheadOfDefault: 4 }) }) }))
    expect(strip()).toBeInTheDocument()
  })
})

describe('the merge-commit question, in the strip’s place', () => {
  it('takes the focus after this pane’s press, makes the merge commit on yes, and does nothing on Escape', async () => {
    const { command, rerender } = mount(child())
    fireEvent.click(within(strip()).getByRole('button', { name: 'Bring changes to main' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    const pressed = sent(command)[0] as Extract<AgentCommand, { type: 'bring-changes-back' }>
    rerender(child({ bringBack: record({ actionId: pressed.actionId, status: 'asks', commits: 3, targetCommits: 2, checkedOut: 'project' }) }))
    const question = screen.getByRole('group', { name: 'Make a merge commit on main?' })
    expect(question).toHaveTextContent('main has 2 commits that sotto/wav-mid-chunk doesn’t, so Git can’t fast-forward. Sotto can make a merge commit on main that brings in this branch’s 3 commits. Nothing is rebased or forced, and this worktree stays as it is.')
    const yes = within(question).getByRole('button', { name: 'Make merge commit' })
    await waitFor(() => expect(yes).toHaveFocus())
    fireEvent.click(yes)
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(sent(command)[1]).toEqual({ type: 'bring-changes-back', threadId: 'child', actionId: expect.any(String), mergeCommit: pressed.actionId })
  })

  it('answers Escape with Not now: nothing is sent, and the offer comes back with the focus on it', async () => {
    const { command } = mount(child({ bringBack: record({ actionId: '11111111-1111-4111-8111-111111111111', status: 'asks', commits: 1, targetCommits: 1 }) }))
    const question = screen.getByRole('group', { name: 'Make a merge commit on main?' })
    within(question).getByRole('button', { name: 'Make merge commit' }).focus()
    fireEvent.keyDown(question, { key: 'Escape' })
    await waitFor(() => expect(within(strip()).getByRole('button', { name: 'Bring changes to main' })).toHaveFocus())
    expect(command).not.toHaveBeenCalled()
  })
})

describe('the outcome, in the strip’s place', () => {
  it('says what Git did and opens the parent, and once dismissed keeps the offer away until the branch changes', async () => {
    const { command, rerender } = mount(child({ bringBack: record({ actionId: '22222222-2222-4222-8222-222222222222', how: 'fast-forward', commits: 3, head: 'a41c2e9d00', checkedOut: 'project' }) }))
    const outcome = screen.getByRole('status', { name: 'Brought 3 commits to main.' })
    expect(outcome).toHaveTextContent('Git fast-forwarded main to a41c2e9; nothing else changed. WAV preview stall works on main in the project folder and sees them now.')
    fireEvent.click(within(outcome).getByRole('button', { name: 'Open WAV preview stall' }))
    expect(sent(command)).toEqual([{ type: 'select-thread', threadId: 'parent' }])
    fireEvent.keyDown(outcome, { key: 'Escape' })
    expect(screen.queryByRole('status', { name: 'Brought 3 commits to main.' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Bring changes back' })).toBeNull()
    rerender(child({ bringBack: record({ actionId: '22222222-2222-4222-8222-222222222222', how: 'fast-forward', commits: 3, head: 'a41c2e9d00', checkedOut: 'project' }),
      worktree: worktree({ git: status('sotto/wav-mid-chunk', { aheadOfDefault: 1 }) }) }))
    expect(strip()).toBeInTheDocument()
  })

  it('gives a conflict in Git’s own words, as an alert', () => {
    mount(child({ bringBack: record({ actionId: '33333333-3333-4333-8333-333333333333', status: 'refused', refusal: 'conflict', gitSaid: 'CONFLICT (content): Merge conflict in src/main/audio/wavStream.ts' }) }))
    const alert = screen.getByRole('alert', { name: 'Nothing was brought to main, and main is unchanged.' })
    expect(alert).toHaveTextContent('Git found a conflict, and Sotto doesn’t resolve conflicts. Ask this thread to merge main into its branch and resolve it, then try again. Git said:')
    expect(alert.querySelector('pre')).toHaveTextContent('CONFLICT (content): Merge conflict in src/main/audio/wavStream.ts')
    // A refusal dismissed brings the offer straight back: nothing changed, so the press may be made again.
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(strip()).toBeInTheDocument()
  })

  it('names the folder it left alone when main has uncommitted work there', () => {
    const words = outcomeWords(record({ status: 'refused', refusal: 'target-uncommitted', files: 1, checkedOut: 'project' }), 'WAV preview stall')
    expect(words).toMatchObject({ tone: 'error', title: 'Nothing was brought to main.', openParent: true,
      body: 'main is checked out in the project folder, which has uncommitted changes in 1 file, so Sotto didn’t touch it. Commit or set them aside in WAV preview stall, then try again.' })
    expect(outcomeWords(record({ how: 'merge-commit', commits: 3, targetCommits: 2, head: '7c0e1d4aaa', subject: 'Merge branch \'sotto/wav-mid-chunk\' into main', checkedOut: 'project' }), 'WAV preview stall').title)
      .toBe('Brought 3 commits to main with a merge commit.')
    expect(outcomeWords(record({ how: 'nothing', commits: 0 }), 'WAV preview stall')).toMatchObject({ title: 'Nothing to bring back.', body: 'main already has every commit on sotto/wav-mid-chunk.' })
  })
})

describe('the same press in the Git action’s menu', () => {
  it('comes first in the menu, named for the parent’s branch, and sends the same command', async () => {
    const { command } = mount(child())
    fireEvent.click(screen.getByRole('button', { name: 'More Git actions' }))
    const menu = screen.getByRole('menu', { name: 'More Git actions' })
    const first = within(menu).getAllByRole('menuitem')[0]!
    expect(first).toHaveTextContent('Bring changes to main')
    await act(async () => { fireEvent.click(first) })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(sent(command)[0]).toMatchObject({ type: 'bring-changes-back', threadId: 'child' })
  })

  it('is disabled with the reason while the worktree has uncommitted changes', () => {
    mount(child({ worktree: worktree({ git: status('sotto/wav-mid-chunk', { dirty: true, changedFiles: 1 }) }) }))
    fireEvent.click(screen.getByRole('button', { name: 'More Git actions' }))
    const item = within(screen.getByRole('menu', { name: 'More Git actions' })).getAllByRole('menuitem')[0]!
    expect(item).toHaveTextContent('Bring changes to main. Commit the 1 file changed first.')
    expect(item).toBeDisabled()
  })
})

describe('what the strip shows, from the records', () => {
  it('lets a newer press’s record through after an older one was dismissed', () => {
    const dismissals = new BringBackDismissals()
    const old = child({ bringBack: record({ actionId: '44444444-4444-4444-8444-444444444444', how: 'nothing', commits: 0 }) })
    dismissals.dismiss('44444444-4444-4444-8444-444444444444')
    expect(bringBackView(old, [parent, old], dismissals)?.kind).toBe('ready')
    const fresh = child({ bringBack: record({ actionId: '55555555-5555-4555-8555-555555555555', status: 'asks', commits: 1, targetCommits: 1 }) })
    expect(bringBackView(fresh, [parent, fresh], dismissals)?.kind).toBe('asks')
    expect(bringBackDismissals).toBeInstanceOf(BringBackDismissals)
  })
})

describe('a child on another machine than the thread it began from', () => {
  const LAPTOP = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222'
  const MOVE = '9d1c3f0e-5b8e-4d4a-8a77-1f0d2f6c4b1a'
  const away = (over: Partial<AgentThread> = {}): AgentThread => child({ id: `host:${FORGE}:child`, delegatedBy: undefined,
    worktree: worktree({ baseBranch: 'feat/x', branch: 'feat/x-2', git: status('feat/x-2') }), ...over })
  const laptopParent = (over: Partial<AgentThread> = {}): AgentThread => ({ ...parent, id: `host:${LAPTOP}:parent`, worktree: { mode: 'shared', status: 'ready', path: '/repo', branch: 'feat/x', git: status('feat/x') }, ...over }) as AgentThread
  const madeFrom = (thread: AgentThread): AgentThread => ({ ...thread, worktree: { ...thread.worktree!, baseBranch: undefined, incomingRef: `refs/sotto/incoming/${MOVE}/feat/x`, madeFrom: { thread: 'parent', host: LAPTOP } } }) as AgentThread

  it('names the machine the branch is checked out on', () => {
    const found = { parentId: `host:${LAPTOP}:parent`, target: 'feat/x', branch: 'feat/x-2', where: 'project' as const, away: true }
    expect(readyWords(found, 'WAV preview stall', 'forge').rest).toBe('feat/x is checked out in the project folder on forge, where WAV preview stall works.')
  })

  it('reads the outcome from the thread its commits went to, only when it names this child', () => {
    const thread = madeFrom(away())
    const done = record({ target: 'feat/x', branch: 'feat/x-2', how: 'fast-forward', commits: 2, head: 'a41c2e9', checkedOut: 'project', from: thread.id })
    expect(bringBackView(thread, [laptopParent({ broughtBack: done }), thread], new BringBackDismissals())).toMatchObject({ kind: 'outcome', record: done })
    const other = { ...done, from: `host:${FORGE}:another-child` }
    expect(bringBackView(thread, [laptopParent({ broughtBack: other }), thread], new BringBackDismissals())?.kind).toBe('ready')
    expect(outcomeWords(done, 'WAV preview stall', 'This computer').body).toBe('Git fast-forwarded feat/x to a41c2e9; nothing else changed. WAV preview stall works on feat/x in the project folder on This computer and sees them now.')
  })

  it('says why a test run’s snapshot is never brought back, and when the parent left its branch', () => {
    expect(outcomeWords(record({ status: 'refused', refusal: 'snapshot', target: 'feat/x', branch: 'feat/x-2' }), 'WAV preview stall').body)
      .toBe('feat/x-2 starts from a test run’s snapshot of uncommitted changes, and Sotto won’t bring that back as a commit. Ask this thread to put its own commits on a branch made from feat/x, then try again.')
    expect(outcomeWords(record({ status: 'refused', refusal: 'parent-moved', target: 'feat/x', branch: 'feat/x-2' }), 'WAV preview stall'))
      .toMatchObject({ title: 'Nothing was brought to feat/x.', body: 'WAV preview stall isn’t on feat/x any more, and Sotto doesn’t switch branches. Switch it back to feat/x there, then try again.', openParent: true })
  })
})
