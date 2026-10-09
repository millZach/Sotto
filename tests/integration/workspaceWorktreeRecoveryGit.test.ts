// @vitest-environment node

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'
import { fixture, local, send } from '../fixtures/workspaceTestFixture'

describe("durable project/thread organization", () => {
  it.each(['missing', 'reclaimed', 'unreadable', 'shared-after-missing', 'missing-shared-subfolder'] as const)('checks checkout ownership with a %s thread folder', async kind => {
    const f = await fixture()
    const repository = f.adapters.codex.state.projects[0]!.path
    await git(repository, ['init'])
    await writeFile(join(repository, 'tracked.txt'), 'baseline')
    await git(repository, ['add', '.'])
    await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Baseline'])
    f.host.setWorkingCopyDefaults(() => 'independent')
    await local(f)
    await f.host.execute(send())
    const owner = f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')!
    const provider = f.adapters.codex.state.threads
    provider.at(-1)!.status = 'idle'
    const missing = join(kind === 'missing-shared-subfolder' ? owner.workingDirectory! : repository, 'missing-folder')
    provider[0]!.workingDirectory = missing
    if (kind === 'reclaimed') provider[0]!.worktree = { mode: 'independent', status: 'ready', path: missing, reclaimedAt: '2026-09-22T00:00:00.000Z' }
    if (kind === 'shared-after-missing') {
      f.adapters.claude.state.threads[0]!.workingDirectory = owner.workingDirectory
      f.adapters.claude.emit()
    }
    const original = ThreadWorktrees.prototype.checkoutIdentity
    const service = new ThreadWorktrees(f.root)
    const identity = vi.spyOn(ThreadWorktrees.prototype, 'checkoutIdentity')
    if (kind === 'unreadable') {
      identity.mockImplementation(async path => {
        if (path === missing) throw Object.assign(new Error('Unreadable folder'), { code: 'EACCES' })
        return original.call(service, path)
      })
    }
    f.adapters.codex.emit()
    await f.host.snapshot()
    await f.host.renameTemporaryBranch('local', 'sotto/available-name')
    const blocked = kind === 'unreadable' || kind === 'shared-after-missing' || kind === 'missing-shared-subfolder'
    expect((await git(owner.workingDirectory!, ['branch', '--show-current'])).trim()).toBe(blocked ? owner.worktree!.branch : 'sotto/available-name')
    if (kind === 'reclaimed') expect(identity).not.toHaveBeenCalledWith(missing)
    if (blocked) await expect(f.host.reclaimThreadWorktree('local')).rejects.toThrow('Another thread works in this folder')
    else {
      // The removal holds the folder off the remote half of status reads and waits for one already running in it.
      const order: string[] = []
      f.host.setGitStatus({ read: vi.fn(async () => { throw new Error('Not read here.') }), invalidate: vi.fn(),
        hold: vi.fn(() => { order.push('hold'); return () => { order.push('released') } }), idle: vi.fn(async () => { order.push('idle') }) }, { pollIntervalMs: () => 0 })
      await f.host.reclaimThreadWorktree('local', { automatic: kind === 'reclaimed' })
      expect(order).toEqual(['hold', 'idle', 'released'])
      expect(f.host.workspaceSnapshot().threads.find(thread => thread.id === 'local')?.worktree?.reclaimedAt).toBeDefined()
    }
  })

})
