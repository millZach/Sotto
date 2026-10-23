import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, Info, Plus } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { type HostPhonesCommand, type PhonesState } from '../../../../shared/phones'
import type { HostPhonesView, HostsBridge, HostStatus } from '../../../../shared/hosts'
import type { HostPhoneAccessSummary } from '../../../../shared/hostProtocol'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { writeClipboard } from '../../agents/richActions'
import { HostSshQuestion } from './HostSshQuestion'
import { HostsModal } from './HostsModal'
import { countdown, PhoneRow, StepMark, type Step } from './phoneParts'
import { TAILSCALE_GUIDE_URL, TAILSCALE_OPERATOR_COMMAND } from './hostTailnetWords'
import './hosts.css'
import './phones.css'

/** How often an open dialog tells main it is still open, well inside main's minute (HOST_PHONES_WATCH_MS). */
const RENEW_WATCH_MS = 30_000

/** A host's phone access in the row's words: off, starting, on and how many phones, or that it needs the owner. */
export function phoneWords(summary: HostPhoneAccessSummary): string {
  if (summary.status === 'off') return i18n._(msg`Phones off`)
  if (summary.status === 'starting') return i18n._(msg`Phones starting…`)
  if (summary.status === 'needs-you') return i18n._(msg`Phones need you`)
  const phones = summary.phones
  return phones ? plural(phones, { one: 'Phones on, # paired', other: 'Phones on, # paired' }) : i18n._(msg`Phones on`)
}

/** A remote host's phone access in a few words, for the end of its row, as the Phones dialog last read it. */
export function hostPhonesLabel(view: HostPhonesView | undefined): string | null {
  const state = view?.state
  if (!state) return null
  if (!state.enabled) return phoneWords({ status: 'off', phones: 0 })
  if (state.phase === 'failed' || state.phase === 'cleanup-failed') return phoneWords({ status: 'needs-you', phones: 0 })
  if (state.phase === 'starting') return phoneWords({ status: 'starting', phones: 0 })
  return phoneWords({ status: state.phase === 'on' ? 'on' : 'off', phones: state.phase === 'on' ? state.phones.length : 0 })
}

/** What a failed step on a remote host says: what happened there, that nothing was changed, and what to do. */
export function hostPhonesFailure(state: PhonesState, name: string): string | null {
  if (state.phase === 'cleanup-failed') return state.serve.status === 'failed' && state.serve.reason === 'cleanup-record'
    ? i18n._(msg`Phones can’t connect. The host on ${name} couldn’t read its saved cleanup record, so it can’t tell which Tailscale Serve setting is its own. Remove Sotto’s setting on port 8443 or 10000 in Tailscale on ${name}, then press Try again.`)
    : i18n._(msg`Phones can’t connect. The host on ${name} is still removing its Tailscale Serve setting and tries again while it runs. Check Tailscale on ${name}, then press Try again.`)
  if (state.tailscale.status === 'failed') {
    return state.tailscale.reason === 'missing'
      ? i18n._(msg`Tailscale isn’t installed on ${name}. Nothing was changed, and Sotto won’t install it. Install Tailscale on ${name} and sign in there, then press Try again.`)
      : i18n._(msg`Tailscale isn’t running on ${name}, or isn’t signed in there. Nothing was changed. Start Tailscale on ${name} and sign in, then press Try again.`)
  }
  if (state.serve.status !== 'failed') return null
  const port = state.servePort ?? 8443
  switch (state.serve.reason) {
    // A host from before the 10000 fallback sends no servePort, and for it only 8443 was tried.
    case 'port-taken': return state.servePort === undefined
      ? i18n._(msg`Another app on ${name} already uses port 8443 in Tailscale Serve. Sotto left it alone, and nothing was changed. Free port 8443 on ${name}, then press Try again.`)
      : i18n._(msg`Other apps on ${name} already use ports 8443 and 10000 in Tailscale Serve. Sotto left them alone, and nothing was changed. Free one of them on ${name}, then press Try again.`)
    case 'not-enabled': return i18n._(msg`Tailscale Serve isn’t turned on for your tailnet. Nothing was changed. Turn it on in Tailscale, then press Try again.`)
    case 'denied': return i18n._(msg`Tailscale on ${name} won’t let the account Sotto signs in with change Tailscale Serve. Nothing was changed. Run this command on ${name}, then press Try again.`)
    case 'listener': return i18n._(msg`The host on ${name} couldn’t open its listener for phones. Nothing was changed. Press Try again, or stop the host and connect again.`)
    case 'record': return i18n._(msg`The host on ${name} couldn’t save its phone access settings. Phone access wasn’t started. Check that its data folder can be written to, then press Try again.`)
    case 'failed': return i18n._(msg`Tailscale Serve couldn’t be set up on port ${port} on ${name}. Nothing was changed. Check Tailscale on ${name}, then press Try again.`)
    case 'cleanup':
    case 'cleanup-record': return null
  }
}

const time = (iso: string): string => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/**
 * Phones on a remote host (ADR-0050): the host's own phone access, opened from its row in Settings > Hosts & phones. The switch,
 * the three checks the host ran, its pairing code and its paired phones, each press sent on to the host over SSH.
 */
export function HostPhonesDialog({ host, view, bridge, onClose }: {
  readonly host: HostStatus
  readonly view: HostPhonesView | undefined
  readonly bridge: HostsBridge
  readonly onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'address' | 'command' | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const pairButton = useRef<HTMLButtonElement>(null)
  const codeBox = useRef<HTMLDivElement>(null)
  const keepButton = useRef<HTMLButtonElement>(null)
  const previous = useRef<PhonesState | undefined>(undefined)
  const id = host.id, name = host.name
  const connected = host.phase === 'connected'
  const state = view?.state
  // While the dialog is open main reads the host every couple of seconds; it is told again in time, and told when it closes.
  useEffect(() => {
    const watch = (watching: boolean): void => { void bridge.command({ type: 'watch-host-phones', id, watching }).catch(() => undefined) }
    watch(true)
    const timer = setInterval(() => watch(true), RENEW_WATCH_MS)
    return () => { clearInterval(timer); watch(false) }
  }, [bridge, id])
  const code = state?.code ?? null
  useEffect(() => {
    if (!code) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])
  useEffect(() => { if (code) codeBox.current?.focus() }, [code?.code])
  useEffect(() => { if (removeId) keepButton.current?.focus() }, [removeId])
  // A phone that redeemed the code is said once, politely; focus that was on the code goes back to Pair a phone.
  useEffect(() => {
    const before = previous.current
    previous.current = state
    if (!before?.code || state?.code) return
    const added = state?.phones.find(phone => !before.phones.some(known => known.clientId === phone.clientId))
    const phone = added?.name ?? ''
    if (added) setAnnouncement(i18n._(msg`${phone} is paired with ${name}.`))
    const focused = document.activeElement
    if (focused === null || focused === document.body || !focused.isConnected) queueMicrotask(() => pairButton.current?.focus())
  }, [state, name])

  const run = async (command: HostPhonesCommand): Promise<boolean> => {
    setError(null)
    try { await bridge.command({ type: 'host-phones', id, command }); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : t`Phone access on ${name} could not be changed. Nothing was changed. Try again.`); return false }
  }
  const copy = async (text: string, what: 'address' | 'command'): Promise<void> => {
    try { await writeClipboard(text); setCopied(what); setTimeout(() => setCopied(null), 1500) }
    catch { setError(t`It could not be copied. Select it and copy it instead.`) }
  }

  const live = connected && state !== undefined
  const approving = host.adminSignIn === true && host.tailscale?.waiting === true
  // SSH's question for that admin connection, asked here because the question over the page waits while this dialog is open.
  const asking = host.adminSignIn === true ? host.prompt : undefined
  // What the dialog last read stays on show while Tailscale or SSH holds a new admin connection, but nothing is pressed
  // through it until the user approves or answers: a change would only wait behind the sign-in.
  const busy = view?.busy === true || approving || asking !== undefined
  const answer = async (prompt: NonNullable<HostStatus['prompt']>, value: string): Promise<void> => {
    try { await bridge.command({ type: 'ssh-answer', id, promptId: prompt.id, answer: value }) }
    catch { setError(t`SSH did not take the answer. Close Phones on ${name} and open it again to sign in again.`) }
  }
  const on = state?.phase === 'on' && state.enabled
  const starting = state?.phase === 'starting'
  const failure = state ? hostPhonesFailure(state, name) : null
  const tailscaleStep: Step = state?.tailscale.status === 'ok' ? 'ok' : state?.tailscale.status === 'failed' ? 'failed' : 'waiting'
  const serveStep: Step = state?.serve.status === 'ok' ? 'ok' : state?.serve.status === 'failed' ? 'failed' : 'waiting'
  const addressStep: Step = state?.address ? 'ok' : 'waiting'
  const machine = state?.tailscale.status === 'ok' ? state.tailscale.dnsName.split('.')[0]! : name
  const dnsName = state?.tailscale.status === 'ok' ? state.tailscale.dnsName : machine
  const servePort = state?.servePort ?? 8443
  const notYet = t`Checked when you turn this on.`
  const retry = <Button variant="secondary" disabled={!live || busy} onClick={() => void run({ type: 'retry' })}>{t`Try again`}</Button>
  const removing = state?.phones.find(phone => phone.clientId === removeId)
  const denied = state?.serve.status === 'failed' && state.serve.reason === 'denied'
  const readAt = view?.readAt ? time(view.readAt) : ''

  const pairing = !on || !live ? null : code
    ? (() => {
      const left = countdown(code.expiresAt, now)
      const spelled = [...code.code].join(' '), expires = left.text
      return <div ref={codeBox} className="host-phones-code" role="group" aria-label={t`Pairing code from ${name}`} tabIndex={-1}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void run({ type: 'cancel-code' }) } }}>
        <span className="phones-code__value" aria-hidden="true">{code.code.slice(0, 4)}<i />{code.code.slice(4)}</span>
        <span className="tt-visually-hidden"><Trans>Pairing code {spelled}</Trans></span>
        <div className="host-phones-code__copy">
          <p><Trans>On your iPhone, tap <b>Add computer</b>, enter <b className="phones-mono">{machine}</b>, then this code.</Trans></p>
          <span className="phones-count">
            <span className="phones-count__bar" aria-hidden="true"><i style={{ width: `${left.fraction * 100}%` }} /></span>
            <span><Trans>Works once. Expires in <b>{expires}</b></Trans></span>
          </span>
        </div>
        <span className="host-phones-code__actions">
          <Button variant="ghost" disabled={busy} onClick={() => void run({ type: 'show-code' })}>{t`Make a new code`}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void run({ type: 'cancel-code' })}>{t`Cancel code`}</Button>
        </span>
      </div>
    })()
    : <div className="host-phones-pair">
      <Button ref={pairButton} variant="secondary" disabled={busy} onClick={() => void run({ type: 'show-code' })}><Plus size={16} aria-hidden="true" />{t`Pair a phone`}</Button>
      <p><Trans>Shows a code from {name} to type on your iPhone. It works once, for five minutes. A paired phone reads threads and replies; answering is its own switch.</Trans></p>
    </div>

  return <HostsModal title={t`Phones on ${name}`} onClose={onClose} busy={busy || starting} className="host-phones-dialog"
    footer={<Button onClick={onClose}>{t({ message: 'Done', comment: 'Closes a dialog.' })}</Button>}>
    <div className="hosts-settings phones-settings host-phones">
      <p className="host-phones__intro"><Trans>Reach {name}’s threads from Sotto on your iPhone, over Tailscale.</Trans></p>
      {/* On a tailnet connection the dialog reads and changes phone access over an admin connection, whose sign-in Tailscale may hold (ADR-0053). */}
      {approving ? <div className="hosts-notice host-phones-approval" role="status">
        <Info size={16} aria-hidden="true" />
        <div className="host-phones-approval__copy">
          <p><Trans>Waiting for your approval in Tailscale. {name} uses Tailscale SSH, which asks you to approve this connection in your browser. The dialog fills in once you approve. Sotto waits up to 5 minutes.</Trans></p>
          <span className="host-phones-approval__actions">
            {host.tailscale?.url ? <Button aria-label={t`Open the Tailscale approval page for ${name}`} onClick={() => void bridge.command({ type: 'open-approval', id }).catch(() => undefined)}>{t`Open approval page`}</Button> : null}
            <button type="button" className="host-setup__link tt-focusable" onClick={() => void window.sotto?.openExternalLink?.(TAILSCALE_GUIDE_URL)}>{t`Why Tailscale asks`}</button>
          </span>
        </div>
      </div> : null}
      {asking ? <HostSshQuestion prompt={asking} onAnswer={value => answer(asking, value)}
        actions={<Button variant="secondary" onClick={() => void bridge.command({ type: 'stop-admin-sign-in', id }).catch(() => undefined)}>{t`Stop signing in`}</Button>} /> : null}
      {/* Until the host is read, nothing here is known: the switch shows once it is, rather than reading off. */}
      {connected && !state ? <ol className="phones-steps host-phones-steps host-phones-unread" aria-label={t`Phone access on ${name}`} aria-busy={!view?.error || undefined}>
        <li data-step="waiting"><StepMark step="waiting" /><div className="phones-step__copy"><b>{t`Let phones reach ${name}`}</b>
          <p role="status">{view?.error ? t`Not read.` : approving || asking ? t`Not read yet. The switch shows once Sotto reaches ${name} over SSH.` : t`Reading phone access on ${name}…`}</p></div></li>
        {[t`Tailscale on ${name}`, t`Tailscale Serve on port 8443`, t`Paired phones`].map(title => <li key={title} data-step="waiting"><StepMark step="waiting" />
          <div className="phones-step__copy"><b>{title}</b><p>{t`Waits for the step above.`}</p></div></li>)}
      </ol> : <div className="phones-switch">
        <Toggle label={t`Let phones reach ${name}`} checked={state?.enabled ?? false} disabled={!live || busy}
          onCheckedChange={enabled => void run({ type: 'set-enabled', enabled })}
          description={t`Sotto runs Tailscale Serve on ${name}, port 8443, or 10000 when another app uses 8443, so Sotto on your iPhone can reach ${name}’s threads over your tailnet. Only phones you pair can connect. Phones reach ${name} while its host runs. Turning this off removes the setting and disconnects them.`} />
      </div>}
      {!connected ? <div className="hosts-notice">
        <Info size={16} aria-hidden="true" />
        <p><Trans>Connect to {name} to change phone access or pair a phone. Phones already paired keep reaching it while its host runs.</Trans></p>
      </div> : null}
      {view?.error ? <div className="hosts-notice hosts-notice--error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><p>{view.error}</p></div> : null}
      {live && state.enabled ? <ol className="phones-steps host-phones-steps" aria-label={t`Phone access on ${name}`} aria-busy={starting || undefined}>
        <li data-step={tailscaleStep}>
          <StepMark step={tailscaleStep} />
          <div className="phones-step__copy"><b>{t`Tailscale on ${name}`}</b>
            <p>{tailscaleStep === 'ok' ? <Trans>Signed in. {name} is <span className="phones-mono">{dnsName}</span> on your tailnet.</Trans> : tailscaleStep === 'failed' ? failure : starting ? t`Checking…` : notYet}</p>
          </div>
          {tailscaleStep === 'failed' ? retry : null}
        </li>
        <li data-step={serveStep}>
          <StepMark step={serveStep} />
          <div className="phones-step__copy"><b>{t`Tailscale Serve on port ${servePort}`}</b>
            <p>{serveStep === 'ok' ? state.servePort === 10000
              ? t`Sotto added it on ${name}, on 10000 because another app had 8443. It stays on your tailnet; Funnel is never used.`
              : t`Sotto added it on ${name}. It stays on your tailnet; Funnel is never used.`
              : serveStep === 'failed' ? failure : tailscaleStep === 'failed' ? t`Waits for Tailscale.` : starting ? t`Setting it up…` : notYet}</p>
            {denied ? <span className="host-phones-command">
              <code className="phones-mono">{TAILSCALE_OPERATOR_COMMAND}</code>
              <Button variant="ghost" aria-label={t`Copy the command to run on ${name}`} onClick={() => void copy(TAILSCALE_OPERATOR_COMMAND, 'command')}>{copied === 'command' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied === 'command' ? t`Copied` : t`Copy command`}</Button>
            </span> : null}
          </div>
          {serveStep === 'failed' ? <span className="phones-step__actions">
            {state.serve.status === 'failed' && state.serve.canOpenSetup ? <Button variant="secondary" disabled={busy} onClick={() => void run({ type: 'open-serve-setup' })}>{t`Turn on Serve in Tailscale`}</Button> : null}
            {retry}
          </span> : null}
        </li>
        <li data-step={addressStep}>
          <StepMark step={addressStep} />
          <div className="phones-step__copy"><b>{t`Address phones use`}</b>
            <p>{state.address ? <span className="phones-mono phones-address">{state.address}</span> : state.phase === 'failed' || starting ? t`Waits for the steps above.` : notYet}</p>
          </div>
          {state.address ? <Button variant="ghost" onClick={() => void copy(state.address!, 'address')}>{copied === 'address' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied === 'address' ? t`Copied` : t`Copy address`}</Button> : null}
        </li>
      </ol> : null}
      {pairing}
      <p className="phones-live" role="status" aria-live="polite">{announcement}</p>
      {state && (state.enabled || state.phones.length) ? <section className="host-phones-list" aria-label={t`Phones paired with ${name}`}>
        <h3>{connected || !view?.readAt ? t`Paired phones` : t`Paired phones, as of ${readAt}`}</h3>
        {state.phones.length ? <div className="hosts-list phones-list">
          {state.phones.map(phone => { const phoneName = phone.name; return <React.Fragment key={phone.clientId}>
            <PhoneRow phone={phone} answersAvailable={state.answersAvailable} disabled={!live || busy}
              onCanAnswer={allowed => void run({ type: 'set-can-answer', clientId: phone.clientId, allowed })} onRemove={() => setRemoveId(phone.clientId)} />
            {removing?.clientId === phone.clientId ? <div className="hosts-notice host-phones-remove" role="group" aria-label={t`Remove ${phoneName}?`}
              onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRemoveId(null) } }}>
              <p className="grow"><Trans>Remove {phoneName}? It can no longer reach {name}, and its connection closes now. Threads stay on {name}. To use it again, pair it with a new code.</Trans></p>
              <Button ref={keepButton} variant="secondary" onClick={() => setRemoveId(null)}>{t`Keep phone`}</Button>
              <Button variant="danger" disabled={busy} onClick={() => void run({ type: 'remove', clientId: phone.clientId }).then(done => { if (done) { setRemoveId(null); queueMicrotask(() => pairButton.current?.focus()) } })}>{t`Remove phone`}</Button>
            </div> : null}
          </React.Fragment> })}
        </div> : <p><Trans>No phones paired with {name} yet. A phone paired with {name}’s own pairing command isn’t listed here.</Trans></p>}
      </section> : null}
      {error ? <div className="hosts-notice hosts-notice--error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><p>{error}</p></div> : null}
    </div>
  </HostsModal>
}
