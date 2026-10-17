import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Clock, Square, TriangleAlert } from 'lucide-react'
import type { WatcherThreadTarget } from '../../../shared/watcher'
import { stopAllRunning, type WatcherStopAllResult } from '../../../shared/watcherRoom'
import { Button } from '../components/Button'
import { ProviderMark } from '../agents/ProviderMark'
import type { WatcherRoom } from './watcherRoom'
import type { ConversationThread, WatcherConversation } from './WatcherReceipts'

type StopResult = Extract<WatcherStopAllResult, { status: 'ok' }>['results'][number]
type Phase =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'confirm'; readonly confirmationId: string; readonly targets: readonly WatcherThreadTarget[] }
  | { readonly kind: 'stopping'; readonly targets: readonly WatcherThreadTarget[] }
  | { readonly kind: 'done'; readonly results: readonly StopResult[] }
  | { readonly kind: 'refused'; readonly message: string }

const NOTE = 'Each stops its current turn and keeps the work it has done. Threads you started or took over keep running.'
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`
const named = (facts: ConversationThread): string => facts.title ?? 'A thread no longer here'

/** Stop all's question, with how many it stops. */
export function stopQuestion(count: number): string {
  return count === 1 ? 'Stop the thread Watcher started?' : `Stop the ${count} threads Watcher started?`
}
/** The press that stops them. */
export function stopButton(count: number): string { return count === 1 ? 'Stop 1 thread' : `Stop ${count} threads` }

/** What came of one thread's stop: stopped, asked of its computer and waiting on it, or main's words for what went wrong. */
export function stopResultWords(result: StopResult, facts: ConversationThread): string {
  if (result.status === 'stopped') return 'Stopped.'
  if (result.status === 'requested') return facts.remote && facts.computer ? `Stop requested. Waiting on ${facts.computer} to confirm.` : 'Stop requested. Waiting for it to confirm.'
  return result.message
}

/** The line over the results: everything stopped, or how many did and what the rest wait on. */
export function stopSummary(results: readonly StopResult[], describe: (target: WatcherThreadTarget) => ConversationThread): string {
  const count = results.length
  if (count === 0) return 'Watcher had no threads to stop. Nothing was stopped.'
  const waiting = results.filter(result => result.status === 'requested')
  const unsure = results.filter(result => result.status !== 'stopped' && result.status !== 'requested')
  const hosts = [...new Set(waiting.map(result => describe(result.target)).filter(facts => facts.remote && facts.computer).map(facts => facts.computer!))].join(' and ')
  const on = hosts === '' ? '' : ` on ${hosts}`
  if (count === 1) {
    const title = named(describe(results[0]!.target))
    return waiting.length ? `Stop requested for ${title}. Waiting${on} to confirm.` : unsure.length ? `${title} may still be running.` : `Stopped ${title}.`
  }
  if (waiting.length === 0 && unsure.length === 0) return `Stopped ${count} threads.`
  const one = (value: number): string => value === 1 ? 'One' : String(value)
  return [`Stopped ${count - waiting.length - unsure.length} of ${count}.`,
    waiting.length ? `${one(waiting.length)} ${waiting.length === 1 ? 'is' : 'are'} waiting${on} to confirm.` : '',
    unsure.length ? `${one(unsure.length)} may still be running.` : ''].filter(Boolean).join(' ')
}

/**
 * Stop all in Watcher's header (Zach's pick on October 16, 2026), shown only while threads Watcher started are running.
 * A press asks main which threads it would stop and asks the user first, naming each with what it is doing; the stop
 * then says what became of each, including one still waiting on its computer to confirm. Escape, Cancel or Close put it
 * away and focus returns to the button; a press outside puts it away and leaves focus where that press put it. While the
 * stop runs it stays, so its results are not lost.
 */
export function WatcherStopAll({ room, conversation, fallbackFocus }: {
  readonly room: WatcherRoom
  readonly conversation: Pick<WatcherConversation, 'describe' | 'press'>
  /** Where focus goes when Stop all itself is gone by the time the popover closes. */
  readonly fallbackFocus: () => void
}): ReactNode {
  const running = useMemo(() => room.state === null ? [] : stopAllRunning(room.state), [room.state])
  const [phase, setPhase] = useState<Phase | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const panelId = useId(), titleId = useId(), noteId = useId()
  const open = phase !== null
  const close = (): void => {
    setPhase(null)
    window.setTimeout(() => { if (button.current?.isConnected) button.current.focus(); else fallbackFocus() }, 0)
  }
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setPhase(current => current?.kind === 'stopping' ? current : null)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])
  // Focus goes into the popover as each step draws: Cancel to ask, Close once it is done.
  useEffect(() => {
    if (phase?.kind === 'confirm' || phase?.kind === 'done' || phase?.kind === 'refused') panel.current?.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus()
  }, [phase?.kind])
  if (room.stopAll === null || (running.length === 0 && phase === null)) return null
  const stopAll = room.stopAll
  const prepare = async (): Promise<void> => {
    setPhase({ kind: 'preparing' })
    try {
      const preview = await stopAll.prepare()
      setPhase(current => current?.kind !== 'preparing' ? current : preview.status === 'ok'
        ? { kind: 'confirm', confirmationId: preview.confirmationId, targets: preview.targets } : { kind: 'refused', message: preview.message })
    } catch { setPhase(current => current === null ? null : { kind: 'refused', message: 'Sotto could not reach Watcher. Nothing was stopped. Try again.' }) }
  }
  const confirm = async (confirmationId: string, targets: readonly WatcherThreadTarget[]): Promise<void> => {
    setPhase({ kind: 'stopping', targets })
    try {
      const result = await stopAll.stop({ confirmationId })
      if (result.status === 'ok') room.settle({ status: 'ok', state: result.state })
      setPhase(current => current === null ? null : result.status === 'ok' ? { kind: 'done', results: result.results } : { kind: 'refused', message: result.message })
    } catch { setPhase(current => current === null ? null : { kind: 'refused', message: 'Sotto could not reach Watcher, so it cannot say what stopped. Open each thread to check.' }) }
  }
  const count = phase?.kind === 'confirm' || phase?.kind === 'stopping' ? phase.targets.length : running.length
  const name = (target: WatcherThreadTarget): ReactNode => {
    const facts = conversation.describe(target)
    return facts.threadId === null ? <span className="watcher-stop__name">{named(facts)}</span>
      : <button type="button" className="receipt-link tt-focusable" aria-label={`Open ${named(facts)} beside Watcher`} title={named(facts)}
        {...conversation.press(facts.threadId)} onClickCapture={() => setPhase(null)}>{named(facts)}</button>
  }
  let body: ReactNode
  if (phase === null) body = null
  else if (phase.kind === 'preparing') body = <><h2 id={titleId}>Stop the threads Watcher started?</h2><p className="watcher-stop__note" role="status">Checking which threads are Watcher’s…</p></>
  else if (phase.kind === 'refused') body = <>
    <h2 id={titleId}>Nothing was stopped</h2>
    <p className="watcher-stop__note watcher-stop__refused" role="alert">{phase.message}</p>
    <div className="watcher-stop__actions"><Button variant="secondary" data-autofocus onClick={close}>Close</Button></div>
  </>
  else if (phase.kind === 'done') body = <>
    <div role="status"><h2 id={titleId}>{stopSummary(phase.results, conversation.describe)}</h2></div>
    {phase.results.length ? <ul className="watcher-stop__results">{phase.results.map(result => {
      const facts = conversation.describe(result.target)
      const kind = result.status === 'stopped' ? 'stopped' : result.status === 'requested' ? 'requested' : 'uncertain'
      const Icon = kind === 'stopped' ? Check : kind === 'requested' ? Clock : TriangleAlert
      return <li key={`${result.target.hostId}:${result.target.threadId}`} className="watcher-stop__result" data-result={kind}>
        <Icon size={15} aria-hidden="true" /><span>{name(result.target)}<span className="watcher-stop__said">{stopResultWords(result, facts)}</span></span>
      </li>
    })}</ul> : null}
    <div className="watcher-stop__actions"><Button variant="secondary" data-autofocus onClick={close}>Close</Button></div>
  </>
  else {
    const { targets } = phase
    const stopping = phase.kind === 'stopping'
    body = <>
      <h2 id={titleId}>{targets.length === 0 ? 'Watcher has no running threads to stop.' : stopQuestion(targets.length)}</h2>
      {targets.length ? <ul className="watcher-stop__list">{targets.map(target => {
        const facts = conversation.describe(target)
        return <li key={`${target.hostId}:${target.threadId}`} className="watcher-stop__row">
          {facts.providerId === undefined ? <span aria-hidden="true" /> : <span className="thread-nav__mark" data-provider={facts.providerId} aria-hidden="true"><ProviderMark provider={facts.providerId} name={facts.provider ?? facts.providerId} /></span>}
          <span className="watcher-stop__name">{named(facts)}{facts.remote && facts.computer ? <span className="watcher-stop__where"> on {facts.computer}</span> : null}</span>
          {facts.status === null ? null : <span className="watcher-stop__state" data-tone={facts.tone}>{facts.status}</span>}
        </li>
      })}</ul> : null}
      {targets.length ? <p className="watcher-stop__note" id={noteId}>{NOTE}</p> : null}
      <div className="watcher-stop__actions">
        <Button variant="secondary" data-autofocus disabled={stopping} onClick={close}>{targets.length ? 'Cancel' : 'Close'}</Button>
        {targets.length && phase.kind === 'confirm' ? <Button variant="danger" onClick={() => void confirm(phase.confirmationId, targets)}>{stopButton(targets.length)}</Button> : null}
        {stopping ? <Button variant="danger" disabled>Stopping…</Button> : null}
      </div>
    </>
  }
  return <div className="watcher-stop-all" onKeyDown={event => {
    if (!open || event.key !== 'Escape' || event.nativeEvent.isComposing) return
    event.preventDefault(); event.stopPropagation()
    if (phase.kind === 'stopping') return
    close()
  }}>
    <button ref={button} type="button" className="watcher-stop-all__button tt-focusable" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={`Stop all threads Watcher started, ${plural(count, 'thread')}`} title="Stop all threads Watcher started"
      onClick={() => { if (phase?.kind === 'stopping') return; if (open) close(); else void prepare() }}>
      <Square size={13} aria-hidden="true" /><span className="watcher-stop-all__text">Stop all</span>
    </button>
    {open ? <div ref={panel} id={panelId} className="watcher-stop" role="dialog" aria-labelledby={titleId}
      aria-describedby={phase.kind === 'confirm' && phase.targets.length ? noteId : undefined}>{body}</div> : null}
  </div>
}
