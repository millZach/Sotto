import React, { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Laptop, Server, X } from 'lucide-react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import { THIS_COMPUTER, workingThreadsByMachine } from '../../../shared/workingThreads'
import { useOptionalApp } from '../state/AppContext'
import { agoWords, countWords, lineText, machineEntries, machineLabel, memoryWords, overWords, shortLine, systemWords, unknownWhy, windowWords,
  type MachineEntry } from './machineLine'
import { machinesStore, useMachines } from './useMachines'
import { savedMachines, useHostsState } from '../state/hostsState'
import type { HostsBridge } from '../../../shared/hosts'
import { threadAddressIndex, useWatcherRoom } from './watcherRoom'

/** How many working threads a machine's panel names before it counts the rest. */
const NAMED = 6
const FOCUSABLE = 'button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/** The threads working on one machine, as its panel lists them: who started each, and its title. */
function workingOn(entry: MachineEntry, threads: readonly AgentThread[]): readonly AgentThread[] {
  return threads.filter(thread => thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && isThreadTurnRunning(thread)
    && (entry.thisComputer ? thread.remoteHost !== true : thread.remoteHost === true && thread.hostId === entry.hostId))
}

/** The threads Watcher started, by this window's thread ID, from the room's requests. */
function startedByWatcher(room: WatcherRoomState | null, state: AgentState | null): ReadonlySet<string> {
  if (room === null || state === null) return new Set()
  const idOf = threadAddressIndex(state)
  const ids = new Set<string>()
  for (const request of room.requests) for (const participant of request.participants) {
    if (participant.startedBy !== 'watcher') continue
    const id = idOf(participant.target)
    if (id !== undefined) ids.add(id)
  }
  return ids
}

function MachineIcon({ entry, size = 14 }: { readonly entry: MachineEntry; readonly size?: number }): ReactNode {
  return entry.thisComputer ? <Laptop size={size} aria-hidden="true" /> : <Server size={size} aria-hidden="true" />
}

/**
 * One machine's panel (Zach's pick D, October 23, 2026): its system, CPU busy, memory available and when that was read;
 * why its load reads unknown when it does; what works there and who started it; work placed there that has not started;
 * and a way to change where new workers start. It opens with focus in it, keeps Tab inside, and closes on Escape, which
 * returns focus to the name that opened it, or on a press outside it.
 */
function MachinePanel({ entry, threads, watcherIds, now, anchor, frame, onClose, onChangeDefault }: {
  readonly entry: MachineEntry
  readonly threads: readonly AgentThread[]
  readonly watcherIds: ReadonlySet<string>
  readonly now: number
  readonly anchor: HTMLElement | null
  readonly frame: HTMLElement | null
  readonly onClose: (refocus: boolean) => void
  readonly onChangeDefault: (() => void) | null
}): ReactNode {
  const heading = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ readonly top: number; readonly left: number } | null>(null)
  useLayoutEffect(() => {
    if (anchor === null || frame === null) return
    const measure = (): void => {
      const at = anchor.getBoundingClientRect(), box = frame.getBoundingClientRect()
      const width = Math.min(340, box.width)
      setPlace({ top: at.bottom - box.top + 6, left: Math.max(0, Math.min(at.left - box.left - 4, box.width - width)) })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(frame)
    return () => observer?.disconnect()
  }, [anchor, frame])
  const placed = place !== null
  useLayoutEffect(() => {
    if (!placed) return
    panel.current?.focus()
    // The panel was unseen until this render placed it, and Chromium can refuse focus to it until its style settles, so
    // focus is offered again once the press that opened it has ended.
    const again = window.setTimeout(() => { if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus() }, 0)
    return () => window.clearTimeout(again)
  }, [placed])
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target !== null && (panel.current?.contains(target) || anchor?.contains(target))) return
      onClose(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [anchor, onClose])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(true); return }
    if (event.key !== 'Tab') return
    const stops = [...panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []]
    if (stops.length === 0) { event.preventDefault(); return }
    const index = stops.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index === stops.length - 1 ? 0 : index + 1)
    event.preventDefault()
    stops[next]!.focus()
  }

  const machine = entry.machine
  const working = workingOn(entry, threads)
  const byId = new Map(threads.map(thread => [thread.id, thread] as const))
  const who = (thread: AgentThread): string => watcherIds.has(thread.id) ? 'Watcher'
    : thread.delegatedBy !== undefined ? `delegated by ${byId.get(thread.delegatedBy)?.title ?? 'another thread'}` : 'your thread'
  const load = machine?.load ?? null
  const facts = machine?.facts ?? null
  const why = unknownWhy(entry, now)
  const over = overWords(entry)
  const system = machine === null ? null : systemWords(machine)
  const cpus = facts?.logicalCpuCount ?? null
  const cpuKnown = machine !== null && machine.cpuState !== 'unknown' && load?.cpuBusyPercent != null
  const memoryKnown = machine !== null && machine.memoryState !== 'unknown' && load?.availableMemoryBytes != null
  const busy = machine?.cpuState === 'busy', short = machine?.memoryState === 'short'
  return <div ref={panel} className="watcher-machine-panel" role="dialog" aria-labelledby={heading} tabIndex={-1} onKeyDown={onKeyDown}
    style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}>
    <h2 id={heading}><MachineIcon entry={entry} size={15} />{entry.name}</h2>
    <button type="button" className="watcher-machine-panel__close tt-focusable" aria-label={`Close ${entry.name}’s panel`} onClick={() => onClose(true)}><X size={14} aria-hidden="true" /></button>
    {!entry.connected ? <p>{entry.name} is not connected.{entry.isDefault ? ' It is where new workers start, so until it connects they start on this computer, and Watcher says so.' : ''} Connect it in Settings, under Hosts & phones.</p> : <>
      <dl>
        {system !== null ? <><dt>System</dt><dd>{system}{cpus !== null ? ` · ${cpus} CPUs` : ''}</dd></> : null}
        <dt>CPU</dt><dd data-warn={busy || !cpuKnown || undefined}>{cpuKnown ? `${load!.cpuBusyPercent}% busy over ${windowWords(load!.windowMs)}${busy ? '. Busy' : ''}` : 'unknown'}</dd>
        <dt>Memory</dt><dd data-warn={short || !memoryKnown || undefined}>{memoryKnown
          ? `${memoryWords(load!.availableMemoryBytes!)}${facts?.totalMemoryBytes != null ? ` of ${memoryWords(facts.totalMemoryBytes)}` : ''} available${short ? '. Short on memory' : ''}` : 'unknown'}</dd>
        {load !== null ? <><dt>Read</dt><dd>{agoWords(now - Date.parse(load.observedAt))}</dd></> : null}
      </dl>
      {why !== null ? <p>{why}</p> : null}
      <p className="watcher-machine-panel__count"><b>{countWords(entry)}</b>{entry.isDefault ? '. New workers start here.' : ''}</p>
      {over !== null ? <p data-warn="true">{over}</p> : null}
      {working.length > 0 || entry.starting > 0 ? <ul>
        {working.slice(0, NAMED).map(thread => <li key={thread.id}><span className="watcher-row__ring" data-tone="working" aria-hidden="true" />
          <span className="watcher-machine-panel__title">{thread.title}</span><span className="watcher-machine-panel__who">{who(thread)}</span></li>)}
        {working.length > NAMED ? <li><span aria-hidden="true" /><span className="watcher-machine-panel__who">and {working.length - NAMED} more</span></li> : null}
        {entry.starting > 0 ? <li><span className="watcher-machine-panel__wait" aria-hidden="true" /><span className="watcher-machine-panel__title">{entry.starting} placed here, starting</span>
          <span className="watcher-machine-panel__who">Counted, so the next start sees it</span></li> : null}
      </ul> : null}
    </>}
    {onChangeDefault !== null ? <div className="watcher-machine-panel__foot">
      <button type="button" className="watcher-machine-panel__link tt-focusable" onClick={onChangeDefault}>Change where new workers start</button>
    </div> : null}
  </div>
}

/**
 * The machines line under Watcher's header (#1032, Zach's pick D "Names" on October 23, 2026), always shown while Work
 * across machines is on: "This computer 2 working · forge 3 working". Each name is a text button that opens that
 * machine's panel; a problem adds words after the count in the needs-you line's warning ink. A narrow room drops the
 * "starting" counts and names only the machines with a problem, then counts the rest, which a press shows.
 */
export function WatcherMachines({ state, now, hosts: bridge = window.sotto?.hosts }: {
  readonly state: AgentState | null
  readonly now?: number | undefined
  readonly hosts?: HostsBridge | undefined
}): ReactNode {
  const room = useWatcherRoom()
  const app = useOptionalApp()
  const { machines, read } = useMachines(room?.readMachines ?? null)
  const hostsState = useHostsState(bridge)
  const saved = useMemo(() => savedMachines(hostsState), [hostsState])
  // Machine facts are read when Watcher places work (Zach, October 23, 2026): once for each placement the room has not
  // been read for, so the line's words follow a start, and never on a timer.
  const placements = room?.state?.receiptPlacements
  const placementsKey = placements?.map(item => item.operationId).join(',') ?? ''
  useEffect(() => {
    if (placementsKey === '' || placementsKey === machinesStore.placementsRead) return
    machinesStore.placementsRead = placementsKey
    read()
  }, [placementsKey, read])
  const threads = state?.host.threads
  const working = useMemo(() => workingThreadsByMachine(threads ?? []), [threads])
  const entries = useMemo(() => machineEntries(machines?.machines ?? null, working, machines?.newWorkersStart, saved), [machines, working, saved])
  const watcherIds = useMemo(() => startedByWatcher(room?.state ?? null, state), [room?.state, state])
  const [open, setOpen] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const line = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const close = useCallback((refocus: boolean): void => {
    setOpen(null)
    if (refocus && opener.current?.isConnected) opener.current.focus()
  }, [])
  // This computer's key stays the same before and after a read names its host ID, so a read never closes its panel.
  const keyOf = (entry: MachineEntry): string => entry.thisComputer ? THIS_COMPUTER : entry.hostId
  const toggle = (key: string, button: HTMLButtonElement): void => {
    if (open === key) { setOpen(null); return }
    opener.current = button
    setOpen(key)
    // Opening a machine's numbers reads them afresh.
    read()
  }
  const label = useId()
  const short = shortLine(entries)
  // Show every machine moves focus to the first machine the short line left out, since the press itself goes away.
  const expanded = useRef(false)
  useLayoutEffect(() => {
    if (!all || expanded.current) return
    expanded.current = true
    const hidden = entries.find(entry => !short.shown.includes(entry))
    const at = hidden === undefined ? null : line.current?.querySelector<HTMLButtonElement>(`.watcher-machines__wide [data-host="${CSS.escape(hidden.thisComputer ? THIS_COMPUTER : hidden.hostId)}"] button`)
    at?.focus()
  }, [all, entries, short.shown])
  const name = (entry: MachineEntry, withStarting: boolean): ReactNode => {
    const count = countWords(entry, withStarting)
    return <span className="watcher-machines__machine" data-host={entry.thisComputer ? THIS_COMPUTER : entry.hostId}>
      <button type="button" className="watcher-machines__name tt-focusable" aria-haspopup="dialog" aria-expanded={open === keyOf(entry)}
        aria-label={machineLabel(entry, withStarting)} title={lineText(entry, withStarting)} onClick={event => toggle(keyOf(entry), event.currentTarget)}>
        <span>{entry.name}</span></button>
      {count ? <span className="watcher-machines__count" aria-hidden="true"> {count}</span> : null}
      {entry.words.length ? <span className="watcher-machines__words" aria-hidden="true">{count ? ', ' : ' '}{entry.words.join(', ')}</span> : null}
    </span>
  }
  const run = (list: readonly MachineEntry[], withStarting: boolean): ReactNode => list.map((entry, index) => <Fragment key={keyOf(entry)}>
    {index > 0 ? <><span className="watcher-machines__sep" aria-hidden="true">·</span><wbr /></> : null}{name(entry, withStarting)}
  </Fragment>)
  const opened = entries.find(entry => keyOf(entry) === open) ?? null
  const changeDefault = app === null ? null : (): void => { setOpen(null); app.actions.navigate('settings', 'settings-new-workers') }
  return <div ref={line} className="watcher-machines" role="group" aria-labelledby={label} data-all={all || undefined}>
    <span id={label} className="tt-visually-hidden">Machines and what works on each</span>
    <span className="watcher-machines__wide">{run(entries, true)}</span>
    <span className="watcher-machines__narrow">{run(short.shown, false)}
      {short.more > 0 ? <><span className="watcher-machines__sep" aria-hidden="true">·</span><wbr />
        <button type="button" className="watcher-machines__more tt-focusable" aria-expanded={all} aria-label={`${short.more} more machine${short.more === 1 ? '' : 's'}. Show every machine`}
          onClick={() => setAll(true)}>{short.more} more</button></> : null}
    </span>
    {opened !== null ? <MachinePanel key={keyOf(opened)} entry={opened} threads={threads ?? []} watcherIds={watcherIds} now={now ?? Date.now()}
      anchor={opener.current} frame={line.current} onClose={close} onChangeDefault={changeDefault} /> : null}
  </div>
}
