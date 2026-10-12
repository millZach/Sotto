import React, { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { AgentConnection } from '../agents/AgentContext'
import { PullRequestOpenerContext, type PullRequestOpener } from '../agents/BranchToolbar'
import { toolsPanelStore } from '../tools/toolsPanelStore'
import { DIVIDER_WIDTH, MIN_PANE_WIDTH, RESIZE_STEP } from '../agents/splitLayout'
import type { ThreadRow } from '../agents/threadFacts'
import type { ThreadDraftStore } from '../agents/threadDraftStore'
import { ThreadPane } from '../agents/ThreadPane'
import { ThreadWorkingCopyNotice } from '../agents/ThreadWorkingCopy'

/** The beside pane's composer; Watcher's own is `watcher-prompt`. */
export const BESIDE_PROMPT_ID = 'watcher-beside-prompt'
export const BESIDE_PANE_ID = 'watcher-beside-pane'

/**
 * Watcher's room keeps its own view, apart from the Threads page's panes and selection (the plan, section 6): the one
 * thread open beside Watcher, and how much of the width Watcher's conversation takes. It lasts as long as the window,
 * so a trip to another room comes back to the room as it was left.
 */
export interface RoomView { readonly besideId: string | null; readonly share: number }
let view: RoomView = { besideId: null, share: 0.5 }
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
 * Where each reader in the room had scrolled to, Watcher's own and each beside thread's, when that was not its newest
 * message: coming back to the room, or reopening a thread beside Watcher, goes back there.
 */
const readPositions = new Map<string, number>()
/** Within this many pixels of the end, a transcript reads as at its newest message and follows what comes next. */
const AT_END_PX = 24

/**
 * Keeps the reading position of the transcript in the pane `paneId` across that pane leaving the screen, for as long
 * as the window lasts. It runs after the transcript's own first scroll to its newest message, which comes first
 * because the transcript is deeper in the tree, and tells the transcript at once that its reader is not at the end,
 * so nothing arriving pulls the reader away.
 */
export function useKeptReadingPosition(threadId: string, paneId: string): void {
  useLayoutEffect(() => {
    const transcript = document.getElementById(paneId)?.querySelector<HTMLElement>('.thread-workspace__transcript')
    if (transcript == null) return
    const saved = readPositions.get(threadId)
    if (saved !== undefined) {
      transcript.scrollTop = saved
      transcript.dispatchEvent(new Event('scroll'))
    }
    const remember = (): void => {
      if (transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= AT_END_PX) readPositions.delete(threadId)
      else readPositions.set(threadId, transcript.scrollTop)
    }
    transcript.addEventListener('scroll', remember, { passive: true })
    return () => transcript.removeEventListener('scroll', remember)
  }, [threadId, paneId])
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
 * (a menu, a picker, a docked card) answers Escape first. The room has no Tools panel, so its pull request badge
 * opens the thread's pull request in Tools on the Threads page, with the thread selected, and says so.
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
  useKeptReadingPosition(threadId, BESIDE_PANE_ID)
  const pullRequests = useMemo<PullRequestOpener>(() => ({
    open: id => { toolsPanelStore.showPullRequest(id); onOpenInThreads() },
    where: 'in Tools on the Threads page',
  }), [onOpenInThreads])
  return <PullRequestOpenerContext.Provider value={pullRequests}><section id={BESIDE_PANE_ID} className="thread-pane watcher-beside" data-thread-id={threadId} data-focused={focused || undefined}
    data-under-controls={underControls || undefined} role="region" aria-label={row.thread.title}
    onFocusCapture={onFocus} onPointerDownCapture={onFocus}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
      if ((event.target as Element).closest('[role="dialog"], [role="menu"], [role="listbox"], [aria-expanded="true"]')) return
      event.preventDefault()
      onClose()
    }}>
    <ThreadPane row={row} state={state} command={command} store={store} focused={focused} promptId={BESIDE_PROMPT_ID} error={error} now={now} onClose={onClose}
      actions={<button type="button" className="pane-action tt-focusable" aria-label={`Open ${row.thread.title} in Threads`} title="Open in Threads" onClick={onOpenInThreads}>
        <ArrowUpRight size={16} aria-hidden="true" />
      </button>}
      notice={<ThreadWorkingCopyNotice key={`working-copy-${threadId}`} thread={row.thread} project={row.project} command={command}
        onRecovered={() => document.getElementById(BESIDE_PROMPT_ID)?.focus()} />} />
  </section></PullRequestOpenerContext.Provider>
}
