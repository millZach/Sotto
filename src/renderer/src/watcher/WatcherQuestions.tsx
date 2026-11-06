import React, { useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentMessage } from '../../../shared/agents'
import { isShownReply } from '../../../shared/watcherRoom'
import { watcherQuestionRequest, type WatcherQuestion } from '../../../shared/watcherQuestions'
import { AgentRequestCard } from '../agents/requests/AgentRequestCard'
import type { RequestAnswer, SubmitOutcome } from '../agents/requests/requestAnswers'
import { prefersReducedMotion } from '../state/reducedMotion'
import { WatcherAskAnsweringContext } from './WatcherAsks'

/**
 * Where each of Watcher's own questions goes in its conversation (#2228, Zach's pick A): after the last message shown
 * from before Watcher asked, so news replies that came while it waited follow it. A question from before every message
 * there is follows the first.
 */
export function placeQuestions(messages: readonly AgentMessage[], questions: readonly WatcherQuestion[] | undefined): ReadonlyMap<string, readonly WatcherQuestion[]> {
  const placed = new Map<string, WatcherQuestion[]>()
  if (!questions?.length || messages.length === 0) return placed
  for (const question of questions) {
    const at = Date.parse(question.at)
    let anchor: string | undefined
    for (const message of messages) {
      if (Date.parse(message.createdAt) > at) break
      if (message.role === 'user' || isShownReply(message)) anchor = message.id
    }
    const key = anchor ?? messages[0]!.id
    placed.set(key, [...placed.get(key) ?? [], question])
  }
  return placed
}

/** Brings the card of Watcher's question into view and focuses it; false when it is not drawn. */
export function focusWatcherQuestion(questionId: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-watcher-question="${CSS.escape(questionId)}"]`)
  if (card === null) return false
  card.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  card.focus({ preventScroll: true })
  card.closest('.thread-workspace__transcript')?.dispatchEvent(new Event('scroll'))
  return true
}

/**
 * Watcher's own questions under one message of its conversation (#2228, Zach's pick A): while one waits, Sotto's card,
 * shaped like a watched thread's card here, which never holds Watcher; once answered, one line in the card's own words.
 */
export function WatcherQuestionCards({ questions }: { readonly questions: readonly WatcherQuestion[] }): ReactNode {
  return <div className="watcher-asks">
    {questions.map(question => question.state === 'open' ? <WatcherQuestionCard key={question.id} question={question} />
      : <p key={question.id} className="watcher-ask-receipt tt-paragraph" data-watcher-question={question.id} tabIndex={-1}>
        <span className="watcher-ask-receipt__words"><Trans>You answered: {question.choice}.</Trans></span>
      </p>)}
  </div>
}

function WatcherQuestionCard({ question }: { readonly question: WatcherQuestion }): ReactNode {
  const { t } = useLingui()
  const answering = useContext(WatcherAskAnsweringContext)
  const request = useMemo(() => watcherQuestionRequest(question), [question])
  if (answering === null) return null
  const watcher = answering.state.host.threads.find(thread => thread.id === question.watcherThreadId)
  // The answer is the ordinary answer to a card, which main hands to Watcher as the user's own choice: no provider hears it.
  const submit = (answer: RequestAnswer): Promise<SubmitOutcome> => answering.command({ type: 'answer', threadId: question.watcherThreadId, requestId: request.id, ...answer })
    .then(result => result === null ? null : { error: result.error })
  return <section className="watcher-ask watcher-ask--own" tabIndex={-1} aria-label={t`Question from Watcher`} data-watcher-question={question.id} data-kind="question">
    <div className="watcher-ask__top">
      <span className="watcher-row__ring" data-tone="needs" aria-hidden="true" />
      <strong className="watcher-ask__title"><Trans>Watcher asks</Trans></strong>
      <span className="watcher-ask__meta">
        <span className="watcher-ask__kind">{t({ message: 'question', comment: 'The kind of request a card in Watcher’s conversation holds' })}</span>
        <span><Trans>Watcher keeps working while this waits</Trans></span>
      </span>
    </div>
    <AgentRequestCard ownerId={question.watcherThreadId} ownerTitle={watcher?.title ?? 'Watcher'} request={request} providerId={watcher?.providerId}
      blocked={null} onSubmit={submit} />
  </section>
}

/**
 * The quiet "↑ Watcher's question" mark (#2228): shown while a card of Watcher's that still waits is scrolled above what
 * the conversation shows. A press brings it back into view and focuses it.
 */
export function WatcherQuestionMark({ paneId, open }: { readonly paneId: string; readonly open: readonly string[] }): ReactNode {
  const { t } = useLingui()
  const [above, setAbove] = useState<{ readonly id: string; readonly count: number } | null>(null)
  const key = open.join(' ')
  useEffect(() => {
    if (key === '') { setAbove(null); return }
    const ids = key.split(' ')
    const pane = document.getElementById(paneId)
    const scroller = pane?.querySelector<HTMLElement>('.thread-workspace__transcript') ?? null
    if (scroller === null) return
    // Read as the reader scrolls and as the conversation grows: the newest waiting card above the view, if any.
    const look = (): void => {
      const top = scroller.getBoundingClientRect().top + 12
      let found: string | null = null, count = 0
      for (const id of ids) {
        const card = scroller.querySelector<HTMLElement>(`[data-watcher-question="${CSS.escape(id)}"]`)
        if (card !== null && card.getBoundingClientRect().bottom < top) { found = id; count++ }
      }
      setAbove(previous => found === null ? null : previous?.id === found && previous.count === count ? previous : { id: found, count })
    }
    look()
    scroller.addEventListener('scroll', look, { passive: true })
    const grown = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(look)
    for (const child of scroller.children) grown?.observe(child)
    return () => { scroller.removeEventListener('scroll', look); grown?.disconnect() }
  }, [paneId, key])
  if (above === null) return null
  const { id, count } = above
  return <div className="watcher-question-mark">
    <button type="button" className="watcher-question-mark__chip tt-focusable" onClick={() => { focusWatcherQuestion(id) }}
      aria-label={count > 1 ? t`Scroll up to Watcher’s questions` : t`Scroll up to Watcher’s question`}>
      <span className="watcher-row__ring" data-tone="needs" aria-hidden="true" />
      {plural(count, { one: '↑ Watcher’s question', other: '↑ # questions from Watcher' })}
    </button>
  </div>
}
