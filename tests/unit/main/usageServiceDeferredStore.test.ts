// @vitest-environment node
/**
 * The Usage service over a store that answers later and in order, as the usage store worker does (ADR-0083, October 27
 * amendment), through the same request code: flushes handed over behind one that failed, and history writes that fail
 * after the scan has returned.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHost } from '../../../src/main/agents/host'
import { UsageService } from '../../../src/main/agents/usageService'
import { UsageStore } from '../../../src/main/agents/usageStore'
import type { UsageHistorySink } from '../../../src/main/agents/usageHistory/sink'
import type { UsagePromptSubmission, UsageTokenObservation } from '../../../src/shared/usageDashboard'
import { DeferredUsageStore } from '../../fixtures/deferredUsageStore'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const at = '2026-10-12T12:00:00.000Z'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const submission: UsagePromptSubmission = { providerId: 'codex', threadId: 'thread-1', messageId: 'message-1',
  modelId: 'selected-model', at, kind: 'user', inputKind: 'send' }

const services: UsageService[] = []
afterEach(() => { for (const service of services.splice(0)) service.close(); vi.restoreAllMocks() })

function fixture() {
  const store = new UsageStore(':memory:', () => at)
  const client = new DeferredUsageStore(store)
  const fake = new FakeProviderHost()
  fake.state.connected = true
  fake.state.threads[0]!.providerId = 'codex'
  const host: AgentHost = fake
  const service = new UsageService({ directory: '.', host, client })
  services.push(service)
  service.start(); fake.emit()
  return { store, client, host, service }
}

async function read(f: ReturnType<typeof fixture>) {
  const reading = f.service.read()
  await f.client.drain()
  return (await reading).activity!
}

describe('usage service over a store that answers later', () => {
  it('keeps a submission whose flush failed when its acceptance was refused behind it', async () => {
    const f = fixture()
    await f.client.drain()
    vi.spyOn(f.store, 'submitPrompt').mockImplementationOnce(() => { throw new Error('synthetic disk failure') })
    f.service.submitPrompt(submission)
    f.service.acceptPrompt(submission.threadId, submission.messageId)
    // The submission's flush fails; the acceptance's, behind it, is refused untried. Both come back for the retry.
    await f.client.drain()
    f.service.flush()
    const activity = await read(f)
    expect(activity.totals.prompts).toMatchObject({ user: 1, total: 1 })
    expect(activity.models).toMatchObject([{ modelId: 'selected-model', prompts: { total: 1 } }])
  })

  it('keeps an acceptance whose flush failed when a refusal was refused behind it', async () => {
    const f = fixture()
    await f.client.drain()
    f.service.submitPrompt(submission)
    await f.client.drain()
    vi.spyOn(f.store, 'acceptSubmittedPrompt').mockImplementationOnce(() => { throw new Error('synthetic commit failure') })
    f.service.acceptPrompt(submission.threadId, submission.messageId)
    f.service.discardPrompt(submission.threadId, submission.messageId)
    await f.client.drain()
    f.service.flush()
    expect((await read(f)).totals.prompts.total).toBe(1)
  })

  it('records a pass as unavailable when its last cursor fails after the scan returned', async () => {
    const f = fixture()
    const row: UsageTokenObservation = { providerId: 'codex', threadId: 'outside-1', modelId: 'native-model', recordKey: hash('history'),
      at: '2026-09-20T10:00:00.000Z', phase: 'replay', partial: false, tokens: { input: 10, output: 2 }, origin: 'history', source: 'outside', client: 'codex-cli' }
    let scanned = false
    f.host.scanUsageHistory = async (sink: UsageHistorySink) => {
      sink.tokens([row])
      sink.setCursors([{ key: 'codex:file', cursor: { size: 10, mtimeMs: 1, offset: 10 } }])
      scanned = true
    }
    // History is wired at start; this service starts again with the scan in place.
    f.service.close(); services.length = 0
    const store = new UsageStore(':memory:', () => at)
    const client = new DeferredUsageStore(store)
    const service = new UsageService({ directory: '.', host: f.host, client }); services.push(service)
    service.start()
    await client.drain()
    vi.spyOn(store, 'setHistoryCursors').mockImplementation(() => { throw new Error('synthetic disk failure') })
    const reading = service.read()
    await client.drain()
    await reading
    await vi.waitFor(async () => { await client.drain(); expect(store.metadata().history?.status).toBe('unavailable') })
    expect(scanned).toBe(true)
    expect(store.metadata().history?.scannedAt).toBeUndefined()
    expect(store.historyCursors()).toEqual([])
  })
})
