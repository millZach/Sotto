import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Network } from 'lucide-react'
import type { HostsBridge } from '../../../../shared/hosts'
import type { TailscaleSummary } from '../../../../shared/hostDevices'
import { Button } from '../../components/Button'
import './hostDevices.css'

/** How often Sotto looks at Tailscale again while a sign-in finishes in the browser, and for how long. */
const SIGN_IN_POLL_MS = 3_000
const SIGN_IN_WAIT_MS = 10 * 60_000

export interface TailscaleControl {
  /** Tailscale on this computer, or null until it has been read. */
  readonly summary: TailscaleSummary | null
  /** `connecting` while `tailscale up` runs; `signing-in` while Sotto waits for the sign-in in the browser. */
  readonly phase: 'idle' | 'connecting' | 'signing-in'
  /** What the last press did, when it needs saying. */
  readonly notice: string | null
  readonly connect: () => void
  readonly getTailscale: () => void
}

/**
 * Tailscale on this computer, for the Hosts page's row and Add host's prompt: read when the page opens and
 * whenever the window comes back to the front (after installing Tailscale, say), and every few seconds
 * while a sign-in finishes in the browser.
 */
export function useTailscale(bridge: HostsBridge | undefined): TailscaleControl {
  const [summary, setSummary] = useState<TailscaleSummary | null>(null)
  const [phase, setPhase] = useState<TailscaleControl['phase']>('idle')
  const [notice, setNotice] = useState<string | null>(null)
  const [unread, setUnread] = useState(false)
  const alive = useRef(true)
  const refresh = useCallback(async (): Promise<TailscaleSummary | null> => {
    if (!bridge) return null
    try {
      const next = await bridge.tailscale()
      if (alive.current) { setSummary(next); setUnread(false) }
      return next
    } catch {
      if (alive.current) setUnread(true)
      return null
    }
  }, [bridge])
  useEffect(() => {
    alive.current = true
    void refresh()
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { alive.current = false; window.removeEventListener('focus', onFocus) }
  }, [refresh])
  useEffect(() => {
    if (phase !== 'signing-in') return
    const started = Date.now()
    const timer = window.setInterval(() => {
      void refresh().then(next => {
        if (!alive.current) return
        if (next?.state === 'running') { setPhase('idle'); setNotice(null) }
        else if (Date.now() - started > SIGN_IN_WAIT_MS) { setPhase('idle'); setNotice('Tailscale is still not signed in. Press Connect to Tailscale to try again.') }
      })
    }, SIGN_IN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [phase, refresh])
  const connect = useCallback((): void => {
    if (!bridge) return
    // A press while the sign-in goes on opens the same page again: main keeps the one tailscale up running.
    const reopening = phase === 'signing-in'
    if (!reopening) { setPhase('connecting'); setNotice(null) }
    void bridge.connectTailscale().catch(() => 'failed' as const).then(async outcome => {
      if (!alive.current) return
      if (outcome === 'sign-in-opened') { setPhase('signing-in'); setNotice('Sign in to Tailscale in your browser. Sotto lists your devices once you have.'); return }
      setPhase('idle')
      await refresh()
      if (!alive.current) return
      if (outcome === 'sign-in-needed') setNotice(reopening ? 'Your browser did not open. Open the Tailscale app on this computer and sign in there.' : 'Tailscale needs you to sign in. Open the Tailscale app on this computer and sign in there.')
      else if (outcome === 'failed') setNotice('Tailscale did not connect. Open the Tailscale app on this computer and connect from there.')
    })
  }, [bridge, phase, refresh])
  const getTailscale = useCallback((): void => {
    if (!bridge) return
    setNotice(null)
    void bridge.openTailscaleDownload().catch(() => { if (alive.current) setNotice('Your browser did not open. Go to tailscale.com/download to get Tailscale.') })
  }, [bridge])
  // A first read that fails leaves the row saying so, rather than checking for ever.
  const unreadNotice = unread && summary === null ? 'Sotto could not check Tailscale on this computer. Nothing was changed. Come back to this window to check again.' : null
  return { summary, phase, notice: notice ?? unreadNotice, connect, getTailscale }
}

const devicesOnTailnet = (count: number): string => `${count} ${count === 1 ? 'device' : 'devices'} on your tailnet`

/**
 * The button a Tailscale that is off or missing offers: the same on the Hosts page and in Add host, where
 * Connect to Tailscale is the primary action. While the sign-in goes on in the browser it opens the sign-in
 * page again, since a second tailscale up would only replace the first.
 */
function TailscaleAction({ control, summary, primary = false }: { readonly control: TailscaleControl; readonly summary: TailscaleSummary; readonly primary?: boolean }): ReactNode {
  if (summary.state === 'missing') return <Button variant="secondary" onClick={control.getTailscale}>Get Tailscale</Button>
  if (summary.state !== 'off') return null
  const label = control.phase === 'connecting' ? 'Connecting…' : control.phase === 'signing-in' ? 'Open sign-in page' : 'Connect to Tailscale'
  return <Button variant={primary ? 'primary' : 'secondary'} disabled={control.phase === 'connecting'} onClick={control.connect}>{label}</Button>
}

/** The Hosts page's Tailscale row, under This computer. */
export function TailscaleRow({ control }: { readonly control: TailscaleControl }): ReactNode {
  const { summary } = control
  return <section className="hosts-tailscale" aria-label="Tailscale">
    <span className="hosts-row__icon hosts-row__icon--local" aria-hidden="true"><Network size={18} /></span>
    <div className="hosts-tailscale__copy">
      <h4>Tailscale</h4>
      {summary === null ? <p>Checking Tailscale on this computer…</p>
        : summary.state === 'running' ? <p><span className="hosts-dot" data-online="true" aria-hidden="true" />Connected as {summary.user} · {devicesOnTailnet(summary.deviceCount)}</p>
        : summary.state === 'off' ? <p>Off on this computer. Connect to reach your other machines.</p>
        : <p>Not installed. Any machine you reach over SSH works without it, and Sotto connects to it over SSH each time.</p>}
      {control.notice ? <p className="hosts-tailscale__notice" role="status">{control.notice}</p> : null}
    </div>
    {summary ? <div className="hosts-tailscale__action"><TailscaleAction control={control} summary={summary} /></div> : null}
  </section>
}

/** Add host's prompt when Tailscale on this computer is off or missing. */
export function TailscalePrompt({ control }: { readonly control: TailscaleControl }): ReactNode {
  const { summary } = control
  if (summary === null || summary.state === 'running') return control.notice ? <p className="hosts-tailscale-prompt__notice" role="status">{control.notice}</p> : null
  return <div className="hosts-tailscale-prompt">
    <p>{summary.state === 'off'
      ? <><b>Tailscale is off on this computer.</b> Connect to see the machines on your tailnet.</>
      : <><b>Tailscale is not installed.</b> Any machine you reach over SSH works; Tailscale makes your other machines easy to reach.</>}</p>
    <TailscaleAction control={control} summary={summary} primary />
    {control.notice ? <p className="hosts-tailscale-prompt__notice" role="status">{control.notice}</p> : null}
  </div>
}
