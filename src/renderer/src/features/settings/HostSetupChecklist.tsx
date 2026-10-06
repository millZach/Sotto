import { writeClipboard } from '../../agents/richActions'
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Circle, Clock, Copy, LoaderCircle, X } from 'lucide-react'
import { HOST_SETUP_STEPS, type HostAddTailnet, type HostSetupStep, type HostStatus } from '../../../../shared/hosts'
import { Button } from '../../components/Button'
import { TAILSCALE_OPERATOR_COMMAND } from './hostTailnetWords'
import './hostSetup.css'

/** Where "Why Tailscale asks" leads: the guide's section on a tailnet policy's `check` and `accept`. */
export const TAILSCALE_GUIDE_URL = 'https://github.com/millZach/Sotto/blob/main/docs/guide.md#hosts-over-tailscale-ssh'

/** Where Add host stands once pressed: still connecting, stopped at a failed step, or connected and saved. */
export type HostSetupOutcome = 'connecting' | 'failed' | 'connected'
type StepState = 'done' | 'active' | 'waiting' | 'failed' | 'todo'

/** The dialog's title while the checklist shows: where the add stands, in one line. `over` says a host Add host kept on SSH. */
export function hostSetupTitle(name: string, outcome: HostSetupOutcome, over?: 'ssh'): string {
  if (outcome === 'connected') return over === 'ssh' ? `${name} is connected over SSH` : `${name} is connected`
  return outcome === 'failed' ? `${name} could not be added` : `Connecting to ${name}`
}

/**
 * Add host's tailnet step as its checklist shows it (ADR-0053): still to come, under way, done, or the host kept on its SSH
 * connection with why. `error` is the sentence a Try again that failed came back with.
 */
export type TailnetStepView = { readonly state: 'todo' } | HostAddTailnet | { readonly state: 'ssh'; readonly why: 'error'; readonly error: string }

/** What the tailnet step says when the host stayed on SSH: why, and what to do. Only the operator's has a command. */
export function tailnetStepNote(view: Extract<TailnetStepView, { state: 'ssh' }>, name: string, address: string | undefined): { readonly text: string; readonly command?: string } {
  const ssh = `so ${name} is connected over SSH.`
  switch (view.why) {
    case 'operator': return { text: `${name}’s Tailscale Serve needs your SSH account to be Tailscale’s operator there, ${ssh} Run this on ${name}, then press Try again.`, command: TAILSCALE_OPERATOR_COMMAND }
    case 'no-tailscale': return { text: `Tailscale isn’t running on ${name}, ${ssh} Start Tailscale there, then press Try again.` }
    case 'no-address': return { text: `${name} hasn’t said where your tailnet reaches it yet, ${ssh} Sotto tries again every 5 minutes.` }
    case 'old-host': return { text: `The host on ${name} can’t be reached over your tailnet until it is updated, ${ssh} Update it from the Threads page, then press Try again.` }
    case 'refused': return { text: `The host on ${name} didn’t turn on its tailnet connections, ${ssh} Press Try again.` }
    case 'error': return { text: view.error }
    default: return { text: `${name} didn’t answer at ${address ?? 'its tailnet address'}, ${ssh} Sotto tries the tailnet again every 5 minutes.` }
  }
}

/** "forge · user and port from your SSH configuration": what Add host was asked to connect to. */
export function hostSetupSummary(user: string, port: number | undefined): string {
  if (user && port) return `as ${user}, port ${port}`
  if (user) return `as ${user}, port from your SSH configuration`
  if (port) return `port ${port}, user from your SSH configuration`
  return 'user and port from your SSH configuration'
}

/** Each step's name: still to come, under way, done, and failed. */
function stepTitle(step: HostSetupStep, state: StepState, name: string): string {
  const titles: Record<HostSetupStep, readonly [todo: string, active: string, done: string, failed: string]> = {
    reach: [`Reach ${name}`, `Reaching ${name}…`, `Reached ${name}`, `Could not reach ${name}`],
    tailscale: ['Approve in Tailscale', 'Waiting for your approval in Tailscale', 'Approved in Tailscale', 'Not approved in Tailscale'],
    'sign-in': ['Sign in', 'Signing in…', 'Signed in', 'Could not sign in'],
    install: ['Check the host installation', 'Checking the host installation…', 'Host installed', `The host cannot run on ${name} yet`],
    start: ['Start the host', 'Starting the host…', 'Host started', 'The host did not start'],
    pair: ['Pair this computer', 'Pairing this computer…', 'Paired', 'Could not pair this computer'],
  }
  const [todo, active, done, failed] = titles[step]
  return state === 'done' ? done : state === 'failed' ? failed : state === 'todo' ? todo : active
}

const MARK_LABEL: Record<StepState, string> = { done: 'Done', active: 'In progress', waiting: 'Waiting for you', failed: 'Failed', todo: 'Not started' }
function StepMark({ state }: { readonly state: StepState }): ReactNode {
  return <span className="host-setup__mark" data-state={state} role="img" aria-label={MARK_LABEL[state]}>
    {state === 'done' ? <Check size={16} strokeWidth={2.2} aria-hidden="true" />
      : state === 'failed' ? <X size={16} strokeWidth={2.2} aria-hidden="true" />
        : state === 'waiting' ? <Clock size={16} strokeWidth={1.9} aria-hidden="true" />
          : state === 'active' ? <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" className="hosts-spin" />
            : <Circle size={12} strokeWidth={1.7} aria-hidden="true" />}
  </span>
}

/** A command the user runs to fix a failure, with Copy, under the sentence that introduces it when there is one. Sotto never runs it. */
export function FixCommand({ fix }: { readonly fix: { readonly text?: string | undefined; readonly command: string } }): ReactNode {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1500); return () => clearTimeout(timer) }, [copied])
  const copy = async (): Promise<void> => {
    try { await writeClipboard(fix.command); setCopied('copied') } catch { setCopied('failed') }
  }
  return <>
    {fix.text ? <p>{fix.text}</p> : null}
    <div className="host-setup__command">
      <code>{fix.command}</code>
      <Button variant="secondary" aria-label="Copy the command" onClick={() => void copy()}>
        {copied === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === 'copied' ? 'Copied' : 'Copy'}
      </Button>
    </div>
    {copied === 'failed' ? <p className="host-setup__quiet">The command could not be copied. Select it and copy it yourself.</p> : null}
    {/* The button keeps saying what a press does; this says that it worked. */}
    <span className="tt-visually-hidden" role="status">{copied === 'copied' ? 'Copied the command' : ''}</span>
  </>
}

/**
 * The checklist as a host setup thread works through it (ADR-0035). A step that stopped the last check is where
 * the agent is working, so it shows the reason quietly rather than as a failure to act on; a step that passed
 * after an earlier check stopped there reads "by the agent"; and `waiting`, the thread's own wait for the user,
 * sits on the step the setup has reached.
 */
export interface AgentSetupView {
  readonly byAgent: readonly HostSetupStep[]
  /** A card for the step the setup has reached: the thread is waiting for an answer. */
  readonly waiting?: ReactNode
  /** No check has run yet: every step is still to come. */
  readonly idle: boolean
  /** Who is working in which thread, under the line saying what is being set up. */
  readonly line?: ReactNode
}

/**
 * Add host once pressed: the host setup checklist. The form shrinks to a line saying what is being added,
 * and each step says whether it is done, under way, waiting for the user, failed or still to come. A failure
 * shows on its own step with main's sentence (what happened, that nothing was saved, what to do) and a
 * command to copy where there is one. SSH's own questions sit on the step that asked them.
 */
export function HostSetupChecklist({ name, summary, host, outcome, error, approvalError, question, onChange, onOpenApproval, onOpenGuide, agent, offer, tailnet, boot }: {
  /** The host part of the target, which names the host until it is renamed. */
  readonly name: string
  /** What was asked for besides the host: `hostSetupSummary()`. */
  readonly summary: string
  /** The connect as main reports it: Add host's attempt, or the saved host once it is added. */
  readonly host: HostStatus | undefined
  readonly outcome: HostSetupOutcome
  /** Main's failure sentence, or one from the dialog itself. */
  readonly error: string | null
  /** Why Open approval page did not open, shown on the Tailscale card while Tailscale still waits. */
  readonly approvalError?: string | null | undefined
  /** SSH's question (a host key, a password or a passphrase), shown on the step that is asking. */
  readonly question?: ReactNode
  /** Back to the form; the attempt is dropped first. Absent once the host is added. */
  readonly onChange?: (() => void) | undefined
  readonly onOpenApproval: () => void
  readonly onOpenGuide: () => void
  /** Set while a host setup thread works through the checklist rather than Add host itself. */
  readonly agent?: AgentSetupView | undefined
  /** Under a failed step's sentence and command: Have my agent fix this, with its model picker. */
  readonly offer?: ReactNode
  /** Add host's own add ends with its tailnet step, after Paired (ADR-0053); a setup's add has none. */
  readonly tailnet?: TailnetStepView | undefined
  /** On the connected card: the offer to start the host at boot, or what came of it (ADR-0054). */
  readonly boot?: ReactNode
}): ReactNode {
  const approval = useRef<HTMLButtonElement>(null)
  const approvalUrl = host?.tailscale?.waiting ? host.tailscale.url : undefined
  // Tailscale's approval is the one thing to do while it waits, so focus goes to it when it arrives.
  useEffect(() => { if (approvalUrl) approval.current?.focus() }, [approvalUrl])
  // Once the tailnet step has begun, every step before it is done.
  const pastPairing = tailnet !== undefined && tailnet.state !== 'todo'
  const current: HostSetupStep | undefined = outcome === 'connected' || pastPairing ? undefined : agent?.idle ? 'reach' : host?.step ?? 'reach'
  const steps = HOST_SETUP_STEPS.filter(step => step !== 'tailscale' || host?.tailscale !== undefined || current === 'tailscale')
  const at = current === undefined ? steps.length : steps.indexOf(current)
  const waiting = outcome === 'connecting' && host?.tailscale?.waiting === true
  // Tailscale can hold the port forward too, after the host started; its approval shows on the Tailscale step,
  // with the 30 seconds the forward's keepalive gives it rather than the 5 minutes a sign-in gets.
  const forwardHeld = waiting && current !== 'tailscale'
  // For the agent, a check that got as far as starting the host leaves Pair still to come, and nothing runs until
  // it adds the host; a check that stopped leaves its step with the agent, which works on it.
  const agentPaused = agent !== undefined && (agent.idle || host?.checked === true || host?.phase === 'error')
  const stateOf = (index: number, step: HostSetupStep): StepState => {
    if (step === 'tailscale' && waiting) return 'waiting'
    if (index < at) return 'done'
    if (index > at) return 'todo'
    if (agentPaused) return 'todo'
    if (outcome === 'failed') return 'failed'
    return 'active'
  }
  // Said to a screen reader as the connect moves on; the failure and the connected card speak for themselves.
  const progress = outcome !== 'connecting' ? '' : waiting ? stepTitle('tailscale', 'waiting', name) : current ? stepTitle(current, 'active', name)
    : tailnet?.state === 'active' ? tailnetStepTitle('active', name) : ''
  const over = tailnet?.state === 'done' ? ' over your tailnet' : tailnet?.state === 'ssh' ? ' over SSH' : ''
  return <div className="host-setup">
    <span className="tt-visually-hidden" role="status">{progress}</span>
    <div className="host-setup__summary">
      <p><b>{name}</b> <span>· {summary}</span></p>
      {onChange ? <Button variant="ghost" onClick={onChange} aria-label={outcome === 'connecting' ? 'Change the host to add, and stop connecting' : 'Change the host to add'}>Change</Button> : null}
    </div>
    {agent?.line}
    <ol className="host-setup__steps" aria-label="Connection steps">
      {steps.map((step, index) => {
        const state = stateOf(index, step)
        // While Tailscale waits, that is where the user is, whichever step the connect is on.
        const reached = agent !== undefined && index === at
        return <li key={step} data-state={state} aria-current={state === 'waiting' || (state === 'active' && !waiting) || (reached && agent.waiting) ? 'step' : undefined}>
          <StepMark state={state} />
          <span className="host-setup__title">{stepTitle(step, state, name)}{state === 'done' && agent?.byAgent.includes(step) ? <span className="host-setup__by"> by the agent</span> : null}</span>
          {reached && host?.phase === 'error' && error ? <div className="host-setup__detail"><p className="host-setup__note">The last check stopped here. {error}</p></div> : null}
          {reached && agent.waiting ? <div className="host-setup__detail">{agent.waiting}</div> : null}
          {state === 'waiting' ? <div className="host-setup__detail"><div className="hosts-notice host-setup__card" role="status">
            <p>{forwardHeld
              ? `${name} uses Tailscale SSH, which asks you to approve the port forward as well. Approve it in your browser within 30 seconds and Sotto carries on.`
              : `${name} uses Tailscale SSH, which asks you to approve new connections in your browser. Sotto waits up to 5 minutes and carries on when you approve.`}</p>
            <div className="host-setup__actions">
              {approvalUrl ? <Button ref={approval} onClick={onOpenApproval}>Open approval page</Button> : null}
              <button type="button" className="host-setup__link tt-focusable" onClick={onOpenGuide}>Why Tailscale asks</button>
            </div>
            {approvalError ? <p className="host-setup__problem" role="alert">{approvalError}</p> : null}
          </div></div> : null}
          {state === 'active' && question ? <div className="host-setup__detail">{question}</div> : null}
          {state === 'failed' && error ? <div className="host-setup__detail"><div className="hosts-notice hosts-notice--error host-setup__card" role="alert">
            <p>{error}</p>
            {host?.fix ? <FixCommand fix={host.fix} /> : null}
            {offer}
          </div></div> : null}
        </li>
      })}
      {tailnet ? <TailnetStep view={tailnet} name={name} address={host?.tailnetAddress} /> : null}
    </ol>
    {outcome === 'connecting' && error && !agent ? <div className="hosts-notice hosts-notice--error host-setup__card" role="alert"><p>{error}</p></div> : null}
    {outcome === 'connected' && !agent ? <div className="hosts-notice host-setup__card host-setup__card--done" role="status">
      <p>{host?.name ?? name} is added and connected{over}. Its projects and threads show in the Threads sidebar with a {host?.name ?? name} badge.</p>
      {boot}
    </div> : null}
  </div>
}

/** Each state's title for the tailnet step. */
function tailnetStepTitle(state: TailnetStepView['state'], name: string): string {
  return state === 'active' ? `Reaching ${name} over your tailnet…` : state === 'done' ? `Reached ${name} over your tailnet`
    : state === 'ssh' ? `Could not reach ${name} over your tailnet` : `Reach ${name} over your tailnet`
}

/**
 * Add host's tailnet step (ADR-0053): Sotto turns on Tailscale Serve on the host, which the press on Add host consented to,
 * and moves the socket to the tailnet. A host it cannot move is still added, on its SSH connection, and the step says why.
 */
function TailnetStep({ view, name, address }: { readonly view: TailnetStepView; readonly name: string; readonly address: string | undefined }): ReactNode {
  const state: StepState = view.state === 'ssh' ? 'failed' : view.state
  const note = view.state === 'ssh' ? tailnetStepNote(view, name, address) : undefined
  return <li data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
    <StepMark state={state} />
    <span className="host-setup__title">{tailnetStepTitle(view.state, name)}</span>
    {view.state === 'active' ? <div className="host-setup__detail"><p className="host-setup__note">Sotto turns on Tailscale Serve on {name}, on your tailnet only, and tries the address {name} reports. If it doesn’t answer, {name} is still added and connects over SSH.</p></div> : null}
    {view.state === 'done' && address ? <div className="host-setup__detail"><p className="host-setup__note host-setup__address">{address}</p></div> : null}
    {note?.command ? <div className="host-setup__detail"><div className="hosts-notice hosts-notice--error host-setup__card"><FixCommand fix={{ text: note.text, command: note.command }} /></div></div>
      : note ? <div className="host-setup__detail"><p className="host-setup__note">{note.text}</p></div> : null}
  </li>
}
