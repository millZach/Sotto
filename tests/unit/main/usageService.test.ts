// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHost } from '../../../src/main/agents/host'
import { UsageService } from '../../../src/main/agents/usageService'
import { UsageStore } from '../../../src/main/agents/usageStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import type { UsagePromptSubmission, UsageTokenObservation } from '../../../src/shared/usageDashboard'
import { parseCodexQuota } from '../../../src/main/agents/providerQuota'

const at = '2026-10-12T12:00:00.000Z'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const submission: UsagePromptSubmission = { providerId: 'codex', threadId: 'thread-1', messageId: 'message-1',
  modelId: 'selected-model', at, kind: 'user', inputKind: 'send' }
const token = (patch: Partial<UsageTokenObservation> = {}): UsageTokenObservation => ({ providerId: 'codex', threadId: 'thread-1',
  modelId: 'native-model', recordKey: hash('request'), groupKey: hash('turn'), at, phase: 'live', partial: false,
  tokens: { input: 100, output: 20, cached: 40 }, ...patch })
const opened: UsageService[] = []
afterEach(() => { for (const service of opened.splice(0)) service.close(); vi.restoreAllMocks(); vi.useRealTimers() })

function fixture(options: { store?: UsageStore; accepted?: (threadId: string, messageId: string) => boolean } = {}) {
  const fake = new FakeProviderHost()
  fake.state.connected = true
  fake.state.threads[0]!.providerId = 'codex'
  fake.state.models[0]!.providerId = 'codex'
  let observation: ((record: UsageTokenObservation) => void) | undefined
  const host: AgentHost = fake
  host.subscribeUsage = listener => { observation = listener; return () => { observation = undefined } }
  const store = options.store ?? new UsageStore(':memory:', () => at)
  const service = new UsageService({ directory: '.', host, store,
    ...(options.accepted ? { hasAcceptedPrompt: options.accepted } : {}) })
  opened.push(service); service.start(); fake.emit()
  return { fake, host, store, service, emit: (record: UsageTokenObservation) => observation!(record) }
}

describe('host usage collection service', () => {
  it('coalesces whole streaming replacements and flushes the final counts on close', () => {
    vi.useFakeTimers()
    const f = fixture()
    const write = vi.spyOn(f.store, 'observeTokens')
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

  it('counts only exact accepted original submissions and separates selected and observed models', async () => {
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
    expect(activity.models.find(row => row.modelId === 'selected-model')!.prompts.total).toBe(1)
    expect(activity.models.find(row => row.modelId === 'native-model')!.tokens.total.value).toBe(120)
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
})
