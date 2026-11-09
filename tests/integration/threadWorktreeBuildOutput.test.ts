// @vitest-environment node

import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILD_OUTPUT_ATTRIBUTE, runWorktreeGit as git, ThreadWorktrees, type RunGit } from '../../src/main/agents/threadWorktrees'
import { fixture } from '../fixtures/threadWorktreeFixture'

const SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55'

/** A thread's worktree whose committed `.gitignore` and `.gitattributes` are these, with `native/tool/` tracked. */
async function worktreeWith(gitignore: string, gitattributes = '') {
  const f = await fixture(); const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
  await writeFile(join(a.path!, '.gitignore'), gitignore)
  if (gitattributes) await writeFile(join(a.path!, '.gitattributes'), gitattributes)
  await mkdir(join(a.path!, 'native', 'tool'), { recursive: true }); await writeFile(join(a.path!, 'native', 'tool', 'main.swift'), '')
  await git(a.path!, ['add', '.'])
  await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore build output'])
  await mkdir(join(a.path!, 'node_modules', 'dep'), { recursive: true }); await writeFile(join(a.path!, 'node_modules', 'dep', 'index.js'), '')
  return { ...f, a }
}
async function put(folder: string, file: string, text = 'built') {
  await mkdir(folder, { recursive: true }); await writeFile(join(folder, file), text)
}
const commit = (cwd: string, message: string) => git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message])
/**
 * A tagged `folder` as SwiftPM leaves `.build/`: a mirror of a dependency whose remote is elsewhere, every ref packed,
 * and a clone of that mirror on a detached release tag. `upstream`, outside the worktree, stands for the remote.
 */
async function swiftBuild(root: string, worktree: string, folder = '.build') {
  const build = join(worktree, folder), upstream = join(root, 'upstream'), mirror = join(build, 'repositories', 'dep-08d244c7'), checkout = join(build, 'checkouts', 'dep')
  await mkdir(upstream); await git(upstream, ['init'])
  await writeFile(join(upstream, 'Package.swift'), ''); await git(upstream, ['add', '.']); await commit(upstream, 'Dependency'); await git(upstream, ['tag', 'v1'])
  await put(build, 'CACHEDIR.TAG', `${SIGNATURE}\n`)
  await mkdir(join(build, 'repositories'), { recursive: true }); await git(join(build, 'repositories'), ['clone', '--mirror', upstream, 'dep-08d244c7'])
  await git(mirror, ['remote', 'set-url', 'origin', 'https://example.invalid/dep.git'])
  await mkdir(join(build, 'checkouts'), { recursive: true }); await git(join(build, 'checkouts'), ['clone', mirror, 'dep'])
  await git(checkout, ['checkout', '--detach', 'v1'])
  return { checkout, mirror, upstream }
}
/** What a rule keeps in the worktree, asked as `reclaim` asks it. */
async function kept(service: ThreadWorktrees, worktree: Parameters<ThreadWorktrees['reclaimFacts']>[0]) {
  const facts = await service.reclaimFacts(worktree)
  return service.ruleKeptIgnored(facts.path, facts.ignored, facts.repositories)
}

describe('build output a cleanup rule may remove (ADR-0041)', () => {
  it('removes a folder whose only ignored files are dependencies and folders the repository marks as build output', async () => {
    const { service, a } = await worktreeWith('node_modules/\nout/\nnative/*/build/\n', '/out sotto-build-output\n/native/tool/build sotto-build-output\n')
    await put(join(a.path!, 'out', 'main'), 'index.js')
    await put(join(a.path!, 'native', 'tool', 'build'), 'listener')
    const facts = await service.reclaimFacts(a)
    // Remove worktree and Delete thread… still list them for the user to tick.
    expect(facts.ignored).toEqual(['native/tool/build/', 'out/'])
    expect(await service.ruleKeptIgnored(facts.path, facts.ignored, facts.repositories)).toEqual([])
    expect((await service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
    await expect(lstat(a.path!)).rejects.toThrow()
  })

  it('removes a folder whose build output its tool tagged with a valid CACHEDIR.TAG', async () => {
    const { service, a } = await worktreeWith('node_modules/\n.build/\n')
    await put(join(a.path!, '.build'), 'CACHEDIR.TAG', `${SIGNATURE}\n# This file is a cache directory tag created by swift-build.\n`)
    await put(join(a.path!, '.build', 'debug'), 'tool')
    expect(await kept(service, a)).toEqual([])
    expect((await service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
    await expect(lstat(a.path!)).rejects.toThrow()
  })

  it('keeps a folder whose CACHEDIR.TAG is missing, is a folder, or does not begin with the signature', async () => {
    const { service, a } = await worktreeWith('node_modules/\n.build/\ntarget/\nempty/\nnested/\n')
    await put(join(a.path!, '.build'), 'CACHEDIR.TAG', SIGNATURE.slice(0, -1))
    await put(join(a.path!, 'target'), 'CACHEDIR.TAG', `signature: 8a477f597d28d172789f06886806bc55\n`)
    await put(join(a.path!, 'empty'), 'artifact.bin')
    await put(join(a.path!, 'nested', 'CACHEDIR.TAG'), 'inside', SIGNATURE)
    expect(await kept(service, a)).toEqual(['.build/', 'empty/', 'nested/', 'target/'])
    await expect(service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies and build output')
    expect(await readFile(join(a.path!, 'empty', 'artifact.bin'), 'utf8')).toBe('built')
  })

  it('keeps a folder holding any other ignored file beside marked build output, or a mark in another form', async () => {
    const { service, a } = await worktreeWith('node_modules/\nout/\n.env\nlocal/\nunset/\nvalued/\ncontents/\n',
      '/out sotto-build-output\n/unset -sotto-build-output\n/valued sotto-build-output=true\n/contents/** sotto-build-output\n')
    await put(join(a.path!, 'out'), 'index.js')
    await writeFile(join(a.path!, '.env'), 'keep this secret')
    for (const folder of ['local', 'unset', 'valued', 'contents']) await put(join(a.path!, folder), 'data.txt')
    expect(await kept(service, a)).toEqual(['.env', 'contents/', 'local/', 'unset/', 'valued/'])
    await expect(service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies and build output')
    expect(await readFile(join(a.path!, '.env'), 'utf8')).toBe('keep this secret')
  })

  // SwiftPM keeps a mirror of each dependency and a clone of it in `.build/`, which it tags and Sotto also marks. The
  // mirror's commits are on no remote-tracking ref, and the clone's only remote is the mirror beside it.
  it.each([['tagged', ''], ['marked and tagged', '/.build sotto-build-output\n']])('removes a folder whose %s cache holds its tool’s own repositories, untouched', async (_, gitattributes) => {
    const { root, service, a } = await worktreeWith('node_modules/\n.build/\n', gitattributes)
    const { checkout } = await swiftBuild(root, a.path!)
    const facts = await service.reclaimFacts(a)
    expect(facts.repositories.map(item => [item.path, item.changeCount])).toEqual([['.build/checkouts/dep/', 0], ['.build/repositories/dep-08d244c7/', 0]])
    expect(await service.ruleKeptIgnored(facts.path, facts.ignored, facts.repositories)).toEqual([])
    expect((await service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
    await expect(lstat(checkout)).rejects.toThrow()
    await expect(lstat(a.path!)).rejects.toThrow()
  })

  const fix = async (checkout: string) => { await writeFile(join(checkout, 'Package.swift'), '// a fix tried in place'); await git(checkout, ['add', '.']); await commit(checkout, 'A fix') }
  it.each<[string, (made: { root: string; worktree: string; checkout: string; mirror: string }) => Promise<unknown>]>([
    ['an uncommitted change', ({ checkout }) => writeFile(join(checkout, 'Package.swift'), '// a fix tried in place')],
    ['a commit', ({ checkout }) => fix(checkout)],
    ['a commit pushed to the mirror beside it', async ({ checkout }) => { await git(checkout, ['checkout', '-b', 'fix']); await fix(checkout); await git(checkout, ['push', 'origin', 'fix']) }],
    ['a commit under a tag made there', async ({ checkout }) => { await fix(checkout); await git(checkout, ['tag', 'my-fix']); await git(checkout, ['checkout', '--detach', 'v1']) }],
    ['a stash', async ({ checkout }) => { await writeFile(join(checkout, 'Package.swift'), '// a fix tried in place'); await git(checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'stash']) }],
    ['a linked worktree inside the folder', ({ worktree, checkout }) => git(checkout, ['worktree', 'add', '-b', 'side', join(worktree, '.build', 'side')])],
    ['a linked worktree outside it', ({ root, checkout }) => git(checkout, ['worktree', 'add', '-b', 'side', join(root, 'side')])],
    ['history kept for a submodule', async ({ checkout }) => { await mkdir(join(checkout, '.git', 'modules', 'sub'), { recursive: true }); await git(join(checkout, '.git', 'modules', 'sub'), ['init', '--bare']) }],
    ['a commit pushed into its mirror from a clone since removed', async ({ root, mirror }) => {
      await git(root, ['clone', mirror, 'other']); await git(join(root, 'other'), ['checkout', '-b', 'fix']); await fix(join(root, 'other'))
      await git(join(root, 'other'), ['push', 'origin', 'fix']); await rm(join(root, 'other'), { recursive: true, force: true })
    }],
    ['a mirror whose remote is a path', ({ mirror, root }) => git(mirror, ['remote', 'set-url', 'origin', join(root, 'upstream')])],
    ['a second remote on its mirror', ({ mirror }) => git(mirror, ['remote', 'add', 'mine', 'https://example.invalid/mine.git'])],
    ['a mirror not set up as one', ({ mirror }) => git(mirror, ['config', '--unset', 'remote.origin.mirror'])],
    ['a clone of the clone', ({ checkout }) => git(join(checkout, '..'), ['clone', checkout, 'again'])],
    ['lost its tag, though the repository marks it', ({ worktree }) => rm(join(worktree, '.build', 'CACHEDIR.TAG'))],
  ])('keeps a cache whose repository has %s', async (_, work) => {
    const { root, service, a } = await worktreeWith('node_modules/\n.build/\n', '/.build sotto-build-output\n')
    const { checkout, mirror } = await swiftBuild(root, a.path!)
    await work({ root, worktree: a.path!, checkout, mirror })
    expect(await kept(service, a)).not.toEqual([])
    await expect(service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies and build output')
    await expect(lstat(join(checkout, 'Package.swift'))).resolves.toBeTruthy()
  })

  it('keeps a mirror alone in a folder the repository only marks', async () => {
    const { root, service, a } = await worktreeWith('node_modules/\n.build/\n', '/.build sotto-build-output\n')
    const { checkout } = await swiftBuild(root, a.path!)
    await rm(checkout, { recursive: true, force: true }); await rm(join(a.path!, '.build', 'CACHEDIR.TAG'))
    expect(await kept(service, a)).toEqual(['.build/repositories/dep-08d244c7/'])
  })

  it('keeps a bare repository of the user’s own in a tagged cache, a row whose folder is gone, and a clone swapped for a link', async () => {
    const { root, service, a } = await worktreeWith('node_modules/\n.build/\n')
    const { checkout } = await swiftBuild(root, a.path!)
    // The only copy of a commit: pushed in from a clone since removed, with no remote of its own.
    await mkdir(join(a.path!, '.build', 'mine.git')); await git(join(a.path!, '.build', 'mine.git'), ['init', '--bare'])
    expect(await kept(service, a)).toEqual(['.build/mine.git/'])
    await rm(join(a.path!, '.build', 'mine.git'), { recursive: true, force: true })
    const facts = await service.reclaimFacts(a)
    expect(await service.ruleKeptIgnored(facts.path, facts.ignored, [...facts.repositories, { path: '.build/gone/', changeCount: 0, kind: 'repository' }])).toEqual(['.build/gone/'])
    // Read after the walk, the clone is now a link to a repository outside the folder.
    await rename(checkout, join(root, 'moved')); await symlink(join(root, 'moved'), checkout, 'junction')
    expect(await service.ruleKeptIgnored(facts.path, facts.ignored, facts.repositories)).toEqual(['.build/checkouts/dep/'])
  })

  it('keeps a repository at a marked path, inside a folder that is only marked, and one that is itself the tagged folder', async () => {
    const { service, a } = await worktreeWith('node_modules/\nout/\nrelease/\nvendor/\n', '/out sotto-build-output\n/release sotto-build-output\n')
    // A clone someone works in at the very path the repository marks.
    await mkdir(join(a.path!, 'release')); await git(join(a.path!, 'release'), ['init']); await writeFile(join(a.path!, 'release', 'notes.txt'), 'only here')
    await mkdir(join(a.path!, 'out', 'mirror'), { recursive: true }); await git(join(a.path!, 'out', 'mirror'), ['init', '--bare'])
    // A bare repository has nothing uncommitted, so only its being the tagged folder itself keeps it.
    await mkdir(join(a.path!, 'vendor')); await git(join(a.path!, 'vendor'), ['init', '--bare'])
    await put(join(a.path!, 'vendor'), 'CACHEDIR.TAG', SIGNATURE)
    const facts = await service.reclaimFacts(a)
    expect(facts.repositories.map(item => [item.path, item.changeCount])).toEqual([['out/mirror/', 0], ['release/', 1], ['vendor/', 0]])
    expect(await service.ruleKeptIgnored(facts.path, facts.ignored, facts.repositories)).toEqual(['out/mirror/', 'release/', 'vendor/'])
    await expect(service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies and build output')
    expect(await readFile(join(a.path!, 'release', 'notes.txt'), 'utf8')).toBe('only here')
  })

  // The mark is in the repository's own .git/info/attributes, which reaches its linked worktrees, so losing it leaves the
  // worktree clean and only the check in the registry lane can see it.
  it.each(['mark', 'tag'] as const)('asks again just before the lock, so a %s lost after the first check keeps the folder', async lost => {
    const { root, project, a } = await worktreeWith('node_modules/\nout/\n.build/\n')
    const info = join(project, '.git', 'info', 'attributes')
    await put(join(project, '.git', 'info'), 'attributes', '/out sotto-build-output\n')
    await put(join(a.path!, 'out'), 'index.js')
    await put(join(a.path!, '.build'), 'CACHEDIR.TAG', SIGNATURE)
    let asked = 0
    const racing: RunGit = async (cwd, args, options) => {
      if (args[0] === 'check-attr' && ++asked === 2) await (lost === 'mark' ? writeFile(info, '') : rm(join(a.path!, '.build', 'CACHEDIR.TAG')))
      return git(cwd, args, options)
    }
    await expect(new ThreadWorktrees(root, racing).reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies and build output')
    expect(asked).toBe(2)
    expect(await readFile(join(a.path!, 'out', 'index.js'), 'utf8')).toBe('built')
  })

  it('marks every build folder Sotto ignores in its own checkout', async () => {
    for (const folder of ['out/', 'release/', 'native/coreml-asr/.build/', 'native/key-listener/build/']) {
      expect((await git(process.cwd(), ['check-attr', BUILD_OUTPUT_ATTRIBUTE, '--', folder])).trim()).toBe(`${folder}: ${BUILD_OUTPUT_ATTRIBUTE}: set`)
      expect((await git(process.cwd(), ['check-ignore', '--', folder])).trim()).toBe(folder)
    }
  })
})
