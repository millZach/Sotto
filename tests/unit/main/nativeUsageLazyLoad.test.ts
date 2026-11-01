// @vitest-environment node
/**
 * Start reads each thread's usage view and none of its requests, and a thread's requests are read the first time
 * something needs them (#1937). These hold the guard, that start parses no ledger and a report parses its own thread's
 * once, and the exactness: a thread read late counts what a thread read at start counts, to the last field.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'
import type { UsageTokenObservation } from '../../../src/shared/usageDashboard'
import { savedUsageLedgers } from '../../fixtures/usageLedgerFiles'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>() }))
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fsp>() }))

type Provider = 'claude' | 'codex' | 'grok'
const roots: string[] = []
const drains: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const drain of drains.splice(0)) await drain()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-lazy-')); roots.push(root)
  return root
}
async function started(root: string, provider: Provider = 'claude', usageEnabled = false): Promise<NativeUsage> {
  const usage = new NativeUsage(root, provider, usageEnabled); await usage.load(); drains.push(() => usage.flushed())
  return usage
}
const ledgerName = (id: string): string => `${createHash('sha256').update(id).digest('hex').slice(0, 40)}.json`
const viewName = (id: string): string => ledgerName(id).replace(/\.json$/u, '.view.json')

/** Every read of a thread's ledger file from here on, by either read Sotto makes: never a view file beside it. */
function ledgerReads(): { paths: () => string[]; clear: () => void } {
  const reads = [vi.spyOn(fsp, 'readFile'), vi.spyOn(fs, 'readFileSync')]
  return {
    paths: () => reads.flatMap(read => read.mock.calls.map(([path]) => String(path))).filter(path => /[0-9a-f]{40}\.json$/u.test(path)),
    clear: () => { for (const read of reads) read.mockClear() },
  }
}

const claudeReport = (index: number, output = 100) => ({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(), message: {
  id: `message-${index}`, model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
} })
const codexReport = (turn: number) => ({ turnId: `turn-${turn}`, tokenUsage: {
  total: { inputTokens: turn * 1_000, outputTokens: turn * 100, cachedInputTokens: 0 }, last: { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0 },
} })
const grokReport = (prompt: number) => ({ _meta: { agentTimestampMs: Date.UTC(2026, 9, 1, 0, prompt) }, update: { sessionUpdate: 'turn_completed', prompt_id: `prompt-${prompt}`,
  usage: { inputTokens: 1_000, outputTokens: 100, cachedReadTokens: 0, cacheCreationTokens: 0, apiDurationMs: 50, costUsdTicks: 1_000_000 } } })
/** One request of `provider`'s, the same one again for the same `index`: a replay carries the identity it was counted under. */
function report(usage: NativeUsage, provider: Provider, id: string, index: number): void {
  if (provider === 'claude') usage.claude(id, claudeReport(index))
  else if (provider === 'codex') usage.codex(id, 'gpt-5.4', codexReport(index))
  else usage.grok(id, 'grok-4.6-build', grokReport(index))
}

/** A copy of `root` as an earlier build left it, with no thread's view beside its ledger: started from, it reads every ledger whole. */
async function withoutViews(root: string, provider: Provider = 'claude'): Promise<string> {
  const copy = await folder()
  await cp(root, copy, { recursive: true })
  const directory = join(copy, `${provider}-usage`)
  for (const name of await readdir(directory)) if (name.endsWith('.view.json')) await rm(join(directory, name))
  return copy
}

it('reads every thread\'s view at start and no thread\'s requests, then one thread\'s ledger once, for its first report', async () => {
  const root = await folder()
  const first = await started(root)
  for (let thread = 0; thread < 30; thread++) for (let index = 0; index < 20; index++) first.claude(`thread-${thread}`, claudeReport(index))
  await first.flushed()
  const reads = ledgerReads()
  const usage = await started(root)
  expect(reads.paths()).toEqual([])
  for (let thread = 0; thread < 30; thread++) expect(usage.get(`thread-${thread}`)).toEqual(first.get(`thread-${thread}`))
  usage.claude('thread-7', claudeReport(20))
  expect(reads.paths()).toEqual([join(root, 'claude-usage', ledgerName('thread-7'))])
  // A streaming reply on it, and its turn's end, read nothing more.
  usage.claude('thread-7', { type: 'stream_event', event: { type: 'message_start', message: claudeReport(21, 1).message } })
  usage.claude('thread-7', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 100 } } })
  usage.claudeResult('thread-7', { duration_ms: 1_234 })
  expect(reads.paths()).toHaveLength(1)
  expect(usage.get('thread-7')).toMatchObject({ total: { output: 22 * 100 }, elapsedMs: 1_234 })
  expect(usage.get('thread-8')).toEqual(first.get('thread-8'))
  await usage.flushed()
  // A reconnect reads the views again, and a replay of a request already counted counts nothing.
  const view = structuredClone(usage.get('thread-7'))
  reads.clear()
  await usage.load()
  expect(reads.paths()).toEqual([])
  expect(usage.get('thread-7')).toEqual(view)
  usage.claude('thread-7', claudeReport(20))
  expect(usage.get('thread-7')!.total).toEqual(view!.total)
})

it('reads every ledger whole on the first start after an earlier build, writes their views alone, and only the views on the next start', async () => {
  const root = await folder()
  const first = await started(root)
  for (let thread = 0; thread < 12; thread++) for (let index = 0; index < 5; index++) first.claude(`thread-${thread}`, claudeReport(index))
  await first.flushed()
  const upgraded = await withoutViews(root)
  const directory = join(upgraded, 'claude-usage')
  const ledgers = (await readdir(directory)).filter(name => /^[0-9a-f]{40}\.json$/u.test(name))
  const modified = async () => Promise.all(ledgers.map(async name => (await stat(join(directory, name))).mtimeMs))
  const before = await modified()
  const reads = ledgerReads()
  const once = await started(upgraded)
  expect(reads.paths()).toHaveLength(12)
  await once.flushed()
  expect((await readdir(directory)).filter(name => name.endsWith('.view.json'))).toHaveLength(12)
  // Each ledger is left as it was: only its view was written.
  expect(await modified()).toEqual(before)
  reads.clear()
  const later = await started(upgraded)
  expect(reads.paths()).toEqual([])
  for (let thread = 0; thread < 12; thread++) expect(later.get(`thread-${thread}`)).toEqual(first.get(`thread-${thread}`))
})

it.each(['claude', 'codex', 'grok'] as const)('counts nothing twice when %s replays requests an earlier run counted into a thread not read yet, and ends where reading it at start ends', async provider => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-31T12:00:00Z'))
  const root = await folder()
  const first = await started(root, provider)
  for (let index = 1; index <= 10; index++) { report(first, provider, 'thread', index); report(first, provider, 'idle', index) }
  await first.flushed()
  const counted = structuredClone(first.get('thread'))
  // The reference reads every ledger whole at start, as every start did before #1937.
  const eagerRoot = await withoutViews(root, provider)
  const lazy = await started(root, provider), eager = await started(eagerRoot, provider)
  vi.setSystemTime(new Date('2026-10-31T13:00:00Z'))
  for (const usage of [lazy, eager]) {
    // The thread read again from its provider's record: every request it made, then two new ones.
    for (let index = 1; index <= 12; index++) report(usage, provider, 'thread', index)
  }
  expect(lazy.get('thread')).toEqual(eager.get('thread'))
  expect(lazy.get('idle')).toEqual(eager.get('idle'))
  expect(lazy.get('thread')!.total).toMatchObject({ input: 12_000, output: 1_200 })
  expect(lazy.get('thread')!.estimatedUsd).toBeCloseTo(counted!.estimatedUsd! * 12 / 10, 12)
  await lazy.flushed(); await eager.flushed()
  // What each saves is the same to the last request and key.
  expect(await savedUsageLedgers(root, provider)).toEqual(await savedUsageLedgers(eagerRoot, provider))
})

it('reads a ledger whole at start when its view was not written with it, as one a failed write or an earlier build leaves behind', async () => {
  const root = await folder()
  const first = await started(root)
  for (let index = 0; index < 5; index++) first.claude('thread', claudeReport(index))
  await first.flushed()
  const viewPath = join(root, 'claude-usage', viewName('thread'))
  const stale = await readFile(viewPath)
  const second = await started(root)
  second.claude('thread', claudeReport(5))
  await second.flushed()
  // As if the second run's ledger landed and its view did not.
  await writeFile(viewPath, stale)
  const reads = ledgerReads()
  const third = await started(root)
  expect(reads.paths()).toHaveLength(1)
  expect(third.get('thread')).toEqual(second.get('thread'))
  expect(third.get('thread')!.total!.output).toBe(600)
  await third.flushed()
  reads.clear()
  const fourth = await started(root)
  expect(reads.paths()).toEqual([])
  expect(fourth.get('thread')).toEqual(second.get('thread'))
})

it('reads a ledger whole at start to price its unpriced requests when its view was made with another rate table', async () => {
  const root = await folder()
  const first = await started(root)
  first.claude('thread', claudeReport(0))
  await first.flushed()
  const directory = join(root, 'claude-usage'), ledgerPath = join(directory, ledgerName('thread'))
  // A request saved before its model had a price, and the view made then, with the rate table of that time.
  const saved = JSON.parse(await readFile(ledgerPath, 'utf8')) as { id: string; ledger: { view: Record<string, unknown>; entries: Record<string, Record<string, unknown>> } }
  const entry = saved.ledger.entries['message-0']!
  delete entry.usd; entry.rate = 'older-rates'
  delete saved.ledger.view.estimatedUsd; saved.ledger.view.partial = true; saved.ledger.view.rateVersions = []
  await writeFile(ledgerPath, `${JSON.stringify(saved)}\n`)
  const file = await stat(ledgerPath)
  await writeFile(join(directory, viewName('thread')), JSON.stringify({ id: 'thread', rateVersion: 'older-rates', ledgerSize: file.size, ledgerModified: file.mtimeMs, view: saved.ledger.view }))
  const reads = ledgerReads()
  const usage = await started(root)
  expect(reads.paths()).toHaveLength(1)
  expect(usage.get('thread')).toEqual(first.get('thread'))
  expect(usage.get('thread')!.partial).toBe(false)
})

it('sets a thread\'s ledger aside as the store would when it is unreadable by its first report, and starts the thread afresh', async () => {
  const root = await folder()
  const first = await started(root)
  for (let index = 0; index < 3; index++) first.claude('thread', claudeReport(index))
  await first.flushed()
  const usage = await started(root)
  expect(usage.get('thread')!.total!.output).toBe(300)
  const directory = join(root, 'claude-usage')
  await writeFile(join(directory, ledgerName('thread')), '{"id":"thread","ledger":')
  usage.claude('thread', claudeReport(3))
  expect((await readdir(directory)).filter(name => name.startsWith(`${ledgerName('thread')}.corrupt-`))).toHaveLength(1)
  expect(usage.get('thread')!.total!.output).toBe(100)
  await usage.flushed()
  const reopened = await started(root)
  expect(reopened.get('thread')).toEqual(usage.get('thread'))
})

it('visits an unread thread\'s saved rows as a thread read at start does, without keeping its requests', async () => {
  const root = await folder()
  const first = await started(root, 'claude', true)
  for (let index = 0; index < 6; index++) first.claude('thread', claudeReport(index))
  await first.flushed()
  const eagerRoot = await withoutViews(root)
  const lazy = await started(root, 'claude', true), eager = await started(eagerRoot, 'claude', true)
  const visit = (usage: NativeUsage) => { const rows: UsageTokenObservation[] = []; usage.visitUsage('thread', row => rows.push(row)); return rows }
  const reads = ledgerReads()
  const visited = visit(lazy)
  expect(visited).toHaveLength(6)
  expect(visited).toEqual(visit(eager))
  expect(reads.paths()).toEqual([join(root, 'claude-usage', ledgerName('thread'))])
  // Not kept: a second visit reads the file again, and the thread still shows its view.
  expect(visit(lazy)).toEqual(visited)
  expect(reads.paths()).toHaveLength(2)
  expect(lazy.get('thread')).toEqual(first.get('thread'))
  // Its first report reads the requests to keep them, and counts the one new request alone.
  lazy.claude('thread', claudeReport(6))
  expect(reads.paths()).toHaveLength(3)
  expect(lazy.get('thread')!.total!.output).toBe(700)
})

it('counts nothing, and changes nothing saved, for a report whose thread\'s ledger cannot be read at the moment', async () => {
  const root = await folder()
  const first = await started(root)
  for (let index = 0; index < 3; index++) first.claude('thread', claudeReport(index))
  await first.flushed()
  const usage = await started(root)
  const ledgerPath = join(root, 'claude-usage', ledgerName('thread'))
  const saved = await readFile(ledgerPath, 'utf8')
  vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw Object.assign(new Error('Synthetic busy file'), { code: 'EBUSY' }) })
  expect(() => usage.claude('thread', claudeReport(3))).not.toThrow()
  expect(usage.get('thread')).toEqual(first.get('thread'))
  await usage.flushed()
  expect(await readFile(ledgerPath, 'utf8')).toBe(saved)
  // The next report reads the requests, and the provider's replay of the one missed counts it once.
  usage.claude('thread', claudeReport(4)); usage.claude('thread', claudeReport(3))
  expect(usage.get('thread')!.total!.output).toBe(500)
})
