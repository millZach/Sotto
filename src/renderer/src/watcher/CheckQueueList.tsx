import React, { useId, type ReactNode } from 'react'
import type { AgentThread } from '../../../shared/agents'
import type { CheckQueueEntry, MachineChecks } from '../../../shared/checkQueue'
import { checksHeading, checksNote, checkStateWords, checkWhoseWords, untitledCheck } from './checkQueueWords'
import './checkQueue.css'

/** What names a check: its thread's title once the window holds the thread, otherwise the title it was asked under. */
export function checkTitle(check: CheckQueueEntry, threadOf: (threadId: string) => AgentThread | undefined): string {
  const thread = check.thread === undefined ? undefined : threadOf(check.thread)
  return thread?.title || check.title || untitledCheck()
}

/**
 * One machine's checks, one at a time (#1312, fourth part, Zach's pick C): the running check first, then the ones waiting
 * in the order asked, each with whose it is and where it stands. In the machine's panel (`machine` null, as the panel names
 * the machine) and in a check's row in Tools › Agents, which marks its own check.
 */
export function CheckQueueList({ checks, machine, thisComputer, threadOf, current }: {
  readonly checks: MachineChecks
  /** The machine's name, for the heading in Tools › Agents; null in the machine's own panel. */
  readonly machine: string | null
  readonly thisComputer: boolean
  readonly threadOf: (threadId: string) => AgentThread | undefined
  /** The check this list is shown for, by its ticket, marked in the list. */
  readonly current?: string | undefined
}): ReactNode {
  const heading = useId()
  return <section className="check-queue" aria-labelledby={heading}>
    <h3 id={heading} className="check-queue__head">{checksHeading(machine, thisComputer)}</h3>
    <ol className="check-queue__list">{checks.checks.map((check, at) => {
      const thread = check.thread === undefined ? undefined : threadOf(check.thread)
      const by = check.by === undefined ? undefined : threadOf(check.by)?.title
      const installing = at === 0 && thread?.worktree?.check?.install === 'running'
      const facts = [checkWhoseWords(check, by), checkStateWords(at, installing)].filter(Boolean).join(' · ')
      return <li key={check.id} data-current={check.id === current || undefined}>
        {at === 0 ? <span className="check-queue__ring" aria-hidden="true" /> : <span className="check-queue__place" aria-hidden="true">{at}</span>}
        <span className="check-queue__title">{checkTitle(check, threadOf)}</span>
        <span className="check-queue__facts">{facts}</span>
      </li>
    })}</ol>
  </section>
}

/** Under the machine's own list: why its checks wait. */
export function CheckQueueNote({ machine, thisComputer }: { readonly machine: string; readonly thisComputer: boolean }): ReactNode {
  return <p className="check-queue__note tt-paragraph">{checksNote(machine, thisComputer)}</p>
}
