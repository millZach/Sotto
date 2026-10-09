// @vitest-environment node
import * as worktrees from '../../../src/main/agents/threadWorktrees'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { workspaceFixture } from '../../fixtures/workspaceFixture'
import { runWorktreeGit as git } from '../../../src/main/agents/threadWorktrees'
import { GitActions } from '../../../src/main/agents/gitActions'
import { WorktreeCleanup } from '../../../src/main/agents/worktreeCleanup'
import { DEFAULT_WORKTREE_CLEANUP } from '../../../src/shared/settings'
import { GitStatusReader } from '../../../src/main/agents/gitStatus'
import { CheckoutMutations } from '../../../src/main/agents/checkoutMutations'
import type { AgentThread } from '../../../src/shared/agents'

it.each([
  ['waiting-answer', 'Thread "b" is waiting for your answer. Answer it, then try again.'],
  ['history-error', 'Thread "b" could not load its history. Open it to retry, or archive it, then try again.'],
  ['history-loading', 'Thread "b" is loading its history. Try again in a moment.'],
  ['failed-followups', 'Thread "b" has queued follow-ups that did not send. Resume or remove them, then try again.'],
  ['paused-followups', 'Thread "b" has paused follow-ups. Resume or remove them, then try again.'],
  ['paused-assignment', 'Thread "b" has paused management and queued work. Stop managing it and review its queue, or archive it, then try again.'],
  ['managed-assignment', 'Thread "b" is managed by Sotto. Stop managing it, or archive it, then try again.'],
  ['uncertain-send', 'Thread "b" has a message whose delivery is unconfirmed. Open it and refresh to check whether it was sent, then try again.'],
] as const)('names the sibling reason %s and how to release it', async (reason, copy) => {
  const f = await fixture()
  try {
    await f.host.execute(send('b'))
    const sibling = f.adapters.codex.state.threads.at(-1)!
    sibling.status = 'idle'
    if (reason === 'history-error') sibling.historyStatus = 'error'
    else if (reason === 'history-loading') sibling.historyStatus = 'loading'
    else if (reason === 'waiting-answer') sibling.requests = [{ id: 'answer', kind: 'question', text: 'Choose', options: [] } satisfies AgentThread['requests'][number]]
    else f.host.setPendingThreadWork(id => id === 'b', () => reason)
    f.adapters.codex.emit()
    await expect(f.host.pullThreadBranch('a')).rejects.toThrow(copy)
    expect(await f.host.isCheckoutMutating('a')).toBe(false)
  } finally { await f.stop(); await f.remove() }
})

async function fixture() {
  const f = await workspaceFixture()
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(item => item.providerId === 'codex')!
  const model = snapshot.models.find(item => item.providerId === 'codex')!
  await git(project.path, ['init', '-b', 'main'])
  await writeFile(join(project.path, 'file.txt'), 'baseline')
  await git(project.path, ['add', '.'])
  await git(project.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
  for (const id of ['a', 'b']) await f.host.execute({ type: 'create-thread', commandId: id, threadId: id, projectId: project.id, modelId: model.id, title: id })
  return { ...f, project }
}
function barrier() {
  let release!: () => void, enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { held, entered, release, enter }
}
const send = (id: string) => ({ type: 'send' as const, threadId: id, commandId: `send-${id}`, messageId: `message-${id}`, text: 'Work' })

it('refuses terminal reclamation while an idle thread still references the checkout', async () => {
  const f = await fixture()
  try {
    await expect(f.host.acquireWorktreeReclaim(f.project.path)).rejects.toThrow('A thread works in this folder too, so it stays.')
    expect(await f.host.isCheckoutMutating('a')).toBe(false)
  } finally { await f.stop(); await f.remove() }
})

it('names a shell startup reservation and refuses another startup during removal', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  try {
    release = await f.host.acquireTerminalStart(f.project.path)
    await expect(f.host.acquireCheckoutMutation('a')).rejects.toThrow('Sotto is starting a terminal in this folder. Try again in a moment.')
    release(); release = undefined
    release = await f.host.acquireCheckoutMutation('a', { kind: 'remove-folder' })
    await expect(f.host.acquireTerminalStart(f.project.path)).rejects.toThrow('Sotto is removing this folder')
  } finally { release?.(); await f.stop(); await f.remove() }
})

it('refuses working-copy selection throughout terminal checkout removal', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  try {
    const terminalWorktrees = new worktrees.ThreadWorktrees(f.root, git, worktrees.TERMINAL_WORKTREE_HOME)
    const owned = await terminalWorktrees.ensure(await terminalWorktrees.allocate(f.project.path, 'independent'))
    release = await f.host.acquireWorktreeReclaim(owned.path!)
    const before = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'a')!.worktree
    await expect(f.host.configureThreadWorkingCopy('a', { workingCopy: 'independent', existingWorktreePath: owned.path! })).rejects.toThrow('Sotto is removing this folder')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'a')!.worktree).toEqual(before)
    release(); release = undefined
    await f.host.configureThreadWorkingCopy('a', { workingCopy: 'independent', existingWorktreePath: owned.path! })
    await expect(f.host.execute(send('a'))).resolves.toMatchObject({ accepted: true })
  } finally { release?.(); await f.stop(); await f.remove() }
})

it.each(['existing', 'shared'] as const)('refuses thread creation in a terminal checkout reserved for removal (%s)', async selection => {
  const f = await fixture()
  let release: (() => void) | undefined
  try {
    const terminalWorktrees = new worktrees.ThreadWorktrees(f.root, git, worktrees.TERMINAL_WORKTREE_HOME)
    const owned = await terminalWorktrees.ensure(await terminalWorktrees.allocate(f.project.path, 'independent'))
    // Use the working-copy selector's project record for a shared selection into the reserved checkout.
    const model = f.host.workspaceSnapshot().models.find(item => item.providerId === 'codex')!
    if (selection === 'shared') await f.host.execute({ type: 'create-project', commandId: 'terminal-project', projectId: 'terminal-project', provider: 'codex', title: 'Terminal project', path: owned.path! })
    const projectId = selection === 'shared' ? f.host.workspaceSnapshot().projects.find(project => project.path === owned.path)!.id : f.project.id
    release = await f.host.acquireWorktreeReclaim(owned.path!)
    const create = () => f.host.execute({ type: 'create-thread', commandId: 'draft', threadId: 'draft', projectId, modelId: model.id, title: 'Draft',
      ...(selection === 'shared' ? { workingCopy: 'shared' as const } : { workingCopy: 'independent' as const, existingWorktreePath: owned.path! }) })
    await expect(create()).rejects.toThrow('Sotto is removing this folder')
    expect(f.host.workspaceSnapshot().threads.some(thread => thread.id === 'draft')).toBe(false)
    release(); release = undefined
    await expect(create()).resolves.toMatchObject({ accepted: true })
  } finally { release?.(); await f.stop(); await f.remove() }
})

it('names a post-turn checkpoint read when a sibling tries to change Git', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  try {
    release = await f.host.acquireCheckoutRead('b')
    await expect(f.host.pullThreadBranch('a')).rejects.toThrow('Sotto is saving a checkpoint in this folder. Try again in a moment.')
    release(); release = undefined
    const mutation = await f.host.acquireCheckoutMutation('a'); mutation()
  } finally { release?.(); await f.stop(); await f.remove() }
})

it.each(['checkpoint read', 'desktop guard'] as const)('keeps the last Git result and PR link when a new press is refused by a %s', async reason => {
  const f = await fixture()
  let release: (() => void) | undefined
  try {
    const runStackedAction = vi.fn(async () => ({ action: 'create_pr', branch: { status: 'skipped_not_requested' }, commit: { status: 'skipped_not_requested' }, push: { status: 'skipped_not_requested' },
      pr: { status: 'created', url: 'https://github.com/o/r/pull/9', number: 9, title: 'Keep this result' }, toast: { title: 'Created PR #9', cta: { kind: 'open_pr', label: 'View PR', url: 'https://github.com/o/r/pull/9' } } }))
    f.host.setGitActions({ runStackedAction } as unknown as GitActions)
    await f.host.runGitAction({ threadId: 'a', actionId: 'previous', action: 'create_pr' })
    const previous = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'a')!.gitAction
    if (reason === 'checkpoint read') release = await f.host.acquireCheckoutRead('b')
    else f.host.setMutationGuard(() => false)
    await expect(f.host.runGitAction({ threadId: 'a', actionId: 'refused', action: 'commit' })).rejects.toThrow(reason === 'checkpoint read' ? 'Sotto is saving a checkpoint' : 'Wait for active or pending thread work')
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'a')?.gitAction).toEqual(previous)
    expect(previous?.result?.pr.url).toBe('https://github.com/o/r/pull/9')
    expect(runStackedAction).toHaveBeenCalledTimes(1)
    expect(await f.host.isCheckoutMutating('a')).toBe(false)
  } finally { release?.(); await f.stop(); await f.remove() }
})

it('auto-settles a checked merged tip despite the thread history error', async () => {
  const f = await fixture()
  try {
    await f.host.execute(send('a'))
    const native = f.adapters.codex.state.threads.at(-1)!
    native.status = 'idle'; native.historyStatus = 'error'; f.adapters.codex.emit()
    const tip = (await git(f.project.path, ['rev-parse', 'HEAD'])).trim()
    const after = await f.host.setWorkspaceSettled('thread', 'a', true, { expectedMergedTip: tip, expectedMergedBranch: 'main' })
    expect(after.threads.find(thread => thread.id === 'a')?.workspaceSettledAt).toBeTruthy()
    expect(after.threads.find(thread => thread.id === 'a')?.historyStatus).toBe('error')
    expect((await git(f.project.path, ['rev-parse', 'HEAD'])).trim()).toBe(tip)
    expect(await readFile(join(f.project.path, 'file.txt'), 'utf8')).toBe('baseline')
  } finally { await f.stop(); await f.remove() }
})

it('holds a checkout throughout a Git action and refuses a sibling send and branch restore without desktop checkpoint wiring', async () => {
  const f = await fixture(), pause = barrier()
  let action: Promise<unknown> | undefined
  try {
    f.host.setGitActions({ runStackedAction: async () => { pause.enter(); await pause.held; throw new Error('Draft failed') } } as unknown as GitActions)
    action = f.host.runGitAction({ threadId: 'a', actionId: 'commit', action: 'commit' })
    await pause.entered
    await expect(f.host.execute(send('b'))).rejects.toThrow('A Git action is running in this folder. Your message was not sent. Send it again when the action finishes.')
    await expect(f.host.restoreThreadBranch('b', true)).rejects.toThrow(/Wait for/)
    expect(f.adapters.codex.commands.some(command => command.type === 'send')).toBe(false)
    pause.release(); await action
    await expect(f.host.execute(send('b'))).resolves.toMatchObject({ accepted: true })
  } finally { pause.release(); await action; await f.stop(); await f.remove() }
})

it('refuses branch restore while a sibling turn is working', async () => {
  const f = await fixture()
  try {
    await f.host.execute(send('b'))
    f.adapters.codex.state.threads.at(-1)!.status = 'idle'; f.adapters.codex.emit()
    await f.host.execute(send('a'))
    await git(f.project.path, ['switch', '-c', 'feature'])
    await expect(f.host.restoreThreadBranch('b', true)).rejects.toThrow(/Wait for/)
    expect((await git(f.project.path, ['branch', '--show-current'])).trim()).toBe('feature')
  } finally { await f.stop(); await f.remove() }
})

it('reserves a checkout before a sibling send can pass an asynchronous guard', async () => {
  const f = await fixture(), pause = barrier()
  let action: Promise<unknown> | undefined
  try {
    f.host.setMutationGuard(async () => { pause.enter(); await pause.held; return true })
    f.host.setGitActions({ pull: vi.fn(async () => ({ status: 'already_up_to_date' })) } as unknown as GitActions)
    action = f.host.pullThreadBranch('a')
    await pause.entered
    await expect(f.host.execute(send('b'))).rejects.toThrow('Your message was not sent')
    pause.release(); await action
  } finally { pause.release(); await action; await f.stop(); await f.remove() }
})

it('uses the checkout root for subdirectories and releases reservations on refusal', async () => {
  const f = await fixture(), mutations = new CheckoutMutations()
  try {
    const nested = join(f.project.path, 'nested'); await mkdir(nested)
    const release = await mutations.acquire(nested, 'mutation')
    await expect(mutations.acquire(f.project.path, 'send')).rejects.toThrow('Your message was not sent')
    const other = await mutations.acquire(join(f.root, 'claude'), 'mutation'); other()
    release()
    const sendRelease = await mutations.acquire(f.project.path, 'send'); sendRelease()
    f.host.setPendingThreadWork(id => id === 'b')
    await expect(f.host.pullThreadBranch('a')).rejects.toThrow('Open it to review that work')
    expect(await f.host.isCheckoutMutating('a')).toBe(false)
  } finally { await f.stop(); await f.remove() }
})

it('refuses Git while a sibling first send is pending in a previous worktree', async () => {
  const f = await fixture()
  try {
    const model = f.host.workspaceSnapshot().models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'c', threadId: 'c', projectId: f.project.id, modelId: model.id, title: 'c', workingCopy: 'independent' })
    await f.host.execute(send('c'))
    for (const thread of f.adapters.codex.state.threads) thread.status = 'idle'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')?.status).toBe('idle'))
    const copy = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')!.worktree!
    await f.host.execute({ type: 'create-thread', commandId: 'd', threadId: 'd', projectId: f.project.id, modelId: model.id, title: 'd', workingCopy: 'independent', existingWorktreePath: copy.path! })
    const pull = vi.fn(async () => ({ status: 'already_up_to_date' }))
    f.host.setGitActions({ pull } as unknown as GitActions)
    f.host.setPendingThreadWork(id => id === 'd')
    await expect(f.host.pullThreadBranch('c')).rejects.toThrow('Open it to review that work')
    expect(pull).not.toHaveBeenCalled()
    expect(await f.host.isCheckoutMutating('c')).toBe(false)
    f.host.setPendingThreadWork(() => false)
    const release = await f.host.acquireCheckoutMutation('c')
    try {
      await expect(f.host.execute(send('d'))).rejects.toThrow('Your message was not sent')
      expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'd')?.worktree?.path).toBeUndefined()
    } finally { release() }
  } finally { await f.stop(); await f.remove() }
})

it('refuses Git while a sibling send is still awaiting provider acknowledgement', async () => {
  const f = await fixture(), pause = barrier()
  let sending: Promise<unknown> | undefined
  try {
    const original = f.adapters.codex.execute.bind(f.adapters.codex)
    vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type === 'send') { pause.enter(); await pause.held }
      return original(command)
    })
    sending = f.host.execute(send('b'))
    await pause.entered
    await expect(f.host.pullThreadBranch('a')).rejects.toThrow('Wait for')
    pause.release(); await sending
  } finally { pause.release(); await sending; await f.stop(); await f.remove() }
})

it('restores a deleted owned worktree for a project subdirectory and holds its root during send', async () => {
  const f = await fixture(), pause = barrier()
  let sending: Promise<unknown> | undefined
  try {
    const nested = join(f.project.path, 'nested'); await mkdir(nested)
    await writeFile(join(nested, 'app.txt'), 'committed project')
    await git(f.project.path, ['add', '.'])
    await git(f.project.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Nested project'])
    await f.host.execute({ type: 'create-project', provider: 'codex', commandId: 'subproject', projectId: 'subproject', title: 'Nested', path: nested })
    const snapshot = f.host.workspaceSnapshot()
    const model = snapshot.models.find(item => item.providerId === 'codex')!
    const project = snapshot.projects.find(item => item.path === nested)!
    await f.host.execute({ type: 'create-thread', commandId: 'c', threadId: 'c', projectId: project.id, modelId: model.id, title: 'c', workingCopy: 'independent' })
    await f.host.execute(send('c'))
    for (const thread of f.adapters.codex.state.threads) thread.status = 'idle'
    f.adapters.codex.emit()
    const copy = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')!.worktree!
    await f.host.execute({ type: 'create-thread', commandId: 'd', threadId: 'd', projectId: f.project.id, modelId: model.id, title: 'd', workingCopy: 'independent', existingWorktreePath: copy.path! })
    await f.host.execute(send('d'))
    for (const thread of f.adapters.codex.state.threads) thread.status = 'idle'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.filter(thread => ['c', 'd'].includes(thread.id)).every(thread => thread.status === 'idle')).toBe(true))
    if (!copy.path?.startsWith(f.root)) throw new Error('Unexpected owned fixture path')
    await rm(copy.path, { recursive: true })
    const original = f.adapters.codex.execute.bind(f.adapters.codex)
    vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type === 'send') { pause.enter(); await pause.held }
      return original(command)
    })
    sending = f.host.execute({ ...send('c'), commandId: 'send-c-again', messageId: 'message-c-again' })
    await pause.entered
    await expect(f.host.pullThreadBranch('d')).rejects.toThrow('Wait for')
    pause.release(); await sending
    expect((await git(copy.path, ['branch', '--show-current'])).trim()).toBe(copy.branch)
  } finally { pause.release(); await sending; await f.stop(); await f.remove() }
})


it.each(['reclaim', 'settle'] as const)('rechecks a merged commit inside the lane before %s after a queued commit action', async kind => {
  const f = await fixture(), pause = barrier(), queued = barrier()
  let action: Promise<unknown> | undefined, sweep: Promise<void> | undefined
  try {
    const model = f.host.workspaceSnapshot().models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'c', threadId: 'c', projectId: f.project.id, modelId: model.id, title: 'c', workingCopy: 'independent' })
    await f.host.execute(send('c'))
    for (const thread of f.adapters.codex.state.threads) thread.status = 'idle'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')?.status).toBe('idle'))
    const copy = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')!.worktree!
    const tip = (await git(copy.path!, ['rev-parse', 'HEAD'])).trim()
    await git(f.project.path, ['config', 'user.name', 'Fixture'])
    await git(f.project.path, ['config', 'user.email', 'fixture@example.invalid'])
    await git(f.project.path, ['config', 'commit.gpgSign', 'false'])
    await writeFile(join(copy.path!, 'file.txt'), 'new unmerged work')
    f.host.setGitActions(new GitActions({ status: new GitStatusReader({ fetchIntervalMs: () => 0 }),
      writeCommitMessage: async () => { pause.enter(); await pause.held; return 'Keep new unmerged work' }, writePullRequestText: async () => null }))
    action = f.host.runGitAction({ threadId: 'c', actionId: 'commit', action: 'commit' })
    await pause.entered
    const host = { workspaceSnapshot: () => f.host.workspaceSnapshot(), subscribe: f.host.subscribe.bind(f.host),
      reclaimThreadWorktree: (...args: Parameters<typeof f.host.reclaimThreadWorktree>) => { queued.enter(); return f.host.reclaimThreadWorktree(...args) },
      setWorkspaceSettled: (...args: Parameters<typeof f.host.setWorkspaceSettled>) => { queued.enter(); return f.host.setWorkspaceSettled(...args) } }
    sweep = new WorktreeCleanup({ host, rules: () => ({ ...DEFAULT_WORKTREE_CLEANUP, merged: kind === 'reclaim' }),
      autoSettleMerged: () => kind === 'settle', pullRequestMerged: async () => true }).sweep()
    await queued.entered
    pause.release(); await action; await sweep
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')?.gitAction?.status).toBe('done')
    expect((await git(f.project.path, ['rev-parse', `refs/heads/${copy.branch}`])).trim()).not.toBe(tip)
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')?.worktree?.reclaimedAt).toBeUndefined()
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')?.workspaceSettledAt ?? null).toBeNull()
    expect((await stat(copy.path!)).isDirectory()).toBe(true)
  } finally { pause.release(); await action; await sweep; await f.stop(); await f.remove() }
}, 60_000)

it.each([false, true])('removes an owned folder with failed history and a retained follow-up (automatic: %s)', async automatic => {
  const f = await fixture()
  try {
    const model = f.host.workspaceSnapshot().models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'c', threadId: 'c', projectId: f.project.id, modelId: model.id, title: 'c', workingCopy: 'independent' })
    await f.host.execute(send('c'))
    const native = f.adapters.codex.state.threads.at(-1)!
    native.status = 'idle'; native.historyStatus = 'error'; f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')?.historyStatus).toBe('error'))
    f.host.setPendingThreadWork(id => id === 'c')
    const copy = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'c')!.worktree!
    const after = await f.host.reclaimThreadWorktree('c', { automatic })
    expect(after.threads.find(thread => thread.id === 'c')?.worktree?.reclaimedAt).toBeDefined()
    await expect(stat(copy.path!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await git(f.project.path, ['rev-parse', `refs/heads/${copy.branch}`])).trim()).not.toBe('')
  } finally { await f.stop(); await f.remove() }
})

it('allows a sibling send while auto-settle reads the merged branch tip', async () => {
  const f = await fixture(), pause = barrier()
  let settling: Promise<unknown> | undefined
  try {
    await git(f.project.path, ['switch', '-c', 'feature'])
    await f.host.execute(send('a')); await f.host.execute(send('b'))
    for (const thread of f.adapters.codex.state.threads) thread.status = 'idle'
    f.adapters.codex.emit()
    await vi.waitFor(() => expect(f.host.workspaceSnapshot().threads.filter(t => ['a', 'b'].includes(t.id)).every(t => t.status === 'idle')).toBe(true))
    const tip = (await git(f.project.path, ['rev-parse', 'HEAD'])).trim()
    const original = worktrees.runWorktreeGit
    vi.spyOn(worktrees, 'runWorktreeGit').mockImplementation(async (cwd, args) => {
      if (args.includes('refs/heads/feature^{commit}')) { pause.enter(); await pause.held }
      return original(cwd, args)
    })
    settling = f.host.setWorkspaceSettled('thread', 'a', true, { expectedMergedTip: tip, expectedMergedBranch: 'feature' })
    await pause.entered
    await expect(f.host.execute({ ...send('b'), commandId: 'send-b-again', messageId: 'message-b-again' })).resolves.toMatchObject({ accepted: true })
    pause.release(); await settling
    expect(f.host.workspaceSnapshot().threads.find(t => t.id === 'a')?.workspaceSettledAt).toBeTruthy()
  } finally { pause.release(); await settling; vi.restoreAllMocks(); await f.stop(); await f.remove() }
})

it.each(['Git action', 'checkpoint recovery'] as const)('keeps a draft on its original worktree choice when local PR checkout is refused by %s', async holder => {
  const f = await fixture(), pause = barrier()
  let action: Promise<unknown> | undefined
  try {
    const model = f.host.workspaceSnapshot().models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'draft', threadId: 'draft', projectId: f.project.id, modelId: model.id, title: 'Draft', workingCopy: 'independent', baseBranch: 'main' })
    const before = f.host.workspaceSnapshot().threads.find(t => t.id === 'draft')!
    const checkoutLocal = vi.fn()
    f.host.setGitPullRequests({ view: async () => ({ url: 'https://github.com/o/r/pull/1', number: 1 }), checkoutLocal } as never)
    f.host.setGitActions({ runStackedAction: async () => { pause.enter(); await pause.held; throw new Error('Draft failed') } } as unknown as GitActions)
    if (holder === 'Git action') {
      action = f.host.runGitAction({ threadId: 'a', actionId: 'commit', action: 'commit' })
      await pause.entered
    } else f.host.setMutationGuard(() => false)
    await expect(f.host.checkoutThreadPullRequest('draft', '#1', 'local')).rejects.toThrow(holder === 'Git action' ? 'A Git action is running' : 'Wait for active or pending thread work')
    const after = f.host.workspaceSnapshot().threads.find(t => t.id === 'draft')!
    expect(after.worktree).toEqual(before.worktree)
    expect(after.workingDirectory).toEqual(before.workingDirectory)
    expect(checkoutLocal).not.toHaveBeenCalled()
    const saved = JSON.parse(await readFile(join(f.root, 'workspace.json'), 'utf8'))
    expect(saved.snapshot.threads.find((t: { id: string }) => t.id === 'draft')?.worktree).toMatchObject({ mode: 'independent', status: 'pending', baseBranch: 'main' })
    pause.release(); await action
  } finally { pause.release(); await action; await f.stop(); await f.remove() }
})


it('never saves a destination binding while local PR eligibility is still being checked', async () => {
  const f = await fixture(), pause = barrier()
  let checking: Promise<unknown> | undefined
  try {
    const model = f.host.workspaceSnapshot().models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'draft', threadId: 'draft', projectId: f.project.id, modelId: model.id, title: 'Draft', workingCopy: 'independent', baseBranch: 'main' })
    const before = f.host.workspaceSnapshot().threads.find(t => t.id === 'draft')!
    const checkoutLocal = vi.fn()
    f.host.setGitPullRequests({ view: async () => ({ url: 'https://github.com/o/r/pull/1', number: 1 }), checkoutLocal } as never)
    f.host.setMutationGuard(async () => { pause.enter(); await pause.held; return false })
    checking = f.host.checkoutThreadPullRequest('draft', '#1', 'local')
    const refused = expect(checking).rejects.toThrow('Wait for active or pending thread work')
    await pause.entered
    await f.host.renameThread('b', 'Unrelated rename')
    const saved = JSON.parse(await readFile(join(f.root, 'workspace.json'), 'utf8'))
    expect(saved.snapshot.threads.find((t: { id: string }) => t.id === 'draft')?.worktree).toEqual(before.worktree)
    expect(f.host.workspaceSnapshot().threads.find(t => t.id === 'draft')?.worktree).toEqual(before.worktree)
    pause.release(); await refused
    expect(checkoutLocal).not.toHaveBeenCalled()
  } finally { pause.release(); await checking?.catch(() => undefined); await f.stop(); await f.remove() }
})


it('refuses local PR checkout when an independent draft queues its first send on a headless host', async () => {
  const f = await fixture(), pause = barrier()
  let checkout: Promise<unknown> | undefined, sending: Promise<unknown> | undefined, pending = false
  try {
    const model = f.host.workspaceSnapshot().models.find(item => item.providerId === 'codex')!
    await f.host.execute({ type: 'create-thread', commandId: 'draft', threadId: 'draft', projectId: f.project.id, modelId: model.id, title: 'Draft', workingCopy: 'independent', baseBranch: 'main' })
    const checkoutLocal = vi.fn()
    f.host.setGitPullRequests({ view: async () => { pause.enter(); await pause.held; return { url: 'https://github.com/o/r/pull/1', number: 1, title: 'Fixture PR', state: 'open', draft: false } }, checkoutLocal } as never)
    // The headless coordinator supplies pending work without desktop checkpoint wiring.
    f.host.setPendingThreadWork(id => id === 'draft' && pending)
    checkout = f.host.checkoutThreadPullRequest('draft', '#1', 'local')
    const outcome = checkout.then(() => null, error => error as Error)
    await pause.entered
    pending = true
    sending = f.host.execute(send('draft')).finally(() => { pending = false })
    expect(f.host.workspaceSnapshot().threads.find(t => t.id === 'draft')?.worktree).toMatchObject({ mode: 'independent', status: 'pending', baseBranch: 'main' })
    pause.release(); const error = await outcome
    expect(checkoutLocal).not.toHaveBeenCalled()
    expect(error?.message).toContain('Thread "Draft" has pending work in this folder.')
    await sending
    const after = f.host.workspaceSnapshot().threads.find(t => t.id === 'draft')!
    expect(after.worktree).toMatchObject({ mode: 'independent', baseBranch: 'main', status: 'ready' })
    expect(after.worktree?.path).not.toBe(f.project.path)
  } finally { pause.release(); await checkout?.catch(() => undefined); await sending?.catch(() => undefined); await f.stop(); await f.remove() }
})
