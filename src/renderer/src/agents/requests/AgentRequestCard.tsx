import React, { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentRequest } from '../../../../shared/agents'
import { Button } from '../../components/Button'
import {
  EMPTY_SELECTION, isAnswered, legacyPermissionAnswer, permissionAnswer, permissionSummary, pickOption, pickOther,
  requestAnswerStore, requestMode, structuredAnswer, textOnly, useRequestEntry,
  type RequestAnswer, type RequestAnswerStore, type StructuredQuestion, type SubmitOutcome,
} from './requestAnswers'
import './requests.css'

export interface AgentRequestCardProps {
  /** The thread or personal chat that owns the request; answers always carry this and `request.id`. */
  readonly ownerId: string
  readonly ownerTitle: string
  readonly request: AgentRequest
  /** Why the choices cannot be used right now (disconnected, busy); null when they can. */
  readonly blocked: string | null
  readonly onSubmit: (answer: RequestAnswer) => Promise<SubmitOutcome>
  /** Re-reads the owner from its provider; resolves true when the read succeeded. */
  readonly onCheck?: () => Promise<boolean>
  /** A free-text question with no structure is answered in the composer. */
  readonly onWriteAnswer?: () => void
  /** A line under the choices, such as the voice phrases. */
  readonly hint?: ReactNode
  readonly store?: RequestAnswerStore
}

/**
 * One pending question or approval, answered here and nowhere else. It shows exactly the choices the provider
 * offered, sends one answer for this request's own ID, and holds instead of resending when delivery is unknown.
 */
export function AgentRequestCard({ ownerId, ownerTitle, request, blocked, onSubmit, onCheck, onWriteAnswer, hint, store = requestAnswerStore }: AgentRequestCardProps): ReactNode {
  const entry = useRequestEntry(ownerId, request.id, store)
  const [checking, setChecking] = useState(false)
  const baseId = useId()
  const mode = requestMode(request)
  const permission = mode === 'permission'
  const uncertain = request.delivery === 'uncertain' || entry.phase === 'unconfirmed'
  const locked = uncertain || entry.phase === 'sending' || entry.phase === 'sent'
  const disabled = locked || blocked !== null
  const titleId = `${baseId}-title`
  const send = (choice: string | null, answer: RequestAnswer): void => {
    if (disabled) return
    void store.submit(ownerId, request.id, choice, () => onSubmit(answer))
  }
  const check = (): void => {
    if (!onCheck || checking) return
    setChecking(true)
    void onCheck().then(ok => { if (ok) store.release(ownerId, request.id) }, () => undefined).finally(() => setChecking(false))
  }
  const summary = permission ? permissionSummary(request) : null
  const questions = request.questions ?? []
  const answer = mode === 'structured' ? structuredAnswer(questions, entry.selections) : null
  const remaining = questions.filter(question => !isAnswered(question, entry.selections[question.id])).length

  const status = request.delivery === 'uncertain'
    ? <div className="agent-request__hold" role="status"><p>Your answer was sent, but its arrival could not be confirmed. Sotto won’t send it again.</p>
      {onCheck ? <Button variant="secondary" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check again'}</Button> : null}</div>
    : entry.phase === 'unconfirmed'
      ? <div className="agent-request__hold" role="status"><p>Sotto could not confirm this answer. It may have arrived, so it won’t be sent again until you check.</p>
        {onCheck ? <Button variant="secondary" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check again'}</Button> : null}</div>
      : entry.phase === 'failed' ? <p className="agent-request__error" role="alert">{entry.error}</p>
        : entry.phase === 'sending' ? <p className="agent-request__status" role="status">Sending…</p>
          : entry.phase === 'sent' ? <p className="agent-request__status" role="status">Answer sent.</p>
            : blocked !== null ? <p className="agent-request__status">{blocked}</p> : null

  return <section className="agent-request" data-kind={request.kind} data-phase={entry.phase} data-uncertain={uncertain || undefined}
    aria-labelledby={titleId} aria-busy={entry.phase === 'sending' || undefined}>
    <span className="tt-visually-hidden">{permission ? `Permission request for ${ownerTitle}` : `Question from ${ownerTitle}`}</span>
    {summary ? <>
      <div className="agent-request__head"><strong id={titleId}>{summary.title}</strong>
        {request.context?.toolName ? <span className="agent-request__tag">{request.context.toolName}</span> : null}</div>
      {summary.command ? <pre className="agent-request__command"><code>{summary.command}</code></pre> : null}
      {summary.cwd ? <p className="agent-request__cwd">in <code>{summary.cwd}</code></p> : null}
      {summary.details ? <pre className="agent-request__details">{summary.details}</pre> : null}
      <PermissionActions request={request} disabled={disabled} pressed={entry.choice} onChoose={send} />
    </> : mode === 'structured' ? <form className="agent-request__form" noValidate onSubmit={(event: FormEvent) => {
      event.preventDefault()
      if (answer) send(null, answer)
    }}>
      <div className="agent-request__head"><strong id={titleId}>{questions.length === 1 ? 'Question' : `${questions.length} questions`}</strong></div>
      {questions.map((question, index) => <QuestionField key={question.id} name={`${baseId}-q${index}`} question={question}
        selection={entry.selections[question.id] ?? EMPTY_SELECTION} disabled={disabled}
        onChange={selection => store.select(ownerId, request.id, question.id, selection)}
        onSubmitKey={() => { if (answer) send(null, answer) }} />)}
      <div className="agent-request__footer">
        <span className="agent-request__count" aria-live="polite">{remaining === 0 ? 'Ready to send' : remaining === questions.length ? '' : `${remaining} left to answer`}</span>
        <Button type="submit" disabled={disabled || answer === null}>{entry.phase === 'sending' ? 'Sending…' : questions.length === 1 ? 'Send answer' : 'Send answers'}</Button>
      </div>
    </form> : <>
      <div className="agent-request__head"><strong id={titleId}>Question</strong></div>
      <p className="agent-request__text">{request.text}</p>
      <div className="agent-request__actions">
        {mode === 'legacy-options'
          ? request.options.map(option => <Button key={option.id} variant="secondary" disabled={disabled} aria-pressed={entry.choice === option.id || undefined}
            onClick={() => send(option.id, { answer: option.id })}>{option.label}</Button>)
          : onWriteAnswer ? <Button variant="secondary" disabled={locked} onClick={onWriteAnswer}>Write an answer</Button> : null}
      </div>
    </>}
    {status}
    {hint && !locked ? <span className="agent-request__hint">{hint}</span> : null}
  </section>
}

function PermissionActions({ request, disabled, pressed, onChoose }: {
  readonly request: AgentRequest; readonly disabled: boolean; readonly pressed: string | null
  readonly onChoose: (choice: string, answer: RequestAnswer) => void
}): ReactNode {
  const choices = request.permissionChoices
  if (choices && choices.length > 0) {
    const described = choices.filter(choice => choice.description)
    // The provider's order is kept; the single-use approval is the one emphasized action.
    const primary = choices.find(choice => choice.kind === 'allow-once')?.id
    return <>
      <div className="agent-request__actions">
        {choices.map(choice => <Button key={choice.id} variant={choice.id === primary ? 'primary' : 'secondary'} disabled={disabled}
          aria-pressed={pressed === choice.id || undefined} data-choice-kind={choice.kind}
          onClick={() => onChoose(choice.id, permissionAnswer(choice))}>{choice.label}</Button>)}
      </div>
      {described.length > 0 ? <dl className="agent-request__choices">{described.map(choice => <div key={choice.id}><dt>{choice.label}</dt><dd>{choice.description}</dd></div>)}</dl> : null}
    </>
  }
  return <div className="agent-request__actions">
    <Button variant="secondary" disabled={disabled} aria-pressed={pressed === 'deny' || undefined} onClick={() => onChoose('deny', legacyPermissionAnswer(false))}>Deny</Button>
    <Button disabled={disabled} aria-pressed={pressed === 'allow' || undefined} onClick={() => onChoose('allow', legacyPermissionAnswer(true))}>Allow</Button>
  </div>
}

function QuestionField({ name, question, selection, disabled, onChange, onSubmitKey }: {
  readonly name: string; readonly question: StructuredQuestion; readonly selection: typeof EMPTY_SELECTION
  readonly disabled: boolean; readonly onChange: (selection: typeof EMPTY_SELECTION) => void; readonly onSubmitKey: () => void
}): ReactNode {
  const type = question.multiSelect ? 'checkbox' : 'radio'
  const onlyText = textOnly(question)
  const textId = `${name}-text`
  const textKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    onSubmitKey()
  }
  return <fieldset className="agent-request__question" disabled={disabled}>
    <legend>{question.header ? <span className="agent-request__tag">{question.header}</span> : null}<span className="agent-request__prompt">{question.question}</span></legend>
    {question.multiSelect && !onlyText ? <span className="agent-request__note">Choose any that apply.</span> : null}
    {onlyText ? question.allowFreeText
      ? <textarea id={textId} className="agent-request__input" rows={2} aria-label={question.header ?? question.question} value={selection.text}
        placeholder="Your answer" onKeyDown={textKey} onChange={event => onChange({ ...selection, text: event.target.value })} />
      : <p className="agent-request__note">This question has no choices Sotto can show.</p>
      : <div className="agent-request__options">
        {question.options.map(option => {
          const checked = selection.optionIds.includes(option.id)
          return <label key={option.id} className="agent-request__option" data-checked={checked || undefined}>
            <input type={type} name={name} value={option.id} checked={checked}
              onChange={event => onChange(pickOption(question, selection, option.id, event.target.checked))} />
            <span><span className="agent-request__label">{option.label}</span>
              {option.description ? <small>{option.description}</small> : null}
              {option.preview && checked ? <pre className="agent-request__preview">{option.preview}</pre> : null}</span>
          </label>
        })}
        {question.allowFreeText ? <div className="agent-request__option agent-request__option--other" data-checked={selection.other || undefined}>
          <input id={`${name}-other`} type={type} name={name} value="" checked={selection.other}
            onChange={event => {
              onChange(pickOther(question, selection, event.target.checked))
              if (event.target.checked) requestAnimationFrame(() => document.getElementById(textId)?.focus())
            }} />
          <span><label className="agent-request__label" htmlFor={`${name}-other`}>Other</label>
            {selection.other ? <textarea id={textId} className="agent-request__input" rows={1} aria-label={`Other answer to: ${question.question}`} value={selection.text}
              placeholder="Your answer" onKeyDown={textKey} onChange={event => onChange({ ...selection, text: event.target.value })} /> : null}</span>
        </div> : null}
      </div>}
  </fieldset>
}
