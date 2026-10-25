import { i18n } from '@lingui/core'
import { plural, t } from '@lingui/core/macro'

import { countWords, type DictationRecord } from '../../../../shared/dictationRecord'
import type { HistoryEntry } from '../../../../shared/history'
import { languageLabel } from '../../languages'

/**
 * The Journal's arithmetic: days, labels, a transcript's facts, and the stats column, all worked out from
 * transcripts and dictation records (ADR-0100) with nothing kept of its own. Days are local calendar days, so
 * stepping a day goes through `Date#setDate` and stays on midnight across daylight-saving changes.
 */

/** How many days the feed adds at a time: the first week, then each "Show the 7 days before". */
export const JOURNAL_DAYS_STEP = 7
/** How far back "usual" looks. */
export const USUAL_DAYS = 90
/** The window for speed, Where and the app chips. */
export const RECENT_DAYS = 30
/** The streak calendar's width, in weeks. */
export const CALENDAR_WEEKS = 13
/** How many apps Where lists, and how many chips sit beside All. */
export const WHERE_APPS = 4
export const CHIP_APPS = 5

export function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.valueOf()
}

/** Midnight `days` calendar days before the midnight `day`. */
export function daysBefore(day: number, days: number): number {
  const date = new Date(day)
  date.setDate(date.getDate() - days)
  return date.valueOf()
}

/** Day labels: Today, Yesterday, then the weekday and date. */
export function dayLabel(createdAt: number, now: number): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return t({ message: 'Saved', comment: 'A Journal day or time label for a transcript whose date is unknown' })
  const today = startOfDay(now)
  if (createdAt >= today) return t`Today`
  if (createdAt >= daysBefore(today, 1)) return t`Yesterday`
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

/** The row's clock: "2:32 pm" in a 12-hour locale, "14:32" in a 24-hour one. */
export function clockLabel(createdAt: number): { dateTime?: string; time: string; full: string } {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.valueOf())) return { time: t({ message: 'Saved', comment: 'A Journal day or time label for a transcript whose date is unknown' }), full: t`Saved transcript` }
  return {
    dateTime: date.toISOString(),
    time: date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/u, (period) => period.toLowerCase()),
    full: date.toLocaleString(),
  }
}

/** An hour of the day the way the clock reads it: "2 pm" in a 12-hour locale, "14" in a 24-hour one. */
export function hourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' })
    .replace(/\s?[AP]M$/u, (period) => ` ${period.trim().toLowerCase()}`)
}

export function shortDate(day: number): string {
  return new Date(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** A count as the interface language writes it: "1,240" in English, "1.240" in German. */
export function countLabel(value: number): string {
  return new Intl.NumberFormat(i18n.locale).format(value)
}

/** "1,240 words": the count written by countLabel, in a message that says it in the reader's plural. */
export function wordsLabel(words: number): string {
  const shown = countLabel(words)
  return plural(words, { one: `${shown} word`, other: `${shown} words` })
}

/** Minutes for a person: "45 min", "2 h", "1 h 20 min". */
export function minutesLabel(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes))
  if (rounded < 60) return `${rounded} min`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function lengthLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000))
  if (seconds < 60) return plural(seconds, { one: '# second', other: '# seconds' })
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/** Entries kept from before Parakeet (ADR-0071) name the model that transcribed them, or an earlier one. */
function modelLabel(preset: HistoryEntry['modelPreset']): string {
  if (preset === 'parakeet') return t`Parakeet model`
  return preset === 'mai' ? t`MAI-Transcribe-2 model` : t({ message: 'an earlier model', comment: 'Mid-sentence, after the dictation language: "English, an earlier model."' })
}

/** Words a minute, or null when nothing was timed. */
export function pace(words: number, durationMs: number): number | null {
  return durationMs > 0 && words > 0 ? Math.round(words / (durationMs / 60_000)) : null
}

/** What one transcript says about itself in its collapsed row and when it opens. */
export interface JournalRow {
  readonly entry: HistoryEntry
  readonly words: number
  readonly wpm: number | null
  /** The delivered app, from the transcript or, for one saved before it carried one, its record. */
  readonly app: string | undefined
}

/** `words` lets the Journal pass a count it already made for this transcript instead of counting again. */
export function journalRow(entry: HistoryEntry, record: DictationRecord | undefined, words: number = countWords(entry.text)): JournalRow {
  return { entry, words, wpm: pace(words, entry.durationMs), app: entry.app ?? record?.app }
}

/** The collapsed row's line under the text: "Outlook · 42 words · 128 wpm", without the parts it does not know. */
export function rowMeta(row: JournalRow): string {
  const wpm = row.wpm
  return [row.app, wordsLabel(row.words), wpm === null ? undefined : t`${wpm} wpm`].filter(Boolean).join(' · ')
}

/**
 * The facts line under an open transcript, built only from what Sotto keeps: length, words and pace in bold, then
 * language, model, the app it went to and where it is kept. Whether it was pasted or copied is not stored, so it is
 * not claimed.
 */
export function transcriptFacts(row: JournalRow): { lead: string; rest: string } {
  const { entry, words, wpm } = row
  const length = lengthLabel(entry.durationMs)
  const wordCount = wordsLabel(words)
  const lead = entry.durationMs > 0
    ? wpm === null ? t`${length}, ${wordCount}.` : t`${length}, ${wordCount} at ${wpm} wpm.`
    : `${wordCount}.`
  const language = languageLabel(entry.language)
  const model = modelLabel(entry.modelPreset)
  const app = row.app
  return { lead, rest: app === undefined ? t`${language}, ${model}. Kept on this computer only.` : t`${language}, ${model}, in ${app}. Kept on this computer only.` }
}

export interface JournalDay {
  readonly day: number
  readonly label: string
  readonly rows: JournalRow[]
  readonly words: number
  readonly wpm: number | null
}

/**
 * The feed's days, newest first, and whether older ones are waiting. The window opens on today and the days before
 * it; when nothing that matches falls inside it, it opens on the newest matching day instead, so a quiet week never
 * leaves the feed empty above a button. `rows` are newest first, as main lists transcripts, so only the days shown
 * are read: one more week costs that week, not every transcript kept.
 */
export function journalDays(rows: readonly JournalRow[], now: number, daysShown: number): { days: JournalDay[]; more: boolean } {
  const sorted = rows
  const newest = sorted[0]
  if (newest === undefined) return { days: [], more: false }
  const today = startOfDay(now)
  const firstWindow = daysBefore(today, JOURNAL_DAYS_STEP - 1)
  const top = newest.entry.createdAt >= firstWindow ? today : startOfDay(newest.entry.createdAt)
  const cutoff = daysBefore(top, daysShown - 1)
  const days: JournalDay[] = []
  let more = false
  for (const row of sorted) {
    if (row.entry.createdAt < cutoff) { more = true; break }
    const day = startOfDay(row.entry.createdAt)
    const last = days.at(-1)
    if (last !== undefined && last.day === day) last.rows.push(row)
    else days.push({ day, label: dayLabel(row.entry.createdAt, now), rows: [row], words: 0, wpm: null })
  }
  return {
    days: days.map((group) => {
      const words = group.rows.reduce((sum, row) => sum + row.words, 0)
      const timed = group.rows.filter((row) => row.entry.durationMs > 0)
      return { ...group, words, wpm: pace(timed.reduce((sum, row) => sum + row.words, 0), timed.reduce((sum, row) => sum + row.entry.durationMs, 0)) }
    }),
    more,
  }
}

interface Tally { count: number; words: number; timedWords: number; timedMs: number }
const emptyTally = (): Tally => ({ count: 0, words: 0, timedWords: 0, timedMs: 0 })
function add(tally: Tally, record: DictationRecord): void {
  tally.count += 1
  tally.words += record.words
  if (record.durationMs > 0) { tally.timedWords += record.words; tally.timedMs += record.durationMs }
}
const tallyPace = (tally: Tally): number | null => pace(tally.timedWords, tally.timedMs)

export interface CalendarCell {
  readonly day: number
  readonly words: number
  /** 0 for no dictation, then 1 to 4 against the busiest day shown. */
  readonly level: 0 | 1 | 2 | 3 | 4
  readonly today: boolean
}

export interface JournalStats {
  readonly today: { readonly words: number; readonly count: number; readonly wpm: number | null }
  /** The average pace over the last 90 days, today included. */
  readonly usual: number | null
  /** Each of the last 30 days, oldest first, with its pace or null where nothing was timed. */
  readonly speed: ReadonlyArray<{ readonly day: number; readonly wpm: number | null }>
  /** Days in a row with dictation, ending today, or yesterday while today has none yet. */
  readonly streak: number
  /** The longest run of days with dictation in the last year. */
  readonly longestStreak: number
  /** Thirteen weeks, a column a week from Sunday, today's week last; days after today are left out. */
  readonly calendar: ReadonlyArray<ReadonlyArray<CalendarCell | null>>
  readonly calendarDays: number
  /** The apps that took the most words in the last 30 days, with each one's share of the words that went to a known app. */
  readonly where: ReadonlyArray<{ readonly app: string; readonly words: number; readonly share: number }>
  /** App names for the chips, busiest first. Records without an app are left out. */
  readonly chips: readonly string[]
  readonly month: { readonly words: number; readonly savedMinutes: number; readonly busiestHour: number | null }
}

/** How far back the longest streak looks. */
export const LONGEST_STREAK_DAYS = 365

/**
 * Everything the stats column shows, from dictation records alone, so it keeps counting with History off. `records`
 * are newest first, as main lists them, and only the last year of them is read, so the work stays the same however
 * many years of records a computer keeps.
 */
export function journalStats(records: readonly DictationRecord[], now: number, typingWpm: number): JournalStats {
  const today = startOfDay(now)
  const tomorrow = daysBefore(today, -1)
  const usualFrom = daysBefore(today, USUAL_DAYS - 1)
  const recentFrom = daysBefore(today, RECENT_DAYS - 1)
  const monthStart = new Date(today)
  monthStart.setDate(1)
  const monthFrom = monthStart.valueOf()
  const weekStart = daysBefore(today, new Date(today).getDay())
  const firstDay = daysBefore(weekStart, (CALENDAR_WEEKS - 1) * 7)
  const yearFrom = daysBefore(today, LONGEST_STREAK_DAYS - 1)

  const todayTally = emptyTally()
  const usual = emptyTally()
  const month = emptyTally()
  const byDay = new Map<number, Tally>()
  const apps = new Map<string, number>()
  const hours = new Array<number>(24).fill(0)
  const activeDays = new Set<number>()
  const dayWords = new Map<number, number>()

  for (const record of records) {
    if (!Number.isFinite(record.createdAt) || record.createdAt >= tomorrow) continue
    // Newest first: past the last year there is nothing left to count.
    if (record.createdAt < yearFrom) break
    const day = startOfDay(record.createdAt)
    if (record.words > 0) activeDays.add(day)
    if (day >= firstDay) dayWords.set(day, (dayWords.get(day) ?? 0) + record.words)
    if (day === today) add(todayTally, record)
    if (day >= usualFrom) add(usual, record)
    if (day >= recentFrom) {
      let tally = byDay.get(day)
      if (tally === undefined) { tally = emptyTally(); byDay.set(day, tally) }
      add(tally, record)
      if (record.app !== undefined) apps.set(record.app, (apps.get(record.app) ?? 0) + record.words)
    }
    if (day >= monthFrom) {
      add(month, record)
      hours[new Date(record.createdAt).getHours()]! += record.words
    }
  }

  const speed: Array<{ day: number; wpm: number | null }> = []
  for (let back = RECENT_DAYS - 1; back >= 0; back -= 1) {
    const day = daysBefore(today, back)
    const tally = byDay.get(day)
    speed.push({ day, wpm: tally === undefined ? null : tallyPace(tally) })
  }

  let streak = 0
  for (let day = activeDays.has(today) ? today : daysBefore(today, 1); activeDays.has(day); day = daysBefore(day, 1)) streak += 1
  let longestStreak = 0
  let run = 0
  let previous: number | null = null
  for (const day of [...activeDays].sort((first, second) => first - second)) {
    run = previous !== null && daysBefore(day, 1) === previous ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    previous = day
  }

  const busiestDay = Math.max(0, ...dayWords.values())
  const calendar: Array<Array<CalendarCell | null>> = []
  let calendarDays = 0
  for (let week = 0; week < CALENDAR_WEEKS; week += 1) {
    const column: Array<CalendarCell | null> = []
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const day = daysBefore(firstDay, -(week * 7 + weekday))
      if (day > today) { column.push(null); continue }
      const words = dayWords.get(day) ?? 0
      if (words > 0) calendarDays += 1
      const level = words === 0 || busiestDay === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((words / busiestDay) * 4))) as 1 | 2 | 3 | 4
      column.push({ day, words, level, today: day === today })
    }
    calendar.push(column)
  }

  const ranked = [...apps.entries()].sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
  const knownWords = ranked.reduce((sum, [, words]) => sum + words, 0)
  const where = ranked.slice(0, WHERE_APPS).filter(([, words]) => words > 0)
    .map(([app, words]) => ({ app, words, share: knownWords === 0 ? 0 : words / knownWords }))

  const busiest = Math.max(...hours)
  return {
    today: { words: todayTally.words, count: todayTally.count, wpm: tallyPace(todayTally) },
    usual: tallyPace(usual),
    speed,
    streak,
    longestStreak,
    calendar,
    calendarDays,
    where,
    chips: ranked.filter(([, words]) => words > 0).slice(0, CHIP_APPS).map(([app]) => app),
    month: {
      words: month.words,
      savedMinutes: Math.max(0, month.words / Math.max(1, typingWpm) - month.timedMs / 60_000),
      busiestHour: busiest > 0 ? hours.indexOf(busiest) : null,
    },
  }
}
