import { i18n } from '@lingui/core'
import { plural, t } from '@lingui/core/macro'
import type { MachineEntry, MachineProblem } from '../../../shared/machineLine'
import { unknownReason } from '../../../shared/machineLine'
import { WORKING_THREADS_QUIET_MAX } from '../../../shared/workingThreads'
import { checksWaitingWords } from './checkQueueWords'

/**
 * The machines line's words, and its panel's and Settings', in the interface language (ADR-0123). What the line says is
 * worked out in `src/shared/machineLine.ts`; this says it. Numbers, memory and times are formatted by `Intl` in the
 * reader's language, and a list of a machine's count and problems is joined as that language joins one.
 */

const locale = (): string => i18n.locale || 'en'
/** "3 working, 1 starting, busy": the language's own way of listing a few short things. */
export function listWords(parts: readonly string[]): string {
  return new Intl.ListFormat(locale(), { type: 'unit', style: 'short' }).format(parts.filter(Boolean))
}

/** A machine's name: the one the user saved, or This computer in the interface language. */
export function machineName(entry: Pick<MachineEntry, 'name' | 'thisComputer'>): string {
  return entry.thisComputer ? t`This computer` : entry.name
}

/** The words a problem adds after a machine's count. */
export function problemWords(problem: MachineProblem): string {
  switch (problem) {
    case 'not-connected': return t`not connected`
    case 'over': return t`may slow down`
    case 'busy': return t`busy`
    case 'short': return t`short on memory`
    case 'unknown': return t`load unknown`
  }
}

/**
 * "3 working", or "3 working, 1 starting" while work placed there has not begun; nothing for a machine not connected. With
 * checks waiting their turn there (#1312, Owl only), "3 working, 2 checks waiting", and "2 waiting" on the narrow line.
 */
export function countWords(entry: MachineEntry, withStarting = true, waiting = 0): string {
  if (!entry.connected) return ''
  const working = entry.working, starting = entry.starting
  const parts = [plural(working, { one: '# working', other: '# working' })]
  if (withStarting && starting > 0) parts.push(plural(starting, { one: '# starting', other: '# starting' }))
  if (waiting > 0) parts.push(checksWaitingWords(waiting, !withStarting))
  return listWords(parts)
}

/** What follows a machine's name on the line: "3 working, busy", "not connected". */
export function tailWords(entry: MachineEntry, withStarting = true, waiting = 0): string {
  return listWords([countWords(entry, withStarting, waiting), ...entry.problems.map(problemWords)])
}

/** One machine as the line reads it, in words: "forge 3 working, busy", "forge not connected". */
export function lineText(entry: MachineEntry, withStarting = true, waiting = 0): string {
  const name = machineName(entry), tail = tailWords(entry, withStarting, waiting)
  return tail ? t`${name} ${tail}` : name
}

/** What a press on a machine's name does, with what the line shows of it first, for its accessible name. */
export function machineLabel(entry: MachineEntry, withStarting = true, waiting = 0): string {
  const shown = listWords([machineName(entry), countWords(entry, withStarting, waiting), ...entry.problems.map(problemWords)])
  const name = entry.name
  return entry.thisComputer ? t`${shown}. Show this computer’s load and what runs there.` : t`${shown}. Show ${name}’s load and what runs there.`
}

/**
 * The short line when nothing is wrong on any machine: "3 machines, 5 working", the press that shows every machine. With
 * checks waiting on any of them (#1312, Owl only), "3 machines, 5 working, 2 waiting".
 */
export function calmWords(entries: readonly MachineEntry[], waiting = 0): string {
  const machines = entries.length, working = entries.reduce((sum, entry) => sum + entry.working, 0)
  return listWords([plural(machines, { one: '# machine', other: '# machines' }), plural(working, { one: '# working', other: '# working' }),
    ...waiting > 0 ? [checksWaitingWords(waiting, true)] : []])
}
/** The calm line's accessible name. */
export function calmLabel(entries: readonly MachineEntry[], waiting = 0): string {
  const calm = calmWords(entries, waiting)
  return t`${calm}, nothing wrong. Show every machine`
}
/** "2 more", the press that shows every machine the short line left out. */
export function moreWords(count: number): string {
  return plural(count, { one: '# more', other: '# more' })
}
/** That press's accessible name. */
export function moreLabel(count: number): string {
  return plural(count, { one: '# more machine. Show every machine', other: '# more machines. Show every machine' })
}

/** Memory as the panel and Settings say it: "41 GB", "1.6 GB". */
export function memoryWords(bytes: number): string {
  const gb = bytes / 1024 ** 3
  return new Intl.NumberFormat(locale(), { style: 'unit', unit: 'gigabyte', maximumFractionDigits: gb >= 10 ? 0 : 1 }).format(gb)
}

/** A share of the processors' time: "93%". */
export function percentWords(percent: number): string {
  return new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(percent / 100)
}

/** How long ago a reading was taken: "6 sec. ago", "3 min. ago", in the language's own short form. */
export function agoWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const format = new Intl.RelativeTimeFormat(locale(), { style: 'short', numeric: 'always' })
  if (seconds < 60) return format.format(-seconds, 'second')
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? format.format(-minutes, 'minute') : format.format(-Math.round(minutes / 60), 'hour')
}

/** The span a CPU reading covers: "the last 2 seconds", "the last minute". */
export function windowWords(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return plural(seconds, { one: 'the last second', other: 'the last # seconds' })
  const minutes = Math.round(seconds / 60)
  return plural(minutes, { one: 'the last minute', other: 'the last # minutes' })
}

/** The panel's CPU row: "93% busy over the last 2 seconds", with ". Busy" when it is. */
export function cpuWords(percent: number, windowMs: number, busy: boolean): string {
  const share = percentWords(percent), span = windowWords(windowMs)
  return busy ? t`${share} busy over ${span}. Busy` : t`${share} busy over ${span}`
}

/** The panel's memory row: "41 GB of 64 GB available", with ". Short on memory" when it is. */
export function memoryRowWords(available: number, total: number | null, short: boolean): string {
  const free = memoryWords(available)
  if (total === null) return short ? t`${free} available. Short on memory` : t`${free} available`
  const all = memoryWords(total)
  return short ? t`${free} of ${all} available. Short on memory` : t`${free} of ${all} available`
}

/** The warning above ten, in the panel: this computer's own sentence, or another machine's. */
export function overWords(entry: MachineEntry): string | null {
  if (entry.working <= WORKING_THREADS_QUIET_MAX) return null
  const name = entry.name
  return entry.thisComputer ? t`More than ten threads are working on this computer. This computer may slow down or use its battery faster. Nothing is stopped or held back.`
    : t`More than ten threads are working on ${name}. It may slow down. Nothing is stopped or held back.`
}

/**
 * Why a machine's load reads unknown, in a sentence for its panel, or null when it is known. A machine never reads idle
 * for want of a reading: Watcher treats it as unknown.
 */
export function unknownWhyWords(entry: MachineEntry, now: number): string | null {
  const reason = unknownReason(entry, now)
  if (reason === null) return null
  const name = entry.name, local = entry.thisComputer
  switch (reason.kind) {
    case 'older-host': return local ? t`This computer runs an older Sotto host that does not report its load. Watcher treats it as unknown, never idle. Update it in Settings, under Hosts & phones.`
      : t`${name} runs an older Sotto host that does not report its load. Watcher treats it as unknown, never idle. Update it in Settings, under Hosts & phones.`
    case 'unread': return local ? t`Sotto could not read this computer’s load just now. Watcher treats it as unknown, never idle. It reads again when you open this.`
      : t`Sotto could not read ${name}’s load just now. Watcher treats it as unknown, never idle. It reads again when you open this.`
    case 'stale': {
      const ago = agoWords(reason.ageMs)
      return local ? t`The last reading is ${ago}, older than a minute, so Watcher treats this computer’s load as unknown, not idle.`
        : t`The last reading is ${ago}, older than a minute, so Watcher treats ${name}’s load as unknown, not idle.`
    }
    case 'cpu-unreported': return local ? t`This computer does not report how busy its processors are, so Watcher treats its load as unknown, not idle.`
      : t`${name} does not report how busy its processors are, so Watcher treats its load as unknown, not idle.`
    case 'memory-unreported': return local ? t`This computer does not report the memory a new process could have, so Watcher treats its memory as unknown, not plentiful.`
      : t`${name} does not report the memory a new process could have, so Watcher treats its memory as unknown, not plentiful.`
    case 'memory-changed': return local ? t`This computer’s memory changed during the reading, so Watcher treats it as unknown until the next one.`
      : t`${name}’s memory changed during the reading, so Watcher treats it as unknown until the next one.`
  }
}
