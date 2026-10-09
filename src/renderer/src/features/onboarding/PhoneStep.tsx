import { Check, ExternalLink } from 'lucide-react'
import React, { useEffect, useState, type ReactNode } from 'react'

import { IPHONE_BETA_URL, type PhonesBridge, type PhonesCommand, type PhonesState } from '../../../../shared/phones'
import type { SettingsPatch } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { Toggle } from '../../components/Toggle'
import { phonesFailure } from '../settings/PhonesSettings'
import { countdown } from '../settings/phoneParts'

export interface PhoneStepProps {
  readonly heading: ReactNode
  readonly phoneAccess: boolean
  readonly onUpdateSettings: (patch: SettingsPatch) => Promise<boolean>
  readonly onOpenLink: (url: string) => Promise<boolean>
  readonly bridge?: PhonesBridge | undefined
  /** Called when the beta page opened, so setup knows this step did something. */
  readonly onBetaOpened?: () => void
}

/**
 * Setup's iPhone step: get the beta from TestFlight, then let phones reach this computer and show a pairing code.
 * Phone access is the same setting and the same code as Settings › Phones, which keeps the steps, the paired phones and
 * the name phones show; this step shows only what a first pairing needs.
 */
export function PhoneStep({ heading, phoneAccess, onUpdateSettings, onOpenLink, bridge = window.sotto?.phones, onBetaOpened }: PhoneStepProps): ReactNode {
  const [state, setState] = useState<PhonesState | null>(null)
  const [beta, setBeta] = useState<'idle' | 'opened' | 'failed'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }).catch(() => { if (alive) setError('Sotto could not read phone access. Nothing was changed. You can turn it on later in Settings › Phones.') })
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

  const run = async (command: PhonesCommand): Promise<void> => {
    if (!bridge) return
    setError(null)
    try { setState(await bridge.command(command)) }
    catch (failure) { setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '') : 'Phone access could not be changed. Nothing was changed. Try again.') }
  }

  const openBeta = async (): Promise<void> => {
    const opened = await onOpenLink(IPHONE_BETA_URL)
    setBeta(opened ? 'opened' : 'failed')
    if (opened) onBetaOpened?.()
  }

  const localHostRunning = state?.localHostRunning ?? true
  const on = state?.phase === 'on' && state.enabled
  const failure = state && phoneAccess ? phonesFailure(state) : null
  const left = code ? countdown(code.expiresAt, now) : null

  return (
    <section aria-labelledby="onboarding-heading">
      {heading}
      <ol className="onboarding-phone">
        <li>
          <span className="onboarding-phone__number" aria-hidden="true">1</span>
          <div>
            <strong>Install the beta</strong>
            <span>Opens Apple's TestFlight page in your browser. Install TestFlight on the iPhone first.</span>
            {beta === 'opened' ? <span className="onboarding-ready" role="status"><Check aria-hidden="true" size={15} />Opened in your browser</span> : null}
            {beta === 'failed' ? <span className="onboarding-recovery" role="alert">Your browser did not open. Go to testflight.apple.com on your iPhone instead.</span> : null}
          </div>
          <Button variant={beta === 'opened' ? 'secondary' : 'primary'} onClick={() => void openBeta()}>
            <ExternalLink aria-hidden="true" size={15} />
            Get the iPhone beta
          </Button>
        </li>
        <li>
          <span className="onboarding-phone__number" aria-hidden="true">2</span>
          <div>
            <Toggle
              label="Let phones connect"
              checked={phoneAccess}
              disabled={!bridge || (!localHostRunning && !phoneAccess)}
              description="Lets your iPhone reach this computer over your tailnet. Only phones you pair can connect."
              onCheckedChange={enabled => { setError(null); void onUpdateSettings({ phoneAccess: enabled }).then(saved => setSaveFailed(!saved)) }}
            />
            {!localHostRunning ? <span className="onboarding-recovery">Phone access needs the local host, which is off. Turn on Run the local host in Settings › Hosts, then restart Sotto.</span> : null}
            {saveFailed ? <span className="onboarding-recovery" role="alert">Phone access could not be saved. Nothing was changed. Try again.</span> : null}
            {phoneAccess && state?.phase === 'starting' ? <span role="status">Checking Tailscale on this computer…</span> : null}
            {failure ? <span className="onboarding-recovery" role="alert">{failure}</span> : null}
            {failure ? <Button variant="secondary" onClick={() => void run({ type: 'retry' })}>Try again</Button> : null}
            {on && code && left ? (
              <div className="onboarding-phone__code" role="group" aria-label="Pairing code">
                <span>Pairing code</span>
                <b aria-hidden="true">{code.code.slice(0, 4)} {code.code.slice(4)}</b>
                <span className="tt-visually-hidden">Pairing code {[...code.code].join(' ')}</span>
                <span>Type it in the app's Add computer step. Works once. Expires in {left.text}.</span>
              </div>
            ) : null}
            {on && !code ? <Button variant="secondary" onClick={() => void run({ type: 'show-code' })}>Show a pairing code</Button> : null}
            {error ? <span className="onboarding-recovery" role="alert">{error}</span> : null}
          </div>
        </li>
      </ol>
      <p className="onboarding-aside">Paired phones, and the name they show for this computer, are in Settings › Phones.</p>
    </section>
  )
}
