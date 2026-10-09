import { MonitorSmartphone, Plus, Server } from 'lucide-react'
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { HostsBridge, HostsState } from '../../../../shared/hosts'
import { Button } from '../../components/Button'
import { HostDialog } from '../settings/HostDialog'
import { hostStatusLabel } from '../settings/HostsSettings'
import { useTailscale } from '../settings/TailscaleConnect'

export interface ComputersStepProps {
  readonly heading: ReactNode
  readonly bridge?: HostsBridge | undefined
  /** Called with the saved hosts whenever they change, so setup knows whether this step did anything. */
  readonly onHostsChange?: (count: number) => void
}

/**
 * Setup's other computers: the hosts this computer reaches, and Add a computer, which opens Settings › Hosts' own Add
 * host dialog with its device list, Tailscale prompt and host setup checklist. The dialog follows main's hosts state
 * live, so this step keeps that state as the Hosts page does.
 */
export function ComputersStep({ heading, bridge = window.sotto?.hosts, onHostsChange }: ComputersStepProps): ReactNode {
  const [state, setState] = useState<HostsState | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const addButton = useRef<HTMLButtonElement>(null)
  const tailscale = useTailscale(bridge)
  const onHostsChangeRef = useRef(onHostsChange)
  onHostsChangeRef.current = onHostsChange

  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge.get().then(value => { if (alive) setState(value) }).catch(() => { if (alive) setFailure('Sotto could not read your hosts. Nothing was changed. You can add a computer later in Settings › Hosts.') })
    const off = bridge.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; off() }
  }, [bridge])

  const hosts = state?.hosts ?? []
  useEffect(() => { onHostsChangeRef.current?.(hosts.length) }, [hosts.length])

  const close = (): void => {
    setAdding(false)
    queueMicrotask(() => addButton.current?.focus())
  }

  return (
    <section aria-labelledby="onboarding-heading">
      {heading}
      {hosts.length > 0 ? (
        <ul className="onboarding-hosts" aria-label="Your computers">
          {hosts.map(host => (
            <li key={host.id} className="onboarding-host" data-phase={host.phase}>
              <Server aria-hidden="true" size={18} />
              <span><strong>{host.name}</strong><span>{hostStatusLabel(host)}</span></span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="onboarding-hosts__empty">
          <MonitorSmartphone aria-hidden="true" size={22} />
          <p>Sotto lists the computers on your tailnet and the hosts in your SSH configuration, and sets Sotto up on the one you choose.</p>
        </div>
      )}
      <Button ref={addButton} variant={hosts.length > 0 ? 'secondary' : 'primary'} disabled={!bridge} onClick={() => setAdding(true)}>
        <Plus aria-hidden="true" size={17} />
        {hosts.length > 0 ? 'Add another computer' : 'Add a computer'}
      </Button>
      {failure ? <p className="onboarding-recovery" role="alert">{failure}</p> : null}
      <p className="onboarding-aside">Only using this computer? Skip this. Settings › Hosts adds one any time.</p>
      {adding && bridge ? createPortal(<HostDialog mode={{ kind: 'add' }} bridge={bridge} state={state} tailscale={tailscale} onClose={close} />, document.body) : null}
    </section>
  )
}
