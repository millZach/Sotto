// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { initializeGitRepository } from '../fixtures/gitRepository'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { workspaceFixture } from '../fixtures/workspaceFixture'

import { runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'

import { cleanup, fixture, local, send } from '../fixtures/workspaceTestFixture'

describe("durable project/thread organization", () => {
  it('drains a pending branch name without renaming Git after shutdown starts', async () => {
    const f = await workspaceFixture()
    cleanup.push(async () => { f.native.disconnect(); await f.registry.flush(); await f.remove() })
    const repository = f.adapters.codex.state.projects[0]!.path
    await writeFile(join(repository, 'tracked.txt'), 'baseline')
    await initializeGitRepository(repository, { files: {}, message: "Baseline", identity: { name: "Fixture", email: "fixture@example.invalid" } })
    let finish!: (name: string) => void
    const started = deferred<void>()
    const writer = vi.fn(() => { const pending = deferred<string>(); finish = pending.resolve; started.resolve(); return pending.promise })
    f.host.setWorkingCopyDefaults(() => 'independent')
    f.host.setBranchNameWriter(writer)
    await local(f)
    await f.host.execute(send())
    await started.promise
    expect(writer).toHaveBeenCalledOnce()
    const thread = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    const rename = vi.spyOn(ThreadWorktrees.prototype, 'renameTemporaryBranch')
    f.host.disconnect()
    const settled = vi.fn()
    const closed = f.host.close().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finish('sotto/late-generated-name')
    await closed
    expect(rename).not.toHaveBeenCalled()
    expect((await git(thread.workingDirectory!, ['branch', '--show-current'])).trim()).toBe(thread.worktree!.branch)
  })

  it('leaves an agent branch alone when it changes while descriptive naming is pending', async () => {
    const f = await fixture()
    const repository = f.adapters.codex.state.projects[0]!.path
    await writeFile(join(repository, 'tracked.txt'), 'baseline')
    await initializeGitRepository(repository, { files: {}, message: "Baseline", identity: { name: "Fixture", email: "fixture@example.invalid" } })
    let finish!: (name: string | null) => void
    const started = deferred<void>()
    const writer = vi.fn(() => { const pending = deferred<string | null>(); finish = pending.resolve; started.resolve(); return pending.promise })
    f.host.setWorkingCopyDefaults(() => 'independent')
    f.host.setBranchNameWriter(writer)
    await local(f)
    await f.host.execute(send())
    await started.promise
    // Git's inspection after the send runs in the thread's lane; a refresh waits there behind it, so the switch
    // below is made once it has finished.
    await f.host.updateThreadWorktree('local', false)
    expect(writer).toHaveBeenCalledTimes(1)
    // The branch is named by the thread whose first prompt it is, so its own provider is the one asked.
    expect(writer).toHaveBeenCalledWith('local', send().text)
    const thread = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    await git(thread.workingDirectory!, ['switch', '-c', 'feat/agent-choice'])
    await f.host.updateThreadWorktree('local', false)
    expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree).toMatchObject({ branch: 'feat/agent-choice', temporaryBranch: false })
    finish('sotto/generated-name')
    // The rename joins the thread lane, so the next send waits for it rather than sleeping.
    await Promise.resolve(); await Promise.resolve()
    await f.host.execute({ ...send(), commandId: 'next', messageId: 'next' })
    expect((await git(thread.workingDirectory!, ['branch', '--show-current'])).trim()).toBe('feat/agent-choice')
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it.each(['legacy', 'shared-subdirectory'] as const)('never requests or applies branch naming when a %s thread uses the checkout', async kind => {
    const f = await fixture()
    const repository = f.adapters.codex.state.projects[0]!.path
    await writeFile(join(repository, 'tracked.txt'), 'baseline')
    await initializeGitRepository(repository, { files: {}, message: "Baseline", identity: { name: "Fixture", email: "fixture@example.invalid" } })
    const writer = vi.fn(async () => 'sotto/do-not-rename')
    f.host.setWorkingCopyDefaults(() => 'independent')
    f.host.setBranchNameWriter(writer)
    await local(f)
    const execute = f.adapters.codex.execute.bind(f.adapters.codex)
    vi.spyOn(f.adapters.codex, 'execute').mockImplementation(async command => {
      if (command.type === 'send') {
        const owner = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
        const directory = kind === 'legacy' ? owner.workingDirectory! : join(owner.workingDirectory!, 'packages')
        if (kind === 'shared-subdirectory') await mkdir(directory)
        const other = f.adapters.codex.state.threads[0]!
        other.workingDirectory = directory
        if (kind === 'shared-subdirectory') other.worktree = { mode: 'shared', status: 'ready', path: directory }
      }
      return execute(command)
    })
    await f.host.execute(send())
    const owner = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    await f.host.renameTemporaryBranch('local', 'sotto/do-not-rename')
    expect((await git(owner.workingDirectory!, ['branch', '--show-current'])).trim()).toBe(owner.worktree!.branch)
    expect(writer).not.toHaveBeenCalled()
  })

  it.each(['shared', 'independent'] as const)('discovers a legacy %s checkout without moving its provider session or history', async mode => {
    const f = await fixture()
    const project = f.adapters.codex.state.projects[0]!
    await writeFile(join(project.path, 'tracked.txt'), 'baseline')
    await initializeGitRepository(project.path, { files: {}, message: "Baseline", identity: { name: "Fixture", email: "fixture@example.invalid" } })
    const directory = mode === 'shared' ? project.path : join(f.root, 'legacy-checkout')
    if (mode === 'independent') await git(project.path, ['worktree', 'add', '-b', 'legacy-task', directory])
    const native = f.adapters.codex.state.threads[0]!
    native.workingDirectory = directory
    native.messages = [{ id: 'old-message', role: 'assistant', text: 'Retained history', createdAt: '2026-09-01T00:00:00Z' }]
    const snapshot = await f.host.connect()
    const thread = snapshot.threads.find(item => item.providerId === 'codex' && item.title === native.title)!
    const binding = structuredClone(f.registry.byThread(thread.id))
    await writeFile(join(directory, 'tracked.txt'), 'unfinished user edits')
    const discovered = (await f.host.updateThreadWorktree(thread.id, false)).threads.find(item => item.id === thread.id)!
    expect(discovered).toMatchObject({ workingDirectory: directory, worktree: { mode, status: 'ready' } })
    expect(discovered.messages).toEqual(native.messages)
    expect(f.registry.byThread(thread.id)).toEqual(binding)
    const original = discovered.worktree!.branch
    await f.host.execute(send(thread.id))
    await git(directory, ['switch', '-c', `next-${mode}`])
    const changed = (await f.host.updateThreadWorktree(thread.id, false)).threads.find(item => item.id === thread.id)!
    expect(changed.worktree).toMatchObject({ mode, branch: `next-${mode}`, sentBranch: original })
    await f.host.execute({ ...send(thread.id), commandId: 'next-send', messageId: 'next-message' })
    expect(f.host.workspaceSnapshot().threads.find(item => item.id === thread.id)?.worktree?.sentBranch).toBe(`next-${mode}`)
    expect(f.registry.byThread(thread.id)).toEqual(binding)
    expect(f.adapters.codex.commands.filter(command => command.type === 'create-thread')).toHaveLength(0)
    expect(await readFile(join(directory, 'tracked.txt'), 'utf8')).toBe('unfinished user edits')
  })

})
