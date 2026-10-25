import React, { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Laptop, Server, X } from 'lucide-react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import { THIS_COMPUTER, workingThreadsByMachine } from '../../../shared/workingThreads'
import { useOptionalApp } from '../state/AppContext'
import { machineEntries, shortLine, systemWords, type MachineEntry } from '../../../shared/machineLine'
import { agoWords, calmLabel, calmWords, countWords, cpuWords, lineText, listWords, machineLabel, machineName, memoryRowWords, moreLabel, moreWords, overWords,
  problemWords, unknownWhyWords } from './machineWords'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { machinesStore, useMachines } from './useMachines'
import { savedMachines, useHostsState } from '../state/hostsState'
import type { HostsBridge } from '../../../shared/hosts'
import { threadAddressIndex, useWatcherRoom } from './watcherRoom'

/** How many working threads a machine's panel names before it counts the rest. */
const NAMED = 6
/** What may hold focus in a machine's panel, before those that can't take it now (disabled, or out of the Tab order). */
const FOCUSABLE = 'button, [href], [tabindex]'
/** The space a machine's panel keeps below it inside the room, and the least height it takes however short the room. */
const PANEL_GAP = 12
const PANEL_MIN_HEIGHT = 160

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
  const { t } = useLingui()
  const heading = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ readonly top: number; readonly left: number; readonly maxHeight: number } | null>(null)
  useLayoutEffect(() => {
    if (anchor === null || frame === null) return
    // The panel may be no taller than the room leaves under its name, so its foot stays in reach in a short window; what
    // does not fit scrolls inside it.
    const room = frame.closest<HTMLElement>('.thread-pane') ?? document.documentElement
    const measure = (): void => {
      const at = anchor.getBoundingClientRect(), box = frame.getBoundingClientRect()
      const width = Math.min(340, box.width)
      const bottom = room === document.documentElement ? window.innerHeight : room.getBoundingClientRect().bottom
      setPlace({ top: at.bottom - box.top + 6, left: Math.max(0, Math.min(at.left - box.left - 4, box.width - width)),
        maxHeight: Math.max(PANEL_MIN_HEIGHT, Math.floor(bottom - at.bottom - 6 - PANEL_GAP)) })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(frame)
    if (room !== frame) observer?.observe(room)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [anchor, frame])
  // The panel was unseen until a render placed it, and Chromium can refuse focus to it until its style settles, so focus
  // is offered on each placing render and on the next frames until the panel has taken it once.
  const focused = useRef(false)
  useLayoutEffect(() => {
    if (place === null || focused.current) return
    const offer = (): void => {
      if (focused.current || !panel.current) return
      if (!panel.current.contains(document.activeElement)) panel.current.focus()
      focused.current = panel.current.contains(document.activeElement)
    }
    offer()
    let frames = 0, frame = 0
    const next = (): void => { offer(); if (!focused.current && ++frames < 10) frame = window.requestAnimationFrame(next) }
    frame = window.requestAnimationFrame(next)
    return () => window.cancelAnimationFrame(frame)
  }, [place])
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
    const stops = [...panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []].filter(stop => stop.tabIndex >= 0 && !stop.hasAttribute('disabled'))
    if (stops.length === 0) { event.preventDefault(); return }
    const index = stops.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index === stops.length - 1 ? 0 : index + 1)
    event.preventDefault()
    stops[next]!.focus()
  }

  const machine = entry.machine
  const working = workingOn(entry, threads)
  const byId = new Map(threads.map(thread => [thread.id, thread] as const))
  const who = (thread: AgentThread): string => {
    if (watcherIds.has(thread.id)) return 'Watcher'
    if (thread.delegatedBy === undefined) return t`your thread`
    const parent = byId.get(thread.delegatedBy)?.title
    return parent === undefined ? t`delegated by another thread` : t`delegated by ${parent}`
  }
  const load = machine?.load ?? null
  const facts = machine?.facts ?? null
  const why = unknownWhyWords(entry, now)
  const name = machineName(entry)
  const over = overWords(entry)
  const count = countWords(entry)
  const system = machine === null ? null : systemWords(machine)
  const cpus = facts?.logicalCpuCount ?? null
  const cpuKnown = machine !== null && machine.cpuState !== 'unknown' && load?.cpuBusyPercent != null
  const memoryKnown = machine !== null && machine.memoryState !== 'unknown' && load?.availableMemoryBytes != null
  const busy = machine?.cpuState === 'busy', short = machine?.memoryState === 'short'
  return <div ref={panel} className="watcher-machine-panel" role="dialog" aria-labelledby={heading} tabIndex={-1} onKeyDown={onKeyDown}
    style={place ? { top: place.top, left: place.left, maxHeight: place.maxHeight } : { visibility: 'hidden' }}>
    <h2 id={heading}><MachineIcon entry={entry} size={15} /><span>{name}</span></h2>
    <button type="button" className="watcher-machine-panel__close tt-focusable" aria-label={entry.thisComputer ? t`Close this computer’s panel` : t`Close ${name}’s panel`}
      onClick={() => onClose(true)}><X size={14} aria-hidden="true" /></button>
    {/* A stop in the Tab order between Close and Change where new workers start, so what does not fit can be scrolled
        from the keyboard as well as read. */}
    <div className="watcher-machine-panel__body tt-focusable" role="region" tabIndex={0}
      aria-label={entry.thisComputer ? t`This computer’s load and what runs there` : t`${name}’s load and what runs there`}>{!entry.connected
        ? <p className="tt-paragraph">{entry.isDefault ? t`${name} is not connected. It is where new workers start, so until it connects they start on this computer, and Watcher says so. Connect it in Settings, under Hosts & phones.`
          : t`${name} is not connected. Connect it in Settings, under Hosts & phones.`}</p> : <>
      <dl>
        {system !== null ? <><dt>{t`System`}</dt><dd>{system}{cpus !== null ? ` · ${plural(cpus, { one: '# CPU', other: '# CPUs' })}` : ''}</dd></> : null}
        <dt>{t`CPU`}</dt><dd data-warn={busy || !cpuKnown || undefined}>{cpuKnown ? cpuWords(load!.cpuBusyPercent!, load!.windowMs, busy) : t`unknown`}</dd>
        <dt>{t`Memory`}</dt><dd data-warn={short || !memoryKnown || undefined}>{memoryKnown
          ? memoryRowWords(load!.availableMemoryBytes!, facts?.totalMemoryBytes ?? null, short) : t`unknown`}</dd>
        {load !== null ? <><dt>{t`Read`}</dt><dd>{agoWords(now - Date.parse(load.observedAt))}</dd></> : null}
      </dl>
      {why !== null ? <p className="tt-paragraph">{why}</p> : null}
      <p className="watcher-machine-panel__count tt-paragraph">{entry.isDefault ? <Trans><b>{count}</b>. New workers start here.</Trans> : <b>{count}</b>}</p>
      {over !== null ? <p className="tt-paragraph" data-warn="true">{over}</p> : null}
      {working.length > 0 || entry.starting > 0 ? <ul>
        {working.slice(0, NAMED).map(thread => <li key={thread.id}><span className="watcher-row__ring" data-tone="working" aria-hidden="true" />
          <span className="watcher-machine-panel__title">{thread.title}</span><span className="watcher-machine-panel__who">{who(thread)}</span></li>)}
        {working.length > NAMED ? <li><span aria-hidden="true" /><span className="watcher-machine-panel__who">{plural(working.length - NAMED, { one: 'and # more', other: 'and # more' })}</span></li> : null}
        {entry.starting > 0 ? <li><span className="watcher-machine-panel__wait" aria-hidden="true" /><span className="watcher-machine-panel__title">{plural(entry.starting, { one: '# placed here, starting', other: '# placed here, starting' })}</span>
          <span className="watcher-machine-panel__who">{t`Counted, so the next start sees it`}</span></li> : null}
      </ul> : null}
    </>}</div>
    {onChangeDefault !== null ? <div className="watcher-machine-panel__foot">
      <button type="button" className="watcher-machine-panel__link tt-focusable" onClick={onChangeDefault}>{t`Change where new workers start`}</button>
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
  const { t } = useLingui()
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
    // The count and the problem's words are one list in the reader's language, the words drawn in the warning ink.
    const whole = listWords([count, ...entry.problems.map(problemWords)])
    const words = entry.problems.length === 0 ? '' : count && whole.startsWith(count) ? whole.slice(count.length) : ` ${whole}`
    return <span className="watcher-machines__machine" data-host={entry.thisComputer ? THIS_COMPUTER : entry.hostId}>
      <button type="button" className="watcher-machines__name tt-focusable" aria-haspopup="dialog" aria-expanded={open === keyOf(entry)}
        aria-label={machineLabel(entry, withStarting)} title={lineText(entry, withStarting)} onClick={event => toggle(keyOf(entry), event.currentTarget)}>
        <span>{machineName(entry)}</span></button>
      {count && words !== ` ${whole}` ? <span className="watcher-machines__count" aria-hidden="true"> {count}</span> : null}
      {words ? <span className="watcher-machines__words" aria-hidden="true">{words}</span> : null}
    </span>
  }
  const run = (list: readonly MachineEntry[], withStarting: boolean): ReactNode => list.map((entry, index) => <Fragment key={keyOf(entry)}>
    {index > 0 ? <><span className="watcher-machines__sep" aria-hidden="true">·</span><wbr /></> : null}{name(entry, withStarting)}
  </Fragment>)
  const opened = entries.find(entry => keyOf(entry) === open) ?? null
  const changeDefault = app === null ? null : (): void => { setOpen(null); app.actions.navigate('settings', 'settings-new-workers') }
  return <div ref={line} className="watcher-machines" role="group" aria-labelledby={label} data-all={all || undefined}>
    <span id={label} className="tt-visually-hidden">{t`Machines and what works on each`}</span>
    <span className="watcher-machines__wide">{run(entries, true)}</span>
    <span className="watcher-machines__narrow">{run(short.shown, false)}
      {short.more > 0 && short.shown.length > 0 ? <><span className="watcher-machines__sep" aria-hidden="true">·</span><wbr />
        <button type="button" className="watcher-machines__more tt-focusable" aria-expanded={all} aria-label={moreLabel(short.more)}
          onClick={() => setAll(true)}>{moreWords(short.more)}</button></> : null}
      {short.more > 0 && short.shown.length === 0 ? <button type="button" className="watcher-machines__more tt-focusable" aria-expanded={all}
        aria-label={calmLabel(entries)} onClick={() => setAll(true)}>{calmWords(entries)}</button> : null}
    </span>
    {opened !== null ? <MachinePanel key={keyOf(opened)} entry={opened} threads={threads ?? []} watcherIds={watcherIds} now={now ?? Date.now()}
      anchor={opener.current} frame={line.current} onClose={close} onChangeDefault={changeDefault} /> : null}
  </div>
}
