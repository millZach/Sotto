// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GitActions } from '../../src/main/agents/gitActions'
import { CheckoutHeldRefusal } from '../../src/main/agents/checkoutMutations'
import type { AgentThread } from '../../src/shared/agents'
import { GitStatusReader } from '../../src/main/agents/gitStatus'
import { BRING_BACK_NO_TARGET, BRING_BACK_OFF, BRING_BACK_QUESTION_GONE, bringBackTarget } from '../../src/shared/bringChangesBack'
import { initializeGitRepository, runFixtureGit } from '../fixtures/gitRepository'
import { fixture } from '../fixtures/workspaceTestFixture'

/**
 * Bring changes to <branch> (#1030) through the host, over real Git in a temporary folder: a parent thread on the shared
 * project folder on `main`, and a thread it delegated, in a new worktree made from `main`. What Git does in each case
 * is `bringChangesBackGit.test.ts`; this is what the host offers, records and asks.
 */
const git = (cwd: string, ...args: string[]): string => runFixtureGit(cwd, ...args).trim()
const commitFile = async (cwd: string, file: string, text: string, message: string): Promise<string> => {
  await writeFile(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

async function family(options: { allow?: boolean; childBase?: string; childWorkingCopy?: 'independent' | 'shared' } = {}) {
  const f = await fixture()
  const project = f.adapters.codex.state.projects[0]!.path
  await initializeGitRepository(project, { files: { 'work.txt': 'one\ntwo\nthree\n' }, message: 'Baseline' })
  if (options.childBase && options.childBase !== 'main') git(project, 'branch', options.childBase)
  const status = new GitStatusReader({ fetchIntervalMs: () => 0 })
  f.host.setGitStatus(status, { pollIntervalMs: () => 0 })
  f.host.setGitActions(new GitActions({ status, writeCommitMessage: async () => null, writePullRequestText: async () => null }))
  if (options.allow !== false) f.host.allowBringBack()
  const snapshot = await f.host.connect()
  const projectId = snapshot.projects.find(item => item.providerId === 'codex')!.id
  const modelId = snapshot.models.find(item => item.providerId === 'codex')!.id
  await f.host.execute({ type: 'create-thread', commandId: 'create-parent', threadId: 'parent', projectId, title: 'WAV preview stall', modelId, workingCopy: 'shared' })
  await f.host.execute({ type: 'send', commandId: 'send-parent', threadId: 'parent', messageId: 'message-parent', text: 'Look into the stall' })
  await f.host.execute({ type: 'create-thread', commandId: 'create-child', threadId: 'child', projectId, title: 'WAV mid-chunk test', modelId,
    workingCopy: options.childWorkingCopy ?? 'independent', ...(options.childWorkingCopy === 'shared' ? {} : { baseBranch: options.childBase ?? 'main' }) })
  await f.host.setDelegatedBy('child', 'parent')
  await f.host.execute({ type: 'send', commandId: 'send-child', threadId: 'child', messageId: 'message-child', text: 'Add a test' })
  for (const session of f.adapters.codex.state.threads) session.status = 'idle'
  f.adapters.codex.emit()
  const thread = (id: string) => f.host.workspaceSnapshot().threads.find(item => item.id === id)!
  await vi.waitFor(() => expect(['parent', 'child'].every(id => thread(id).status === 'idle' && thread(id).worktree?.status === 'ready')).toBe(true))
  const childFolder = thread('child').workingDirectory ?? thread('child').worktree!.path!
  const press = (mergeCommit?: string) => f.host.bringChangesBack({ threadId: 'child', actionId: randomUUID(), ...(mergeCommit ? { mergeCommit } : {}) })
  return { f, project, childFolder, thread, press, record: () => thread('child').bringBack, main: () => git(project, 'rev-parse', 'main') }
}

/**
 * A child on another machine (#1030): its branch, `feat/away` in a clone of the project elsewhere, arrives in this
 * project's incoming ref for a move, as the desktop's branch move leaves it, and the desktop then asks this host to bring
 * it to the parent's branch.
 */
async function arrival(project: string, root: string) {
  const elsewhere = join(root, 'elsewhere')
  git(root, 'clone', '-q', project, elsewhere)
  git(elsewhere, 'config', 'user.name', 'Sotto test'); git(elsewhere, 'config', 'user.email', 'test@example.invalid')
  git(elsewhere, 'switch', '-q', '-c', 'feat/away')
  const from = 'host:22222222-2222-4222-8222-222222222222:child-on-forge'
  const land = (): { moveId: string; ref: string } => {
    const moveId = randomUUID(), ref = `refs/sotto/incoming/${moveId}/feat/away`
    git(project, 'fetch', '-q', elsewhere, `feat/away:${ref}`)
    return { moveId, ref }
  }
  return { elsewhere, from, land }
}

describe('bringing a thread’s commits back to the branch of the thread it began from', () => {
  it('offers main to a delegated thread made from it, and fast-forwards main in the shared project folder on the press', async () => {
    const { project, childFolder, press, record, thread, main } = await family()
    expect(bringBackTarget(thread('child'), [thread('parent'), thread('child')])).toMatchObject({ parentId: 'parent', target: 'main', where: 'project' })
    const head = await commitFile(childFolder, 'test.txt', 'mid-chunk\n', 'Test a stream that ends mid-chunk')
    await press()
    expect(main()).toBe(head)
    expect(await readFile(join(project, 'test.txt'), 'utf8')).toBe('mid-chunk\n')
    expect(record()).toMatchObject({ status: 'done', how: 'fast-forward', target: 'main', commits: 1, head, checkedOut: 'project' })
    // The thread it began from reads its folder again, so its own status shows the commit.
    await vi.waitFor(() => expect(thread('parent').worktree?.git?.branch).toBe('main'))
  })

  it('holds the merge-commit question, refuses a yes to any other, and merges on the yes to it', async () => {
    const { project, childFolder, press, record, main } = await family()
    const ours = await commitFile(childFolder, 'test.txt', 'mid-chunk\n', 'Test a stream that ends mid-chunk')
    const theirs = await commitFile(project, 'notes.txt', 'meanwhile\n', 'Note what happened meanwhile')
    await press()
    const question = record()!
    expect(question).toMatchObject({ status: 'asks', commits: 1, targetCommits: 1, target: 'main' })
    expect(main()).toBe(theirs)
    await expect(press(randomUUID())).rejects.toThrow(BRING_BACK_QUESTION_GONE)
    expect(main()).toBe(theirs)
    expect(record()!.actionId).toBe(question.actionId)
    await press(question.actionId)
    expect(git(project, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([theirs, ours])
    expect(record()).toMatchObject({ status: 'done', how: 'merge-commit', commits: 1, targetCommits: 1, head: main(), subject: `Merge branch '${question.branch}' into main` })
    // The question is spent: a second yes to it is refused.
    await expect(press(question.actionId)).rejects.toThrow(BRING_BACK_QUESTION_GONE)
  })

  it('records the refusal, and where main is checked out, when the project folder has uncommitted work', async () => {
    const { project, childFolder, press, record, main } = await family()
    await commitFile(childFolder, 'test.txt', 'mid-chunk\n', 'Test')
    await writeFile(join(project, 'work.txt'), 'the parent is editing\n')
    const before = main()
    await press()
    expect(record()).toMatchObject({ status: 'refused', refusal: 'target-uncommitted', files: 1, checkedOut: 'project' })
    expect(main()).toBe(before)
    expect(await readFile(join(project, 'work.txt'), 'utf8')).toBe('the parent is editing\n')
  })

  it('names the thread whose work holds the folder where main is checked out, and nothing else when no thread holds it (#1866)', async () => {
    const { f, childFolder, press, record, main } = await family()
    await commitFile(childFolder, 'test.txt', 'mid-chunk\n', 'Test')
    const before = main()
    f.host.setPendingThreadWork(id => id === 'parent', () => 'failed-followups')
    await press()
    // A hold, in the guard's words with the bring-back's own "Nothing was brought back.", naming the thread that holds it.
    expect(record()).toMatchObject({ status: 'refused', refusal: 'busy', heldBy: 'parent', checkedOut: 'project',
      message: 'Thread "WAV preview stall" has queued follow-ups that did not send. Nothing was brought back. Resume or remove them, then try again.' })
    expect(main()).toBe(before)
    // A Git action holding that folder is no thread: the refusal keeps the words it has always had, and names none.
    f.host.setPendingThreadWork(() => false)
    const held = await f.host.acquireCheckoutMutation('parent')
    try { await press() } finally { held() }
    expect(record()).toMatchObject({ status: 'refused', refusal: 'busy', checkedOut: 'project',
      message: 'A Git action is running in this folder. Nothing was changed. Wait for it to finish before changing this folder.' })
    expect(record()!.heldBy).toBeUndefined()
    expect(main()).toBe(before)
  })

  it.each([
    ['made from another branch', { childBase: 'release' }],
    ['sharing the project folder', { childWorkingCopy: 'shared' as const }],
  ])('offers nothing to a child %s, and a press changes nothing', async (_name, options) => {
    const { thread, press, record, main } = await family(options)
    expect(bringBackTarget(thread('child'), [thread('parent'), thread('child')])).toBeNull()
    const before = main()
    await expect(press()).rejects.toThrow(BRING_BACK_NO_TARGET)
    expect(record()).toBeUndefined()
    expect(main()).toBe(before)
  })

  it('finds every thread to read again in one pass over the thread list, however many share the folder', async () => {
    const { f, project, thread } = await family()
    const host = f.host as unknown as { state: { snapshot: { threads: AgentThread[] } }; onLane: (threadId: string, run: () => Promise<void>) => Promise<void>
      followBroughtChanges(parentId: string, checkout: string | null): void }
    const real = host.state.snapshot.threads
    const many = Array.from({ length: 1_000 }, (_, index) => ({ ...thread('parent'), id: `shared-${index}` }))
    let visits = 0
    host.state.snapshot.threads = new Proxy(many, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) visits++
      return Reflect.get(target, key, receiver) as unknown
    } })
    const onLane = host.onLane
    let queued = 0
    host.onLane = async () => { queued++ }
    try { host.followBroughtChanges('shared-0', project) } finally { host.onLane = onLane; host.state.snapshot.threads = real }
    expect(queued).toBe(1_000)
    expect(visits).toBeLessThanOrEqual(1_000)
  })

  it('refuses in plain words while the Owl list keeps it off', async () => {
    const { childFolder, press, main } = await family({ allow: false })
    await commitFile(childFolder, 'test.txt', 'mid-chunk\n', 'Test')
    const before = main()
    await expect(press()).rejects.toThrow(BRING_BACK_OFF)
    expect(main()).toBe(before)
  })

  it('brings a child’s branch that arrived from another machine to the parent’s branch, keeps the outcome on the parent, and lets the ref go', async () => {
    const { f, project, thread, main } = await family()
    const { elsewhere, from, land } = await arrival(project, f.root)
    const head = await commitFile(elsewhere, 'away.txt', 'from forge\n', 'Work done on forge')
    const { moveId, ref } = land()
    await f.host.bringChangesBack({ threadId: 'parent', actionId: randomUUID(), away: { moveId, from, target: 'main' } })
    expect(main()).toBe(head)
    expect(await readFile(join(project, 'away.txt'), 'utf8')).toBe('from forge\n')
    expect(thread('parent').broughtBack).toMatchObject({ status: 'done', how: 'fast-forward', from, target: 'main', branch: 'feat/away', commits: 1, head, checkedOut: 'project' })
    expect(thread('parent').bringBack).toBeUndefined()
    expect(() => git(project, 'rev-parse', '-q', '--verify', ref)).toThrow()
  })

  it('asks before a merge commit for a branch from another machine, and makes it on the yes once the branch arrives again', async () => {
    const { f, project, thread, main } = await family()
    const { elsewhere, from, land } = await arrival(project, f.root)
    const ours = await commitFile(elsewhere, 'away.txt', 'from forge\n', 'Work done on forge')
    const theirs = await commitFile(project, 'notes.txt', 'meanwhile\n', 'Note what happened meanwhile')
    const first = land()
    await f.host.bringChangesBack({ threadId: 'parent', actionId: randomUUID(), away: { moveId: first.moveId, from, target: 'main' } })
    const question = thread('parent').broughtBack!
    expect(question).toMatchObject({ status: 'asks', from, commits: 1, targetCommits: 1 })
    expect(main()).toBe(theirs)
    expect(() => git(project, 'rev-parse', '-q', '--verify', first.ref)).toThrow()
    const again = land()
    await f.host.bringChangesBack({ threadId: 'parent', actionId: randomUUID(), mergeCommit: question.actionId, away: { moveId: again.moveId, from, target: 'main' } })
    expect(git(project, 'rev-list', '--parents', '-n', '1', 'main').split(' ').slice(1)).toEqual([theirs, ours])
    expect(thread('parent').broughtBack).toMatchObject({ status: 'done', how: 'merge-commit', subject: "Merge branch 'feat/away' into main" })
    expect(() => git(project, 'rev-parse', '-q', '--verify', again.ref)).toThrow()
  })

  it('refuses a branch from another machine while the parent’s folder has uncommitted work, and still lets the ref go', async () => {
    const { f, project, thread, main } = await family()
    const { elsewhere, from, land } = await arrival(project, f.root)
    await commitFile(elsewhere, 'away.txt', 'from forge\n', 'Work done on forge')
    await writeFile(join(project, 'work.txt'), 'the parent is editing\n')
    const before = main(), { moveId, ref } = land()
    await f.host.bringChangesBack({ threadId: 'parent', actionId: randomUUID(), away: { moveId, from, target: 'main' } })
    expect(thread('parent').broughtBack).toMatchObject({ status: 'refused', refusal: 'target-uncommitted', files: 1, from })
    expect(main()).toBe(before)
    expect(await readFile(join(project, 'work.txt'), 'utf8')).toBe('the parent is editing\n')
    expect(() => git(project, 'rev-parse', '-q', '--verify', ref)).toThrow()
  })

  it('lets the incoming ref go when the parent’s checkout is busy, and leaves none behind across retries', async () => {
    const { f, project, main } = await family()
    const { elsewhere, from, land } = await arrival(project, f.root)
    await commitFile(elsewhere, 'away.txt', 'from forge\n', 'Work done on forge')
    const before = main()
    const held = await f.host.acquireCheckoutMutation('parent')
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { moveId } = land()
        await expect(f.host.bringChangesBack({ threadId: 'parent', actionId: randomUUID(), away: { moveId, from, target: 'main' } })).rejects.toThrow()
      }
    } finally { held() }
    expect(git(project, 'for-each-ref', 'refs/sotto/incoming')).toBe('')
    expect(main()).toBe(before)
  })

  it('refuses a branch from another machine while a thread holds the parent’s folder as a hold that names it, and lets the ref go (#1866)', async () => {
    const { f, project, main } = await family()
    const { elsewhere, from, land } = await arrival(project, f.root)
    await commitFile(elsewhere, 'away.txt', 'from forge\n', 'Work done on forge')
    const before = main()
    f.host.setPendingThreadWork(id => id === 'parent', () => 'failed-followups')
    const { moveId } = land()
    const refusal = await f.host.bringChangesBack({ threadId: 'parent', actionId: randomUUID(), away: { moveId, from, target: 'main' } }).then(() => null, (error: unknown) => error)
    // The folder is held before Git runs, so the press's own reply says so, with the thread that holds it, as a Git action's does.
    expect(refusal).toBeInstanceOf(CheckoutHeldRefusal)
    expect((refusal as CheckoutHeldRefusal).message).toBe('Thread "WAV preview stall" has queued follow-ups that did not send. Nothing was brought back. Resume or remove them, then try again.')
    expect((refusal as CheckoutHeldRefusal).threadId).toBe('parent')
    expect(git(project, 'for-each-ref', 'refs/sotto/incoming')).toBe('')
    expect(main()).toBe(before)
  })

  it('refuses a branch from another machine when the parent is no longer on its branch, and switches nothing', async () => {
    const { f, project, thread, main } = await family()
    const { elsewhere, from, land } = await arrival(project, f.root)
    await commitFile(elsewhere, 'away.txt', 'from forge\n', 'Work done on forge')
    git(project, 'branch', 'release')
    const before = main(), { moveId } = land()
    await f.host.bringChangesBack({ threadId: 'parent', actionId: randomUUID(), away: { moveId, from, target: 'release' } })
    expect(thread('parent').broughtBack).toMatchObject({ status: 'refused', refusal: 'parent-moved' })
    expect(main()).toBe(before)
    expect(git(project, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })
})
