import { z } from 'zod'

/**
 * When a **scheduled task** runs on its own (ADR-0218): once at an instant, every so many minutes from an instant, or on
 * chosen days at chosen times of the wall clock in a named time zone. Pure: main's scheduler and the window's summary
 * both read it, and nothing here keeps a timer.
 *
 * A wall-clock time is read the way the Temporal proposal's `compatible` choice reads it: a time the clock skips when
 * summer time starts runs that much later (2:30 runs at 3:30), and a time the clock passes twice when it ends runs the
 * first time only.
 */

/** The shortest interval an `every` schedule may have, so a mistyped one can't send a prompt a minute. */
export const SCHEDULE_EVERY_MIN_MINUTES = 5
/** The longest: four weeks. */
export const SCHEDULE_EVERY_MAX_MINUTES = 28 * 24 * 60
/** How many times of day a weekly schedule may name. */
export const SCHEDULE_TIMES_MAX = 12
/** How many occurrences one evaluation counts before it stops counting ("1000 or more"). */
export const OCCURRENCE_COUNT_MAX = 1000

const instant = z.iso.datetime({ offset: true })
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)

export const taskScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: instant }).strict(),
  z.object({ kind: z.literal('every'), minutes: z.number().int().min(SCHEDULE_EVERY_MIN_MINUTES).max(SCHEDULE_EVERY_MAX_MINUTES), from: instant }).strict(),
  z.object({
    kind: z.literal('weekly'),
    /** ISO weekdays: 1 is Monday and 7 is Sunday. */
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    times: z.array(clockTime).min(1).max(SCHEDULE_TIMES_MAX),
    timeZone: z.string().min(1).max(64),
  }).strict(),
])
export type TaskSchedule = z.infer<typeof taskScheduleSchema>

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(timeZone, found)
  }
  return found
}

/** Whether this computer knows the IANA time zone, such as `Europe/London`. */
export function isTimeZone(timeZone: string): boolean {
  try { formatter(timeZone); return true } catch { return false }
}

/** The wall clock in a zone at an instant, to the minute. */
export function wallClock(at: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(at))) if (part.type !== 'literal') parts[part.type] = Number(part.value)
  const year = parts['year']!, month = parts['month']!, day = parts['day']!
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7
  return { year, month, day, hour: parts['hour']! % 24, minute: parts['minute']!, weekday }
}

/** The zone's offset from UTC at an instant, in minutes. */
function offsetMinutes(at: number, timeZone: string): number {
  const clock = wallClock(at, timeZone)
  const local = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute)
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000)
}

const DAY_MS = 86_400_000

/**
 * The instant a zone's wall clock shows a date and time. A time the clock skips runs that much later; a time it shows
 * twice is the first of the two.
 */
export function wallClockInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const local = Date.UTC(year, month - 1, day, hour, minute)
  // Offsets a day either side hold across any one change, since a zone never changes twice in two days.
  const before = offsetMinutes(local - DAY_MS, timeZone), after = offsetMinutes(local + DAY_MS, timeZone)
  const early = local - before * 60_000
  if (before === after) return early
  const late = local - after * 60_000
  const earlyHolds = offsetMinutes(early, timeZone) === before, lateHolds = offsetMinutes(late, timeZone) === after
  if (earlyHolds && lateHolds) return Math.min(early, late)
  if (earlyHolds) return early
  if (lateHolds) return late
  // Skipped: the old offset puts it as far past the change as it asked to be past the hour.
  return early
}

function weeklyOccurrence(schedule: Extract<TaskSchedule, { kind: 'weekly' }>, reference: number, direction: 1 | -1): number | null {
  if (!isTimeZone(schedule.timeZone)) return null
  const start = wallClock(reference, schedule.timeZone)
  // Eight days reach every weekday once more, even across a change of offset.
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset * direction))
    if (!schedule.days.includes(date.getUTCDay() || 7)) continue
    let nearest: number | null = null
    for (const time of schedule.times) {
      const [hour, minute] = time.split(':').map(Number) as [number, number]
      const at = wallClockInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, schedule.timeZone)
      if ((at - reference) * direction > 0 && (nearest === null || (at - nearest) * direction < 0)) nearest = at
    }
    if (nearest !== null) return nearest
  }
  return null
}

/** The first time the schedule names strictly after `after`, or null when it names none. */
export function nextOccurrence(schedule: TaskSchedule, after: number): number | null {
  switch (schedule.kind) {
    case 'once': {
      const at = Date.parse(schedule.at)
      return at > after ? at : null
    }
    case 'every': {
      const from = Date.parse(schedule.from), period = schedule.minutes * 60_000
      if (after < from) return from
      return from + (Math.floor((after - from) / period) + 1) * period
    }
    case 'weekly': return weeklyOccurrence(schedule, after, 1)
  }
}

/**
 * The occurrences after `from` up to and including `to`: how many, counted to `OCCURRENCE_COUNT_MAX`, and the newest.
 * What a scheduler that slept, or a Sotto that was closed, missed in between.
 */
export function occurrencesBetween(schedule: TaskSchedule, from: number, to: number): { readonly count: number; readonly newest: number | null } {
  if (to <= from) return { count: 0, newest: null }
  if (schedule.kind === 'every') {
    const first = nextOccurrence(schedule, from)
    if (first === null || first > to) return { count: 0, newest: null }
    const period = schedule.minutes * 60_000
    const count = Math.floor((to - first) / period) + 1
    return { count: Math.min(count, OCCURRENCE_COUNT_MAX), newest: first + (count - 1) * period }
  }
  let count = 0, newest: number | null = null, cursor = from
  while (count < OCCURRENCE_COUNT_MAX) {
    const next = nextOccurrence(schedule, cursor)
    if (next === null || next > to) break
    count++; newest = next; cursor = next
  }
  if (schedule.kind === 'weekly' && count === OCCURRENCE_COUNT_MAX) newest = weeklyOccurrence(schedule, to + 1, -1) ?? newest
  return { count, newest }
}

/** Whether a schedule can still name a time after `after`: a `once` whose time has passed cannot. */
export const scheduleHasFuture = (schedule: TaskSchedule, after: number): boolean => nextOccurrence(schedule, after) !== null
