// @vitest-environment node

import { initializeGitRepository } from '../fixtures/gitRepository'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fetchHeadSource, runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'

import { fixture, submoduleHistoryFixture } from '../fixtures/threadWorktreeFixture'

const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid']

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
  it.each(['deinitialized', 'checked-out'] as const)("counts a nested repository's own submodule history (%s)", async state => {
    const f = await fixture(), nestedOrigin = await fixture(), moduleOrigin = await fixture()
    await git(nestedOrigin.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', moduleOrigin.project, 'module'])
    await git(nestedOrigin.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add module'])
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    // A plain clone inside the worktree: its own commits are all on its remote.
    const nested = join(a.path!, 'nested')
    await git(a.path!, ['-c', 'protocol.file.allow=always', 'clone', '--recurse-submodules', nestedOrigin.project, 'nested'])
    const module = join(nested, 'module')
    const recorded = (await git(module, ['rev-parse', 'HEAD'])).trim()
    const moduleDirectory = (await git(module, ['rev-parse', '--absolute-git-dir'])).trim()
    // Git prints forward slashes, and on a Windows runner a long folder name where the temp path holds the short one.
    const modulesHome = await realpath(join(nested, '.git', 'modules'))
    expect((await realpath(moduleDirectory)).startsWith(modulesHome)).toBe(true)
    await git(module, ['checkout', '-b', 'private'])
    await writeFile(join(module, 'private.txt'), 'local-only nested module history')
    await git(module, ['add', '.'])
    await git(module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Private nested module work'])
    const privateCommit = (await git(module, ['rev-parse', 'HEAD'])).trim()
    await git(module, ['checkout', '--detach', recorded])
    if (state === 'deinitialized') await git(nested, ['submodule', 'deinit', '--', 'module'])
    const preview = await f.service.reclaimFacts(a)
    // The checked-out module has a row of its own; its history is not counted twice.
    expect(preview.repositories).toEqual(state === 'deinitialized'
      ? [{ path: 'nested/', changeCount: 0, kind: 'repository', unpushedCommitCount: 1 }]
      : [{ path: 'nested/', changeCount: 0, kind: 'repository', unpushedCommitCount: 0 }, { path: 'nested/module/', changeCount: 0, kind: 'repository', unpushedCommitCount: 1 }])
    await expect(f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories.map(row => ({ ...row, unpushedCommitCount: 0 })) })).rejects.toThrow('The nested work changed')
    expect(await git(moduleDirectory, ['--git-dir', moduleDirectory, 'cat-file', '-t', privateCommit])).toBe('commit\n')
    expect((await f.service.reclaim(a, { withUncommittedChanges: true, confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    await expect(lstat(moduleDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
  /**
   * A worktree whose submodule is checked out at a commit its origin keeps under a ref that is not a branch, as
   * GitHub keeps a pull request's head. A clone does not fetch it, so `git submodule update` fetches it by its hash,
   * which leaves it in FETCH_HEAD and on no remote-tracking ref (#687).
   */
  async function fetchedByHashFixture() {
    const f = await fixture()
    const origin = join(f.root, 'module-origin'); await mkdir(origin)
    await writeFile(join(origin, 'module.txt'), 'published baseline')
    await initializeGitRepository(origin, { files: {}, message: 'Module baseline', identity: { name: 'Fixture', email: 'fixture@example.invalid' } })
    const tree = (await git(origin, ['rev-parse', 'HEAD^{tree}'])).trim()
    const published = (await git(origin, [...identity, 'commit-tree', tree, '-p', 'HEAD', '-m', 'Published on no branch'])).trim()
    await git(origin, ['update-ref', 'refs/pull/1/head', published])
    await git(f.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', origin, 'module'])
    await git(join(f.project, 'module'), ['-c', 'protocol.file.allow=always', 'fetch', 'origin', published])
    await git(join(f.project, 'module'), ['checkout', '--detach', published])
    await git(f.project, ['add', 'module'])
    await git(f.project, [...identity, 'commit', '-m', 'Add module at a commit on no branch'])
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await git(a.path!, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'])
    const module = join(a.path!, 'module')
    expect((await git(module, ['rev-parse', 'HEAD'])).trim()).toBe(published)
    // What the count read before: the commit on no remote-tracking ref.
    expect(await git(module, ['rev-list', '--count', '--all', '--not', '--remotes'])).toBe('1\n')
    expect(await readFile((await git(module, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])).trim(), 'utf8')).toContain(`'${published}' of `)
    return { ...f, a, origin, module, published }
  }
  it.each(['checked-out', 'deinitialized'] as const)('still counts a submodule commit fetched by its hash, and says it may be on its remote (%s)', async state => {
    const f = await fetchedByHashFixture()
    if (state === 'deinitialized') await git(f.a.path!, ['submodule', 'deinit', '--', 'module'])
    const preview = await f.service.reclaimFacts(f.a)
    expect(preview.repositories).toEqual([{ path: 'module/', changeCount: 0, kind: 'repository', unpushedCommitCount: 1, fetchedByHash: { remote: 'origin', commitCount: 1 } }])
    await expect(f.service.reclaim(f.a, { automatic: true })).rejects.toThrow('a rule leaves it alone')
    await expect(f.service.reclaim(f.a)).rejects.toThrow('Choose Remove worktree to review them')
    if (state === 'checked-out') {
      // A tick given to the note is refused once the note is gone: the row would now say "not on any remote".
      const fetchHead = (await git(f.module, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])).trim()
      const recorded = await readFile(fetchHead, 'utf8')
      await rm(fetchHead)
      await expect(f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).rejects.toThrow('The nested work changed')
      await writeFile(fetchHead, recorded)
      expect((await f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: preview.repositories })).reclaimedAt).toBeTruthy()
    } else {
      // A client from before the note confirms the row without it, having read "1 commit not on any remote".
      const unnoted = preview.repositories.map(row => ({ path: row.path, changeCount: row.changeCount, unpushedCommitCount: row.unpushedCommitCount, kind: row.kind }))
      expect((await f.service.reclaim(f.a, { confirmedItems: preview.items, confirmedIgnored: preview.ignored, confirmedRepositories: unnoted })).reclaimedAt).toBeTruthy()
    }
  }, 60_000)
  it.each(['built on it', 'fetched from itself', 'fetched from a folder that is not its remote', 'fetched from a remote at its own path', 'fetched from a remote at its own Git directory'] as const)('notes only the commits fetched from another copy (%s)', async source => {
    const f = await fetchedByHashFixture()
    let local: string
    if (source === 'fetched from a folder that is not its remote') {
      const elsewhere = join(f.root, 'elsewhere')
      await git(f.root, ['-c', 'protocol.file.allow=always', 'clone', f.origin, elsewhere])
      await git(elsewhere, ['-c', 'protocol.file.allow=always', 'fetch', 'origin', f.published])
      local = (await git(elsewhere, [...identity, 'commit-tree', `${f.published}^{tree}`, '-p', f.published, '-m', 'Work kept in another folder'])).trim()
      await git(elsewhere, ['update-ref', 'refs/heads/elsewhere', local])
      await git(f.module, ['-c', 'protocol.file.allow=always', 'fetch', '--append', elsewhere, local])
    } else {
      local = (await git(f.module, [...identity, 'commit-tree', `${f.published}^{tree}`, '-p', f.published, '-m', 'Local module work'])).trim()
      // `git pull . <branch>` writes the same kind of record, from the repository itself.
      if (source === 'fetched from itself') await git(f.module, ['-c', 'protocol.file.allow=always', 'fetch', '--append', '.', local])
      if (source.startsWith('fetched from a remote at its own')) {
        // A remote that is the submodule itself, by its path or a file URL: this fetch replaces the record from origin.
        const gitDirectory = (await git(f.module, ['rev-parse', '--absolute-git-dir'])).trim()
        await git(f.module, ['remote', 'add', 'self', source.endsWith('path') ? f.module : pathToFileURL(gitDirectory).href])
        await git(f.module, ['-c', 'protocol.file.allow=always', 'fetch', 'self', f.published, local])
      }
    }
    await git(f.module, ['checkout', '--detach', local])
    const fetchHead = await readFile((await git(f.module, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])).trim(), 'utf8')
    if (source !== 'built on it') expect(fetchHead).toContain(`'${local}' of `)
    const preview = await f.service.reclaimFacts(f.a)
    // Both commits stay counted; only the one fetched from origin is noted.
    expect(preview.repositories).toEqual([{ path: 'module/', changeCount: 0, kind: 'repository', unpushedCommitCount: 2,
      ...source.startsWith('fetched from a remote at its own') ? {} : { fetchedByHash: { remote: 'origin', commitCount: 1 } } }])
    await expect(f.service.reclaim(f.a, { automatic: true })).rejects.toThrow('a rule leaves it alone')
    expect(await git(f.module, ['cat-file', '-t', local])).toBe('commit\n')
  }, 60_000)
  it.each(['clean', 'recursive', 'dirty-hidden'])('reclaims initialized submodules safely (%s)', async mode => {
    const recursive = mode === 'recursive'
    const f = await fixture()
    const module = join(f.root, 'module'); await mkdir(module)
    await writeFile(join(module, 'module.txt'), 'committed')
    await initializeGitRepository(module, { files: {}, message: "Module", identity: { name: "Fixture", email: "fixture@example.invalid" } })
    if (recursive) {
      const childModule = join(f.root, 'child-module'); await mkdir(childModule)
      await writeFile(join(childModule, 'child.txt'), 'committed child')
      await initializeGitRepository(childModule, { files: {}, message: "Child", identity: { name: "Fixture", email: "fixture@example.invalid" } })
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
  }, 60_000)
})

// What Git 2.55 wrote in FETCH_HEAD for a fetch from each URL, checked with real fetches over a stand-in ssh
// (November 7, 2026). The https forms follow the same rule as ssh's in Git's `transport_anonymize_url`.
describe('a remote URL as FETCH_HEAD names it', () => {
  it.each([
    ['git@github.com:millZach/Sotto.git', 'github.com:millZach/Sotto'],
    ['ssh://git@example.invalid/srv/module.git/', 'ssh://example.invalid/srv/module'],
    ['ssh://user:secret@example.invalid/srv/module.git', 'ssh://example.invalid/srv/module'],
    ['https://user:token@github.com/millZach/Sotto.git', 'https://github.com/millZach/Sotto'],
    ['ssh://example.invalid/srv/a@b/module.git', 'ssh://example.invalid/srv/a@b/module'],
    ['/srv/a@b/module.git/', '/srv/a@b/module'],
    ['C:/Users/a@b/module.git', 'C:/Users/a@b/module'],
    ['../origin/.git', '../origin/'],
    ['a.git', 'a.git'],
  ])('%s', (url, source) => {
    expect(fetchHeadSource(url)).toBe(source)
  })
})
