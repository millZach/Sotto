import React, { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, CornerUpLeft, GitFork } from 'lucide-react'
import { t } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS, type AgentMessageHandover, type AgentThread, type AgentThreadStart, type HandoverCounts, type ProviderId } from '../../../shared/agents'
import { SottoMark } from '../components/SottoMark'
import { handoverLedger } from '../watcher/WatcherHandover'
import { useOwlFeature } from '../state/owlFeature'
import { clockLabel } from './threadFacts'
import './threadStart.css'

/**
 * A thread that began from another (#1028, Zach's pick B of the continue prototype, in place): one of a thread's agents
 * continued as its own thread, or a thread forked at a reply. The transcript says where it began with a note Sotto
 * writes, since a Codex fork shows no brief of its own, and a thread that starts from a handover shows that handover as
 * Sotto's, ahead of the first message it goes with.
 */

/** Ask before drawing any of it: continuing agents and Fork from here are an Owl feature (ADR-0072). */
export function useThreadStarts(): boolean { return useOwlFeature('continue-agent-thread') }

/** What the transcript needs to say where a thread began. */
export interface ThreadStartView {
  readonly threadId: string
  readonly start: AgentThreadStart
  /** The thread it began from, by its title now, or undefined when that thread is no longer listed. */
  readonly sourceTitle: string | undefined
  /** The provider the agent or the conversation came from. */
  readonly sourceProvider: ProviderId | undefined
  /** Opens the thread it began from. */
  readonly openSource: (() => void) | undefined
  /** The words of a handover still waiting for the first message, read only when asked for. */
  readonly readHandover: (() => Promise<string | null>) | undefined
}
/**
 * The view of the thread a transcript shows, `'off'` for a thread that began from another while the feature is off, whose
 * handover is then not drawn at all, and null for every other thread.
 */
export const ThreadStartContext = createContext<ThreadStartView | 'off' | null>(null)
export function useThreadStartView(): ThreadStartView | 'off' | null { return useContext(ThreadStartContext) }

/** The view of a thread that began from another, or null for every other thread and while the feature is off. */
export function threadStartView(thread: Pick<AgentThread, 'id' | 'startedFrom' | 'providerId'>, source: Pick<AgentThread, 'title' | 'providerId'> | undefined,
  command: (command: { type: 'select-thread'; threadId: string }) => unknown, read: ((threadId: string) => Promise<{ text: string } | null>) | undefined): ThreadStartView | null {
  const start = thread.startedFrom
  if (!start) return null
  return { threadId: thread.id, start, sourceTitle: source?.title, sourceProvider: source?.providerId ?? thread.providerId,
    openSource: source ? () => { void command({ type: 'select-thread', threadId: start.threadId }) } : undefined,
    readHandover: read ? async () => (await read(thread.id))?.text ?? null : undefined }
}

const named = (title: string | undefined): ReactNode => title ? <strong>{title}</strong> : t`a thread that is no longer listed`
/** The agent by its title, which is not kept while Keep local history is off. */
const agentNamed = (title: string | undefined): ReactNode => title ? <Trans comment="{title} is an agent's title.">the agent <strong>{title}</strong></Trans> : t`one of its agents`
/** The button that opens the thread this one began from, after a space. */
const openButton = (view: ThreadStartView, sourceTitle: string | undefined): ReactNode => view.openSource && sourceTitle
  ? <> <button type="button" className="thread-start-note__open tt-focusable" onClick={view.openSource}>{t({ message: `Open ${sourceTitle}`, comment: 'Opens a thread; {sourceTitle} is its title.' })}</button></>
  : null
/** Joins parts of a sentence into a list: "a", "a and b", "a, b and c". */
const listOf = (items: readonly string[]): string => items.reduce((list, item, index) => index === 0 ? item
  : index === items.length - 1 ? t({ message: `${list} and ${item}`, comment: 'The last two parts of a list in a sentence.' })
  : t({ message: `${list}, ${item}`, comment: 'Parts of a list in a sentence, before its last.' }), '')

/**
 * Sotto's note on where a thread began: at the head of a thread an agent was continued into, and under the last reply a
 * fork copied, where the fork's own conversation begins. A fork that started from a handover has the handover's card instead.
 */
export function ThreadStartNote({ view }: { readonly view: ThreadStartView }): ReactNode {
  const { t } = useLingui()
  const { start, sourceTitle, sourceProvider } = view
  const source = named(sourceTitle)
  const open = openButton(view, sourceTitle)
  if (start.from === 'turn') {
    if (start.route !== 'fork') return null
    const provider = sourceProvider ? PROVIDER_LABELS[sourceProvider] : t({ message: 'the provider', comment: 'Stands for a provider whose name is not known, inside a sentence.' })
    return <div className="thread-start-note" role="note"><GitFork size={15} aria-hidden="true" />
      <p className="tt-paragraph"><Trans comment="{source} is the title of the thread it was forked from; {provider} is a provider's name; {open} is a button that opens that thread.">Forked from {source} at {provider}’s reply above. What follows is this thread’s own. Files weren’t rewound.{open}</Trans></p></div>
  }
  const agent = agentNamed(start.agentTitle)
  if (start.route === 'fork') {
    const provider = sourceProvider ? PROVIDER_LABELS[sourceProvider] : t({ message: 'The provider', comment: 'Stands for a provider whose name is not known, at the start of a sentence.' })
    const time = clockLabel(Date.parse(start.at))
    const sourceName = sourceTitle ?? t({ message: 'that thread', comment: 'Stands for a thread that is no longer listed, inside a sentence.' })
    return <div className="thread-start-note" role="note"><GitFork size={15} aria-hidden="true" />
      <p className="tt-paragraph"><Trans comment="{provider} is a provider's name; {agent} names the agent; {source} and {sourceName} are the title of the thread it came from; {time} is a time of day; {open} is a button that opens that thread.">{provider} forked {agent} from {source} into this thread, {time}. It carried the agent’s whole conversation, including its task, which {provider} keeps encrypted, so Sotto can’t show it here. The agent’s row in {sourceName} is unchanged.{open}</Trans></p></div>
  }
  return <div className="thread-start-note" role="note"><CornerUpLeft size={15} aria-hidden="true" />
    <p className="tt-paragraph"><Trans comment="{agent} names the agent; {source} is the title of the thread it came from; {open} is a button that opens that thread.">Continued from {agent} in {source}.{open}</Trans></p></div>
}

/** What a thin handover carried and left out, in words. */
export function thinLedger(counts: HandoverCounts, provider: ProviderId | undefined): { readonly carried: string; readonly leftOut: string } {
  // Codex keeps a v2 agent's task encrypted, so a Codex agent's handover carries its title in the task's place.
  const title = t({ message: 'the agent’s title', comment: 'Part of what a handover carried, inside a sentence.' })
  const task = counts.total >= 2 ? t({ message: 'the task', comment: 'Part of what a handover carried, inside a sentence.' }) : provider === 'codex' ? title : null
  const result = counts.answered ? t({ message: 'the result', comment: 'Part of what a handover carried, inside a sentence.' }) : null
  const whole = listOf([task, result].filter((part): part is string => Boolean(part))) || title
  // A part too long to carry is left out whole; the counts say how many, not which.
  const carried = counts.tooLong === 0 ? whole : counts.carried === 0 ? t`only the agent’s title`
    : t({ message: `only one of ${whole}`, comment: '{whole} lists the parts of a handover, such as "the task and the result".' })
  const leftOut = [counts.tooLong > 0 ? counts.carried === 0 ? t({ message: `${whole}, too long to carry`, comment: '{whole} lists the parts of a handover, such as "the task and the result".' }) : t`the other, too long to carry` : '',
    counts.total < 2 && provider === 'codex' ? t`its task, which Codex kept encrypted` : '', t`everything the agent did on the way`].filter(Boolean)
  return { carried, leftOut: listOf(leftOut) }
}

/**
 * The handover a thread starts from, as Sotto's: where it came from, that it is context and not a new request, what it
 * carried and left out, and its words on request. Before the first message `words` reads them from the thread's host;
 * afterwards they are the message's own. Escape folds them again.
 */
export function StartHandoverCard({ view, handover, createdAt }: { readonly view: ThreadStartView; readonly handover?: AgentMessageHandover | undefined; readonly createdAt: string }): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(handover?.text ?? null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const regionId = useId()
  const counts = handover?.counts ?? view.start.handover?.counts
  if (!counts) return null
  const thin = view.start.handover?.thin !== false
  // A thin handover carries an agent's task and result; a fork's carries the conversation up to its reply.
  const ledger = thin ? thinLedger(counts, view.sourceProvider) : handoverLedger(counts)
  const toggle = async (): Promise<void> => {
    if (open) { setOpen(false); return }
    if (text !== null) { setOpen(true); return }
    if (!view.readHandover) { setError(t`Sotto can’t read the handover from this window. It still goes with your first message.`); return }
    setReading(true); setError(null)
    try {
      const read = await view.readHandover()
      if (read === null) setError(t`The handover is no longer waiting for this thread’s first message.`)
      else { setText(read); setOpen(true) }
    } catch { setError(t`Sotto could not read the handover. It still goes with your first message. Press Read the handover to try again.`) }
    finally { setReading(false) }
  }
  const source = named(view.sourceTitle)
  const agent = agentNamed(view.start.agentTitle)
  const provider = view.sourceProvider ? PROVIDER_LABELS[view.sourceProvider] : t({ message: 'its provider', comment: 'Stands for a provider whose name is not known, inside a sentence.' })
  const from = view.start.from === 'agent'
    ? <Trans comment="{agent} names the agent; {source} is the title of the thread it came from.">From {agent} in {source}.</Trans>
    : <Trans comment="{source} is the title of the thread it came from; {provider} is a provider's name.">From {source}, up to {provider}’s reply.</Trans>
  const { carried, leftOut } = ledger
  const ledgerWords = handover
    ? leftOut === null ? t({ message: `Carried ${carried}.`, comment: '{carried} lists what the handover held.' }) : t({ message: `Carried ${carried}. Left out ${leftOut}.`, comment: '{carried} lists what the handover held; {leftOut} what it did not.' })
    : leftOut === null ? t({ message: `Carries ${carried}.`, comment: '{carried} lists what the handover holds.' }) : t({ message: `Carries ${carried}. Leaves out ${leftOut}.`, comment: '{carried} lists what the handover holds; {leftOut} what it does not.' })
  return <article className="thread-message thread-start-handover" data-role="user" data-from="sotto" aria-label={t`Handover this thread started from`}
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus()
    }}>
    <header><span className="thread-message__who"><SottoMark className="thread-message__mark" />Sotto</span><span className="thread-message__tag">{thin ? t({ message: 'Handover, thin', comment: 'A tag on a handover that carried only an agent\'s task and result.' }) : t({ message: 'Handover', comment: 'A tag on a message: Sotto\'s handover from another thread.' })}</span>
      <time dateTime={createdAt}>{clockLabel(Date.parse(createdAt))}</time></header>
    <p className="thread-start-handover__lead">{handover
      ? <Trans comment="{from} says where the handover came from.">{from} Context, not a new request.</Trans>
      : <Trans comment="{from} says where the handover came from.">{from} Context, not a new request. It goes with your first message.</Trans>}</p>
    <p className="thread-start-handover__ledger tt-paragraph">{counts.historyKept ? null : t`Keep local history was off, so it held only what Sotto had kept since it last started.` + ' '}
      {ledgerWords}</p>
    <button ref={button} type="button" className="thread-start-handover__disclose tt-focusable" aria-expanded={open} aria-controls={open ? regionId : undefined}
      disabled={reading} onClick={() => void toggle()}><ChevronRight size={14} aria-hidden="true" />{open ? t`Hide the handover` : reading ? t`Reading the handover…` : t`Read the handover, word for word`}</button>
    {open && text !== null ? <div id={regionId} className="thread-start-handover__text tt-focusable" tabIndex={0} role="region" aria-label={t`The handover, word for word`}>{text}</div> : null}
    {error === null ? null : <p className="thread-start-handover__error" role="alert">{error}</p>}
  </article>
}
