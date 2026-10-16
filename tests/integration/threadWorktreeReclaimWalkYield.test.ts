// @vitest-environment node

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { periodicYield, runWorktreeGit as git, YIELD_INTERVAL } from '../../src/main/agents/threadWorktrees'
import { fixture } from '../fixtures/threadWorktreeFixture'

describe('periodicYield', () => {
  // A real setImmediate race is not the assertion (AGENTS.md: waiting is not the assertion, and a
  // fast, warm filesystem already hands the event loop a turn on every awaited fs call here, so a
  // single scheduled callback fires either way). Counting calls to the yield primitive itself is
  // the seam that tells the fix from its absence.
  it('gives the event loop a turn only every YIELD_INTERVAL call, not on every one', async () => {
    const immediate = vi.spyOn(global, 'setImmediate')
    const yieldPeriodically = periodicYield()
    for (let visited = 1; visited < YIELD_INTERVAL; visited++) {
      await yieldPeriodically()
      expect(immediate).not.toHaveBeenCalled()
    }
    await yieldPeriodically()
    expect(immediate).toHaveBeenCalledTimes(1)
    for (let visited = 0; visited < YIELD_INTERVAL - 1; visited++) {
      await yieldPeriodically()
      expect(immediate).toHaveBeenCalledTimes(1)
    }
    await yieldPeriodically()
    expect(immediate).toHaveBeenCalledTimes(2)
    immediate.mockRestore()
  })
})

describe('reclaim facts walk', () => {
  it('finds the same facts walking many dependency files as it did before yielding between them', async () => {
    const f = await fixture()
    const a = await f.service.ensure(await f.service.allocate(f.project, 'independent'))
    await writeFile(join(a.path!, '.gitignore'), 'node_modules/\nout/\n')
    await git(a.path!, ['add', '.gitignore'])
    await git(a.path!, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore dependencies'])
    await mkdir(join(a.path!, 'out'))
    await writeFile(join(a.path!, 'out', 'bundle.js'), 'build output')
    // More than one YIELD_INTERVAL of dependency entries, spread the way a real install nests
    // packages, plus one nested repository whose own ignored rows merge into the walk's ignored set.
    const packageRoot = join(a.path!, 'node_modules', 'big-package')
    await mkdir(packageRoot, { recursive: true })
    const fileCount = YIELD_INTERVAL * 3
    await Promise.all(Array.from({ length: fileCount }, (_, index) => writeFile(join(packageRoot, `file-${index}.js`), `module.exports = ${index}`)))
    const nested = join(a.path!, 'node_modules', 'nested.git')
    await mkdir(nested, { recursive: true })
    await git(nested, ['init', '--bare'])

    // The walk itself must hand the event loop a turn as it goes, not just the helper on its own.
    const immediate = vi.spyOn(global, 'setImmediate')
    const facts = await f.service.reclaimFacts(a)
    expect(immediate.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(fileCount / YIELD_INTERVAL))
    immediate.mockRestore()

    // Dependencies are walked for link inspection but never become a row of their own; the one
    // ignored folder outside them, and the nested repository's own ignored row, still do.
    expect(facts.ignored).toEqual(['node_modules/nested.git/', 'out/'])
    expect(facts.items).toEqual(expect.arrayContaining([{ path: 'out/', bytes: 'build output'.length, fileCount: 1 }]))
    expect(facts.items.find(item => item.path === 'node_modules/nested.git/')).toBeTruthy()
    expect(facts.repositories).toEqual([{ path: 'node_modules/nested.git/', changeCount: 0, unpushedCommitCount: 0, kind: 'repository' }])
    expect(facts.outsideLink).toBeUndefined()
    expect(facts.dirty).toBe(false)
  }, 60_000)
})
