import { createHash } from 'node:crypto'
import type { UsageHistoryCursor, UsageHistoryPrompt, UsageProviderId, UsageTokenObservation } from '../../../shared/usageDashboard'

/**
 * Where a history reader puts what it read from a provider's own local records (ADR-0080). Each batch holds at
 * most `USAGE_HISTORY_BATCH_MAX` entries. A reader saves a file's cursor only after that file's rows went in, so a
 * pass that stops anywhere resumes without losing a row; a row read twice is the same row and counts once.
 * Everything that crosses it is numbers, instants, model and client names and hashed identities.
 */
export interface UsageHistorySink {
  tokens(batch: readonly UsageTokenObservation[]): void
  prompts(batch: readonly UsageHistoryPrompt[]): void
  cursor(key: string): UsageHistoryCursor | undefined
  setCursors(entries: readonly { key: string; cursor: UsageHistoryCursor }[]): void
}

/**
 * One of Sotto's own stored user messages, by identity and instant alone: no words. Wake-ups are told apart by the
 * thread store's `wake_ups` table (ADR-0061 decision 8).
 */
export interface UsageRecordedUserMessage {
  readonly threadId: string
  readonly messageId: string
  readonly providerId: UsageProviderId
  /** The thread's model as Sotto holds it now: the selection the store's served-model join corrects. */
  readonly modelId: string
  readonly at: string
  readonly wakeUp: boolean
}

/**
 * A provider host reads its own provider's local records on this computer. The adapter is the only layer that
 * knows which native session is which thread, so it reports owned work under its own thread ID, and the wrappers
 * above translate it as they translate every other usage record (ADR-0002). Grok Build and Devin keep no token
 * counts on the computer, so their adapters offer none; a reader for them would plug in here.
 */
export type UsageHistoryScan = (sink: UsageHistorySink, signal: AbortSignal) => Promise<void>

/** Thread identities for work outside any Sotto thread start with this; no Sotto thread ID does. */
const HISTORY_THREAD_PREFIX = 'usage-history:'

/**
 * A namespaced, non-reversible identity for a native session Sotto does not own. The provider's own session ID never
 * leaves the adapter: only this hash does.
 */
export function usageHistoryThreadId(providerId: UsageProviderId, nativeSessionId: string): string {
  return HISTORY_THREAD_PREFIX + createHash('sha256').update(JSON.stringify(['sotto-usage-history', providerId, 'session', nativeSessionId])).digest('hex')
}
export function isUsageHistoryThreadId(threadId: string): boolean { return threadId.startsWith(HISTORY_THREAD_PREFIX) }

/** The record key of a row outside any Sotto thread, stable across passes and files. */
export function usageHistoryRecordKey(providerId: UsageProviderId, threadId: string, identity: string): string {
  return createHash('sha256').update(JSON.stringify(['sotto-usage-history', providerId, 'row', threadId, identity])).digest('hex')
}

/**
 * The message identity of a prompt outside any Sotto thread: a hash of the provider's own message or turn ID, which
 * never leaves the reader. The same native message is the same identity on every pass and in every file.
 */
export function usageHistoryMessageId(providerId: UsageProviderId, nativeMessageId: string): string {
  return createHash('sha256').update(JSON.stringify(['sotto-usage-history', providerId, 'message', nativeMessageId])).digest('hex')
}

/** A file's cursor key: a hash of the provider and the file's place under its client's folder, never the path itself. */
export function usageHistoryCursorKey(providerId: UsageProviderId, relativePath: string): string {
  return `${providerId}:` + createHash('sha256').update(JSON.stringify(['sotto-usage-history', providerId, 'file', relativePath.replaceAll('\\', '/')])).digest('hex')
}

/** Gives a send, a read or startup its turn between batches. */
export function yieldToEventLoop(): Promise<void> { return new Promise(resolve => setImmediate(resolve)) }

/** A sink whose rows a wrapper host rewrites or drops on their way up; cursors pass through unchanged. */
export function mappedSink(sink: UsageHistorySink, mapping: {
  token?: (record: UsageTokenObservation) => UsageTokenObservation | undefined
  prompt?: (record: UsageHistoryPrompt) => UsageHistoryPrompt | undefined
}): UsageHistorySink {
  const map = <T>(batch: readonly T[], each: ((value: T) => T | undefined) | undefined): T[] => {
    if (!each) return [...batch]
    const result: T[] = []
    for (const value of batch) { const mapped = each(value); if (mapped) result.push(mapped) }
    return result
  }
  return {
    tokens: batch => { const mapped = map(batch, mapping.token); if (mapped.length) sink.tokens(mapped) },
    prompts: batch => { const mapped = map(batch, mapping.prompt); if (mapped.length) sink.prompts(mapped) },
    cursor: key => sink.cursor(key),
    setCursors: entries => sink.setCursors(entries),
  }
}
