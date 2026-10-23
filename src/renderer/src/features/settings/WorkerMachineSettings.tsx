import React, { useId, useMemo, type ReactNode } from 'react'
import { Laptop, MapPin, Server } from 'lucide-react'
import type { HostsBridge } from '../../../../shared/hosts'
import { savedMachines, useHostsState } from '../../state/hostsState'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import type { WatcherMachine } from '../../../../shared/watcherRoom'
import { workerMachineHostId, type WorkerMachineSetting } from '../../../../shared/workerMachine'
import { THIS_COMPUTER, WORKING_THREADS_QUIET_MAX, workingThreadsByMachine } from '../../../../shared/workingThreads'
import { useOptionalAgents } from '../../agents/AgentContext'
import { loadUnknown, memoryWords, systemWords } from '../../../../shared/machineLine'
import { useMachines } from '../../watcher/useMachines'
import { useWatcherRoom } from '../../watcher/watcherRoom'
import { WatcherOwl } from '../../watcher/WatcherOwl'
import { SettingsGroup } from './SettingsGroup'
import './workerMachine.css'

/** The settings section the room's panels open: this group, on the Watcher page. */
export const WORKER_MACHINE_SECTION = 'settings-new-workers'
export const WORKER_MACHINE_NOTE = 'Workers are threads Watcher starts. Name a machine in your message to start one somewhere else for that request. Nothing is refused for how many are working; above ten on a machine, Sotto warns.'

interface Choice {
  readonly value: WorkerMachineSetting
  readonly title: string
  readonly kind: 'watcher' | 'local' | 'remote'
  readonly connected: boolean
  readonly machine: WatcherMachine | null
  /** Working threads there, from the window's own thread list. */
  readonly working: number
}

/** What a machine is: its system, processors and memory, or why that is not known. */
function factsWords(choice: Choice): string | null {
  const machine = choice.machine
  if (choice.kind === 'watcher') return 'Watcher picks a machine from each one’s load and the project’s notes on where checks run, and says why in its reply.'
  if (!choice.connected) return null
  if (machine === null) return null
  if (machine.factsState === 'unknown' || machine.facts === null) return 'An older Sotto host: load unknown. Update it in Hosts & phones.'
  const parts = [systemWords(machine), machine.facts.logicalCpuCount !== null ? `${machine.facts.logicalCpuCount} CPUs` : null,
    machine.facts.totalMemoryBytes !== null ? memoryWords(machine.facts.totalMemoryBytes) : null].filter((part): part is string => part !== null)
  return parts.length ? parts.join(' · ') : null
}

/** How it is now: working threads, CPU and memory free, each with the words a problem adds. */
function NowWords({ choice }: { readonly choice: Choice }): ReactNode {
  if (choice.kind === 'watcher') return null
  if (!choice.connected) return <span className="worker-machine__now">Not connected</span>
  const machine = choice.machine
  const over = choice.working > WORKING_THREADS_QUIET_MAX
  const bits: ReactNode[] = [<span key="working" data-warn={over || undefined}>{choice.working} working{over ? ', may slow down' : ''}</span>]
  const load = machine?.load ?? null
  if (machine !== null && load !== null && !loadUnknown(machine)) {
    // Each half shows when it is known; the other says it is unknown, as a Mac's memory does.
    const busy = machine.cpuState === 'busy', short = machine.memoryState === 'short'
    bits.push((machine.cpuState ?? 'unknown') !== 'unknown' && load.cpuBusyPercent !== null
      ? <span key="cpu" data-warn={busy || undefined}>CPU {load.cpuBusyPercent}%{busy ? ', busy' : ''}</span> : <span key="cpu">CPU unknown</span>,
    (machine.memoryState ?? 'unknown') !== 'unknown' && load.availableMemoryBytes !== null
      ? <span key="memory" data-warn={short || undefined}>{memoryWords(load.availableMemoryBytes)} free{short ? ', short on memory' : ''}</span> : <span key="memory">memory unknown</span>)
  } else if (machine !== null) bits.push(<span key="unknown" data-warn="true">load unknown</span>)
  return <span className="worker-machine__now">{bits.flatMap((bit, index) => index === 0 ? [bit] : [<span key={`dot-${index}`} className="worker-machine__dot" aria-hidden="true">·</span>, bit])}</span>
}

/**
 * Settings, under Watcher: Where new workers start (#1032, Zach's pick on October 23, 2026), between Watched threads and
 * Worker roles. A card for Let Watcher choose, for This computer, the default, and for each machine this computer has
 * paired with, by name, each with what it is and how busy it is now. Choosing a machine that is not connected says what
 * happens until it is. Part of the Owl feature Work across machines: SettingsView asks before it exists.
 */
export function WorkerMachineSettings({ settings, onUpdateSettings, onOpenHosts, hosts: bridge = window.sotto?.hosts }: {
  readonly settings: AppSettings
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onOpenHosts: () => void
  readonly hosts?: HostsBridge | undefined
}): ReactNode {
  const name = useId()
  const hostsState = useHostsState(bridge)
  const room = useWatcherRoom()
  // Opening this group is asking for the machines' numbers, so they are read once now, and never on a timer.
  const { machines } = useMachines(room?.readMachines ?? null, { readNow: true })
  const threads = useOptionalAgents()?.state?.host.threads
  const working = useMemo(() => workingThreadsByMachine(threads ?? []), [threads])
  const chosen = settings.newWorkerMachine
  const chosenHost = workerMachineHostId(chosen)
  const listed = machines?.machines ?? []
  const local = listed.find(machine => machine.thisComputer) ?? null
  const localId = hostsState?.localHostId ?? local?.hostId
  // Every machine this computer has paired with, by the name the user saved, then any other the read lists. Whether a saved
  // machine is connected is the saved hosts' answer now, which main keeps current, not the last read's, as on the
  // machines line; the read only gives its facts, and none while it is not connected.
  const saved = savedMachines(hostsState) ?? []
  const remotes: Choice[] = saved.filter(host => host.hostId !== localId).map(host => {
    const machine = listed.find(item => item.hostId === host.hostId) ?? null
    const read = machine !== null && machine.connected && machine.factsState !== 'not-connected' ? machine : null
    return { value: host.hostId, title: host.name, kind: 'remote', connected: host.connected, machine: host.connected ? read : null, working: working.get(host.hostId) ?? 0 }
  })
  for (const machine of listed) {
    if (machine.thisComputer || remotes.some(choice => choice.value === machine.hostId)) continue
    remotes.push({ value: machine.hostId, title: machine.name, kind: 'remote', connected: machine.connected && machine.factsState !== 'not-connected', machine, working: working.get(machine.hostId) ?? 0 })
  }
  // A machine chosen once and since forgotten still shows, so the user can see why new workers start here.
  if (chosenHost !== undefined && chosenHost !== localId && !remotes.some(choice => choice.value === chosenHost)) {
    remotes.push({ value: chosenHost, title: 'A machine no longer saved', kind: 'remote', connected: false, machine: null, working: 0 })
  }
  const choices: Choice[] = [
    ...remotes.length > 0 || chosen === 'watcher' ? [{ value: 'watcher', title: 'Let Watcher choose', kind: 'watcher', connected: true, machine: null, working: 0 } as const] : [],
    { value: 'this-computer', title: 'This computer', kind: 'local', connected: true, machine: local, working: working.get(THIS_COMPUTER) ?? 0 },
    ...remotes,
  ]
  const isChosen = (choice: Choice): boolean => choice.value === chosen || (choice.kind === 'local' && chosenHost !== undefined && chosenHost === localId)
  return <SettingsGroup id={WORKER_MACHINE_SECTION} title="Where new workers start" icon={MapPin} note={WORKER_MACHINE_NOTE} rows={false}>
    {remotes.length === 0 ? <p className="worker-machine__alone">Only this computer is connected, so new workers start here. Add a machine in{' '}
      <button type="button" className="worker-machine__link tt-focusable" onClick={onOpenHosts}>Hosts & phones</button>.</p> : null}
    <fieldset className="worker-machine__choices">
      <legend className="tt-visually-hidden">Where new workers start</legend>
      {choices.map(choice => {
        const on = isChosen(choice)
        const facts = factsWords(choice)
        const titleId = `${name}-${choice.value}-title`, factsId = `${name}-${choice.value}-facts`, noteId = `${name}-${choice.value}-note`
        const Icon = choice.kind === 'local' ? Laptop : Server
        return <label key={choice.value} className="worker-machine" data-checked={on || undefined}>
          <span className="worker-machine__head">
            <input type="radio" name={name} value={choice.value} checked={on} className="tt-focusable" aria-labelledby={titleId}
              aria-describedby={[facts !== null ? factsId : '', on && !choice.connected ? noteId : ''].filter(Boolean).join(' ') || undefined}
              onChange={() => void onUpdateSettings({ newWorkerMachine: choice.value })} />
            {choice.kind === 'watcher' ? <WatcherOwl size={15} /> : <Icon size={15} aria-hidden="true" />}
            <span className="worker-machine__title" id={titleId}>{choice.title}</span>
            {on ? <span className="worker-machine__tag">New workers start here</span> : null}
          </span>
          {facts !== null ? <span className="worker-machine__facts" id={factsId}>{facts}</span> : null}
          <NowWords choice={choice} />
          {on && !choice.connected ? <span className="worker-machine__note" id={noteId}>{choice.machine === null && choice.title === 'A machine no longer saved'
            ? 'This machine is no longer saved, so new workers start on this computer. Choose another.'
            : `${choice.title} is not connected. Until it is, new workers start on this computer, and Watcher says so in its reply.`}</span> : null}
        </label>
      })}
    </fieldset>
  </SettingsGroup>
}
