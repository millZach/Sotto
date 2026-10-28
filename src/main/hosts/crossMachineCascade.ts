import { join } from 'node:path'
import { plural } from '@lingui/core/macro'
import { z } from 'zod'
import type { AgentThread } from '../../shared/agents'
import { parseHostEntityKey } from '../../shared/clientIdentity'
import { DELEGATION_LEVELS_MAX } from '../../shared/delegation'
import { isThreadTurnRunning } from '../../shared/threadActivity'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

/**
 * Stop and settle reaching every machine (#1316 part 3, Owl `cross-machine-work`). Stopping or settling a thread stops or
 * settles the threads it delegated to, at both levels, as on one machine (ADR-0081 decisions 6 and 11, #1253). Delegation
 * stops those on another machine through the asks it already makes there; settling one there is the same Settle the window
 * sends any thread on that machine. These are the window's side of both: which delegated threads its own machine's
 * cascade does not reach, what Stop, Settle and Restore say of those they could not move, and the record of which ones a
 * Settle settled, which its Restore brings back.
 */

/**
 * A thread below another, at either level, that the cascade on that thread's own machine does not reach: one on a different
 * machine, or one back on the same machine that was delegated to through a thread on another.
 */
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
 * The threads below `parentKey`, both levels, from the window's own links, that the cascade on its own machine does not
 * reach: every one on another machine, and one back on its machine whose link runs through a thread on another, as a check
 * a thread on forge delegated back to this computer for a thread here. Only those whose whole chain stays on the parent's
 * machine are left to that machine. One pass over the threads the window holds, whatever the history.
 */
export function delegatedElsewhere(threads: readonly AgentThread[], parentKey: string): DelegatedElsewhere[] {
  const parentHost = parseHostEntityKey(parentKey)?.hostId
  const children = new Map<string, AgentThread[]>()
  for (const thread of threads) {
    if (!thread.delegatedBy) continue
    const siblings = children.get(thread.delegatedBy)
    if (siblings) siblings.push(thread); else children.set(thread.delegatedBy, [thread])
  }
  const elsewhere: DelegatedElsewhere[] = [], seen = new Set([parentKey])
  let level = (children.get(parentKey) ?? []).map(thread => ({ thread, through: false }))
  for (let depth = 0; depth < DELEGATION_LEVELS_MAX && level.length; depth++) {
    const next: { thread: AgentThread; through: boolean }[] = []
    for (const { thread, through } of level) {
      if (seen.has(thread.id)) continue
      seen.add(thread.id)
      const key = parseHostEntityKey(thread.id)
      const across = through || key !== null && key.hostId !== parentHost
      if (key && across) elsewhere.push({ key: thread.id, hostId: key.hostId, id: key.id, running: isThreadTurnRunning(thread), settledAt: thread.workspaceSettledAt ?? null })
      for (const child of children.get(thread.id) ?? []) next.push({ thread: child, through: across })
    }
    level = next
  }
  return elsewhere
}

/**
 * How far apart the two machines' clocks may stamp a settle that went with its parent's. Settling a thread settles its
 * delegated threads elsewhere with that machine's own time, so restoring it brings back those its settle settled there
 * that are still settled within this of it, as on one machine it brings back those carrying its timestamp. Settled with
 * Zach on October 28, 2026 (#1316 part 3); named here so it changes in one place.
 */
export const SETTLE_CASCADE_SKEW_MS = 2 * 60_000

/**
 * Whether a delegated thread on another machine is still settled as its parent's settle left it, so restoring the parent
 * restores it: its settle stamp within `SETTLE_CASCADE_SKEW_MS` of the parent's. Asked only of one the parent's settle
 * settled (`CascadedSettles`), so one settled on its own just before is not taken for it.
 */
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
 * The delegated threads a Stop, Settle or Restore left on each machine (#1316 part 3), each counted once, by its machine's
 * key and name in the order first met.
 */
export class LeftTally {
  private readonly machines = new Map<string, { readonly name: string; readonly threads: Set<string> }>()
  add(machine: string, name: string, thread: string): void {
    const entry = this.machines.get(machine)
    if (entry) entry.threads.add(thread); else this.machines.set(machine, { name, threads: new Set([thread]) })
  }
  holds(machine: string, thread: string): boolean { return this.machines.get(machine)?.threads.has(thread) === true }
  counts(): { readonly name: string; readonly count: number }[] { return [...this.machines.values()].map(({ name, threads }) => ({ name, count: threads.size })) }
}
/** What Stop says it left on other machines: those it could not reach, then those it did not see stop; nothing when it left none. */
export function stopLeftWords(away: LeftTally, unconfirmed: LeftTally): string | undefined {
  const unreached = away.counts(), unsure = unconfirmed.counts()
  const said = [...unreached.length ? [stopUnreachedWords(unreached)] : [], ...unsure.length ? [stopUnconfirmedWords(unsure)] : []]
  return said.length ? said.join(' ') : undefined
}

/**
 * What the window's Settle of a thread did to its delegated threads elsewhere (#1316 part 3), by the window's keys: the ones
 * it settled there, which its Restore brings back; the ones it never got a settle to, its machine away or refusing, which a
 * later Settle of the same thread tries again while they are open; and the ones whose settle went but whose answer was
 * lost, which its Restore brings back only if they are seen settled with it, and which are never sent a settle again.
 */
export interface CascadedSettle {
  readonly settled: ReadonlySet<string>
  readonly left: ReadonlySet<string>
  readonly uncertain: ReadonlySet<string>
}
/** How many threads' cascaded settles are kept, newest last; an older one's Restore brings back none of them. */
const SETTLES_KEPT = 500
/** The window's key for a thread: `host:<hostId>:<id>`, with a host's thread ID of up to 512 characters. */
const KEY_MAX = 600
const keySchema = z.string().min(1).max(KEY_MAX)
/**
 * The file as it is read. Every bound here is one `keep` holds to as it writes, so what is written can always be read: a
 * thread's lists have no bound of their own, since each key is bounded and one Settle lists only the threads below it.
 */
const settlesFileSchema = z.object({ version: z.literal(1), settles: z.array(z.object({ parent: keySchema, settled: z.array(keySchema), left: z.array(keySchema),
  uncertain: z.array(keySchema).optional() }).strict()).max(SETTLES_KEPT) }).strict()
/** Whether a key is one the file can hold. One that is not is left out of the record, and its thread is not restored. */
const fits = (key: string): boolean => key.length >= 1 && key.length <= KEY_MAX
type SettlesFile = z.infer<typeof settlesFileSchema>

/**
 * The window's record of its cascaded settles (#1316 part 3), so a Restore brings back only the delegated threads elsewhere
 * that its parent's Settle settled, not one settled on its own a minute before. Kept in `cross-machine-settles.json` in
 * Sotto's data folder, since a Restore often comes after a restart: the window's keys of the threads only, never a title,
 * a brief or a reply. Without a folder, as in a test, it is kept in memory.
 */
export class CascadedSettles {
  private readonly settles = new Map<string, CascadedSettle>()
  private readonly store: AtomicJsonStore<SettlesFile> | undefined

  constructor(directory?: string) {
    this.store = directory === undefined ? undefined
      : new AtomicJsonStore(join(directory, 'cross-machine-settles.json'), input => settlesFileSchema.parse(input), (): SettlesFile => ({ version: 1, settles: [] }))
  }
  async load(): Promise<void> {
    const file = await this.store?.read().catch((): SettlesFile => ({ version: 1, settles: [] }))
    for (const settle of file?.settles ?? []) this.settles.set(settle.parent, { settled: new Set(settle.settled), left: new Set(settle.left), uncertain: new Set(settle.uncertain) })
  }
  /** What the window's newest Settle of `parent` did elsewhere, until its Restore. */
  of(parent: string): CascadedSettle | undefined { return this.settles.get(parent) }
  /** Keeps what a Settle of `parent` did elsewhere, in place of what an earlier one did, and saves it. */
  async keep(parent: string, settle: CascadedSettle): Promise<void> {
    this.settles.delete(parent)
    if (!fits(parent)) { await this.save(); return }
    const held = (keys: ReadonlySet<string>): ReadonlySet<string> => [...keys].every(fits) ? keys : new Set([...keys].filter(fits))
    this.settles.set(parent, { settled: held(settle.settled), left: held(settle.left), uncertain: held(settle.uncertain) })
    if (this.settles.size > SETTLES_KEPT) this.settles.delete(this.settles.keys().next().value!)
    await this.save()
  }
  /** Lets go of `parent`'s record once its Restore has brought back what it settled. */
  async forget(parent: string): Promise<void> {
    if (this.settles.delete(parent)) await this.save()
  }
  private async save(): Promise<void> {
    await this.store?.writeLatest(() => ({ version: 1, settles: [...this.settles].map(([parent, { settled, left, uncertain }]) => ({ parent, settled: [...settled], left: [...left],
      ...uncertain.size ? { uncertain: [...uncertain] } : {} })) }))
      .catch(() => undefined)
  }
}

/**
 * What Settle says when it could not settle delegated threads on other machines (#1316 part 3): how many on each machine,
 * and what to do. A machine not connected, one that refused, and one whose answer was lost read alike: the thread may be
 * open there. Drafted; to be checked with Zach.
 */
export function settleLeftWords(left: readonly { readonly name: string; readonly count: number }[]): string {
  const parts = left.map(({ name, count }) => plural(count, {
    one: `Sotto couldn't settle # delegated thread on ${name}.`,
    other: `Sotto couldn't settle # delegated threads on ${name}.`,
  }))
  const total = left.reduce((sum, item) => sum + item.count, 0)
  const next = plural(total, {
    one: 'Open it from Tools › Agents to settle it yourself.',
    other: 'Open them from Tools › Agents to settle them yourself.',
  })
  return [...parts, next].join(' ')
}
/** What Restore says when it could not restore delegated threads on other machines that the thread's Settle settled (#1316 part 3). Drafted. */
export function restoreLeftWords(left: readonly { readonly name: string; readonly count: number }[]): string {
  const parts = left.map(({ name, count }) => plural(count, {
    one: `Sotto couldn't restore # delegated thread on ${name}.`,
    other: `Sotto couldn't restore # delegated threads on ${name}.`,
  }))
  const total = left.reduce((sum, item) => sum + item.count, 0)
  const next = plural(total, {
    one: 'Open it from Tools › Agents to restore it yourself.',
    other: 'Open them from Tools › Agents to restore them yourself.',
  })
  return [...parts, next].join(' ')
}
