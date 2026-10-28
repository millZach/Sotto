import { plural } from '@lingui/core/macro'
import type { AgentThread } from '../../shared/agents'
import { parseHostEntityKey } from '../../shared/clientIdentity'
import { delegatedThreadsBelow } from '../../shared/delegation'
import { isThreadTurnRunning } from '../../shared/threadActivity'

/**
 * Stop and settle reaching every machine (#1316 part 3, Owl `cross-machine-work`). Stopping or settling a thread stops or
 * settles the threads it delegated to, at both levels, as on one machine (ADR-0081 decisions 6 and 11, #1253). Delegation
 * stops those on another machine through the asks it already makes there; settling one there is the same Settle the window
 * sends any thread on that machine. These are the window's side of both: which delegated threads are on another machine,
 * and what Stop says of those it could not reach.
 */

/** A thread below another, at either level, on a different machine than the thread that delegated to it. */
export interface DelegatedElsewhere {
  /** The window's key for it. */
  readonly key: string
  readonly hostId: string
  /** Its machine's own ID for it. */
  readonly id: string
  readonly running: boolean
  readonly settledAt: string | null
}

/**
 * The threads below `parentKey`, both levels, from the window's own links, that run on a machine other than its own. One
 * pass over the threads the window holds, whatever the history.
 */
export function delegatedElsewhere(threads: readonly AgentThread[], parentKey: string): DelegatedElsewhere[] {
  const parentHost = parseHostEntityKey(parentKey)?.hostId
  const below = new Set(delegatedThreadsBelow(threads, parentKey))
  if (!below.size) return []
  const elsewhere: DelegatedElsewhere[] = []
  for (const thread of threads) {
    if (!below.has(thread.id)) continue
    const key = parseHostEntityKey(thread.id)
    if (!key || key.hostId === parentHost) continue
    elsewhere.push({ key: thread.id, hostId: key.hostId, id: key.id, running: isThreadTurnRunning(thread), settledAt: thread.workspaceSettledAt ?? null })
  }
  return elsewhere
}

/**
 * How far apart the two machines' clocks may stamp a settle that went with its parent's. Settling a thread settles its
 * delegated threads elsewhere with that machine's own time, so restoring it brings back those settled within this of it,
 * as on one machine it brings back those carrying its timestamp. Not settled with Zach; named here so it changes in one place.
 */
export const SETTLE_CASCADE_SKEW_MS = 2 * 60_000

/** Whether a delegated thread on another machine was settled with its parent, so restoring the parent restores it. */
export function settledWithParent(parentSettledAt: string | null | undefined, childSettledAt: string | null): boolean {
  if (!parentSettledAt || !childSettledAt) return false
  const parent = Date.parse(parentSettledAt), child = Date.parse(childSettledAt)
  return Number.isFinite(parent) && Number.isFinite(child) && Math.abs(child - parent) <= SETTLE_CASCADE_SKEW_MS
}

/**
 * What Stop says when delegated threads it would have stopped run on machines this computer is not connected to: how many
 * on each, by the name the user gave the machine, that they may still be working, and what to do. Nothing is queued, and
 * nothing else was left. Settled with Zach on October 28, 2026 (#1316 part 3).
 */
export function stopUnreachedWords(left: readonly { readonly name: string; readonly count: number }[]): string {
  const parts = left.map(({ name, count }) => plural(count, {
    one: `Sotto couldn't stop # delegated thread on ${name}, because ${name} isn't connected.`,
    other: `Sotto couldn't stop # delegated threads on ${name}, because ${name} isn't connected.`,
  }))
  const total = left.reduce((sum, item) => sum + item.count, 0)
  const next = plural(total, {
    one: 'It may still be working there. Open it from Tools › Agents and stop it once its machine is back.',
    other: 'They may still be working there. Open them from Tools › Agents and stop them once their machine is back.',
  })
  return [...parts, next].join(' ')
}

/**
 * What Stop says of delegated threads on machines that are connected but did not say they stopped (#1316 part 3): a cancel
 * the machine refused, one that could not name its delegation, or one whose answer was lost. How many on each machine, that
 * they may still be working, and where to see. It never says they stopped, and nothing is sent again. Drafted; to be
 * checked with Zach.
 */
export function stopUnconfirmedWords(left: readonly { readonly name: string; readonly count: number }[]): string {
  const parts = left.map(({ name, count }) => plural(count, {
    one: `Sotto couldn't confirm that # delegated thread on ${name} stopped.`,
    other: `Sotto couldn't confirm that # delegated threads on ${name} stopped.`,
  }))
  const total = left.reduce((sum, item) => sum + item.count, 0)
  const next = plural(total, {
    one: 'It may still be working there. Open it from Tools › Agents to see where it stands.',
    other: 'They may still be working there. Open them from Tools › Agents to see where they stand.',
  })
  return [...parts, next].join(' ')
}

/**
 * The delegated threads a Stop left on each machine (#1316 part 3), each counted once, by its machine's key and name in the
 * order first met.
 */
export class StopTally {
  private readonly machines = new Map<string, { readonly name: string; readonly threads: Set<string> }>()
  add(machine: string, name: string, thread: string): void {
    const entry = this.machines.get(machine)
    if (entry) entry.threads.add(thread); else this.machines.set(machine, { name, threads: new Set([thread]) })
  }
  holds(machine: string, thread: string): boolean { return this.machines.get(machine)?.threads.has(thread) === true }
  counts(): { readonly name: string; readonly count: number }[] { return [...this.machines.values()].map(({ name, threads }) => ({ name, count: threads.size })) }
}
/** What Stop says it left on other machines: those it could not reach, then those it did not see stop; nothing when it left none. */
export function stopLeftWords(away: StopTally, unconfirmed: StopTally): string | undefined {
  const unreached = away.counts(), unsure = unconfirmed.counts()
  const said = [...unreached.length ? [stopUnreachedWords(unreached)] : [], ...unsure.length ? [stopUnconfirmedWords(unsure)] : []]
  return said.length ? said.join(' ') : undefined
}
