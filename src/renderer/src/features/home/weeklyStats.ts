import type { HistoryEntry } from '../../../../shared/history'

export interface WeeklyStats {
  readonly words: number
  readonly avgWpm: number
  readonly minutes: number
  /** Word totals per calendar day, oldest first, ending with the day containing `now`. */
  readonly dailyWords: readonly number[]
}

const DAY_MS = 86_400_000
const WINDOW_MS = 7 * DAY_MS
const BUCKET_COUNT = 7

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Aggregates dictation stats for the rolling last seven days.
 *
 * An entry counts when `now - createdAt < 7 days` (an entry exactly seven days
 * old is excluded). Future-dated entries (clock skew) are kept and clamped into
 * the newest bucket. Daily buckets follow local calendar days; the rare
 * in-window entry whose calendar day falls outside the seven buckets is clamped
 * into the oldest bucket.
 */
export function computeWeeklyStats(entries: readonly HistoryEntry[], now: number): WeeklyStats {
  const dailyWords = new Array<number>(BUCKET_COUNT).fill(0)
  const today = startOfDay(now)
  let words = 0
  let durationMs = 0

  for (const entry of entries) {
    if (now - entry.createdAt >= WINDOW_MS) continue
    const entryWords = countWords(entry.text)
    words += entryWords
    durationMs += entry.durationMs
    const daysBack = Math.round((today - startOfDay(entry.createdAt)) / DAY_MS)
    const bucket = Math.min(Math.max(BUCKET_COUNT - 1 - daysBack, 0), BUCKET_COUNT - 1)
    dailyWords[bucket] = (dailyWords[bucket] ?? 0) + entryWords
  }

  const totalMinutes = durationMs / 60_000
  return {
    words,
    avgWpm: totalMinutes === 0 ? 0 : Math.round(words / totalMinutes),
    minutes: Math.round(totalMinutes),
    dailyWords,
  }
}
