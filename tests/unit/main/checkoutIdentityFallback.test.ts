// @vitest-environment node
/**
 * A checkout's identity when its files do not answer (issue #766): `checkoutIdentity` reads the `.git` entries on
 * disk first, and asks Git only when the file system will not say, then falls back to the nearest `.git` marker when
 * Git refuses, as it does for a repository its ownership checks reject.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkoutIdentity, runWorktreeGit as git } from '../../../src/main/agents/threadWorktrees'

/** While set, `stat` of any `.git` entry fails as a folder the process may not read does. */
const refuse = vi.hoisted(() => ({ gitEntries: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const stat = (async (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
    if (refuse.gitEntries && typeof path === 'string' && basename(path) === '.git') throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    return (actual.stat as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.stat
  return { ...actual, stat, default: { ...actual, stat } }
})

const roots: string[] = []
afterEach(async () => {
  refuse.gitEntries = false
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('sotto-identity-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

describe('a checkout identity the files do not settle', () => {
  it('asks Git, and groups a subfolder with its repository by the .git marker when Git refuses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-identity-')); roots.push(root)
    const project = join(root, 'project'); await mkdir(project)
    await git(project, ['init'])
    const nested = join(project, 'nested'); await mkdir(nested)
    refuse.gitEntries = true
    const asked: string[][] = []
    const answering = async (cwd: string, args: string[]) => { asked.push(args); return git(cwd, args) }
    expect(await checkoutIdentity(nested, answering)).toBe(key(await realpath(project)))
    expect(asked).toEqual([['rev-parse', '--show-toplevel']])
    const refused = async () => { throw new Error('fatal: detected dubious ownership in repository') }
    expect(await checkoutIdentity(nested, refused)).toBe(await checkoutIdentity(project, refused))
  })
})
