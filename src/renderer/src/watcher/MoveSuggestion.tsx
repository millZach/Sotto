import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentThread } from '../../../shared/agents'
import type { MachineEntry } from '../../../shared/machineLine'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import { THIS_COMPUTER } from '../../../shared/workingThreads'
import { Button } from '../components/Button'
import { agoWords, machineName } from './machineWords'
import { isPutAway, moveSheetStore, useMovesOffered } from './MoveThreads'
import { moveSuggestionNotNow, moveSuggestionPlan, type MoveSuggestionPlan } from './moveSuggestionPlan'

/** The thread a reading's preview found at a clean point, for the line to name. */
interface Named { readonly reading: string; readonly threadId: string }
type Phase = { readonly kind: 'offer' } | { readonly kind: 'moving' } | { readonly kind: 'refused'; readonly message: string }

/**
 * The move suggestion under the machines line (#1309, Zach's picks of October 30, 2026): "forge is short on memory, and
 * This computer has room. Move Tray icon at night there?", with Move to This computer, Choose threads… and Not now. The
 * thread it names is the one at a clean point that worked most recently, as main's own preview finds it: the same checks
 * as Move threads, so the line never names one that would not move now. A press asks main for a fresh preview and starts
 * that one move, whose card then reports it in Watcher's conversation; a move that would start narrower opens the sheet
 * for that thread instead, where it asks first. Not now passes the machine over until it reads fine again.
 */
export function WatcherMoveSuggestion({ entries, threads, now }: {
  readonly entries: readonly MachineEntry[]
  readonly threads: readonly AgentThread[]
  readonly now: number
}): ReactNode {
  const { t } = useLingui()
  const bridge = useMovesOffered()
  const notNow = useSyncExternalStore(moveSuggestionNotNow.subscribe, moveSuggestionNotNow.get)
  useEffect(() => { moveSuggestionNotNow.settle(entries) }, [entries])
  const plan = useMemo(() => bridge === undefined ? null : moveSuggestionPlan(entries, threads, notNow), [bridge, entries, threads, notNow])
  const [named, setNamed] = useState<Named | null>(null)
  // A reading whose suggestion was pressed: it says nothing more until the next reading.
  const [handled, setHandled] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'offer' })
  const reading = plan?.reading ?? null
  const planRef = useRef<MoveSuggestionPlan | null>(plan)
  planRef.current = plan
  // Each new reading asks main once which of the machine's threads would move now; the same reading never asks again,
  // however often the threads change under it, so a working thread's updates never send main a preview.
  useEffect(() => {
    const asked = planRef.current
    if (bridge === undefined || asked === null || reading === null) return
    let current = true
    setPhase({ kind: 'offer' })
    void bridge.prepare({ threadIds: [...asked.candidates], hostId: asked.to.machine!.hostId }).then(preview => {
      if (!current) return
      const moves = preview.status === 'ok' ? new Set(preview.threads.filter(item => item.outcome === 'moves').map(item => item.threadId)) : new Set<string>()
      const first = asked.candidates.find(id => moves.has(id))
      setNamed(first === undefined ? null : { reading: asked.reading, threadId: first })
    }, () => { if (current) setNamed(null) })
    return () => { current = false }
  }, [bridge, reading])
  const labelId = useId()
  // A named thread that has started a turn since, or was put away, is not named: the next reading asks again.
  const found = named !== null && plan !== null && named.reading === plan.reading ? threads.find(item => item.id === named.threadId) : undefined
  const thread = found !== undefined && !isThreadTurnRunning(found) && !isPutAway(found) ? found : undefined
  if (bridge === undefined || plan === null || thread === undefined || handled === plan.reading) return null
  const { from, to, problems } = plan
  const fromName = machineName(from), toName = machineName(to)
  const title = thread.title
  const focusLine = (): void => {
    // The line goes away, so focus goes to the machine it was about on the machines line, or to the composer.
    const key = from.thisComputer ? THIS_COMPUTER : from.hostId
    const at = document.querySelector<HTMLElement>(`.watcher-machines__wide [data-host="${CSS.escape(key)}"] button`) ?? document.querySelector<HTMLElement>('#watcher-prompt')
    at?.focus()
  }
  const move = async (): Promise<void> => {
    setPhase({ kind: 'moving' })
    try {
      const preview = await bridge.prepare({ threadIds: [thread.id], hostId: to.machine!.hostId })
      if (preview.status !== 'ok') { setPhase({ kind: 'refused', message: preview.message }); return }
      const planned = preview.threads.find(item => item.threadId === thread.id)
      if (planned?.outcome === 'asks') {
        // It would start narrower there: the sheet says how, and asks first.
        setHandled(plan.reading); setPhase({ kind: 'offer' })
        moveSheetStore.open({ kind: 'one', threadId: thread.id, title, ...from.thisComputer ? {} : { hostId: from.hostId } })
        return
      }
      if (planned?.outcome !== 'moves') { setPhase({ kind: 'refused', message: planned?.words ?? t`${title} can’t move to ${toName} now. Nothing was moved.` }); return }
      const started = await bridge.start({ confirmationId: preview.confirmationId, threadIds: [thread.id], allowNarrower: [] })
      if (started.status === 'refused') { setPhase({ kind: 'refused', message: started.message }); return }
      setHandled(plan.reading); setPhase({ kind: 'offer' })
      focusLine()
    } catch { setPhase({ kind: 'refused', message: t`Sotto lost the answer, so ${title} may be moving. Its card in Watcher’s conversation says where it stands.` }) }
  }
  const choose = (): void => { moveSheetStore.open({ kind: 'all', hostId: to.machine!.hostId }) }
  const dismiss = (): void => { moveSuggestionNotNow.add(from.machine!.hostId); setPhase({ kind: 'offer' }); focusLine() }
  const busy = problems.includes('busy'), short = problems.includes('short')
  const why = busy && short ? t`${fromName} is busy and short on memory, and ${toName} has room.`
    : busy ? t`${fromName} is busy, and ${toName} has room.` : t`${fromName} is short on memory, and ${toName} has room.`
  const at = thread.updatedAt === undefined ? Number.NaN : Date.parse(thread.updatedAt)
  const when = Number.isNaN(at) ? t`It is between turns.` : t`It last worked ${agoWords(now - at)} and is between turns.`
  const pending = phase.kind === 'moving'
  return <div className="watcher-move-suggestion" role="group" aria-labelledby={labelId}>
    <p id={labelId} className="watcher-move-suggestion__text">{why} <Trans>Move <b>{title}</b> there?</Trans> {when}</p>
    {phase.kind === 'refused' ? <p className="watcher-move-suggestion__refused" role="alert">{phase.message}</p> : null}
    <div className="watcher-move-suggestion__actions">
      <Button variant="primary" disabled={pending} onClick={() => void move()}>
        {pending ? t`Moving…` : t`Move to ${toName}`}</Button>
      <Button variant="secondary" disabled={pending} aria-label={t`Choose threads to move to ${toName}`} onClick={choose}><Trans>Choose threads…</Trans></Button>
      <Button variant="secondary" disabled={pending} aria-label={t`Not now, until ${fromName} reads fine again`} onClick={dismiss}><Trans>Not now</Trans></Button>
    </div>
  </div>
}
