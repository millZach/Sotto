// @vitest-environment node
import { initializeGitRepository } from '../fixtures/gitRepository'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** A workspace over a fake provider whose two threads each said something, in a real repository. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-thread-deletion-'))
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-thread-deletion-')) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  })
  const project = join(root, 'project'); await mkdir(project)
  await initializeGitRepository(project, { files: { 'tracked.txt': 'baseline', '.gitignore': 'node_modules/\n*.log\n' } })
  const worktrees = new ThreadWorktrees(root)
  const checkout = async () => worktrees.inspect(await worktrees.ensure(await worktrees.allocate(project, 'independent')))
  const adapter = new FakeProviderHost()
  adapter.state.projects[0]!.path = project
  for (const thread of adapter.state.threads) {
    thread.messages = [{ id: `${thread.id}-user`, role: 'user', text: `Secret plan for ${thread.title}`, createdAt: '2026-09-01T00:00:00.000Z' }]
  }
  const forgotten: string[] = []
  ;(adapter as FakeProviderHost & { forgetThread(id: string): Promise<void> }).forgetThread = async id => { forgotten.push(id) }
  const open = async () => {
    const host = new WorkspaceHost(adapter, root, () => true)
    cleanup.push(async () => { await host.close().catch(() => undefined) })
    await host.initialize(); await host.connect()
    return host
  }
  return { root, project, adapter, worktrees, checkout, forgotten, open }
}
const automatic = { automatic: true, hold: () => null }

describe('deleting settled threads (ADR-0140)', () => {
  it('removes the record and its history, forgets the alias, and keeps the thread cleared across snapshots and restarts', async () => {
    const f = await fixture()
    const host = await f.open()
    await host.setWorkspaceSettled('thread', 'session-workshop', true)
    expect(host.threadMessages('session-workshop').map(message => message.text)).toEqual(['Secret plan for Workshop'])
    await host.setDelegatedBy('session-docs', 'session-workshop')

    const result = await host.deleteThreads(['session-workshop'], automatic)
    expect(result).toEqual({ deleted: ['session-workshop'], kept: [] })
    expect(host.workspaceSnapshot().threads.map(thread => thread.id)).toEqual(['session-docs'])
    expect(host.isThreadCleared('session-workshop')).toBe(true)
    expect(f.forgotten).toEqual(['session-workshop'])
    // The thread it delegated to keeps its own history and loses only the link.
    expect(host.workspaceSnapshot().threads[0]!.delegatedBy).toBeUndefined()

    // The provider still reports it: it does not come back.
    f.adapter.emit()
    await host.snapshot()
    expect(host.workspaceSnapshot().threads.map(thread => thread.id)).toEqual(['session-docs'])
    await host.close()

    // Its words are gone from the store; the other thread's are kept.
    const store = new ThreadStore(join(f.root, 'threads.sqlite'))
    store.open()
    try {
      expect(store.messageCount('session-workshop')).toBe(0)
      expect(store.messageCount('session-docs')).toBe(1)
    } finally { store.close() }

    const again = await f.open()
    expect(again.workspaceSnapshot().threads.map(thread => thread.id)).toEqual(['session-docs'])
    expect(again.isThreadCleared('session-workshop')).toBe(true)
  })

  it('keeps a thread the coordinator holds back, or one still working, and says why', async () => {
    const f = await fixture()
    const host = await f.open()
    await host.setWorkspaceSettled('thread', 'session-workshop', true)
    await host.setWorkspaceSettled('thread', 'session-docs', true)
    expect(await host.deleteThreads(['session-workshop'], { automatic: true, hold: () => 'pull-request' })).toEqual({ deleted: [], kept: [{ threadId: 'session-workshop', reason: 'pull-request' }] })
    f.adapter.state.threads.find(thread => thread.id === 'session-docs')!.status = 'running'
    f.adapter.emit(); await host.snapshot()
    expect(await host.deleteThreads(['session-docs'], automatic)).toEqual({ deleted: [], kept: [{ threadId: 'session-docs', reason: 'working' }] })
    expect(host.workspaceSnapshot().threads).toHaveLength(2)
    expect(f.forgotten).toEqual([])
  })

  it('clears many threads in one go', async () => {
    const f = await fixture()
    const host = await f.open()
    const forgetMany = vi.spyOn(ThreadStore.prototype, 'forgetMany')
    const result = await host.deleteThreads(['session-workshop', 'session-docs'], automatic)
    expect(result.deleted).toEqual(['session-workshop', 'session-docs'])
    // One store transaction for all of them, not one per thread.
    expect(forgetMany).toHaveBeenCalledTimes(1)
    expect(forgetMany).toHaveBeenCalledWith(['session-workshop', 'session-docs'])
    expect(host.workspaceSnapshot().threads).toEqual([])
  })

  it('removes the thread’s own clean worktree and keeps its branch', async () => {
    const f = await fixture()
    const copy = await f.checkout()
    f.adapter.state.threads[0]!.worktree = copy
    const host = await f.open()
    await host.setWorkspaceSettled('thread', 'session-workshop', true)
    const preview = await host.previewThreadDeletion('session-workshop', true)
    expect(preview.kept).toBeNull()
    expect(preview.worktree?.path).toBe(copy.path)

    expect((await host.deleteThreads(['session-workshop'], automatic)).deleted).toEqual(['session-workshop'])
    expect(await exists(copy.path!)).toBe(false)
    expect((await git(f.project, ['rev-parse', '--verify', `refs/heads/${copy.branch}`])).trim()).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('keeps a thread whose worktree has uncommitted changes, whichever way it is deleted', async () => {
    const f = await fixture()
    const dirty = await f.checkout()
    await writeFile(join(dirty.path!, 'tracked.txt'), 'unsaved work')
    f.adapter.state.threads[0]!.worktree = dirty
    const host = await f.open()
    expect(await host.deleteThreads(['session-workshop'], automatic)).toEqual({ deleted: [], kept: [{ threadId: 'session-workshop', reason: 'uncommitted' }] })
    expect((await host.previewThreadDeletion('session-workshop')).kept).toBe('uncommitted')
    expect(await host.deleteThreads(['session-workshop'], { automatic: false, hold: () => null })).toEqual({ deleted: [], kept: [{ threadId: 'session-workshop', reason: 'uncommitted' }] })
    expect(await exists(dirty.path!)).toBe(true)
  })

  it('keeps a worktree holding ignored files from Clear now, and lists them for Delete thread… to tick', async () => {
    const f = await fixture()
    const built = await f.checkout()
    await writeFile(join(built.path!, 'build.log'), 'output')
    f.adapter.state.threads[1]!.worktree = built
    const host = await f.open()
    expect(await host.deleteThreads(['session-docs'], automatic)).toEqual({ deleted: [], kept: [{ threadId: 'session-docs', reason: 'worktree-files' }] })
    const preview = await host.previewThreadDeletion('session-docs')
    expect(preview.kept).toBeNull()
    expect(preview.worktree?.ignored).toEqual(['build.log'])
    const ticked = await host.deleteThreads(['session-docs'], { automatic: false, hold: () => null,
      worktree: { confirmedIgnored: preview.worktree!.ignored, confirmedItems: preview.worktree!.items.map(({ path, fileCount }) => ({ path, fileCount })) } })
    expect(ticked.deleted).toEqual(['session-docs'])
    expect(await exists(built.path!)).toBe(false)
    expect((await git(f.project, ['rev-parse', '--verify', `refs/heads/${built.branch}`])).trim()).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('leaves a shared project checkout alone', async () => {
    const f = await fixture()
    const host = await f.open()
    const result = await host.deleteThreads(['session-workshop'], automatic)
    expect(result.deleted).toEqual(['session-workshop'])
    expect(await exists(join(f.project, 'tracked.txt'))).toBe(true)
  })
})
