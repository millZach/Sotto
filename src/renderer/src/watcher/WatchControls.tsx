import React, { type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useWatchActions, useWatchedThread, useWatchPaused } from './watcherRoom'
import { watchNotices, useWatchNotice } from './watchNotice'
import { WATCHED_BY_WATCHER, WatcherOwl } from './WatcherOwl'

/** What a press on a toggle does, for its tooltip: the toggle's name stays Watch, and its pressed state says the rest. */
const WATCH_TIP = 'Watch: Watcher keeps this thread going until you stop it'
const STOP_TIP = 'Stop watching: Watcher lets this thread be'

/**
 * Watch in a thread's pane header (Zach's pick on October 13, 2026, watch B): pressed while Watcher watches the thread.
 * Its name is Watch and the thread's title, the same pressed or not, so a screen reader says whether it is on.
 */
export function WatchHeaderToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const actions = useWatchActions()
  const watched = useWatchedThread(threadId)
  if (actions === null) return null
  return <button type="button" className="watch-toggle tt-focusable" aria-pressed={watched} aria-label={`Watch ${title}`} title={watched ? STOP_TIP : WATCH_TIP}
    onClick={() => void actions.setThread(threadId, !watched)}>
    <WatcherOwl size={15} /><span className="watch-toggle__text">Watch</span>
  </button>
}

/** The owl among a sidebar row's actions, pressed while Watcher watches the thread. */
export function WatchRowToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const actions = useWatchActions()
  const watched = useWatchedThread(threadId)
  if (actions === null) return null
  return <button type="button" className="thread-nav__action watch-row-toggle tt-focusable" aria-pressed={watched} aria-label={`Watch ${title}`}
    title={watched ? STOP_TIP : WATCH_TIP} onClick={() => void actions.setThread(threadId, !watched)}>
    <WatcherOwl size={16} />
  </button>
}

/** The owl at the end of a row in All threads, pressed while Watcher watches it; the row's last stop. */
export function WatchListToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const actions = useWatchActions()
  const watched = useWatchedThread(threadId)
  if (actions === null) return null
  return <button type="button" className="watcher-row__watch tt-focusable" aria-pressed={watched} aria-label={`Watch ${title}`}
    title={watched ? STOP_TIP : WATCH_TIP} onClick={() => void actions.setThread(threadId, !watched)}>
    <WatcherOwl size={15} />
  </button>
}

/**
 * Under a watched thread's composer, before anything is sent: what watching means, with Stop watching. Watching lasts
 * until it is stopped; the user's own send only holds Watcher back while that turn runs, and the line says so then.
 */
export function WatchedNote({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const actions = useWatchActions()
  const watched = useWatchedThread(threadId)
  const paused = useWatchPaused(threadId)
  if (!watched) return null
  return <p className="watched-note">
    <WatcherOwl size={13} />
    <span>{paused ? `${WATCHED_BY_WATCHER}. It waits while your own turn here runs, then keeps this thread going.`
      : `${WATCHED_BY_WATCHER}. It keeps this thread going and brings you its questions and permissions.`}</span>
    {actions === null ? null : <button type="button" className="watched-note__stop tt-focusable" aria-label={`Stop watching ${title}`}
      onClick={() => void actions.setThread(threadId, false)}>Stop watching</button>}
  </p>
}

/**
 * What the last Watch or Stop watching press did, in a toast just above the focused pane's composer (the mock-up's
 * place for it), with Undo; or main's refusal in its own words, with Dismiss. It never takes focus, and goes by itself
 * after a few seconds.
 */
export function WatchToast(): ReactNode {
  const actions = useWatchActions()
  const notice = useWatchNotice()
  if (actions === null || notice === null) return null
  const { id, target, title, watched, refusal } = notice
  if (refusal !== null) return <div className="watch-toast-anchor"><div className="watch-toast" data-tone="refused" role="alert">
    <WatcherOwl size={15} /><span>{refusal}</span>
    <button type="button" className="watch-toast__dismiss tt-focusable" aria-label="Dismiss" title="Dismiss" onClick={() => watchNotices.dismiss(id)}><X size={14} aria-hidden="true" /></button>
  </div></div>
  return <div className="watch-toast-anchor"><div className="watch-toast" role="status">
    <WatcherOwl size={15} />
    <span>{watched ? <>Watcher is watching <strong>{title}</strong>.</> : <>Watcher stopped watching <strong>{title}</strong>.</>}</span>
    <button type="button" className="watch-toast__undo tt-focusable" aria-label={watched ? `Undo: stop watching ${title}` : `Undo: watch ${title} again`}
      onClick={() => { watchNotices.dismiss(id); void actions.set(target, title, !watched) }}>Undo</button>
  </div></div>
}
