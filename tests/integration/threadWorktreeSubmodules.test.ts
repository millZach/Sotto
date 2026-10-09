// @vitest-environment node

import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'

import { fixture, submoduleHistoryFixture } from '../fixtures/threadWorktreeFixture'

describe("independent working-copy allocation", () => {
  it.each(['branch', 'tag', 'no-remote'] as const)('requires acknowledgement of clean submodule history outside HEAD (%s)', async reference => {
    const f = await submoduleHistoryFixture(reference)
    expect((await lstat(join(f.module, '.git'))).isFile()).toBe(true)
    expect(await git(f.module, ['status', '--porcelain'])).toBe('')
    const preview = await f.service.reclaimFacts(f.a)
    expect(preview.dirty).toBe(false)
    expect(preview.repositories).toEqual([{ path: 'module/', changeCount: 0, kind: 'repository', unpushedCommitCount: reference === 'no-remote' ? 2 : 1 }])
    expect(preview.ignored).toEqual(['module/'])
    expect(preview.items.find(item => item.path === 'module/')?.fileCount).toBeGreaterThan(0)
    await expect(f.service.reclaim(f.a, { automatic: true })).rejects.toThrow('a rule leaves it alone')
    await expect(f.service.reclaim(f.a)).rejects.toThrow('Choose Remove worktree to review them')
    await expect(f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored })).rejects.toThrow('The nested work changed')
    expect((await lstat(f.gitDirectory)).isDirectory()).toBe(true)
    expect(await git(f.module, ['cat-file', '-t', f.privateCommit])).toBe('commit\n')
    expect((await f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    await expect(lstat(f.gitDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
  it('rechecks unpublished submodule history inside the registry lane', async () => {
    const f = await submoduleHistoryFixture()
    const preview = await f.service.reclaimFacts(f.a)
    let historyReads = 0
    const service = new ThreadWorktrees(f.root, async (cwd, args) => {
      if (cwd === f.module && args[0] === 'rev-list' && ++historyReads === 2) {
        // Only refs change: the clean checkout and its file count stay the same.
        const tree = (await git(f.module, ['rev-parse', `${f.privateCommit}^{tree}`])).trim()
        const unseen = (await git(f.module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', f.privateCommit, '-m', 'Unseen module history'])).trim()
        await git(f.module, ['update-ref', 'refs/heads/private', unseen])
      }
      return git(cwd, args)
    })
    await expect(service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow('The files changed')
    expect(historyReads).toBe(2)
    expect(await git(f.module, ['cat-file', '-t', f.privateCommit])).toBe('commit\n')
    expect((await lstat(f.gitDirectory)).isDirectory()).toBe(true)
  })
  it.each(['deinitialized-branch', 'deinitialized-tag'] as const)('requires acknowledgement of retained submodule history (%s)', async reference => {
    const f = await submoduleHistoryFixture(reference, reference === 'deinitialized-tag' ? 'kept.history' : 'module')
    await expect(lstat(join(f.module, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lstat(f.gitDirectory)).isDirectory()).toBe(true)
    const preview = await f.service.reclaimFacts(f.a)
    expect(preview.dirty).toBe(false)
    expect(preview.repositories).toEqual([{ path: 'module/', changeCount: 0, kind: 'repository', unpushedCommitCount: 1 }])
    await expect(f.service.reclaim(f.a, { automatic: true })).rejects.toThrow('a rule leaves it alone')
    await expect(f.service.reclaim(f.a)).rejects.toThrow('Choose Remove worktree to review them')
    expect(await git(f.gitDirectory, ['--git-dir', f.gitDirectory, 'cat-file', '-t', f.privateCommit])).toBe('commit\n')
    expect((await f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    await expect(lstat(f.gitDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
  it.each(['published', 'private'] as const)('inspects retained recursive submodule history without its checkout (%s)', async history => {
    const f = await fixture(), moduleOrigin = await fixture(), childOrigin = await fixture()
    await git(moduleOrigin.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', childOrigin.project, 'child'])
    await git(moduleOrigin.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add child module'])
    await git(f.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', moduleOrigin.project, 'module'])
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add module'])
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])
    const child = join(a.path!, 'module', 'child')
    const recorded = (await git(child, ['rev-parse', 'HEAD'])).trim()
    const childDirectory = (await git(child, ['rev-parse', '--absolute-git-dir'])).trim()
    let privateCommit = ''
    if (history === 'private') {
      await git(child, ['checkout', '-b', 'private'])
      await writeFile(join(child, 'private.txt'), 'unpublished recursive history')
      await git(child, ['add', '.'])
      await git(child, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Private child work'])
      privateCommit = (await git(child, ['rev-parse', 'HEAD'])).trim()
      await git(child, ['checkout', '--detach', recorded])
    }
    await git(a.path!, ['submodule', 'deinit', '--', 'module'])
    await expect(lstat(child)).rejects.toMatchObject({ code: 'ENOENT' })
    // Parent deinit retains the child's core.worktree pointing at the removed checkout.
    expect(await readFile(join(childDirectory, 'config'), 'utf8')).toContain('worktree =')
    const preview = await f.service.reclaimFacts(a)
    expect(preview.dirty).toBe(false)
    if (history === 'published') {
      expect(preview.repositories).toEqual([])
      expect(preview.ignored).toEqual([])
      expect((await f.service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
    } else {
      expect(preview.repositories).toEqual([{ path: '.git/modules/module/modules/child/', changeCount: 0, kind: 'repository', unpushedCommitCount: 1 }])
      expect(preview.items.find(item => item.path === '.git/modules/module/modules/child/')?.fileCount).toBeGreaterThan(0)
      await expect(f.service.reclaim(a, { automatic: true })).rejects.toThrow('a rule leaves it alone')
      await expect(f.service.reclaim(a)).rejects.toThrow('Choose Remove worktree to review them')
      await expect(f.service.reclaim(a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored })).rejects.toThrow('The nested work changed')
      expect(await git(childDirectory, ['--git-dir', childDirectory, '--work-tree', childDirectory, 'cat-file', '-t', privateCommit])).toBe('commit\n')
      expect((await f.service.reclaim(a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    }
    await expect(lstat(childDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
  it.each(['clean', 'recursive', 'dirty-hidden'])('reclaims initialized submodules safely (%s)', async mode => {
    const recursive = mode === 'recursive'
    const f = await fixture()
    const module = join(f.root, 'module'); await mkdir(module)
    await git(module, ['init'])
    await writeFile(join(module, 'module.txt'), 'committed')
    await git(module, ['add', '.'])
    await git(module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Module'])
    if (recursive) {
      const childModule = join(f.root, 'child-module'); await mkdir(childModule)
      await git(childModule, ['init'])
      await writeFile(join(childModule, 'child.txt'), 'committed child')
      await git(childModule, ['add', '.'])
      await git(childModule, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Child'])
      await git(module, ['-c', 'protocol.file.allow=always', 'submodule', 'add', childModule, 'child'])
      await git(module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add child module'])
    }
    await git(f.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'module'])
    await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add submodule'])
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])
    if (mode === 'dirty-hidden') {
      await git(a.path!, ['config', 'submodule.module.ignore', 'all'])
      await writeFile(join(a.path!, 'module', 'module.txt'), 'uncommitted module work')
      const facts = await f.service.reclaimFacts(a)
      expect(facts.dirty).toBe(true)
      expect(facts.repositories).toEqual([{ path: 'module/', changeCount: 1, kind: 'repository', unpushedCommitCount: 0 }])
      await expect(f.service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies')
      expect((await f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: facts.items, confirmedIgnored: facts.ignored, confirmedRepositories: facts.repositories })).reclaimedAt).toBeTruthy()
      return
    }
    expect((await f.service.reclaimFacts(a)).repositories).toEqual([])
    expect((await f.service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
  })
})
