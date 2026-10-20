// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatcherStateStore } from '../../../src/main/agents/watcherState'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'sotto-watcher-state-'))
  folders.push(made)
  return made
}

it('keeps both lists when two keep_state calls come at once', async () => {
  const store = new WatcherStateStore(await folder(), () => true)
  await Promise.all([store.keep({ decisions: ['Merge #1186?'] }, '2026-10-19T10:00:00.000Z'), store.keep({ rules: ['Suites run in CI.'] }, '2026-10-19T10:00:00.000Z')])
  expect(store.read()).toMatchObject({ decisions: ['Merge #1186?'], rules: ['Suites run in CI.'], issues: [] })
})

it('removes the kept words, their recovery copies and temporary writes as soon as history is turned off', async () => {
  const directory = await folder()
  let history = true
  const store = new WatcherStateStore(directory, () => history)
  await store.keep({ rules: ['synthetic_private_rule_7d1e'] }, '2026-10-19T10:00:00.000Z')
  expect(await readFile(join(directory, 'watcher-state.json'), 'utf8')).toContain('synthetic_private_rule_7d1e')
  await writeFile(join(directory, 'watcher-state.json.corrupt-1-a'), 'synthetic_private_rule_7d1e')
  await writeFile(join(directory, 'watcher-state.json.tmp-1-b'), 'synthetic_private_rule_7d1e')
  await writeFile(join(directory, 'agents.json'), '{}')
  history = false
  await store.privacyChanged()
  expect(await readdir(directory)).toEqual(['agents.json'])
  // Still kept in memory for this run, and saved again once history is back on.
  expect(store.read().rules).toEqual(['synthetic_private_rule_7d1e'])
  history = true
  await store.privacyChanged()
  expect(await readFile(join(directory, 'watcher-state.json'), 'utf8')).toContain('synthetic_private_rule_7d1e')
})

it('starts with history off by removing what an earlier run saved', async () => {
  const directory = await folder()
  await writeFile(join(directory, 'watcher-state.json'), JSON.stringify({ decisions: [], rules: ['synthetic_private_rule_3b9c'], issues: [], updatedAt: null }))
  const store = new WatcherStateStore(directory, () => false)
  expect((await store.current()).rules).toEqual([])
  expect(await readdir(directory)).toEqual([])
})

it('refuses rather than keep over saved lists it could not read at start, and reads them once it can', async () => {
  const directory = await folder(), file = join(directory, 'watcher-state.json')
  // A path that cannot be read as the state file, standing in for a passing permission or disk error.
  await mkdir(file)
  const store = new WatcherStateStore(directory, () => true)
  await expect(store.keep({ issues: ['#1189'] }, '2026-10-19T10:00:00.000Z')).rejects.toThrow()
  await expect(store.current()).rejects.toThrow()
  await rm(file, { recursive: true })
  await writeFile(file, JSON.stringify({ decisions: ['Merge #1186?'], rules: ['Suites run in CI.'], issues: [], updatedAt: null }))
  expect(await store.keep({ issues: ['#1189'] }, '2026-10-19T10:00:00.000Z')).toMatchObject({ decisions: ['Merge #1186?'], rules: ['Suites run in CI.'], issues: ['#1189'] })
})
