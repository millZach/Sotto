// @vitest-environment node

import { lstat, mkdir, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises'

import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkoutIdentity, runWorktreeGit as git, ThreadWorktrees, type RunGit } from '../../src/main/agents/threadWorktrees'

import type { AgentWorktree } from '../../src/shared/agents'
import { fixture, removeTestCheckout } from '../fixtures/threadWorktreeFixture'

// Git's ownership checks can refuse discovery; the checkout is found from its files, so they never decide it.
// `checkoutIdentityFallback.test.ts` covers the files not answering, when Git and then the marker do.
it('groups subdirectories with their repository even where Git ownership checks would refuse discovery', async () => {
  const f = await fixture()
  const nested = join(f.project, 'nested'); await mkdir(nested)
  const refused: RunGit = async () => { throw new Error('fatal: detected dubious ownership in repository') }
  const service = new ThreadWorktrees(f.root, refused)
  expect(await service.checkoutIdentity(nested)).toBe(await service.checkoutIdentity(f.project))
})

describe('reading a checkout from its files (issue #766)', () => {
  const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const counting = () => {
    const calls: string[][] = []
    const run: RunGit = async (cwd, args) => { calls.push(args); return git(cwd, args) }
    return { calls, run }
  }

  it('finds the checkout identity Git finds, without asking Git', async () => {
    const f = await fixture()
    const nested = join(f.project, 'nested', 'deeper'); await mkdir(nested, { recursive: true })
    const linked = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const outside = join(f.root, 'plain'); await mkdir(outside)
    const { calls, run } = counting()
    const toplevel = async (folder: string) => key(await realpath((await git(folder, ['rev-parse', '--show-toplevel'])).trim()))
    expect(await checkoutIdentity(f.project, run)).toBe(await toplevel(f.project))
    expect(await checkoutIdentity(nested, run)).toBe(await toplevel(f.project))
    expect(await checkoutIdentity(linked.path!, run)).toBe(await toplevel(linked.path!))
    // Outside any repository Git finds nothing, and the folder groups with the nearest .git of any kind above it,
    // as it always has when Git's discovery was refused, or with itself when there is none.
    let marker: string | undefined
    for (let candidate = await realpath(outside); !marker; candidate = dirname(candidate)) {
      if (await lstat(join(candidate, '.git')).then(() => true, () => false)) marker = candidate
      else if (dirname(candidate) === candidate) break
    }
    expect(await checkoutIdentity(outside, run)).toBe(key(marker ?? await realpath(outside)))
    expect(calls).toEqual([])
  })

  it('passes over a .git folder that is not a repository, as Git does', async () => {
    const f = await fixture()
    const nested = join(f.project, 'nested'); await mkdir(join(nested, '.git'), { recursive: true })
    const { calls, run } = counting()
    // A .git folder with no HEAD, objects or refs is not a repository to Git, which finds the one above it.
    expect(key(await realpath((await git(nested, ['rev-parse', '--show-toplevel'])).trim()))).toBe(key(await realpath(f.project)))
    expect(await checkoutIdentity(nested, run)).toBe(key(await realpath(f.project)))
    expect(calls).toEqual([])
  })

  /**
   * `readyOnDisk` stands in for `inspect` on a send's path, so the two are run over the same folders: where the files
   * say ready, Git confirms the folder and records the same branch; where Git refuses the folder, the files leave it
   * to Git. The files may also leave to Git a folder Git would confirm; that only costs the send its Git processes.
   */
  async function agrees(service: ThreadWorktrees, files: ThreadWorktrees, record: AgentWorktree): Promise<'ready' | 'ask-git'> {
    const fromFiles = await files.readyOnDisk(record)
    const fromGit = await service.inspect(record).then(worktree => ({ worktree }), (error: unknown) => ({ error }))
    if (fromFiles.kind === 'ready') {
      expect(fromGit).toHaveProperty('worktree')
      // Everything but what only Git reads: uncommitted changes, and the error and reclaim marks a ready folder clears.
      const comparable = (worktree: AgentWorktree) => ({ ...worktree, dirty: undefined, error: undefined, reclaimedAt: undefined })
      expect(comparable(fromFiles.worktree)).toEqual(comparable((fromGit as { worktree: AgentWorktree }).worktree))
    } else if ('error' in fromGit) expect(fromFiles).toEqual({ kind: 'ask-git' })
    return fromFiles.kind
  }

  it('reads a ready worktree\'s branch from its files where Git would, and leaves to Git every folder Git refuses', async () => {
    const f = await fixture()
    const { calls, run } = counting()
    const files = new ThreadWorktrees(f.root, run)
    const ready = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    const check = (record: AgentWorktree) => agrees(f.service, files, record)
    expect(await check(ready)).toBe('ready')
    expect(await files.readyOnDisk(ready)).toEqual({ kind: 'ready', worktree: ready })
    await git(ready.path!, ['switch', '-c', 'feat/elsewhere'])
    expect(await check(ready)).toBe('ready')
    expect(await files.readyOnDisk(ready)).toMatchObject({ worktree: { branch: 'feat/elsewhere' } })
    // A temporary branch the folder moved off is the thread's no longer, as `inspect` records it.
    expect(await files.readyOnDisk({ ...ready, temporaryBranch: true })).toMatchObject({ worktree: { branch: 'feat/elsewhere', temporaryBranch: false } })
    await git(ready.path!, ['switch', '--detach'])
    expect(await check(ready)).toBe('ready')
    expect(await files.readyOnDisk(ready)).toMatchObject({ worktree: { branch: undefined } })
    // A project subfolder inside the worktree, one that is not there, and one that leads outside it.
    await mkdir(join(ready.path!, 'packages', 'app'), { recursive: true })
    expect(await check({ ...ready, projectRelativePath: join('packages', 'app') })).toBe('ready')
    expect(await check({ ...ready, projectRelativePath: join('packages', 'gone') })).toBe('ask-git')
    expect(await check({ ...ready, projectRelativePath: '..' })).toBe('ask-git')
    const outside = join(f.root, 'outside'); await mkdir(outside)
    await symlink(outside, join(ready.path!, 'packages', 'redirected'), 'junction')
    expect(await check({ ...ready, projectRelativePath: join('packages', 'redirected') })).toBe('ask-git')
    // The worktree reached through a link is not the checkout Sotto made.
    const link = join(f.root, 'linked-worktree')
    await symlink(ready.path!, link, 'junction')
    expect(await check({ ...ready, path: link })).toBe('ask-git')
    // Locked in Git's registry.
    await git(f.project, ['worktree', 'lock', '--', ready.path!])
    await expect(f.service.inspect(ready)).rejects.toThrow('Git has locked this worktree')
    expect(await check(ready)).toBe('ask-git')
    await git(f.project, ['worktree', 'unlock', '--', ready.path!])
    // A worktree of another repository is not this record's checkout.
    const other = await fixture()
    expect(await check({ ...ready, repositoryRoot: other.project })).toBe('ask-git')
    expect(calls).toEqual([])
    // Recorded as anything but ready, or reclaimed: inspect decides.
    expect(await files.readyOnDisk({ ...ready, status: 'error' })).toEqual({ kind: 'ask-git' })
    expect(await files.readyOnDisk({ ...ready, reclaimedAt: '2026-10-05T00:00:00.000Z' })).toEqual({ kind: 'ask-git' })
    // Git's registry entry has lost its gitdir file, so Git no longer counts the folder as this worktree.
    const entry = (await git(ready.path!, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim()
    const gitdir = await readFile(join(entry, 'gitdir'), 'utf8')
    await unlink(join(entry, 'gitdir'))
    await expect(f.service.inspect(ready)).rejects.toThrow()
    expect(await check(ready)).toBe('ask-git')
    await writeFile(join(entry, 'gitdir'), gitdir)
    expect(await check(ready)).toBe('ready')
    // A .git file that no longer points at Git's registry entry for this folder.
    // Windows will not open a hidden file for writing, so the .git file is replaced rather than rewritten.
    await unlink(join(ready.path!, '.git'))
    await writeFile(join(ready.path!, '.git'), `gitdir: ${join(f.root, 'elsewhere')}\n`)
    expect(await check(ready)).toBe('ask-git')
    // A folder that is gone.
    await removeTestCheckout(f.root, ready.path!)
    expect(await check(ready)).toBe('ask-git')
    expect(calls).toEqual([])
  })

  it('reads a shared project folder\'s branch from its files where Git would, and a plain folder as no repository', async () => {
    const f = await fixture()
    const files = new ThreadWorktrees(f.root, async () => { throw new Error('Git was asked') })
    const check = (record: AgentWorktree) => agrees(f.service, files, record)
    const shared = await f.service.inspect(await f.service.allocate(f.project, 'shared'))
    expect(await check(shared)).toBe('ready')
    expect(await files.readyOnDisk(shared)).toMatchObject({ worktree: { branch: shared.branch } })
    const plainFolder = join(f.root, 'plain'); await mkdir(plainFolder)
    const plain = await f.service.inspect(await f.service.allocate(plainFolder, 'shared'))
    expect(plain.repositoryRoot).toBeUndefined()
    expect(await check(plain)).toBe('ready')
    expect(await files.readyOnDisk(plain)).toMatchObject({ worktree: { branch: undefined } })
    // A plain folder that became a repository since it was inspected is Git's to read.
    await git(plainFolder, ['init'])
    expect(await files.readyOnDisk(plain)).toEqual({ kind: 'ask-git' })
    // A project folder that is now inside another repository than the one recorded.
    const other = await fixture()
    expect(await check({ ...shared, repositoryRoot: other.project })).toBe('ask-git')
  })
})
