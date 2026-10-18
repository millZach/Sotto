import React, { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Eye, SquareArrowOutUpRight } from 'lucide-react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { ProviderMark } from '../agents/ProviderMark'
import { DELEGATION_OUTCOME_WORDS, delegationWaitLine } from '../agents/delegationWords'
import { useDelegationsOf } from '../agents/delegations'
import { useShared } from '../agents/stateSharing'
import { delegatedRoster, delegatingBelow, openAction, type DelegatedRosterRow } from './delegatedRoster'
import { elapsedLabel } from './rosterTime'
import '../agents/delegation.css'

/** What Tools › Agents needs to list a thread's delegated threads (ADR-0081; Owl only). */
export interface DelegatedRosterSource {
  readonly state: AgentState
  /** The thread in the focused pane, whose row says In the pane. */
  readonly shownThreadId: string | null
  /** Opens a delegated thread in the pane, keeping Tools on this roster's thread. */
  readonly open: (threadId: string) => void
  /** False where the page holds its clock still (a capture run). */
  readonly liveClock?: boolean | undefined
}

const NO_FAMILIES: readonly DelegatedRosterRow[][] = []
const NO_THREADS: readonly AgentThread[] = []

/**
 * The delegated threads below `ownerId`, two levels, each family newest start first, from the snapshot and the
 * delegation reads of the owner and of each first-level thread that delegated in turn. Nothing without a source.
 */
export function useDelegatedRoster(ownerId: string, source: DelegatedRosterSource | undefined): readonly DelegatedRosterRow[][] {
  const threads = source?.state.host.threads ?? NO_THREADS
  const host = source?.state.host
  const delegating = useMemo(() => host === undefined ? [] : [ownerId, ...delegatingBelow(ownerId, threads)], [host, ownerId, threads])
  const made = useDelegationsOf(delegating)
  return useShared(useMemo(() => host === undefined ? NO_FAMILIES : delegatedRoster(ownerId, threads, made, host), [host, ownerId, threads, made]))
}

/** What a delegated thread's row says it is doing: what it waits on you for, or its delegation's outcome. */
export function delegatedStatusWord(row: Pick<DelegatedRosterRow, 'status' | 'waitingFor'>): string | undefined {
  if (row.status === 'needs') return row.waitingFor === 'question' ? 'Needs your answer' : 'Needs your approval'
  return row.status === undefined ? undefined : DELEGATION_OUTCOME_WORDS[row.status]
}

/** How long it has worked, counting each second while it does; the time it took once its outcome is in. */
function DelegatedElapsed({ row, live }: { readonly row: DelegatedRosterRow; readonly live: boolean }): ReactNode {
  const working = row.status === 'working' || row.status === 'background' || (row.status === 'needs' && !Number.isFinite(row.endedAt))
  const [now, setNow] = useState(Date.now)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const visibility = (): void => { setVisible(document.visibilityState !== 'hidden'); setNow(Date.now()) }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  const ticking = working && live && visible && Number.isFinite(row.startedAt)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking])
  const duration = (working ? now : row.endedAt) - row.startedAt
  return Number.isFinite(duration) ? <span>{elapsedLabel(duration)}</span> : null
}

/** The latest word on a delegated thread in its details: what it waits on you for, then how its delegation stands. */
function latestOutcome(row: DelegatedRosterRow, now: number): string {
  const waiting = row.waitingFor === 'approval' ? 'It is waiting for your approval. Open it to answer there; nothing is answered from here.'
    : row.waitingFor === 'question' ? 'It is waiting for your answer. Open it to answer there; nothing is answered from here.' : undefined
  const outcome = row.newest ? delegationWaitLine(row.newest, now, row.delegatedBy) : undefined
  return [waiting, outcome].filter(Boolean).join(' ') || 'Open it to see where it stands.'
}

/**
 * One delegated thread in Tools › Agents (variant B): its provider's mark, its title and a Thread marker, its brief as the
 * preview, what the delegation record knows of it, its outcome and time, and a control that opens it in the pane. The
 * row opens to the brief and the latest outcome, never the thread's reply (ADR-0081 decision 7).
 */
export const DelegatedThreadRow = memo(function DelegatedThreadRow({ row, shown, live, onOpen }: { readonly row: DelegatedRosterRow; readonly shown: boolean; readonly live: boolean; readonly onOpen: (threadId: string) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const id = useId()
  const head = useRef<HTMLButtonElement>(null)
  const title = row.thread.title
  const status = delegatedStatusWord(row)
  const action = openAction(row, shown)
  const outcome = row.status === 'needs' ? 'needs' : row.status
  const close = (event: React.KeyboardEvent): void => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault(); setOpen(false); head.current?.focus()
  }
  return <li className="subagent-item subagent-item--thread" data-thread-id={row.thread.id} data-nested={row.level > 1 || undefined}
    style={{ '--subagent-depth': row.level - 1 } as React.CSSProperties} onKeyDown={close}>
    <div className="delegated-row" data-needs={row.status === 'needs' || undefined} data-shown={shown || undefined}>
      <button ref={head} type="button" className="subagent-head tt-focusable" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
        aria-label={[title, `delegated thread${row.provider ? ` on ${row.provider}` : ''}`, status].filter(Boolean).join(', ')} aria-describedby={`${id}-meta`}>
        <span className="subagent-lead delegated-row__mark" data-provider={row.thread.providerId}><ProviderMark provider={row.thread.providerId} name={row.provider ?? 'Provider'} size={15} /></span>
        <span className="subagent-main">
          <span className="delegated-row__title-line"><span className="subagent-title" title={title}>{title}</span><span className="delegated-row__marker">Thread</span></span>
          {row.brief ? <span className="subagent-description">{row.brief}</span> : null}
          <span className="subagent-meta" id={`${id}-meta`}><span className="subagent-model">{row.meta.join(' · ')}</span></span>
        </span>
        <span className="subagent-right">
          <span className="subagent-time"><DelegatedElapsed row={row} live={live} /><ChevronRight size={12} aria-hidden="true" /></span>
          {status ? <span className="delegated-row__status" data-outcome={outcome}><span className="delegation-ring" data-outcome={outcome} aria-hidden="true" />{status}</span> : null}
        </span>
      </button>
      {action.kind === 'shown'
        ? <span className="delegated-row__shown"><Eye size={13} aria-hidden="true" />In the pane</span>
        : <button type="button" className="delegated-row__open tt-focusable" data-needs={action.kind === 'answer' || undefined} aria-label={action.name} title={action.name}
          onClick={() => { onOpen(row.thread.id); head.current?.focus() }}>
          {action.kind === 'answer' ? action.label : <><SquareArrowOutUpRight size={13} aria-hidden="true" /><span className="delegated-row__open-long">{action.label}</span><span className="delegated-row__open-short" aria-hidden="true">Open</span></>}
        </button>}
    </div>
    {open ? <div className="subagent-details" id={id}>
      {row.brief ? <><h3>Brief</h3><p>{row.brief}</p></> : null}
      <h3>Latest outcome</h3>
      <p className="subagent-result" data-needs={row.status === 'needs' || undefined}>{latestOutcome(row, Date.now())}</p>
    </div> : null}
  </li>
})
