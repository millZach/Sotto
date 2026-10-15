import React, { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AppWindow, ArrowUpRight, ChevronDown, ChevronUp, Link2 } from 'lucide-react'
import type { AgentRequest, QuestionPage } from '../../../../shared/agents'
import { requestDraftQuestions, type RequestDraftOwner } from '../../../../shared/requestDrafts'
import { Button } from '../../components/Button'
import { LinkedText } from './LinkedText'
import { linkPlace, webLinks } from './messageLinks'
import {
  answerProgress, blocksSending, EMPTY_SELECTION, isRequired, isUnavailable, legacyPermissionAnswer, permissionAnswer,
  permissionSummary, pickOption, pickOther, requestAnswerOwnerKey, requestAnswerStore, requestMode, structuredAnswer, textOnly, useRequestEntry,
  type RequestAnswer, type RequestAnswerStore, type StructuredQuestion, type SubmitOutcome,
} from './requestAnswers'
import './requests.css'

export interface AgentRequestCardProps {
  /** The thread that owns the request; answers always carry this and `request.id`. */
  readonly ownerId: string
  readonly ownerTitle: string
  readonly draftOwner?: RequestDraftOwner
  readonly request: AgentRequest
  /** Why the choices cannot be used right now (disconnected, busy); null when they can. */
  readonly blocked: string | null
  readonly onSubmit: (answer: RequestAnswer) => Promise<SubmitOutcome>
  /** Re-reads the owner from its provider; resolves true when the read succeeded. */
  readonly onCheck?: () => Promise<boolean>
  /** A free-text question with no structure is answered in the composer. */
  readonly onWriteAnswer?: () => void
  /** A line under the choices, such as the voice phrases. */
  readonly store?: RequestAnswerStore
  /** Thread questions sit above the composer; other hosts keep their existing placement. */
  readonly placement?: 'composer' | undefined
  /** The web links in the agent's message just before a question, which the card covers once it docks. Those the card
   *  already shows as links in the request's own words are left out. */
  readonly messageLinks?: readonly string[]
}

/**
 * One pending question or approval, answered here and nowhere else. It shows exactly the choices the provider
 * offered, sends one answer for this request's own ID, and holds instead of resending when delivery is unknown.
 */
export function AgentRequestCard({ ownerId, ownerTitle, draftOwner, request, blocked, onSubmit, onCheck, onWriteAnswer, placement, messageLinks = [], store = requestAnswerStore }: AgentRequestCardProps): ReactNode {
  const draftQuestions = requestDraftQuestions(request)
  const entryOwner = requestAnswerOwnerKey(ownerId, request, draftOwner)
  const entry = useRequestEntry(entryOwner, request.id, store, draftOwner && draftQuestions.length > 0
    ? { ...draftOwner, requestId: request.id, questions: draftQuestions } : undefined,
    request.delivery === 'uncertain' ? 'uncertain' : request.answerRetryReady === true ? 'retry-ready' : undefined)
  const [checking, setChecking] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const baseId = useId()
  const mode = requestMode(request)
  const linked = linkedWords(request, mode)
  const pages = request.pages ?? []
  // A loopback address that is one of the question's pages opens as that page, and has no row of its own.
  const served = new Set(pages.filter(page => page.kind === 'server').map(page => page.name))
  const rows = messageLinks.filter(url => !linked.has(url) && !served.has(new URL(url).host))
  const permission = mode === 'permission'
  const docked = placement === 'composer' && !permission
  const nativeUncertain = request.delivery === 'uncertain'
  const uncertain = nativeUncertain || entry.phase === 'unconfirmed'
  const locked = uncertain || entry.phase === 'sending' || entry.phase === 'sent'
  const disabled = locked || blocked !== null || entry.save === 'loading'
  const titleId = `${baseId}-title`
  const send = (choice: string | null, answer: RequestAnswer): void => {
    if (disabled || entry.save === 'unsaved') return
    void store.submit(entryOwner, request.id, choice, () => onSubmit(answer))
  }
  const check = (): void => {
    if (!onCheck || checking) return
    setChecking(true)
    void store.release(entryOwner, request.id, onCheck).finally(() => setChecking(false))
  }
  const summary = permission ? permissionSummary(request) : null
  const questions = request.questions ?? []
  const answer = mode === 'structured' ? structuredAnswer(questions, entry.selections) : null
  const remaining = questions.filter(question => blocksSending(question, entry.selections[question.id])).length
  const touched = questions.some(question => answerProgress(question, entry.selections[question.id]) !== 'empty')
  const needsProvider = questions.some(question => isRequired(question) && isUnavailable(question))
  const legacySelection = entry.selections[request.id] ?? EMPTY_SELECTION
  const legacyChoice = request.options.find(option => legacySelection.optionIds.includes(option.id))

  const status = nativeUncertain
    ? <div className="agent-request__hold" role="status"><p>Your answer was sent, but its arrival could not be confirmed. Sotto won’t send it again.</p>
      {onCheck ? <Button variant="secondary" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check again'}</Button> : null}</div>
    : entry.phase === 'unconfirmed'
      ? <div className="agent-request__hold" role="status"><p>{entry.save === 'unsaved' && entry.error ? entry.error
        : 'Sotto could not confirm this answer. It may have arrived, so it won’t be sent again until you check.'}</p>
        {onCheck ? <Button variant="secondary" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check again'}</Button> : null}</div>
      : entry.phase === 'failed' ? <p className="agent-request__error" role="alert">{entry.error}</p>
        : entry.phase === 'sending' ? <p className="agent-request__status" role="status">Sending…</p>
          : entry.phase === 'sent' ? <p className="agent-request__status" role="status">Answer sent.</p>
            : blocked !== null ? <p className="agent-request__status">{blocked}</p> : null

  return <section className="agent-request" data-kind={request.kind} data-phase={entry.phase} data-save={entry.save} data-uncertain={uncertain || undefined}
    data-placement={docked ? 'composer' : undefined} data-collapsed={docked && collapsed || undefined}
    aria-labelledby={docked && collapsed ? `${baseId}-collapsed` : titleId} aria-busy={entry.phase === 'sending' || undefined}
    onKeyDown={event => {
      if (docked && !collapsed && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setCollapsed(true)
        toggle.current?.focus()
      }
    }}>
    <span className="tt-visually-hidden">{permission ? `Permission request for ${ownerTitle}` : `Question from ${ownerTitle}`}</span>
    {docked ? <div className="agent-request__toggle-row">
      {collapsed ? <span id={`${baseId}-collapsed`} className="agent-request__collapsed-title">{questions.length > 1 ? `${questions.length} questions waiting` : questions[0]?.question ?? request.text}</span> : null}
      <button ref={toggle} type="button" className="agent-request__toggle tt-focusable" aria-label={collapsed ? 'Show question' : 'Collapse question'}
        aria-expanded={!collapsed} aria-controls={`${baseId}-body`} onClick={() => setCollapsed(value => !value)}>
        {collapsed ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      </button>
    </div> : null}
    <div id={`${baseId}-body`} className="agent-request__body" hidden={docked && collapsed}>
      {summary ? <>
        <div className="agent-request__head"><strong id={titleId}>{summary.title}</strong>
          {request.context?.toolName ? <span className="agent-request__tag">{request.context.toolName}</span> : null}</div>
        {summary.command ? <pre className="agent-request__command"><code>{summary.command}</code></pre> : null}
        {summary.cwd ? <p className="agent-request__cwd">in <code>{summary.cwd}</code></p> : null}
        {summary.details ? <pre className="agent-request__details">{summary.details}</pre> : null}
        <PermissionActions request={request} disabled={disabled} pressed={entry.choice} onChoose={send} />
      </> : mode === 'structured' ? <form className="agent-request__form" noValidate onKeyDown={event => {
        // Enter on a radio must not trigger the form's implicit submit. The send button still works by keyboard.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault()
      }} onSubmit={(event: FormEvent) => {
        event.preventDefault()
        if (answer) send(null, answer)
      }}>
        <div className={`agent-request__head${docked && questions.length === 1 ? ' tt-visually-hidden' : ''}`}><strong id={titleId}>{questions.length === 1 ? 'Question' : `${questions.length} questions`}</strong>
          {request.context?.toolName ? <span className="agent-request__tag">{request.context.toolName}</span> : null}</div>
        <FormContext request={request} />
        {questions.map((question, index) => <QuestionField key={question.id} name={`${baseId}-q${index}`} question={question} links={index === 0 ? rows : []} pages={index === 0 ? pages : []} owner={{ threadId: ownerId, requestId: request.id }}
          selection={entry.selections[question.id] ?? EMPTY_SELECTION} disabled={disabled}
          onChange={selection => store.select(entryOwner, request.id, question.id, selection)} />)}
        <div className="agent-request__footer">
          <span className="agent-request__count" aria-live="polite">{needsProvider ? 'Finish this form in the provider’s app.'
            : remaining === 0 ? 'Ready to send' : touched ? `${remaining} left to answer` : 'Choose an answer'}</span>
          <Button type="submit" disabled={disabled || entry.save === 'unsaved' || answer === null}>{entry.phase === 'sending' ? 'Sending…' : questions.length === 1 ? 'Send answer' : 'Send answers'}</Button>
        </div>
      </form> : <>
        <div className="agent-request__head"><strong id={titleId}>Question</strong></div>
        <p className="agent-request__text"><LinkedText text={request.text} /></p>
        <MessageLinks links={rows} pages={pages} owner={{ threadId: ownerId, requestId: request.id }} />
        {mode === 'legacy-options' ? <>
          <fieldset className="agent-request__question" disabled={disabled}>
            <legend className="tt-visually-hidden">{request.text}</legend>
            <div className="agent-request__options">{request.options.map(option => <label key={option.id} className="agent-request__option" data-checked={legacyChoice?.id === option.id || undefined}>
              <input type="radio" name={`${baseId}-legacy`} value={option.id} checked={legacyChoice?.id === option.id}
                onChange={() => store.select(entryOwner, request.id, request.id, { ...legacySelection, optionIds: [option.id] })} />
              <span><OptionLabel label={option.label} /></span>
            </label>)}</div>
          </fieldset>
          <div className="agent-request__footer"><Button disabled={disabled || entry.save === 'unsaved' || !legacyChoice}
            onClick={() => { if (legacyChoice) send(legacyChoice.id, { answer: legacyChoice.id }) }}>Send answer</Button></div>
        </> : <div className="agent-request__actions">{onWriteAnswer ? <Button variant="secondary" disabled={locked} onClick={onWriteAnswer}>Write an answer</Button> : null}</div>}
      </>}
      {status}
      {entry.saveError ? <div className="agent-request__error" role="alert"><p>{entry.saveError}</p>
        {!locked ? <Button variant="secondary" onClick={() => { void store.flush(entryOwner, request.id) }}>Save again</Button> : null}</div>
        : draftQuestions.length > 0 && !locked ? <span className="agent-request__status" role="status">{entry.save === 'loading' ? 'Loading saved answer…'
          : entry.save === 'saving' ? 'Saving answer…' : entry.revision > 0 ? 'Answer draft saved.' : ''}</span> : null}
    </div>
  </section>
}

function PermissionActions({ request, disabled, pressed, onChoose }: {
  readonly request: AgentRequest; readonly disabled: boolean; readonly pressed: string | null
  readonly onChoose: (choice: string, answer: RequestAnswer) => void
}): ReactNode {
  const choices = request.permissionChoices
  // Only absent choices mean a legacy Allow/Deny request. An empty list is the provider offering nothing Sotto can send.
  if (choices && choices.length === 0) return <p className="agent-request__fallback">Sotto has no choice it can send for this request. Answer it in the provider’s app.</p>
  if (choices) {
    const described = choices.filter(choice => choice.description)
    // The provider's order is kept; the single-use approval is the one emphasized action.
    const primary = choices.find(choice => choice.kind === 'allow-once')?.id
    return <>
      <div className="agent-request__actions">
        {choices.map(choice => <Button key={choice.id} variant={choice.id === primary ? 'primary' : 'secondary'} disabled={disabled}
          aria-pressed={pressed === choice.id || undefined} data-choice-kind={choice.kind}
          onClick={() => onChoose(choice.id, permissionAnswer(choice))}>{choice.label}</Button>)}
      </div>
      {described.length > 0 ? <dl className="agent-request__choices">{described.map(choice => <div key={choice.id}><dt>{choice.label}</dt><dd><LinkedText text={choice.description!} /></dd></div>)}</dl> : null}
    </>
  }
  return <div className="agent-request__actions">
    <Button variant="secondary" disabled={disabled} aria-pressed={pressed === 'deny' || undefined} onClick={() => onChoose('deny', legacyPermissionAnswer(false))}>Deny</Button>
    <Button disabled={disabled} aria-pressed={pressed === 'allow' || undefined} onClick={() => onChoose('allow', legacyPermissionAnswer(true))}>Allow</Button>
  </div>
}

/** Only a recommendation present in the provider's label is called one. IDs and answers stay untouched. */
function OptionLabel({ label }: { readonly label: string }): ReactNode {
  const recommendation = /\s*\(recommended\)\s*$/iu.exec(label)
  return <span className="agent-request__label"><LinkedText text={recommendation ? label.slice(0, recommendation.index) : label} />
    {recommendation ? <> <span className="agent-request__recommended">(recommended)</span></> : null}</span>
}

/**
 * Every web address the card shows as a link in the request's own words: a structured form's explanation when it says
 * more than its questions, each question and each choice; otherwise the request's text and its choices. A header is a
 * plain tag and a hidden explanation is not shown, so an address only there is no link and a row still carries it.
 */
function linkedWords(request: AgentRequest, mode: ReturnType<typeof requestMode>): Set<string> {
  const texts = mode === 'structured'
    ? [requestExplanation(request) ?? '', ...(request.questions ?? []).flatMap(question => [question.question, ...question.options.flatMap(option => [option.label, option.description ?? ''])])]
    : [request.text, ...request.options.map(option => option.label)]
  return new Set(texts.flatMap(webLinks))
}

/** The request a row's page belongs to, which main opens it through. */
interface PageOwner { readonly threadId: string; readonly requestId: string }

/** What a row says when its page could not be opened. */
const PAGE_OPEN_FAILURES = {
  gone: 'That page is no longer there. The file was moved or deleted, or the question was answered. Nothing else changed. Ask the agent where the page is now.',
  unavailable: 'Sotto could not open that page. Nothing else changed. Try again.',
} as const

/**
 * The pages Sotto found for a question (ADR-0084), then the links from the agent's message before it, each a row of its
 * own between the question and its choices, as the iPhone's question sheet shows them. A row is a link, not a choice:
 * pressing it opens the page in this computer's browser, picks nothing, and works while the choices cannot be used. A
 * page opens through main, by the request it is on and its token: a file as itself, a loopback page and a remote
 * host's page at their address.
 */
function MessageLinks({ links, pages = [], owner }: { readonly links: readonly string[]; readonly pages?: readonly QuestionPage[]; readonly owner?: PageOwner | undefined }): ReactNode {
  const [failure, setFailure] = useState<keyof typeof PAGE_OPEN_FAILURES | null>(null)
  if (links.length === 0 && pages.length === 0) return null
  const open = (page: QuestionPage): void => {
    if (!owner) return
    setFailure(null)
    void (window.sotto?.openQuestionPage?.({ ...owner, token: page.token }) ?? Promise.resolve({ ok: false as const, reason: 'unavailable' as const }))
      .then(result => setFailure(result.ok ? null : result.reason), () => setFailure('unavailable'))
  }
  return <div className="agent-request__link-rows" role="group" aria-label={pages.length ? 'Pages and links for this question' : 'Links from the message above'}>
    {/* A link rather than a button: the question's fieldset disables its buttons while the choices cannot be used. */}
    {owner ? pages.map(page => <a key={page.token} role="link" tabIndex={0} className="agent-request__link-row tt-focusable" title={page.name} aria-label={`Open the prototype, ${page.name}`}
      onClick={event => { event.preventDefault(); event.stopPropagation(); open(page) }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); open(page) } }}>
      <AppWindow size={16} aria-hidden="true" />
      <span><strong>Open the prototype</strong><small>{page.name}</small></span>
      <ArrowUpRight size={16} aria-hidden="true" />
    </a>) : null}
    {links.map(url => {
      const place = linkPlace(url)
      return <a key={url} className="agent-request__link-row tt-focusable" href={url} rel="noopener noreferrer" target="_blank" title={url} aria-label={`Open the link, ${place}`}
        onClick={event => { event.preventDefault(); event.stopPropagation(); void window.sotto?.openExternalLink?.(url) }}
        onAuxClick={event => event.preventDefault()}>
        <Link2 size={16} aria-hidden="true" />
        <span><strong>Open the link</strong><small>{place}</small></span>
        <ArrowUpRight size={16} aria-hidden="true" />
      </a>
    })}
    {failure ? <p className="agent-request__link-failure" role="status">{PAGE_OPEN_FAILURES[failure]}</p> : null}
  </div>
}

function QuestionField({ name, question, selection, disabled, onChange, links = [], pages = [], owner }: {
  readonly name: string; readonly question: StructuredQuestion; readonly selection: typeof EMPTY_SELECTION
  readonly disabled: boolean; readonly onChange: (selection: typeof EMPTY_SELECTION) => void
  /** The message's links, shown under this question's words: the first question's, when a form has several. */
  readonly links?: readonly string[]
  /** The question's pages, shown with the links: the first question's, when a form has several (ADR-0084). */
  readonly pages?: readonly QuestionPage[]
  readonly owner?: PageOwner | undefined
}): ReactNode {
  const type = question.multiSelect ? 'checkbox' : 'radio'
  const onlyText = textOnly(question)
  const optional = !isRequired(question)
  const field = useRef<HTMLFieldSetElement>(null)
  // Radios cannot be unchecked, so an optional single choice gets its own way back to unanswered.
  const clearable = optional && !question.multiSelect && !onlyText && !isUnavailable(question) && answerProgress(question, selection) !== 'empty'
  const clear = (): void => {
    field.current?.querySelector<HTMLInputElement>('input')?.focus()
    onChange(EMPTY_SELECTION)
  }
  const textId = `${name}-text`
  return <fieldset ref={field} className="agent-request__question" disabled={disabled}>
    <legend>{question.header ? <span className="agent-request__tag">{question.header}</span> : null}<span className="agent-request__prompt"><LinkedText text={question.question} /></span>
      {optional ? <span className="agent-request__optional">Optional</span> : null}</legend>
    <MessageLinks links={links} pages={pages} owner={owner} />
    {isUnavailable(question) ? <p className="agent-request__unavailable" data-required={!optional || undefined}>{question.unavailableReason}</p> : <>
      {question.multiSelect && !onlyText ? <span className="agent-request__note">Choose any that apply.</span> : null}
      {onlyText ? question.allowFreeText
        ? <textarea id={textId} className="agent-request__input" rows={2} aria-label={question.header ?? question.question} value={selection.text}
          placeholder="Type your answer…" onChange={event => onChange({ ...selection, text: event.target.value })} />
        : <p className="agent-request__note">This question has no choices Sotto can show.</p>
        : <div className="agent-request__options">
          {question.options.map(option => {
            const checked = selection.optionIds.includes(option.id)
            return <label key={option.id} className="agent-request__option" data-checked={checked || undefined}>
              <input type={type} name={name} value={option.id} checked={checked}
                onChange={event => onChange(pickOption(question, selection, option.id, event.target.checked))} />
              <span><OptionLabel label={option.label} />
                {option.description ? <small><LinkedText text={option.description} /></small> : null}
                {option.preview && checked ? <pre className="agent-request__preview">{option.preview}</pre> : null}</span>
            </label>
          })}
          {question.allowFreeText ? <div className="agent-request__option agent-request__option--other" data-checked={selection.other || undefined}>
            <input id={`${name}-other`} type={type} name={name} value="" checked={selection.other}
              onChange={event => onChange(pickOther(question, selection, event.target.checked))} />
            <span><label className="agent-request__label" htmlFor={`${name}-other`}>Write my own answer</label>
              <textarea id={textId} className="agent-request__input" rows={2} aria-label={`Other answer to: ${question.question}`} value={selection.text}
                placeholder="Type your answer…" onChange={event => onChange({ ...pickOther(question, selection, true), text: event.target.value })} /></span>
          </div> : null}
        </div>}
      {clearable ? <button type="button" className="agent-request__clear tt-focusable" aria-label={`Clear choice for ${question.question}`} onClick={clear}>Clear choice</button> : null}
    </>}
  </fieldset>
}

/** What a form carries beyond its fields: the provider's own explanation, then the command, folder and details it acts on. */
function FormContext({ request }: { readonly request: AgentRequest }): ReactNode {
  const explanation = requestExplanation(request)
  const context = request.context
  // A native context that serialized to an empty object has nothing to read.
  const details = context?.details?.trim() && !/^\{\s*\}$/u.test(context.details.trim()) ? context.details : null
  return <>
    {explanation ? <p className="agent-request__text"><LinkedText text={explanation} /></p> : null}
    {context?.command ? <pre className="agent-request__command"><code>{context.command}</code></pre> : null}
    {context?.cwd ? <p className="agent-request__cwd">in <code>{context.cwd}</code></p> : null}
    {details ? <pre className="agent-request__details">{details}</pre> : null}
  </>
}

const collapse = (value: string): string => value.replace(/\s+/gu, ' ').trim()

/**
 * A structured request's own explanation, exactly as the provider sent it, or null when its text only restates the
 * questions. Providers without a request-level message fill the text from the question prompts, numbered when there are
 * several and sometimes followed by the choice labels; a Codex form keeps its message there, apart from the fields.
 */
export function requestExplanation(request: AgentRequest): string | null {
  if (!request.text.trim()) return null
  let rest = collapse(request.text)
  const questions = request.questions ?? []
  // Prompts first, longest first, so a prompt containing a shorter one or a choice label is removed whole.
  const pieces = [...questions.map(question => question.question), ...questions.flatMap(question => [question.header ?? '', ...question.options.map(option => option.label)])]
  for (const piece of pieces.map(collapse).filter(Boolean).sort((a, b) => b.length - a.length)) rest = rest.split(piece).join(' ')
  return /^(?:\s|\d+\.|[()/;,])*$/u.test(rest) ? null : request.text
}
