import React, { useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useStandingWatch, useWatchActions, useWatchedThread, useWatchPaused } from './watcherRoom'
import { watchNotices, useWatchNotice } from './watchNotice'
import { WATCHED_BY_WATCHER, WatcherOwl } from './WatcherOwl'

/** What a press on a toggle does, for its tooltip: the toggle's name stays Watch, and its pressed state says the rest. */
const WATCH_TIP = 'Watch: Watcher keeps this thread going until you stop it'
const STOP_TIP = 'Stop watching: Watcher lets this thread be'
/**
 * A thread Watcher watches only because it takes part in a Watcher request: the user's own send takes it over. Word for
 * word as the iPhone says it.
 */
export const WATCHED_FOR_A_REQUEST = `${WATCHED_BY_WATCHER}. If you send here, Watcher stops sending to it.`

/**
 * What every owl toggle shares: its name, pressed state, tooltip and press. Its name is Watch and the thread's title, the
 * same pressed or not, so a screen reader says whether it is on; a press watches or stops at once. Null where the
 * bridge offers neither, and no owl is drawn as a control.
 */
function useWatchToggle(threadId: string, title: string) {
  const actions = useWatchActions()
  const watched = useWatchedThread(threadId)
  return actions === null ? null : { type: 'button' as const, 'aria-pressed': watched, 'aria-label': `Watch ${title}`,
    title: watched ? STOP_TIP : WATCH_TIP, onClick: () => void actions.setThread(threadId, !watched) }
}

/** Watch in a thread's pane header (Zach's pick on October 13, 2026, watch B): pressed while Watcher watches the thread. */
export function WatchHeaderToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const toggle = useWatchToggle(threadId, title)
  if (toggle === null) return null
  return <button className="watch-toggle tt-focusable" {...toggle}><WatcherOwl size={15} /><span className="watch-toggle__text">Watch</span></button>
}

/** The owl among a sidebar row's actions, pressed while Watcher watches the thread. */
export function WatchRowToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const toggle = useWatchToggle(threadId, title)
  if (toggle === null) return null
  return <button className="thread-nav__action watch-row-toggle tt-focusable" {...toggle}><WatcherOwl size={16} /></button>
}

/** The owl at the end of a row in All threads, pressed while Watcher watches it; the row's last stop. */
export function WatchListToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const toggle = useWatchToggle(threadId, title)
  if (toggle === null) return null
  return <button className="watcher-row__watch tt-focusable" {...toggle}><WatcherOwl size={15} /></button>
}

/**
 * Under a watched thread's composer, before anything is sent: what watching means, with Stop watching. A standing watch
 * lasts until it is stopped; the user's own send only holds Watcher back while that turn runs, and the line says so
 * then. A thread watched only for a Watcher request is taken over by the user's own send, and the line says that.
 */
export function WatchedNote({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const actions = useWatchActions()
  const watched = useWatchedThread(threadId)
  const paused = useWatchPaused(threadId)
  const standing = useStandingWatch(threadId)
  // Stop watching takes the note away with its own button: the composer just above it keeps the keyboard.
  const landing = useFocusLanding(watched)
  if (!watched) return null
  return <p className="watched-note">
    <WatcherOwl size={13} />
    <span>{!standing ? WATCHED_FOR_A_REQUEST : paused ? `${WATCHED_BY_WATCHER}. While your own turn here runs, it can only steer that turn.`
      : `${WATCHED_BY_WATCHER}. It keeps this thread going and brings you its questions and permissions.`}</span>
    {actions === null ? null : <button type="button" className="watched-note__stop tt-focusable" aria-label={`Stop watching ${title}`}
      onClick={event => { landing.from(event.currentTarget); void actions.setThread(threadId, false) }}>Stop watching</button>}
  </p>
}

/** The composer field of the pane whose compose area this is, which keeps the keyboard when a control by it goes away. */
const composerIn = (compose: Element): HTMLElement | null => compose.querySelector<HTMLElement>('[role="textbox"]')

/**
 * Keeps the keyboard when a press takes away the control it was on. Once `shown` changes after the press, and focus
 * fell to the page rather than going somewhere else meanwhile, it goes to what `land` finds in the pane's compose area:
 * by default the composer, which sits beside every control here.
 */
export function useFocusLanding(shown: unknown, land: (compose: Element) => HTMLElement | null = composerIn) {
  const pressed = useRef<{ readonly control: HTMLElement; readonly compose: Element } | null>(null)
  useLayoutEffect(() => {
    const press = pressed.current
    if (press === null || press.control.isConnected) return
    pressed.current = null
    const active = document.activeElement
    if (active === null || active === document.body) land(press.compose)?.focus()
  }, [shown])
  return {
    from: (control: HTMLElement): void => {
      const compose = control.closest('.thread-workspace__compose')
      pressed.current = compose === null ? null : { control, compose }
    },
  }
}

/**
 * What the last Watch or Stop watching press did, in a toast just above the focused pane's composer (the mock-up's
 * place for it), with Undo; or main's refusal in its own words, with Dismiss. It never takes focus, and goes by itself
 * after a few seconds.
 */
export function WatchToast(): ReactNode {
  const actions = useWatchActions()
  const notice = useWatchNotice()
  // Dismiss and Undo take the toast away with their own button; the composer under it keeps the keyboard, and the
  // toast Undo brings never takes it.
  const landing = useFocusLanding(notice?.id ?? null)
  if (actions === null || notice === null) return null
  const { id, target, title, watched, refusal } = notice
  if (refusal !== null) return <div className="watch-toast-anchor"><div className="watch-toast" data-tone="refused" role="alert">
    <WatcherOwl size={15} /><span>{refusal}</span>
    <button type="button" className="watch-toast__dismiss tt-focusable" aria-label="Dismiss" title="Dismiss"
      onClick={event => { landing.from(event.currentTarget); watchNotices.dismiss(id) }}><X size={14} aria-hidden="true" /></button>
  </div></div>
  return <div className="watch-toast-anchor"><div className="watch-toast" role="status">
    <WatcherOwl size={15} />
    <span>{watched ? <>Watcher is watching <strong>{title}</strong>.</> : <>Watcher stopped watching <strong>{title}</strong>.</>}</span>
    <button type="button" className="watch-toast__undo tt-focusable" aria-label={watched ? `Undo: stop watching ${title}` : `Undo: watch ${title} again`}
      onClick={event => { landing.from(event.currentTarget); watchNotices.dismiss(id); void actions.set(target, title, !watched) }}>Undo</button>
  </div></div>
}
