import { plural, t } from '@lingui/core/macro'
import type { CheckQueueEntry } from '../../../shared/checkQueue'

/**
 * A machine's checks in words, in the interface language (ADR-0123), for the machines line, the machine's panel and Tools ›
 * Agents (#1312, fourth part, Zach's pick C). The user's word is "check": a test run Sotto queues on one machine, never a
 * pull request's CI check. A check's outcome stays Working while it waits, so no word here is an outcome.
 */

/** What the machines line adds after a machine's working count: "2 checks waiting", or "2 waiting" on the narrow line. */
export function checksWaitingWords(count: number, short: boolean): string {
  return short ? plural(count, { one: '# waiting', other: '# waiting' }) : plural(count, { one: '# check waiting', other: '# checks waiting' })
}

/** A waiting check's place, as its row in Tools › Agents says it: "Waiting for forge’s check to finish. 1 ahead." */
export function checkWaitingSentence(machine: string, thisComputer: boolean, ahead: number): string {
  return thisComputer
    ? plural(ahead, { one: 'Waiting for this computer’s check to finish. # ahead.', other: 'Waiting for this computer’s checks to finish. # ahead.' })
    : plural(ahead, { one: `Waiting for ${machine}’s check to finish. # ahead.`, other: `Waiting for ${machine}’s checks to finish. # ahead.` })
}

/** Zach's sentence for a check whose packages install first (October 23, 2026), as its row in Tools › Agents says it. */
export function checkInstallSentence(machine: string, thisComputer: boolean): string {
  return thisComputer ? t`Installing packages first, because package-lock.json changed since the last check on this computer. The checks start when that finishes.`
    : t`Installing packages first, because package-lock.json changed since the last check on ${machine}. The checks start when that finishes.`
}

/** The heading over a machine's checks: in its own panel, and in Tools › Agents, where the machine is named. */
export function checksHeading(machine: string | null, thisComputer: boolean): string {
  if (machine === null) return t`Checks, one at a time`
  return thisComputer ? t`Checks on this computer, one at a time` : t`Checks on ${machine}, one at a time`
}

/** Under a machine's checks: why they wait. */
export function checksNote(machine: string, thisComputer: boolean): string {
  return thisComputer ? t`This computer runs one check at a time. The rest wait here in the order they were asked for, whoever asked.`
    : t`${machine} runs one check at a time. The rest wait here in the order they were asked for, whoever asked.`
}

/** Whose a check is: Watcher's, or the thread's that delegated it, by its title where the window holds it. */
export function checkWhoseWords(check: Pick<CheckQueueEntry, 'whose'>, by: string | undefined): string | undefined {
  if (check.whose === 'watcher') return t({ message: 'Watcher’s', comment: 'Whose a check is: Watcher started it.' })
  if (check.whose !== 'thread') return undefined
  return by === undefined ? t({ message: 'A thread’s', comment: 'Whose a check is: a thread delegated it.' }) : t`Delegated by ${by}`
}

/**
 * Where a check stands in its machine's list: running, or installing packages first, for the one whose turn it is; how many
 * are ahead for the rest.
 */
export function checkStateWords(at: number, installing: boolean): string {
  if (at === 0) return installing ? t`installing packages first, because package-lock.json changed` : t({ message: 'running', comment: 'The check whose turn it is on its machine.' })
  return plural(at, { one: '# ahead', other: '# ahead' })
}

/** A check with no title the window can show. */
export function untitledCheck(): string { return t`A check` }
