// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTreeUnchanged, compareTreeStamps, snapshotTree } from '../../../scripts/omarchy-shell-sandbox.mjs'

// The nested-desktop proofs check that the live trees they protect are unchanged. Comparing two snapshots of a large
// tree with a deep equality built a diff that ran forge out of memory (#1802); the comparison now counts and names a few.
const entry = (path, mtimeMs = 1, content = 'a') => [path, 1, 1, 1, mtimeMs, content]

describe('compareTreeStamps', () => {
  it('finds nothing between equal snapshots', () => {
    const stamps = [entry('/t'), entry('/t/a'), entry('/t/b')]
    expect(compareTreeStamps(stamps, stamps.map(row => [...row]))).toEqual({ count: 0, paths: [] })
  })

  it('counts added, removed and changed paths and names only the first few', () => {
    const before = [entry('/t'), entry('/t/a'), entry('/t/b'), entry('/t/c'), entry('/t/gone')]
    const after = [entry('/t'), entry('/t/a', 2), entry('/t/b', 1, 'b'), entry('/t/c'), entry('/t/new')]
    expect(compareTreeStamps(before, after)).toEqual({ count: 4, paths: ['/t/a', '/t/b', '/t/gone', '/t/new'] })
    expect(compareTreeStamps(before, after, 2)).toEqual({ count: 4, paths: ['/t/a', '/t/b'] })
  })

  it('reports a large tree with many changes in a few paths', () => {
    const name = index => `/t/${String(index).padStart(6, '0')}`
    const before = Array.from({ length: 200_000 }, (_, index) => entry(name(index)))
    const after = before.map((row, index) => index % 1_000 === 0 ? entry(row[0], 2) : row)
    const result = compareTreeStamps(before, after)
    expect(result.count).toBe(200)
    expect(result.paths).toEqual([0, 1_000, 2_000, 3_000, 4_000].map(name))
  })

  it('walks paths in the order snapshotTree visits them, a folder before its contents', () => {
    // Whole-string order would put "a.b" before "a/x"; the walk visits "a", then "a/x", then "a.b".
    const before = [entry('/t'), entry('/t/a'), entry('/t/a/x'), entry('/t/a.b')]
    expect(compareTreeStamps(before, before.map(row => [...row]))).toEqual({ count: 0, paths: [] })
    const after = [entry('/t'), entry('/t/a'), entry('/t/a/x'), entry('/t/a/y'), entry('/t/a.b')]
    expect(compareTreeStamps(before, after)).toEqual({ count: 1, paths: ['/t/a/y'] })
  })
})

describe('assertTreeUnchanged', () => {
  let root = ''
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it('passes an untouched tree and names what changed in one line otherwise', () => {
    root = mkdtempSync(join(tmpdir(), 'tree-stamps-'))
    for (const name of ['a', 'b', 'c']) writeFileSync(join(root, name), name)
    const before = snapshotTree(root)
    expect(() => assertTreeUnchanged(root, before)).not.toThrow()
    writeFileSync(join(root, 'a'), 'changed')
    writeFileSync(join(root, 'd'), 'new')
    expect(() => assertTreeUnchanged(root, before)).toThrow(`${root} changed: 3 paths differ, first ${root}, ${join(root, 'a')}, ${join(root, 'd')}`)
  })
})
