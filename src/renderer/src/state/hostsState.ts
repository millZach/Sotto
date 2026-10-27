import { useEffect, useState } from 'react'
import type { HostsBridge, HostsState } from '../../../shared/hosts'

/** The saved hosts as main publishes them: read once, then kept as each change arrives. Null until the first answer. */
export function useHostsState(bridge: HostsBridge | undefined): HostsState | null {
  const [state, setState] = useState<HostsState | null>(null)
  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.get().then(next => { if (live) setState(next) }, () => undefined)
    const off = bridge.onChanged(next => { if (live) setState(next) })
    return () => { live = false; off() }
  }, [bridge])
  return state
}

/** The machines this computer has paired with, by host ID and saved name, and whether each is connected now. */
export interface SavedMachine { readonly hostId: string; readonly name: string; readonly connected: boolean }
export function savedMachines(state: HostsState | null): readonly SavedMachine[] | undefined {
  if (state === null) return undefined
  return state.hosts.flatMap(host => host.hostId === undefined || host.hostId === state.localHostId ? []
    : [{ hostId: host.hostId, name: host.name, connected: host.phase === 'connected' && host.reconnecting !== true }])
}
