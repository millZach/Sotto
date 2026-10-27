import { plural, t } from '@lingui/core/macro'

import { PROVIDER_LABELS, type AgentThread } from '../../../shared/agents'
import { isLimitRestartNoteText } from '../../../shared/limitRestart'
import { providerIdSchema } from '../../../shared/providerIds'
import { isResumeNoteText } from '../../../shared/restartResume'
import { isThreadArchived } from '../../../shared/threadActivity'
import { shownCount } from '../state/interfaceNumbers'
import { localeFormatter } from './localeFormat'

/**
 * What the window says about restarting stopped threads (ADR-0144, an Owl feature): the band at the top of the Threads
 * sidebar, the strip over a stopped thread's composer, the row's "Restarts at 3:00 pm", and the tag on Sotto's note.
 * Every claim is read from the `scheduledRestart` the thread's host published, never worked out here.
 */

/**
 * Whether a message Sotto's own record has already marked as a wake-up is a restart note: the note sent when a limit
 * resets, or the resume note after Sotto itself restarted. Either opens the wake-up it is part of; text alone never makes
 * a message Sotto's.
 */
export function isRestartNoteText(text: string): boolean {
  return isResumeNoteText(text) || isLimitRestartNoteText(text)
}

/** The provider's own name for an ID the host published; a name it does not know is shown as it came. */
export function restartProviderName(provider: string): string {
  const id = providerIdSchema.safeParse(provider)
  return id.success ? PROVIDER_LABELS[id.data] : provider
}

const clockTime = localeFormatter({ hour: 'numeric', minute: '2-digit' })
const weekday = localeFormatter({ weekday: 'long' })
const monthDay = localeFormatter({ month: 'short', day: 'numeric' })
const DAY_MS = 24 * 60 * 60_000

/** Midnight of the moment's own day, on this computer's clock. */
function dayStart(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.valueOf()
}

/**
 * When a restart is due, as a sentence goes on after "Restarts" or "resets": "at 3:00 pm" today, "tomorrow at 3:00 pm",
 * "Thursday at 3:00 pm" within the week, "on Oct 30 at 3:00 pm" after that. Null once the moment has passed, which happens
 * only while Sotto waits for the provider to connect again, and when the moment cannot be read.
 */
export function restartWhen(at: number, now: number): string | null {
  if (!Number.isFinite(at) || at <= now) return null
  // As the rest of the window says a time (`clockLabel`), "3:00 pm".
  const clock = clockTime(new Date(at)).toLocaleLowerCase()
  const days = Math.round((dayStart(at) - dayStart(now)) / DAY_MS)
  if (days <= 0) return t({ message: `at ${clock}`, comment: 'When a stopped thread restarts today, as in "Restarts at 3:00 pm".' })
  if (days === 1) return t({ message: `tomorrow at ${clock}`, comment: 'When a stopped thread restarts, as in "Restarts tomorrow at 3:00 pm".' })
  if (days < 7) {
    const day = weekday(new Date(at))
    return t({ message: `${day} at ${clock}`, comment: '{day} is a day of the week, as in "Restarts Thursday at 3:00 pm".' })
  }
  const date = monthDay(new Date(at))
  return t({ message: `on ${date} at ${clock}`, comment: '{date} is a month and day, as in "Restarts on Oct 30 at 3:00 pm".' })
}

/** The moment a thread's scheduled restart is due, or NaN when its provider did not say when its limit resets. */
export function restartAt(thread: Pick<AgentThread, 'scheduledRestart'>): number {
  const at = thread.scheduledRestart?.at
  return at === undefined ? Number.NaN : Date.parse(at)
}

/**
 * The sidebar row's line for a thread whose restart is scheduled, in place of its failure line: "Restarts at 3:00 pm".
 * Undefined for a thread with no time to restart at, an archived one, and one with a request waiting on the user.
 */
export function restartRowWords(thread: Pick<AgentThread, 'scheduledRestart' | 'requests' | 'archivedAt'>, now = Date.now()): string | undefined {
  if (thread.scheduledRestart?.at === undefined || thread.requests.length > 0 || isThreadArchived(thread)) return undefined
  const when = restartWhen(restartAt(thread), now)
  return when === null
    ? t({ message: 'Restarts soon', comment: 'A thread row\'s state: its usage limit has reset and Sotto restarts it once it can.' })
    : t({ message: `Restarts ${when}`, comment: 'A thread row\'s state. {when} is "at 3:00 pm", "tomorrow at 3:00 pm" or "Thursday at 3:00 pm".' })
}

/** The strip over a stopped thread's composer, in one sentence. */
export function restartStripWords(thread: Pick<AgentThread, 'scheduledRestart'>, now = Date.now()): string | undefined {
  const scheduled = thread.scheduledRestart
  if (scheduled === undefined) return undefined
  const name = restartProviderName(scheduled.provider)
  if (scheduled.at === undefined) return t({ message: `${name} didn’t say when its limit resets. Send again once it has.`, comment: '{name} is a provider, such as Devin.' })
  const when = restartWhen(restartAt(thread), now)
  return when === null
    ? t({ message: `${name}’s limit has reset. Sotto restarts this thread once it can.`, comment: '{name} is a provider, such as Claude Code.' })
    : t({ message: `Restarts ${when}, when ${name}’s limit resets.`, comment: '{when} is "at 3:00 pm", "tomorrow at 3:00 pm" or "Thursday at 3:00 pm"; {name} is a provider, such as Claude Code.' })
}

/** One band in the sidebar: a provider's threads restarting at one moment, or its threads it gave no time for. */
export interface RestartGroup {
  readonly key: string
  readonly provider: string
  readonly name: string
  /** When they restart; NaN when the provider did not say. */
  readonly at: number
  /** Watcher's own thread first, then the rest in the order they stopped. */
  readonly threads: readonly AgentThread[]
  readonly watcherFirst: boolean
}

const isWatcher = (thread: Pick<AgentThread, 'kind'>): boolean => thread.kind === 'watcher'

/**
 * The bands the sidebar shows: one per provider with scheduled threads, soonest first. Threads of one provider due at
 * different moments, as two of Codex's windows can be, get a band each, so no band claims a time one of its threads
 * does not have. Watcher's own thread counts only while Watcher is on, since nothing else of it shows then.
 */
export function restartGroups(threads: readonly AgentThread[], watcherOn: boolean): readonly RestartGroup[] {
  const groups = new Map<string, { provider: string; at: number; threads: AgentThread[] }>()
  for (const thread of threads) {
    const scheduled = thread.scheduledRestart
    if (scheduled === undefined || isThreadArchived(thread) || (thread.kind === 'watcher' || thread.kind === 'watcher-history') && !watcherOn) continue
    const at = restartAt(thread)
    const key = `${scheduled.provider}\n${Number.isFinite(at) ? at : 'unsaid'}`
    const group = groups.get(key) ?? { provider: scheduled.provider, at, threads: [] }
    group.threads.push(thread)
    groups.set(key, group)
  }
  const stopped = (thread: AgentThread): number => Date.parse(thread.scheduledRestart?.stoppedAt ?? '')
  return [...groups].map(([key, group]) => {
    const ordered = group.threads.sort((left, right) => Number(isWatcher(right)) - Number(isWatcher(left)) || stopped(left) - stopped(right))
    return { key, provider: group.provider, name: restartProviderName(group.provider), at: group.at, threads: ordered,
      watcherFirst: ordered.length > 1 && isWatcher(ordered[0]!) }
  }).sort((left, right) => (Number.isFinite(left.at) ? left.at : Infinity) - (Number.isFinite(right.at) ? right.at : Infinity) || left.name.localeCompare(right.name))
}

/** The band's first sentence, said strongly: when the provider's limit resets. */
export function restartBandLead(group: RestartGroup, now = Date.now()): string {
  const name = group.name
  if (!Number.isFinite(group.at)) return t({ message: `${name} didn’t say when its limit resets,`, comment: 'The start of a sentence that goes on "so Sotto can’t restart its 2 threads on its own." {name} is a provider, such as Devin.' })
  const when = restartWhen(group.at, now)
  return when === null
    ? t({ message: `${name}’s limit has reset.`, comment: '{name} is a provider, such as Claude Code.' })
    : t({ message: `${name}’s limit resets ${when}.`, comment: '{when} is "at 3:00 pm", "tomorrow at 3:00 pm" or "Thursday at 3:00 pm"; {name} is a provider, such as Claude Code.' })
}

/** The rest of the band's sentence: what Sotto does then, or that it can't. */
export function restartBandRest(group: RestartGroup, now = Date.now()): string {
  const count = group.threads.length
  const threads = shownCount(count)
  if (!Number.isFinite(group.at)) return plural(count, {
    one: `so Sotto can’t restart its thread on its own. Send again once it resets.`,
    other: `so Sotto can’t restart its ${threads} threads on its own. Send again once it resets.`,
  })
  if (restartWhen(group.at, now) === null) return group.watcherFirst
    ? plural(count, { one: `Sotto restarts ${threads} thread once it can, Watcher first.`, other: `Sotto restarts ${threads} threads once it can, Watcher first.` })
    : plural(count, { one: `Sotto restarts ${threads} thread once it can.`, other: `Sotto restarts ${threads} threads once it can.` })
  return group.watcherFirst
    ? plural(count, { one: `Sotto restarts ${threads} thread then, Watcher first.`, other: `Sotto restarts ${threads} threads then, Watcher first.` })
    : plural(count, { one: `Sotto restarts ${threads} thread then.`, other: `Sotto restarts ${threads} threads then.` })
}

/** Don't restart them's accessible name, which says whose threads a press keeps from restarting. */
export function restartBandCancelLabel(group: RestartGroup): string {
  const count = group.threads.length, name = group.name, threads = shownCount(count)
  return plural(count, { one: `Don’t restart ${name}’s ${threads} thread`, other: `Don’t restart ${name}’s ${threads} threads` })
}
