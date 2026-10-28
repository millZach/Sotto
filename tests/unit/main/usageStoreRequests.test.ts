// @vitest-environment node
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageStore } from '../../../src/main/agents/usageStore'
import { answerUsageRequest, usageRequestState, UsageWriteRefused, type UsageFlush } from '../../../src/main/agents/usageStoreRequests'
import type { UsageTokenObservation } from '../../../src/shared/usageDashboard'

const at = '2026-10-12T12:00:00.000Z'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const token = (key: string): UsageTokenObservation => ({ providerId: 'codex', threadId: 'thread-1', modelId: 'native-model', recordKey: hash(key),
  at, phase: 'live', partial: false, tokens: { input: 1, output: 1 } })
const history = (key: string): UsageTokenObservation => ({ ...token(key), phase: 'replay', origin: 'history', source: 'outside', client: 'codex-cli' })
const flush = (key: string, retry = false): UsageFlush => ({ retry, tokens: [token(key)], prompts: [], seed: false })
const stores: UsageStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks() })
function opened(): UsageStore { const store = new UsageStore(':memory:', () => at); store.open(); stores.push(store); return store }

describe('usage store requests', () => {
  for (const failure of ['open', 'write'] as const) {
    it(`refuses later flushes behind one whose ${failure} failed, until the retry`, () => {
      const store = opened()
      const state = usageRequestState()
      if (failure === 'write') vi.spyOn(store, 'observeTokenBatch').mockImplementationOnce(() => { throw new Error('synthetic disk failure') })
      const prepare = failure === 'open' ? vi.fn().mockImplementationOnce(() => { throw new Error('synthetic open failure') }) : vi.fn()
      expect(answerUsageRequest(store, { kind: 'flush', flush: flush('a') }, state, prepare)).toMatchObject({ tokens: 0, failed: true })
      // B, already queued behind A, opens fine and would commit ahead of A's retry: it is refused untried.
      expect(answerUsageRequest(store, { kind: 'flush', flush: flush('b') }, state, prepare)).toMatchObject({ tokens: 0, skipped: true })
      expect(store.query().totals.tokenRecords).toBe(0)
      expect(answerUsageRequest(store, { kind: 'flush', flush: { ...flush('a', true), tokens: [token('a'), token('b')] } }, state, prepare)).toEqual({ tokens: 2, prompts: 0, seed: false })
      expect(store.query().totals.tokenRecords).toBe(2)
    })

    it(`refuses a history pass's later rows and cursors once its ${failure} failed, and writes its status`, () => {
      const store = opened()
      const state = usageRequestState()
      if (failure === 'write') vi.spyOn(store, 'observeTokenBatch').mockImplementationOnce(() => { throw new Error('synthetic disk failure') })
      const prepare = failure === 'open' ? vi.fn().mockImplementationOnce(() => { throw new Error('synthetic open failure') }) : vi.fn()
      const write = (pass: number, kind: 'tokens' | 'cursors') => answerUsageRequest(store, { kind: 'history', pass,
        write: kind === 'tokens' ? { kind, batch: [history(`row-${pass}`)] } : { kind, entries: [{ key: 'codex:file', cursor: { size: 1, mtimeMs: 1, offset: pass } }] } }, state, prepare)
      expect(() => write(1, 'tokens')).toThrow()
      expect(() => write(1, 'tokens')).toThrow(UsageWriteRefused)
      expect(() => write(1, 'cursors')).toThrow(UsageWriteRefused)
      answerUsageRequest(store, { kind: 'history', pass: 1, write: { kind: 'status', status: { status: 'unavailable' } } }, state, prepare)
      expect(store.historyCursors()).toEqual([])
      expect(store.metadata().history?.status).toBe('unavailable')
      // The next pass starts clean.
      write(2, 'tokens'); write(2, 'cursors')
      expect(store.historyCursors()).toEqual([{ key: 'codex:file', cursor: { size: 1, mtimeMs: 1, offset: 2 } }])
    })
  }
})
