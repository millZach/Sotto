import { useEffect, useSyncExternalStore } from 'react'
import type { CheckQueueEntry, CheckQueuesBridge, CheckQueuesView, MachineChecks } from '../../../shared/checkQueue'
import { useOwlFeature } from '../state/owlFeature'

/**
 * Every machine's check queue as main last sent it (#1312, fourth part, Zach's pick C), shared by the machines line, the
 * machine's panel and Tools › Agents. Read once when the first of them appears, then kept current by main's pushes, which
 * come only when a queue changes; nothing reads on a timer. Forgotten once nothing shows it.
 */
class CheckQueuesStore {
  private view: CheckQueuesView | null = null
  private readonly listeners = new Set<() => void>()
  private bridge: CheckQueuesBridge | null = null
  private users = 0
  private stop: (() => void) | null = null
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly get = (): CheckQueuesView | null => this.view
  /** Starts reading through `bridge` for one more user. Returns the way to stop, which stops reading after the last. */
  use(bridge: CheckQueuesBridge): () => void {
    if (this.bridge !== bridge) { this.stop?.(); this.stop = null; this.users = 0; this.bridge = bridge; this.set(null) }
    if (this.users++ === 0) {
      // A push that answers before the first read is newer than it, so that read is dropped.
      let pushed = false
      this.stop = bridge.onChanged(view => { pushed = true; this.set(view) })
      void bridge.read().then(view => { if (!pushed && this.bridge === bridge && this.users > 0) this.set(view) }, () => undefined)
    }
    let stopped = false
    return () => {
      if (stopped || this.bridge !== bridge) return
      stopped = true
      if (--this.users === 0) { this.stop?.(); this.stop = null; this.set(null) }
    }
  }
  private set(view: CheckQueuesView | null): void {
    if (this.view === view) return
    this.view = view
    for (const listener of [...this.listeners]) listener()
  }
  /** For tests: forget everything. */
  clear(): void { this.stop?.(); this.stop = null; this.users = 0; this.bridge = null; this.view = null }
}
export const checkQueuesStore = new CheckQueuesStore()

/** An end-to-end run's queues, in place of main's (`createE2ECheckQueuesBridge`). */
let standIn: CheckQueuesBridge | undefined
export function setCheckQueuesStandIn(bridge: CheckQueuesBridge | undefined): void { standIn = bridge }

/**
 * Every machine's check queue, or null where Work across machines is off or main offers no queues (stable, or Watcher off),
 * and until the first read answers.
 */
export function useCheckQueues(bridge: CheckQueuesBridge | undefined = standIn ?? window.sotto?.checks): CheckQueuesView | null {
  const enabled = useOwlFeature('cross-machine-work')
  const active = enabled ? bridge : undefined
  useEffect(() => active ? checkQueuesStore.use(active) : undefined, [active])
  const view = useSyncExternalStore(checkQueuesStore.subscribe, checkQueuesStore.get)
  return active ? view : null
}

/** One machine's queue, by whether it is this computer or by its host ID. */
export function machineChecksOf(view: CheckQueuesView | null, machine: { readonly thisComputer: boolean; readonly hostId: string | undefined }): MachineChecks | undefined {
  return view?.machines.find(item => machine.thisComputer ? item.thisComputer : !item.thisComputer && item.hostId === machine.hostId)
}

/** Where a thread's check stands: its machine's queue and its place there, the running check at 0; undefined for any other thread. */
export function checkOfThread(view: CheckQueuesView | null, threadId: string): { readonly machine: MachineChecks; readonly at: number } | undefined {
  for (const machine of view?.machines ?? []) {
    const at = machine.checks.findIndex(check => check.thread === threadId)
    if (at !== -1) return { machine, at }
  }
  return undefined
}

/** A check a thread delegated whose own thread is not made yet: it waits its turn, or its turn has only just come. */
export interface UnmadeCheck { readonly machine: MachineChecks; readonly check: CheckQueueEntry; readonly at: number }
/** The checks `owners` delegated whose threads `made` does not hold yet, in the order their machines' queues list them. */
export function unmadeChecks(view: CheckQueuesView | null, owners: ReadonlySet<string>, made: (threadId: string) => boolean): UnmadeCheck[] {
  const found: UnmadeCheck[] = []
  for (const machine of view?.machines ?? []) machine.checks.forEach((check, at) => {
    if (check.whose === 'thread' && check.by !== undefined && owners.has(check.by) && check.thread !== undefined && !made(check.thread)) found.push({ machine, check, at })
  })
  return found
}
