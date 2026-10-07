import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { writeClipboard } from '../../agents/richActions'
import { isCompositionKey } from '../../agents/composerKeys'
import { PROVIDER_LABELS, type ProviderId } from '../../../../shared/agents'
import type { HostsBridge, HostStatus } from '../../../../shared/hosts'
import { PASTED_CODE_MAX, type ProviderSignInView } from '../../../../shared/hostProviders'
import { Button } from '../../components/Button'
import { HostsModal } from './HostsModal'

/** How often the dialog asks the host where a sign-in stands while it waits for the user or the client. */
const READ_EVERY_MS = 1500
/** Reads in a row a host can fail to answer before the dialog says it stopped answering. */
const READ_MISSES = 2
const clean = (failure: unknown, fallback: string): string =>
  failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '').trim() || fallback : fallback
const running = (view: ProviderSignInView | null): boolean => view !== null && (view.stage === 'starting' || view.stage === 'waiting' || view.stage === 'finishing')

/** "W D J B, dash, M J H T": a code read out one character at a time, so a screen reader does not say it as a word. */
function spelled(code: string): string { return [...code].map(character => character === '-' ? 'dash' : character).join(' ') }

/**
 * Sign in to a provider on a host, from this computer (ADR-0037). The provider's own client runs on the host; the user
 * finishes in this computer's browser, either by entering the code shown here (Codex, Grok Build) or by pasting back the
 * code the page shows (Claude Code). Cancel and Escape stop the sign-in on the host; nothing is kept on this computer.
 */
export function HostProviderSignIn({ host, provider, bridge, onClose }: {
  readonly host: HostStatus; readonly provider: ProviderId; readonly bridge: HostsBridge; readonly onClose: () => void
}): ReactNode {
  const name = PROVIDER_LABELS[provider]
  const [view, setView] = useState<ProviderSignInView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const fieldId = useId(), hintId = useId()
  const field = useRef<HTMLInputElement>(null)
  const current = useRef<ProviderSignInView | null>(null)
  current.current = view

  // Start, and start again on Try again. A sign-in still running when the dialog goes is stopped on the host, including
  // one whose start answers only after the dialog has gone (Escape while it still says Starting).
  useEffect(() => {
    let alive = true
    setView(null); setError(null); setOpened(false); setCode(''); setCodeError(null)
    bridge.signIn({ type: 'start', id: host.id, provider }).then(started => {
      if (alive) { setView(started); return }
      if (started && running(started)) void bridge.signIn({ type: 'cancel', id: host.id, signInId: started.id }).catch(() => undefined)
    }, failure => { if (alive) setError(clean(failure, `${name} could not start signing in on ${host.name}. Nothing was changed. Try again.`)) })
    return () => { alive = false }
  }, [attempt, bridge, host.id, host.name, name, provider])
  useEffect(() => () => { const last = current.current; if (last && running(last)) void bridge.signIn({ type: 'cancel', id: host.id, signInId: last.id }).catch(() => undefined) }, [bridge, host.id])

  // While it runs, follow it: a device code is finished on the page, and a pasted code by the client on the host.
  // A host that fails to answer twice in a row is said to have stopped answering, rather than left waiting for ever.
  const signInId = view?.id, stage = view?.stage
  useEffect(() => {
    if (!signInId || !stage || !running(view) || error) return
    let alive = true, missed = 0
    const timer = setInterval(() => {
      void bridge.signIn({ type: 'read', id: host.id, signInId }).then(next => {
        if (!alive) return
        missed = 0
        setView(next ?? { id: signInId, provider, shape: view!.shape, stage: 'ended' })
      }, () => {
        if (!alive || ++missed < READ_MISSES) return
        setError(`${host.name} stopped answering while ${name} was signing in. If its tile still says Not signed in, try again.`)
      })
    }, READ_EVERY_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [bridge, error, host.id, host.name, name, provider, signInId, stage])

  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1500); return () => clearTimeout(timer) }, [copied])
  useEffect(() => { if (opened) field.current?.focus() }, [opened])
  // Focus follows the sign-in to the control its new step is for: Open sign-in page, Try again or Done.
  const anchor = useRef<HTMLDivElement>(null)
  const shown = error ? 'error' : view?.stage ?? 'none'
  useEffect(() => {
    if (shown === 'none' || shown === 'starting' || shown === 'finishing') return
    // After the dialog's own first focus and anything else this change set in motion, so the step's control keeps it.
    const timer = setTimeout(() => { anchor.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)')?.focus() }, 0)
    return () => clearTimeout(timer)
  }, [shown])

  const open = async (): Promise<void> => {
    if (!view) return
    setBusy(true)
    try { await bridge.signIn({ type: 'open', id: host.id, signInId: view.id }); setOpened(true) }
    catch (failure) { setError(clean(failure, 'The sign-in page could not open. Nothing was changed. Try again.')) }
    finally { setBusy(false) }
  }
  const finish = async (): Promise<void> => {
    if (!view || !code.trim() || busy) return
    setBusy(true); setCodeError(null)
    try { const next = await bridge.signIn({ type: 'code', id: host.id, signInId: view.id, code: code.trim() }); setCode(''); if (next) setView(next) }
    catch (failure) { setCodeError(clean(failure, 'The code could not be sent. Nothing was changed. Try again.')) }
    finally { setBusy(false) }
  }
  const copy = async (value: string): Promise<void> => { try { await writeClipboard(value); setCopied('copied') } catch { setCopied('failed') } }
  const tryAgain = (): void => setAttempt(value => value + 1)
  const close = (): void => { onClose() }

  const body = (): ReactNode => {
    if (error) return <div className="hosts-notice hosts-notice--error" role="alert"><p>{error}</p></div>
    if (!view || view.stage === 'starting') return <div className="hosts-notice" role="status"><LoaderCircle size={16} aria-hidden="true" className="hosts-spin" /><p>Starting {name}'s sign-in on {host.name}…</p></div>
    if (view.stage === 'finishing') return <div className="hosts-notice" role="status"><LoaderCircle size={16} aria-hidden="true" className="hosts-spin" /><p>Finishing sign-in on {host.name}, then connecting {name}…</p></div>
    if (view.stage === 'connected') return <div className="hosts-notice host-sign-in__done" role="status"><Check size={16} aria-hidden="true" /><p>{name} is signed in and connected on {host.name}.</p></div>
    if (view.stage === 'refused') return <div className="hosts-notice hosts-notice--error" role="alert"><p>{name} did not accept that code, so {host.name} is still not signed in. Open the sign-in page again for a new code.</p></div>
    if (view.stage === 'failed') return <div className="hosts-notice hosts-notice--error" role="alert"><p>{view.message ?? `${name} could not finish signing in on ${host.name}. Nothing was changed.`}</p></div>
    if (view.stage === 'ended') return <div className="hosts-notice hosts-notice--error" role="alert"><p>The sign-in on {host.name} ended before it was finished. Nothing was signed in.</p></div>
    const page = view.page ?? 'the sign-in page'
    if (view.shape === 'device-code') return <div className="host-sign-in">
      <p>Enter this code on {name}'s sign-in page. {host.name} finishes signing in by itself once you do.</p>
      <div className="host-sign-in__code-row">
        <span className="host-sign-in__code" aria-hidden="true">{view.code}</span>
        <span className="tt-visually-hidden">Code {spelled(view.code ?? '')}</span>
        <Button variant="secondary" aria-label="Copy the code" onClick={() => void copy(view.code ?? '')}>
          {copied === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === 'copied' ? 'Copied' : 'Copy code'}
        </Button>
      </div>
      <div className="host-sign-in__row">
        <Button variant="primary" data-autofocus disabled={busy} onClick={() => void open()}>{opened ? 'Open sign-in page again' : 'Open sign-in page'}</Button>
      </div>
      <p className="host-sign-in__waiting" role="status"><LoaderCircle size={14} aria-hidden="true" className="hosts-spin" />Waiting for you on {page}.{view.expiresInMinutes ? ` The code lasts ${view.expiresInMinutes} minutes.` : ''}</p>
      {copied === 'failed' ? <p className="host-sign-in__quiet">The code could not be copied. Type it on the page instead.</p> : null}
      <span className="tt-visually-hidden" role="status">{copied === 'copied' ? 'Copied the code' : ''}</span>
    </div>
    return <div className="host-sign-in">
      <p>{name} signs in with your Claude subscription in this computer's browser, then shows a code to bring back here.</p>
      <div className="host-sign-in__row">
        <Button variant={opened ? 'secondary' : 'primary'} data-autofocus disabled={busy} onClick={() => void open()}>{opened ? 'Open sign-in page again' : 'Open sign-in page'}</Button>
        {opened ? <span className="host-sign-in__quiet">Opened {page} in your browser.</span> : null}
      </div>
      {opened ? <div className="tt-field host-sign-in__field">
        <label className="tt-field__label" htmlFor={fieldId}>Code from the page</label>
        <div className="host-sign-in__row">
          <input ref={field} id={fieldId} className="tt-input tt-focusable" value={code} maxLength={PASTED_CODE_MAX} autoComplete="off" spellCheck={false}
            aria-describedby={hintId} aria-invalid={codeError ? true : undefined} placeholder="Paste the code"
            onChange={event => { setCode(event.target.value); setCodeError(null) }}
            onKeyDown={event => { if (isCompositionKey(event.nativeEvent)) { event.stopPropagation(); return } if (event.key === 'Enter') { event.preventDefault(); void finish() } }} />
          <Button variant="primary" disabled={!code.trim() || busy} onClick={() => void finish()}>Finish sign-in</Button>
        </div>
        <p className="tt-field__description" id={hintId}>Sotto hands the code to {name} on {host.name} and keeps nothing.</p>
        {codeError ? <p className="host-sign-in__error" role="alert">{codeError}</p> : null}
      </div> : null}
    </div>
  }
  const ended = error !== null || (view !== null && !running(view))
  const again = error !== null || view?.stage === 'refused' || view?.stage === 'failed' || view?.stage === 'ended'
  return <HostsModal title={`Sign in to ${name} on ${host.name}`} onClose={close} className="host-sign-in-dialog" busy={busy}
    footer={<>
      {ended ? <Button variant={again ? 'secondary' : 'primary'} data-autofocus={again ? undefined : true} onClick={close}>{view?.stage === 'connected' ? 'Done' : 'Close'}</Button>
        : <Button variant="secondary" onClick={close}>Cancel</Button>}
      {again ? <Button variant="primary" data-autofocus onClick={tryAgain}>Try again</Button> : null}
    </>}>
    <div ref={anchor}>{body()}</div>
  </HostsModal>
}
