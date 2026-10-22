// @vitest-environment node

import type * as fs from 'node:fs/promises'
import { lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runWorktreeGit as git, YIELD_INTERVAL } from '../../src/main/agents/threadWorktrees'
import { fixture } from '../fixtures/threadWorktreeFixture'

// Every file-system call the reclaim walk can make, counted only while `calls.on` is set, so the
// fixture's own setup and the test's independent recount stay out of the numbers.
// `listed` is how many entries the walk's readdir calls returned between them.
const calls = vi.hoisted(() => ({ on: false, counts: {} as Record<string, number>, listed: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>()
  const counted = <F extends (...args: never[]) => unknown>(name: string, call: F): F => ((...args: Parameters<F>) => {
    if (calls.on) calls.counts[name] = (calls.counts[name] ?? 0) + 1
    return call(...args)
  }) as F
  const listing = counted('readdir', actual.readdir)
  const readdir = (async (...args: Parameters<typeof actual.readdir>) => {
    const on = calls.on
    const entries = await (listing as (...args: Parameters<typeof actual.readdir>) => Promise<unknown[]>)(...args)
    if (on) calls.listed += entries.length
    return entries
  }) as typeof actual.readdir
  return {
    ...actual,
    lstat: counted('lstat', actual.lstat), stat: counted('stat', actual.stat), opendir: counted('opendir', actual.opendir),
    readdir, readlink: counted('readlink', actual.readlink),
    realpath: counted('realpath', actual.realpath), readFile: counted('readFile', actual.readFile),
  }
})

async function counting<T>(read: () => Promise<T>): Promise<{ result: T; counts: Record<string, number>; listed: number }> {
  calls.counts = {}; calls.listed = 0; calls.on = true
  try { return { result: await read(), counts: calls.counts, listed: calls.listed } } finally { calls.on = false }
}

/** Files under `root` and their sizes, read independently of the walk under test. */
async function recount(root: string): Promise<{ bytes: number; fileCount: number }> {
  let bytes = 0; let fileCount = 0
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue
    bytes += (await lstat(join(entry.parentPath, entry.name))).size; fileCount++
  }
  return { bytes, fileCount }
}

async function addPackages(dependencies: string, from: number, count: number): Promise<void> {
  for (let index = from; index < from + count; index++) {
    const lib = join(dependencies, `package-${index}`, 'lib')
    await mkdir(lib, { recursive: true })
    await writeFile(join(dependencies, `package-${index}`, 'package.json'), `{"name":"package-${index}"}`)
    await Promise.all(Array.from({ length: 6 }, (_, file) => writeFile(join(lib, `file-${file}.js`), `module.exports = ${file}`)))
  }
}

describe('reclaim facts walk calls', () => {
  it('reads dependencies without an lstat for every file, and finds the same facts', async () => {
    const f = await fixture()
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'node_modules/\nout/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore dependencies'])
    await mkdir(join(a.path!, 'out'))
    await writeFile(join(a.path!, 'out', 'bundle.js'), 'build output')
    const dependencies = join(a.path!, 'node_modules')
    await addPackages(dependencies, 0, 20)
    // A link that stays inside the folder, and one that leads out of it.
    await symlink(join(dependencies, 'package-0'), join(dependencies, 'inside-link'), 'junction')
    const shared = join(f.root, 'shared-deps'); await mkdir(shared); await writeFile(join(shared, 'keep.txt'), 'real install')
    await symlink(shared, join(dependencies, 'outside-link'), 'junction')
    // Nested repositories inside dependencies: a bare one and one with a working tree and a change.
    const bare = join(dependencies, 'nested.git'); await mkdir(bare); await git(bare, ['init', '--bare'])
    const checkout = join(dependencies, 'git-dependency'); await mkdir(checkout); await git(checkout, ['init'])
    await writeFile(join(checkout, 'work.txt'), 'uncommitted')

    const first = await counting(() => f.service.reclaimFacts(a))
    const facts = first.result
    expect(facts.outsideLink).toBe('node_modules/outside-link')
    expect(facts.dirty).toBe(false)
    expect(facts.ignored).toEqual(['node_modules/git-dependency/', 'node_modules/nested.git/', 'out/'])
    expect(facts.repositories).toEqual([
      { path: 'node_modules/git-dependency/', changeCount: 1, unpushedCommitCount: 0, kind: 'repository' },
      { path: 'node_modules/nested.git/', changeCount: 0, unpushedCommitCount: 0, kind: 'repository' },
    ])
    // Each nested repository's row holds every file under it, its Git metadata included, as an
    // independent recount finds them; the build output's row holds its one file.
    expect([...facts.items].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'node_modules/git-dependency/', ...await recount(checkout) },
      { path: 'node_modules/nested.git/', ...await recount(bare) },
      { path: 'out/', bytes: 'build output'.length, fileCount: 1 },
    ])

    // More dependencies change no fact. Each package adds an lstat for its folder and its lib, which are
    // read before they are entered, and at most one for its package.json, which is read when it is listed
    // after lib; lib's six files are taken from lib's listing. A directory's .git, HEAD and objects are read
    // from its own listing too. Each turn the walk gives the event loop can add an lstat for the files left
    // in the folder it lands in, and no folder here holds 32.
    await addPackages(dependencies, 20, 40)
    const second = await counting(() => f.service.reclaimFacts(a))
    expect(second.result).toEqual(facts)
    const lstats = second.counts.lstat! - first.counts.lstat!
    expect(lstats).toBeGreaterThanOrEqual(40 * 2)
    expect(lstats).toBeLessThanOrEqual(40 * 3 + 32 * Math.ceil(second.listed / YIELD_INTERVAL))
    // Each directory added (a package and its lib) is listed once, and once more when the walk waited on
    // anything after listing it (a package, for its lib).
    const listings = (counts: Record<string, number>) => (counts.readdir ?? 0) + (counts.opendir ?? 0)
    const added = listings(second.counts) - listings(first.counts)
    expect(added).toBeGreaterThanOrEqual(40 * 2)
    expect(added).toBeLessThanOrEqual(40 * 2 * 2)
    // Nothing else is read for them.
    const total = (counts: Record<string, number>) => Object.values(counts).reduce((sum, count) => sum + count, 0)
    expect(total(second.counts) - total(first.counts)).toBe(added + lstats)
  }, 120_000)

  it('reads a large flat dependency folder a bounded number of times, not once more for every turn of the event loop', async () => {
    const f = await fixture()
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'node_modules/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore dependencies'])
    // Many times the walk's yield interval, so a cost per turn of the event loop shows as growth.
    const flat = join(a.path!, 'node_modules', 'flat'); await mkdir(flat, { recursive: true })
    const fileCount = 4096
    for (let from = 0; from < fileCount; from += 256) {
      await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(flat, `file-${from + index}.js`), '')))
    }

    const walk = await counting(() => f.service.reclaimFacts(a))
    expect(walk.result.ignored).toEqual([])
    expect(walk.result.outsideLink).toBeUndefined()
    // Every entry listed and every lstat, the folder's own and the worktree's few included, stay
    // within a small multiple of the folder's files.
    expect(walk.listed + walk.counts.lstat!).toBeLessThanOrEqual(3 * fileCount)
  }, 120_000)

  it('still counts dependencies and a nested repository inside an ignored folder in that folder’s row', async () => {
    const f = await fixture()
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'node_modules/\nout/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore build output'])
    const out = join(a.path!, 'out')
    await mkdir(join(out, 'sub', 'node_modules', 'package'), { recursive: true })
    await writeFile(join(out, 'one.bin'), 'abcdef'); await writeFile(join(out, 'sub', 'two.bin'), 'ghi')
    await writeFile(join(out, 'sub', 'node_modules', 'package', 'index.js'), 'a dependency inside an ignored folder')
    const inner = join(out, 'inner'); await mkdir(inner); await git(inner, ['init']); await writeFile(join(inner, 'notes.txt'), 'nested')
    await addPackages(join(a.path!, 'node_modules'), 0, 3)

    const facts = await f.service.reclaimFacts(a)
    expect(facts.ignored).toEqual(['out/', 'out/inner/'])
    expect(facts.repositories).toEqual([{ path: 'out/inner/', changeCount: 1, unpushedCommitCount: 0, kind: 'repository' }])
    // The folder's row holds everything under it, the nested repository and the dependencies inside it
    // included, and the nested repository's row holds everything under that, as an independent recount finds.
    expect(facts.items).toEqual([{ path: 'out/', ...await recount(out) }, { path: 'out/inner/', ...await recount(inner) }])
  }, 120_000)
})
