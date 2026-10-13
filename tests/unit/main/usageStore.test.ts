// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageStore } from '../../../src/main/agents/usageStore'
import { usageLocalReadSchema, type UsagePromptSubmission, type UsageTokenObservation } from '../../../src/shared/usageDashboard'

const stores: UsageStore[] = []
const roots: string[] = []
const at = '2026-10-12T10:00:00.000Z'
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const token = (patch: Partial<UsageTokenObservation> = {}): UsageTokenObservation => ({
  providerId: 'claude', threadId: 'thread-1', recordKey: hash('request-1'), groupKey: hash('turn-1'), modelId: 'observed-sonnet',
  tokens: { input: 100, output: 20, cached: 40, cacheWrite: 10, cacheWrite5m: 10, cacheWrite1h: 0 },
  at, phase: 'live', partial: false, ...patch,
})
const prompt = (patch: Partial<UsagePromptSubmission> = {}): UsagePromptSubmission => ({
  providerId: 'claude', threadId: 'thread-1', messageId: 'message-1', modelId: 'selected-sonnet', at,
  kind: 'user', inputKind: 'send', ...patch,
})
function accepted(store: UsageStore, observation: UsagePromptSubmission) {
  const submitted = store.submitPrompt(observation)
  return submitted.status === 'suppressed' ? submitted : store.acceptSubmittedPrompt(observation.threadId, observation.messageId)
}
function pendingIdentities(store: UsageStore) {
  const identities: Array<{ threadId: string; messageId: string }> = []
  store.visitPendingPromptIdentities(identity => identities.push(identity))
  return identities
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-usage-store-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-store-'))
  roots.push(root)
  const path = join(root, 'usage.sqlite')
  let time = at
  const store = new UsageStore(path, () => time)
  stores.push(store)
  store.open()
  return { root, path, store, setTime: (value: string) => { time = value } }
}

describe('host numeric usage store', () => {
  it('rejects a downward Grok exact row after restart even when membership and legacy aggregate are unchanged', async () => {
    const f = await fixture()
    const a = token({ providerId: 'grok', modelId: 'model-a', tokens: { input: 30, output: 10 } })
    const b = token({ providerId: 'grok', modelId: 'model-b', recordKey: hash('model-b'), tokens: { input: 15, output: 3 } })
    f.store.observeTokens(a); f.store.observeTokens(b)
    f.store.observeTokens({ ...a, phase: 'replay', tokens: { input: 10, output: 10 } })
    expect(f.store.query().totals.tokens.total.value).toBeUndefined()
    f.store.observeTokens({ ...b, phase: 'replay' })
    expect(f.store.query().totals.tokens.total).toMatchObject({ value: 18, partial: true })
    expect(f.store.query().models.find(row => row.modelId === 'model-a')!.tokens.total.value).toBeUndefined()
    f.store.close()
    const reopened = new UsageStore(f.path); stores.push(reopened); reopened.open()
    for (let replay = 0; replay < 2; replay++) {
      reopened.observeTokens({ ...a, phase: 'replay', tokens: { input: 10, output: 10 } }); reopened.observeTokens({ ...b, phase: 'replay' })
      expect(reopened.query().totals.tokens.total).toMatchObject({ value: 18, partial: true })
    }
    reopened.observeTokens({ ...a, phase: 'replay' })
    expect(reopened.query().totals.tokens.total).toMatchObject({ value: 58, partial: false })
    reopened.observeTokens({ ...a, phase: 'replay', tokens: { input: 10, output: 10 } })
    reopened.clear(reopened.metadata().revision)
    const database = new DatabaseSync(f.path)
    try { expect(database.prepare('SELECT COUNT(*) AS count FROM grok_conflict_floors').get()!.count).toBe(0) }
    finally { database.close() }
  })
  it('reconciles full Grok membership even after aggregate retirement and repairs reported models', async () => {
    const f = await fixture()
    const a = token({ providerId: 'grok', modelId: 'model-a', recordKey: hash('model-a'), tokens: { input: 30, output: 10 } })
    const b = token({ providerId: 'grok', modelId: 'model-b', recordKey: hash('model-b'), tokens: { input: 15, output: 3 } })
    const members = (...rows: UsageTokenObservation[]) => hash(JSON.stringify(rows.map(row => row.recordKey).sort()))
    const retirement = token({ providerId: 'grok', modelId: 'unknown', recordKey: hash('aggregate'), tokens: {}, removed: true,
      phase: 'replay', partial: true, groupRecordsHash: members(a, b) })
    f.store.observeTokens(a); f.store.observeTokens(b); f.store.observeTokens(retirement)
    const before = f.store.metadata().revision
    expect(f.store.observeTokens(retirement)).toEqual({ status: 'suppressed', revision: before })
    f.store.observeTokens({ ...retirement, phase: 'seed', groupRecordsHash: members(b) })
    expect(f.store.query().totals.tokens.total).toMatchObject({ value: 58, partial: false })
    f.store.observeTokens({ ...retirement, groupRecordsHash: members(b) })
    expect(f.store.query().totals.tokens.total.value).toBeUndefined()
    f.store.observeTokens({ ...b, phase: 'replay', tokens: { input: 20, output: 3 } })
    expect(f.store.query().totals.tokens.total).toMatchObject({ value: 23, partial: true })
    f.store.observeTokens(retirement); f.store.observeTokens(a); f.store.observeTokens({ ...b, tokens: { input: 20, output: 3 } })
    expect(f.store.query().totals.tokens.total).toMatchObject({ value: 63, partial: false })
    f.store.clear(f.store.metadata().revision)
    const cleared = f.store.metadata().revision
    expect(f.store.observeTokens({ ...retirement, groupRecordsHash: members(b) })).toEqual({ status: 'suppressed', revision: cleared })
    expect(f.store.observeTokens(b).status).toBe('suppressed')
    expect(f.store.query().totals.tokenRecords).toBe(0)
  })
  it('retires an ambiguous aggregate without retaining its vector or reviving it through seed', async () => {
    const f = await fixture()
    const aggregate = token({ providerId: 'grok', modelId: 'unknown', tokens: { input: 45, output: 13 }, partial: true })
    f.store.observeTokens(aggregate)
    f.store.observeTokens({ ...aggregate, tokens: {}, removed: true })
    expect(f.store.query().totals.tokenRecords).toBe(0)
    f.store.observeTokens({ ...aggregate, phase: 'seed' })
    f.store.observeTokens(token({ providerId: 'grok', modelId: 'model-a', recordKey: hash('model-a'), tokens: { input: 30, output: 10 } }))
    f.store.observeTokens(token({ providerId: 'grok', modelId: 'model-b', recordKey: hash('model-b'), tokens: { input: 15, output: 3 } }))
    expect(f.store.query().totals.tokens.total.value).toBe(58)
    const before = f.store.metadata().revision
    expect(f.store.observeTokens({ ...aggregate, tokens: {}, removed: true })).toEqual({ status: 'suppressed', revision: before })
  })
  it('imports legacy seed rows without replacing exact native model evidence after restart', async () => {
    const f = await fixture()
    f.store.observeTokens(token({ providerId: 'grok', modelId: 'model-a', tokens: { input: 30, output: 10 } }))
    f.store.observeTokens(token({ providerId: 'grok', modelId: 'model-b', recordKey: hash('request-b'), tokens: { input: 15, output: 3 } }))
    const revision = f.store.metadata().revision
    expect(f.store.observeTokens(token({ providerId: 'grok', modelId: 'unknown', phase: 'seed', partial: true,
      tokens: { input: 45, output: 13 } }))).toEqual({ status: 'unchanged', revision })
    expect(f.store.query().totals.tokens.total.value).toBe(58)
    expect(f.store.query().models.map(row => row.modelId).sort()).toEqual(['model-a', 'model-b'])
    f.store.observeTokens(token({ providerId: 'grok', modelId: 'model-a', phase: 'replay', tokens: { input: 30, output: 12 } }))
    expect(f.store.query().totals.tokens.total.value).toBe(60)
  })
  it('shows contradictory Grok aggregate evidence as unknown rather than an overstated lower bound', async () => {
    const f = await fixture()
    f.store.observeTokens(token({ providerId: 'grok', modelId: 'model-a', tokens: { input: 30, output: 10 } }))
    f.store.observeTokens(token({ providerId: 'grok', modelId: 'model-b', recordKey: hash('request-b'), tokens: { input: 15, output: 3 } }))
    f.store.observeTokens(token({ providerId: 'grok', modelId: 'unknown', partial: true, phase: 'replay', tokens: { input: 15, output: 3 } }))
    expect(f.store.query().totals.tokens.total).toMatchObject({ knownRows: 0, rows: 2, partial: true })
    expect(f.store.query().totals.tokens.total.value).toBeUndefined()
  })
  it('retains uncertain submissions without counting and accepts original metadata after restart', async () => {
    const f = await fixture()
    const original = prompt({ kind: 'watcher', inputKind: 'steer', modelId: 'original-selection', at: '2026-10-11T12:00:00.000Z' })
    expect(f.store.submitPrompt(original)).toEqual({ status: 'written', revision: 1 })
    expect(f.store.query().totals).toMatchObject({ activeThreads: 0, activeDays: 0, prompts: { total: 0 } })
    // An uncertain native result keeps the pending metadata whole until its exact echo arrives.
    f.store.close(); f.store.open()
    expect(f.store.submitPrompt(prompt({ providerId: 'codex', modelId: 'later-model', kind: 'user' }))).toEqual({ status: 'unchanged', revision: 1 })
    expect(pendingIdentities(f.store)).toEqual([{ threadId: original.threadId, messageId: original.messageId }])
    expect(f.store.acceptSubmittedPrompt(original.threadId, original.messageId)).toEqual({ status: 'written', revision: 2 })
    const result = f.store.query()
    expect(result.totals.prompts).toEqual({ user: 0, watcher: 1, wakeUp: 0, total: 1, steered: 1 })
    expect(result.models.map(row => [row.providerId, row.modelId])).toEqual([['claude', 'original-selection']])
    expect(result.daily.map(row => row.day)).toEqual(['2026-10-11'])
    expect(pendingIdentities(f.store)).toEqual([])
    expect(f.store.acceptSubmittedPrompt(original.threadId, original.messageId)).toEqual({ status: 'unchanged', revision: 2 })
    expect(f.store.acceptSubmittedPrompt(original.threadId, 'unknown-message')).toEqual({ status: 'missing', revision: 2 })
    expect(f.store.submitPrompt(original)).toEqual({ status: 'unchanged', revision: 2 })
    expect(f.store.query().totals.prompts.total).toBe(1)
  })

  it('discards only definitive rejected submissions and allows a fresh canonical retry', async () => {
    const f = await fixture()
    const original = prompt()
    f.store.submitPrompt(original)
    expect(f.store.discardSubmittedPrompt(original.threadId, original.messageId)).toEqual({ status: 'written', revision: 2 })
    expect(f.store.acceptSubmittedPrompt(original.threadId, original.messageId)).toEqual({ status: 'missing', revision: 2 })
    expect(pendingIdentities(f.store)).toEqual([])
    const retry = prompt({ providerId: 'codex', modelId: 'retry-selection', inputKind: 'steer' })
    expect(f.store.submitPrompt(retry)).toEqual({ status: 'written', revision: 3 })
    expect(f.store.acceptSubmittedPrompt(retry.threadId, retry.messageId)).toEqual({ status: 'written', revision: 4 })
    const counted = f.store.query()
    expect(counted.models.map(row => [row.providerId, row.modelId])).toEqual([['codex', 'retry-selection']])
    expect(f.store.discardSubmittedPrompt(retry.threadId, retry.messageId)).toEqual({ status: 'unchanged', revision: 4 })
    expect(f.store.query()).toEqual(counted)
  })

  it('hashes and removes pending metadata on Clear so a delayed echo cannot refill counts', async () => {
    const f = await fixture()
    const original = prompt()
    f.store.submitPrompt(original)
    expect(f.store.clear(0).status).toBe('stale')
    expect(pendingIdentities(f.store)).toHaveLength(1)
    f.setTime('2026-10-12T11:00:00.000Z')
    f.store.clear(f.store.metadata().revision)
    f.store.close(); f.store.open()
    expect(pendingIdentities(f.store)).toEqual([])
    expect(f.store.acceptSubmittedPrompt(original.threadId, original.messageId)).toEqual({ status: 'suppressed', revision: 2 })
    expect(f.store.submitPrompt(prompt({ at: '2026-10-12T12:00:00.000Z' }))).toEqual({ status: 'suppressed', revision: 2 })
    const db = new DatabaseSync(f.path)
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM pending_prompt_rows').get()?.count).toBe(0)
      const exclusions = db.prepare('SELECT * FROM exclusions').all()
      expect(exclusions).toHaveLength(1)
      expect(exclusions.every(row => typeof row.identity_hash === 'string' && /^[a-f\d]{64}$/u.test(row.identity_hash))).toBe(true)
    } finally { db.close() }
    const next = prompt({ messageId: 'new-message', at: '2026-10-12T12:00:00.000Z' })
    f.store.submitPrompt(next)
    expect(f.store.query().totals.prompts.total).toBe(0)
    f.store.acceptSubmittedPrompt(next.threadId, next.messageId)
    expect(f.store.query().totals.prompts.user).toBe(1)
  })

  it('retains pending metadata when acceptance commit, discard or Clear fails', async () => {
    const f = await fixture()
    const original = prompt()
    f.store.submitPrompt(original)
    const db = new DatabaseSync(f.path)
    try {
      // A deferred foreign key fails COMMIT after both the insert and pending deletion ran.
      db.exec(`CREATE TABLE commit_fixture (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES commit_fixture(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_accept AFTER INSERT ON prompt_rows BEGIN INSERT INTO commit_fixture VALUES (1,2); END`)
      expect(() => f.store.acceptSubmittedPrompt(original.threadId, original.messageId)).toThrow('FOREIGN KEY')
      expect(f.store.metadata().revision).toBe(1)
      expect(f.store.query().totals.prompts.total).toBe(0)
      expect(pendingIdentities(f.store)).toHaveLength(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM commit_fixture').get()?.count).toBe(0)
      db.exec('DROP TRIGGER reject_accept')
      db.exec("CREATE TRIGGER reject_discard BEFORE DELETE ON pending_prompt_rows BEGIN SELECT RAISE(ABORT,'fixture discard failure'); END")
      expect(() => f.store.discardSubmittedPrompt(original.threadId, original.messageId)).toThrow('fixture discard failure')
      expect(() => f.store.clear(1)).toThrow('fixture discard failure')
      expect(f.store.metadata()).toMatchObject({ revision: 1, generation: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM exclusions').get()?.count).toBe(0)
      f.store.close(); f.store.open()
      expect(pendingIdentities(f.store)).toHaveLength(1)
      db.exec('DROP TRIGGER reject_discard')
      expect(f.store.acceptSubmittedPrompt(original.threadId, original.messageId)).toEqual({ status: 'written', revision: 2 })
      expect(pendingIdentities(f.store)).toEqual([])
      expect(f.store.query().totals.prompts.total).toBe(1)
    } finally { db.close() }
  })

  it('replaces streamed rows, deduplicates repeats and survives closing without double charging cache subsets', async () => {
    const f = await fixture()
    expect(f.store.observeTokens(token())).toEqual({ status: 'written', revision: 1 })
    expect(f.store.observeTokens(token())).toEqual({ status: 'unchanged', revision: 1 })
    f.store.observeTokens(token({ tokens: { input: 120, output: 30, cached: 50, cacheWrite: 10 }, partial: true }))
    const totals = f.store.query().totals
    expect(totals.tokenRecords).toBe(1)
    expect(totals.tokens.input.value).toBe(120)
    expect(totals.tokens.total.value).toBe(150)
    expect(totals.tokens.cached.value).toBe(50)
    expect(totals.tokens.cacheWrite.value).toBe(10)
    expect(totals.tokens.cacheWrite5m.value).toBeUndefined()
    expect(totals.tokens.total.partial).toBe(true)
    f.store.close(); f.store.open()
    expect(f.store.query().totals).toEqual(totals)
    expect(f.store.observeTokens(token({ tokens: { input: 120, output: 30, cached: 50, cacheWrite: 10 }, partial: true, phase: 'replay' }))).toEqual({ status: 'unchanged', revision: 2 })
    expect(usageLocalReadSchema.safeParse(f.store.query()).success).toBe(true)
  })

  it('distinguishes missing fields from known zero and reports coverage for each field', async () => {
    const f = await fixture()
    f.store.observeTokens(token({ tokens: { input: 0, output: 0, cached: 0 } }))
    f.store.observeTokens(token({ recordKey: hash('request-2'), tokens: { input: 10 } }))
    const { tokens } = f.store.query().totals
    expect(tokens.input).toEqual({ value: 10, knownRows: 2, rows: 2, partial: false })
    expect(tokens.output).toEqual({ value: 0, knownRows: 1, rows: 2, partial: true })
    expect(tokens.cached).toEqual({ value: 0, knownRows: 1, rows: 2, partial: true })
    expect(tokens.cacheWrite).toEqual({ knownRows: 0, rows: 2, partial: true })
    expect(tokens.total).toEqual({ value: 0, knownRows: 1, rows: 2, partial: true })
  })

  it('preserves earliest real dates, keeps seed rows undated and filters provider/model/dates without reading text', async () => {
    const f = await fixture()
    f.store.observeTokens(token({ phase: 'seed', at: undefined }))
    f.store.observeTokens(token({ recordKey: hash('request-2'), providerId: 'codex', modelId: 'gpt-5', at: '2026-10-11T12:00:00.000Z' }))
    f.store.observeTokens(token({ recordKey: hash('request-2'), providerId: 'codex', modelId: 'gpt-5', at: '2026-10-12T12:00:00.000Z', phase: 'replay' }))
    expect(f.store.query().totals.undatedTokenRecords).toBe(1)
    expect(f.store.query({ from: '2026-10-11', to: '2026-10-11' }).totals.tokenRecords).toBe(1)
    expect(f.store.query({ from: '2026-10-12' }).totals.tokenRecords).toBe(0)
    expect(f.store.query({ providerIds: ['claude'] }).totals.tokenRecords).toBe(1)
    expect(f.store.query({ providerIds: ['codex'], modelIds: ['gpt-5'] }).totals.tokenRecords).toBe(1)
    expect(f.store.query({ modelIds: ['unobserved'] }).totals.tokenRecords).toBe(0)
    expect(f.store.query({ providerIds: [] }).totals.tokenRecords).toBe(0)
    f.store.close(); f.store.open()
    expect(f.store.query().daily.map(bucket => bucket.day)).toEqual(['2026-10-11'])
  })

  it('counts accepted canonical prompts once and distinguishes automation and selected models from token models', async () => {
    const f = await fixture()
    accepted(f.store, prompt())
    expect(accepted(f.store, prompt({ providerId: 'codex', modelId: 'changed-selection' })).status).toBe('unchanged')
    accepted(f.store, prompt({ messageId: 'message-2', kind: 'watcher' }))
    accepted(f.store, prompt({ messageId: 'message-3', kind: 'wake-up', inputKind: 'steer', threadId: 'thread-2', at: '2026-10-11T12:00:00.000Z' }))
    f.store.observeTokens(token())
    const result = f.store.query()
    expect(result.totals.prompts).toEqual({ user: 1, watcher: 1, wakeUp: 1, total: 3, steered: 1 })
    expect(result.totals.activeThreads).toBe(2)
    expect(result.totals.activeDays).toBe(2)
    expect(result.models.find(row => row.modelId === 'observed-sonnet')?.prompts.total).toBe(0)
    expect(result.models.find(row => row.modelId === 'selected-sonnet')?.tokenRecords).toBe(0)
    f.store.close(); f.store.open()
    expect(accepted(f.store, prompt()).status).toBe('unchanged')
    expect(f.store.query().totals.prompts.total).toBe(3)
  })

  it('clears atomically with a revision guard and retains seed completion plus hashes alone', async () => {
    const f = await fixture()
    f.store.markLegacySeedCompleted()
    f.store.observeTokens(token())
    accepted(f.store, prompt())
    const before = f.store.query()
    expect(f.store.clear(before.metadata.revision - 1)).toEqual({ status: 'stale', metadata: before.metadata })
    expect(f.store.query()).toEqual(before)
    f.setTime('2026-10-12T11:00:00.000Z')
    expect(f.store.clear(before.metadata.revision)).toEqual({
      status: 'cleared', metadata: { ...before.metadata, revision: before.metadata.revision + 1, generation: 1, clearedAt: '2026-10-12T11:00:00.000Z' },
    })
    expect(f.store.query().totals).toMatchObject({ tokenRecords: 0, prompts: { total: 0 } })
    const db = new DatabaseSync(f.path)
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM token_rows').get()?.count).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS count FROM prompt_rows').get()?.count).toBe(0)
      const exclusions = db.prepare('SELECT * FROM exclusions').all()
      expect(exclusions).toHaveLength(3)
      expect(exclusions.every(row => typeof row.identity_hash === 'string' && /^[a-f\d]{64}$/u.test(row.identity_hash))).toBe(true)
    } finally { db.close() }
  })

  it('prevents active-group stream updates and native replay from resurrecting erased figures after restart', async () => {
    const f = await fixture()
    f.store.observeTokens(token())
    accepted(f.store, prompt())
    f.setTime('2026-10-12T11:00:00.000Z')
    f.store.clear(f.store.metadata().revision)
    f.store.close(); f.store.open()
    const clearedRevision = f.store.metadata().revision
    expect(f.store.observeTokens(token({ recordKey: hash('stream-next'), tokens: { input: 999, output: 200 }, at: '2026-10-12T12:00:00.000Z', liveNewGroup: true })).status).toBe('suppressed')
    expect(f.store.observeTokens(token({ recordKey: hash('old-unseen'), groupKey: hash('old-unseen-group'), phase: 'replay', at: '2026-10-12T12:00:00.000Z' })).status).toBe('suppressed')
    expect(f.store.observeTokens(token({ recordKey: hash('undated-unseen'), groupKey: undefined, phase: 'seed', at: undefined })).status).toBe('suppressed')
    expect(accepted(f.store, prompt({ at: '2026-10-12T12:00:00.000Z' })).status).toBe('suppressed')
    expect(accepted(f.store, prompt({ messageId: 'historical-unseen', at })).status).toBe('suppressed')
    expect(f.store.metadata().revision).toBe(clearedRevision)
    expect(f.store.query().totals.tokenRecords).toBe(0)
    const newGroup = token({ recordKey: hash('new-request'), groupKey: hash('new-turn'), groupStartedAt: '2026-10-12T12:00:00.000Z', at: undefined, phase: 'replay' })
    expect(f.store.observeTokens(newGroup).status).toBe('written')
    expect(f.store.observeTokens({ ...newGroup, recordKey: hash('new-request-next'), groupStartedAt: undefined, tokens: { input: 10, output: 5 } }).status).toBe('written')
    expect(accepted(f.store, prompt({ messageId: 'new-message', at: '2026-10-12T12:00:00.000Z' })).status).toBe('written')
    expect(f.store.query().totals).toMatchObject({ tokenRecords: 2, prompts: { user: 1 }, tokens: { total: { value: 135 } } })
  })

  it('admits adapter-proved new live groups without inventing event dates', async () => {
    const f = await fixture()
    f.store.clear(0)
    expect(f.store.observeTokens(token({ at: undefined, liveNewGroup: true })).status).toBe('written')
    expect(f.store.query().totals.undatedTokenRecords).toBe(1)
    f.store.close(); f.store.open()
    expect(f.store.observeTokens(token({ at: undefined, phase: 'replay' })).status).toBe('unchanged')
  })

  it('bounds model and daily responses without losing all-time totals', async () => {
    const f = await fixture()
    for (let index = 0; index < 205; index += 1) {
      f.store.observeTokens(token({ recordKey: hash(`request-${index}`), modelId: `model-${index}`, tokens: { input: index, output: 0 } }))
    }
    f.store.observeTokens(token({ recordKey: hash('old-request'), at: '2024-01-01T00:00:00.000Z' }))
    const result = f.store.query()
    expect(result.models).toHaveLength(200)
    expect(result.modelCount).toBe(206)
    expect(result.modelsTruncated).toBe(true)
    expect(result.totals.tokenRecords).toBe(206)
    expect(result.daily).toEqual([])
    expect(result.dailyCoverage).toBe('omitted-range')
    expect(f.store.query({ from: '2026-10-12', to: '2026-10-12' }).daily).toHaveLength(1)
    expect(f.store.query({ includeDaily: false }).dailyCoverage).toBe('not-requested')
  })

  it('rejects unsafe totals and failed writes without advancing durable dedup or revision', async () => {
    const f = await fixture()
    const db = new DatabaseSync(f.path)
    try {
      db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON token_rows BEGIN SELECT RAISE(ABORT,'fixture failure'); END")
      expect(() => f.store.observeTokens(token())).toThrow('fixture failure')
      expect(f.store.metadata().revision).toBe(0)
      expect(f.store.query().totals.tokenRecords).toBe(0)
      db.exec('DROP TRIGGER reject_usage')
      expect(f.store.observeTokens(token())).toEqual({ status: 'written', revision: 1 })
      f.store.observeTokens(token({ recordKey: hash('large-request'), tokens: { input: Number.MAX_SAFE_INTEGER, output: 0 } }))
      expect(() => f.store.query()).toThrow('Usage count exceeds its supported range')
      expect(() => f.store.observeTokens(token({ tokens: { input: Number.MAX_SAFE_INTEGER + 1 } }))).toThrow()
    } finally { db.close() }
  })

  it('returns at most 366 complete daily buckets and explicitly omits a longer range', async () => {
    const f = await fixture()
    const start = Date.parse('2025-10-12T00:00:00.000Z')
    for (let index = 0; index < 366; index += 1) {
      f.store.observeTokens(token({ recordKey: hash(`day-${index}`), at: new Date(start + index * 86_400_000).toISOString() }))
    }
    const full = f.store.query()
    expect(full.daily).toHaveLength(366)
    expect(full.dailyCoverage).toBe('complete')
    f.store.observeTokens(token({ recordKey: hash('day-366'), at: new Date(start + 366 * 86_400_000).toISOString() }))
    expect(f.store.query()).toMatchObject({ daily: [], dailyCoverage: 'omitted-range', totals: { tokenRecords: 367 } })
  })

  it('uses one requested calendar across hosts for Pacific midnight, filters and active days', async () => {
    const fixtures = [await fixture(), await fixture()]
    for (const f of fixtures) {
      f.store.observeTokens(token({ recordKey: hash('before-midnight'), modelId: 'calendar-model', at: '2026-10-12T06:59:59.000Z', tokens: { input: 0, output: 0 } }))
      f.store.observeTokens(token({ recordKey: hash('after-midnight'), modelId: 'calendar-model', at: '2026-10-12T07:00:00.000Z', tokens: {} }))
      f.store.observeTokens(token({ recordKey: hash('undated-calendar'), modelId: 'calendar-model', at: undefined, phase: 'seed' }))
      accepted(f.store, prompt({ messageId: 'before-midnight', modelId: 'calendar-model', at: '2026-10-12T06:59:59.000Z' }))
      accepted(f.store, prompt({ messageId: 'after-midnight', modelId: 'calendar-model', kind: 'watcher', at: '2026-10-12T07:00:00.000Z' }))
      accepted(f.store, prompt({ providerId: 'codex', messageId: 'other-provider', modelId: 'other-model', kind: 'wake-up', at: '2026-10-12T08:30:00.000Z' }))
    }
    const [first, second] = fixtures
    if (first === undefined || second === undefined) throw new Error('Missing calendar fixtures')
    expect(first.store.query().timeZone).toBe('UTC')
    expect(first.store.query().totals.activeDays).toBe(1)
    const query = { timeZone: 'America/Los_Angeles', from: '2026-10-11', to: '2026-10-11', providerIds: ['claude' as const], modelIds: ['calendar-model'] }
    const before = first.store.query(query)
    expect(before.totals).toMatchObject({ tokenRecords: 1, activeDays: 1, tokens: { total: { value: 0 } }, prompts: { user: 1, total: 1 } })
    expect(before.daily.map(row => row.day)).toEqual(['2026-10-11'])
    expect(before.hourly).toEqual([{ weekday: 6, hour: 23, prompts: { user: 1, watcher: 0, wakeUp: 0, total: 1, steered: 0 } }])
    expect(second.store.query(query)).toEqual(before)
    const after = first.store.query({ ...query, from: '2026-10-12', to: '2026-10-12' })
    expect(after.totals.tokens.total).toEqual({ knownRows: 0, rows: 1, partial: true })
    expect(after.totals.undatedTokenRecords).toBe(0)
    expect(after.hourly).toEqual([{ weekday: 0, hour: 0, prompts: { user: 0, watcher: 1, wakeUp: 0, total: 1, steered: 0 } }])
    const all = first.store.query({ timeZone: 'America/Los_Angeles' })
    expect(all.totals.activeDays).toBe(2)
    expect(all.totals.undatedTokenRecords).toBe(1)
    expect(all.hourly.reduce((total, cell) => total + cell.prompts.total, 0)).toBe(all.totals.prompts.total)
    const db = new DatabaseSync(first.path)
    try { expect(db.prepare('SELECT at FROM token_rows WHERE record_key=?').get(hash('before-midnight'))?.at).toBe('2026-10-12T06:59:59.000Z') } finally { db.close() }
  })

  it.each([
    { timeZone: 'Pacific/Kiritimati', first: '2026-10-11T10:00:00.000Z', last: '2026-10-12T09:59:59.000Z' },
    { timeZone: 'Pacific/Pago_Pago', first: '2026-10-12T11:00:00.000Z', last: '2026-10-13T10:59:59.000Z' },
  ])('filters UTC history before converting the full local day in $timeZone', async ({ timeZone, first, last }) => {
    const f = await fixture()
    // A real archive larger than the instant cache exposes any full-history Intl pass.
    const db = new DatabaseSync(f.path)
    try {
      const insert = db.prepare('INSERT INTO token_rows (provider,thread_id,record_key,model_id,at,day,partial,input,output) VALUES (?,?,?,?,?,?,0,100,20)')
      const insertPrompt = db.prepare("INSERT INTO prompt_rows VALUES (?,?,?,?,?,?,'user','send')")
      db.exec('BEGIN')
      for (let index = 0; index < 1_024; index++) {
        const instant = new Date(Date.parse('2024-01-01T00:00:00Z') + index * 60_000).toISOString()
        insert.run('claude', 'archive-thread', hash(`archive-${index}`), 'archive-model', instant, instant.slice(0, 10))
        insertPrompt.run('archive-thread', `archive-${index}`, 'claude', 'archive-model', instant, instant.slice(0, 10))
      }
      db.exec('COMMIT')
    } finally { db.close() }
    const instants = [new Date(Date.parse(first) - 1_000).toISOString(), first, last, new Date(Date.parse(last) + 1_000).toISOString()]
    for (const [index, instant] of instants.entries()) {
      f.store.observeTokens(token({ recordKey: hash(`edge-${index}`), at: instant }))
      accepted(f.store, prompt({ messageId: `edge-${index}`, at: instant }))
    }
    f.store.observeTokens(token({ recordKey: hash('undated'), at: undefined, phase: 'seed' }))
    const formatted = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
    const result = f.store.query({ timeZone, from: '2026-10-12', to: '2026-10-12' })
    expect(result.totals).toMatchObject({ tokenRecords: 2, undatedTokenRecords: 0, prompts: { total: 2 }, tokens: { total: { value: 240 } } })
    expect(result.daily.map(row => row.day)).toEqual(['2026-10-12'])
    expect(formatted).toHaveBeenCalled()
    expect(formatted.mock.calls.every(([instant]) => instant instanceof Date && instant.getUTCFullYear() === 2026)).toBe(true)
  })

  it('reuses unchanged numeric queries defensively and invalidates them for writes, Clear and reopening', async () => {
    const f = await fixture()
    f.store.observeTokens(token())
    const formatted = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
    const query = { timeZone: 'America/Los_Angeles' }
    const first = f.store.query(query)
    const calls = formatted.mock.calls.length
    first.totals.tokens.total.value = 1
    first.models.length = 0
    expect(f.store.query(query)).toMatchObject({ totals: { tokens: { total: { value: 120 } } }, models: [{ modelId: 'observed-sonnet' }] })
    expect(formatted).toHaveBeenCalledTimes(calls)
    f.store.observeTokens(token({ tokens: { input: 100, output: 25 } }))
    expect(f.store.query(query).totals.tokens.total.value).toBe(125)
    f.store.clear(f.store.metadata().revision)
    expect(f.store.query(query).totals.tokenRecords).toBe(0)
    f.store.observeTokens(token({ recordKey: hash('new-cache-record'), groupKey: hash('new-cache-group'), liveNewGroup: true }))
    expect(f.store.query(query).totals.tokens.total.value).toBe(120)
    const beforeReopen = formatted.mock.calls.length
    f.store.close(); f.store.open()
    expect(f.store.query(query).totals.tokens.total.value).toBe(120)
    expect(formatted.mock.calls.length).toBeGreaterThan(beforeReopen)
  })

  it.each([
    {
      name: 'spring forward', day: '2026-03-08',
      instants: ['2026-03-08T08:00:00Z', '2026-03-08T09:30:00Z', '2026-03-08T10:00:00Z', '2026-03-09T06:59:00Z', '2026-03-09T07:00:00Z'],
      hours: [0, 1, 3, 23], counts: [1, 1, 1, 1],
    },
    {
      name: 'fall back', day: '2026-11-01',
      instants: ['2026-11-01T07:00:00Z', '2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z', '2026-11-02T07:59:00Z', '2026-11-02T08:00:00Z'],
      hours: [0, 1, 23], counts: [1, 2, 1],
    },
  ])('reconciles date/model/provider/hour totals through Pacific $name', async ({ day, instants, hours, counts }) => {
    const f = await fixture()
    for (const [index, instant] of instants.entries()) {
      f.store.observeTokens(token({ recordKey: hash(`dst-${index}`), modelId: 'dst-model', at: instant }))
      accepted(f.store, prompt({ messageId: `dst-${index}`, modelId: 'dst-model', at: instant, kind: index % 2 === 0 ? 'user' : 'watcher' }))
    }
    const result = f.store.query({ timeZone: 'America/Los_Angeles', from: day, to: day, providerIds: ['claude'], modelIds: ['dst-model'] })
    expect(result.totals).toMatchObject({ tokenRecords: 4, activeDays: 1, prompts: { total: 4 }, tokens: { total: { value: 480 } } })
    expect(result.daily.map(row => row.day)).toEqual([day])
    expect(result.hourly.map(cell => cell.weekday)).toEqual(hours.map(() => 6))
    expect(result.hourly.map(cell => cell.hour)).toEqual(hours)
    expect(result.hourly.map(cell => cell.prompts.total)).toEqual(counts)
    expect(result.hourly.reduce((total, cell) => total + cell.prompts.total, 0)).toBe(result.daily[0]?.prompts.total)
    expect(result.models[0]?.prompts.total).toBe(result.providers[0]?.prompts.total)
    f.store.close(); f.store.open()
    expect(f.store.query({ timeZone: 'America/Los_Angeles', from: day, to: day })).toEqual(result)
  })

  it('bounds a complete Monday-based hour grid at 168 cells while retaining prompt kinds and duplicates', async () => {
    const f = await fixture()
    const start = Date.parse('2026-10-12T00:00:00Z')
    for (let index = 0; index < 168; index += 1) {
      const observation = prompt({ messageId: `hour-${index}`, at: new Date(start + index * 3_600_000).toISOString(), kind: index % 3 === 0 ? 'user' : index % 3 === 1 ? 'watcher' : 'wake-up' })
      accepted(f.store, observation)
      if (index === 0) accepted(f.store, observation)
    }
    const result = f.store.query()
    expect(result.hourly).toHaveLength(168)
    expect(result.hourly[0]).toMatchObject({ weekday: 0, hour: 0 })
    expect(result.hourly[167]).toMatchObject({ weekday: 6, hour: 23 })
    expect(result.totals.prompts).toEqual({ user: 56, watcher: 56, wakeUp: 56, total: 168, steered: 0 })
    expect(result.hourly.reduce((total, cell) => total + cell.prompts.total, 0)).toBe(168)
    expect(result.daily.reduce((total, bucket) => total + bucket.prompts.total, 0)).toBe(168)
    expect(result.totals.tokens.input.value).toBeUndefined()
    expect(usageLocalReadSchema.safeParse({ ...result, hourly: [...result.hourly, result.hourly[0]] }).success).toBe(false)
    expect(() => f.store.query({ timeZone: 'invalid-zone' })).toThrow()
  })
})
