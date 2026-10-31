import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'
import type { AgentThread } from '../../../shared/agents'
import { THREAD_SHORTCUT_IDS } from '../../../shared/threadShortcuts'
import type { SottoPlatform } from '../../../shared/platform'
import { isWorkspaceThreadSettled } from '../../../shared/threadActivity'
import { ToastRegion, type ToastMessage } from '../components/ToastRegion'
import { useOptionalApp } from '../state/AppContext'
import type { AgentConnection } from './AgentContext'
import { ROVING_KEY } from './rovingList'
import { settleOffers, useSettleOffer, type SettleOffer } from './settleUndo'
import { claimedThreadChord, fixedKeyFree, sameThreadKeys, SETTLE_UNDO_CHORD, threadChordLabel, threadChordPressed } from './threadShortcuts'
import './settleUndo.css'

/** A text field keeps Ctrl+Z for its own typing, so the toast leaves it there. */
const typing = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)

/** How many frames Undo waits for its row to be drawn again before the focus goes to the list's own stop. */
const LANDING_FRAMES = 12

/**
 * The settle toast (ADR-0165, Zach's pick B of #1826) at the Threads sidebar's foot: "Settled <title>" with **Undo** for
 * about six seconds after a Settle the user pressed. Undo is Restore, the press the Settled shelf and its shortcut make, so
 * the thread comes back where it stood with the delegated threads settled with it. Where the settle also removed the
 * thread's worktree folder it says so plainly and offers no Undo, since Restore cannot bring the folder back as it was.
 * It never takes the focus. Its Undo is in the Tab order after the thread list, and Ctrl+Z (Cmd+Z) presses it from
 * anywhere a text field, a terminal or a dialog does not take the keys. Its time stands still while the pointer or the
 * focus is on it, and it goes as soon as its thread is restored some other way.
 */
export function SettleToast({ command, threads, list, platform: givenPlatform, placement = 'sidebar' }: {
  readonly command: AgentConnection['command']
  readonly threads: readonly AgentThread[]
  /** The thread list, where the focus lands on the restored row once Undo took it from the toast. */
  readonly list?: RefObject<HTMLElement | null> | undefined
  readonly platform?: SottoPlatform | undefined
  /** At the sidebar's foot, or in the window's corner where there is no sidebar: Watcher's room. */
  readonly placement?: 'sidebar' | 'corner'
}): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const platform: SottoPlatform = givenPlatform ?? app?.platform ?? 'win32'
  // Ctrl+Z stands down for dictation, as every fixed key does, and for a thread shortcut the user saved on it before
  // Settings › Keyboard refused those keys.
  const settings = app?.settings
  const undoKeys = useMemo(() => fixedKeyFree(settings, SETTLE_UNDO_CHORD, platform)
    && !THREAD_SHORTCUT_IDS.some(id => { const chord = claimedThreadChord(settings, id, platform); return chord !== null && sameThreadKeys(chord, SETTLE_UNDO_CHORD, platform) })
    ? threadChordLabel(SETTLE_UNDO_CHORD, platform) : undefined, [settings, platform])
  const offer = useSettleOffer()
  const shown = offer !== null && !offer.asking ? offer : null
  const region = useRef<HTMLDivElement>(null)
  // The toast goes once its thread is no longer settled, restored from the shelf or its shortcut, or cleared: an offer only
  // after it has been seen settled, as the settle's own update can arrive after its reply; a refused or unconfirmed Undo
  // as soon as the thread is seen restored after all, since its answer came after the update it would have carried.
  const thread = shown === null ? undefined : threads.find(item => item.id === shown.threadId)
  const settledNow = thread !== undefined && isWorkspaceThreadSettled(thread)
  const seen = useRef<number | null>(null)
  useEffect(() => {
    if (shown === null) return
    if (settledNow) seen.current = shown.id
    else if (seen.current === shown.id || shown.kind === 'refused' || shown.kind === 'unconfirmed') settleOffers.dismiss(shown.id)
  }, [shown, settledNow])
  // Held while the pointer or the focus is on it, read from the window rather than kept, so a toast that replaces another
  // under a still pointer, or takes away the focused Undo, is held or not as things stand.
  const holdNow = useCallback((): void => {
    const area = region.current
    settleOffers.hold(area !== null && (area.matches(':hover') || area.contains(document.activeElement)))
  }, [])
  const shownId = shown?.id
  useLayoutEffect(() => { holdNow() }, [shownId, holdNow])
  // A toast taken away while held (the sidebar collapsing, another page) lets its time run again, or it would stand for good.
  useEffect(() => () => settleOffers.hold(false), [])
  /** Undo from the toast leaves the focus on the restored row, or on the list's own stop if the row is not drawn. */
  const land = useCallback((threadId: string): void => {
    let frames = 0
    const tryLanding = (): void => {
      const active = document.activeElement
      if (active !== null && active !== document.body) return
      const listed = list?.current
      const row = listed?.querySelector<HTMLElement>(`[${ROVING_KEY}="thread:${CSS.escape(threadId)}"]`)
      if (row) { row.focus(); return }
      if (++frames < LANDING_FRAMES) { requestAnimationFrame(tryLanding); return }
      listed?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
    }
    requestAnimationFrame(tryLanding)
  }, [list])
  const undo = useCallback((settled: SettleOffer, fromToast: boolean): void => {
    settleOffers.dismiss(settled.id)
    // A refusal is main's own words; no answer at all leaves it unknown whether the thread came back.
    void command({ type: 'restore-thread', threadId: settled.threadId }).then(result => {
      if (!result) { settleOffers.refused(settled.threadId, settled.title, undefined); return }
      if (result.error) { settleOffers.refused(settled.threadId, settled.title, result.error); return }
      if (fromToast) land(settled.threadId)
    }, () => settleOffers.refused(settled.threadId, settled.title, undefined))
  }, [command, land])
  // Ctrl+Z (Cmd+Z) while Undo stands, unless dictation uses those keys or a field, a terminal or a dialog takes them.
  const undoable = shown !== null && shown.kind === 'undo' ? shown : null
  useEffect(() => {
    if (undoable === null || undoKeys === undefined) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (!threadChordPressed(event, SETTLE_UNDO_CHORD, platform) || typing(event.target)) return
      event.preventDefault()
      undo(undoable, region.current?.contains(document.activeElement) === true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoable, undoKeys, platform, undo])
  // The words name these plainly, so a translator sees {title} and {refusal} rather than numbered places.
  const title = shown?.title ?? ''
  const refusal = shown?.refusal ?? ''
  const messages: ToastMessage[] = shown === null ? [] : [{
    id: `settle-${shown.id}`,
    tone: shown.kind === 'refused' || shown.kind === 'unconfirmed' ? 'error' : 'info',
    message: <span className="settle-toast" data-kind={shown.kind}>{shown.kind === 'undo'
      ? <>
        <span className="settle-toast__words" title={title}><Trans comment="A toast after the user settled a thread; {title} is the thread's name.">Settled {title}</Trans></span>
        <button type="button" className="tt-toast__action tt-focusable" aria-label={t`Undo: restore ${title}`} aria-keyshortcuts={undoKeys?.keys}
          title={undoKeys ? `${t`Undo`} ${undoKeys.suffix}` : t`Undo`} onClick={() => undo(shown, true)}><Trans>Undo</Trans></button>
      </>
      : shown.kind === 'removed' || shown.kind === 'removing'
        ? <span className="settle-toast__words">{shown.kind === 'removed'
          ? <Trans comment="A toast after the user settled a thread and Sotto removed its worktree folder; {title} is the thread's name.">Settled {title} and removed its worktree. The branch is kept.</Trans>
          : <Trans comment="A toast while a cleanup rule removes a settled thread's worktree folder; {title} is the thread's name.">Settled {title}. Removing its worktree…</Trans>}</span>
        : <>
          <span className="settle-toast__words">{shown.kind === 'refused'
            ? <Trans comment="A toast after Undo could not restore a settled thread; {title} is its name and {refusal} says why.">{title} is still settled. {refusal}</Trans>
            : <Trans comment="A toast after Undo got no answer; {title} is the thread's name.">Sotto could not confirm that {title} came back. If it is still on the Settled shelf, restore it from there.</Trans>}</span>
          <button type="button" className="tt-toast__dismiss tt-focusable" aria-label={t`Dismiss`} title={t`Dismiss`} onClick={() => settleOffers.dismiss(shown.id)}><X size={14} aria-hidden="true" /></button>
        </>}
    </span>,
  }]
  return <div ref={region} className={placement === 'sidebar' ? 'thread-nav__toast' : 'settle-toast-corner'}
    onPointerEnter={() => settleOffers.hold(true)} onPointerLeave={() => settleOffers.hold(region.current?.contains(document.activeElement) === true)}
    onFocus={() => settleOffers.hold(true)}
    onBlur={event => { if (!region.current?.contains(event.relatedTarget as Node | null)) settleOffers.hold(region.current?.matches(':hover') === true) }}>
    <ToastRegion placement={placement} messages={messages} />
  </div>
}
