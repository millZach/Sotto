import React, { useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SquarePen } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { shownWords, type LaterWords } from '../features/settings/laterWords'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { resolveModel } from '../../../shared/modelCatalog'
import { stopAllRunning, type WatcherRoomState } from '../../../shared/watcherRoom'
import { Button } from '../components/Button'
import { WatcherOwl } from './WatcherOwl'
import { watchedRows, useWatcherRoom, type WatcherRoom } from './watcherRoom'

/**
 * New Watcher (Zach's pick on October 21, 2026, variant A of `prototype/new-watcher-button`): a quiet chip first in
 * Watcher's composer footer, where an ordinary thread says where it runs. A press starts a new Watcher at once on the
 * current one's provider, model, effort and permissions, through the same replacement a provider change makes (ADR-0073).
 * The last conversation goes to Watcher history, workers and standing watches carry on, and the handover offer stands
 * over the new composer. Unavailable, it stays in the Tab order and says why, as the Comment button in Changes does.
 */

// The English of the chip's title and of why it cannot start one, for the tests that read them; the chip shows them in
// the interface language.
export const NEW_WATCHER_TITLE = 'Start a new Watcher with a handover of this one'
export const NEW_WATCHER_BUSY = 'Watcher is working. Stop its turn to start a new one.'
export const NEW_WATCHER_EMPTY = 'This Watcher is new, so there is nothing to hand over yet.'
const UNAVAILABLE = {
  busy: msg`Watcher is working. Stop its turn to start a new one.`,
  empty: msg`This Watcher is new, so there is nothing to hand over yet.`,
} as const

/**
 * Why New Watcher cannot start one now: Watcher's own turn running, as the window sees it or by main's own answer
 * (`newWatcher`), or nothing said yet, so nothing to hand over. Zach, October 28, 2026: "If you are in a turn I should have
 * to stop you to start a new watcher". Nothing else holds it (#1735): a turn that waits on a card of Watcher's is stopped by
 * the press, and the card's question handed over; a message on its way moves to the new Watcher's queue, paused. A press
 * still asks main. Null when a press may go.
 */
export function newWatcherUnavailable(state: AgentState, thread: AgentThread, main?: WatcherRoomState['newWatcher']): string | null {
  void state
  const why = newWatcherBlocked(thread, main)
  return why === null ? null : i18n._(UNAVAILABLE[why])
}

function newWatcherBlocked(thread: AgentThread, main?: WatcherRoomState['newWatcher']): keyof typeof UNAVAILABLE | null {
  if (thread.status === 'running' && thread.requests.length === 0 || main === 'busy') return 'busy'
  const said = thread.messages.length > 0 || (thread.summary?.messageCount ?? 0) > 0 || thread.earlierAvailable === true || thread.lastUserMessageId !== undefined
  return said && main !== 'empty' ? null : 'empty'
}

/** The chip in Watcher's composer; nothing where the room's bridge cannot start a new Watcher. */
export function WatcherNewButton({ state, thread, noticeSlot }: {
  readonly state: AgentState
  readonly thread: AgentThread
  /** The composer's row for what happened to a change, under its footer, where a refusal is said. */
  readonly noticeSlot: HTMLElement | null
}): ReactNode {
  const { t } = useLingui()
  const room = useWatcherRoom()
  const reasonId = useId()
  const [starting, setStarting] = useState(false)
  const [refusal, setRefusal] = useState<LaterWords | null>(null)
  const startNew = room?.startNew ?? null
  if (room === null || startNew === null) return null
  const why = starting ? t`Starting a new Watcher…` : newWatcherUnavailable(state, thread, room.state?.newWatcher)
  const press = async (): Promise<void> => {
    if (why !== null) return
    setStarting(true); setRefusal(null)
    // Started, this composer goes with the last Watcher, and Watcher's pane gives focus to the new one's.
    try { setRefusal(room.settle(await startNew())) } catch { setRefusal(msg`Sotto could not reach Watcher, so no new Watcher was started. Try again.`) } finally { setStarting(false) }
  }
  const notice = refusal === null ? null : <p className="thread-options__notice tt-paragraph" role="alert"><span>{shownWords(refusal)}</span></p>
  return <>
    <button type="button" className="thread-chip watcher-new tt-focusable" title={why ?? t`Start a new Watcher with a handover of this one`}
      aria-label={t`New Watcher`} aria-disabled={why !== null || undefined} aria-describedby={why !== null ? reasonId : undefined} onClick={() => void press()}>
      <SquarePen size={14} aria-hidden="true" /><span className="watcher-new__label"><Trans>New Watcher</Trans></span></button>
    <span className="watcher-new__separator" aria-hidden="true">·</span>
    {why !== null ? <span id={reasonId} className="tt-visually-hidden">{why}</span> : null}
    {noticeSlot !== null && notice !== null ? createPortal(notice, noticeSlot) : notice}
  </>
}

/** "Watcher still watches your 3 threads, and the threads it started keep working.", or the part of it that is true. */
export function carriesOnSentence(watching: number, working: number): string | null {
  if (watching > 0 && working === 0) return plural(watching, { 1: 'Watcher still watches one of your threads.', other: 'Watcher still watches your # threads.' })
  if (watching > 0) {
    return plural(watching, {
      1: plural(working, {
        one: 'Watcher still watches one of your threads, and the thread it started keeps working.',
        other: 'Watcher still watches one of your threads, and the threads it started keep working.',
      }),
      other: plural(working, {
        one: `Watcher still watches your ${watching} threads, and the thread it started keeps working.`,
        other: `Watcher still watches your ${watching} threads, and the threads it started keep working.`,
      }),
    })
  }
  return working === 0 ? null : plural(working, { one: 'The thread Watcher started keeps working.', other: 'The threads Watcher started keep working.' })
}

/**
 * What a new Watcher's empty conversation says, in place of a thread's "What is next" (the prototype's After press): the
 * model it is on and what carried on. Only while it has said nothing and replaced an earlier conversation, by New Watcher
 * or a provider change; null otherwise, and then nothing of the room is counted.
 */
export function newWatcherNoteFacts(state: AgentState, thread: AgentThread, room: WatcherRoomState | null): { readonly model: string; readonly carries: string | null; readonly carried: WatcherRoomState['carried'] | null } | null {
  if (room === null || room.history.length === 0 || newWatcherBlocked(thread) !== 'empty') return null
  return { model: resolveModel(state.host.models, thread.modelId)?.name ?? thread.modelId,
    carries: carriesOnSentence(watchedRows(room).length, stopAllRunning(room).length), carried: room.carried ?? null }
}

/**
 * The note itself: which model, where the last conversation went, and what carried on; then a line for each thing the
 * press carried over (#1735), the fact first, each only when it is so (Zach's pick B of the October 28 prototype).
 */
export function NewWatcherNote({ model, carries, carried }: { readonly model: string; readonly carries: string | null; readonly carried?: WatcherRoomState['carried'] | null }): ReactNode {
  const { t } = useLingui()
  const lines: { readonly key: string; readonly fact: string; readonly rest: string }[] = []
  if (carried?.questionClosed) lines.push({ key: 'question', fact: t`Its question to you was closed.`, rest: t`The handover carries it.` })
  if (carried?.questionOpen) lines.push({ key: 'question-open', fact: t`Its question to you may still be open in the last conversation.`, rest: t`Answer it here instead; the handover carries it.` })
  if (carried && carried.moved > 0) lines.push({ key: 'moved', fact: plural(carried.moved, { one: 'One message you wrote had not sent.', other: '# messages you wrote had not sent.' }),
    rest: plural(carried.moved, { one: 'It is in the queue below, paused.', other: 'They are in the queue below, paused.' }) })
  if (carried?.draftMoved) lines.push({ key: 'draft', fact: t`What you were writing moved here.`, rest: t`It is in the box below, not sent.` })
  if (carried?.unconfirmed) lines.push({ key: 'unconfirmed', fact: t`Your last message was not confirmed.`, rest: t`If it arrived, it is in the last conversation.` })
  for (const { host, count, titles } of carried?.cannotStop ?? []) {
    const named = titles?.length ? titles.join(', ') : null
    lines.push({ key: `host:${host}`, fact: plural(count, { one: `It can’t stop one thread on ${host}`, other: `It can’t stop # threads on ${host}` }),
      rest: named === null ? t`until ${host} is updated.` : t`until ${host} is updated: ${named}.` })
  }
  return <div className="thread-workspace__empty watcher-new-note">
    <WatcherOwl size={26} />
    <h3><Trans>New Watcher on {model}.</Trans></h3>
    <p className="tt-paragraph"><Trans>The last conversation is in Watcher history on the Threads page.</Trans>{carries === null ? '' : ` ${carries}`}</p>
    {lines.length > 0 ? <ul className="watcher-new-note__carried">{lines.map(line => <li key={line.key}><strong>{line.fact}</strong> {line.rest}</li>)}</ul> : null}
  </div>
}

/**
 * In the room's place while the current Watcher's creation has stopped part-way, by New Watcher or a provider change:
 * what happened, that nothing was sent, and Try again, which finishes the creation with the choice it was saved with.
 * A refusal is said in main's words. Started, the new Watcher's pane takes the room and focus goes to its composer.
 */
export function WatcherStartStopped({ room }: { readonly room: WatcherRoom }): ReactNode {
  const { t } = useLingui()
  const [trying, setTrying] = useState(false)
  const [refusal, setRefusal] = useState<LaterWords | null>(null)
  const startNew = room.startNew
  const replaced = (room.state?.history.length ?? 0) > 0
  const retry = async (): Promise<void> => {
    if (startNew === null || trying) return
    setTrying(true); setRefusal(null)
    try { setRefusal(room.settle(await startNew())) } catch { setRefusal(msg`Sotto could not reach Watcher, so nothing was started. Try again.`) } finally { setTrying(false) }
  }
  return <div className="watcher-room__stopped">
    <p className="tt-paragraph" role="status">{replaced
      ? t`The new Watcher could not be started. Nothing was sent, and the last conversation is in Watcher history on the Threads page.`
      : t`Watcher could not be started. Nothing was sent.`} {startNew === null ? t`Reopen Sotto to try again.` : t`Try again, or check its provider in Settings, under Providers.`}</p>
    {startNew === null ? null : <Button variant="secondary" aria-disabled={trying || undefined} onClick={() => void retry()}>{trying ? t`Trying again…` : t`Try again`}</Button>}
    {refusal === null ? null : <p className="agent-error tt-paragraph" role="alert">{shownWords(refusal)}</p>}
  </div>
}
