// @vitest-environment node
// ADR-0218: when a scheduled task's times fall, read as the wall clock in a named zone across summer time, and how a
// scheduler that slept counts what it missed.
import { describe, expect, it } from 'vitest'
import { nextDue, retryDelayMs, scheduleDue, scheduleKey } from '../../../src/main/automation/taskTiming'
import { nextOccurrence, OCCURRENCE_COUNT_MAX, occurrencesBetween, taskScheduleSchema, wallClockInstant, type TaskSchedule } from '../../../src/shared/taskSchedules'

const utc = (text: string): number => Date.parse(`${text}Z`)

describe('wall clock times', () => {
  it('runs a time the clock skips that much later, and a time it shows twice the first time only', () => {
    // London skips 01:00 to 02:00 on March 29, 2026: 01:30 runs at 02:30 summer time, 01:30 UTC.
    expect(wallClockInstant(2026, 3, 29, 1, 30, 'Europe/London')).toBe(utc('2026-03-29T01:30:00'))
    // New York shows 01:00 to 02:00 twice on November 1, 2026: 01:30 is the first, in summer time (UTC-4).
    expect(wallClockInstant(2026, 11, 1, 1, 30, 'America/New_York')).toBe(utc('2026-11-01T05:30:00'))
    expect(wallClockInstant(2026, 7, 1, 9, 0, 'Europe/London')).toBe(utc('2026-07-01T08:00:00'))
  })

  it('finds the next weekday time in the zone, over a weekend and across a change of offset', () => {
    const weekdays: TaskSchedule = { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00', '17:30'], timeZone: 'Europe/London' }
    // Friday November 27, 2026 at 18:00 London: next is Monday at 09:00, GMT.
    expect(nextOccurrence(weekdays, utc('2026-11-27T18:00:00'))).toBe(utc('2026-11-30T09:00:00'))
    expect(nextOccurrence(weekdays, utc('2026-11-30T09:00:00'))).toBe(utc('2026-11-30T17:30:00'))
    // Sunday 09:00 New York before and after the clocks go back.
    const sundays: TaskSchedule = { kind: 'weekly', days: [7], times: ['09:00'], timeZone: 'America/New_York' }
    expect(nextOccurrence(sundays, utc('2026-10-26T00:00:00'))).toBe(utc('2026-11-01T14:00:00'))
    expect(nextOccurrence(sundays, utc('2026-10-20T00:00:00'))).toBe(utc('2026-10-25T13:00:00'))
  })

  it('refuses a zone this computer does not know rather than guessing one', () => {
    expect(nextOccurrence({ kind: 'weekly', days: [1], times: ['09:00'], timeZone: 'Mars/Olympus' }, 0)).toBeNull()
  })

  it('orders actual times when a skipped hour moves one of the times later', () => {
    const schedule: TaskSchedule = { kind: 'weekly', days: [7], times: ['02:30', '03:15'], timeZone: 'America/New_York' }
    const from = utc('2026-03-08T06:59:00')
    expect(nextOccurrence(schedule, from)).toBe(utc('2026-03-08T07:15:00'))
    expect(occurrencesBetween(schedule, from, utc('2026-03-08T08:00:00'))).toEqual({ count: 2, newest: utc('2026-03-08T07:30:00') })
  })

  it('finds the newest weekly time even after more than the missed-count limit', () => {
    const schedule: TaskSchedule = { kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], times: ['00:00', '12:00'], timeZone: 'UTC' }
    const newest = utc('2026-12-01T12:00:00')
    expect(occurrencesBetween(schedule, utc('2025-01-01T00:00:00'), newest)).toEqual({ count: OCCURRENCE_COUNT_MAX, newest })
  })
})

describe('intervals and one-off times', () => {
  const from = utc('2026-11-26T08:00:00')
  const hourly: TaskSchedule = { kind: 'every', minutes: 60, from: new Date(from).toISOString() }

  it('counts every interval from its start, and never the start a task was saved at', () => {
    expect(nextOccurrence(hourly, from)).toBe(from + 3_600_000)
    expect(nextOccurrence(hourly, from - 1)).toBe(from)
    expect(occurrencesBetween(hourly, from, from + 3 * 3_600_000)).toEqual({ count: 3, newest: from + 3 * 3_600_000 })
    expect(occurrencesBetween(hourly, from, from + 3_599_999)).toEqual({ count: 0, newest: null })
  })

  it('stops counting at its limit but still names the newest time', () => {
    const often: TaskSchedule = { kind: 'every', minutes: 5, from: new Date(from).toISOString() }
    const month = 30 * 24 * 3_600_000
    expect(occurrencesBetween(often, from, from + month)).toEqual({ count: OCCURRENCE_COUNT_MAX, newest: from + month })
  })

  it('runs a one-off time once and then names none', () => {
    const once: TaskSchedule = { kind: 'once', at: '2026-11-27T09:00:00.000Z' }
    expect(nextOccurrence(once, from)).toBe(utc('2026-11-27T09:00:00'))
    expect(nextOccurrence(once, utc('2026-11-27T09:00:00'))).toBeNull()
  })

  it('refuses an interval short enough to send a prompt a minute', () => {
    expect(taskScheduleSchema.safeParse({ kind: 'every', minutes: 1, from: new Date(from).toISOString() }).success).toBe(false)
    expect(taskScheduleSchema.safeParse({ kind: 'weekly', days: [8], times: ['09:00'], timeZone: 'UTC' }).success).toBe(false)
    expect(taskScheduleSchema.safeParse({ kind: 'weekly', days: [1], times: ['9am'], timeZone: 'UTC' }).success).toBe(false)
  })
})

describe('what a scheduler that slept owes', () => {
  const from = utc('2026-11-26T08:00:00')
  const hourly: TaskSchedule = { kind: 'every', minutes: 60, from: new Date(from).toISOString() }

  it('runs a time it reads within two minutes on time', () => {
    expect(scheduleDue(hourly, 'skip', from, from + 3_600_000 + 30_000)).toEqual({ run: { trigger: 'schedule', dueAt: from + 3_600_000 }, missed: 0 })
  })

  it('runs the newest missed time once, late, and counts the rest as missed, or skips them all', () => {
    const now = from + 5 * 3_600_000 + 20 * 60_000
    expect(scheduleDue(hourly, 'run-once', from, now)).toEqual({ run: { trigger: 'late', dueAt: from + 5 * 3_600_000 }, missed: 4 })
    expect(scheduleDue(hourly, 'skip', from, now)).toEqual({ run: null, missed: 5 })
  })

  it('owes nothing when the clock has not moved on, or was set back', () => {
    expect(scheduleDue(hourly, 'run-once', from + 10, from + 10)).toEqual({ run: null, missed: 0 })
    expect(scheduleDue(hourly, 'run-once', from + 10, from)).toEqual({ run: null, missed: 0 })
  })

  it('names each time by its instant and waits longer after each failed try, to ten minutes', () => {
    expect(scheduleKey(from)).toBe('schedule:2026-11-26T08:00:00.000Z')
    expect(nextDue(null, from)).toBeNull()
    expect([1, 2, 3, 10].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 600_000])
  })
})
