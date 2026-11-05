// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

// The test prune is applied by manifest to a fresh main, so a rerun after main moves must find the same cases by their
// titles and leave nothing behind that lint or the typecheck would refuse (scripts/test-prune/apply.mjs).
const apply = join(process.cwd(), 'scripts/test-prune/apply.mjs')
const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const SAMPLE = `// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { kept, onlyGone } from './subject'

const fixture = readFileSync('x', 'utf8')
const helperForGone = () => onlyGone(fixture)

describe('subject', () => {
  it('keeps this one', () => {
    expect(kept()).toBe(1)
  })

  // Explains the case below.
  it('goes', () => {
    expect(helperForGone()).toBe(vi.fn())
  })

  it.each([[1, 'a'], [2, 'b'], [3, 'c']] as const)('row %i', (n, name) => {
    expect(n).toBeTruthy(); expect(name).toBeTruthy()
  })
})

describe('emptied', () => {
  for (const name of ['x', 'y']) {
    it(\`loops \${name}\`, () => {
      expect(name).toBeTruthy()
    })
  }
})
`

function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), 'sotto-test-prune-'))
  roots.push(root)
  mkdirSync(join(root, 'tests/fixtures'), { recursive: true })
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
  return root
}

describe('the test prune', () => {
  it('deletes cases and table rows by title, then what they alone used, and empties no suite it keeps', () => {
    const root = checkout({
      'tests/sample.test.ts': SAMPLE,
      'tests/whole.test.ts': "it('all of it', () => {})\n",
      'tests/fixtures/testDurations.json': JSON.stringify({ 'tests/sample.test.ts': 100, 'tests/whole.test.ts': 200 }, null, 2) + '\n',
    })
    const manifest = join(root, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ files: {
      'tests/sample.test.ts': { cases: [
        { suites: ["'subject'"], title: "'goes'", occurrence: 0 },
        { suites: ["'subject'"], title: "'row %i'", occurrence: 0, rows: ["[1, 'a']", "[3, 'c']"] },
        { suites: ["'emptied'"], title: '`loops ${name}`', occurrence: 0 },
      ] },
      'tests/whole.test.ts': { whole: true, cases: [{ suites: [], title: "'all of it'", occurrence: 0 }] },
    } }))

    expect(execFileSync(process.execPath, [apply, manifest], { cwd: root, encoding: 'utf8' })).toContain('0 listed cases not found')

    expect(readFileSync(join(root, 'tests/sample.test.ts'), 'utf8')).toBe(`// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { kept } from './subject'

describe('subject', () => {
  it('keeps this one', () => {
    expect(kept()).toBe(1)
  })

  it.each([[2, 'b']] as const)('row %i', (n, name) => {
    expect(n).toBeTruthy(); expect(name).toBeTruthy()
  })
})
`)
    expect(existsSync(join(root, 'tests/whole.test.ts'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'tests/fixtures/testDurations.json'), 'utf8'))).toEqual({ 'tests/sample.test.ts': 100 })
  })

  it('keeps a file marked whole once it holds a case the manifest does not list', () => {
    const root = checkout({ 'tests/whole.test.ts': "it('all of it', () => {})\nit('added since', () => {})\n" })
    const manifest = join(root, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ files: { 'tests/whole.test.ts': { whole: true, cases: [{ suites: [], title: "'all of it'", occurrence: 0 }] } } }))

    execFileSync(process.execPath, [apply, manifest], { cwd: root, encoding: 'utf8' })

    expect(readFileSync(join(root, 'tests/whole.test.ts'), 'utf8')).toBe("it('added since', () => {})\n")
  })

  it('refuses a table row that matches no row or more than one', () => {
    const table = "it.each([[1], [1], [2]])('row %i', n => { expect(n).toBeTruthy() })\n"
    const root = checkout({ 'tests/rows.test.ts': table })
    const manifest = join(root, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ files: { 'tests/rows.test.ts': { cases: [{ suites: [], title: "'row %i'", occurrence: 0, rows: ['[1]', '[9]'] }] } } }))

    const run = spawnSync(process.execPath, [apply, manifest, '--check'], { cwd: root, encoding: 'utf8' })

    expect(run.status).toBe(1)
    expect(run.stdout).toContain("rows      tests/rows.test.ts :: 'row %i'")
    expect(readFileSync(join(root, 'tests/rows.test.ts'), 'utf8')).toBe(table)
  })

  it('changes nothing with --check and fails when a listed case has been renamed', () => {
    const root = checkout({ 'tests/sample.test.ts': SAMPLE })
    const manifest = join(root, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ files: { 'tests/sample.test.ts': { cases: [{ suites: ["'subject'"], title: "'went'", occurrence: 0 }] } } }))

    const run = spawnSync(process.execPath, [apply, manifest, '--check'], { cwd: root, encoding: 'utf8' })

    expect(run.status).toBe(1)
    expect(run.stdout).toContain("missing   tests/sample.test.ts :: 'subject' > 'went'")
    expect(readFileSync(join(root, 'tests/sample.test.ts'), 'utf8')).toBe(SAMPLE)
  })
})
