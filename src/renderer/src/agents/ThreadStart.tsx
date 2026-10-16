import React, { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, CornerUpLeft, GitFork } from 'lucide-react'
import { PROVIDER_LABELS, type AgentMessageHandover, type AgentThread, type AgentThreadStart, type HandoverCounts, type ProviderId } from '../../../shared/agents'
import { SottoMark } from '../components/SottoMark'
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

const named = (title: string | undefined): ReactNode => title ? <strong>{title}</strong> : 'a thread that is no longer listed'
/** The agent by its title, which is not kept while Keep local history is off. */
const agentNamed = (title: string | undefined): ReactNode => title ? <>the agent <strong>{title}</strong></> : 'one of its agents'

/** The note at the head of a thread an agent was continued into: where it came from and what came with it. */
export function ThreadStartNote({ view }: { readonly view: ThreadStartView }): ReactNode {
  const { start, sourceTitle, sourceProvider } = view
  if (start.from !== 'agent') return null
  const agent = agentNamed(start.agentTitle)
  const open = view.openSource && sourceTitle ? <> <button type="button" className="thread-start-note__open tt-focusable" onClick={view.openSource}>Open {sourceTitle}</button></> : null
  if (start.route === 'fork') {
    const provider = sourceProvider ? PROVIDER_LABELS[sourceProvider] : 'The provider'
    return <div className="thread-start-note" role="note"><GitFork size={15} aria-hidden="true" />
      <p>{provider} forked {agent} from {named(sourceTitle)} into this thread, {clockLabel(Date.parse(start.at))}. It carried the agent’s whole conversation, including its task, which {provider} keeps encrypted, so Sotto can’t show it here. The agent’s row in {sourceTitle ?? 'that thread'} is unchanged.{open}</p></div>
  }
  return <div className="thread-start-note" role="note"><CornerUpLeft size={15} aria-hidden="true" />
    <p>Continued from {agent} in {named(sourceTitle)}.{open}</p></div>
}

/** What a thin handover carried and left out, in words. */
export function thinLedger(counts: HandoverCounts, provider: ProviderId | undefined): { readonly carried: string; readonly leftOut: string } {
  // Codex keeps a v2 agent's task encrypted, so a Codex agent's handover carries its title in the task's place.
  const task = counts.total >= 2 ? 'the task' : provider === 'codex' ? 'the agent’s title' : null
  const result = counts.answered ? 'the result' : null
  const whole = [task, result].filter(Boolean).join(' and ') || 'the agent’s title'
  // A part too long to carry is left out whole; the counts say how many, not which.
  const carried = counts.tooLong === 0 ? whole : counts.carried === 0 ? 'only the agent’s title' : `only one of ${whole}`
  const leftOut = [counts.tooLong > 0 ? counts.carried === 0 ? `${whole}, too long to carry` : 'the other, too long to carry' : '',
    counts.total < 2 && provider === 'codex' ? 'its task, which Codex kept encrypted' : '', 'everything the agent did on the way'].filter(Boolean)
  return { carried, leftOut: leftOut.length < 2 ? leftOut.join('') : `${leftOut.slice(0, -1).join(', ')} and ${leftOut.at(-1)!}` }
}

/**
 * The handover a thread starts from, as Sotto's: where it came from, that it is context and not a new request, what it
 * carried and left out, and its words on request. Before the first message `words` reads them from the thread's host;
 * afterwards they are the message's own. Escape folds them again.
 */
export function StartHandoverCard({ view, handover, createdAt }: { readonly view: ThreadStartView; readonly handover?: AgentMessageHandover | undefined; readonly createdAt: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(handover?.text ?? null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const regionId = useId()
  const counts = handover?.counts ?? view.start.handover?.counts
  if (!counts) return null
  const thin = view.start.handover?.thin !== false
  const { carried, leftOut } = thinLedger(counts, view.sourceProvider)
  const toggle = async (): Promise<void> => {
    if (open) { setOpen(false); return }
    if (text !== null) { setOpen(true); return }
    if (!view.readHandover) { setError('Sotto can’t read the handover from this window. It still goes with your first message.'); return }
    setReading(true); setError(null)
    try {
      const read = await view.readHandover()
      if (read === null) setError('The handover is no longer waiting for this thread’s first message.')
      else { setText(read); setOpen(true) }
    } catch { setError('Sotto could not read the handover. It still goes with your first message. Press Read the handover to try again.') }
    finally { setReading(false) }
  }
  const from = view.start.from === 'agent'
    ? <>From {agentNamed(view.start.agentTitle)} in {named(view.sourceTitle)}.</>
    : <>From {named(view.sourceTitle)}.</>
  return <article className="thread-message thread-start-handover" data-role="user" data-from="sotto" aria-label="Handover this thread started from"
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus()
    }}>
    <header><span className="thread-message__who"><SottoMark className="thread-message__mark" />Sotto</span><span className="thread-message__tag">{thin ? 'Handover, thin' : 'Handover'}</span>
      <time dateTime={createdAt}>{clockLabel(Date.parse(createdAt))}</time></header>
    <p className="thread-start-handover__lead">{from} Context, not a new request.{handover ? null : ' It goes with your first message.'}</p>
    <p className="thread-start-handover__ledger">{counts.historyKept ? null : 'Keep local history was off, so it held only what Sotto had kept since it last started. '}
      {handover ? 'Carried' : 'Carries'} {carried}. {handover ? 'Left out' : 'Leaves out'} {leftOut}.</p>
    <button ref={button} type="button" className="thread-start-handover__disclose tt-focusable" aria-expanded={open} aria-controls={open ? regionId : undefined}
      disabled={reading} onClick={() => void toggle()}><ChevronRight size={14} aria-hidden="true" />{open ? 'Hide the handover' : reading ? 'Reading the handover…' : 'Read the handover, word for word'}</button>
    {open && text !== null ? <div id={regionId} className="thread-start-handover__text tt-focusable" tabIndex={0} role="region" aria-label="The handover, word for word">{text}</div> : null}
    {error === null ? null : <p className="thread-start-handover__error" role="alert">{error}</p>}
  </article>
}
