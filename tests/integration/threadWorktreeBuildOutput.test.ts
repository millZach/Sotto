// @vitest-environment node

import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

describe('build output a cleanup rule may remove (ADR-0041)', () => {
  it('removes a folder whose only ignored files are dependencies and folders the repository marks as build output', async () => {
    const { service, a } = await worktreeWith('node_modules/\nout/\nnative/*/build/\n', '/out sotto-build-output\n/native/tool/build sotto-build-output\n')
    await put(join(a.path!, 'out', 'main'), 'index.js')
    await put(join(a.path!, 'native', 'tool', 'build'), 'listener')
    const facts = await service.reclaimFacts(a)
    // Remove worktree and Delete thread… still list them for the user to tick.
    expect(facts.ignored).toEqual(['native/tool/build/', 'out/'])
    expect(await service.ruleKeptIgnored(facts.path, facts.ignored)).toEqual([])
    expect((await service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
    await expect(lstat(a.path!)).rejects.toThrow()
  })

  it('removes a folder whose build output its tool tagged with a valid CACHEDIR.TAG', async () => {
    const { service, a } = await worktreeWith('node_modules/\n.build/\n')
    await put(join(a.path!, '.build'), 'CACHEDIR.TAG', `${SIGNATURE}\n# This file is a cache directory tag created by swift-build.\n`)
    await put(join(a.path!, '.build', 'debug'), 'tool')
    expect(await service.ruleKeptIgnored(a.path!, (await service.reclaimFacts(a)).ignored)).toEqual([])
    expect((await service.reclaim(a, { automatic: true })).reclaimedAt).toBeTruthy()
    await expect(lstat(a.path!)).rejects.toThrow()
  })

  it('keeps a folder whose CACHEDIR.TAG is missing, is a folder, or does not begin with the signature', async () => {
    const { service, a } = await worktreeWith('node_modules/\n.build/\ntarget/\nempty/\nnested/\n')
    await put(join(a.path!, '.build'), 'CACHEDIR.TAG', SIGNATURE.slice(0, -1))
    await put(join(a.path!, 'target'), 'CACHEDIR.TAG', `signature: 8a477f597d28d172789f06886806bc55\n`)
    await put(join(a.path!, 'empty'), 'artifact.bin')
    await put(join(a.path!, 'nested', 'CACHEDIR.TAG'), 'inside', SIGNATURE)
    expect(await service.ruleKeptIgnored(a.path!, (await service.reclaimFacts(a)).ignored)).toEqual(['.build/', 'empty/', 'nested/', 'target/'])
    await expect(service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies and build output')
    expect(await readFile(join(a.path!, 'empty', 'artifact.bin'), 'utf8')).toBe('built')
  })

  it('keeps a folder holding any other ignored file beside marked build output, or a mark in another form', async () => {
    const { service, a } = await worktreeWith('node_modules/\nout/\n.env\nlocal/\nunset/\nvalued/\ncontents/\n',
      '/out sotto-build-output\n/unset -sotto-build-output\n/valued sotto-build-output=true\n/contents/** sotto-build-output\n')
    await put(join(a.path!, 'out'), 'index.js')
    await writeFile(join(a.path!, '.env'), 'keep this secret')
    for (const folder of ['local', 'unset', 'valued', 'contents']) await put(join(a.path!, folder), 'data.txt')
    expect(await service.ruleKeptIgnored(a.path!, (await service.reclaimFacts(a)).ignored)).toEqual(['.env', 'contents/', 'local/', 'unset/', 'valued/'])
    await expect(service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies and build output')
    expect(await readFile(join(a.path!, '.env'), 'utf8')).toBe('keep this secret')
  })

  it('keeps a repository inside a marked or tagged folder', async () => {
    const { service, a } = await worktreeWith('node_modules/\nout/\n.build/\n', '/out sotto-build-output\n')
    await put(join(a.path!, '.build'), 'CACHEDIR.TAG', SIGNATURE)
    for (const folder of ['out', '.build']) {
      await mkdir(join(a.path!, folder, 'work'), { recursive: true }); await git(join(a.path!, folder, 'work'), ['init'])
      await writeFile(join(a.path!, folder, 'work', 'notes.txt'), 'only here')
    }
    expect((await service.reclaimFacts(a)).repositories.map(item => item.path)).toEqual(['.build/work/', 'out/work/'])
    await expect(service.reclaim(a, { automatic: true })).rejects.toThrow('besides installed dependencies and build output')
    expect(await readFile(join(a.path!, 'out', 'work', 'notes.txt'), 'utf8')).toBe('only here')
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
