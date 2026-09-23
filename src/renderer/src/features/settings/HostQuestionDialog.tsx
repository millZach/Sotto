import React, { useEffect, useState, type ReactNode } from 'react'
import type { HostsBridge, HostsCommand, HostsState } from '../../../../shared/hosts'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { useHostsModalOpen } from './HostDialog'
import './hosts.css'

/**
 * SSH's question for a saved host that is connecting on its own: at launch, after a drop, or after a
 * switch-on. It is asked over whichever page is open, because a host reconnects wherever the user is and
 * SSH stops waiting after a while. Add host asks its own questions in its dialog, and this one waits while
 * a Hosts dialog is open so the two never stack.
 */
export function HostQuestionDialog({ bridge = window.sotto?.hosts }: { readonly bridge?: HostsBridge | undefined }): ReactNode {
  const [state, setState] = useState<HostsState | null>(null)
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const hostsDialogOpen = useHostsModalOpen()
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }, () => undefined)
    const off = bridge.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; off() }
  }, [bridge])
  const host = state?.hosts.find(item => item.prompt)
  const prompt = host?.prompt
  useEffect(() => { setAnswer(''); setError(null) }, [prompt?.id])
  if (!bridge || !host || !prompt || hostsDialogOpen) return null
  const run = async (command: HostsCommand, failure: string): Promise<void> => {
    setError(null)
    try { setState(await bridge.command(command)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : failure) }
  }
  const hostKey = prompt.kind === 'host-key'
  return <ConfirmationDialog key={prompt.id} danger={false}
    title={hostKey ? `Trust the SSH host ${host.name}?` : `Unlock the SSH connection to ${host.name}`}
    confirmLabel={hostKey ? 'Trust host' : 'Continue'} cancelLabel="Switch it off"
    onCancel={() => { setAnswer(''); void run({ type: 'set-enabled', id: host.id, enabled: false }, `${host.name} could not be switched off. Try again in Settings > Hosts.`) }}
    // The dialog stays until main clears the question, which it does once SSH has the answer.
    onConfirm={async () => { await run({ type: 'ssh-answer', id: host.id, promptId: prompt.id, answer: hostKey ? 'yes' : answer }, 'SSH did not take the answer. Switch the host off and on to try again.'); setAnswer(''); return false }}
    {...(error ? { failureMessage: error } : {})}
    description={<div className="hosts-dialog__fields">
      <p>{hostKey ? `Sotto is connecting to ${host.name}, and SSH has not seen this host before. Check its key, then trust it to continue.`
        : `Sotto is connecting to ${host.name}, and SSH needs your ${prompt.kind === 'passphrase' ? 'key passphrase' : 'password'} to sign in.`}</p>
      <pre className="hosts-challenge">{prompt.text}</pre>
      {!hostKey && <div className="tt-field"><label className="tt-field__label" htmlFor="hosts-prompt-answer">{prompt.kind === 'passphrase' ? 'Key passphrase' : 'SSH password'}</label>
        <input id="hosts-prompt-answer" className="tt-input tt-focusable" type="password" autoComplete="off" value={answer} onChange={event => setAnswer(event.target.value)} /></div>}
    </div>} />
}
