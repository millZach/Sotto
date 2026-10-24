import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { writeClipboard } from '../../agents/richActions'
import { isCompositionKey } from '../../agents/composerKeys'
import { PROVIDER_LABELS } from '../../../../shared/agents'
import type { HostsBridge, HostStatus } from '../../../../shared/hosts'
import { PASTED_CODE_MAX, type HostProviderId, type ProviderSignInView } from '../../../../shared/hostProviders'
import { Button } from '../../components/Button'
import { HostsModal } from './HostsModal'
import { shownWords, type LaterWords } from './laterWords'

/** How often the dialog asks the host where a sign-in stands while it waits for the user or the client. */
const READ_EVERY_MS = 1500
/** Reads in a row a host can fail to answer before the dialog says it stopped answering. */
const READ_MISSES = 2
const clean = (failure: unknown, fallback: LaterWords): LaterWords =>
  failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '').trim() || fallback : fallback
const running = (view: ProviderSignInView | null): boolean => view !== null && (view.stage === 'starting' || view.stage === 'waiting' || view.stage === 'finishing')

/** "W D J B, dash, M J H T": a code read out one character at a time, so a screen reader does not say it as a word. */
function spelled(code: string): string {
  const dash = i18n._(msg({ message: 'dash', comment: 'The character "-", read aloud by a screen reader in a sign-in code.' }))
  return [...code].map(character => character === '-' ? dash : character).join(' ')
}

/**
 * Sign in to a provider on a host, from this computer (ADR-0037). The provider's own client runs on the host; the user
 * finishes in this computer's browser, either by entering the code shown here (Codex, Grok Build), by pasting back the
 * code the page shows (Claude Code), or on a page that needs neither and finishes by itself (Cursor). Cancel and Escape stop the sign-in on the host; nothing is kept on this computer.
 */
export function HostProviderSignIn({ host, provider, bridge, onClose }: {
  readonly host: HostStatus; readonly provider: HostProviderId; readonly bridge: HostsBridge; readonly onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const name = PROVIDER_LABELS[provider]
  const hostName = host.name
  const [view, setView] = useState<ProviderSignInView | null>(null)
  const [error, setError] = useState<LaterWords | null>(null)
  const [opened, setOpened] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<LaterWords | null>(null)
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
    }, failure => { if (alive) setError(clean(failure, msg`${name} could not start signing in on ${hostName}. Nothing was changed. Try again.`)) })
    return () => { alive = false }
  }, [attempt, bridge, host.id, hostName, name, provider])
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
        setError(msg`${hostName} stopped answering while ${name} was signing in. If its tile still says Not signed in, try again.`)
      })
    }, READ_EVERY_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [bridge, error, host.id, hostName, name, provider, signInId, stage])

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
    catch (failure) { setError(clean(failure, msg`The sign-in page could not open. Nothing was changed. Try again.`)) }
    finally { setBusy(false) }
  }
  const finish = async (): Promise<void> => {
    if (!view || !code.trim() || busy) return
    setBusy(true); setCodeError(null)
    try { const next = await bridge.signIn({ type: 'code', id: host.id, signInId: view.id, code: code.trim() }); setCode(''); if (next) setView(next) }
    catch (failure) { setCodeError(clean(failure, msg`The code could not be sent. Nothing was changed. Try again.`)) }
    finally { setBusy(false) }
  }
  const copy = async (value: string): Promise<void> => { try { await writeClipboard(value); setCopied('copied') } catch { setCopied('failed') } }
  const tryAgain = (): void => setAttempt(value => value + 1)
  const close = (): void => { onClose() }

  const body = (): ReactNode => {
    if (error) return <div className="hosts-notice hosts-notice--error" role="alert"><p className={typeof error === 'string' ? undefined : 'tt-paragraph'}>{shownWords(error)}</p></div>
    if (!view || view.stage === 'starting') return <div className="hosts-notice" role="status"><LoaderCircle size={16} aria-hidden="true" className="hosts-spin" /><p className="tt-paragraph"><Trans>Starting {name}'s sign-in on {hostName}…</Trans></p></div>
    if (view.stage === 'finishing') return <div className="hosts-notice" role="status"><LoaderCircle size={16} aria-hidden="true" className="hosts-spin" /><p className="tt-paragraph"><Trans>Finishing sign-in on {hostName}, then connecting {name}…</Trans></p></div>
    if (view.stage === 'connected') return <div className="hosts-notice host-sign-in__done" role="status"><Check size={16} aria-hidden="true" /><p className="tt-paragraph"><Trans>{name} is signed in and connected on {hostName}.</Trans></p></div>
    if (view.stage === 'refused') return <div className="hosts-notice hosts-notice--error" role="alert"><p className="tt-paragraph"><Trans>{name} did not accept that code, so {hostName} is still not signed in. Open the sign-in page again for a new code.</Trans></p></div>
    // The host's own sentence, when it sent one.
    if (view.stage === 'failed') return <div className="hosts-notice hosts-notice--error" role="alert"><p className={view.message ? undefined : 'tt-paragraph'}>{view.message ?? t`${name} could not finish signing in on ${hostName}. Nothing was changed.`}</p></div>
    if (view.stage === 'ended') return <div className="hosts-notice hosts-notice--error" role="alert"><p className="tt-paragraph"><Trans>The sign-in on {hostName} ended before it was finished. Nothing was signed in.</Trans></p></div>
    const page = view.page ?? t({ message: 'the sign-in page', comment: 'Stands in for the address of a provider\'s sign-in page, as in "Waiting for you on {page}."' })
    const minutes = view.expiresInMinutes, spoken = spelled(view.code ?? '')
    if (view.shape === 'device-code') return <div className="host-sign-in">
      <p className="tt-paragraph"><Trans>Enter this code on {name}'s sign-in page. {hostName} finishes signing in by itself once you do.</Trans></p>
      <div className="host-sign-in__code-row">
        <span className="host-sign-in__code" aria-hidden="true">{view.code}</span>
        <span className="tt-visually-hidden"><Trans comment="{spoken} is a sign-in code read one character at a time.">Code {spoken}</Trans></span>
        <Button variant="secondary" aria-label={t`Copy the code`} onClick={() => void copy(view.code ?? '')}>
          {copied === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === 'copied' ? t`Copied` : t`Copy code`}
        </Button>
      </div>
      <div className="host-sign-in__row">
        <Button variant="primary" data-autofocus disabled={busy} onClick={() => void open()}>{opened ? t`Open sign-in page again` : t`Open sign-in page`}</Button>
      </div>
      <p className="host-sign-in__waiting tt-paragraph" role="status"><LoaderCircle size={14} aria-hidden="true" className="hosts-spin" />{t`Waiting for you on ${page}.`}{minutes ? <> {plural(minutes, { other: 'The code lasts # minutes.' })}</> : null}</p>
      {copied === 'failed' ? <p className="host-sign-in__quiet tt-paragraph"><Trans>The code could not be copied. Type it on the page instead.</Trans></p> : null}
      <span className="tt-visually-hidden" role="status">{copied === 'copied' ? t`Copied the code` : ''}</span>
    </div>
    // A page with no code (Cursor, ADR-0127): signing in on the page is the whole step, and the host finishes by itself.
    if (view.shape === 'page') return <div className="host-sign-in">
      <p>{name} signs in on {page} in this computer's browser. {host.name} finishes signing in by itself once you do.</p>
      <div className="host-sign-in__row">
        <Button variant={opened ? 'secondary' : 'primary'} data-autofocus disabled={busy} onClick={() => void open()}>{opened ? 'Open sign-in page again' : 'Open sign-in page'}</Button>
      </div>
      {opened ? <p className="host-sign-in__waiting" role="status"><LoaderCircle size={14} aria-hidden="true" className="hosts-spin" />Waiting for you on {page}.</p> : null}
    </div>
    return <div className="host-sign-in">
      <p className="tt-paragraph"><Trans>{name} signs in with your Claude subscription in this computer's browser, then shows a code to bring back here.</Trans></p>
      <div className="host-sign-in__row">
        <Button variant={opened ? 'secondary' : 'primary'} data-autofocus disabled={busy} onClick={() => void open()}>{opened ? t`Open sign-in page again` : t`Open sign-in page`}</Button>
        {opened ? <span className="host-sign-in__quiet tt-paragraph"><Trans>Opened {page} in your browser.</Trans></span> : null}
      </div>
      {opened ? <div className="tt-field host-sign-in__field">
        <label className="tt-field__label" htmlFor={fieldId}>{t`Code from the page`}</label>
        <div className="host-sign-in__row">
          <input ref={field} id={fieldId} className="tt-input tt-focusable" value={code} maxLength={PASTED_CODE_MAX} autoComplete="off" spellCheck={false}
            aria-describedby={hintId} aria-invalid={codeError ? true : undefined} placeholder={t`Paste the code`}
            onChange={event => { setCode(event.target.value); setCodeError(null) }}
            onKeyDown={event => { if (isCompositionKey(event.nativeEvent)) { event.stopPropagation(); return } if (event.key === 'Enter') { event.preventDefault(); void finish() } }} />
          <Button variant="primary" disabled={!code.trim() || busy} onClick={() => void finish()}>{t`Finish sign-in`}</Button>
        </div>
        <p className="tt-field__description tt-paragraph" id={hintId}><Trans>Sotto hands the code to {name} on {hostName} and keeps nothing.</Trans></p>
        {codeError ? <p className={typeof codeError === 'string' ? 'host-sign-in__error' : 'host-sign-in__error tt-paragraph'} role="alert">{shownWords(codeError)}</p> : null}
      </div> : null}
    </div>
  }
  const ended = error !== null || (view !== null && !running(view))
  const again = error !== null || view?.stage === 'refused' || view?.stage === 'failed' || view?.stage === 'ended'
  return <HostsModal title={t`Sign in to ${name} on ${hostName}`} onClose={close} className="host-sign-in-dialog" busy={busy}
    footer={<>
      {ended ? <Button variant={again ? 'secondary' : 'primary'} data-autofocus={again ? undefined : true} onClick={close}>{view?.stage === 'connected' ? t({ message: 'Done', comment: 'Closes a dialog.' }) : t`Close`}</Button>
        : <Button variant="secondary" onClick={close}>{t`Cancel`}</Button>}
      {again ? <Button variant="primary" data-autofocus onClick={tryAgain}>{t`Try again`}</Button> : null}
    </>}>
    <div ref={anchor}>{body()}</div>
  </HostsModal>
}
