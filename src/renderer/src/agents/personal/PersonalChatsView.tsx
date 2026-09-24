import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, MessageSquare, PanelLeftClose, PanelLeftOpen, SquarePen } from 'lucide-react'
import type { AgentSkillCatalog } from '../../../../shared/agentSkills'
import type { PersonalChat, PersonalChatBridge, PersonalChatState } from '../../../../shared/personalChats'
import { Button } from '../../components/Button'
import { PageWindowControls } from '../../components/WindowControls'
import { composerEnterIntent, readComposerKey, runComposerMenuKey } from '../composerKeys'
import { insertSkill, retainSkillReferences, sameSkillReferences, skillLimitReached, skillSigils } from '../composerSkills'
import { MessageContent } from '../MessageContent'
import { useOptionalAgents } from '../AgentContext'
import { useOptionalApp } from '../../state/AppContext'
import { SottoMark } from '../../components/SottoMark'
import { ProviderMark } from '../ProviderMark'
import { SidebarFoot, SidebarResize, SidebarTop, useCollapseToggleFocus } from '../SidebarFrame'
import { CHATS_SIDEBAR_KEY, useSidebarSize } from '../sidebarSize'
import { AgentRequestCard } from '../requests/AgentRequestCard'
import { requestMode } from '../requests/requestAnswers'
import { RequestDraftRecovery } from '../requests/RequestDraftRecovery'
import { SkillPicker, skillOptionId, useCatalogSkillPicker } from '../SkillPicker'
import { LiveActivity } from '../ThreadActivity'
import { liveTurnId, nestActivities, placeActivities } from '../threadActivityView'
import { elapsedLabel } from '../threadFacts'
import { MessageList, reachesJumpBand, TRANSCRIPT_PAGE, type ActivityContext } from '../ThreadTranscript'
import { personalDraftStore, personalError, usePersonalDraft, type PersonalDraftStore } from './personalDrafts'
import '../composer.css'
import './personalChats.css'
import { PersonalVoice } from './PersonalVoice'
import { ChatPromptEditor } from './ChatPromptEditor'

const PERSONAL_PROMPT_ID = 'personal-chat-prompt'
const providerLabel = (provider: string): string => ({ codex: 'Codex', claude: 'Claude', grok: 'Grok' })[provider] ?? provider
const FOLLOW_SLACK_PX = 48

type Pending = 'create' | 'connect' | 'disconnect' | 'refresh' | 'interrupt' | 'select'
type Submission = PersonalChat['submissions'][number]

function bridgePersonalChats(): PersonalChatBridge | undefined {
  return window.sotto?.personalChats
}

const modelLabel = (modelId: string): string => modelId.replace(/^(?:codex|claude|grok):/u, '')

/** A plain question with no choices takes its answer from the composer, as in a project thread. */
function composerQuestion(chat: PersonalChat): PersonalChat['requests'][number] | undefined {
  return chat.requests.find(request => requestMode(request) === 'legacy-text')
}

/** Why this chat cannot take a message now, in one sentence; null when it can. */
function personalBlockedReason(state: PersonalChatState, chat: PersonalChat, answering: boolean): string | null {
  const PROVIDER = providerLabel(chat.providerId)
  if (!state.connected) return state.connecting ? `Connecting to ${PROVIDER}…` : `Connect ${PROVIDER} to send. Your draft stays here.`
  if (answering) return null
  if (chat.requests.length) return 'Answer the request above to continue.'
  if (chat.status === 'running') return `${PROVIDER} is replying. Stop it to send something else.`
  if (chat.submissions.some(item => item.status === 'submitting')) return 'Waiting for your last message to be confirmed.'
  if (chat.nativeState === 'uncertain' || chat.submissions.some(item => item.status === 'uncertain')) return 'Your last message is unconfirmed. Refresh this chat to check before sending more.'
  return null
}

/** The row's second line: what the chat needs, or when it was last active. */
function rowStatus(chat: PersonalChat, connected: boolean, now: number): { readonly state: 'needs' | 'working' | 'idle'; readonly text: string } {
  if (chat.requests.length) return { state: 'needs', text: 'Needs your answer' }
  if (chat.status === 'running') return { state: 'working', text: connected ? 'Replying' : 'Replying · Disconnected' }
  if (chat.submissions.some(item => item.status === 'uncertain') || chat.nativeState === 'uncertain') return { state: 'needs', text: 'Unconfirmed message' }
  const at = Date.parse(chat.updatedAt)
  const elapsed = elapsedLabel(at, now)
  return { state: 'idle', text: chat.messages.length ? elapsed === 'just now' ? 'Just now' : `${elapsed} ago` : 'Not started' }
}

/** Submissions the saved history does not show yet, and the last one that did not go through. */
function visibleSubmissions(chat: PersonalChat): readonly Submission[] {
  const last = chat.submissions.at(-1)
  return chat.submissions.filter(item => !chat.messages.some(message => message.id === item.messageId)
    && (item.status === 'submitting' || item.status === 'uncertain' || item === last))
}

const SUBMISSION_LABEL: Record<Submission['status'], string> = { submitting: 'Sending', accepted: 'Sent', uncertain: 'Unconfirmed', failed: 'Not sent' }

function PendingSubmission({ bridge, chat, store, submission, connected, refreshing, onRefresh, onDisclosure }: {
  readonly bridge: PersonalChatBridge; readonly chat: PersonalChat; readonly store: PersonalDraftStore
  readonly submission: Submission; readonly connected: boolean; readonly refreshing: boolean; readonly onRefresh: () => void
  readonly onDisclosure: (control: HTMLElement) => void
}): ReactNode {
  const PROVIDER = providerLabel(chat.providerId)
  usePersonalDraft(store, chat)
  const failed = submission.status === 'failed'
  const recover = (): void => {
    store.recover(bridge, chat, submission)
    document.getElementById(PERSONAL_PROMPT_ID)?.focus()
  }
  // The saved error is a raw diagnostic (paths, protocol text), so the card gives a plain reason and keeps it under Details.
  const detail = failed ? `${PROVIDER} did not take this message.`
    : submission.status === 'uncertain' ? `Sotto could not confirm ${PROVIDER} received this, and will not send it twice.${connected ? '' : ` Connect ${PROVIDER} to check.`}`
      : null
  return <article className="thread-message thread-message--pending" data-role="user" data-status={submission.status} aria-label="Pending message">
    <header><span className="thread-message__who">You</span>
      <span className="thread-message__status" role="status" data-status={submission.status}><i aria-hidden="true" />{SUBMISSION_LABEL[submission.status]}</span></header>
    <MessageContent text={submission.text} />
    {detail ? <div className="thread-message__delivery"><span>{detail}</span>
      {submission.status === 'uncertain' && connected ? <div className="thread-message__delivery-actions">
        <Button variant="secondary" disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Checking…' : 'Check again'}</Button></div> : null}
      {failed ? <div className="thread-message__delivery-actions">
        {store.holds(chat, submission) ? <span role="status">It is in the composer.</span>
          : <Button variant="secondary" onClick={recover}>Edit in composer</Button>}</div> : null}
      {failed && submission.error ? <details className="personal-chat__diagnostic">
        <summary className="tt-focusable" onClick={event => onDisclosure(event.currentTarget)}>Details</summary>
        <pre>{submission.error}</pre>
      </details> : null}
    </div> : null}
  </article>
}

function PersonalRequests({ bridge, chat, connected, onWriteAnswer }: {
  readonly bridge: PersonalChatBridge; readonly chat: PersonalChat; readonly connected: boolean; readonly onWriteAnswer: () => void
}): ReactNode {
  const PROVIDER = providerLabel(chat.providerId)
  return <>{chat.requests.map(request => {
    const unconfirmed = (state: PersonalChatState): boolean => state.chats.find(item => item.id === chat.id)?.decisions
      ?.some(decision => decision.requestId === request.id && (decision.status === 'submitting' || decision.status === 'uncertain')) === true
    // A durable answer intent the service could not confirm holds the card, across restarts too.
    const held = chat.decisions?.some(decision => decision.requestId === request.id && decision.status === 'uncertain')
    return <AgentRequestCard key={request.id} ownerId={chat.id} ownerTitle={chat.title} request={held ? { ...request, delivery: 'uncertain' } : request}
      draftOwner={{ kind: 'personal', ownerId: chat.id, providerId: chat.providerId }}
      blocked={connected ? null : `Connect ${PROVIDER} to answer.`}
      onWriteAnswer={onWriteAnswer}
      onSubmit={answer => bridge.answer({ chatId: chat.id, requestId: request.id, ...answer })
        .then(state => unconfirmed(state) ? null : { error: null }, (error: unknown) => ({ error: personalError(error, `${PROVIDER} could not take this answer.`) }))}
      onCheck={() => bridge.refresh(chat.id).then(state => !unconfirmed(state), () => false)} />
  })}</>
}

function PersonalTranscript({ bridge, chat, store, state, followSignal, refreshing, onRefresh, onWriteAnswer }: {
  readonly bridge: PersonalChatBridge; readonly chat: PersonalChat; readonly store: PersonalDraftStore; readonly state: PersonalChatState; readonly followSignal: number
  readonly refreshing: boolean; readonly onRefresh: () => void; readonly onWriteAnswer: () => void
}): ReactNode {
  const PROVIDER = providerLabel(chat.providerId)
  const streamText = useOptionalAgents()?.responseStreaming !== 'complete'
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const anchor = useRef<{ readonly height: number; readonly top: number } | null>(null)
  const [limit, setLimit] = useState(TRANSCRIPT_PAGE)
  const [away, setAway] = useState(false)
  const [requestUnderJump, setRequestUnderJump] = useState(false)
  const start = Math.max(0, chat.messages.length - limit)
  const messages = useMemo(() => chat.messages.slice(start), [chat.messages, start])
  const placement = useMemo(() => placeActivities(chat.messages, messages, chat.activities, chat.historyStatus === 'loading'),
    [chat.messages, messages, chat.activities, chat.historyStatus])
  const submissions = visibleSubmissions(chat)
  const liveTurn = liveTurnId(chat)
  const onDisclosure = useCallback((control: HTMLElement): void => {
    const before = control.getBoundingClientRect().top
    following.current = false
    requestAnimationFrame(() => {
      const current = scroller.current
      if (current === null || !control.isConnected) return
      current.scrollTop += control.getBoundingClientRect().top - before
    })
  }, [])
  const activity = useMemo<ActivityContext>(() => ({ liveTurn, running: chat.status === 'running', connected: state.connected, provider: PROVIDER, onDisclosure }),
    [liveTurn, chat.status, state.connected, PROVIDER, onDisclosure])
  const lastGroup = placement.trailing.at(-1) ?? (chat.messages.at(-1) ? placement.after.get(chat.messages.at(-1)!.id)?.at(-1) : undefined)
  const last = chat.messages.at(-1)
  const contentKey = `${last?.id}:${last?.text.length}:${submissions.map(item => `${item.id}:${item.status}`).join()}:${chat.requests.length}:${chat.activities?.length ?? 0}`

  const toEnd = useCallback((): void => {
    const element = scroller.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    following.current = true
    setAway(false)
  }, [])
  useLayoutEffect(() => { anchor.current = null; setLimit(TRANSCRIPT_PAGE); toEnd() }, [chat.id, toEnd])
  useLayoutEffect(() => { if (followSignal) toEnd() }, [followSignal, toEnd])
  useLayoutEffect(() => {
    const element = scroller.current
    if (element === null) return
    if (anchor.current !== null) {
      element.scrollTop = anchor.current.top + (element.scrollHeight - anchor.current.height)
      anchor.current = null
    } else if (following.current) element.scrollTop = element.scrollHeight
  }, [contentKey, start])
  useEffect(() => {
    const element = content.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
      if (scroller.current) setRequestUnderJump(reachesJumpBand(scroller.current))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const onScroll = (): void => {
    const element = scroller.current
    if (element === null) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    following.current = distance <= FOLLOW_SLACK_PX
    setAway(distance > Math.max(FOLLOW_SLACK_PX, element.clientHeight / 2))
    setRequestUnderJump(reachesJumpBand(element))
  }
  const showEarlier = (): void => {
    const element = scroller.current
    if (element !== null) anchor.current = { height: element.scrollHeight, top: element.scrollTop }
    following.current = false
    setLimit(current => current + TRANSCRIPT_PAGE)
  }

  const empty = !chat.messages.length && !submissions.length && liveTurn === null && !chat.activities?.length
  return <div className="thread-transcript">
    <div className="thread-workspace__transcript" ref={scroller} onScroll={onScroll} tabIndex={0} role="log" aria-live="off"
      aria-label="Chat transcript" aria-busy={chat.historyStatus === 'loading'}>
      <div className="thread-transcript__content" ref={content}>
        {chat.historyStatus === 'loading' ? <div className="thread-history-status" role="status">Loading messages…</div> : null}
        {chat.historyStatus === 'error' ? <div className="thread-history-status" role="alert"><span>{chat.historyError || 'Could not load this chat’s messages.'}</span>
          {state.connected ? <Button variant="ghost" disabled={refreshing} onClick={onRefresh}>Retry loading messages</Button> : null}</div> : null}
        {start > 0 ? <div className="thread-transcript__earlier"><Button variant="ghost" onClick={showEarlier}>Show earlier messages ({start})</Button></div> : null}
        {empty && chat.historyStatus !== 'loading' && chat.historyStatus !== 'error'
          ? <div className="thread-workspace__empty personal-chat__start"><MessageSquare size={26} strokeWidth={1.3} aria-hidden="true" />
            <h3>What’s on your mind?</h3><p>This chat has no project. {PROVIDER} brings its usual skills, and the conversation is saved here.</p></div>
          : <MessageList messages={messages} provider={PROVIDER} running={chat.status === 'running'} placement={placement} context={activity} streamText={streamText} />}
        <LiveActivity thread={chat} connected={state.connected} adjacentRecordId={lastGroup ? nestActivities(lastGroup.records).at(-1)?.record.id : undefined} />
        {submissions.map(item => <PendingSubmission key={item.id} bridge={bridge} chat={chat} store={store} submission={item} connected={state.connected} refreshing={refreshing} onRefresh={onRefresh} onDisclosure={onDisclosure} />)}
        <PersonalRequests bridge={bridge} chat={chat} connected={state.connected} onWriteAnswer={onWriteAnswer} />
        {/* Answers saved for questions no live card shows, such as ones the provider closed while Sotto was shut. */}
        <RequestDraftRecovery owner={{ kind: 'personal', ownerId: chat.id, providerId: chat.providerId }} live={chat.requests} provider={PROVIDER}
          observation={state.connecting ? 'loading' : !state.connected ? 'disconnected' : chat.historyStatus === 'loading' ? 'loading' : chat.historyStatus === 'error' ? 'unavailable' : 'ready'}
          observed={JSON.stringify([state.connected, state.connecting, chat.historyStatus, chat.status,
            chat.requests.map(request => [request.id, request.delivery, request.questions]), chat.decisions?.map(decision => [decision.requestId, decision.status])])} />
      </div>
    </div>
    {away && !requestUnderJump ? <button type="button" className="thread-transcript__jump tt-focusable" onClick={toEnd}>
      <ArrowDown size={16} aria-hidden="true" />Jump to latest
    </button> : null}
  </div>
}

function PersonalComposer({ bridge, state, chat, store, onSent }: {
  readonly bridge: PersonalChatBridge; readonly state: PersonalChatState; readonly chat: PersonalChat
  readonly store: PersonalDraftStore; readonly onSent: () => void
}): ReactNode {
  const PROVIDER = providerLabel(chat.providerId)
  const draft = usePersonalDraft(store, chat)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<AgentSkillCatalog | undefined>(undefined)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const caretAfterInsert = useRef<number | null>(null)
  const question = composerQuestion(chat)
  const answering = question !== undefined
  const reason = personalBlockedReason(state, chat, answering)
  const canSend = reason === null && !sending && draft.text.trim() !== ''
  const sigils = skillSigils(catalog?.providerId ?? chat.providerId)
  const load = useCallback(async (forceReload: boolean): Promise<boolean> => {
    try { setCatalog(await bridge.skills(chat.id, forceReload)); return true } catch { return false }
  }, [bridge, chat.id])
  const picker = useCatalogSkillPicker({ ownerId: chat.id, catalog, load, enabled: state.connected && !answering, text: draft.text })
  const listId = `${PERSONAL_PROMPT_ID}-skills`
  const statusId = `${PERSONAL_PROMPT_ID}-status`

  useLayoutEffect(() => {
    const caret = caretAfterInsert.current
    if (caret === null || textarea.current === null || textarea.current.value !== draft.text) return
    caretAfterInsert.current = null
    textarea.current.setSelectionRange(caret, caret)
    picker.track(textarea.current)
  })

  const editText = (text: string): void => {
    const skills = retainSkillReferences(text, draft.skills, sigils)
    store.edit(bridge, chat, sameSkillReferences(skills, draft.skills) ? { text } : { text, skills })
    if (error) setError(null)
  }
  const selectSkill = (index: number): void => {
    const skill = picker.options[index]
    if (skill === undefined || picker.trigger === null || skillLimitReached(draft.skills, skill, catalog?.maxSkillsPerMessage)) return
    const next = insertSkill(draft.text, picker.trigger, skill, draft.skills, sigils)
    caretAfterInsert.current = next.caret
    store.edit(bridge, chat, { text: next.text, skills: next.skills })
    textarea.current?.focus()
  }
  const send = (): void => {
    if (!canSend) return
    setSending(true)
    setError(null)
    if (question) {
      const text = draft.text
      void bridge.answer({ chatId: chat.id, requestId: question.id, answer: text }).then(() => {
        if (store.draft(chat).text === text) store.edit(bridge, chat, { text: '', skills: [] })
      }, (failure: unknown) => setError(personalError(failure, `${PROVIDER} could not take this answer. It is still in the composer.`))).finally(() => setSending(false))
      return
    }
    onSent()
    void store.send(bridge, chat).then(setError).finally(() => setSending(false))
  }

  const status = draft.error !== null && draft.save === 'unsaved'
    ? <span className="thread-prompt__status" data-tone="warning" role="alert">Draft not saved. <button type="button" className="thread-prompt__link tt-focusable" onClick={() => void store.flush(bridge, chat.id)}>Save again</button></span>
    : error ? <span className="thread-prompt__status" data-tone="warning" role="alert">{error}</span>
      : sending ? <span className="thread-prompt__status" role="status">{answering ? 'Sending answer…' : 'Sending…'}</span>
        : reason ? <span className="thread-prompt__status">{reason}</span> : null
  const primaryLabel = answering ? 'Send answer' : 'Send message'
  return <form className="thread-prompt personal-chat__prompt" data-answering={answering || undefined} data-picker={picker.open || undefined}
    onSubmit={event => { event.preventDefault(); send() }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) picker.leave() }}>
    <SkillPicker model={picker} listId={listId} provider={PROVIDER} selected={draft.skills} emptyMessage={`No ${PROVIDER} skills are available to this chat.`}
      onSelect={skill => selectSkill(picker.options.indexOf(skill))} />
    <label className="tt-visually-hidden" htmlFor={PERSONAL_PROMPT_ID}>{answering ? 'Your answer' : 'Message'}</label>
    <textarea ref={textarea} id={PERSONAL_PROMPT_ID} rows={3} value={draft.text} spellCheck
      aria-describedby={statusId}
      aria-autocomplete={!answering ? 'list' : undefined}
      aria-controls={picker.open && picker.options.length ? listId : undefined}
      aria-expanded={!answering ? picker.open : undefined}
      aria-activedescendant={picker.open && picker.activeIndex !== null ? skillOptionId(listId, picker.activeIndex) : undefined}
      placeholder={answering ? 'Write your answer…' : chat.messages.length ? `Reply to ${PROVIDER}` : 'Start the conversation'}
      onChange={event => { editText(event.target.value); picker.track(event.target) }}
      onSelect={event => picker.track(event.currentTarget)}
      onKeyDown={event => {
        const key = readComposerKey(event, !answering ? picker.open && picker.activeIndex !== null : undefined)
        if (runComposerMenuKey(event, key, { open: picker.open, optionCount: picker.options.length, activeIndex: picker.activeIndex, move: picker.move, close: picker.close, select: selectSkill })) return
        if (composerEnterIntent(key) !== 'send') return
        event.preventDefault()
        send()
      }} />
    <div className="thread-prompt__footer">
      <div className="thread-prompt__meta" id={statusId}>
        <span className="thread-prompt__model"><ProviderMark provider={chat.providerId} name={PROVIDER} />{modelLabel(chat.modelId)}<small>{answering ? 'Answer this question' : 'Personal chat'}</small></span>
        {status}
      </div>
      <div className="thread-prompt__actions">
        <Button iconOnly aria-label={primaryLabel} title={reason ?? primaryLabel} disabled={!canSend} type="submit"><ArrowUp size={18} /></Button>
      </div>
    </div>
  </form>
}

export interface PersonalChatsViewProps {
  /** Defaults to the application's bridge. */
  readonly bridge?: PersonalChatBridge | undefined
  readonly store?: PersonalDraftStore
  /** Where the coordinator is chosen, for when new chats are unavailable. */
  readonly onOpenCoordinatorSettings?: (() => void) | undefined
  readonly now?: number | undefined
  /** The page's sentence, seated at the room's bottom right. */
  readonly statusText?: ReactNode
}

/**
 * The page before it has chats to show: the chat list's frame stands empty beside the message, so the foot
 * still leads off the page and the window still has its controls.
 */
function EmptyChatsFrame({ children }: { readonly children: ReactNode }): ReactNode {
  const mac = useOptionalApp()?.platform === 'darwin'
  return <div className={mac ? 'threads-view threads-view--mac personal-chats' : 'threads-view personal-chats'}>
    <ChatsNavFrame rail={null}><div className="thread-nav__scroll" /></ChatsNavFrame>
    <div className="personal-chats--unavailable">{children}</div>
    <PageWindowControls />
  </div>
}

/**
 * The chat list's frame: a width of its own that the right edge drags, and a Collapse sidebar button that folds
 * it to a rail, the way the Threads sidebar folds to its rail. The width and the fold are remembered apart from
 * the Threads sidebar's. Titles end in an ellipsis rather than widening the column.
 */
function ChatsNavFrame({ rail, head, children }: { readonly rail: ReactNode; readonly head?: ReactNode; readonly children: ReactNode }): ReactNode {
  const mac = useOptionalApp()?.platform === 'darwin'
  const size = useSidebarSize(CHATS_SIDEBAR_KEY)
  const [resizing, setResizing] = useState(false)
  const toggle = useCollapseToggleFocus(size.collapsed)
  return <nav className={mac ? 'thread-nav thread-nav--mac personal-chats__nav' : 'thread-nav personal-chats__nav'} aria-label="Chats"
    data-collapsed={size.collapsed || undefined} data-resizing={resizing || undefined} style={{ width: size.collapsed ? (mac ? 80 : 52) : size.width }}>
    {size.collapsed ? <div className="thread-nav__rail">
      <SottoMark className="thread-nav__glyph" />
      <button ref={toggle} type="button" className="thread-nav__action tt-focusable" aria-label="Expand sidebar" title="Expand sidebar" onClick={() => size.collapse(false)}><PanelLeftOpen size={16} aria-hidden="true" /></button>
      <div className="thread-nav__rail-list">{rail}</div>
      <SidebarFoot />
    </div> : <>
      <SidebarTop>
        <button ref={toggle} type="button" className="thread-nav__action tt-focusable thread-nav__collapse" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={() => size.collapse(true)}><PanelLeftClose size={16} aria-hidden="true" /></button>
      </SidebarTop>
      {head}
      {children}
      <SidebarFoot />
      <SidebarResize size={size} onResizing={setResizing} />
    </>}
  </nav>
}

/** The chats, listed in the frame; collapsed, each chat is its provider's mark in a tile named by its title. */
function ChatsSidebar({ state, clock, newChat, onSelect, onOpenCoordinatorSettings }: {
  readonly state: PersonalChatState; readonly clock: number
  readonly newChat: { readonly label: string; readonly blocked: boolean; readonly start: () => void }
  readonly onSelect: (chatId: string) => void
  readonly onOpenCoordinatorSettings?: (() => void) | undefined
}): ReactNode {
  const { availability } = state
  const rows = state.chats.map(chat => ({ chat, current: chat.id === state.selectedChatId, status: rowStatus(chat, chat.connected ?? state.connected, clock) }))
  const rail = <>
    <button type="button" className="thread-nav__action tt-focusable" aria-label="New chat" title={newChat.label} disabled={newChat.blocked} onClick={newChat.start}><SquarePen size={16} aria-hidden="true" /></button>
    <ul className="personal-chats__rail">{rows.map(({ chat, current, status }) => <li key={chat.id}>
      <button type="button" className="thread-nav__rail-thread tt-focusable" aria-label={chat.title} aria-current={current ? 'page' : undefined}
        title={`${chat.title} · ${providerLabel(chat.providerId)} · ${status.text}`} onClick={() => onSelect(chat.id)}>
        <span className="thread-nav__mark" data-provider={chat.providerId}><ProviderMark provider={chat.providerId} name={providerLabel(chat.providerId)} size={16} /></span>
        {status.state === 'idle' ? null : <span className="thread-nav__ring" data-state={status.state} data-disconnected={(chat.connected ?? state.connected) ? undefined : true} aria-hidden="true" />}
      </button>
    </li>)}</ul>
  </>
  const head = <>
    <div className="thread-nav__head"><h1>Chats</h1><div className="thread-nav__head-actions">
      <Button iconOnly variant="ghost" aria-label="New chat" title={newChat.label} disabled={newChat.blocked} onClick={newChat.start}><SquarePen size={17} /></Button></div></div>
    {!availability.supported ? <div className="thread-nav__error personal-chats__availability" role="status">
      <span>{availability.reason ?? 'New chats are unavailable with the current coordinator.'}</span>
      {onOpenCoordinatorSettings ? <button type="button" className="thread-prompt__link tt-focusable" onClick={onOpenCoordinatorSettings}>Coordinator settings</button> : null}
    </div> : null}
  </>
  return <ChatsNavFrame rail={rail} head={head}>
    <div className="thread-nav__scroll">
      {rows.length ? <ul className="personal-chats__list">
        {rows.map(({ chat, current, status }) => <li key={chat.id} className="thread-nav__row" data-current={current || undefined}>
          <button type="button" className="thread-nav__item tt-focusable" aria-current={current ? 'page' : undefined} onClick={() => onSelect(chat.id)}>
            <span className="thread-nav__mark" data-provider={chat.providerId} title={providerLabel(chat.providerId)}><ProviderMark provider={chat.providerId} name={providerLabel(chat.providerId)} /></span>
            <span className="thread-nav__title">{chat.title}</span>
            <span className="thread-nav__status" data-state={status.state}><i aria-hidden="true" />{status.text}</span>
          </button>
        </li>)}
      </ul> : <p className="thread-nav__empty">No chats yet.</p>}
    </div>
  </ChatsNavFrame>
}

/**
 * Saved conversations with the configured native coordinator, outside any project. The main process owns the chats,
 * their drafts and every delivery; this view shows its snapshots and asks it to act.
 * Leaving the view only unsubscribes: the connection, drafts and running replies carry on.
 */
export function PersonalChatsView({ bridge = bridgePersonalChats(), store = personalDraftStore, onOpenCoordinatorSettings, now, statusText }: PersonalChatsViewProps): ReactNode {
  const [state, setState] = useState<PersonalChatState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState<Pending | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [followSignal, setFollowSignal] = useState(0)
  const focusComposer = useRef(false)
  const mac = useOptionalApp()?.platform === 'darwin'

  useEffect(() => {
    if (!bridge) return
    let live = true
    // Subscribe first, then read: main's messages arrive in order, so the latest to arrive is the current state.
    const unsubscribe = bridge.onState(next => { if (live) { setState(next); setLoadError(null) } })
    bridge.get().then(next => { if (live) setState(next) }, (error: unknown) => { if (live) setLoadError(personalError(error, 'Sotto could not open your chats.')) })
    return () => { live = false; unsubscribe() }
  }, [bridge, attempt])

  const selected = state?.chats.find(chat => chat.id === state.selectedChatId)
  useLayoutEffect(() => {
    if (!focusComposer.current || !selected) return
    focusComposer.current = false
    document.getElementById(PERSONAL_PROMPT_ID)?.focus()
  }, [selected])

  const run = useCallback(async (kind: Pending, action: () => Promise<PersonalChatState>, fallback: string): Promise<PersonalChatState | null> => {
    setPending(kind)
    setActionError(null)
    try {
      const next = await action()
      setState(next)
      return next
    } catch (error) {
      setActionError(personalError(error, fallback))
      return null
    } finally { setPending(null) }
  }, [])

  if (!bridge) {
    return <EmptyChatsFrame><div className="thread-workspace__empty"><h2>Chats are unavailable</h2><p>Reopen Sotto to use chats.</p></div></EmptyChatsFrame>
  }
  if (state === null) {
    return <EmptyChatsFrame>
      {loadError ? <div className="thread-workspace__empty" role="alert"><h2>Your chats did not open</h2><p>{loadError}</p><Button variant="secondary" onClick={() => { setLoadError(null); setAttempt(value => value + 1) }}>Try again</Button></div>
        : <div className="thread-workspace__empty" role="status"><p>Opening your chats…</p></div>}
    </EmptyChatsFrame>
  }

  const PROVIDER = providerLabel(selected?.providerId ?? state.availability.provider)
  const clock = now ?? Date.now()
  const { availability } = state
  const create = async (): Promise<void> => {
    focusComposer.current = true
    const next = await run('create', () => bridge.create(), 'Sotto could not start a chat.')
    if (next === null) { focusComposer.current = false; return }
    // Starting a chat is asking to talk: the personal connection starts with it. Project providers are untouched.
    if (!next.connected && !next.connecting) void run('connect', () => bridge.connect(), `${PROVIDER} could not connect.`)
  }
  const select = (chatId: string): void => {
    if (chatId === state.selectedChatId) return
    void run('select', () => bridge.select(chatId), 'Sotto could not open that chat.')
  }
  const refresh = (): void => { if (selected) void run('refresh', () => bridge.refresh(selected.id), 'Sotto could not refresh this chat.') }
  const newChatBlocked = !availability.supported || pending === 'create'

  return <div className={mac ? 'threads-view threads-view--mac personal-chats' : 'threads-view personal-chats'}>
    {/* The chat list wears the Threads sidebar's frame: its top row above the list, its foot below it. */}
    <ChatsSidebar state={state} clock={clock} onSelect={select} onOpenCoordinatorSettings={onOpenCoordinatorSettings}
      newChat={{ label: availability.supported ? 'New chat' : availability.reason ?? 'New chats are unavailable.', blocked: newChatBlocked, start: () => void create() }} />
    <section className="thread-workspace personal-chat" aria-label={selected ? selected.title : 'Chat'}>
      {selected ? <>
        <header className="thread-workspace__head">
          <div className="thread-workspace__title">
            <span className="thread-workspace__crumb"><ProviderMark provider={selected.providerId} name={PROVIDER} size={16} /><span>{PROVIDER} · {modelLabel(selected.modelId)}</span>
              <span className="thread-workspace__tag">No project</span>
              {!state.connected ? <span className="thread-workspace__tag" data-tone="warning">{state.connecting ? 'Connecting' : `${PROVIDER} disconnected`}</span> : null}
            </span>
            <h2>{selected.title}</h2>
          </div>
          <div className="thread-workspace__actions">
            <ChatPromptEditor chat={selected} />
            {!state.connected ? <Button variant="secondary" disabled={state.connecting || pending === 'connect'} onClick={() => void run('connect', () => bridge.connect(), `${PROVIDER} could not connect.`)}>
              {state.connecting ? 'Connecting…' : `Connect ${PROVIDER}`}</Button> : null}
            {state.connected && selected.nativeState !== 'unstarted' ? <Button variant="ghost" disabled={pending === 'refresh'} onClick={refresh}>{pending === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button> : null}
            {selected.status === 'running' ? <Button variant="secondary" disabled={!state.connected || pending === 'interrupt'} onClick={() => void run('interrupt', () => bridge.interrupt(selected.id), `Sotto could not stop ${PROVIDER}.`)}>Stop</Button> : null}
            {state.connected ? <Button variant="ghost" disabled={pending === 'disconnect'} title={selected.requests.length ? 'Disconnecting declines the pending request.' : 'End personal chat connections. Chats and drafts stay.'}
              onClick={() => void run('disconnect', () => bridge.disconnect(), `Sotto could not disconnect ${PROVIDER}.`)}>Disconnect</Button> : null}
          </div>
        </header>
        {actionError || state.error ? <p className="agent-error thread-workspace__error" role="alert">{actionError ?? state.error}</p> : null}
        <PersonalTranscript bridge={bridge} chat={selected} store={store} state={state} followSignal={followSignal} refreshing={pending === 'refresh'} onRefresh={refresh}
          onWriteAnswer={() => document.getElementById(PERSONAL_PROMPT_ID)?.focus()} />
        <div className="thread-workspace__compose">
          <PersonalComposer key={selected.id} bridge={bridge} state={state} chat={selected} store={store} onSent={() => setFollowSignal(value => value + 1)} />
          <PersonalVoice key={`voice-${selected.id}`} bridge={bridge} chat={selected} state={state} store={store} />
        </div>
      </> : <>
        {actionError || state.error ? <p className="agent-error thread-workspace__error" role="alert">{actionError ?? state.error}</p> : null}
        <div className="thread-workspace__empty personal-chat__none">
          <MessageSquare size={30} strokeWidth={1.3} aria-hidden="true" />
          <h2>{state.chats.length ? 'Pick up a chat' : 'Talk it through with Sotto'}</h2>
          <p>{state.chats.length ? 'Choose a saved chat, or start a new one.' : `Chats need no project. They use your ${PROVIDER} coordinator and stay saved on this computer.`}</p>
          <Button variant="primary" disabled={newChatBlocked} onClick={() => void create()}><SquarePen size={16} aria-hidden="true" />New chat</Button>
        </div>
      </>}
    </section>
    <PageWindowControls />
    {statusText ? <p className="page-status">{statusText}</p> : null}
  </div>
}
