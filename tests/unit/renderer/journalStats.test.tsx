import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { JournalStats } from '../../../src/renderer/src/features/dictate/JournalStats'
import { LONGEST_STREAK_DAYS, dayLabel, journalStats as statsOf, minutesLabel } from '../../../src/renderer/src/features/dictate/journalFacts'
import type { DictationRecord } from '../../../src/shared/dictationRecord'

afterEach(cleanup)

/** Wednesday, October 21, 2026, 4:20 pm local. */
const NOW = new Date(2026, 9, 21, 16, 20).valueOf()
const at = (daysAgo: number, hour: number): number => {
  const date = new Date(NOW)
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, 0, 0, 0)
  return date.valueOf()
}
let serial = 0
/** Main lists records newest first, and the stats read them in that order. */
const journalStats = (records: readonly DictationRecord[], now: number, typingWpm: number) =>
  statsOf([...records].sort((first, second) => second.createdAt - first.createdAt), now, typingWpm)
const record = (daysAgo: number, hour: number, words: number, seconds: number, app?: string): DictationRecord => ({
  id: `r${serial += 1}`, createdAt: at(daysAgo, hour), durationMs: seconds * 1_000, words, ...(app === undefined ? {} : { app }),
})

describe('journalStats', () => {
  it('counts today against the usual pace of the last 90 days, and ignores days outside them', () => {
    const stats = journalStats([
      record(0, 9, 120, 60, 'Microsoft Outlook'),
      record(0, 14, 60, 30),
      record(5, 10, 100, 60, 'Slack'),
      record(120, 10, 1_000, 60, 'Slack'),
    ], NOW, 40)
    expect(stats.today).toEqual({ words: 180, count: 2, wpm: 120 })
    // 280 words in 2.5 minutes over the last 90 days; the record from 120 days ago is not usual any more.
    expect(stats.usual).toBe(112)
  })

  it('counts a streak through today, or through yesterday while today has none yet, and the longest run', () => {
    const streak = [record(1, 9, 10, 5), record(2, 9, 10, 5), record(3, 9, 10, 5), record(6, 9, 10, 5), record(7, 9, 10, 5), record(8, 9, 10, 5), record(9, 9, 10, 5)]
    expect(journalStats(streak, NOW, 40)).toMatchObject({ streak: 3, longestStreak: 4 })
    expect(journalStats([record(0, 9, 10, 5), ...streak], NOW, 40)).toMatchObject({ streak: 4, longestStreak: 4 })
    expect(journalStats([record(2, 9, 10, 5)], NOW, 40)).toMatchObject({ streak: 0, longestStreak: 1 })
  })

  it('lays out thirteen weeks from Sunday with today ringed, later days left out, and darker days for more words', () => {
    const stats = journalStats([record(0, 9, 400, 60), record(1, 9, 100, 60), record(100, 9, 50, 60)], NOW, 40)
    expect(stats.calendar).toHaveLength(13)
    const thisWeek = stats.calendar.at(-1)!
    expect(new Date(thisWeek[0]!.day).getDay()).toBe(0)
    // Wednesday is today, so Thursday to Saturday have not happened.
    expect(thisWeek.slice(4)).toEqual([null, null, null])
    expect(thisWeek[3]).toMatchObject({ today: true, words: 400, level: 4 })
    expect(thisWeek[2]).toMatchObject({ today: false, words: 100, level: 1 })
    // 100 days ago is older than the calendar.
    expect(stats.calendarDays).toBe(2)
  })

  it('ranks Where and the chips by words over the last 30 days, leaves out dictations without an app, and invents none', () => {
    const stats = journalStats([
      record(0, 9, 300, 60, 'Microsoft Outlook'),
      record(1, 9, 100, 60, 'Slack'),
      record(2, 9, 100, 60, 'Windows Terminal'),
      record(3, 9, 50, 60, 'Notepad'),
      record(4, 9, 50, 60, 'Word'),
      record(5, 9, 25, 60, 'Teams'),
      record(6, 9, 5_000, 60),
      record(40, 9, 9_000, 60, 'Google Chrome'),
    ], NOW, 40)
    expect(stats.where.map(({ app }) => app)).toEqual(['Microsoft Outlook', 'Slack', 'Windows Terminal', 'Notepad'])
    expect(stats.where[0]!.share).toBeCloseTo(300 / 625)
    expect(stats.chips).toEqual(['Microsoft Outlook', 'Slack', 'Windows Terminal', 'Notepad', 'Word'])
    expect(stats.chips).not.toContain('Unknown')
  })

  it('counts time saved this calendar month against the typing speed, and the busiest hour by words', () => {
    // October 21: the 1st is 20 days back, September 30 is not this month.
    const stats = journalStats([record(0, 14, 400, 120), record(10, 14, 200, 60), record(20, 9, 200, 60), record(21, 9, 4_000, 60)], NOW, 40)
    // 800 words typed at 40 wpm take 20 minutes; talking took 4.
    expect(stats.month.savedMinutes).toBeCloseTo(16)
    expect(stats.month.busiestHour).toBe(14)
    expect(journalStats([record(0, 14, 400, 120)], NOW, 80).month.savedMinutes).toBeCloseTo(3)
    expect(journalStats([], NOW, 40).month).toEqual({ words: 0, savedMinutes: 0, busiestHour: null })
    expect(minutesLabel(16)).toBe('16 min')
    expect(minutesLabel(80)).toBe('1 h 20 min')
    expect(minutesLabel(120)).toBe('2 h')
  })

  it('reads only the last year of records, so years of them cost no more than one, and counts the longest streak inside it', () => {
    const run = Array.from({ length: 20 }, (_, index) => record(LONGEST_STREAK_DAYS + 30 + index, 9, 10, 5))
    const stats = journalStats([record(0, 9, 10, 5), record(1, 9, 10, 5), ...run], NOW, 40)
    expect(stats).toMatchObject({ streak: 2, longestStreak: 2 })
    // Out of order, an old record ends the reading early: the order is main's promise, and the stats lean on it.
    expect(statsOf([record(400, 9, 10, 5), record(0, 9, 10, 5)], NOW, 40).today.count).toBe(0)
  })

  it('gives each of the last 30 days its pace, oldest first, and none where nothing was timed', () => {
    const stats = journalStats([record(0, 9, 100, 60), record(29, 9, 50, 30), record(3, 9, 10, 0)], NOW, 40)
    expect(stats.speed).toHaveLength(30)
    expect(stats.speed[0]).toMatchObject({ wpm: 100 })
    expect(stats.speed.at(-1)).toMatchObject({ wpm: 100 })
    expect(stats.speed.at(-4)).toMatchObject({ wpm: null })
  })

  it('uses local calendar days for Yesterday across both daylight-saving changes', context => {
    const previousTimezone = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const dates = [
        ['2026-03-09T12:00:00', '2026-03-08T00:00:00', '2026-03-07T23:30:00'],
        ['2026-11-02T12:00:00', '2026-11-01T00:00:00', '2026-10-31T23:30:00'],
      ]
      if (dates.some(([today, yesterday]) => new Date(today!).getTimezoneOffset() === new Date(yesterday!).getTimezoneOffset())) {
        context.skip('This worker does not apply America/Los_Angeles at runtime; the dates must cross a DST offset change.')
      }
      for (const [today, yesterday, dayBefore] of dates) {
        const now = new Date(today!).valueOf()
        expect(dayLabel(new Date(yesterday!).valueOf(), now)).toBe('Yesterday')
        expect(dayLabel(new Date(dayBefore!).valueOf(), now)).not.toBe('Yesterday')
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })
})

describe('JournalStats', () => {
  const records = [
    record(0, 9, 120, 60, 'Microsoft Outlook'),
    record(1, 14, 90, 60, 'Slack'),
    record(2, 14, 80, 60),
  ]

  it('shows today against the usual, the streak, where the words went and this month, with text for every chart', () => {
    render(<JournalStats stats={journalStats(records, NOW, 40)} typingWpm={40} />)
    const column = screen.getByRole('complementary', { name: 'Your dictation' })
    expect(within(column).getByRole('heading', { name: 'Today' })).toBeVisible()
    expect(column).toHaveTextContent('120 words in 1 dictation')
    expect(column).toHaveTextContent('120 wpm, usual 97')
    expect(within(column).getByRole('heading', { name: '3-day streak' })).toBeVisible()
    expect(within(column).getByRole('img', { name: /^Words per minute on the 3 of the last 30 days you dictated, from 80 to 120, fastest on Oct 21, against your usual 97\.$/ })).toBeInTheDocument()
    expect(within(column).getByRole('group', { name: 'Days with dictation over the last 13 weeks: 3 of them, darker on days with more words' })).toBeInTheDocument()
    expect(within(column).getByRole('img', { name: 'Today, Wed, Oct 21: 120 words' })).toBeInTheDocument()
    expect(within(column).getByRole('img', { name: 'Tue, Oct 13: no dictation' })).toBeInTheDocument()
    const where = within(column).getByRole('list')
    expect(within(where).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Microsoft Outlook57%120 words', 'Slack43%90 words'])
    expect(column).toHaveTextContent('saved against typing at 40 wpm')
    expect(column).toHaveTextContent('your busiest hour')
  })

  it('says plainly what it cannot show yet', () => {
    render(<JournalStats stats={journalStats([record(0, 9, 10, 0)], NOW, 40)} typingWpm={40} />)
    expect(screen.getByText('Your speed shows here once you have dictated on two days.')).toBeVisible()
    expect(screen.getByText('No app noted yet. Sotto notes the app it pastes into.')).toBeVisible()
    expect(screen.getByRole('heading', { name: '1-day streak' })).toBeVisible()
  })
})
