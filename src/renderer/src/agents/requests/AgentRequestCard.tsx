import React, { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMark } from '../../components/marks'
import { AppWindow, ArrowUpRight, ChevronDown, ChevronUp, Link2, Link2Off } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AgentRequest, QuestionPage } from '../../../../shared/agents'
import { requestDraftQuestions, type RequestDraftOwner } from '../../../../shared/requestDrafts'
import { Button } from '../../components/Button'
import { LinkedText } from './LinkedText'
import { MessageContent } from '../MessageContent'
import { linkPlace, webLinks } from './messageLinks'
import { useWebLinkRouter } from '../../tools/webLinks'
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
 * One pending question or approval, answered through the one store every surface sends by (ADR-0135). It shows
 * exactly the choices the provider offered, sends one answer for this request's own ID, and holds instead of
 * resending when delivery is unknown — the sidebar's Needs you entries answer by the same store and no other path.
 */
export function AgentRequestCard({ ownerId, ownerTitle, draftOwner, request, blocked, onSubmit, onCheck, onWriteAnswer, placement, messageLinks = [], store = requestAnswerStore }: AgentRequestCardProps): ReactNode {
  const { t } = useLingui()
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
  const rows = messageLinks.filter(url => !linked.has(url) && !servedAsPage(url, pages))
  const permission = mode === 'permission'
  const docked = placement === 'composer' && !permission
  // The pane wears a question open in its composer, and a request card standing in its transcript.
  useMark('question-open', docked && !collapsed)
  useMark('request', !docked)
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
  const plan = permission ? cursorPlan(request) : null
  const summary = permission && !plan ? permissionSummary(request) : null
  const questions = request.questions ?? []
  const answer = mode === 'structured' ? structuredAnswer(questions, entry.selections) : null
  const remaining = questions.filter(question => blocksSending(question, entry.selections[question.id])).length
  const touched = questions.some(question => answerProgress(question, entry.selections[question.id]) !== 'empty')
  const needsProvider = questions.some(question => isRequired(question) && isUnavailable(question))
  // Every question optional and none answered: sending is skipping, so the button says so (Cursor's questions, ADR-0128).
  const skipping = mode === 'structured' && questions.length > 0 && !touched && questions.every(question => !isRequired(question))
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
    <span className="tt-visually-hidden">{plan ? t`Plan from ${ownerTitle}` : permission ? `Permission request for ${ownerTitle}` : `Question from ${ownerTitle}`}</span>
    {docked ? <div className="agent-request__toggle-row">
      {collapsed ? <span id={`${baseId}-collapsed`} className="agent-request__collapsed-title">{questions.length > 1 ? `${questions.length} questions waiting` : questions[0]?.question ?? request.text}</span> : null}
      <button ref={toggle} type="button" className="agent-request__toggle tt-focusable" aria-label={collapsed ? 'Show question' : 'Collapse question'}
        aria-expanded={!collapsed} aria-controls={`${baseId}-body`} onClick={() => setCollapsed(value => !value)}>
        {collapsed ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
      </button>
    </div> : null}
    <div id={`${baseId}-body`} className="agent-request__body" hidden={docked && collapsed}>
      {plan ? <>
        <div className="agent-request__head"><strong id={titleId}>{t({ message: 'Plan', comment: 'The heading of a card that shows a plan Cursor made and waits for the user to accept.' })}</strong><span className="agent-request__tag">Cursor</span></div>
        <p className="agent-request__text tt-paragraph"><Trans>Cursor made a plan and waits for you before it starts.</Trans></p>
        {/* A long plan scrolls here, so it takes a stop in the keyboard order for the arrows to scroll it. */}
        <div className="agent-request__plan tt-focusable" role="region" aria-label={t`Cursor’s plan`} tabIndex={0}>
          {plan.title ? <p className="agent-request__plan-title">{plan.title}</p> : null}
          {plan.overview ? <p className="agent-request__plan-overview"><LinkedText text={plan.overview} /></p> : null}
          {plan.steps ? <div className="agent-request__plan-steps"><MessageContent text={plan.steps} /></div> : null}
        </div>
        <PermissionActions request={request} disabled={disabled} pressed={entry.choice} onChoose={send} names={{ 'accept-plan': t`Accept Cursor’s plan`, 'reject-plan': t`Reject Cursor’s plan` }}
          labels={{ 'accept-plan': t`Accept plan`, 'reject-plan': t({ message: 'Reject', comment: 'Rejects a plan the coding agent proposed.' }) }} />
      </> : summary ? <>
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
          linkMissing={index === 0 && request.linkMissing === true}
          selection={entry.selections[question.id] ?? EMPTY_SELECTION} disabled={disabled}
          onChange={selection => store.select(entryOwner, request.id, question.id, selection)} />)}
        <div className="agent-request__footer">
          <span className="agent-request__count" aria-live="polite">{needsProvider ? 'Finish this form in the provider’s app.'
            : skipping ? t`Choose an answer, or skip` : remaining === 0 ? 'Ready to send' : touched ? `${remaining} left to answer` : 'Choose an answer'}</span>
          <Button type="submit" variant={skipping ? 'secondary' : 'primary'} disabled={disabled || entry.save === 'unsaved' || answer === null}>{entry.phase === 'sending' ? 'Sending…'
            : skipping ? t`${plural(questions.length, { one: 'Skip question', other: 'Skip questions' })}` : questions.length === 1 ? 'Send answer' : 'Send answers'}</Button>
        </div>
      </form> : <>
        <div className="agent-request__head"><strong id={titleId}>Question</strong></div>
        <p className="agent-request__text"><LinkedText text={request.text} /></p>
        <MessageLinks links={rows} pages={pages} owner={{ threadId: ownerId, requestId: request.id }} linkMissing={request.linkMissing === true} />
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

function PermissionActions({ request, disabled, pressed, onChoose, names, labels }: {
  readonly request: AgentRequest; readonly disabled: boolean; readonly pressed: string | null
  readonly onChoose: (choice: string, answer: RequestAnswer) => void
  /** Each choice's accessible name by its ID, where its label alone would not say what a press does. */
  readonly names?: Readonly<Record<string, string>>
  /** Each choice's shown label by its ID, where Sotto wrote the choice and so translates it; a provider's own labels show as sent. */
  readonly labels?: Readonly<Record<string, string>>
}): ReactNode {
  const choices = request.permissionChoices
  // Only absent choices mean a legacy Allow/Deny request. An empty list is the provider offering nothing Sotto can send.
  if (choices && choices.length === 0) return <p className="agent-request__fallback">Sotto has no choice it can send for this request. Answer it in the provider’s app.</p>
  if (choices) {
    const described = choices.filter(choice => choice.description)
    // The provider's order is kept; the single-use approval, or a plan's acceptance, is the one emphasized action.
    const primary = choices.find(choice => choice.kind === 'allow-once')?.id ?? (names ? choices[0]?.id : undefined)
    return <>
      <div className="agent-request__actions">
        {choices.map(choice => <Button key={choice.id} variant={choice.id === primary ? 'primary' : 'secondary'} disabled={disabled}
          aria-label={names?.[choice.id]} aria-pressed={pressed === choice.id || undefined} data-choice-kind={choice.kind}
          onClick={() => onChoose(choice.id, permissionAnswer(choice))}>{labels?.[choice.id] ?? choice.label}</Button>)}
      </div>
      {described.length > 0 ? <dl className="agent-request__choices">{described.map(choice => <div key={choice.id}><dt>{choice.label}</dt><dd><LinkedText text={choice.description!} /></dd></div>)}</dl> : null}
    </>
  }
  return <div className="agent-request__actions">
    <Button variant="secondary" disabled={disabled} aria-pressed={pressed === 'deny' || undefined} onClick={() => onChoose('deny', legacyPermissionAnswer(false))}>Deny</Button>
    <Button disabled={disabled} aria-pressed={pressed === 'allow' || undefined} onClick={() => onChoose('allow', legacyPermissionAnswer(true))}>Allow</Button>
  </div>
}

/** The tool Cursor's plans arrive as (main's `CURSOR_PLAN_TOOL`, ADR-0128): a request to accept or reject a plan. */
const CURSOR_PLAN_TOOL = 'cursor/create_plan'

/**
 * A Cursor plan's parts, or null for any other permission. Main sends them typed in the request's context: the plan's
 * name, its overview and its steps in Markdown. A plan without them, from a host older than that, shows its text whole.
 */
export function cursorPlan(request: AgentRequest): { readonly title?: string; readonly overview?: string; readonly steps?: string } | null {
  if (request.kind !== 'permission' || request.context?.toolName !== CURSOR_PLAN_TOOL) return null
  const plan = request.context.plan
  if (!plan) return { steps: request.text }
  const title = plan.name?.trim(), overview = plan.overview?.trim(), steps = plan.steps?.trim()
  return { ...(title ? { title } : {}), ...(overview ? { overview } : {}), ...(steps ? { steps } : {}) }
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

/** Whether a loopback link is the very address of one of the question's pages, which opens as that page instead of as a link. */
function servedAsPage(url: string, pages: readonly QuestionPage[]): boolean {
  const parsed = new URL(url)
  const start = `${parsed.pathname.replace(/^\/+/u, '')}${parsed.search}${parsed.hash}`
  return pages.some(page => page.kind === 'server' && page.name === parsed.host && page.start === start)
}

/**
 * What a row's page belongs to, which main opens it through: the thread and the request it is on, or, with no request,
 * the thread's prototype waiting for review (ADR-0108).
 */
export interface PageOwner { readonly threadId: string; readonly requestId?: string | undefined }

/** What a row says when its page could not be opened. */
const PAGE_OPEN_FAILURES = {
  gone: 'That page is no longer there. The file was moved or deleted, or the question was answered. Nothing else changed. Ask the agent where the page is now.',
  unavailable: 'Sotto could not open that page. Nothing else changed. Try again.',
} as const

/** What a row says when its page opened in Sotto's browser and nothing here can show that browser. */
const PAGE_OPENED_UNSEEN = 'Opened in Sotto’s browser. Open Tools > Browser in this thread to see it.'

/** What stands where Open the prototype would be on a question whose prototype names no page that opens (ADR-0108). */
export const LINK_MISSING = 'No working link. This question is about a prototype, and no page it names opens.'

/**
 * Opens one of an owner's pages through main, by its token, never by path or address (ADR-0085). `failure` says how the
 * latest press went, in plain words, until the next press; a slow earlier press cannot overwrite it.
 */
export function usePageOpener(owner: PageOwner | undefined): { readonly open: (page: QuestionPage) => void; readonly failure: string | null } {
  const [failure, setFailure] = useState<string | null>(null)
  const latest = useRef(0)
  const router = useWebLinkRouter()
  const open = (page: QuestionPage): void => {
    if (!owner) return
    const press = ++latest.current
    setFailure(null)
    const settle = (said: string | null): void => { if (press === latest.current) setFailure(said) }
    const input = owner.requestId === undefined ? { threadId: owner.threadId, token: page.token } : { threadId: owner.threadId, requestId: owner.requestId, token: page.token }
    void (window.sotto?.openQuestionPage?.(input) ?? Promise.resolve({ ok: false as const, reason: 'unavailable' as const }))
      .then(result => {
        if (!result.ok) return settle(PAGE_OPEN_FAILURES[result.reason])
        // Opened in Sotto's browser, as Web links in threads chose: shown where this thread's links show theirs (ADR-0108).
        if (!result.page) return settle(null)
        settle((router.show ? router.show(result.page).message : PAGE_OPENED_UNSEEN) ?? null)
      }, () => settle(PAGE_OPEN_FAILURES.unavailable))
  }
  return { open, failure }
}

/**
 * The pages Sotto found for a question (ADR-0085), then the links from the agent's message before it, each a row of its
 * own between the question and its choices, as the iPhone's question sheet shows them. A row is a link, not a choice:
 * pressing it opens the page in this computer's browser, picks nothing, and works while the choices cannot be used. A
 * page opens through main, by the request it is on and its token: a file as itself, a loopback page and a remote
 * host's page at their address.
 */
export function MessageLinks({ links, pages = [], owner, linkMissing = false, label }: {
  readonly links: readonly string[]; readonly pages?: readonly QuestionPage[]; readonly owner?: PageOwner | undefined
  /** The question is about a prototype that names no page that opens: a muted row stands where its page's would (ADR-0108). */
  readonly linkMissing?: boolean
  /** The group's name, where it is not a question's. */
  readonly label?: string | undefined
}): ReactNode {
  const { open, failure } = usePageOpener(owner)
  // Not a button and not a link: there is nothing to open, so it takes no stop in the keyboard order.
  // Said even beside a loopback page's row: a page that did not answer is still offered (ADR-0085), but it is no working link.
  const missing = linkMissing
    ? <p className="agent-request__no-link"><Link2Off size={16} aria-hidden="true" /><span>{LINK_MISSING}</span></p> : null
  if (links.length === 0 && pages.length === 0) return missing
  return <>{missing}<div className="agent-request__link-rows" role="group" aria-label={label ?? (pages.length ? 'Pages and links for this question' : 'Links from the message above')}>
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
    {failure ? <p className="agent-request__link-failure" role="status">{failure}</p> : null}
  </div></>
}

function QuestionField({ name, question, selection, disabled, onChange, links = [], pages = [], owner, linkMissing = false }: {
  readonly name: string; readonly question: StructuredQuestion; readonly selection: typeof EMPTY_SELECTION
  readonly disabled: boolean; readonly onChange: (selection: typeof EMPTY_SELECTION) => void
  /** The message's links, shown under this question's words: the first question's, when a form has several. */
  readonly links?: readonly string[]
  /** The question's pages, shown with the links: the first question's, when a form has several (ADR-0085). */
  readonly pages?: readonly QuestionPage[]
  readonly owner?: PageOwner | undefined
  /** No page opens for this question's prototype (ADR-0108): the first question's, when a form has several. */
  readonly linkMissing?: boolean
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
    <MessageLinks links={links} pages={pages} owner={owner} linkMissing={linkMissing} />
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
