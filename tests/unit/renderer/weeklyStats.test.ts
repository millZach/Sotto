import { describe, expect, it } from 'vitest'

import { computeWeeklyStats } from '../../../src/renderer/src/features/home/weeklyStats'
import type { HistoryEntry } from '../../../src/shared/history'

const DAY_MS = 86_400_000

// Local noon keeps calendar-day bucketing stable regardless of the runner timezone.
const NOW = new Date(2026, 6, 15, 12, 0, 0).getTime()

function entry(overrides: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: 'entry',
    text: 'one two three',
    createdAt: NOW,
    durationMs: 60_000,
    language: 'en',
    modelPreset: 'balanced',
    ...overrides,
  }
}

describe('computeWeeklyStats', () => {
  it('returns zeroed stats and seven empty daily buckets for empty history', () => {
    const stats = computeWeeklyStats([], NOW)
    expect(stats.words).toBe(0)
    expect(stats.avgWpm).toBe(0)
    expect(stats.minutes).toBe(0)
    expect(stats.dailyWords).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('counts whitespace-separated words, minutes, and average wpm across the week', () => {
    const stats = computeWeeklyStats([
      entry({ id: 'a', text: '  Hello   spaced\tworld \n today ', durationMs: 60_000 }),
      entry({ id: 'b', text: 'four more words here', durationMs: 120_000 }),
    ], NOW)
    expect(stats.words).toBe(8)
    // 8 words over 3 minutes.
    expect(stats.avgWpm).toBe(3)
    expect(stats.minutes).toBe(3)
  })

  it('guards the average against zero total duration', () => {
    const stats = computeWeeklyStats([entry({ text: 'words without duration', durationMs: 0 })], NOW)
    expect(stats.words).toBe(3)
    expect(stats.avgWpm).toBe(0)
    expect(stats.minutes).toBe(0)
  })

  it('excludes an entry exactly seven days old but keeps one just inside the window', () => {
    const stats = computeWeeklyStats([
      entry({ id: 'boundary', text: 'excluded boundary entry', createdAt: NOW - 7 * DAY_MS }),
      entry({ id: 'inside', text: 'included entry', createdAt: NOW - 7 * DAY_MS + 1 }),
    ], NOW)
    expect(stats.words).toBe(2)
    expect(stats.dailyWords.reduce((total, value) => total + value, 0)).toBe(2)
  })

  it('clusters same-day entries into a single calendar-day bucket, oldest to newest', () => {
    const yesterdayMorning = new Date(2026, 6, 14, 9, 0, 0).getTime()
    const yesterdayEvening = new Date(2026, 6, 14, 21, 30, 0).getTime()
    const stats = computeWeeklyStats([
      entry({ id: 'a', text: 'two words', createdAt: yesterdayMorning }),
      entry({ id: 'b', text: 'three more words', createdAt: yesterdayEvening }),
    ], NOW)
    expect(stats.dailyWords).toEqual([0, 0, 0, 0, 0, 5, 0])
  })

  it('spreads distinct days across buckets ending with today', () => {
    const stats = computeWeeklyStats([
      entry({ id: 'today', text: 'one', createdAt: NOW }),
      entry({ id: 'sixBack', text: 'one two', createdAt: NOW - 6 * DAY_MS }),
    ], NOW)
    expect(stats.dailyWords).toEqual([2, 0, 0, 0, 0, 0, 1])
  })

  it('clamps future-dated entries into the newest bucket and counts them', () => {
    const stats = computeWeeklyStats([
      entry({ id: 'future', text: 'clock skew words', createdAt: NOW + 2 * DAY_MS, durationMs: 60_000 }),
    ], NOW)
    expect(stats.words).toBe(3)
    expect(stats.minutes).toBe(1)
    expect(stats.dailyWords).toEqual([0, 0, 0, 0, 0, 0, 3])
  })

  it('ignores whitespace-only transcripts when counting words', () => {
    const stats = computeWeeklyStats([entry({ text: '   \n\t ' })], NOW)
    expect(stats.words).toBe(0)
    expect(stats.dailyWords).toEqual([0, 0, 0, 0, 0, 0, 0])
  })
})
