import React, { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowRightLeft, Columns2, SquareArrowOutUpRight } from 'lucide-react'
import { msg, plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { PROVIDER_LABELS, type AgentState, type AgentThread } from '../../../shared/agents'
import type { CoordinationExchangeView, CoordinationReply } from '../../../shared/threadCoordination'
import type { AgentConnection } from './AgentContext'
import { ProviderMark } from './ProviderMark'
import { clockLabel } from './threadFacts'
import { coordinationStore, isActiveExchange, useCoordinationEnabled, useThreadCoordination, type CoordinationStore } from './coordination'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import { toolsPanelStore, type ToolsPanelStore } from '../tools/toolsPanelStore'
import './peerCoordination.css'

export type PeerVisualState = 'queued' | 'working' | 'background' | 'answered' | 'paused' | 'stopped' | 'failed' | 'unknown'

export function peerVisualState(view: Pick<CoordinationExchangeView, 'deliveryState' | 'outcome'>): PeerVisualState {
  if (view.deliveryState === 'queued') return 'queued'
  if (view.deliveryState === 'dispatching') return 'working'
  return view.outcome
}

const STATE_WORDS: Record<PeerVisualState, MessageDescriptor> = {
  queued: msg({ message: 'Queued', comment: 'A peer coordination message waiting for the target parent thread to become idle.' }),
  working: msg({ message: 'Working', comment: 'A peer parent thread is working on a coordination message.' }),
  background: msg({ message: 'Background', comment: 'A peer parent thread finished its turn with background work still running.' }),
  answered: msg({ message: 'Answered', comment: 'A peer parent thread replied to a coordination message.' }),
  paused: msg({ message: 'Paused', comment: 'A peer coordination message was paused because the user acted in that thread.' }),
  stopped: msg({ message: 'Stopped', comment: 'A peer parent thread was stopped before answering.' }),
  failed: msg({ message: 'Failed', comment: 'A peer coordination message failed to deliver or its turn failed.' }),
  unknown: msg({ message: 'Unknown', comment: 'A peer coordination exchange outcome cannot be proved.' }),
}

export function peerStateWord(state: PeerVisualState): string {
  return i18n._(STATE_WORDS[state])
}

/** Transcript context for opening peer parent threads and reading replies on demand. */
export interface PeerCoordinationWorld {
  readonly threadId: string
  readonly thread: (id: string) => AgentThread | undefined
  readonly open: (id: string) => void
  readonly readReply: (exchangeId: string) => Promise<CoordinationReply>
}

const PeerCoordinationWorldContext = createContext<PeerCoordinationWorld | null>(null)

export function PeerCoordinationWorldProvider({ world, children }: { readonly world: PeerCoordinationWorld | null; readonly children: ReactNode }): ReactNode {
  return <PeerCoordinationWorldContext.Provider value={world}>{children}</PeerCoordinationWorldContext.Provider>
}

export function usePeerCoordinationWorld(
  threadId: string,
  state: AgentState,
  command: AgentConnection['command'],
  store: CoordinationStore = coordinationStore,
): PeerCoordinationWorld | null {
  const enabled = useCoordinationEnabled()
  const threads = state.host.threads
  return useMemo(() => {
    if (!enabled) return null
    const byId = new Map(threads.map(thread => [thread.id, thread]))
    return {
      threadId,
      thread: id => byId.get(id),
      open: id => { void command({ type: 'select-thread', threadId: id }) },
      readReply: exchangeId => store.readReply(threadId, exchangeId),
    }
  }, [enabled, threadId, threads, command, store])
}

/** Groups outgoing peer exchanges by the sender turn's anchor message ID (matches `delegationsByTurn`). */
export function peerExchangesByTurn(
  views: readonly CoordinationExchangeView[],
  messages: readonly { readonly id: string; readonly createdAt: string }[],
): ReadonlyMap<string, readonly CoordinationExchangeView[]> {
  const byTurn = new Map<string, CoordinationExchangeView[]>()
  if (!views.length) return byTurn
  const shown = new Set(messages.map(message => message.id))
  const first = messages.length ? Date.parse(messages[0]!.createdAt) : Number.NaN
  for (const view of views) {
    const key = view.anchorMessageId !== undefined && shown.has(view.anchorMessageId) ? view.anchorMessageId
      : Number.isFinite(first) && Date.parse(view.createdAt) < first ? undefined : ''
    if (key !== undefined) byTurn.set(key, [...byTurn.get(key) ?? [], view])
  }
  return byTurn
}

/** Header for an incoming peer coordination card inside the target thread (Option A). */
export function IncomingPeerHeader({ exchange, createdAt }: { readonly exchange: CoordinationExchangeView; readonly createdAt: string }): ReactNode {
  const { t } = useLingui()
  const world = useContext(PeerCoordinationWorldContext)
  const peer = world?.thread(exchange.peerThreadId)
  const title = peer?.title ?? exchange.peerTitle ?? t`a parent thread that is no longer listed`
  const providerId = peer?.providerId ?? exchange.peerProvider ?? undefined
  const providerName = providerId ? PROVIDER_LABELS[providerId] : undefined
  const hopLabel = t({ message: `hop ${exchange.hopCount}/${exchange.hopMax}`, comment: 'Anti-loop hop counter for a peer parent-thread coordination message.' })
  return <header className="peer-card__head">
    <span className="peer-card__who">
      <ArrowRightLeft size={13} aria-hidden="true" />
      <span>{t({ message: 'From', comment: 'Precedes the title of the peer parent thread that sent this message.' })}</span>
      {peer && world
        ? <button type="button" className="delegation-link tt-focusable" aria-label={t`Open ${title}`} title={title} onClick={() => world.open(peer.id)}>{title}</button>
        : <span>{title}</span>}
    </span>
    {providerId && providerName ? <span className="peer-card__provider"><ProviderMark provider={providerId} name={providerName} size={12} /><span>{providerName}</span></span> : null}
    <span className="peer-card__hop">{hopLabel}</span>
    <time dateTime={createdAt}>{clockLabel(Date.parse(createdAt))}</time>
    {peer && world ? <button type="button" className="peer-card__open tt-focusable" aria-label={t`Open thread ${title}`} onClick={() => world.open(peer.id)}>
      <SquareArrowOutUpRight size={12} aria-hidden="true" /><span>{t`Open thread`}</span>
    </button> : null}
  </header>
}

/** Explicit ADR-0004 attribution footer on incoming peer cards. */
export function IncomingPeerFooter(): ReactNode {
  const { t } = useLingui()
  return <p className="peer-card__foot">{t`Peer context only — does not approve permissions or answer cards.`}</p>
}

/** Lazily loaded reply panel for an answered peer exchange; Escape closes and returns focus to its button. */
function PeerReplyPanel({ exchangeId, peerTitle, readReply, open, onClose, returnFocus }: {
  readonly exchangeId: string
  readonly peerTitle: string
  readonly readReply: (exchangeId: string) => Promise<CoordinationReply>
  readonly open: boolean
  readonly onClose: () => void
  readonly returnFocus: () => void
}): ReactNode {
  const { t } = useLingui()
  const [state, setState] = useState<{ readonly status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'; readonly reply?: NonNullable<CoordinationReply> }>({ status: 'idle' })
  const loadedFor = useRef<string | null>(null)
  React.useEffect(() => {
    if (!open || loadedFor.current === exchangeId) return
    let active = true
    loadedFor.current = exchangeId
    setState({ status: 'loading' })
    void readReply(exchangeId).then(
      reply => {
        if (!active) return
        if (reply === null) setState({ status: 'missing' })
        else setState({ status: 'ready', reply })
      },
      () => { if (active) { loadedFor.current = null; setState({ status: 'error' }) } },
    )
    return () => { active = false }
  }, [open, exchangeId, readReply])
  if (!open) return null
  return <div className="peer-work__reply" onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault(); event.stopPropagation(); onClose(); returnFocus()
  }}>
    <p className="peer-work__reply-label">{t`Reply in ${peerTitle}’s own words — approves nothing.`}</p>
    {state.status === 'loading' ? <p className="peer-work__reply-body" role="status">{t`Loading reply…`}</p>
      : state.status === 'ready' && state.reply ? <>
        <pre className="peer-work__reply-body">{state.reply.text}</pre>
        {state.reply.truncated ? <p className="peer-work__reply-cut">{t`Reply was cut short. Open the thread to read the rest.`}</p> : null}
      </>
      : state.status === 'error' ? <p className="peer-work__reply-body" role="status">{t`Sotto could not read that reply right now. Open the thread to read it.`}</p>
      : <p className="peer-work__reply-body">{t`Reply text is no longer retained locally. Open the thread to inspect it.`}</p>}
  </div>
}

/** One outgoing peer exchange row under the sender's turn (Option 1). */
export function PeerExchangeRow({ view }: { readonly view: CoordinationExchangeView }): ReactNode {
  const { t } = useLingui()
  useInterfaceLanguageState()
  const world = useContext(PeerCoordinationWorldContext)
  const [replyOpen, setReplyOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const replyId = useId()
  if (world === null) return null
  const peer = world.thread(view.peerThreadId)
  const title = peer?.title ?? view.peerTitle ?? t`a parent thread that is no longer listed`
  const providerId = peer?.providerId ?? view.peerProvider ?? undefined
  const providerName = providerId ? PROVIDER_LABELS[providerId] : undefined
  const state = peerVisualState(view)
  const stateWord = peerStateWord(state)
  const hopLabel = t({ message: `hop ${view.hopCount}/${view.hopMax}`, comment: 'Anti-loop hop counter for a peer parent-thread coordination message.' })
  return <li className="peer-work__row" data-state={state} aria-label={t`Sent to ${title}, ${stateWord}`}>
    <ArrowRightLeft size={14} aria-hidden="true" className="peer-work__glyph" />
    <span className="peer-work__name">
      <span className="peer-work__verb">{t({ message: 'Sent to', comment: 'Precedes the target parent thread title on a peer coordination row.' })}</span>
      {peer ? <button type="button" className="delegation-link tt-focusable" aria-label={t`Open ${title}`} title={title} onClick={() => world.open(peer.id)}>{title}</button>
        : <span>{title}</span>}
    </span>
    <span className="peer-work__state" data-state={state}>
      <span className="peer-work__ring" data-state={state} aria-hidden="true" />
      {stateWord}
    </span>
    <p className="peer-work__meta">
      {providerId && providerName ? <><ProviderMark provider={providerId} name={providerName} size={12} /><span>{providerName}</span><span aria-hidden="true">·</span></> : null}
      <span>{hopLabel}</span>
      {view.delivery === 'steered' ? <><span aria-hidden="true">·</span><span>{t({ message: 'Steered', comment: 'A peer message sent as a mid-turn steer.' })}</span></> : null}
    </p>
    {view.note ? <p className="peer-work__note tt-paragraph">{view.note}</p> : null}
    <div className="peer-work__actions">
      {peer ? <button type="button" className="peer-work__action tt-focusable" aria-label={t`Open thread ${title}`} onClick={() => world.open(peer.id)}>{t`Open thread`}</button> : null}
      {view.hasReply ? <button ref={toggleRef} type="button" className="peer-work__action tt-focusable" aria-expanded={replyOpen} aria-controls={replyOpen ? replyId : undefined}
        onClick={() => setReplyOpen(current => !current)}>{replyOpen ? t`Hide reply` : t`Read reply`}</button> : null}
    </div>
    {view.hasReply ? <div id={replyId} style={{ display: 'contents' }}>
      <PeerReplyPanel exchangeId={view.id} peerTitle={title} readReply={world.readReply} open={replyOpen}
        onClose={() => setReplyOpen(false)} returnFocus={() => toggleRef.current?.focus()} />
    </div> : null}
  </li>
}

/** Outgoing peer exchange rows for a turn (Option 1). */
export function PeerCoordinationWork({ views }: { readonly views: readonly CoordinationExchangeView[] | undefined }): ReactNode {
  const { t } = useLingui()
  if (!views?.length) return null
  return <ul className="peer-work" aria-label={t`Peer coordination exchanges`}>
    {views.map(view => <PeerExchangeRow key={view.id} view={view} />)}
  </ul>
}

/** Quiet header indicator shown ONLY while a peer exchange is actively running or queued. */
export function PeerCoordinationHeaderBadge({ threadId, store = coordinationStore, panelStore = toolsPanelStore }: {
  readonly threadId: string
  readonly store?: CoordinationStore
  readonly panelStore?: ToolsPanelStore
}): ReactNode {
  const { t } = useLingui()
  const enabled = useCoordinationEnabled()
  const { sent, received } = useThreadCoordination(enabled ? threadId : undefined, store)
  if (!enabled) return null
  const active = [...sent, ...received].filter(isActiveExchange)
  if (!active.length) return null
  const queuedOnly = active.every(item => item.deliveryState === 'queued')
  const count = active.length
  const label = queuedOnly
    ? plural(count, { one: '# peer queued', other: '# peers queued' })
    : plural(count, { one: '# peer active', other: '# peers active' })
  const state: PeerVisualState = queuedOnly ? 'queued' : 'working'
  const openAgents = (): void => {
    const pinned = panelStore.getSnapshot().pinnedThreadId
    if (pinned !== null && pinned !== threadId) panelStore.pin(threadId)
    panelStore.setSurface('agents')
    panelStore.setOpen(true)
  }
  return <button type="button" className="peer-header-chip tt-focusable" aria-label={t`Open Peer coordination in Tools: ${label}`} title={t`Show peer coordination in Tools › Agents`} onClick={openAgents}>
    <span className="peer-work__ring" data-state={state} aria-hidden="true" />
    <span>{label}</span>
  </button>
}

export interface PeerCoordinationPanelSource {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly onOpenBeside?: ((threadId: string) => void) | undefined
}

/** One row inside Tools › Agents › Peer coordination. */
function PeerAgentsRow({ view, source, readReply }: {
  readonly view: CoordinationExchangeView
  readonly source: PeerCoordinationPanelSource
  readonly readReply: (exchangeId: string) => Promise<CoordinationReply>
}): ReactNode {
  const { t } = useLingui()
  useInterfaceLanguageState()
  const [replyOpen, setReplyOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const peer = source.state.host.threads.find(item => item.id === view.peerThreadId)
  const title = peer?.title ?? view.peerTitle ?? t`a parent thread that is no longer listed`
  const providerId = peer?.providerId ?? view.peerProvider ?? undefined
  const providerName = providerId ? PROVIDER_LABELS[providerId] : undefined
  const state = peerVisualState(view)
  const stateWord = peerStateWord(state)
  const hopLabel = t({ message: `hop ${view.hopCount}/${view.hopMax}`, comment: 'Anti-loop hop counter for a peer parent-thread coordination message.' })
  const directionLabel = view.direction === 'sent'
    ? t({ message: 'Sent to', comment: 'Direction of an outgoing peer exchange in Tools › Agents.' })
    : t({ message: 'From', comment: 'Direction of an incoming peer exchange in Tools › Agents.' })
  return <li className="peer-agents__item" data-direction={view.direction} data-state={state}>
    <div className="peer-agents__top">
      <span className="peer-agents__peer">
        <span className="peer-agents__dir" aria-hidden="true">{view.direction === 'sent' ? '→' : '←'}</span>
        <span className="tt-visually-hidden">{directionLabel} </span>
        <span className="peer-agents__peer-title" title={title}>{title}</span>
      </span>
      <span className="peer-work__state" data-state={state}>
        <span className="peer-work__ring" data-state={state} aria-hidden="true" />
        {stateWord}
      </span>
    </div>
    <p className="peer-agents__meta">
      {providerId && providerName ? <><ProviderMark provider={providerId} name={providerName} size={12} /><span>{providerName}</span><span aria-hidden="true">·</span></> : null}
      <span>{hopLabel}</span>
      <span aria-hidden="true">·</span>
      <time dateTime={view.updatedAt}>{clockLabel(Date.parse(view.updatedAt))}</time>
    </p>
    {view.note ? <p className="peer-work__note tt-paragraph">{view.note}</p> : null}
    <div className="peer-agents__actions">
      {peer ? <button type="button" className="peer-agents__btn tt-focusable" aria-label={t`Open thread ${title}`}
        onClick={() => void source.command({ type: 'select-thread', threadId: peer.id })}>
        <SquareArrowOutUpRight size={12} aria-hidden="true" /><span>{t`Open thread`}</span>
      </button> : null}
      {peer && source.onOpenBeside ? <button type="button" className="peer-agents__btn tt-focusable" aria-label={t`Open ${title} beside`}
        onClick={() => source.onOpenBeside!(peer.id)}>
        <Columns2 size={12} aria-hidden="true" /><span>{t`Open beside`}</span>
      </button> : null}
      {view.hasReply ? <button ref={toggleRef} type="button" className="peer-agents__btn tt-focusable" aria-expanded={replyOpen}
        onClick={() => setReplyOpen(current => !current)}>{replyOpen ? t`Hide reply` : t`Read reply`}</button> : null}
    </div>
    {view.hasReply ? <PeerReplyPanel exchangeId={view.id} peerTitle={title} readReply={readReply} open={replyOpen}
      onClose={() => setReplyOpen(false)} returnFocus={() => toggleRef.current?.focus()} /> : null}
  </li>
}

/** Peer coordination section in Tools › Agents: lists active and recent exchanges for the focused thread. */
export function PeerCoordinationAgentsSection({ threadId, source, store = coordinationStore }: {
  readonly threadId: string
  readonly source: PeerCoordinationPanelSource | undefined
  readonly store?: CoordinationStore
}): ReactNode {
  const { t } = useLingui()
  const enabled = useCoordinationEnabled()
  const { sent, received } = useThreadCoordination(enabled && source ? threadId : undefined, store)
  const headingId = useId()
  const readReply = useCallback((exchangeId: string) => store.readReply(threadId, exchangeId), [store, threadId])
  const all = useMemo(() => [...sent, ...received].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt)), [sent, received])
  if (!enabled || !source || all.length === 0) return null
  const activeCount = all.filter(isActiveExchange).length
  const total = all.length
  const summary = activeCount > 0
    ? `${plural(total, { one: '# exchange', other: '# exchanges' })} · ${plural(activeCount, { other: '# active' })}`
    : plural(total, { one: '# exchange', other: '# exchanges' })
  return <section className="peer-agents" aria-labelledby={headingId}>
    <div className="peer-agents__head">
      <h3 className="peer-agents__title" id={headingId}>{t({ message: 'Peer coordination', comment: 'Heading over parent-to-parent coordination exchanges in Tools › Agents.' })}</h3>
      <span className="peer-agents__count">{summary}</span>
    </div>
    <ul className="peer-agents__list" aria-labelledby={headingId}>
      {all.map(view => <PeerAgentsRow key={`${view.direction}:${view.id}`} view={view} source={source} readReply={readReply} />)}
    </ul>
  </section>
}
