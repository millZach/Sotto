import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentRequest } from '../../../../shared/agents'
import {
  requestDraftKey, requestDraftOwnerKey, requestDraftQuestions, sameRequestQuestions,
  type RequestDraft, type RequestDraftBridge, type RequestDraftOwner,
} from '../../../../shared/requestDrafts'
import { Button } from '../../components/Button'
import { useTransientFlag, writeClipboard } from '../richActions'
import { shownWords, type LaterWords } from '../interfaceWords'
import { useInterfaceLanguageState } from '../../state/interfaceLanguage'
import { answerProgress, requestAnswerStore, textOnly, type RequestAnswerStore, type StructuredQuestion } from './requestAnswers'
import './requests.css'
import './requestDraftRecovery.css'

/** What Sotto currently observes of the owner's provider. Only `ready` may say that a question is no longer shown. */
export type RecoveryObservation = 'disconnected' | 'loading' | 'unavailable' | 'ready'

const LIST_ERROR = msg`Sotto could not read saved answers.`
const DISCARD_ERROR = msg`Sotto could not discard this saved answer. It is still kept.`
const COPY_ERROR = msg`Could not copy. Select the answer above to copy it.`
const readable = (error: unknown, fallback: LaterWords): LaterWords => error instanceof Error && error.message
  ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : fallback

/** The key includes the question definition: a reused request ID with changed questions is another form. */
const savedAnswerKey = (draft: RequestDraft): string => requestDraftKey(draft.target)

/** A live card renders exactly this request ID and definition, so it already shows the saved answer. */
function renderedLive(draft: RequestDraft, live: readonly AgentRequest[]): boolean {
  return live.some(request => request.id === draft.target.requestId
    && sameRequestQuestions(requestDraftQuestions(request), draft.target.questions))
}

/** One question's saved answer in words: the chosen option labels, then Other or free text. Null when unanswered. */
function savedAnswerText(question: StructuredQuestion, selection: RequestDraft['selections'][string] | undefined): string | null {
  if (!selection || answerProgress(question, selection) === 'empty') return null
  const text = selection.text.trim()
  if (textOnly(question)) return text || null
  const parts = question.options.filter(option => selection.optionIds.includes(option.id)).map(option => option.label)
  if (selection.other) parts.push(text ? i18n._(msg({ message: `Other: ${text}`, comment: 'A saved answer the user wrote in their own words; {text} is what they wrote.' })) : i18n._(msg({ message: 'Other', comment: 'A saved answer: the user chose to write their own answer.' })))
  return parts.join(', ')
}

const NO_ANSWER = msg({ message: 'No answer', comment: 'Stands for a question in a saved form that was left unanswered.' })

/** The clipboard form: each question's label followed by its saved answer. */
export function savedAnswerClipboard(draft: RequestDraft): string {
  return draft.target.questions.map(question => `${question.question}\n${savedAnswerText(question, draft.selections[question.id]) ?? i18n._(NO_ANSWER)}`).join('\n\n')
}

/** A form the user never filled in has nothing to recover; a held attempt is always shown. */
const hasContent = (draft: RequestDraft): boolean => draft.held
  || draft.target.questions.some(question => savedAnswerText(question, draft.selections[question.id]) !== null)

export interface RequestDraftRecoveryModel {
  /** Saved forms this owner has that no live card shows. */
  readonly drafts: readonly RequestDraft[]
  /** Sotto's words kept as a message and read when shown, or main's as written. */
  readonly error: LaterWords | null
  readonly reload: () => void
  /** Removes only this exact revision; resolves to a readable error, or null once main no longer keeps it. */
  readonly discard: (draft: RequestDraft) => Promise<LaterWords | null>
}

/**
 * The owner's durable answers that no live request card shows. Listing never refreshes, checks or sends, and a
 * response for an owner the view has since left is ignored. Owner change events list again after main commits
 * asynchronous receipt recovery; snapshots also list again when the observed owner changes.
 * A request can close before its last save or answer acknowledgement settles. When the answer store reports either
 * for a request that left the live set, the list is read again; main alone decides what it still keeps.
 */
function useRequestDraftRecovery(owner: RequestDraftOwner, live: readonly AgentRequest[], observed: string,
  bridge: RequestDraftBridge | undefined = window.sotto?.requestDrafts, answers: RequestAnswerStore = requestAnswerStore): RequestDraftRecoveryModel {
  const ownerKey = requestDraftOwnerKey(owner)
  const [result, setResult] = useState<{ readonly ownerKey: string; readonly drafts: readonly RequestDraft[]; readonly error: LaterWords | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(0)
  const settled = useSyncExternalStore(answers.subscribe, () => answers.recoverySnapshot(owner, live))
  useEffect(() => bridge?.onChanged?.(changed => {
    if (requestDraftOwnerKey(changed) === ownerKey) setAttempt(value => value + 1)
  }), [bridge, ownerKey])
  useEffect(() => {
    if (!bridge?.list) return
    const call = ++latest.current
    const [kind, providerId, ownerId] = JSON.parse(ownerKey) as [RequestDraftOwner['kind'], RequestDraftOwner['providerId'], string]
    bridge.list({ kind, ownerId, providerId }).then(
      drafts => { if (latest.current === call) setResult({ ownerKey, drafts, error: null }) },
      // A failed re-read keeps what was already shown for this owner; the text is never dropped on an error.
      (error: unknown) => { if (latest.current === call) setResult(previous => ({ ownerKey, drafts: previous?.ownerKey === ownerKey ? previous.drafts : [], error: readable(error, LIST_ERROR) })) })
  }, [bridge, ownerKey, observed, attempt, settled])
  const reload = useCallback(() => setAttempt(value => value + 1), [])
  const discard = useCallback(async (draft: RequestDraft): Promise<LaterWords | null> => {
    if (!bridge?.discard) return DISCARD_ERROR
    try {
      // False means it was already gone. A stale revision rejects, and the re-read shows the newer content.
      await bridge.discard({ target: draft.target, revision: draft.revision })
      return null
    } catch (error) { return readable(error, DISCARD_ERROR) } finally { reload() }
  }, [bridge, reload])
  const current = result?.ownerKey === ownerKey ? result : null
  return { drafts: (current?.drafts ?? []).filter(draft => hasContent(draft) && !renderedLive(draft, live)), error: current?.error ?? null, reload, discard }
}

export interface RequestDraftRecoveryProps {
  readonly owner: RequestDraftOwner
  /** The requests this owner's live cards render; a matching saved form stays in its card. */
  readonly live: readonly AgentRequest[]
  readonly observation: RecoveryObservation
  /** Changes whenever the owner's snapshot may have changed what main keeps. */
  readonly observed: string
  readonly provider: string
  readonly bridge?: RequestDraftBridge | undefined
  readonly answers?: RequestAnswerStore
}

/**
 * Answers saved for questions the provider no longer shows, typically after a restart in which the native client
 * closed them. They can be read, copied or discarded. Nothing here sends, rechecks, releases a hold or recreates a request.
 */
export function RequestDraftRecovery({ owner, live, observation, observed, provider, bridge, answers }: RequestDraftRecoveryProps): ReactNode {
  // Its kept words are read when shown, so a change of language draws the list again.
  useInterfaceLanguageState()
  const model = useRequestDraftRecovery(owner, live, observed, bridge, answers)
  const container = useRef<HTMLDivElement>(null)
  /** Where keyboard focus goes once a discarded answer leaves the list. */
  const refocus = useRef<{ readonly removed: string; readonly next: string | null; readonly scroller: HTMLElement | null } | null>(null)
  const keys = model.drafts.map(savedAnswerKey)
  const keysSignature = JSON.stringify(keys)
  useLayoutEffect(() => {
    const pending = refocus.current
    if (!pending || keys.includes(pending.removed)) return
    refocus.current = null
    // Only a focus that was lost with the removed answer moves; a user who went elsewhere keeps their place.
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return
    const next = [...container.current?.querySelectorAll<HTMLElement>('[data-recovery-key]') ?? []].find(item => item.dataset.recoveryKey === pending.next)
    ;(next?.querySelector<HTMLElement>('button') ?? pending.scroller)?.focus()
  }, [keysSignature])
  const liveAnswer = live.some(request => requestDraftQuestions(request).length > 0)
  // An unreadable store is already explained inside a live card; elsewhere it is said once here.
  const listError = model.error && !liveAnswer
    ? <div className="agent-request request-recovery request-recovery--error" role="alert"><p className="agent-request__error tt-paragraph">{shownWords(model.error)}</p>
      <div className="agent-request__actions"><Button variant="secondary" onClick={model.reload}><Trans>Try again</Trans></Button></div></div> : null
  if (!listError && model.drafts.length === 0) return null
  return <div ref={container} className="request-recovery-list">
    {listError}
    {model.drafts.map((draft, index) => <SavedAnswer key={keys[index]} draftKey={keys[index]!} draft={draft}
      changed={live.some(request => request.id === draft.target.requestId)} observation={observation} provider={provider}
      onDiscard={async (element) => {
        const failure = await model.discard(draft)
        if (failure === null) refocus.current = { removed: keys[index]!, next: keys[index + 1] ?? keys[index - 1] ?? null, scroller: element.closest<HTMLElement>('[role="log"]') }
        return failure
      }} />)}
  </div>
}

/** One sentence: whether the answer went anywhere, and what Sotto can honestly say about its question now. */
function recoveryExplanation(held: boolean, changed: boolean, observation: RecoveryObservation, provider: string): string {
  // The title already says a held answer is unconfirmed; the sentence gives its consequence.
  const delivery = held ? i18n._(msg`The answer may have arrived, so Sotto won’t send it again.`) : i18n._(msg`This answer was not sent.`)
  if (observation === 'disconnected') return i18n._(msg({ message: `${delivery} Reconnect ${provider} to see whether its question is still open.`, comment: '{delivery} says whether the answer was sent; {provider} is a provider name.' }))
  if (observation === 'loading') return i18n._(msg({ message: `${delivery} Checking whether ${provider} still shows its question…`, comment: '{delivery} says whether the answer was sent; {provider} is a provider name.' }))
  if (observation === 'unavailable') return i18n._(msg({ message: `${delivery} Sotto can’t tell whether ${provider} still shows its question until this conversation loads.`, comment: '{delivery} says whether the answer was sent; {provider} is a provider name.' }))
  return changed
    ? i18n._(msg({ message: `${provider} changed this question. ${delivery}`, comment: '{delivery} says whether the answer was sent; {provider} is a provider name.' }))
    : i18n._(msg({ message: `${provider} no longer shows this question. ${delivery}`, comment: '{delivery} says whether the answer was sent; {provider} is a provider name.' }))
}

function SavedAnswer({ draft, draftKey, changed, observation, provider, onDiscard }: {
  readonly draft: RequestDraft; readonly draftKey: string; readonly changed: boolean; readonly observation: RecoveryObservation; readonly provider: string
  readonly onDiscard: (element: HTMLElement) => Promise<LaterWords | null>
}): ReactNode {
  const { t } = useLingui()
  const [confirming, setConfirming] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [error, setError] = useState<LaterWords | null>(null)
  const [copied, showCopied] = useTransientFlag<'copied'>()
  const root = useRef<HTMLElement>(null)
  const keep = useRef<HTMLButtonElement>(null)
  const discardButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const titleId = useId()

  useLayoutEffect(() => {
    if (confirming) keep.current?.focus()
    else if (returnFocus.current) { returnFocus.current = false; discardButton.current?.focus() }
  }, [confirming])
  const cancel = (): void => { returnFocus.current = true; setConfirming(false) }
  const copy = (): void => {
    setError(null)
    void writeClipboard(savedAnswerClipboard(draft)).then(() => showCopied('copied'), () => setError(COPY_ERROR))
  }
  const discard = (): void => {
    if (discarding || !root.current) return
    setDiscarding(true)
    setError(null)
    void onDiscard(root.current).then(failure => {
      if (failure === null || !root.current?.isConnected) return
      setError(failure)
      setDiscarding(false)
      returnFocus.current = true
      setConfirming(false)
    })
  }

  return <section ref={root} className="agent-request request-recovery" data-recovery-key={draftKey} data-held={draft.held || undefined} aria-labelledby={titleId}
    onKeyDown={(event: KeyboardEvent) => { if (confirming && !discarding && event.key === 'Escape') { event.preventDefault(); cancel() } }}>
    <div className="agent-request__head"><strong id={titleId}>{draft.held ? t`Unconfirmed answer` : t`Saved answer`}</strong></div>
    <p className="request-recovery__why tt-paragraph">{recoveryExplanation(draft.held, changed, observation, provider)}</p>
    <dl className="request-recovery__answers">
      {draft.target.questions.map(question => {
        const answer = savedAnswerText(question, draft.selections[question.id])
        return <div key={question.id} data-empty={answer === null || undefined}>
          <dt>{question.question}</dt>
          <dd>{answer ?? t(NO_ANSWER)}</dd>
        </div>
      })}
    </dl>
    {confirming ? <div className="request-recovery__confirm" role="group" aria-labelledby={`${titleId}-confirm`}>
      <p className="tt-paragraph" id={`${titleId}-confirm`}>{draft.held ? t`Discard Sotto’s copy? This doesn’t cancel or resend the answer.` : t`Discard this answer? It can’t be restored.`}</p>
      <div className="agent-request__actions">
        <Button ref={keep} variant="secondary" disabled={discarding} onClick={cancel}><Trans comment="Keeps a saved answer instead of discarding it.">Keep</Trans></Button>
        <Button variant="danger" disabled={discarding} onClick={discard}>{discarding ? t`Discarding…` : t`Discard answer`}</Button>
      </div>
    </div> : <div className="request-recovery__actions">
      <div className="agent-request__actions">
        <Button variant="secondary" onClick={copy}><Trans>Copy answer</Trans></Button>
        <Button ref={discardButton} variant="ghost" onClick={() => { setError(null); setConfirming(true) }}><Trans comment="Discards a saved answer; asks first.">Discard</Trans></Button>
      </div>
      <span className="agent-request__status" role="status">{copied ? t`Copied` : null}</span>
    </div>}
    {error ? <p className="agent-request__error tt-paragraph" role="alert">{shownWords(error)}</p> : null}
  </section>
}
