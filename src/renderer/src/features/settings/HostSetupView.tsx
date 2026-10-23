import React, { useId, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { HostSetupChoice, HostSetupState } from '../../../../shared/hosts'
import { Button } from '../../components/Button'
import { HostSetupChecklist, hostSetupSummary, type HostSetupOutcome } from './HostSetupChecklist'

/** How Add host adds the host: an agent sets the machine up first, or Sotto connects to a host already there. */
export type HostAddChoice = 'agent' | 'self'

/** The setup thread's model: this computer's ready models, by provider, starting on the one used most. */
export function SetupModelSelect({ choice, value, onChange, label, disabled, describedBy }: {
  readonly choice: HostSetupChoice; readonly value: string; readonly onChange: (id: string) => void
  /** The field's name; Model unless given. */
  readonly label?: string; readonly disabled?: boolean; readonly describedBy?: string
}): ReactNode {
  const { t } = useLingui()
  const id = useId()
  const providers = [...new Set(choice.models.map(model => model.provider))]
  return <span className="host-setup__model">
    <label htmlFor={id}>{label ?? t({ message: 'Model', comment: 'The AI model an agent runs on.' })}</label>
    <select id={id} className="tt-select tt-focusable" value={value} disabled={disabled} aria-describedby={describedBy} onChange={event => onChange(event.target.value)}>
      {providers.length > 1
        ? providers.map(provider => <optgroup key={provider} label={provider}>{choice.models.filter(model => model.provider === provider).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</optgroup>)
        : choice.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select>
  </span>
}

/**
 * The two ways Add host adds a machine (ADR-0035, placement A2). Native radios, so the arrow keys move between
 * them and Tab leaves the group; the model picker sits inside the agent's choice while it is chosen.
 */
export function HostAddChoices({ value, onChange, choice, modelId, onModel, disabled }: {
  readonly value: HostAddChoice; readonly onChange: (value: HostAddChoice) => void
  readonly choice: HostSetupChoice | undefined; readonly modelId: string; readonly onModel: (id: string) => void
  readonly disabled: boolean
}): ReactNode {
  const { t } = useLingui()
  const name = useId()
  const agentAvailable = choice !== undefined && !choice.unavailable && choice.models.length > 0
  const agentHint = useId(), selfHint = useId(), agentName = useId(), selfName = useId()
  return <div className="host-setup__choices" role="radiogroup" aria-label={t`How to add the host`}>
    <label className="host-setup__choice" data-checked={value === 'agent' || undefined} data-disabled={!agentAvailable || undefined}>
      <input type="radio" name={name} value="agent" checked={value === 'agent'} disabled={disabled || !agentAvailable} aria-labelledby={agentName} aria-describedby={agentHint}
        className="tt-focusable" onChange={() => onChange('agent')} />
      <span className="host-setup__choice-name" id={agentName}>{t`Have my agent set this up`}</span>
      <span className="host-setup__choice-text" id={agentHint}>{agentAvailable
        ? t`For a machine without the host yet. The agent installs it, fixes what is missing and adds the host. It works in a new thread, and you answer each command it wants to run.`
        : choice?.unavailable ?? t`An agent cannot set up a host from this window.`}</span>
    </label>
    {value === 'agent' && agentAvailable ? <div className="host-setup__choice-row"><SetupModelSelect choice={choice} value={modelId} onChange={onModel} disabled={disabled} /></div> : null}
    <label className="host-setup__choice" data-checked={value === 'self' || undefined}>
      <input type="radio" name={name} value="self" checked={value === 'self'} disabled={disabled} aria-labelledby={selfName} aria-describedby={selfHint}
        className="tt-focusable" onChange={() => onChange('self')} />
      <span className="host-setup__choice-name" id={selfName}>{t`Add it`}</span>
      <span className="host-setup__choice-text" id={selfHint}><Trans>For a machine that already has the host. Sotto connects now and says what to fix if a step fails.</Trans></span>
    </label>
  </div>
}

/** The setup view's title: where the setup stands, in one line. */
export function hostSetupViewTitle(setup: HostSetupState): string {
  const name = setup.name
  if (setup.phase === 'connected') return i18n._(msg`${name} is connected`)
  if (setup.phase === 'stopped') return i18n._(msg`Setup of ${name} stopped`)
  if (setup.phase === 'failed') return i18n._(msg`${name} could not be set up`)
  return i18n._(msg`Setting up ${name}`)
}
const ended = (setup: HostSetupState): boolean => setup.phase === 'connected' || setup.phase === 'stopped' || setup.phase === 'failed'

/**
 * Add host while an agent sets the machine up (ADR-0035, round 3 moments 6 and 7): who is working in which thread,
 * the checklist following the thread's checks and add, a card on the step when the thread waits for an answer, and
 * what happened once it ends. SSH's questions and Tailscale's approval sit on their steps, as in Add host.
 */
export function HostSetupProgress({ setup, question, approvalError, onOpenThread, onOpenApproval, onOpenGuide }: {
  readonly setup: HostSetupState
  readonly question: ReactNode
  readonly approvalError: string | null
  readonly onOpenThread: () => void
  readonly onOpenApproval: () => void
  readonly onOpenGuide: () => void
}): ReactNode {
  const { t } = useLingui()
  const { name, modelName: model, threadTitle: thread } = setup
  const attempt = setup.attempt
  const target = setup.target.includes('@') ? setup.target.slice(0, setup.target.lastIndexOf('@')) : ''
  const outcome: HostSetupOutcome = setup.phase === 'connected' ? 'connected' : 'connecting'
  const openThread = <Button variant="secondary" disabled={!setup.threadId} onClick={onOpenThread}>{t`Open thread`}</Button>
  // SSH's question and Tailscale's approval sit on their own steps; these cards are for answers the thread holds.
  const waiting = (setup.waiting === 'command' || setup.waiting === 'add') && !ended(setup) ? <div className="hosts-notice host-setup__card" role="status">
    <p>{setup.waiting === 'add' ? t`Sotto is asking in the thread whether to add ${name} as a host. Answer it there to carry on.`
      : t`The agent wants to run a command on ${name}. Answer it in the thread to carry on.`}</p>
    <div className="host-setup__actions">{openThread}</div>
  </div> : undefined
  const line = !ended(setup) ? <div className="host-setup__agent">
    <p>{setup.phase === 'starting'
      ? <Trans>Starting the thread <b>{thread}</b> on <b>{model}</b>.</Trans>
      : <Trans><b>{model}</b> is setting up {name} in the thread <b>{thread}</b>. You answer each command it wants to run.</Trans>}</p>
    {openThread}
  </div> : undefined
  return <>
    <HostSetupChecklist name={setup.name} summary={hostSetupSummary(target, setup.sshPort)} host={attempt} outcome={outcome}
      error={attempt?.phase === 'error' ? attempt.error ?? null : null} approvalError={approvalError} question={question}
      onOpenApproval={onOpenApproval} onOpenGuide={onOpenGuide}
      agent={{ byAgent: setup.byAgent, waiting, line, idle: attempt === undefined && setup.phase !== 'connected' }} />
    {setup.phase === 'connected' ? <div className="hosts-notice host-setup__card host-setup__card--done" role="status">
      <p><Trans>{name} is added and connected. {model} set it up in <button type="button" className="host-setup__link tt-focusable" onClick={onOpenThread}>{thread}</button>; the thread stays in your Threads list until you archive it.</Trans></p>
    </div> : null}
    {setup.phase === 'stopped' ? <div className="hosts-notice host-setup__card" role="status">
      <p>{t`Setup stopped.`} {setup.error ?? t`Nothing was saved as a host.`} {t`Anything the agent installed on ${name} stays there, and the thread ${thread} stays in your Threads list.`}</p>
      {setup.threadId ? <div className="host-setup__actions">{openThread}</div> : null}
    </div> : null}
    {setup.phase === 'failed' ? <div className="hosts-notice hosts-notice--error host-setup__card" role="alert">
      <p>{setup.error ?? t`The setup could not carry on. Nothing was saved as a host.`}</p>
      {setup.threadId ? <div className="host-setup__actions">{openThread}</div> : null}
    </div> : null}
  </>
}

/** Whether the setup is over, so its dialog offers Done rather than Close and Stop setup. */
export const hostSetupEnded = ended
