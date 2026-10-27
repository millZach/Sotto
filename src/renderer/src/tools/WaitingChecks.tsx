import React, { memo, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { PROVIDER_LABELS } from '../../../shared/agents'
import { DELEGATION_WORK_TITLES } from '../../../shared/delegation'
import { ProviderMark } from '../agents/ProviderMark'
import { DELEGATION_OUTCOME_WORDS } from '../agents/delegationWords'
import { CheckQueueList, checkTitle } from '../watcher/CheckQueueList'
import { unmadeChecks, useCheckQueues, type UnmadeCheck } from '../watcher/checkQueues'
import { checkWaitingSentence } from '../watcher/checkQueueWords'
import '../agents/delegation.css'

const NO_CHECKS: readonly UnmadeCheck[] = []

/**
 * The checks a thread delegated, or one of its delegated threads did, whose own threads are not made yet because they wait
 * their turn on their machine (#1312, fourth part, Zach's pick C). Tools › Agents lists each as a row of its own until its
 * thread is made, when the thread's own row takes its place. Nothing where Work across machines is off.
 */
export function useWaitingChecks(ownerId: string, state: AgentState | undefined): readonly UnmadeCheck[] {
  const queues = useCheckQueues()
  const threads = state?.host.threads
  return useMemo(() => {
    if (queues === null || threads === undefined) return NO_CHECKS
    const owners = new Set([ownerId, ...threads.filter(thread => thread.delegatedBy === ownerId && thread.id !== ownerId).map(thread => thread.id)])
    const made = new Set(threads.map(thread => thread.id))
    const found = unmadeChecks(queues, owners, threadId => made.has(threadId))
    return found.length ? found : NO_CHECKS
  }, [queues, threads, ownerId])
}

/** A machine's name as Tools › Agents gives it: This computer, or the name the user saved for a paired host. */
export function checkMachineName(state: AgentState | undefined, waiting: Pick<UnmadeCheck, 'machine'>, thisComputer: string, remoteHost: string): string {
  if (waiting.machine.thisComputer) return thisComputer
  return state?.connections?.find(item => item.hostId === waiting.machine.hostId)?.name ?? remoteHost
}

/**
 * One delegated check waiting its turn, in Tools › Agents: its provider's mark, its title and a Check marker, its kind of
 * work and machine, and the outcome Working, which a waiting check keeps (Zach, October 23, 2026). It opens to where it
 * stands and its machine's checks; there is no thread to open until its turn comes. Escape closes it.
 */
export const WaitingCheckRow = memo(function WaitingCheckRow({ waiting, machine, threadOf }: {
  readonly waiting: UnmadeCheck
  readonly machine: string
  readonly threadOf: (threadId: string) => AgentThread | undefined
}): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const id = useId()
  const head = useRef<HTMLButtonElement>(null)
  const { check, at } = waiting
  const thisComputer = waiting.machine.thisComputer
  const title = checkTitle(check, threadOf)
  const provider = check.provider ? PROVIDER_LABELS[check.provider] : undefined
  const meta = [provider, check.work ? DELEGATION_WORK_TITLES[check.work] : undefined, machine].filter((fact): fact is string => fact !== undefined && fact !== '')
  const status = DELEGATION_OUTCOME_WORDS.working
  const where = at > 0 ? checkWaitingSentence(machine, thisComputer, at) : t`Its turn has come, and its thread is being made.`
  const close = (event: React.KeyboardEvent): void => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault(); setOpen(false); head.current?.focus()
  }
  return <li className="subagent-item subagent-item--thread" data-check-waiting="" onKeyDown={close}>
    <div className="delegated-row">
      <button ref={head} type="button" className="subagent-head tt-focusable" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
        aria-label={[title, thisComputer ? t`check on this computer` : t`check on ${machine}`, status].join(', ')} aria-describedby={`${id}-meta`}>
        <span className="subagent-lead delegated-row__mark" data-provider={check.provider}>{check.provider
          ? <ProviderMark provider={check.provider} name={provider ?? t`Provider`} size={15} /> : <span className="delegation-ring" data-outcome="working" aria-hidden="true" />}</span>
        <span className="subagent-main">
          <span className="delegated-row__title-line"><span className="subagent-title" title={title}>{title}</span>
            <span className="delegated-row__marker">{t({ message: 'Check', comment: 'Marks a row in Tools › Agents as a check: a test run that waits its turn on a machine, not a CI check.' })}</span></span>
          <span className="subagent-meta" id={`${id}-meta`}><span className="subagent-model">{meta.join(' · ')}</span></span>
        </span>
        <span className="subagent-right">
          <span className="subagent-time"><ChevronRight size={12} aria-hidden="true" /></span>
          <span className="delegated-row__status" data-outcome="working"><span className="delegation-ring" data-outcome="working" aria-hidden="true" />{status}</span>
        </span>
      </button>
    </div>
    {open ? <div className="subagent-details" id={id}>
      <h3>{t`Latest outcome`}</h3>
      <p className="subagent-result tt-paragraph">{where}</p>
      <CheckQueueList checks={waiting.machine} machine={machine} thisComputer={thisComputer} threadOf={threadOf} current={check.id} />
    </div> : null}
  </li>
})
