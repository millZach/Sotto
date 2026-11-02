import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { z } from 'zod'
import { Button } from '../components/Button'
import { useOwlFeature } from '../state/owlFeature'
import type { PaneMenuItem } from './PaneMenu'
import { followRow, type RowMenuSide } from './RowMenu'
import { localeFormatter } from './localeFormat'
import { clockLabel, type ThreadRow } from './threadFacts'

/**
 * Snoozed threads (ADR-0175; Owl `thread-snooze`): each thread the user snoozed and when it wakes, kept on this computer
 * the way starred models are (ADR-0147). A snooze that has passed is ignored and dropped on the next write, so the record
 * keeps only what is still asleep.
 */
export const THREAD_SNOOZES_KEY = 'sotto.threads.snoozes'
const snoozesSchema = z.record(z.string(), z.string())
const NONE: ReadonlyMap<string, number> = new Map()

const listeners = new Set<() => void>()
/** The last stored text and what it read as, so every read between changes is the same map. */
let parsed: { readonly raw: string | null; readonly snoozes: ReadonlyMap<string, number> } = { raw: null, snoozes: NONE }
/** What the user last chose when storage refused to keep it. */
let unsaved: ReadonlyMap<string, number> | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => { listeners.delete(listener); window.removeEventListener('storage', listener) }
}
function read(): ReadonlyMap<string, number> {
  if (unsaved) return unsaved
  let raw: string | null
  try { raw = localStorage.getItem(THREAD_SNOOZES_KEY) } catch { return NONE }
  if (raw !== parsed.raw) {
    let snoozes: ReadonlyMap<string, number> = NONE
    try {
      const stored = snoozesSchema.safeParse(JSON.parse(raw ?? '{}')).data ?? {}
      snoozes = new Map(Object.entries(stored).map(([id, at]) => [id, Date.parse(at)] as const).filter(([, at]) => Number.isFinite(at)))
    } catch { /* Unreadable text keeps no snoozes. */ }
    parsed = { raw, snoozes }
  }
  return parsed.snoozes
}

/** Every snooze on record while Snooze is on; none while the Owl list keeps it off, its record left whole. */
export function useThreadSnoozes(): ReadonlyMap<string, number> {
  const on = useOwlFeature('thread-snooze')
  const snoozes = useSyncExternalStore(subscribe, read, () => NONE)
  return on ? snoozes : NONE
}

/** Snoozes each thread until `until`, or wakes it with null. */
export function snoozeThreads(threadIds: readonly string[], until: number | null): void {
  const now = Date.now()
  const next = new Map([...read()].filter(([, at]) => at > now))
  for (const id of threadIds) { if (until === null) next.delete(id); else next.set(id, until) }
  const kept = next.size ? next : NONE
  try { localStorage.setItem(THREAD_SNOOZES_KEY, JSON.stringify(Object.fromEntries([...kept].map(([id, at]) => [id, new Date(at).toISOString()])))); unsaved = null } catch { unsaved = kept }
  for (const listener of listeners) listener()
}

/** A snoozed thread that needs you wakes for good, so answering it does not send it back to sleep. */
export function useWakeWhenNeeded(rows: readonly ThreadRow[], snoozes: ReadonlyMap<string, number>): void {
  useEffect(() => {
    if (snoozes.size === 0) return
    const now = Date.now()
    const waking = rows.filter(row => row.state === 'needs' && (snoozes.get(row.thread.id) ?? 0) > now).map(row => row.thread.id)
    if (waking.length) snoozeThreads(waking, null)
  }, [rows, snoozes])
}

const at = (base: Date, days: number, hour: number): number => {
  const day = new Date(base)
  day.setDate(day.getDate() + days)
  day.setHours(hour, 0, 0, 0)
  return day.getTime()
}

/** The snooze menu's choices from `now`, each with when it wakes: This evening only before five, Next Monday only when it is not tomorrow. */
export function snoozeChoices(now: Date): { readonly id: 'hour' | 'evening' | 'tomorrow' | 'monday'; readonly until: number }[] {
  const toMonday = (8 - now.getDay()) % 7 || 7
  return [
    { id: 'hour', until: now.getTime() + 60 * 60_000 },
    ...now.getHours() < 17 ? [{ id: 'evening' as const, until: at(now, 0, 18) }] : [],
    { id: 'tomorrow', until: at(now, 1, 9) },
    ...toMonday > 1 ? [{ id: 'monday' as const, until: at(now, toMonday, 9) }] : [],
  ]
}

const weekday = localeFormatter({ weekday: 'short' })
const monthDay = localeFormatter({ month: 'short', day: 'numeric' })
/** A wake time in few words, its clock as a row's: "6:05 pm" today, "Mon 9:00 am" within a week, else "Nov 12 9:00 am". */
export function wakeWords(until: number, now = Date.now()): string {
  const date = new Date(until)
  if (date.toDateString() === new Date(now).toDateString()) return clockLabel(until)
  return `${(until - now < 6 * 24 * 60 * 60_000 ? weekday : monthDay)(date)} ${clockLabel(until)}`
}

/** The snooze menu's rows: the choices, then Pick a date and time. */
export function useSnoozeMenu(): (snooze: (until: number) => void, pick: () => void) => PaneMenuItem[][] {
  const { t } = useLingui()
  return (snooze, pick) => {
    const labels = {
      hour: t({ message: 'For 1 hour', comment: 'Snooze a thread for an hour.' }),
      evening: t({ message: 'This evening', comment: 'Snooze a thread until 6 pm today.' }),
      tomorrow: t({ message: 'Tomorrow', comment: 'Snooze a thread until 9 am tomorrow.' }),
      monday: t({ message: 'Next Monday', comment: 'Snooze a thread until 9 am next Monday.' }),
    }
    const now = new Date()
    return [snoozeChoices(now).map(choice => {
      const when = wakeWords(choice.until, now.getTime())
      return { id: `snooze-${choice.id}`, label: labels[choice.id], description: when, run: () => snooze(choice.until),
        content: <><span className="pane-menu__label">{labels[choice.id]}</span><span className="pane-menu__end" aria-hidden="true">{when}</span></> }
    }), [{ id: 'snooze-pick', label: t({ message: 'Pick a date and time…', comment: 'Snooze a thread until a date and time the user picks.' }), run: pick }]]
  }
}

/** The value a datetime-local field reads for a time, in this computer's zone. */
const fieldValue = (time: number): string => {
  const local = new Date(time - new Date(time).getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

/**
 * Pick a date and time: a date and time field beside the row, in the menu's frame where the snooze menu opened. Enter
 * snoozes until it and Escape leaves the thread as it was; either hands the focus back to the row. A time already past
 * is refused where it is typed.
 */
export function SnoozeUntil({ title, anchor, side = 'below', onSnooze, onDone }: {
  readonly title: string
  readonly anchor: () => HTMLElement | null
  readonly side?: RowMenuSide | undefined
  readonly onSnooze: (until: number) => void
  readonly onDone: (restoreFocus: boolean) => void
}): ReactNode {
  const { t } = useLingui()
  const frame = useRef<HTMLFormElement>(null)
  const latest = useRef({ anchor, onDone })
  latest.current = { anchor, onDone }
  const [value, setValue] = useState(() => fieldValue(Date.now() + 2 * 60 * 60_000))
  const finished = useRef(false)
  const finish = useCallback((restore: boolean): void => { if (!finished.current) { finished.current = true; latest.current.onDone(restore) } }, [])
  useLayoutEffect(() => {
    const box = frame.current
    if (box === null) return
    box.showPopover?.()
    const stop = followRow(box, () => latest.current.anchor(), 'beside', side, () => finish(false))
    if (stop === null) { finish(false); return }
    box.querySelector('input')?.focus()
    return () => { stop(); box.hidePopover?.() }
  }, [finish, side])
  const until = Date.parse(value)
  const valid = Number.isFinite(until) && until > Date.now()
  return <form ref={frame} className="pane-menu__list thread-row-menu thread-snooze" aria-label={t`Snooze ${title} until`} popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined}
    onSubmit={event => { event.preventDefault(); if (valid) { onSnooze(until); finish(true) } }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true) } }}
    onBlur={event => { if (!frame.current?.contains(event.relatedTarget as Node | null)) finish(false) }}>
    <input className="thread-nav__rename tt-focusable" type="datetime-local" aria-label={t`Wake ${title} at`} value={value} min={fieldValue(Date.now())} onChange={event => setValue(event.target.value)} />
    <Button type="submit" disabled={!valid}>{t({ message: 'Snooze', comment: 'Snooze the thread until the picked date and time.' })}</Button>
  </form>
}
