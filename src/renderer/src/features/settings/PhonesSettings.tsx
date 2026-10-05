import { isCompositionKey } from '../../agents/composerKeys'
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, Info } from 'lucide-react'
import { type PhonesBridge, type PhonesCommand, type PhonesState } from '../../../../shared/phones'
import type { SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { Field } from '../../components/Field'
import { Toggle } from '../../components/Toggle'
import { writeClipboard } from '../../agents/richActions'
import { countdown, PhoneRow, StepMark, type Step } from './phoneParts'
import './hosts.css'
import './phones.css'

/** What a failed step says: what happened, that nothing was changed, and what to do. */
export function phonesFailure(state: PhonesState): string | null {
  if (state.phase === 'cleanup-failed') return state.serve.status === 'failed' && state.serve.reason === 'cleanup-record'
    ? 'Phones can’t connect. Sotto couldn’t read its saved cleanup record, so it can’t identify the Tailscale Serve setting. Remove Sotto’s setting on port 8443 or 10000 in Tailscale, then press Try again. Sotto is still finishing cleanup.'
    : 'Phones can’t connect. Sotto is still finishing cleanup of its Tailscale Serve setting and will try again while it is open. Check Tailscale, then press Try again.'
  if (state.tailscale.status === 'failed') {
    return state.tailscale.reason === 'missing'
      ? 'Tailscale isn’t installed on this computer. Phones can’t reach it yet, and nothing was changed. Install Tailscale and sign in, then press Try again.'
      : 'Tailscale isn’t running on this computer, or isn’t signed in. Phones can’t reach it yet, and nothing was changed. Open Tailscale and sign in, then press Try again.'
  }
  if (state.serve.status !== 'failed') return null
  switch (state.serve.reason) {
    case 'port-taken': return 'Other apps already use ports 8443 and 10000 in Tailscale Serve on this computer. Sotto left those settings alone, and nothing was changed. Stop one of those apps, then press Try again.'
    case 'not-enabled': return 'Tailscale Serve isn’t turned on for your tailnet. Nothing was changed. Turn it on in Tailscale, then press Try again.'
    case 'denied': return 'Tailscale on this computer won’t let your account change Tailscale Serve. Nothing was changed. Let your account manage Tailscale, then press Try again.'
    case 'listener': return 'Sotto couldn’t open its listener for phones on this computer. Nothing was changed. Press Try again, or restart Sotto.'
    case 'record': return 'Sotto couldn’t save its phone access settings. Phone access wasn’t started. Check that Sotto can write to its data folder, then press Try again.'
    case 'cleanup-record':
    case 'cleanup': return null
    case 'failed': return `Tailscale Serve couldn’t be set up on port ${state.servePort ?? 8443}. Nothing was changed. Check Tailscale on this computer, then press Try again.`
  }
}

/** The name phones show for this computer, saved when the field loses focus or on Enter. */
function NameField({ name, defaultName, onSave }: { readonly name: string; readonly defaultName: string; readonly onSave: (name: string) => Promise<boolean> }): ReactNode {
  const [draft, setDraft] = useState(name)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setDraft(name) }, [name])
  const save = (): void => {
    const next = draft.trim()
    if (next !== name) void onSave(next).then(saved => setFailed(!saved))
    else { setDraft(name); setFailed(false) }
  }
  return <Field label="Name on phones" {...(failed ? { error: 'The name could not be saved. Phones still use the previous name. Try again.' } : {})} description={`Phones list this computer’s threads under this name. Leave it empty to use ${defaultName}.`}>
    <input className="tt-input" value={draft} placeholder={defaultName} maxLength={63} spellCheck={false}
      onChange={event => setDraft(event.target.value)} onBlur={save}
      onKeyDown={event => { if (isCompositionKey(event.nativeEvent)) { event.stopPropagation(); return } if (event.key === 'Enter') { event.preventDefault(); save() } else if (event.key === 'Escape' && draft !== name) { event.preventDefault(); event.stopPropagation(); setDraft(name) } }} />
  </Field>
}

export function PhonesSettings({ phoneAccess, phoneAccessName, onUpdateSettings, onOpenHosts, bridge = window.sotto?.phones }: {
  readonly phoneAccess: boolean
  readonly phoneAccessName: string
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onOpenHosts: () => void
  readonly bridge?: PhonesBridge | undefined
}): ReactNode {
  const [state, setState] = useState<PhonesState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accessSaveFailed, setAccessSaveFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const showButton = useRef<HTMLButtonElement>(null)
  const codeBox = useRef<HTMLDivElement>(null)
  const previous = useRef<PhonesState | null>(null)
  const pairHeading = useId()
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }).catch(() => { if (alive) setError('Phone access could not be read. Reopen Settings and try again.') })
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
    if (added) setAnnouncement(`${added.name} is paired.`)
    // Focus that was inside the code went with it to the page's body; anywhere else, it stays where it is.
    const focused = document.activeElement
    if (focused === null || focused === document.body || !focused.isConnected) queueMicrotask(() => showButton.current?.focus())
  }, [state])
  useEffect(() => { if (code) codeBox.current?.focus() }, [code?.code])
  const run = async (command: PhonesCommand): Promise<boolean> => {
    if (!bridge) return false
    setError(null)
    try { setState(await bridge.command(command)); return true }
    catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : 'Phone access could not be changed. Nothing was changed. Try again.'); return false }
  }
  const copyAddress = async (address: string): Promise<void> => {
    try { await writeClipboard(address); setCopied(true); setTimeout(() => setCopied(false), 1500) }
    catch { setError('The address could not be copied. Select it and copy it instead.') }
  }

  const localHostRunning = state?.localHostRunning ?? true
  const on = state?.phase === 'on' && state.enabled
  const starting = state?.phase === 'starting'
  const failure = state ? phonesFailure(state) : null
  const tailscaleStep: Step = state?.tailscale.status === 'ok' ? 'ok' : state?.tailscale.status === 'failed' ? 'failed' : 'waiting'
  const serveStep: Step = state?.serve.status === 'ok' ? 'ok' : state?.serve.status === 'failed' ? 'failed' : 'waiting'
  const addressStep: Step = state?.address ? 'ok' : 'waiting'
  const machine = state?.tailscale.status === 'ok' ? state.tailscale.dnsName.split('.')[0]! : state?.defaultName ?? 'this computer'
  const notYet = 'Checked when you turn this on.'
  const retry = <Button variant="secondary" onClick={() => void run({ type: 'retry' })}>Try again</Button>
  const removing = state?.phones.find(phone => phone.clientId === removeId)

  const codeCard = !on
    ? <div key="off" className="phones-code" data-off="">
      <p>{phoneAccess && localHostRunning ? 'Finish the steps above first.' : 'Turn on Let phones connect first.'}</p>
      <Button ref={showButton} variant="secondary" disabled>Show a pairing code</Button>
    </div>
    : code
      ? (() => {
        const left = countdown(code.expiresAt, now)
        return <div key="code" ref={codeBox} className="phones-code" role="group" aria-label="Pairing code" tabIndex={-1}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void run({ type: 'cancel-code' }) } }}>
          <p>Pairing code</p>
          <span className="phones-code__value" aria-hidden="true">{code.code.slice(0, 4)}<i />{code.code.slice(4)}</span>
          <span className="tt-visually-hidden">Pairing code {[...code.code].join(' ')}</span>
          <span className="phones-count">
            <span className="phones-count__bar" aria-hidden="true"><i style={{ width: `${left.fraction * 100}%` }} /></span>
            <span>Works once. Expires in <b>{left.text}</b></span>
          </span>
          <span className="phones-code__actions">
            <Button variant="ghost" onClick={() => void run({ type: 'show-code' })}>Make a new code</Button>
            <Button variant="ghost" onClick={() => void run({ type: 'cancel-code' })}>Cancel code</Button>
          </span>
        </div>
      })()
      : <div key="ready" className="phones-code">
        <p>A code works once, for five minutes.</p>
        <Button ref={showButton} variant="primary" onClick={() => void run({ type: 'show-code' })}>Show a pairing code</Button>
      </div>

  return <div className="hosts-settings phones-settings">
    {!localHostRunning ? <div className="hosts-notice phones-needs-host">
      <Info size={16} aria-hidden="true" />
      <p>Phone access needs the local host, which is off. Phones reach the threads this computer runs. Turn on Run the local host under Hosts, then restart Sotto.</p>
      <Button variant="secondary" onClick={onOpenHosts}>Go to Hosts</Button>
    </div> : null}
    <div className="phones-switch">
      <Toggle label="Let phones connect" checked={phoneAccess} disabled={!bridge || (!localHostRunning && !phoneAccess)}
        onCheckedChange={enabled => { setError(null); void onUpdateSettings({ phoneAccess: enabled }).then(saved => setAccessSaveFailed(!saved)) }}
        description={`Sotto adds this computer to Tailscale Serve on port 8443, or 10000 when another app uses 8443, so phones on your tailnet can find it. Only phones you pair can connect. Turning this off removes the setting.`} />
      {accessSaveFailed ? <p className="tt-field__error" role="alert">Phone access could not be saved. Nothing was changed. Try again.</p> : null}
    </div>
    <ol className="phones-steps" aria-label="Setup" aria-busy={starting || undefined}>
      <li data-step={tailscaleStep}>
        <StepMark step={tailscaleStep} />
        <div className="phones-step__copy"><b>Tailscale is running</b>
          <p>{tailscaleStep === 'ok' ? <>Signed in. This computer is <span className="phones-mono">{machine}</span> on your tailnet.</> : tailscaleStep === 'failed' ? failure : starting ? 'Checking…' : notYet}</p>
        </div>
        {tailscaleStep === 'failed' ? retry : null}
      </li>
      <li data-step={serveStep}>
        <StepMark step={serveStep} />
        <div className="phones-step__copy"><b>Tailscale Serve on port {state?.servePort ?? 8443}</b>
          <p>{serveStep === 'ok' ? (state?.servePort === 10000 ? 'Sotto added it on 10000, because another app uses 8443. Port 443 stays free for other apps.' : 'Sotto added it. Port 443 stays free for other apps.') : serveStep === 'failed' ? failure : tailscaleStep === 'failed' ? 'Waits for Tailscale.' : starting ? 'Setting it up…' : notYet}</p>
        </div>
        {serveStep === 'failed' ? <span className="phones-step__actions">
          {state?.serve.status === 'failed' && state.serve.canOpenSetup ? <Button variant="secondary" onClick={() => void run({ type: 'open-serve-setup' })}>Turn on Serve in Tailscale</Button> : null}
          {retry}
        </span> : null}
      </li>
      <li data-step={addressStep}>
        <StepMark step={addressStep} />
        <div className="phones-step__copy"><b>Address phones use</b>
          <p>{state?.address ? <span className="phones-mono phones-address">{state.address}</span> : state?.phase === 'failed' || starting ? 'Waits for the steps above.' : notYet}</p>
        </div>
        {state?.address ? <Button variant="ghost" onClick={() => void copyAddress(state.address!)}>{copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{copied ? 'Copied' : 'Copy address'}</Button> : null}
      </li>
    </ol>
    <section className="phones-pair" aria-labelledby={pairHeading}>
      <div>
        <h3 id={pairHeading}>Pair a phone</h3>
        <ol className="phones-how">
          <li>On your iPhone, open Sotto and tap <b>Add computer</b>.</li>
          <li>Enter <b className="phones-mono">{machine}</b>.</li>
          <li>Enter the code shown here.</li>
        </ol>
        <p className="phones-note">A paired phone reads threads and replies. It answers questions and permissions only after you turn on Can answer for it.</p>
      </div>
      {codeCard}
    </section>
    <p className="phones-live" role="status" aria-live="polite">{announcement}</p>
    {state?.phones.length ? <section aria-labelledby={`${pairHeading}-phones`}>
      <h3 id={`${pairHeading}-phones`}>Paired phones</h3>
      <div className="hosts-list phones-list">
        {state.phones.map(phone => <PhoneRow key={phone.clientId} phone={phone} answersAvailable={state.answersAvailable}
          onCanAnswer={allowed => void run({ type: 'set-can-answer', clientId: phone.clientId, allowed })} onRemove={() => setRemoveId(phone.clientId)} />)}
      </div>
    </section> : null}
    {state ? <div className="phones-name">
      <NameField name={phoneAccessName} defaultName={state.defaultName} onSave={name => onUpdateSettings({ phoneAccessName: name })} />
    </div> : null}
    {error ? <div className="hosts-notice hosts-notice--error" role="alert"><AlertTriangle size={16} aria-hidden="true" /><p>{error}</p></div> : null}
    {removing ? <ConfirmationDialog title={`Remove ${removing.name}?`} confirmLabel="Remove phone" cancelLabel="Keep phone"
      description={`${removing.name} can no longer reach this computer, and its connection closes now. Threads stay here. To use it again, pair it with a new code.`}
      onCancel={() => setRemoveId(null)} onConfirm={() => run({ type: 'remove', clientId: removing.clientId })}
      failureMessage={error} fallbackFocusRef={showButton} /> : null}
  </div>
}
