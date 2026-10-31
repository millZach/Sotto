import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentThread } from '../../../shared/agents'
import type { MachineEntry } from '../../../shared/machineLine'
import { THIS_COMPUTER } from '../../../shared/workingThreads'
import { Button } from '../components/Button'
import { agoWords, machineName } from './machineWords'
import { moveSheetStore, useMovesOffered } from './MoveThreads'
import { moveSuggestionCandidates, moveSuggestionNotNow, moveSuggestionPlan, plainlyHeld, type MoveSuggestionSource } from './moveSuggestionPlan'

/**
 * How many hundreds of a machine's threads one reading asks about: four previews at most, below the eight main keeps, so
 * the line never pushes out a preview the sheet or a card still holds.
 */
const MOVE_SUGGESTION_PAGES_MAX = 4
/** A press under way or refused, for the reading it was pressed on. */
type Phase = { readonly kind: 'moving'; readonly reading: string } | { readonly kind: 'refused'; readonly reading: string; readonly message: string }

/** The machine's name on the machines line, wide or narrow, whichever shows, or the composer. */
function focusAfter(from: MachineEntry): void {
  const key = CSS.escape(from.thisComputer ? THIS_COMPUTER : from.hostId)
  const shown = [...document.querySelectorAll<HTMLElement>(`.watcher-machines [data-host="${key}"] button`)].find(button => button.getClientRects().length > 0)
  ;(shown ?? document.querySelector<HTMLElement>('#watcher-prompt'))?.focus()
}

/**
 * The move suggestion under the machines line (#1309, Zach's picks of October 30, 2026): "forge is short on memory, and
 * This computer has room. Move Tray icon at night there?", with Move to This computer, Choose threads… and Not now. The
 * thread it names is the one at a clean point that worked most recently, as main's own preview finds it, asked once a
 * reading: the same checks as Move threads, so the line never names one that would not move then. A thread that has since
 * started a turn or shows a card is not named; a press asks main for a fresh preview and starts that one move, whose card
 * then reports it in Watcher's conversation, and a move that would start narrower opens the sheet for that thread at the
 * same machine, where it asks first. Not now passes the machine over until it reads fine again.
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
  // From the machines alone, so a thread's update does no work here.
  const plan = useMemo(() => bridge === undefined ? null : moveSuggestionPlan(entries, notNow), [bridge, entries, notNow])
  // Each machine reading's answer, by `MoveSuggestionSource.reading`: the thread to name there, or null when none would
  // move now. Kept by that machine's own reading, so an answer that comes late fills only its own, never a newer one's.
  const answers = useRef(new Map<string, string | null>())
  const asking = useRef(new Set<string>())
  const [answered, setAnswered] = useState(0)
  // A reading whose suggestion was pressed: it says nothing more until the next reading.
  const [handled, setHandled] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase | null>(null)
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  // While the Move threads sheet is open the line asks main nothing: main keeps only a few previews at once, and the
  // line's would push out the sheet's before its Move is pressed.
  const sheetOpen = useSyncExternalStore(moveSheetStore.subscribe, moveSheetStore.get) !== null
  /** A machine's answer, unless the thread it named has since stopped being plainly movable: then it names nothing. */
  const usable = (answer: string | null | undefined): string | null | undefined => {
    if (answer === undefined || answer === null) return answer
    const found = threadsRef.current.find(item => item.id === answer)
    return found === undefined || plainlyHeld(found) ? null : answer
  }
  // Each machine's reading asks main once which of its threads would move now, a troubled machine at a time until one has
  // a thread to name. The same reading never asks again, whatever the threads do under it, however often the line draws,
  // and whatever another machine reads or the user says Not now to.
  useEffect(() => {
    if (bridge === undefined || plan === null || sheetOpen) return
    for (const key of answers.current.keys()) if (!plan.troubled.some(source => source.reading === key)) answers.current.delete(key)
    const next = plan.troubled.find(source => usable(answers.current.get(source.reading)) !== null)
    if (next === undefined || answers.current.has(next.reading) || asking.current.has(next.reading)) return
    asking.current.add(next.reading)
    const target = plan.to.machine!.hostId
    void (async () => {
      let named: string | null = null
      try {
        for (const page of moveSuggestionCandidates(threadsRef.current, next.from).slice(0, MOVE_SUGGESTION_PAGES_MAX)) {
          // The sheet opened meanwhile: this reading is asked again once it closes.
          if (moveSheetStore.get() !== null) { asking.current.delete(next.reading); return }
          const preview = await bridge.prepare({ threadIds: [...page], hostId: target })
          const moves = new Set(preview.status === 'ok' ? preview.threads.filter(item => item.outcome === 'moves').map(item => item.threadId) : [])
          named = page.find(id => moves.has(id)) ?? null
          if (named !== null) break
        }
      } catch { /* That machine's threads go unnamed this reading; the next machine may still have one. */ }
      answers.current.set(next.reading, named)
      asking.current.delete(next.reading)
      setAnswered(count => count + 1)
    })()
    // `usable` reads the threads through a ref on purpose: a thread's update asks nothing, and the machines line draws a
    // new plan when a thread starts or ends a turn, which is when a named thread can stop being movable.
  }, [bridge, plan, answered, sheetOpen])
  const labelId = useId()
  let named: { readonly source: MoveSuggestionSource; readonly threadId: string } | null = null
  for (const source of plan?.troubled ?? []) {
    const answer = usable(answers.current.get(source.reading))
    if (answer === undefined) break
    if (answer !== null) { named = { source, threadId: answer }; break }
  }
  const thread = named === null ? undefined : threads.find(item => item.id === named.threadId)
  if (bridge === undefined || plan === null || named === null || thread === undefined || plainlyHeld(thread) || handled === plan.reading) return null
  const { to, reading } = plan
  const { from, problems } = named.source
  const fromName = machineName(from), toName = machineName(to)
  const title = thread.title
  const move = async (): Promise<void> => {
    setPhase({ kind: 'moving', reading })
    let preview
    try {
      preview = await bridge.prepare({ threadIds: [thread.id], hostId: to.machine!.hostId })
    } catch { setPhase({ kind: 'refused', reading, message: t`Sotto could not check whether ${title} can move. Nothing was moved. Try again.` }); return }
    if (preview.status !== 'ok') { setPhase({ kind: 'refused', reading, message: preview.message }); return }
    const planned = preview.threads.find(item => item.threadId === thread.id)
    if (planned?.outcome === 'asks') {
      // It would start narrower there: the sheet, at the same machine, says how and asks first.
      setHandled(reading); setPhase(null)
      moveSheetStore.open({ kind: 'one', threadId: thread.id, title, targetHostId: to.machine!.hostId, ...from.thisComputer ? {} : { hostId: from.hostId } })
      return
    }
    if (planned?.outcome !== 'moves') { setPhase({ kind: 'refused', reading, message: planned?.words ?? t`${title} can’t move to ${toName} now. Nothing was moved.` }); return }
    try {
      const started = await bridge.start({ confirmationId: preview.confirmationId, threadIds: [thread.id], allowNarrower: [] })
      if (started.status === 'refused') { setPhase({ kind: 'refused', reading, message: started.message }); return }
    } catch { setPhase({ kind: 'refused', reading, message: t`Sotto lost the answer, so ${title} may be moving. Its card in Watcher’s conversation says where it stands.` }); return }
    setHandled(reading); setPhase(null)
    focusAfter(from)
  }
  const choose = (): void => { moveSheetStore.open({ kind: 'all', targetHostId: to.machine!.hostId }) }
  const dismiss = (): void => { moveSuggestionNotNow.add(from.machine!.hostId); setPhase(null); focusAfter(from) }
  const busy = problems.includes('busy'), short = problems.includes('short')
  const why = busy && short ? t`${fromName} is busy and short on memory, and ${toName} has room.`
    : busy ? t`${fromName} is busy, and ${toName} has room.` : t`${fromName} is short on memory, and ${toName} has room.`
  const at = thread.updatedAt === undefined ? Number.NaN : Date.parse(thread.updatedAt)
  const when = Number.isNaN(at) ? t`It is between turns.` : t`It last worked ${agoWords(now - at)} and is between turns.`
  // A press still under way holds every button, whatever reading came since; its refusal shows only on its own reading.
  const pending = phase?.kind === 'moving'
  const refused = phase?.kind === 'refused' && phase.reading === reading ? phase.message : null
  return <div className="watcher-move-suggestion" role="group" aria-labelledby={labelId}>
    <p id={labelId} className="watcher-move-suggestion__text">{why} <Trans>Move <b>{title}</b> there?</Trans> {when}</p>
    {refused !== null ? <p className="watcher-move-suggestion__refused" role="alert">{refused}</p> : null}
    <div className="watcher-move-suggestion__actions">
      <Button variant="primary" disabled={pending} onClick={() => void move()}>{pending ? t`Moving…` : t`Move to ${toName}`}</Button>
      <Button variant="secondary" disabled={pending} aria-label={t`Choose threads to move to ${toName}`} onClick={choose}><Trans>Choose threads…</Trans></Button>
      <Button variant="secondary" disabled={pending} aria-label={t`Not now, until ${fromName} reads fine again`} onClick={dismiss}><Trans>Not now</Trans></Button>
    </div>
  </div>
}
