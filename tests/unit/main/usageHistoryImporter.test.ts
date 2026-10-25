// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageHistoryImporter, USAGE_HISTORY_START_DELAY_MS, type UsageHistorySource, type UsageHistoryStore } from '../../../src/main/agents/usageHistory/importer'
import { usageHistoryThreadId } from '../../../src/main/agents/usageHistory/sink'
import { visitUserMessageInstants, type StoredUserMessageInstant } from '../../../src/main/agents/usageHistory/sottoPrompts'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import type { AgentHost } from '../../../src/main/agents/host'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { memorySink } from '../../fixtures/usageHistory/sink'
import type { UsageHistoryCursor, UsageHistoryPrompt, UsageHistoryStatus, UsageTokenObservation } from '../../../src/shared/usageDashboard'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const startedAt = '2026-10-14T01:31:52.000Z'
const history = (patch: Partial<UsageTokenObservation> = {}): UsageTokenObservation => ({ providerId: 'claude', threadId: usageHistoryThreadId('claude', 'native'),
  recordKey: hash('row'), modelId: 'claude-opus-5-5', tokens: { input: 10, output: 2 }, at: '2026-09-20T10:00:00.000Z', phase: 'replay', partial: false,
  origin: 'history', source: 'outside', client: 'claude-code', ...patch })

function fakeStore() {
  const tokens: UsageTokenObservation[][] = []
  const prompts: UsageHistoryPrompt[][] = []
  const cursors = new Map<string, UsageHistoryCursor>()
  const statuses: UsageHistoryStatus[] = []
  let failTokens = false
  const store: UsageHistoryStore = {
    metadata: () => ({ startedAt, revision: 0, generation: 0, legacySeedCompleted: true, ...(statuses.length ? { history: statuses.at(-1)! } : {}) }),
    observeTokenBatch: batch => { if (failTokens) throw new Error('disk'); tokens.push(batch); return { status: 'written', revision: 1 } },
    importPrompts: batch => { prompts.push(batch); return { status: 'written', revision: 1 } },
    historyCursor: key => cursors.get(key),
    setHistoryCursors: entries => { for (const entry of entries) cursors.set(entry.key, entry.cursor) },
    setHistoryStatus: status => { statuses.push(status) },
  }
  return { store, tokens, prompts, cursors, statuses, fail: () => { failTokens = true } }
}

afterEach(() => { vi.useRealTimers() })

describe('Usage history importer', () => {
  it('writes valid history in batches, saves cursors after the rows and reports where history begins', async () => {
    const f = fakeStore()
    const source: UsageHistorySource = { scanUsageHistory: async sink => {
      sink.tokens([history(), history({ recordKey: hash('older'), at: '2026-07-19T08:00:00.000Z' }), { ...history(), at: undefined } as UsageTokenObservation,
        { ...history(), origin: undefined }])
      sink.setCursors([{ key: 'claude:file', cursor: { size: 10, mtimeMs: 1, offset: 10 } }])
    } }
    const importer = new UsageHistoryImporter({ source, store: () => f.store })
    await importer.run()
    importer.close()
    expect(f.tokens.flat().map(row => row.recordKey)).toEqual([hash('row'), hash('older')])
    expect(f.cursors.get('claude:file')?.offset).toBe(10)
    expect(f.statuses.map(status => status.status)).toEqual(['scanning', 'complete'])
    expect(f.statuses.at(-1)).toMatchObject({ earliestAt: '2026-07-19T08:00:00.000Z' })
    expect(f.statuses.at(-1)?.scannedAt).toBeDefined()
  })

  it('moves no cursor past rows the store refused, and says history is unavailable', async () => {
    const f = fakeStore(); f.fail()
    let aborted = false
    const importer = new UsageHistoryImporter({ store: () => f.store, source: { scanUsageHistory: async (sink, signal) => {
      sink.tokens([history()])
      aborted = signal.aborted
      sink.setCursors([{ key: 'claude:file', cursor: { size: 10, mtimeMs: 1, offset: 10 } }])
    } } })
    await importer.run(); importer.close()
    expect(aborted).toBe(true)
    expect(f.cursors.size).toBe(0)
    expect(f.statuses.at(-1)?.status).toBe('unavailable')
  })

  it('imports Sotto\'s own prompts from before Usage began once, wake-ups told apart', async () => {
    const f = fakeStore()
    const visits: (string | undefined)[] = []
    let ready = false
    const source: UsageHistorySource = { visitRecordedUserMessages: (visitor, before) => {
      visits.push(before)
      if (!ready) return false
      visitor({ threadId: 'thread-1', messageId: 'm-1', providerId: 'claude', modelId: 'native:claude:model:opus', at: '2026-09-15T17:19:00.000Z', wakeUp: false })
      visitor({ threadId: 'thread-1', messageId: 'm-2', providerId: 'claude', modelId: '', at: '2026-09-15T17:20:00.000Z', wakeUp: true })
      return true
    } }
    const importer = new UsageHistoryImporter({ source, store: () => f.store })
    await importer.run()
    expect(f.prompts.flat()).toEqual([])
    ready = true
    await importer.run(); await importer.run(); importer.close()
    expect(visits).toEqual([startedAt, startedAt])
    expect(f.prompts.flat()).toEqual([
      { providerId: 'claude', threadId: 'thread-1', messageId: 'm-1', modelId: 'native:claude:model:opus', at: '2026-09-15T17:19:00.000Z', kind: 'user', source: 'sotto', client: 'sotto' },
      { providerId: 'claude', threadId: 'thread-1', messageId: 'm-2', modelId: 'unknown', at: '2026-09-15T17:20:00.000Z', kind: 'wake-up', source: 'sotto', client: 'sotto' }])
  })

  it('runs in the background after start, then again on a read, and one pass at a time', async () => {
    vi.useFakeTimers()
    const f = fakeStore()
    let release: (() => void) | undefined
    const scan = vi.fn((): Promise<void> => new Promise<void>(resolve => { release = resolve }))
    let now = 0
    const importer = new UsageHistoryImporter({ source: { scanUsageHistory: scan }, store: () => f.store, now: () => now })
    importer.start()
    expect(scan).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(USAGE_HISTORY_START_DELAY_MS)
    expect(scan).toHaveBeenCalledOnce()
    importer.poke(); void importer.run()
    expect(scan).toHaveBeenCalledOnce()
    release!(); await vi.advanceTimersByTimeAsync(0)
    importer.poke()
    expect(scan).toHaveBeenCalledOnce()
    now = 60_000
    importer.poke()
    expect(scan).toHaveBeenCalledTimes(2)
    release!(); importer.close()
  })

  it('says history is unavailable on a host that has none to read', async () => {
    const f = fakeStore()
    const importer = new UsageHistoryImporter({ source: {}, store: () => f.store })
    await importer.run(); importer.close()
    expect(f.statuses).toEqual([{ status: 'unavailable' }])
  })
})

describe('Sotto stored prompt instants', () => {
  it('reads identities, instants and wake-ups without any text column', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE messages (thread_id TEXT, position INTEGER, message_id TEXT, role TEXT, text TEXT, created_at TEXT);
      CREATE TABLE wake_ups (thread_id TEXT, message_id TEXT, PRIMARY KEY (thread_id, message_id));`)
    const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('t-1', 0, 'm-1', 'user', 'secret words', '2026-09-15T17:19:00.000Z')
    insert.run('t-1', 1, 'm-2', 'assistant', 'secret reply', '2026-09-15T17:19:05.000Z')
    insert.run('t-1', 2, 'm-3', 'user', 'secret wake', '2026-09-16T08:00:00.000Z')
    insert.run('t-1', 3, 'm-4', 'user', 'after start', '2026-10-14T02:00:00.000Z')
    insert.run('t-2', 0, 'm-5', 'user', 'bad date', 'not a date')
    db.prepare('INSERT INTO wake_ups VALUES (?, ?)').run('t-1', 'm-3')
    const seen: StoredUserMessageInstant[] = []
    visitUserMessageInstants(db, message => seen.push(message), startedAt)
    expect(seen).toEqual([
      { threadId: 't-1', messageId: 'm-1', at: '2026-09-15T17:19:00.000Z', wakeUp: false },
      { threadId: 't-1', messageId: 'm-3', at: '2026-09-16T08:00:00.000Z', wakeUp: true }])
    expect(JSON.stringify(seen)).not.toContain('secret')
    db.close()
  })
})

describe('Sotto thread host history translation', () => {
  it('lifts owned rows to their Sotto thread, drops unbound ones and passes work outside Sotto through', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-usage-history-threads-'))
    try {
      const registry = new ThreadRegistry(root)
      await registry.load()
      const binding = registry.bind('claude', 'adapter-thread-1', 'project-1')
      const inner: AgentHost = new FakeProviderHost()
      inner.scanUsageHistory = async sink => {
        sink.tokens([history({ threadId: 'adapter-thread-1', source: undefined, client: undefined }), history({ threadId: 'adapter-unbound', source: undefined, client: undefined }), history()])
        sink.prompts([{ providerId: 'claude', threadId: usageHistoryThreadId('claude', 'native'), messageId: 'u-1', modelId: 'm', at: startedAt, kind: 'user', source: 'outside', client: 'claude-code' }])
        sink.setCursors([{ key: 'k', cursor: { size: 1, mtimeMs: 1, offset: 1 } }])
      }
      const host = new SottoThreadHost('claude', inner, registry)
      const sink = memorySink()
      await host.scanUsageHistory!(sink.sink, new AbortController().signal)
      expect(sink.tokens.map(row => row.threadId)).toEqual([binding.threadId, usageHistoryThreadId('claude', 'native')])
      expect(sink.prompts).toHaveLength(1)
      expect(sink.cursors.get('k')?.offset).toBe(1)
      await registry.flush()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('provider switch history scan', () => {
  it('reads each usage provider in turn under its provider and model names, and goes on past one that fails', async () => {
    const hosts = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(), opencode: new FakeProviderHost(), cursor: new FakeProviderHost(), deepseek: new FakeProviderHost() }
    const codex: AgentHost = hosts.codex, claude: AgentHost = hosts.claude, muse: AgentHost = hosts.muse
    codex.scanUsageHistory = async () => { throw new Error('unreadable') }
    claude.scanUsageHistory = async sink => { sink.tokens([history({ providerId: 'codex' })]) }
    muse.scanUsageHistory = async sink => { sink.tokens([history()]) }
    const host = new ConfiguredProviderHost({ hosts, provider: () => 'codex' })
    const sink = memorySink()
    await host.scanUsageHistory!(sink.sink, new AbortController().signal)
    // Every scan is projected under the provider that read it, whatever its rows said; Muse has none of its own (ADR-0083).
    expect(sink.tokens.map(row => [row.providerId, row.modelId])).toEqual([['claude', 'native:claude:model:claude-opus-5-5'], ['muse', 'native:muse:model:claude-opus-5-5']])
  })
})
