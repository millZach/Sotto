// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHost } from '../../../src/main/agents/host'
import { UsageService } from '../../../src/main/agents/usageService'
import { UsageStore } from '../../../src/main/agents/usageStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { USAGE_HISTORY_BATCH_MAX, type UsagePromptIdentity, type UsagePromptSubmission, type UsageTokenObservation } from '../../../src/shared/usageDashboard'
import { parseCodexQuota } from '../../../src/main/agents/providerQuota'

const at = '2026-10-12T12:00:00.000Z'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const submission: UsagePromptSubmission = { providerId: 'codex', threadId: 'thread-1', messageId: 'message-1',
  modelId: 'selected-model', at, kind: 'user', inputKind: 'send' }
const token = (patch: Partial<UsageTokenObservation> = {}): UsageTokenObservation => ({ providerId: 'codex', threadId: 'thread-1',
  modelId: 'native-model', recordKey: hash('request'), groupKey: hash('turn'), at, phase: 'live', partial: false,
  tokens: { input: 100, output: 20, cached: 40 }, ...patch })
const opened: UsageService[] = []
const roots: string[] = []
afterEach(async () => {
  for (const service of opened.splice(0)) service.close()
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-usage-service-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

function fixture(options: { store?: UsageStore; accepted?: (threadId: string, messageId: string) => boolean;
  acceptedBatch?: (identities: readonly UsagePromptIdentity[]) => readonly UsagePromptIdentity[];
  initiallyConnected?: boolean; beforeFirstSnapshot?: () => void } = {}) {
  const fake = new FakeProviderHost()
  fake.state.connected = options.initiallyConnected ?? true
  fake.state.threads[0]!.providerId = 'codex'
  fake.state.models[0]!.providerId = 'codex'
  let observation: ((record: UsageTokenObservation) => void) | undefined
  const host: AgentHost = fake
  host.subscribeUsage = listener => { observation = listener; return () => { observation = undefined } }
  const store = options.store ?? new UsageStore(':memory:', () => at)
  const service = new UsageService({ directory: '.', host, store,
    ...(options.acceptedBatch ? { acceptedPromptIdentities: options.acceptedBatch } : {}),
    ...(options.accepted ? { hasAcceptedPrompt: options.accepted } : {}) })
  opened.push(service); service.start(); options.beforeFirstSnapshot?.(); fake.emit()
  return { fake, host, store, service, emit: (record: UsageTokenObservation) => observation!(record) }
}

describe('host usage collection service', () => {
  it('drains bounded recovery passes once and accepts arbitrarily delayed echoes under the original selection', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'sotto-usage-service-')); roots.push(root)
    const store = new UsageStore(join(root, 'usage.sqlite'), () => at)
    store.open()
    for (let index = 0; index < 263; index++) store.submitPrompt({ ...submission, messageId: `pending-${String(index).padStart(3, '0')}`,
      modelId: 'original-selection', kind: 'watcher' })
    store.close()
    const accepted = new Set<string>()
    const evidence = vi.fn((_threadId: string, messageId: string) => accepted.has(messageId))
    const batchEvidence = vi.fn((identities: readonly UsagePromptIdentity[]) => identities.filter(identity => evidence(identity.threadId, identity.messageId)))
    const batches = vi.spyOn(store, 'pendingPromptIdentities')
    const f = fixture({ store, acceptedBatch: batchEvidence })
    // Startup and first host readiness each check at most one bounded batch.
    expect(batches.mock.results.every(result => result.value.length <= 128)).toBe(true)
    evidence.mockClear(); batchEvidence.mockClear()
    for (let snapshot = 0; snapshot < 50; snapshot++) f.fake.emit()
    for (let read = 0; read < 3; read++) expect((await f.service.read()).activity!.totals.prompts.total).toBe(0)
    expect(evidence).not.toHaveBeenCalled()
    expect(batchEvidence).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    expect(evidence).toHaveBeenCalledTimes(128)
    expect(batchEvidence).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(5_000)
    expect(evidence).toHaveBeenCalledTimes(135)
    expect(batchEvidence).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    expect(evidence).toHaveBeenCalledTimes(135)
    const delayed = { ...submission, messageId: 'pending-z', modelId: 'original-selection', kind: 'watcher' as const }
    f.service.submitPrompt(delayed)
    f.service.submitPrompt({ ...delayed, modelId: 'later-selection', kind: 'user' })
    f.service.acceptPrompt(delayed.threadId, delayed.messageId)
    f.service.acceptPrompt(delayed.threadId, delayed.messageId)
    expect((await f.service.read()).activity!.models).toMatchObject([{ modelId: 'original-selection', prompts: { watcher: 1, user: 0 } }])
    expect(evidence).toHaveBeenCalledTimes(135)
    // A real reconnect recovers old durable evidence, including the end of the keyset.
    accepted.add('pending-000'); accepted.add('pending-262')
    f.fake.state.connected = false; f.fake.emit()
    f.fake.state.connected = true; f.fake.emit()
    expect(evidence).toHaveBeenCalledTimes(263)
    vi.advanceTimersByTime(10_000)
    expect(evidence).toHaveBeenCalledTimes(398)
    const result = (await f.service.read()).activity!
    expect(result.totals.prompts).toEqual({ user: 0, watcher: 3, wakeUp: 0, total: 3, steered: 0 })
    expect(batches.mock.results.every(batch => batch.value.length <= 128)).toBe(true)
    expect(batchEvidence.mock.calls.every(([identities]) => identities.length <= 128)).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(evidence).toHaveBeenCalledTimes(398)
    expect(f.fake.commands).toHaveLength(0)
  })

  it('recovers startup acceptance after the first host snapshot even with disconnected providers', async () => {
    const store = new UsageStore(':memory:', () => at)
    store.open(); store.submitPrompt(submission)
    let ready = false
    const evidence = vi.fn(() => ready)
    const f = fixture({ store, accepted: evidence, initiallyConnected: false, beforeFirstSnapshot: () => { ready = true } })
    expect((await f.service.read()).activity!.totals.prompts.user).toBe(1)
    evidence.mockClear()
    for (let snapshot = 0; snapshot < 20; snapshot++) f.fake.emit()
    expect(evidence).not.toHaveBeenCalled()
    expect(f.fake.commands).toHaveLength(0)
  })

  it('coalesces whole streaming replacements and flushes the final counts on close', () => {
    vi.useFakeTimers()
    const f = fixture()
    const write = vi.spyOn(f.store, 'observeTokenBatch')
    f.emit(token()); f.emit(token({ tokens: { input: 100, output: 22, cached: 40 } }))
    // A normal snapshot broadcast must not bypass the stream write interval.
    f.fake.emit()
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(write).toHaveBeenCalledOnce()
    expect(f.store.query().totals.tokens.total.value).toBe(122)
    f.emit(token({ tokens: { input: 100, output: 30, cached: 40 } }))
    f.service.close()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('counts only exact accepted original submissions under the model that served them', async () => {
    const f = fixture()
    f.service.submitPrompt(submission)
    expect((await f.service.read()).activity!.totals.prompts.total).toBe(0)
    f.service.acceptPrompt(submission.threadId, 'another-message')
    expect((await f.service.read()).activity!.totals.prompts.total).toBe(0)
    f.service.acceptPrompt(submission.threadId, submission.messageId)
    f.service.acceptPrompt(submission.threadId, submission.messageId)
    f.emit(token())
    const activity = (await f.service.read()).activity!
    expect(activity.totals.prompts).toEqual({ user: 1, watcher: 0, wakeUp: 0, total: 1, steered: 0 })
    // The token report after the prompt names the served model, so the selection has no row of its own.
    expect(activity.models.find(row => row.modelId === 'selected-model')).toBeUndefined()
    expect(activity.models.find(row => row.modelId === 'native-model')).toMatchObject({ prompts: { total: 1 }, tokens: { total: { value: 120 } } })
  })

  it('retries numeric submission and acceptance after a failed save without executing native work', async () => {
    const f = fixture()
    const save = vi.spyOn(f.store, 'submitPrompt').mockImplementationOnce(() => { throw new Error('synthetic disk failure') })
    expect(() => f.service.submitPrompt(submission)).not.toThrow()
    f.service.acceptPrompt(submission.threadId, submission.messageId)
    const result = await f.service.read()
    expect(result.persistence).toBe('saved')
    expect(result.activity!.totals.prompts.total).toBe(1)
    expect(save).toHaveBeenCalledTimes(2)
    expect(f.fake.commands).toHaveLength(0)
  })

  it('retains failed exact acceptance and recovers pending metadata from text-free evidence', async () => {
    let accepted = false
    const f = fixture({ accepted: () => accepted })
    f.service.submitPrompt(submission)
    vi.spyOn(f.store, 'acceptSubmittedPrompt').mockImplementationOnce(() => { throw new Error('synthetic commit failure') })
    f.service.acceptPrompt(submission.threadId, submission.messageId)
    accepted = true
    expect((await f.service.read()).activity!.totals.prompts.total).toBe(1)
    f.service.discardPrompt(submission.threadId, submission.messageId)
    expect((await f.service.read()).activity!.totals.prompts.total).toBe(1)
    expect(f.fake.commands).toHaveLength(0)
  })
  it('keeps a buffered exact acceptance when later native cleanup tries to discard it', async () => {
    const f = fixture()
    f.service.submitPrompt(submission)
    vi.spyOn(f.store, 'acceptSubmittedPrompt').mockImplementationOnce(() => { throw new Error('synthetic commit failure') })
    f.service.acceptPrompt(submission.threadId, submission.messageId)
    f.service.discardPrompt(submission.threadId, submission.messageId)
    expect((await f.service.read()).activity!.totals.prompts.user).toBe(1)
    expect(f.fake.commands).toHaveLength(0)
  })

  it('drops a definitive refusal and keeps uncertainty uncounted until the echo', async () => {
    const f = fixture()
    f.service.submitPrompt(submission)
    f.service.discardPrompt(submission.threadId, submission.messageId)
    f.service.acceptPrompt(submission.threadId, submission.messageId)
    expect((await f.service.read()).activity!.totals.prompts.total).toBe(0)
    f.service.submitPrompt({ ...submission, messageId: 'uncertain', kind: 'watcher', inputKind: 'steer' })
    expect((await f.service.read()).activity!.totals.prompts.total).toBe(0)
    f.service.acceptPrompt(submission.threadId, 'uncertain')
    expect((await f.service.read()).activity!.totals.prompts).toEqual({ user: 0, watcher: 1, wakeUp: 0, total: 1, steered: 1 })
  })

  it('requires a fresh clear revision after buffered usage and keeps old replay suppressed', async () => {
    const f = fixture()
    f.emit(token())
    const before = (await f.service.read()).activity!
    f.emit(token({ tokens: { input: 100, output: 25 } }))
    expect((await f.service.clear({ expectedRevision: before.metadata.revision })).status).toBe('stale')
    const latest = (await f.service.read()).activity!
    expect((await f.service.clear({ expectedRevision: latest.metadata.revision })).status).toBe('cleared')
    f.emit(token({ recordKey: hash('other-tick'), tokens: { input: 500, output: 20 } }))
    expect((await f.service.read()).activity!.totals.tokenRecords).toBe(0)
    f.emit(token({ recordKey: hash('new-request'), groupKey: hash('new-turn'), liveNewGroup: true }))
    expect((await f.service.read()).activity!.totals.tokens.total.value).toBe(120)
  })

  it('reads cached native metadata and deduplicates explicit refresh without prompting', async () => {
    const f = fixture()
    const quota = parseCodexQuota({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } }, at)
    let finish: (() => void) | undefined
    const read = vi.fn(async (_provider: string, refresh: boolean) => {
      if (refresh) await new Promise<void>(resolve => { finish = resolve })
      return quota
    })
    f.host.readProviderQuota = read
    const cached = await f.service.read()
    expect(cached.quotas[0]!.windows[0]!.usedPercent).toBe(0)
    expect(read).toHaveBeenCalledWith('codex', false)
    const first = f.service.refresh(['codex']), second = f.service.refresh(['codex'])
    finish!(); await Promise.all([first, second])
    expect(read.mock.calls.filter(call => call[1])).toHaveLength(1)
    expect(f.fake.commands).toHaveLength(0)
  })

  it('marks a refresh Usage made on its own, and never lets Read again wait on one (#1456)', async () => {
    const f = fixture()
    const quota = parseCodexQuota({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } }, at)
    let finish: (() => void) | undefined
    const read = vi.fn(async (_provider: string, _refresh: boolean, background?: boolean) => {
      if (background) await new Promise<void>(resolve => { finish = resolve })
      return quota
    })
    f.host.readProviderQuota = read
    const background = f.service.refresh(['codex'], true), another = f.service.refresh(['codex'], true)
    // Read again reads for itself while the one Usage made on its own is still under way.
    await f.service.refresh(['codex'])
    expect(read.mock.calls).toEqual([['codex', true, true], ['codex', true]])
    finish!(); await Promise.all([background, another])
    expect(read).toHaveBeenCalledTimes(2)
    // One Usage made on its own joins a Read again under way rather than asking again.
    let release: (() => void) | undefined
    read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return quota })
    const asked = f.service.refresh(['codex']), quiet = f.service.refresh(['codex'], true)
    release!(); await Promise.all([asked, quiet])
    expect(read).toHaveBeenCalledTimes(3)
    expect(f.fake.commands).toHaveLength(0)
  })

  it('keeps the reading of a later read when an earlier one finishes after it (#1456)', async () => {
    const f = fixture()
    const older = parseCodexQuota({ rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300 } } }, at)
    const newer = parseCodexQuota({ rateLimits: { primary: { usedPercent: 64, windowDurationMins: 300 } } }, at)
    let finish: (() => void) | undefined
    f.host.readProviderQuota = vi.fn(async (_provider: string, _refresh: boolean, background?: boolean) => {
      if (!background) return newer
      await new Promise<void>(resolve => { finish = resolve })
      return older
    })
    const opened = f.service.refresh(['codex'], true)
    expect((await f.service.refresh(['codex'])).quotas[0]!.windows[0]!.usedPercent).toBe(64)
    finish!()
    expect((await opened).quotas[0]!.windows[0]!.usedPercent).toBe(64)
    // A read of the last reading while Read again is under way takes no place ahead of it.
    let release: (() => void) | undefined
    const newest = parseCodexQuota({ rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300 } } }, at)
    f.host.readProviderQuota = vi.fn(async (_provider: string, refresh: boolean) => {
      if (!refresh) return newer
      await new Promise<void>(resolve => { release = resolve })
      return newest
    })
    const again = f.service.refresh(['codex'])
    expect((await f.service.read()).quotas[0]!.windows[0]!.usedPercent).toBe(64)
    release!()
    expect((await again).quotas[0]!.windows[0]!.usedPercent).toBe(80)
    // A failure later still shows the newest reading's figures.
    f.host.readProviderQuota = vi.fn(async () => { throw new Error('synthetic failure') })
    expect((await f.service.refresh(['codex'])).quotas[0]).toMatchObject({ status: 'error', reason: 'read-failed', windows: [{ usedPercent: 80 }] })
  })

  it('reports a failed store separately while account metadata remains available', async () => {
    const store = new UsageStore(':memory:')
    vi.spyOn(store, 'open').mockImplementation(() => { throw new Error('synthetic open failure') })
    const f = fixture({ store })
    f.host.readProviderQuota = async () => parseCodexQuota({ rateLimits: { primary: { usedPercent: 20 } } }, at)
    const result = await f.service.read()
    expect(result).toMatchObject({ status: 'error', persistence: 'failed' })
    expect(result.quotas[0]!.windows[0]!.usedPercent).toBe(20)
    await expect(f.service.clear({ expectedRevision: 0 })).rejects.toThrow('could not be saved')
    expect(f.fake.commands).toHaveLength(0)
  })

  it('saves a backlog of token records in one transaction per batch, with the rows and revision one save per record gives', () => {
    const f = fixture()
    // The first snapshot's seed mark goes first, so only the backlog is counted below.
    f.service.flush()
    const records = Array.from({ length: USAGE_HISTORY_BATCH_MAX + 500 }, (_, index) => token({ recordKey: hash(`backlog-${index}`),
      groupKey: hash(`backlog-turn-${index % 7}`), tokens: { input: index, output: 1 } }))
    for (const record of records) f.emit(record)
    // A whole replacement still arriving in the buffer, and a row it already holds, change nothing about the batching.
    f.emit({ ...records[3]!, tokens: { input: 9_999, output: 1 } })
    const begins = vi.spyOn(DatabaseSync.prototype, 'exec')
    f.service.flush()
    expect(begins.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(Math.ceil(records.length / USAGE_HISTORY_BATCH_MAX))
    begins.mockRestore()

    const reference = new UsageStore(':memory:', () => at)
    reference.open()
    try {
      reference.markLegacySeedCompleted()
      for (const record of [records[0]!, records[1]!, records[2]!, { ...records[3]!, tokens: { input: 9_999, output: 1 } }, ...records.slice(4)]) {
        reference.observeTokens(record)
      }
      expect(f.store.metadata().revision).toBe(reference.metadata().revision)
      expect(f.store.query().totals).toEqual(reference.query().totals)
    } finally { reference.close() }
  })

  it('keeps a failed batch buffered for the retry and saves the prompts after the token records', async () => {
    const f = fixture()
    f.service.flush()
    const save = f.store.observeTokenBatch.bind(f.store)
    const write = vi.spyOn(f.store, 'observeTokenBatch')
    const prompts = vi.spyOn(f.store, 'submitPrompt')
    // The first batch commits; the second fails and nothing after it is attempted.
    write.mockImplementationOnce(save).mockImplementationOnce(() => { throw new Error('synthetic disk failure') })
    const count = USAGE_HISTORY_BATCH_MAX + 10
    for (let index = 0; index < count; index++) f.emit(token({ recordKey: hash(`retry-${index}`), tokens: { input: 1, output: 1 } }))
    f.service.submitPrompt(submission)
    expect(write).toHaveBeenCalledTimes(2)
    expect(prompts).not.toHaveBeenCalled()
    expect(f.store.query().totals.tokenRecords).toBe(USAGE_HISTORY_BATCH_MAX)
    const result = await f.service.read()
    expect(result.persistence).toBe('saved')
    expect(result.activity!.totals.tokenRecords).toBe(count)
    expect(write).toHaveBeenCalledTimes(3)
    expect(write.mock.calls[2]![0]).toHaveLength(10)
    expect(prompts).toHaveBeenCalledOnce()
    expect(prompts.mock.invocationCallOrder[0]).toBeGreaterThan(write.mock.invocationCallOrder[2]!)
  })
})

describe('host usage history import', () => {
  it('answers with activity while a provider is slow to say its limits, and keeps the reading for later', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.emit(token()); f.service.flush()
    const quota = parseCodexQuota({ rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } } }, at)
    let finish: (() => void) | undefined
    f.host.readProviderQuota = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve }); return quota })
    const pending = f.service.read()
    await vi.advanceTimersByTimeAsync(6_000)
    const slow = await pending
    expect(slow.activity!.totals.tokens.total.value).toBe(120)
    expect(slow.quotas[0]).toMatchObject({ providerId: 'codex', status: 'unavailable', reason: 'not-read' })
    finish!(); await vi.advanceTimersByTimeAsync(0)
    f.host.readProviderQuota = vi.fn(async () => { await new Promise<void>(() => undefined); return quota })
    const later = f.service.read()
    await vi.advanceTimersByTimeAsync(6_000)
    expect((await later).quotas[0]!.windows[0]!.usedPercent).toBe(30)
  })

  it('dates a counted row from history without counting it twice, and Clear keeps older history out', async () => {
    const store = new UsageStore(':memory:', () => at)
    let rows: UsageTokenObservation[] = []
    const fake = new FakeProviderHost()
    fake.state.connected = true
    fake.state.threads[0]!.providerId = 'codex'
    let observation: ((record: UsageTokenObservation) => void) | undefined
    const host: AgentHost = fake
    host.subscribeUsage = listener => { observation = listener; return () => { observation = undefined } }
    host.scanUsageHistory = async sink => { sink.tokens(rows) }
    const service = new UsageService({ directory: '.', host, store })
    opened.push(service); service.start(); fake.emit()
    const undated = token({ phase: 'seed', at: undefined, groupKey: undefined })
    observation!(undated); service.flush()
    expect(store.query().totals.undatedTokenRecords).toBe(1)
    rows = [{ ...undated, at: '2026-09-20T10:00:00.000Z', phase: 'replay', origin: 'history' }]
    await service.read()
    await vi.waitFor(() => expect(store.metadata().history?.status).toBe('complete'))
    const dated = store.query({ from: '2026-09-01', to: '2026-09-30', timeZone: 'UTC' })
    expect(dated.totals.tokens.total.value).toBe(120)
    expect(store.query().totals).toMatchObject({ tokenRecords: 1, undatedTokenRecords: 0 })
    expect((await service.clear({ expectedRevision: store.metadata().revision })).status).toBe('cleared')
    rows = [{ ...undated, recordKey: hash('older-history'), at: '2026-09-21T10:00:00.000Z', phase: 'replay', origin: 'history', source: 'outside', client: 'codex-cli' },
      { ...undated, recordKey: hash('newer-history'), at: '2026-10-13T10:00:00.000Z', phase: 'replay', origin: 'history', source: 'outside', client: 'codex-cli' }]
    // A read starts another pass once the last one is a minute old.
    const later = Date.now() + 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    await service.read()
    await vi.waitFor(() => expect(store.query().totals.tokenRecords).toBe(1))
    expect(store.query().totals.lastDay).toBe('2026-10-13')
  })
})
