// @vitest-environment node
/**
 * Start reads each thread's usage view and none of its requests, and a thread's requests are read the first time
 * something needs them (#1937), a report being held meanwhile. These hold the guard, that start parses no ledger and a
 * report parses its own thread's once, off its own task, and the exactness: a thread read late counts what a thread read at
 * start counts, to the last field, even when a read fails first.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'
import type { AgentHost } from '../../../src/main/agents/host'
import { UsageReadPending } from '../../../src/main/agents/usageVisits'
import { UsageService } from '../../../src/main/agents/usageService'
import { UsageStore } from '../../../src/main/agents/usageStore'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
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
async function started(root: string, provider: Provider = 'claude', usageEnabled = false, applied?: (id: string) => void): Promise<NativeUsage> {
  const usage = new NativeUsage(root, provider, usageEnabled, applied); await usage.load(); drains.push(() => usage.flushed())
  return usage
}
/** Reads of the ledger file of `id` under `root` fail once with `code`, as a file another program holds can, then read as before. */
function failOnce(root: string, provider: Provider, id: string, code = 'EBUSY'): void {
  const path = join(root, `${provider}-usage`, ledgerName(id)), read = fsp.readFile
  let failed = false
  vi.spyOn(fsp, 'readFile').mockImplementation(((file: Parameters<typeof read>[0], ...rest: unknown[]) => {
    if (failed || String(file) !== path) return (read as (...args: unknown[]) => Promise<unknown>)(file, ...rest)
    failed = true
    return Promise.reject(Object.assign(new Error('Synthetic unreadable ledger'), { code }))
  }) as typeof read)
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

/** Usage's visit of a thread as Usage makes it: once its saved requests are read, in the background, the visit is made again. */
async function visited(usage: NativeUsage, id: string): Promise<UsageTokenObservation[]> {
  const rows: UsageTokenObservation[] = []
  try { usage.visitUsage(id, row => rows.push(row)); return rows } catch (error) { if (!(error instanceof UsageReadPending)) throw error }
  await usage.flushed()
  usage.visitUsage(id, row => rows.push(row))
  return rows
}
/** Usage over `usage`'s Claude threads, as main wires it, on a store in `root`; `publish` hands it the threads as the host shows them. */
function usageOver(usage: NativeUsage, root: string, ids: readonly string[]) {
  let listener: ((snapshot: AgentHostSnapshot) => void) | undefined
  const host = { subscribe: (next: (snapshot: AgentHostSnapshot) => void) => { listener = next; return () => { listener = undefined } },
    visitUsage: (id: string, visitor: (row: UsageTokenObservation) => void) => usage.visitUsage(id, visitor),
    subscribeUsage: (next: (row: UsageTokenObservation) => void) => usage.subscribeUsage(next) } as unknown as AgentHost
  const rows: UsageTokenObservation[] = [], perVisit: number[] = []
  const inner = host.visitUsage!.bind(host)
  host.visitUsage = (id, visitor) => {
    let handed = 0
    try { inner(id, row => { handed += 1; rows.push(row); visitor(row) }) } finally { perVisit.push(handed) }
  }
  const store = new UsageStore(join(root, 'usage.sqlite'), () => '2026-10-31T12:00:00.000Z')
  const service = new UsageService({ directory: root, host, store })
  service.start()
  drains.push(async () => { service.close() })
  const publish = (shown: readonly string[] = ids): void => listener!({ connected: true, providers: [{ id: 'claude', connection: 'connected' }], models: [],
    threads: shown.map(id => ({ id, providerId: 'claude', usage: usage.get(id) })) } as unknown as AgentHostSnapshot)
  const visits = vi.spyOn(host as { visitUsage: (id: string, visitor: (row: UsageTokenObservation) => void) => void }, 'visitUsage')
  return { service, store, publish, visits, rows, perVisit }
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
  const applied: string[] = []
  const usage = await started(root, 'claude', false, id => applied.push(id))
  expect(reads.paths()).toEqual([])
  for (let thread = 0; thread < 30; thread++) expect(usage.get(`thread-${thread}`)).toEqual(first.get(`thread-${thread}`))
  usage.claude('thread-7', claudeReport(20))
  // Its request is held while the thread's requests are read, off this task; its reading shows in the view at once.
  expect(usage.get('thread-7')).toMatchObject({ total: first.get('thread-7')!.total, updatedAt: claudeReport(20).timestamp, contextUsed: 1_000 })
  // A streaming reply on it, and its turn's end, are held behind it in order.
  usage.claude('thread-7', { type: 'stream_event', event: { type: 'message_start', message: claudeReport(21, 1).message } })
  usage.claude('thread-7', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 100 } } })
  usage.claude('thread-7', { type: 'stream_event', event: { type: 'message_stop' } })
  usage.claudeResult('thread-7', { duration_ms: 1_234 })
  await usage.flushed()
  expect(reads.paths()).toEqual([join(root, 'claude-usage', ledgerName('thread-7'))])
  expect(applied).toEqual(['thread-7'])
  expect(usage.get('thread-7')).toMatchObject({ total: { output: 22 * 100 }, elapsedMs: 1_234 })
  expect(usage.get('thread-8')).toEqual(first.get('thread-8'))
  // Read once, its next report counts at once.
  usage.claude('thread-7', claudeReport(22))
  expect(usage.get('thread-7')!.total!.output).toBe(23 * 100)
  expect(reads.paths()).toHaveLength(1)
  await usage.flushed()
  // A reconnect reads the views again, and a replay of a request already counted counts nothing.
  const view = structuredClone(usage.get('thread-7'))
  reads.clear()
  await usage.load()
  expect(reads.paths()).toEqual([])
  expect(usage.get('thread-7')).toEqual(view)
  usage.claude('thread-7', claudeReport(20))
  await usage.flushed()
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
  await lazy.flushed(); await eager.flushed()
  expect(lazy.get('thread')).toEqual(eager.get('thread'))
  expect(lazy.get('idle')).toEqual(eager.get('idle'))
  expect(lazy.get('thread')!.total).toMatchObject({ input: 12_000, output: 1_200 })
  expect(lazy.get('thread')!.estimatedUsd).toBeCloseTo(counted!.estimatedUsd! * 12 / 10, 12)
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
  // Pricing a request is a change to it, so the thread's revision moves on.
  const { revision, ...priced } = usage.get('thread')!
  const { revision: firstRevision, ...counted } = first.get('thread')!
  expect(priced).toEqual(counted)
  expect(revision).toBe(firstRevision! + 1)
  expect(priced.partial).toBe(false)
})

it.each([
  ['unreadable', () => '{"id":"thread","ledger":'],
  ['holding a request its schema refuses', (saved: string) => saved.replace('"output":100', '"output":-1')],
])('sets a thread\'s ledger aside as the store would when it is %s by its first report, and starts the thread afresh', async (_kind, spoil) => {
  const root = await folder()
  const first = await started(root)
  for (let index = 0; index < 3; index++) first.claude('thread', claudeReport(index))
  await first.flushed()
  const usage = await started(root)
  expect(usage.get('thread')!.total!.output).toBe(300)
  const directory = join(root, 'claude-usage')
  await writeFile(join(directory, ledgerName('thread')), spoil(await readFile(join(directory, ledgerName('thread')), 'utf8')))
  usage.claude('thread', claudeReport(3))
  await usage.flushed()
  expect((await readdir(directory)).filter(name => name.startsWith(`${ledgerName('thread')}.corrupt-`))).toHaveLength(1)
  expect(usage.get('thread')!.total!.output).toBe(100)
  await usage.flushed()
  const reopened = await started(root)
  expect(reopened.get('thread')).toEqual(usage.get('thread'))
})

it('visits an unread thread\'s saved rows as a thread read at start does, and keeps its requests for its reports', async () => {
  const root = await folder()
  const first = await started(root, 'claude', true)
  for (let index = 0; index < 6; index++) first.claude('thread', claudeReport(index))
  await first.flushed()
  const eagerRoot = await withoutViews(root)
  const lazy = await started(root, 'claude', true), eager = await started(eagerRoot, 'claude', true)
  const reads = ledgerReads()
  const rows = await visited(lazy, 'thread')
  expect(rows).toHaveLength(6)
  expect(rows).toEqual(await visited(eager, 'thread'))
  expect(reads.paths()).toEqual([join(root, 'claude-usage', ledgerName('thread'))])
  // Kept: a second visit reads nothing, and the thread's first report counts at once, the one new request alone.
  expect(await visited(lazy, 'thread')).toEqual(rows)
  expect(reads.paths()).toHaveLength(1)
  expect(lazy.get('thread')).toEqual(first.get('thread'))
  lazy.claude('thread', claudeReport(6))
  expect(lazy.get('thread')!.total!.output).toBe(700)
  expect(reads.paths()).toHaveLength(1)
})

it('reads a thread\'s requests once when it reports usage and Usage visits it before the read lands', async () => {
  const root = await folder()
  const first = await started(root, 'claude', true)
  for (let index = 0; index < 3; index++) { first.claude('thread', claudeReport(index)); first.claude('other', claudeReport(index)) }
  await first.flushed()
  const usage = await started(root, 'claude', true)
  const reads = ledgerReads()
  const f = usageOver(usage, root, ['thread', 'other'])
  usage.claude('thread', claudeReport(3))
  // Usage comes to the thread while its read for the report is under way: it waits for that read rather than reading again.
  f.publish()
  const read = await f.service.read()
  expect(reads.paths().filter(path => path.endsWith(ledgerName('thread')))).toHaveLength(1)
  expect(reads.paths().filter(path => path.endsWith(ledgerName('other')))).toHaveLength(1)
  expect(f.visits.mock.calls.filter(([id]) => id === 'thread').length).toBeGreaterThan(1)
  expect(read.activity!.totals.tokens.output).toMatchObject({ rows: 7, value: 700 })
  expect(usage.get('thread')!.total!.output).toBe(400)
  await usage.flushed()
  expect(usage.get('thread')!.total!.output).toBe(400)
})

it('marks a thread read again when an older request\'s model is corrected though no total or time moved', async () => {
  const root = await folder()
  const first = await started(root, 'claude', true)
  // Both models are priced, so correcting one to the other moves no total, time, rate version or partial mark.
  first.claude('thread', { ...claudeReport(1), message: { ...claudeReport(1).message, model: 'claude-opus-5' } })
  first.claude('thread', claudeReport(2))
  await first.flushed()
  const start = await started(root, 'claude', true)
  const f1 = usageOver(start, root, ['thread']); f1.publish(); await f1.service.read(); f1.service.close()
  expect(f1.rows.map(row => row.modelId).sort()).toEqual(['claude-opus-5', 'claude-sonnet-4-6'])
  await start.flushed()
  const view = structuredClone(start.get('thread')!)
  // History replays the first request with the model it was served by: the same tokens, an older time.
  start.claude('thread', claudeReport(1))
  await start.flushed()
  expect(start.get('thread')).toMatchObject({ total: view.total, updatedAt: view.updatedAt, latest: view.latest, rateVersions: view.rateVersions, partial: view.partial })
  expect(start.get('thread')!.revision).toBe(view.revision! + 1)
  const next = await started(root, 'claude', true)
  const f2 = usageOver(next, root, ['thread']); f2.publish(); await f2.service.read()
  // Its rows are read again at the next start, the corrected model among them.
  expect(f2.rows.map(row => row.modelId)).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-6'])
  // A start after that, nothing having changed, reads nothing.
  f2.service.close()
  const after = await started(root, 'claude', true)
  const f3 = usageOver(after, root, ['thread']); f3.publish(); await f3.service.read()
  expect(f3.rows).toEqual([])
})

it.each([
  ['keeps a context reading that came in while it ran', 2, 10_000],
  ['clears the reading when what came in was a report Codex had counted already', 1, undefined],
])('orders a Codex compaction among reports held while the thread\'s requests are read, so it %s, as reading every ledger at start does (ADR-0095)', async (_case, turn, kept) => {
  const root = await folder()
  const first = await started(root, 'codex')
  const codex = (turn: number, used: number) => ({ turnId: `turn-${turn}`, tokenUsage: { total: { inputTokens: turn * 1_000, outputTokens: turn * 100, cachedInputTokens: 0 },
    last: { inputTokens: 1_000, outputTokens: 100, cachedInputTokens: 0, totalTokens: used }, modelContextWindow: 200_000 } })
  first.codex('thread', 'gpt-5.4', codex(1, 50_000))
  await first.flushed()
  const eagerRoot = await withoutViews(root, 'codex')
  const compacting = async (usage: NativeUsage) => {
    // Codex's compaction as its adapter drives it: its start, a report while it runs, and its end.
    usage.compactionStarted('thread')
    const before = structuredClone(usage.get('thread'))
    usage.codex('thread', 'gpt-5.4', codex(turn, turn === 1 ? 50_000 : 10_000))
    // A report Codex counted already changes nothing in the view, held or not.
    if (turn === 1) expect(usage.get('thread')).toEqual(before)
    usage.compactionEnded('thread')
    await usage.flushed()
    return usage.get('thread')!.contextUsed
  }
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-31T12:00:00Z'))
  expect(await compacting(await started(eagerRoot, 'codex'))).toBe(kept)
  vi.setSystemTime(new Date('2026-10-31T12:00:01Z'))
  expect(await compacting(await started(root, 'codex'))).toBe(kept)
})

it('normalises a long thread\'s requests a chunk a task when they are read for its report, to the same totals', async () => {
  const root = await folder()
  const first = await started(root)
  for (let index = 0; index < 4_500; index++) first.claude('thread', claudeReport(index, 100 + index % 7))
  await first.flushed()
  const eagerRoot = await withoutViews(root)
  const lazy = await started(root), eager = await started(eagerRoot)
  const tasks = vi.spyOn(globalThis, 'setImmediate')
  lazy.claude('thread', claudeReport(4_500)); eager.claude('thread', claudeReport(4_500))
  await lazy.flushed(); await eager.flushed()
  // The read's own task, then the repricing and the totals of 4,500 requests, two thousand a task.
  expect(tasks.mock.calls.length).toBeGreaterThanOrEqual(5)
  expect(lazy.get('thread')).toEqual(eager.get('thread'))
  expect(await savedUsageLedgers(root)).toEqual(await savedUsageLedgers(eagerRoot))
})

it.each(['claude', 'codex', 'grok'] as const)('loses no %s report to a read that fails, and ends where reading every ledger at start ends', async provider => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-31T12:00:00Z'))
  const root = await folder()
  const first = await started(root, provider)
  report(first, provider, 'thread', 1)
  await first.flushed()
  const eagerRoot = await withoutViews(root, provider)
  const lazy = await started(root, provider), eager = await started(eagerRoot, provider)
  failOnce(root, provider, 'thread')
  vi.setSystemTime(new Date('2026-10-31T13:00:00Z'))
  // The next request is reported as the thread's read fails, and another after it; nothing replays either.
  for (const usage of [lazy, eager]) { report(usage, provider, 'thread', 2); report(usage, provider, 'thread', 3) }
  await lazy.flushed(); await eager.flushed()
  expect(lazy.get('thread')!.total).toMatchObject({ input: 3_000, output: 300 })
  expect(lazy.get('thread')).toEqual(eager.get('thread'))
  expect(await savedUsageLedgers(root, provider)).toEqual(await savedUsageLedgers(eagerRoot, provider))
})

it('reads a thread again on its own a short while after its read failed, and applies its held reports then', async () => {
  const root = await folder()
  const first = await started(root)
  first.claude('thread', claudeReport(0))
  await first.flushed()
  let applied: () => void = () => undefined
  const landed = new Promise<void>(resolve => { applied = resolve })
  const usage = await started(root, 'claude', false, () => { applied() })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  failOnce(root, 'claude', 'thread')
  usage.claude('thread', claudeReport(1))
  // The failed read is behind it once a task has passed; the retry waits half a second.
  await new Promise(resolve => { setImmediate(resolve) }); await new Promise(resolve => { setImmediate(resolve) })
  expect(usage.get('thread')!.total!.output).toBe(100)
  await vi.advanceTimersByTimeAsync(500)
  await landed
  expect(usage.get('thread')!.total!.output).toBe(200)
})

it('reads a thread\'s ledger whole at start when its view cannot be read, rather than failing to start', async () => {
  const root = await folder()
  const first = await started(root)
  first.claude('thread', claudeReport(0))
  await first.flushed()
  const viewPath = join(root, 'claude-usage', viewName('thread')), read = fsp.readFile
  vi.spyOn(fsp, 'readFile').mockImplementation(((file: Parameters<typeof read>[0], ...rest: unknown[]) => String(file) === viewPath
    ? Promise.reject(Object.assign(new Error('Synthetic refused view'), { code: 'EACCES' }))
    : (read as (...args: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof read)
  const reads = ledgerReads()
  const usage = await started(root)
  expect(reads.paths()).toEqual([join(root, 'claude-usage', ledgerName('thread'))])
  expect(usage.get('thread')).toEqual(first.get('thread'))
})

it('visits a long thread\'s rows five hundred a task when its first report moves its mark, and Usage\'s read and seed wait for all of them', async () => {
  const root = await folder()
  const first = await started(root, 'claude', true)
  for (let index = 0; index < 4_500; index++) first.claude('long', claudeReport(index))
  first.claude('short', claudeReport(0))
  await first.flushed()
  const start = await started(root, 'claude', true)
  const f1 = usageOver(start, root, ['short', 'long'])
  const seed = vi.spyOn(f1.store, 'markLegacySeedCompleted')
  // Connected with no thread first, so the seed is due; then the threads, the long one read a chunk a task.
  f1.publish([])
  f1.publish()
  // Once its ledger is read the long thread is visited a chunk a task; mid-visit, a flush carries no seed mark.
  const midVisit = () => (f1.service as unknown as { active?: unknown; visits: Map<string, unknown> }).active !== undefined
  // Its read lands, then Usage visits it again a short while on (UsageReadPending): turns of the event loop until then.
  for (const until = performance.now() + 5_000; !midVisit() && performance.now() < until;) await new Promise(resolve => { setImmediate(resolve) })
  expect(midVisit()).toBe(true)
  expect((f1.service as unknown as { visits: Map<string, unknown> }).visits.size).toBe(0)
  f1.service.flush()
  expect(seed).not.toHaveBeenCalled()
  await f1.service.read()
  expect(seed).toHaveBeenCalledOnce()
  expect(Math.max(...f1.perVisit)).toBeLessThanOrEqual(500)
  f1.service.close(); await start.flushed()
  // The next start passes the long thread over on its mark, until its first report moves the mark.
  const next = await started(root, 'claude', true)
  const f2 = usageOver(next, root, ['short', 'long'])
  f2.publish()
  await f2.service.read()
  expect(f2.rows).toEqual([])
  next.claude('long', claudeReport(4_500))
  await next.flushed()
  f2.publish()
  const read = await f2.service.read()
  expect(f2.rows).toHaveLength(4_501)
  expect(Math.max(...f2.perVisit)).toBeLessThanOrEqual(500)
  expect(read.activity!.totals.tokens.output).toMatchObject({ rows: 4_502 })
})

it('keeps Usage from saying it saved, and Clear from clearing, while a thread\'s ledger cannot be read', async () => {
  const root = await folder()
  const first = await started(root, 'claude', true)
  first.claude('thread', claudeReport(0)); first.claude('other', claudeReport(0))
  await first.flushed()
  const usage = await started(root, 'claude', true)
  const path = join(root, 'claude-usage', ledgerName('thread')), read = fsp.readFile
  const refusing = vi.spyOn(fsp, 'readFile').mockImplementation(((file: Parameters<typeof read>[0], ...rest: unknown[]) => String(file) === path
    ? Promise.reject(Object.assign(new Error('Synthetic refused ledger'), { code: 'EACCES' }))
    : (read as (...args: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof read)
  const f = usageOver(usage, root, ['thread', 'other'])
  f.publish()
  const refused = await f.service.read()
  expect(refused.persistence).toBe('failed')
  expect(refused.activity!.totals.tokens.output).toMatchObject({ rows: 1 })
  await expect(f.service.clear({ expectedRevision: refused.activity!.metadata.revision })).rejects.toThrow('could not be saved')
  // Readable again: its read is tried again, the next publication visits it, and Usage has saved everything.
  refusing.mockRestore()
  await usage.flushed()
  f.publish()
  const saved = await f.service.read()
  expect(saved.persistence).toBe('saved')
  expect(saved.activity!.totals.tokens.output).toMatchObject({ rows: 2 })
})

it('reads a thread whose ledger an earlier build wrote, with no revision, at every start until it is read, then marks it', async () => {
  const root = await folder()
  const first = await started(root, 'claude', true)
  first.claude('thread', { ...claudeReport(1), message: { ...claudeReport(1).message, model: 'claude-opus-5' } })
  first.claude('thread', claudeReport(2))
  await first.flushed()
  /** The thread's ledger as a build with no revision writes it: no revision in it, and no view beside it. */
  const asEarlierBuild = async (correct = false) => {
    const directory = join(root, 'claude-usage'), ledgerPath = join(directory, ledgerName('thread'))
    const saved = JSON.parse(await readFile(ledgerPath, 'utf8')) as { ledger: { view: Record<string, unknown>; entries: Record<string, { model: string }> } }
    delete saved.ledger.view.revision
    if (correct) saved.ledger.entries['message-1']!.model = 'claude-sonnet-4-6'
    await writeFile(ledgerPath, `${JSON.stringify(saved)}\n`)
    await rm(join(directory, viewName('thread')), { force: true })
  }
  const startWith = async () => {
    const usage = await started(root, 'claude', true)
    const f = usageOver(usage, root, ['thread']); f.publish(); await f.service.read(); f.service.close(); await usage.flushed()
    return f.rows.map(row => row.modelId)
  }
  await asEarlierBuild()
  expect(await startWith()).toEqual(['claude-opus-5', 'claude-sonnet-4-6'])
  // An earlier build runs again and corrects the first request's model, totals and times unmoved: read again, not passed over.
  await asEarlierBuild(true)
  expect(await startWith()).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-6'])
  // Read, it has a revision now; the start after marks it, and the one after that passes it over.
  expect(await startWith()).toHaveLength(2)
  expect(await startWith()).toEqual([])
})
