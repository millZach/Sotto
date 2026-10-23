import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { WatcherMachinesRead } from '../../../shared/watcherRoom'

type MachinesOk = Extract<WatcherMachinesRead, { status: 'ok' }>

/**
 * The window's last read of Watcher's machines (#1032), shared by the machines line and Settings and kept while the window
 * lives, so leaving the room and coming back shows the same words. Nothing reads on a timer (Zach, October 23, 2026): the
 * window reads machine facts only when Watcher places work or the user opens a machine's numbers, a panel or Settings.
 */
class MachinesStore {
  private machines: MachinesOk | null = null
  private readonly listeners = new Set<() => void>()
  private inFlight = false
  /** The placements the line last read for, so a placement is read for once however often the room is opened. */
  placementsRead = ''
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  readonly get = (): MachinesOk | null => this.machines
  read(call: () => Promise<WatcherMachinesRead>): void {
    if (this.inFlight) return
    this.inFlight = true
    void call().then(result => { if (result.status === 'ok') { this.machines = result; for (const listener of this.listeners) listener() } }, () => undefined)
      .finally(() => { this.inFlight = false })
  }
  /** For tests: forget the last read. */
  clear(): void { this.machines = null; this.placementsRead = ''; this.inFlight = false }
}
export const machinesStore = new MachinesStore()

/**
 * Watcher's machines as last read, and `read` to read them again. `readNow` reads once when the surface appears, for a
 * surface whose opening is the user asking for the numbers (Settings). Null until a read answers; a read that fails or is
 * refused leaves the last good one.
 */
export function useMachines(readMachines: (() => Promise<WatcherMachinesRead>) | null, options: { readonly readNow?: boolean } = {}): { readonly machines: MachinesOk | null; readonly read: () => void } {
  const reader = useRef(readMachines)
  reader.current = readMachines
  const machines = useSyncExternalStore(machinesStore.subscribe, machinesStore.get)
  const read = useCallback((): void => { if (reader.current !== null) machinesStore.read(reader.current) }, [])
  const available = readMachines !== null
  const readNow = options.readNow === true
  useEffect(() => { if (available && readNow) read() }, [available, readNow, read])
  return { machines: available ? machines : null, read }
}
