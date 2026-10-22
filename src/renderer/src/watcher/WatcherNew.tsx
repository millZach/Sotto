import React, { useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SquarePen } from 'lucide-react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import { stopAllRunning, type WatcherRoomState } from '../../../shared/watcherRoom'
import { promptOnItsWay } from '../agents/ThreadOptions'
import { WatcherOwl } from './WatcherOwl'
import { watchedRows, useWatcherRoom } from './watcherRoom'

/**
 * New Watcher (Zach's pick on October 21, 2026, variant A of `prototype/new-watcher-button`): a quiet chip first in
 * Watcher's composer footer, where an ordinary thread says where it runs. A press starts a new Watcher at once on the
 * current one's provider, model, effort and permissions, through the same replacement a provider change makes (ADR-0073).
 * The last conversation goes to Watcher history, workers and standing watches carry on, and the handover offer stands
 * over the new composer. Unavailable, it stays in the Tab order and says why, as the Comment button in Changes does.
 */

export const NEW_WATCHER_TITLE = 'Start a new Watcher with a handover of this one'
export const NEW_WATCHER_BUSY = 'Wait for Watcher to finish before starting a new one.'
export const NEW_WATCHER_EMPTY = 'This Watcher is new, so there is nothing to hand over yet.'
const STARTING = 'Starting a new Watcher…'
const UNREACHABLE = 'Sotto could not reach Watcher, so no new Watcher was started. Try again.'

/**
 * Why New Watcher cannot start one now, from what the window sees: Watcher working, waiting on a card, or with a prompt
 * on its way; or nothing said yet, so nothing to hand over. Main refuses the rest (deliveries, starts and tool calls in
 * flight) in its own words. Null when a press may go.
 */
export function newWatcherUnavailable(state: AgentState, thread: AgentThread): string | null {
  if (thread.status === 'running' || thread.requests.length > 0 || promptOnItsWay(state, thread.id)) return NEW_WATCHER_BUSY
  const said = thread.messages.length > 0 || (thread.summary?.messageCount ?? 0) > 0 || thread.earlierAvailable === true || thread.lastUserMessageId !== undefined
  return said ? null : NEW_WATCHER_EMPTY
}

/** The chip in Watcher's composer; nothing where the room's bridge cannot start a new Watcher. */
export function WatcherNewButton({ state, thread, noticeSlot }: {
  readonly state: AgentState
  readonly thread: AgentThread
  /** The composer's row for what happened to a change, under its footer, where a refusal is said. */
  readonly noticeSlot: HTMLElement | null
}): ReactNode {
  const room = useWatcherRoom()
  const reasonId = useId()
  const [starting, setStarting] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const startNew = room?.startNew ?? null
  if (room === null || startNew === null) return null
  const why = starting ? STARTING : newWatcherUnavailable(state, thread)
  const press = async (): Promise<void> => {
    if (why !== null) return
    setStarting(true); setRefusal(null)
    // Started, this composer goes with the last Watcher, and Watcher's pane gives focus to the new one's.
    try { setRefusal(room.settle(await startNew())) } catch { setRefusal(UNREACHABLE) } finally { setStarting(false) }
  }
  const notice = refusal === null ? null : <p className="thread-options__notice" role="alert"><span>{refusal}</span></p>
  return <>
    <button type="button" className="thread-chip watcher-new tt-focusable" title={why ?? NEW_WATCHER_TITLE}
      aria-disabled={why !== null || undefined} aria-describedby={why !== null ? reasonId : undefined} onClick={() => void press()}>
      <SquarePen size={14} aria-hidden="true" /><span>New Watcher</span></button>
    {why !== null ? <span id={reasonId} className="tt-visually-hidden">{why}</span> : null}
    {noticeSlot !== null && notice !== null ? createPortal(notice, noticeSlot) : notice}
  </>
}

/** "Watcher still watches your 3 threads, and the threads it started keep working.", or the part of it that is true. */
export function carriesOnSentence(watching: number, working: number): string | null {
  if (watching > 0) {
    const watches = watching === 1 ? 'Watcher still watches one of your threads' : `Watcher still watches your ${watching} threads`
    return working === 0 ? `${watches}.` : `${watches}, and the ${working === 1 ? 'thread it started keeps' : 'threads it started keep'} working.`
  }
  return working === 0 ? null : `The ${working === 1 ? 'thread Watcher started keeps' : 'threads Watcher started keep'} working.`
}

/**
 * What a new Watcher's empty conversation says, in place of a thread's "What is next" (the prototype's After press): the
 * model it is on and what carried on. Only while it has said nothing and replaced an earlier conversation, by New Watcher
 * or a provider change; null otherwise, and then nothing of the room is counted.
 */
export function newWatcherNoteFacts(state: AgentState, thread: AgentThread, room: WatcherRoomState | null): { readonly model: string; readonly carries: string | null } | null {
  if (room === null || room.history.length === 0 || newWatcherUnavailable(state, thread) !== NEW_WATCHER_EMPTY) return null
  return { model: resolveModel(state.host.models, thread.modelId)?.name ?? thread.modelId,
    carries: carriesOnSentence(watchedRows(room).length, stopAllRunning(room).length) }
}

/** The note itself: which model, where the last conversation went, and what carried on. */
export function NewWatcherNote({ model, carries }: { readonly model: string; readonly carries: string | null }): ReactNode {
  return <div className="thread-workspace__empty watcher-new-note">
    <WatcherOwl size={26} />
    <h3>New Watcher on {model}.</h3>
    <p>The last conversation is in Watcher history on the Threads page.{carries === null ? '' : ` ${carries}`}</p>
  </div>
}
