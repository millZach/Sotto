import { useCallback, useEffect, useRef, useState } from 'react'
import type { WatcherMachinesRead } from '../../../shared/watcherRoom'

/** How often the machines line and Settings read the machines again while they show: a host keeps its last reading five seconds. */
export const MACHINES_READ_EVERY_MS = 15_000

type MachinesOk = Extract<WatcherMachinesRead, { status: 'ok' }>

/**
 * Watcher's machines (#1032), read through the room's bridge while a surface that shows them is on screen, and again
 * every fifteen seconds and whenever `read` is called, such as when a machine's panel opens. Nothing reads on a timer
 * while the window is hidden. Null until the first read answers, and after a read that fails or is refused the last
 * good one stays.
 */
export function useMachines(readMachines: (() => Promise<WatcherMachinesRead>) | null): { readonly machines: MachinesOk | null; readonly read: () => void } {
  const [machines, setMachines] = useState<MachinesOk | null>(null)
  const reader = useRef(readMachines)
  reader.current = readMachines
  const live = useRef(true)
  const inFlight = useRef(false)
  const read = useCallback((): void => {
    const call = reader.current
    if (call === null || inFlight.current) return
    inFlight.current = true
    void call().then(result => { if (live.current && result.status === 'ok') setMachines(result) }, () => undefined)
      .finally(() => { inFlight.current = false })
  }, [])
  const available = readMachines !== null
  useEffect(() => {
    live.current = true
    if (!available) return () => { live.current = false }
    read()
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') read() }, MACHINES_READ_EVERY_MS)
    return () => { live.current = false; window.clearInterval(timer) }
  }, [available, read])
  return { machines: available ? machines : null, read }
}
