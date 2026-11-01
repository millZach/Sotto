/**
 * What Usage asks of its store and what each request does there (ADR-0083, October 27 amendment). Main never runs these
 * against the file itself once the usage store worker is built: `usageStoreWorker.ts` answers them on the worker's own
 * connections, and `UsageStoreOnMain` (`usageStoreClient.ts`) answers them in place where there is no worker, as under
 * the test runner. Both run the same `answerUsageRequest`, so a request means one thing wherever it is answered.
 */
import {
  USAGE_HISTORY_BATCH_MAX,
  type UsageHistoryCursor, type UsageHistoryPrompt, type UsageHistoryStatus, type UsageLocalClearResult, type UsageLocalQuery,
  type UsageLocalRead, type UsageMetadata, type UsagePromptIdentity, type UsagePromptSubmission, type UsageTokenObservation,
} from '../../shared/usageDashboard'
import type { UsageStore, UsageVisitMark } from './usageStore'

/** One prompt's buffered numeric writes: its original selection, and whether its echo or a refusal settled it. */
export interface UsagePromptWrite {
  readonly submission?: UsagePromptSubmission | undefined
  readonly action?: 'accept' | 'discard' | undefined
}

/**
 * One flush of the live buffer, in the order it was buffered: token records, then prompts, then the marks of threads whose
 * saved rows were read, then the legacy seed mark. `retry` is the first flush main sends after one failed; until it arrives
 * the writer refuses every flush, so nothing buffered after a failed record commits ahead of it, a thread's mark among
 * them: a mark commits only once every row its read gave has.
 */
export interface UsageFlush {
  readonly retry: boolean
  readonly tokens: readonly UsageTokenObservation[]
  readonly prompts: readonly { readonly threadId: string; readonly messageId: string; readonly write: UsagePromptWrite }[]
  readonly visits?: readonly UsageVisitMark[] | undefined
  readonly seed: boolean
}

/** How much of a flush committed, from its start: a failed batch rolls back whole and stops it. */
export interface UsageFlushOutcome {
  readonly tokens: number
  readonly prompts: number
  /** The flush's visit marks, all written, where it carried any. */
  readonly visits?: number | undefined
  readonly seed: boolean
  /** A write failed; what follows it was not tried. */
  readonly failed?: true | undefined
  /** Refused untried, behind a flush that failed. */
  readonly skipped?: true | undefined
}

/** A history pass's write. Tokens, prompts and cursors after one of its pass's writes failed are refused untried. */
export type UsageHistoryWrite =
  | { readonly kind: 'tokens'; readonly batch: readonly UsageTokenObservation[] }
  | { readonly kind: 'prompts'; readonly batch: readonly UsageHistoryPrompt[] }
  | { readonly kind: 'cursors'; readonly entries: readonly { readonly key: string; readonly cursor: UsageHistoryCursor }[] }
  | { readonly kind: 'status'; readonly status: UsageHistoryStatus }

export type UsageStoreRequest =
  | { readonly kind: 'open' }
  | { readonly kind: 'metadata' }
  | { readonly kind: 'flush'; readonly flush: UsageFlush }
  | { readonly kind: 'pending-end' }
  | { readonly kind: 'pending-identities'; readonly after?: UsagePromptIdentity | undefined; readonly through: UsagePromptIdentity }
  | { readonly kind: 'clear'; readonly expectedRevision: number }
  | { readonly kind: 'query'; readonly query: UsageLocalQuery }
  | { readonly kind: 'history-cursors' }
  | { readonly kind: 'visit-marks' }
  | { readonly kind: 'history'; readonly pass: number; readonly write: UsageHistoryWrite }

/** What each request answers with. */
export interface UsageStoreAnswers {
  open: UsageMetadata
  metadata: UsageMetadata
  flush: UsageFlushOutcome
  'pending-end': UsagePromptIdentity | undefined
  'pending-identities': UsagePromptIdentity[]
  clear: UsageLocalClearResult
  query: UsageLocalRead
  'history-cursors': { key: string; cursor: UsageHistoryCursor }[]
  'visit-marks': UsageVisitMark[]
  history: null
}

/** The store calls a request can make. Tests hand the service a store with only some history calls. */
export type UsageRequestStore = Pick<UsageStore, 'open' | 'metadata' | 'observeTokenBatch' | 'submitPrompt' | 'acceptSubmittedPrompt' |
  'discardSubmittedPrompt' | 'pendingPromptReconciliationEnd' | 'pendingPromptIdentities' | 'markLegacySeedCompleted' | 'query' | 'clear'>
  & Partial<Pick<UsageStore, 'importPrompts' | 'historyCursors' | 'setHistoryCursors' | 'setHistoryStatus' | 'visitMarks' | 'setVisitMarks'>>

/** What a connection remembers between requests: whether a flush failed, and the newest history pass that did. */
export interface UsageRequestState { flushFailed: boolean; failedPass: number }
export function usageRequestState(): UsageRequestState { return { flushFailed: false, failedPass: 0 } }

export class UsageWriteRefused extends Error {
  constructor() { super('Usage refused a write behind one that failed'); this.name = 'UsageWriteRefused' }
}

/**
 * Runs one request against the store, throwing what the store threw. `prepare` runs first, as part of the request: the
 * worker opens its connection there, so a failure to open fails a flush or a history write as a failed write does, and
 * what is queued behind it is refused the same way.
 */
export function answerUsageRequest<K extends UsageStoreRequest['kind']>(store: UsageRequestStore, request: Extract<UsageStoreRequest, { kind: K }>,
  state: UsageRequestState, prepare?: () => void): UsageStoreAnswers[K]
export function answerUsageRequest(store: UsageRequestStore, request: UsageStoreRequest, state: UsageRequestState, prepare: () => void = () => undefined): UsageStoreAnswers[UsageStoreRequest['kind']] {
  if (request.kind === 'flush') return flush(store, request.flush, state, prepare)
  if (request.kind === 'history') { history(store, request.pass, request.write, state, prepare); return null }
  prepare()
  switch (request.kind) {
    case 'open': store.open(); return store.metadata()
    case 'metadata': return store.metadata()
    case 'pending-end': return store.pendingPromptReconciliationEnd()
    case 'pending-identities': return store.pendingPromptIdentities(request.after, request.through)
    case 'clear': return store.clear(request.expectedRevision)
    case 'query': return store.query(request.query)
    case 'history-cursors': return historyStore(store).historyCursors()
    case 'visit-marks': return store.visitMarks?.() ?? []
  }
}

/**
 * The live buffer's writes in the order buffered, in a few bounded transactions rather than one per record: a start-up
 * backlog of thousands held main for seconds when this ran there. A batch that fails rolls back whole and stops the
 * flush, and every flush after it is refused until main retries, so the buffer keeps it and everything after it.
 */
function flush(store: UsageRequestStore, request: UsageFlush, state: UsageRequestState, prepare: () => void): UsageFlushOutcome {
  if (state.flushFailed && !request.retry) return { tokens: 0, prompts: 0, seed: false, skipped: true }
  state.flushFailed = false
  let tokens = 0, prompts = 0, seed = false
  let visits: number | undefined
  const counted = (): Pick<UsageFlushOutcome, 'visits'> => visits === undefined ? {} : { visits }
  try {
    prepare()
    for (let index = 0; index < request.tokens.length; index += USAGE_HISTORY_BATCH_MAX) {
      const batch = request.tokens.slice(index, index + USAGE_HISTORY_BATCH_MAX)
      store.observeTokenBatch(batch, { revision: 'per-record' })
      tokens += batch.length
    }
    for (const { threadId, messageId, write } of request.prompts) {
      if (write.submission) store.submitPrompt(write.submission)
      if (write.action === 'accept') store.acceptSubmittedPrompt(threadId, messageId)
      else if (write.action === 'discard') store.discardSubmittedPrompt(threadId, messageId)
      prompts += 1
    }
    if (request.visits?.length) {
      for (let index = 0; index < request.visits.length; index += USAGE_HISTORY_BATCH_MAX) store.setVisitMarks?.(request.visits.slice(index, index + USAGE_HISTORY_BATCH_MAX))
      visits = request.visits.length
    }
    if (request.seed) { store.markLegacySeedCompleted(); seed = true }
    return { tokens, prompts, ...counted(), seed }
  } catch {
    state.flushFailed = true
    return { tokens, prompts, ...counted(), seed, failed: true }
  }
}

/** A cursor moves only after its rows went in: once a pass's write fails, its later rows and cursors are refused. */
function history(store: UsageRequestStore, pass: number, write: UsageHistoryWrite, state: UsageRequestState, prepare: () => void): void {
  // Status is advisory, and says how the pass ended, so it is written whatever failed before it.
  if (write.kind === 'status') { prepare(); historyStore(store).setHistoryStatus(write.status); return }
  if (pass <= state.failedPass) throw new UsageWriteRefused()
  try {
    prepare()
    if (write.kind === 'tokens') store.observeTokenBatch([...write.batch])
    else if (write.kind === 'prompts') historyStore(store).importPrompts([...write.batch])
    else historyStore(store).setHistoryCursors([...write.entries])
  } catch (error) {
    state.failedPass = pass
    throw error
  }
}

/** Whether the store takes history: every one the app opens does, and a test's may not. */
export function takesHistory(store: UsageRequestStore): store is Required<UsageRequestStore> {
  return store.importPrompts !== undefined && store.historyCursors !== undefined && store.setHistoryCursors !== undefined && store.setHistoryStatus !== undefined
}

function historyStore(store: UsageRequestStore): Required<UsageRequestStore> {
  if (!takesHistory(store)) throw new Error('Usage history is unavailable')
  return store
}
