import type { UsageHistoryCursor, UsageHistoryPrompt, UsageTokenObservation } from '../../../src/shared/usageDashboard'
import type { UsageHistorySink } from '../../../src/main/agents/usageHistory/sink'

/** A sink that keeps everything in memory, the way the store would: one row per thread and record key. */
export function memorySink() {
  const tokens: UsageTokenObservation[] = []
  const prompts: UsageHistoryPrompt[] = []
  const cursors = new Map<string, UsageHistoryCursor>()
  const batches: number[] = []
  const sink: UsageHistorySink = {
    tokens: batch => { batches.push(batch.length); tokens.push(...batch.map(row => structuredClone(row))) },
    prompts: batch => { batches.push(batch.length); prompts.push(...batch.map(row => structuredClone(row))) },
    cursor: key => cursors.get(key),
    setCursors: entries => { for (const { key, cursor } of entries) cursors.set(key, { ...cursor }) },
  }
  /** Rows as the store keeps them: a replay of the same row replaces it. */
  const rows = (): Map<string, UsageTokenObservation> => {
    const kept = new Map<string, UsageTokenObservation>()
    for (const row of tokens) kept.set(JSON.stringify([row.providerId, row.threadId, row.recordKey]), row)
    return kept
  }
  const uniquePrompts = (): Map<string, UsageHistoryPrompt> => {
    const kept = new Map<string, UsageHistoryPrompt>()
    for (const prompt of prompts) if (!kept.has(JSON.stringify([prompt.threadId, prompt.messageId]))) kept.set(JSON.stringify([prompt.threadId, prompt.messageId]), prompt)
    return kept
  }
  const sum = (field: 'input' | 'output'): number => [...rows().values()].reduce((total, row) => total + (row.tokens[field] ?? 0), 0)
  return { sink, tokens, prompts, cursors, batches, rows, uniquePrompts, sum }
}
