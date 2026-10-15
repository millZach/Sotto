import React, { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import type { AgentConnection } from '../agents/AgentContext'
import { PullRequestOpenerContext, type PullRequestOpener } from '../agents/BranchToolbar'
import { toolsPanelStore } from '../tools/toolsPanelStore'
import { BrowserPageRouteContext, type BrowserPageRoute } from '../tools/webLinks'
import { DIVIDER_WIDTH, MIN_PANE_WIDTH, RESIZE_STEP } from '../agents/splitLayout'
import type { ThreadRow } from '../agents/threadFacts'
import type { ThreadDraftStore } from '../agents/threadDraftStore'
import { ThreadPane } from '../agents/ThreadPane'
import { ThreadWorkingCopyNotice } from '../agents/ThreadWorkingCopy'

/** The beside pane's composer; Watcher's own is `watcher-prompt`. */
export const BESIDE_PROMPT_ID = 'watcher-beside-prompt'
export const BESIDE_PANE_ID = 'watcher-beside-pane'
/** Where Escape belongs to something inside the pane: an open popup, or the trigger of one (a picker, a menu button). */
const POPUP_OWNS_ESCAPE = '[role="dialog"], [role="menu"], [role="listbox"], [aria-expanded="true"]:is([aria-haspopup]:not([aria-haspopup="false"]), [role="combobox"])'

/**
 * Watcher's room keeps its own view, apart from the Threads page's panes and selection (the plan, section 6): the one
 * thread open beside Watcher, how much of the width Watcher's conversation takes, and whether Watcher's pane shows its
 * conversation or the threads it watches. It lasts as long as the window, so a trip to another room comes back to the
 * room as it was left.
 */
export type RoomTab = 'conversation' | 'watched'
export interface RoomView { readonly besideId: string | null; readonly share: number; readonly tab: RoomTab }
let view: RoomView = { besideId: null, share: 0.5, tab: 'conversation' }
const listeners = new Set<() => void>()
export const roomView = {
  get: (): RoomView => view,
  set(patch: Partial<RoomView>): void {
    view = { ...view, ...patch }
    for (const listener of [...listeners]) listener()
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
}
export function useRoomView(): RoomView { return useSyncExternalStore(roomView.subscribe, roomView.get, roomView.get) }

/**
 * Where a reader in the room was, when it was not at the newest message: the first message whose text reached the
 * top of the view and how far below that top it began (negative when it began above it), and, for when that message
 * is not drawn on the way back, how far the view was from the end.
 */
interface ReadPosition { readonly messageId: string | null; readonly offset: number; readonly fromEnd: number }
/** Watcher's own reading position and each beside thread's, by thread, for as long as the window lasts. */
const readPositions = new Map<string, ReadPosition>()
/** Within this many pixels of the end, a transcript reads as at its newest message and follows what comes next. */
const AT_END_PX = 24
/** A message the transcript draws whatever is folded: not one inside an open turn fold, which comes back folded. */
const anchors = (transcript: HTMLElement): HTMLElement[] => [...transcript.querySelectorAll<HTMLElement>('[data-message-id]')].filter(item => item.closest('.thread-work__body') === null)

/**
 * Keeps the reading position of the transcript in the pane `paneId` across that pane leaving the screen, for as long
 * as the window lasts. The position is a message, not a pixel count: a transcript drawn afresh may hold fewer
 * messages or wrap them otherwise, so the same message comes back to the same place, or, when it is not drawn, the
 * view comes back as far from the end. Nothing is restored or remembered until `thread`'s history is drawn
 * (`historyDrawn`): a thread whose history the window let go comes back as an empty transcript first, and that view is
 * not where its reader was. It runs after the transcript's own scroll to its newest message, which comes first because
 * the transcript is deeper in the tree, and tells the transcript at once that its reader is not at the end, so nothing
 * arriving pulls the reader away. While `shown` is false the pane shows something else in the transcript's place
 * (Watcher's Watched view), so nothing is read or kept until the transcript is back.
 */
export function useKeptReadingPosition(thread: AgentThread, paneId: string, shown = true): void {
  const threadId = thread.id
  const drawn = historyDrawn(thread)
  useLayoutEffect(() => {
    if (!drawn || !shown) return
    const transcript = document.getElementById(paneId)?.querySelector<HTMLElement>('.thread-workspace__transcript')
    if (transcript == null) return
    const saved = readPositions.get(threadId)
    if (saved !== undefined) {
      const anchor = saved.messageId === null ? null : anchors(transcript).find(item => item.dataset['messageId'] === saved.messageId)
      if (anchor) transcript.scrollTop += anchor.getBoundingClientRect().top - transcript.getBoundingClientRect().top - saved.offset
      else transcript.scrollTop = transcript.scrollHeight - transcript.clientHeight - saved.fromEnd
      transcript.dispatchEvent(new Event('scroll'))
    }
    const remember = (): void => {
      const fromEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
      if (fromEnd <= AT_END_PX) { readPositions.delete(threadId); return }
      const top = transcript.getBoundingClientRect().top
      const anchor = anchors(transcript).find(item => item.getBoundingClientRect().bottom > top)
      readPositions.set(threadId, { messageId: anchor?.dataset['messageId'] ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, fromEnd })
    }
    transcript.addEventListener('scroll', remember, { passive: true })
    return () => transcript.removeEventListener('scroll', remember)
  }, [threadId, paneId, drawn, shown])
}

/**
 * Whether a thread's history is in the window, so its transcript draws what was read: not while it loads, and not
 * while the thread says it has messages the window does not hold yet.
 */
export function historyDrawn(thread: AgentThread): boolean {
  if (thread.historyStatus === 'loading' || thread.historyStatus === 'error') return false
  return thread.messages.length > 0 || (thread.summary?.messageCount ?? 0) === 0
}

/** The widest share Watcher may take, and the narrowest, so that each pane keeps its minimum where the room allows it. */
function shareRange(width: number): readonly [number, number] {
  const usable = width - DIVIDER_WIDTH
  if (usable < 2 * MIN_PANE_WIDTH) return [0.5, 0.5]
  return [MIN_PANE_WIDTH / usable, 1 - MIN_PANE_WIDTH / usable]
}
const clamp = (share: number, [min, max]: readonly [number, number]): number => Math.min(max, Math.max(min, share))

/**
 * The divider between Watcher and the thread beside it: drag it, or focus it and use the arrow keys, Home and End;
 * Enter or a double-click shares the width evenly again. Without a sidebar the room fits two panes of the minimum
 * width even at the smallest window, so the two always stand side by side.
 */
export function BesideDivider({ width, share, controls }: { readonly width: number; readonly share: number; readonly controls: string }): ReactNode {
  const range = shareRange(width)
  const shown = clamp(share, range)
  const drag = useRef<{ readonly pointerId: number; readonly left: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const move = (clientX: number): void => {
    const state = drag.current
    if (state === null) return
    roomView.set({ share: clamp((clientX - state.left - DIVIDER_WIDTH / 2) / Math.max(1, width - DIVIDER_WIDTH), range) })
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, left: event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0 }
    setDragging(true)
  }
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = event.key === 'ArrowLeft' ? shown - RESIZE_STEP : event.key === 'ArrowRight' ? shown + RESIZE_STEP
      : event.key === 'Home' ? range[0] : event.key === 'End' ? range[1] : event.key === 'Enter' ? 0.5 : null
    if (next === null) return
    event.preventDefault()
    roomView.set({ share: clamp(next, range) })
  }
  return <div role="separator" aria-orientation="vertical" aria-label="Resize panes" aria-controls={controls} tabIndex={0}
    aria-valuemin={Math.round(range[0] * 100)} aria-valuemax={Math.round(range[1] * 100)} aria-valuenow={Math.round(shown * 100)}
    className="thread-panes__divider watcher-split__divider tt-focusable" data-axis="columns" data-dragging={dragging || undefined} title="Drag to resize · Double-click to even"
    onPointerDown={onPointerDown} onPointerMove={event => { if (drag.current?.pointerId === event.pointerId) move(event.clientX) }}
    onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onLostPointerCapture={onPointerEnd}
    onDoubleClick={() => roomView.set({ share: 0.5 })} onKeyDown={onKeyDown} />
}

/** The share Watcher's conversation takes in a room of this width, kept inside what the minimum pane width allows. */
export function shownShare(width: number, share: number): number { return clamp(share, shareRange(width)) }

/**
 * A thread opened in Watcher's room: its real pane, with its own header, request cards, transcript and composer, so it
 * is answered and worked in exactly as on the Threads page. Its header adds Open in Threads, which takes the thread to
 * the Threads room selected, and Close. Closing or replacing it stops nothing. Its draft is the thread's own, and its
 * reading position is kept for when it opens beside Watcher again. Escape closes it, unless something inside it
 * (a menu, a picker, a docked card) answers Escape first. The room has no Tools panel, so what would open there goes
 * to the Threads page, with the thread selected, as Open in Threads does: its pull request badge opens Tools on the
 * pull request and says so, and a link that opens in Sotto's browser opens Tools on that page.
 */
export function BesidePane({ row, state, command, store, focused, underControls, error, now, onFocus, onClose, onOpenInThreads }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly store: ThreadDraftStore
  readonly focused: boolean
  /** Whether the window controls sit over this pane's header, so it keeps their corner clear. */
  readonly underControls: boolean
  readonly error: string | null
  readonly now: number | undefined
  readonly onFocus: () => void
  readonly onClose: () => void
  readonly onOpenInThreads: () => void
}): ReactNode {
  const threadId = row.thread.id
  useKeptReadingPosition(row.thread, BESIDE_PANE_ID)
  const pullRequests = useMemo<PullRequestOpener>(() => ({
    open: id => { toolsPanelStore.showPullRequest(id); onOpenInThreads() },
    where: 'in Tools on the Threads page',
  }), [onOpenInThreads])
  const pages = useMemo<BrowserPageRoute>(() => page => { toolsPanelStore.showBrowserPageOf(page); onOpenInThreads(); return { ok: true } }, [onOpenInThreads])
  return <PullRequestOpenerContext.Provider value={pullRequests}><BrowserPageRouteContext.Provider value={pages}><section id={BESIDE_PANE_ID} className="thread-pane watcher-beside" data-thread-id={threadId} data-focused={focused || undefined}
    data-under-controls={underControls || undefined} role="region" aria-label={row.thread.title}
    onFocusCapture={onFocus} onPointerDownCapture={onFocus}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
      // A popup answers Escape itself, and so does the control that owns an open one. An open disclosure folds first
      // (`foldOnEscape`); one with nothing to answer Escape no longer stops the pane closing.
      if ((event.target as Element).closest(POPUP_OWNS_ESCAPE)) return
      event.preventDefault()
      onClose()
    }}>
    <ThreadPane row={row} state={state} command={command} store={store} focused={focused} promptId={BESIDE_PROMPT_ID} error={error} now={now} onClose={onClose}
      actions={<button type="button" className="pane-action tt-focusable" aria-label={`Open ${row.thread.title} in Threads`} title="Open in Threads" onClick={onOpenInThreads}>
        <ArrowUpRight size={16} aria-hidden="true" />
      </button>}
      notice={<ThreadWorkingCopyNotice key={`working-copy-${threadId}`} thread={row.thread} project={row.project} command={command}
        onRecovered={() => document.getElementById(BESIDE_PROMPT_ID)?.focus()} />} />
  </section></BrowserPageRouteContext.Provider></PullRequestOpenerContext.Provider>
}
