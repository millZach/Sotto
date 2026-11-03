import React, { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { shownWords } from '../features/settings/laterWords'
import { useWatchActions, useWatchedThread } from './watcherRoom'
import { watchNotices, useWatchNotice } from './watchNotice'
import { useWatchOnSend, watchOnSend } from './watchOnSend'
import { WatcherOwl } from './WatcherOwl'

/**
 * What every owl toggle shares: its name, pressed state, tooltip and press. Its name is Watch and the thread's title, the
 * same pressed or not, so a screen reader says whether it is on; a press watches or stops at once. Null where the
 * bridge offers neither, and no owl is drawn as a control.
 */
function useWatchToggle(threadId: string, title: string) {
  const { t } = useLingui()
  const actions = useWatchActions()
  const watched = useWatchedThread(threadId)
  // What a press does, for its tooltip: the toggle's name stays Watch, and its pressed state says the rest.
  return actions === null ? null : { type: 'button' as const, 'aria-pressed': watched, 'aria-label': t`Watch ${title}`,
    title: watched ? t`Stop watching: Watcher lets this thread be` : t`Watch: Watcher keeps this thread going until you stop it`, onClick: () => void actions.setThread(threadId, !watched) }
}

/** Watch in a thread's pane header (Zach's pick on October 13, 2026, watch B): pressed while Watcher watches the thread. */
export function WatchHeaderToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const toggle = useWatchToggle(threadId, title)
  if (toggle === null) return null
  return <button className="watch-toggle tt-focusable" {...toggle}><WatcherOwl size={15} /><span className="watch-toggle__text"><Trans context="Put a thread under Watcher's watch">Watch</Trans></span></button>
}

/**
 * The owl among a sidebar row's actions, pressed while Watcher watches the thread. Like the row's other actions it is
 * the pointer's: the row's menu says Watch in words for the keyboard (ADR-0164), so it is out of the Tab order.
 */
export function WatchRowToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const toggle = useWatchToggle(threadId, title)
  if (toggle === null) return null
  return <button className="thread-nav__action watch-row-toggle tt-focusable" tabIndex={-1} {...toggle}><WatcherOwl size={16} /></button>
}

/** The owl at the end of a row in All threads, pressed while Watcher watches it; the row's last stop. */
export function WatchListToggle({ threadId, title }: { readonly threadId: string; readonly title: string }): ReactNode {
  const toggle = useWatchToggle(threadId, title)
  if (toggle === null) return null
  return <button className="watcher-row__watch tt-focusable" {...toggle}><WatcherOwl size={15} /></button>
}

/**
 * Watch among a new thread's option chips, after its permissions, named Watch like the other toggles: pressed, the first send puts the thread under a
 * standing watch. It is pressed too while Watcher already watches the thread, and a press then stops watching at once.
 * Not drawn where the Watcher gate is off or the bridge offers no Watch.
 */
export function WatchOnSendToggle({ threadId }: { readonly threadId: string }): ReactNode {
  const { t } = useLingui()
  const actions = useWatchActions()
  const watched = useWatchedThread(threadId)
  const wanted = useWatchOnSend(threadId)
  // Watched from elsewhere first (the pane header), the request has nothing left to do, and must not watch it twice.
  useEffect(() => { if (watched && wanted) watchOnSend.set(threadId, false) }, [threadId, watched, wanted])
  if (actions === null) return null
  const on = watched || wanted
  return <button type="button" className="thread-chip watch-on-send tt-focusable" aria-pressed={on}
    title={on ? t`Watched: Watcher watches this thread from your first message. Press again to leave it unwatched` : t`Watch: Watcher watches this thread from your first message until you stop it`}
    onClick={() => {
      if (!watched) { watchOnSend.set(threadId, !wanted); return }
      watchOnSend.set(threadId, false); void actions.setThread(threadId, false)
    }}>
    <WatcherOwl size={14} /><span><Trans context="Put a thread under Watcher's watch">Watch</Trans></span>
  </button>
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
  const { t } = useLingui()
  const actions = useWatchActions()
  const notice = useWatchNotice()
  // Dismiss and Undo take the toast away with their own button; the composer under it keeps the keyboard, and the
  // toast Undo brings never takes it.
  const landing = useFocusLanding(notice?.id ?? null)
  if (actions === null || notice === null) return null
  const { id, target, title, watched, refusal } = notice
  if (refusal !== null) return <div className="watch-toast-anchor"><div className="watch-toast" data-tone="refused" role="alert">
    <WatcherOwl size={15} /><span>{shownWords(refusal)}</span>
    <button type="button" className="watch-toast__dismiss tt-focusable" aria-label={t`Dismiss`} title={t`Dismiss`}
      onClick={event => { landing.from(event.currentTarget); watchNotices.dismiss(id) }}><X size={14} aria-hidden="true" /></button>
  </div></div>
  return <div className="watch-toast-anchor"><div className="watch-toast" role="status">
    <WatcherOwl size={15} />
    <span>{watched ? <Trans>Watcher is watching <strong>{title}</strong>.</Trans> : <Trans>Watcher stopped watching <strong>{title}</strong>.</Trans>}</span>
    <button type="button" className="watch-toast__undo tt-focusable" aria-label={watched ? t`Undo: stop watching ${title}` : t`Undo: watch ${title} again`}
      onClick={event => { landing.from(event.currentTarget); watchNotices.dismiss(id); void actions.set(target, title, !watched) }}><Trans>Undo</Trans></button>
  </div></div>
}
