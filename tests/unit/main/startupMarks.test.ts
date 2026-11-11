// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const root = resolve(__dirname, '../../..')

/** A fresh copy of the module, so each case starts from a launch that has reached nothing. */
async function freshMarks(e2e = true): Promise<typeof import('../../../src/main/performance/startupMarks')> {
  vi.resetModules()
  // A launch records startup marks only when it was started for an e2e run.
  if (e2e) vi.stubEnv('SOTTO_E2E', '1'); else vi.stubEnv('SOTTO_E2E', '')
  return import('../../../src/main/performance/startupMarks')
}

function sources(folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const path = `${folder}/${entry.name}`
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('startup marks', () => {
  beforeEach(() => { globalThis.sottoStartupMarksE2E = undefined })
  afterEach(() => { globalThis.sottoStartupMarksE2E = undefined; vi.unstubAllEnvs() })

  it('records nothing in an ordinary launch', async () => {
    const { markStartup, startupMarks, STARTUP_MARKS } = await freshMarks(false)
    for (const name of STARTUP_MARKS) markStartup(name)
    expect(startupMarks()).toEqual([])
  })

  it('keeps stable names in the order launch reaches them', async () => {
    const { STARTUP_MARKS } = await freshMarks()
    expect(STARTUP_MARKS).toEqual([
      'main-bundle-evaluated', 'app-ready', 'runtime-created', 'main-window-created', 'main-window-loaded',
      'widget-created', 'widget-loaded', 'main-window-shown', 'launch-finished',
    ])
  })

  it('records each mark once, in the order reached, on a clock that only moves forward', async () => {
    const { markStartup, startupMarks, STARTUP_MARKS } = await freshMarks()
    expect(startupMarks()).toEqual([])
    markStartup('main-bundle-evaluated')
    markStartup('app-ready')
    // A second window made later reaches the same point again; the first time is the launch's.
    markStartup('main-bundle-evaluated')
    for (const name of STARTUP_MARKS.slice(2)) markStartup(name)
    const marks = startupMarks()
    expect(marks.map(mark => mark.name)).toEqual(STARTUP_MARKS)
    for (const [index, mark] of marks.entries()) {
      expect(Number.isFinite(mark.atMs)).toBe(true)
      expect(mark.atMs).toBeGreaterThanOrEqual(index === 0 ? 0 : marks[index - 1]!.atMs)
      expect(Object.keys(mark).sort()).toEqual(['atMs', 'name'])
    }
  })

  it('keeps nothing once launch has finished', async () => {
    const { markStartup, startupMarks } = await freshMarks()
    markStartup('main-bundle-evaluated')
    markStartup('launch-finished')
    // Dictation was off at launch, so the widget is made on the first press.
    markStartup('widget-created')
    expect(startupMarks().map(mark => mark.name)).toEqual(['main-bundle-evaluated', 'launch-finished'])
  })

  it('hands out a copy, so a reader cannot change what launch recorded', async () => {
    const { markStartup, startupMarks } = await freshMarks()
    markStartup('app-ready')
    const read = startupMarks() as { name: string; atMs: number }[]
    read.length = 0
    expect(startupMarks()).toHaveLength(1)
  })

  it('cannot be read outside an e2e launch', async () => {
    const { markStartup } = await freshMarks()
    const { exposeStartupMarksForE2E } = await import('../../../src/main/e2e/startupMarks')
    markStartup('main-bundle-evaluated')
    expect(globalThis.sottoStartupMarksE2E).toBeUndefined()
    exposeStartupMarksForE2E(null)
    expect(globalThis.sottoStartupMarksE2E).toBeUndefined()
    exposeStartupMarksForE2E({ scenario: 'success', userDataPath: resolve('/sotto-e2e-profile') })
    expect(globalThis.sottoStartupMarksE2E?.read().map(mark => mark.name)).toEqual(['main-bundle-evaluated'])
  })

  it('is placed in main once for every name, and only the e2e hook reads it', () => {
    const marked = new Map<string, number>()
    const readers: string[] = []
    for (const path of sources('src/main')) {
      const text = readFileSync(join(root, path), 'utf8')
      for (const match of text.matchAll(/\bmarkStartup\('([a-z-]+)'\)/g)) marked.set(match[1]!, (marked.get(match[1]!) ?? 0) + 1)
      if (/import\s*\{[^}]*\bstartupMarks\b[^}]*\}/.test(text)) readers.push(path)
    }
    expect(readers).toEqual(['src/main/e2e/startupMarks.ts'])
    expect([...marked.keys()].sort()).toEqual([
      'main-bundle-evaluated', 'app-ready', 'runtime-created', 'main-window-created', 'main-window-loaded',
      'widget-created', 'widget-loaded', 'main-window-shown', 'launch-finished',
    ].sort())
    expect([...marked.values()].every(count => count === 1)).toBe(true)
  })
})
