import { isCompositionKey } from '../../agents/composerKeys'
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, Info } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { type PhonesBridge, type PhonesCommand, type PhonesState } from '../../../../shared/phones'
import type { SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { Field } from '../../components/Field'
import { Toggle } from '../../components/Toggle'
import { writeClipboard } from '../../agents/richActions'
import { countdown, PhoneRow, StepMark, type Step } from './phoneParts'
import { shownWords, type LaterWords } from './laterWords'
import './hosts.css'
import './phones.css'

/** What a failed step says: what happened, that nothing was changed, and what to do. */
export function phonesFailure(state: PhonesState): string | null {
  if (state.phase === 'cleanup-failed') return state.serve.status === 'failed' && state.serve.reason === 'cleanup-record'
    ? i18n._(msg`Phones can’t connect. Sotto couldn’t read its saved cleanup record, so it can’t identify the Tailscale Serve setting. Remove Sotto’s setting on port 8443 or 10000 in Tailscale, then press Try again. Sotto is still finishing cleanup.`)
    : i18n._(msg`Phones can’t connect. Sotto is still finishing cleanup of its Tailscale Serve setting and will try again while it is open. Check Tailscale, then press Try again.`)
  if (state.tailscale.status === 'failed') {
    return state.tailscale.reason === 'missing'
      ? i18n._(msg`Tailscale isn’t installed on this computer. Phones can’t reach it yet, and nothing was changed. Install Tailscale and sign in, then press Try again.`)
      : i18n._(msg`Tailscale isn’t running on this computer, or isn’t signed in. Phones can’t reach it yet, and nothing was changed. Open Tailscale and sign in, then press Try again.`)
  }
  if (state.serve.status !== 'failed') return null
  const port = state.servePort ?? 8443
  switch (state.serve.reason) {
    case 'port-taken': return i18n._(msg`Other apps already use ports 8443 and 10000 in Tailscale Serve on this computer. Sotto left those settings alone, and nothing was changed. Stop one of those apps, then press Try again.`)
    case 'not-enabled': return i18n._(msg`Tailscale Serve isn’t turned on for your tailnet. Nothing was changed. Turn it on in Tailscale, then press Try again.`)
    case 'denied': return i18n._(msg`Tailscale on this computer won’t let your account change Tailscale Serve. Nothing was changed. Let your account manage Tailscale, then press Try again.`)
    case 'listener': return i18n._(msg`Sotto couldn’t open its listener for phones on this computer. Nothing was changed. Press Try again, or restart Sotto.`)
    case 'record': return i18n._(msg`Sotto couldn’t save its phone access settings. Phone access wasn’t started. Check that Sotto can write to its data folder, then press Try again.`)
    case 'cleanup-record':
    case 'cleanup': return null
    case 'failed': return i18n._(msg`Tailscale Serve couldn’t be set up on port ${port}. Nothing was changed. Check Tailscale on this computer, then press Try again.`)
  }
}

/** The name phones show for this computer, saved when the field loses focus or on Enter. */
function NameField({ name, defaultName, onSave }: { readonly name: string; readonly defaultName: string; readonly onSave: (name: string) => Promise<boolean> }): ReactNode {
  const { t } = useLingui()
  const [draft, setDraft] = useState(name)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setDraft(name) }, [name])
  const save = (): void => {
    const next = draft.trim()
    if (next !== name) void onSave(next).then(saved => setFailed(!saved))
    else { setDraft(name); setFailed(false) }
  }
  return <Field setting="phone-name" label={t`Name on phones`} {...(failed ? { error: t`The name could not be saved. Phones still use the previous name. Try again.` } : {})} description={t`How this computer appears on phones. Leave it empty to use ${defaultName}.`}>
    <input className="tt-input" value={draft} placeholder={defaultName} maxLength={63} spellCheck={false}
      onChange={event => setDraft(event.target.value)} onBlur={save}
      onKeyDown={event => { if (isCompositionKey(event.nativeEvent)) { event.stopPropagation(); return } if (event.key === 'Enter') { event.preventDefault(); save() } else if (event.key === 'Escape' && draft !== name) { event.preventDefault(); event.stopPropagation(); setDraft(name) } }} />
  </Field>
}

export function PhonesSettings({ phoneAccess, phoneAccessName, onUpdateSettings, onOpenHosts, bridge = window.sotto?.phones }: {
  readonly phoneAccess: boolean
  readonly phoneAccessName: string
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  /** Brings Run the local host, above on the same page, into view with focus on it. */
  readonly onOpenHosts: () => void
  readonly bridge?: PhonesBridge | undefined
}): ReactNode {
  const { t } = useLingui()
  const [state, setState] = useState<PhonesState | null>(null)
  const [error, setError] = useState<LaterWords | null>(null)
  const [accessSaveFailed, setAccessSaveFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<LaterWords>('')
  const [now, setNow] = useState(() => Date.now())
  const showButton = useRef<HTMLButtonElement>(null)
  const codeBox = useRef<HTMLDivElement>(null)
  const previous = useRef<PhonesState | null>(null)
  const pairHeading = useId()
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }).catch(() => { if (alive) setError(msg`Phone access could not be read. Reopen Settings and try again.`) })
    const off = bridge.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; off() }
  }, [bridge])
  const code = state?.code ?? null
  useEffect(() => {
    if (!code) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])
  // When the code closes, focus that was on it goes back to the button that shows one; a phone that
  // redeemed it is said once, politely.
  useEffect(() => {
    const before = previous.current
    previous.current = state
    if (!before?.code || state?.code) return
    const added = state?.phones.find(phone => !before.phones.some(known => known.clientId === phone.clientId))
    const phone = added?.name ?? ''
    if (added) setAnnouncement(msg`${phone} is paired.`)
    // Focus that was inside the code went with it to the page's body; anywhere else, it stays where it is.
    const focused = document.activeElement
    if (focused === null || focused === document.body || !focused.isConnected) queueMicrotask(() => showButton.current?.focus())
  }, [state])
  useEffect(() => { if (code) codeBox.current?.focus() }, [code?.code])
  const run = async (command: PhonesCommand): Promise<boolean> => {
    if (!bridge) return false
    setError(null)
    try { setState(await bridge.command(command)); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : msg`Phone access could not be changed. Nothing was changed. Try again.`); return false }
  }
  const copyAddress = async (address: string): Promise<void> => {
    try { await writeClipboard(address); setCopied(true); setTimeout(() => setCopied(false), 1500) }
    catch { setError(msg`The address could not be copied. Select it and copy it instead.`) }
  }

  const localHostRunning = state?.localHostRunning ?? true
  const on = state?.phase === 'on' && state.enabled
  const starting = state?.phase === 'starting'
  const failure = state ? phonesFailure(state) : null
  const tailscaleStep: Step = state?.tailscale.status === 'ok' ? 'ok' : state?.tailscale.status === 'failed' ? 'failed' : 'waiting'
  const serveStep: Step = state?.serve.status === 'ok' ? 'ok' : state?.serve.status === 'failed' ? 'failed' : 'waiting'
  const addressStep: Step = state?.address ? 'ok' : 'waiting'
  const machine = state?.tailscale.status === 'ok' ? state.tailscale.dnsName.split('.')[0]! : state?.defaultName ?? t({ message: 'this computer', comment: 'Stands in for this computer\'s name, as in "Enter this computer" on a phone.' })
  const notYet = t`Checked when you turn this on.`
  const retry = <Button variant="secondary" onClick={() => void run({ type: 'retry' })}>{t`Try again`}</Button>
  const servePort = state?.servePort ?? 8443
  const removing = state?.phones.find(phone => phone.clientId === removeId)
  const removingName = removing?.name

  const codeCard = !on
    ? <div key="off" className="phones-code" data-off="">
      <p className="tt-paragraph">{phoneAccess && localHostRunning ? t`Finish the steps above first.` : t`Turn on Let phones connect first.`}</p>
      <Button ref={showButton} variant="secondary" disabled>{t`Show a pairing code`}</Button>
    </div>
    : code
      ? (() => {
        const left = countdown(code.expiresAt, now)
        const spelled = [...code.code].join(' '), expires = left.text
        return <div key="code" ref={codeBox} className="phones-code" data-code="" role="group" aria-label={t`Pairing code`} tabIndex={-1}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void run({ type: 'cancel-code' }) } }}>
          <p>{t`Pairing code`}</p>
          <span className="phones-code__value" aria-hidden="true">{code.code.slice(0, 4)}<i />{code.code.slice(4)}</span>
          <span className="tt-visually-hidden"><Trans>Pairing code {spelled}</Trans></span>
          <span className="phones-count">
            <span className="phones-count__bar" aria-hidden="true"><i style={{ width: `${left.fraction * 100}%` }} /></span>
            <span><Trans>Works once. Expires in <b>{expires}</b></Trans></span>
          </span>
          <span className="phones-code__actions">
            <Button variant="ghost" onClick={() => void run({ type: 'show-code' })}>{t`Make a new code`}</Button>
            <Button variant="ghost" onClick={() => void run({ type: 'cancel-code' })}>{t`Cancel code`}</Button>
          </span>
        </div>
      })()
      : <div key="ready" className="phones-code">
        <p className="tt-paragraph"><Trans>A code works once, for five minutes.</Trans></p>
        <Button ref={showButton} variant="primary" onClick={() => void run({ type: 'show-code' })}>{t`Show a pairing code`}</Button>
      </div>

  return <div className="hosts-settings phones-settings">
    {!localHostRunning ? <div className="hosts-notice phones-needs-host">
      <Info size={16} aria-hidden="true" />
      <p className="tt-paragraph"><Trans>Phone access needs the local host. Turn on Run the local host above, then restart Sotto.</Trans></p>
      <Button variant="secondary" onClick={onOpenHosts}>{t`Show Run the local host`}</Button>
    </div> : null}
    {/* One card, as on every other Settings page (ADR-0110, #1831): the switch, its three checks as rows, and Pair a phone
        as a row with its button. */}
    <div className="hosts-card phones-card">
    <div className="phones-switch">
      <Toggle setting="phone-access" label={t`Let phones connect`} checked={phoneAccess} disabled={!bridge || (!localHostRunning && !phoneAccess)}
        onCheckedChange={enabled => { setError(null); void onUpdateSettings({ phoneAccess: enabled }).then(saved => setAccessSaveFailed(!saved)) }}
        description={t`Adds this computer to Tailscale Serve, on port 8443 or 10000, while this is on and Sotto is open. Only phones you pair can connect.`} />
      {accessSaveFailed ? <p className="tt-field__error tt-paragraph" role="alert"><Trans>Phone access could not be saved. Nothing was changed. Try again.</Trans></p> : null}
    </div>
    <ol className="phones-steps" aria-label={t({ message: 'Setup', comment: 'The steps that set up phone access.' })} aria-busy={starting || undefined}>
      <li data-step={tailscaleStep}>
        <StepMark step={tailscaleStep} />
        <div className="phones-step__copy"><b>{t`Tailscale is running`}</b>
          <p className="tt-paragraph">{tailscaleStep === 'ok' ? <Trans>Signed in. This computer is <span className="phones-mono">{machine}</span> on your tailnet.</Trans> : tailscaleStep === 'failed' ? failure : starting ? t`Checking…` : notYet}</p>
        </div>
        {tailscaleStep === 'failed' ? retry : null}
      </li>
      <li data-step={serveStep}>
        <StepMark step={serveStep} />
        <div className="phones-step__copy"><b>{t`Tailscale Serve on port ${servePort}`}</b>
          <p className="tt-paragraph">{serveStep === 'ok' ? (state?.servePort === 10000 ? t`Sotto added it on 10000, because another app had 8443. Port 443 stays free for other apps.` : t`Sotto added it. Port 443 stays free for other apps.`) : serveStep === 'failed' ? failure : tailscaleStep === 'failed' ? t`Waits for Tailscale.` : starting ? t`Setting it up…` : notYet}</p>
        </div>
        {serveStep === 'failed' ? <span className="phones-step__actions">
          {state?.serve.status === 'failed' && state.serve.canOpenSetup ? <Button variant="secondary" onClick={() => void run({ type: 'open-serve-setup' })}>{t`Turn on Serve in Tailscale`}</Button> : null}
          {retry}
        </span> : null}
      </li>
      <li data-step={addressStep}>
        <StepMark step={addressStep} />
        <div className="phones-step__copy"><b>{t`Address phones use`}</b>
          <p className="tt-paragraph">{state?.address ? <span className="phones-mono phones-address">{state.address}</span> : state?.phase === 'failed' || starting ? t`Waits for the steps above.` : notYet}</p>
        </div>
        {state?.address ? <Button variant="ghost" onClick={() => void copyAddress(state.address!)}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied ? t`Copied` : t`Copy address`}</Button> : null}
      </li>
    </ol>
    <section className="phones-pair" aria-labelledby={pairHeading}>
      <div>
        <h3 id={pairHeading}>{t`Pair a phone`}</h3>
        <ol className="phones-how">
          <li><Trans>On your iPhone, open Sotto and tap <b>Add computer</b>.</Trans></li>
          <li><Trans>Enter <b className="phones-mono">{machine}</b>.</Trans></li>
          <li><Trans>Enter the code shown here.</Trans></li>
        </ol>
        <p className="phones-note tt-paragraph"><Trans>A paired phone reads threads, replies, and answers questions and permissions. Remove a phone to take that away.</Trans></p>
      </div>
      {codeCard}
    </section>
    </div>
    <p className="phones-live tt-paragraph" role="status" aria-live="polite">{shownWords(announcement)}</p>
    {state?.phones.length ? <section aria-labelledby={`${pairHeading}-phones`}>
      <h3 id={`${pairHeading}-phones`}>{t`Paired phones`}</h3>
      <div className="hosts-list hosts-card phones-list">
        {state.phones.map(phone => <PhoneRow key={phone.clientId} phone={phone} onRemove={() => setRemoveId(phone.clientId)} />)}
      </div>
    </section> : null}
    {state ? <div className="settings-rows phones-name">
      <NameField name={phoneAccessName} defaultName={state.defaultName} onSave={name => onUpdateSettings({ phoneAccessName: name })} />
    </div> : null}
    {error ? <div className="hosts-notice hosts-notice--error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><p className={typeof error === 'string' ? undefined : 'tt-paragraph'}>{shownWords(error)}</p></div> : null}
    {removing ? <ConfirmationDialog title={t`Remove ${removingName}?`} confirmLabel={t`Remove phone`} cancelLabel={t`Keep phone`}
      description={t`${removingName} can no longer reach this computer, and its connection closes now. Threads stay here. To use it again, pair it with a new code.`}
      onCancel={() => setRemoveId(null)} onConfirm={() => run({ type: 'remove', clientId: removing.clientId })}
      failureMessage={shownWords(error)} fallbackFocusRef={showButton} /> : null}
  </div>
}
