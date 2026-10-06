import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HostsBridge, HostsCommand, HostsState, HostStatus } from '../../../../shared/hosts'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { useHostsModalOpen } from './HostDialog'
import { hostQuestionKey, useHostQuestionDismissals } from './hostQuestionDismissals'
import './hosts.css'

/**
 * The check or add a running host setup is waiting on the user for, if any (ADR-0035): SSH's question, or a
 * Tailscale approval with its page. The setup's thread cannot say so itself while its tool call waits.
 */
function setupWait(state: HostsState | null): HostStatus | undefined {
  const setup = state?.setup
  if (!setup || (setup.phase !== 'starting' && setup.phase !== 'running')) return undefined
  const attempt = setup.attempt
  return attempt?.phase === 'connecting' && (attempt.prompt || (attempt.tailscale?.waiting && attempt.tailscale.url)) ? attempt : undefined
}

/**
 * SSH's question for a saved host that is connecting on its own: at launch, after a drop, or after a
 * switch-on. It is asked over whichever page is open, because a host reconnects wherever the user is and
 * SSH stops waiting after a while. A host setup's check or add asks its SSH question, or Tailscale's approval,
 * the same way, with Not now to answer it later from Show setup. Add host asks its own questions in its
 * dialog, and this one waits while a Hosts dialog is open so the two never stack.
 */
export function HostQuestionDialog({ bridge = window.sotto?.hosts }: { readonly bridge?: HostsBridge | undefined }): ReactNode {
  const [state, setState] = useState<HostsState | null>(null)
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const hostsDialogOpen = useHostsModalOpen()
  const answerRef = useRef<HTMLInputElement>(null)
  const hostKeyRef = useRef<HTMLPreElement>(null)
  const fallbackFocusRef = useRef<HTMLElement | null>(null)
  // Keep the page's focus across consecutive questions: the next dialog may inherit body.
  useEffect(() => {
    const remember = (): void => {
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body && !active.closest('[role="dialog"]')) fallbackFocusRef.current = active
    }
    remember()
    document.addEventListener('focusin', remember)
    return () => document.removeEventListener('focusin', remember)
  }, [])
  if (!fallbackFocusRef.current?.isConnected) fallbackFocusRef.current = document.querySelector<HTMLElement>('[aria-current="page"], [role="tab"][aria-selected="true"]')
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }, () => undefined)
    const off = bridge.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; off() }
  }, [bridge])
  /** Dismiss only this question, so other hosts and new questions can still ask. */
  const { dismissedQuestionKeys, dismissQuestion, focusAnswer } = useHostQuestionDismissals(bridge)
  const saved = state?.hosts.find(item => item.prompt && !dismissedQuestionKeys.has(hostQuestionKey(item)!))
  const waiting = saved ? undefined : setupWait(state)
  const setupKey = waiting ? hostQuestionKey(waiting) ?? `tailscale:${waiting.id}` : null
  const savedKey = saved ? hostQuestionKey(saved) : null
  const host = saved ?? (setupKey && !dismissedQuestionKeys.has(setupKey) ? waiting : undefined)
  const prompt = host?.prompt
  useEffect(() => { setAnswer(''); setError(null) }, [savedKey, prompt?.id, setupKey])
  if (!bridge || !host || hostsDialogOpen) return null
  const run = async (command: HostsCommand, failure: string): Promise<boolean> => {
    setError(null)
    try { setState(await bridge.command(command)); return true }
    catch (reason) { setError(reason instanceof Error ? reason.message : failure); return false }
  }
  const dismiss = (): void => {
    setAnswer('')
    const key = savedKey ?? setupKey
    if (key) dismissQuestion(key)
    // The row's Answer button exists after the dismissal renders. A following dialog takes priority.
    if (savedKey) queueMicrotask(() => {
      if (document.querySelector('[role="dialog"]')) return
      focusAnswer(savedKey)
    })
  }
  if (!saved) {
    const name = state?.setup?.name ?? host.name
    const putOff = ' Not now leaves it waiting, and Show setup in Settings > Hosts has it too.'
    if (!prompt) return <ConfirmationDialog key={setupKey} danger={false} fallbackFocusRef={fallbackFocusRef} title={`Approve the connection to ${name} in Tailscale`}
      confirmLabel="Open approval page" cancelLabel="Not now" onCancel={dismiss}
      onConfirm={() => run({ type: 'open-approval', id: host.id }, 'The approval page could not open. Nothing was changed. Try again.')}
      {...(error ? { failureMessage: error } : {})}
      description={<p>{`An agent is setting up ${name}, and Tailscale SSH asks you to approve this computer's connection before the setup goes on. Open the approval page and approve it in your browser.${putOff}`}</p>} />
    const hostKey = prompt.kind === 'host-key'
    return <ConfirmationDialog key={setupKey} danger={false} confirmFirst submitOnEnter={!hostKey} initialFocus={hostKey ? hostKeyRef : answerRef} fallbackFocusRef={fallbackFocusRef}
      title={hostKey ? `Trust the SSH host ${name}?` : `Unlock the SSH connection to ${name}`}
      confirmLabel={hostKey ? 'Trust host' : 'Continue'} cancelLabel="Not now" onCancel={dismiss}
      // The dialog stays until main clears the question, which it does once SSH has the answer.
      onConfirm={async () => { await run({ type: 'ssh-answer', id: host.id, promptId: prompt.id, answer: hostKey ? 'yes' : answer }, 'SSH did not take the answer. Answer it again from Show setup in Settings > Hosts.'); setAnswer(''); return false }}
      {...(error ? { failureMessage: error } : {})}
      description={<div className="hosts-dialog__fields">
        <p>{(hostKey ? `An agent is setting up ${name}, and SSH has not seen this host before. Check its key, then trust it to continue.`
          : `An agent is setting up ${name}, and SSH needs your ${prompt.kind === 'passphrase' ? 'key passphrase' : 'password'} to sign in.`) + putOff}</p>
        <pre ref={hostKeyRef} className="hosts-challenge" role={hostKey ? 'region' : undefined} aria-label={hostKey ? 'SSH host key' : undefined} tabIndex={hostKey ? 0 : undefined}>{prompt.text}</pre>
        {!hostKey && <div className="tt-field"><label className="tt-field__label" htmlFor="hosts-prompt-answer">{prompt.kind === 'passphrase' ? 'Key passphrase' : 'SSH password'}</label>
          <input ref={answerRef} id="hosts-prompt-answer" className="tt-input tt-focusable" type="password" autoComplete="off" value={answer} onChange={event => setAnswer(event.target.value)} /></div>}
      </div>} />
  }
  if (!prompt) return null
  const hostKey = prompt.kind === 'host-key'
  // An admin connection's sign-in (ADR-0053) is for a press the user made, not the host's own connect: stopping it
  // changes nothing on the host and leaves the switch alone.
  const admin = host.adminSignIn === true
  const why = admin ? `Sotto is signing in to ${host.name} for a change you asked for there` : `Sotto is connecting to ${host.name}`
  return <ConfirmationDialog key={savedKey} danger={false} confirmFirst submitOnEnter={!hostKey} initialFocus={hostKey ? hostKeyRef : answerRef} fallbackFocusRef={fallbackFocusRef}
    title={hostKey ? `Trust the SSH host ${host.name}?` : `Unlock the SSH connection to ${host.name}`}
    confirmLabel={hostKey ? 'Trust host' : 'Continue'} cancelLabel={admin ? 'Stop signing in' : 'Switch it off'}
    onDismiss={dismiss}
    onCancel={() => {
      setAnswer('')
      if (admin) void run({ type: 'stop-admin-sign-in', id: host.id }, `Sotto could not stop signing in to ${host.name}. Try again in Settings > Hosts.`)
      else void run({ type: 'set-enabled', id: host.id, enabled: false }, `${host.name} could not be switched off. Try again in Settings > Hosts.`)
    }}
    // The dialog stays until main clears the question, which it does once SSH has the answer.
    onConfirm={async () => { await run({ type: 'ssh-answer', id: host.id, promptId: prompt.id, answer: hostKey ? 'yes' : answer }, 'SSH did not take the answer. Switch the host off and on to try again.'); setAnswer(''); return false }}
    {...(error ? { failureMessage: error } : {})}
    description={<div className="hosts-dialog__fields">
      <p>{hostKey ? `${why}, and SSH has not seen this host before. Check its key, then trust it to continue.`
        : `${why}, and SSH needs your ${prompt.kind === 'passphrase' ? 'key passphrase' : 'password'} to sign in.`}</p>
      <pre ref={hostKeyRef} className="hosts-challenge" role={hostKey ? 'region' : undefined} aria-label={hostKey ? 'SSH host key' : undefined} tabIndex={hostKey ? 0 : undefined}>{prompt.text}</pre>
      {!hostKey && <div className="tt-field"><label className="tt-field__label" htmlFor="hosts-prompt-answer">{prompt.kind === 'passphrase' ? 'Key passphrase' : 'SSH password'}</label>
        <input ref={answerRef} id="hosts-prompt-answer" className="tt-input tt-focusable" type="password" autoComplete="off" value={answer} onChange={event => setAnswer(event.target.value)} /></div>}
    </div>} />
}
