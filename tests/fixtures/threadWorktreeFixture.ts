// @vitest-environment node

import { initializeGitRepository } from './gitRepository'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect } from 'vitest'
import { runWorktreeGit as git, ThreadWorktrees } from '../../src/main/agents/threadWorktrees'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-worktree-test-')) throw new Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
export async function fixture(commit = true) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-worktree-test-')); roots.push(root)
  const project = join(root, 'project'); await mkdir(project)
  if (commit) await initializeGitRepository(project, { files: { 'tracked.txt': 'committed baseline' } })
  else await git(project, ['init']) // This scenario deliberately has no initial commit.
  return { root, project, service: new ThreadWorktrees(root) }
}
export async function submoduleHistoryFixture(reference: 'branch' | 'tag' | 'no-remote' | 'deinitialized-branch' | 'deinitialized-tag' = 'branch', moduleName = 'module') {
  const f = await fixture()
  const origin = join(f.root, 'module-origin'); await mkdir(origin)

  await writeFile(join(origin, 'module.txt'), 'published baseline')

  await initializeGitRepository(origin, { files: {}, message: "Module baseline", identity: { name: "Fixture", email: "fixture@example.invalid" } })
  await git(f.project, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', moduleName, origin, 'module'])
  await git(f.project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'Add module'])
  const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
  await git(a.path!, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'])
  const module = join(a.path!, 'module')
  const recorded = (await git(module, ['rev-parse', 'HEAD'])).trim()
  const gitDirectory = (await git(module, ['rev-parse', '--absolute-git-dir'])).trim()
  await git(module, ['checkout', '-b', 'private'])
  await writeFile(join(module, 'private.txt'), 'local-only history')
  await git(module, ['add', '.'])
  await git(module, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Private module work'])
  const privateCommit = (await git(module, ['rev-parse', 'HEAD'])).trim()
  if (reference === 'tag' || reference === 'deinitialized-tag') await git(module, ['tag', 'private-save'])
  await git(module, ['checkout', '--detach', recorded])
  if (reference === 'tag' || reference === 'deinitialized-tag') await git(module, ['branch', '-D', 'private'])
  if (reference === 'no-remote') await git(module, ['remote', 'remove', 'origin'])
  if (reference.startsWith('deinitialized-')) await git(a.path!, ['submodule', 'deinit', '--', 'module'])
  return { ...f, a, module, gitDirectory, privateCommit }
}
/** Removes only a test-owned checkout under the fixture root; the production implementation has no removal path. */
export async function removeTestCheckout(root: string, path: string) {
  expect(resolve(path).startsWith(resolve(root) + '\\') || resolve(path).startsWith(resolve(root) + '/')).toBe(true)
  await rm(path, { recursive: true })
}
