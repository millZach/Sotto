import { nextOccurrence, occurrencesBetween, type TaskSchedule } from '../../shared/taskSchedules'

/**
 * When a task's schedule is due (ADR-0218). The scheduler reads the clock each time it wakes, never trusting how long it
 * slept (ADR-0021), and asks what came due between the last instant it read and now. A time read within a couple of
 * minutes of when it came is on time; an older one was missed, because Sotto was closed, asleep or had scheduled tasks
 * off, and the task's choice decides: run once, late, for the newest one, or skip. Either way every missed time is
 * counted in one line of the task's history.
 */

/** How late a time may be read and still count as on time. */
export const ON_TIME_GRACE_MS = 2 * 60_000
/** The longest the scheduler sleeps before it reads the clock again, so a changed clock or a wake from sleep is seen. */
export const SCHEDULER_WAKE_MAX_MS = 60_000

export interface ScheduleDue {
  /** The run to start now: on time, or late for the newest time missed. */
  readonly run: { readonly trigger: 'schedule' | 'late'; readonly dueAt: number } | null
  /** Times that passed without a run of their own. */
  readonly missed: number
}

const NOTHING: ScheduleDue = { run: null, missed: 0 }

/** What a schedule owes between `evaluatedAt` and `now`. A clock that went back owes nothing. */
export function scheduleDue(schedule: TaskSchedule, missed: 'run-once' | 'skip', evaluatedAt: number, now: number): ScheduleDue {
  if (now <= evaluatedAt) return NOTHING
  const { count, newest } = occurrencesBetween(schedule, evaluatedAt, now)
  if (count === 0 || newest === null) return NOTHING
  if (now - newest <= ON_TIME_GRACE_MS) return { run: { trigger: 'schedule', dueAt: newest }, missed: count - 1 }
  return missed === 'run-once' ? { run: { trigger: 'late', dueAt: newest }, missed: count - 1 } : { run: null, missed: count }
}

/** The key a scheduled time's run is known by, so the same time never starts two runs. */
export const scheduleKey = (dueAt: number): string => `schedule:${new Date(dueAt).toISOString()}`

/** The next time the schedule names after `after`, or null. */
export const nextDue = (schedule: TaskSchedule | null, after: number): number | null => schedule ? nextOccurrence(schedule, after) : null

/** How long a failed step waits before it is tried again: half a minute, doubling, at most ten minutes. */
export const retryDelayMs = (attempts: number): number => Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1))
