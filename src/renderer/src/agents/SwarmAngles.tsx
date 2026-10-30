import React, { useId, useState, type ReactNode } from 'react'
import { ChevronRight, CircleStop } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { AgentThread } from '../../../shared/agents'
import { isThreadTurnRunning } from '../../../shared/threadActivity'
import { threadNeedsYou, threadWaitingFor } from '../tools/delegatedRoster'
import type { AgentConnection } from './AgentContext'
import { DELEGATION_OUTCOME_WORDS } from './delegationWords'
import './delegation.css'

type Swarm = NonNullable<AgentThread['swarm']>
type AngleState = NonNullable<Swarm['state']>

/**
 * Each swarm lead's angles, in angle order, from the snapshot alone (ADR-0162; Owl `worker-swarms`). An angle goes under
 * its lead only where the sidebar lists it there (`listedAs`, the organization's answer): one still open under a settled
 * lead has a row of its own instead, and is never listed twice. A lead whose angles have no threads yet, as while they
 * wait their turn, has an empty list, so its row still says how the swarm stands. Reads the list once, in place.
 */
export function swarmAnglesByLead(threads: readonly AgentThread[], listedAs: ReadonlyMap<string, string> | undefined): ReadonlyMap<string, readonly AgentThread[]> {
  const byLead = new Map<string, AgentThread[]>()
  for (const thread of threads) {
    const swarm = thread.swarm
    if (swarm === undefined) continue
    const angles = byLead.get(swarm.leadThreadId) ?? []
    if (swarm.leadThreadId !== thread.id && listedAs?.get(thread.id) === swarm.leadThreadId) angles.push(thread)
    byLead.set(swarm.leadThreadId, angles)
  }
  for (const angles of byLead.values()) angles.sort((first, second) => (first.swarm?.index ?? 0) - (second.swarm?.index ?? 0))
  return byLead
}

const WAITING = msg({ message: 'Waiting its turn', comment: 'A swarm angle that has not started: its machine is at its ceiling, or its lead has not planned it yet.' })

/** An angle's word and ring: what it waits on you for first, then how its part of the swarm stands. */
function angleState(thread: AgentThread): { readonly outcome: AngleState | 'needs'; readonly word: string } {
  const waiting = threadWaitingFor(thread)
  if (waiting !== null) return { outcome: 'needs', word: waiting === 'approval' ? i18n._(msg`Needs your approval`) : i18n._(msg`Needs your answer`) }
  if (threadNeedsYou(thread)) return { outcome: 'needs', word: i18n._(msg`Needs attention`) }
  const state = thread.swarm?.state ?? (isThreadTurnRunning(thread) ? 'working' : 'unknown')
  return { outcome: state, word: state === 'planned' || state === 'queued' ? i18n._(WAITING) : DELEGATION_OUTCOME_WORDS[state] }
}

/**
 * A swarm's angles under its lead's row in the Threads list (ADR-0162, Owl `worker-swarms`): a line saying how the swarm
 * stands that opens and closes the list, and a row per angle that opens it in the pane, says what it waits on you for and
 * stops it while it works. Closed, the list still shows every angle that needs you: a request is never hidden.
 */
export function SwarmAngles({ lead, angles, currentThreadId, onOpen, command }: {
  readonly lead: AgentThread
  readonly angles: readonly AgentThread[]
  /** The thread in the focused pane, whose angle row is marked current. */
  readonly currentThreadId: string | null
  readonly onOpen: (threadId: string) => void
  readonly command: AgentConnection['command']
}): ReactNode {
  const { t } = useLingui()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const swarm = lead.swarm
  const count = swarm?.count ?? angles.length
  const done = swarm?.done ?? 0, failed = swarm?.failed ?? 0, queued = swarm?.queued ?? 0
  const needs = angles.filter(threadNeedsYou)
  const working = angles.filter(angle => !threadNeedsYou(angle) && isThreadTurnRunning(angle)).length
  const title = lead.title
  const facts = [plural(count, { one: `${done} of # angle done`, other: `${done} of # angles done` }),
    ...failed ? [plural(failed, { other: '# failed' })] : [], ...needs.length ? [plural(needs.length, { other: '# needs you' })] : [],
    ...working ? [plural(working, { other: '# working' })] : [], ...queued ? [plural(queued, { other: '# waiting' })] : [],
    ...swarm?.synthesisDone ? [t({ message: 'Synthesis written', comment: 'A swarm lead has written its synthesis of the angles.' })] : []]
  const shown = open ? angles : needs
  return <li className="thread-swarm" data-open={open || undefined}>
    <button type="button" className="thread-swarm__toggle tt-focusable" aria-expanded={open} aria-controls={listId} disabled={!angles.length}
      aria-label={t({ message: `Angles of ${title}`, comment: '{title} is the title of the thread that leads a swarm.' })} aria-describedby={`${listId}-facts`}
      onClick={() => setOpen(!open)}>
      <ChevronRight size={12} aria-hidden="true" className="thread-swarm__chevron" />
      <span id={`${listId}-facts`} className="thread-swarm__facts">{facts.join(' · ')}</span>
    </button>
    {shown.length ? <ul className="thread-swarm__angles" id={listId} role="group" aria-label={t({ message: `Angles of ${title}`, comment: '{title} is the title of the thread that leads a swarm.' })}>
      {shown.map(angle => <AngleRow key={angle.id} angle={angle} current={angle.id === currentThreadId} onOpen={onOpen} command={command} state={angleState(angle)} />)}
    </ul> : null}
  </li>
}

function AngleRow({ angle, current, state, onOpen, command }: {
  readonly angle: AgentThread; readonly current: boolean; readonly state: ReturnType<typeof angleState>
  readonly onOpen: (threadId: string) => void; readonly command: AgentConnection['command']
}): ReactNode {
  const { t } = useLingui()
  const stateId = useId()
  const title = angle.title
  const running = state.outcome !== 'needs' && isThreadTurnRunning(angle)
  return <li className="thread-swarm__angle" data-current={current || undefined} data-needs={state.outcome === 'needs' || undefined}>
    <button type="button" className="thread-swarm__open tt-focusable" aria-label={title} aria-describedby={stateId} aria-current={current ? 'page' : undefined} title={title}
      onClick={() => onOpen(angle.id)}>
      <span className="delegation-ring" data-outcome={state.outcome === 'needs' ? undefined : state.outcome} data-state={state.outcome === 'needs' ? 'needs-you' : undefined} aria-hidden="true" />
      <span className="thread-swarm__title">{title}</span>
      <span className="thread-swarm__state" id={stateId} data-outcome={state.outcome}>{state.word}</span>
    </button>
    {running ? <button type="button" className="thread-nav__action thread-swarm__stop tt-focusable" aria-label={t`Stop ${title}`} title={t`Stop`}
      onClick={() => void command({ type: 'interrupt', threadId: angle.id })}><CircleStop size={15} aria-hidden="true" /></button> : null}
  </li>
}
