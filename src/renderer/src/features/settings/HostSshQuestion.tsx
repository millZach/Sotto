import { isCompositionKey } from '../../agents/composerKeys'
import React, { useEffect, useId, useState, type ReactNode } from 'react'
import type { HostStatus } from '../../../../shared/hosts'
import { Button } from '../../components/Button'

/**
 * SSH's question inside a Hosts dialog whose press is signing in, asked there because the question over the page waits
 * while a Hosts dialog is open: the host key to trust, or the password or passphrase to type. `onAnswer` sends it on and
 * says what went wrong itself; `actions` sits beside the answer, such as a press that stops signing in.
 */
export function HostSshQuestion({ prompt, onAnswer, actions }: {
  readonly prompt: NonNullable<HostStatus['prompt']>
  readonly onAnswer: (answer: string) => Promise<void>
  readonly actions?: ReactNode
}): ReactNode {
  const [answer, setAnswer] = useState('')
  const [answering, setAnswering] = useState(false)
  const answerId = useId()
  const hostKey = prompt.kind === 'host-key'
  useEffect(() => { setAnswer('') }, [prompt.id])
  const send = async (): Promise<void> => {
    if (answering) return
    setAnswering(true)
    try { await onAnswer(hostKey ? 'yes' : answer) }
    finally { setAnswer(''); setAnswering(false) }
  }
  return <div className="hosts-notice hosts-prompt" role="group" aria-label={hostKey ? 'Trust this SSH host?' : 'SSH needs an answer'}>
    <p className="hosts-prompt__lead">{hostKey ? 'SSH has not seen this host before. Check its key, then trust it to continue.' : prompt.kind === 'passphrase' ? 'SSH needs your key passphrase to sign in.' : 'SSH needs your password to sign in.'}</p>
    <pre className="hosts-challenge">{prompt.text}</pre>
    {!hostKey ? <div className="tt-field"><label className="tt-field__label" htmlFor={answerId}>{prompt.kind === 'passphrase' ? 'Key passphrase' : 'SSH password'}</label>
      <input id={answerId} className="tt-input tt-focusable" type="password" autoComplete="off" autoFocus value={answer} onChange={event => setAnswer(event.target.value)}
        onKeyDown={event => { if (isCompositionKey(event.nativeEvent)) { event.stopPropagation(); return } if (event.key === 'Enter') { event.preventDefault(); void send() } }} /></div> : null}
    <div className="hosts-prompt__actions"><Button autoFocus={hostKey} disabled={answering} onClick={() => void send()}>{hostKey ? 'Trust host and continue' : 'Continue'}</Button>{actions}</div>
  </div>
}
