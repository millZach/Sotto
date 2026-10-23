import React, { useId, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { HostStatus } from '../../../../shared/hosts'
import type { HostConnectionName } from '../../../../shared/hostConnection'
import { lastReached } from './hostTailnetWords'

/**
 * Edit connection's How Sotto connects (ADR-0053): over the tailnet with SSH when it can't, or SSH only. The tailnet choice
 * says where the tailnet reaches the host and that it turns on Tailscale Serve there. A host this computer has never paired
 * with has nothing to choose yet. Focus starts on the choice the host has when the dialog opens, so the keyboard and a
 * screen reader land on what is chosen.
 */
export function HostConnectionChoice({ host, value, opened, disabled, onChange }: {
  readonly host: HostStatus
  readonly value: HostConnectionName
  /** The choice when the dialog opened, which takes focus first. */
  readonly opened: HostConnectionName
  readonly disabled: boolean
  readonly onChange: (value: HostConnectionName) => void
}): ReactNode {
  const { t } = useLingui()
  const name = useId(), tailnetId = useId(), tailnetHintId = useId(), sshId = useId(), sshHintId = useId()
  const paired = Boolean(host.hostId)
  const hostName = host.name, address = host.tailnetAddress, when = host.tailnetSeen ? lastReached(host.tailnetSeen) : ''
  const radio = (option: HostConnectionName, labelId: string, hintId: string): ReactNode => <input type="radio" name={name} value={option}
    checked={value === option} disabled={disabled || !paired} aria-labelledby={labelId} aria-describedby={hintId} className="tt-focusable"
    {...(opened === option ? { 'data-autofocus': true } : {})} onChange={() => onChange(option)} />
  return <fieldset className="hosts-fieldset">
    <legend>{t`How Sotto connects`}</legend>
    <div className="host-setup__choices">
      <label className="host-setup__choice" data-checked={value === 'tailnet' || undefined} data-disabled={!paired || undefined}>
        {radio('tailnet', tailnetId, tailnetHintId)}
        <span className="host-setup__choice-name" id={tailnetId}>{t`Over your tailnet, SSH when it can’t`}</span>
        <span className="host-setup__choice-text" id={tailnetHintId}>{address
          ? when
            ? <Trans>At <span className="hosts-dialog__address">{address}</span>, last reached at {when}.</Trans>
            : <Trans>At <span className="hosts-dialog__address">{address}</span>.</Trans>
          : t`${hostName} says where your tailnet reaches it once Serve is on.`}{' '}
          <Trans>Sotto turns on Tailscale Serve on {hostName} for this, on your tailnet only. Tailscale then asks for approval only for a press that signs in over SSH, such as Phones… or Stop host.</Trans></span>
      </label>
      <label className="host-setup__choice" data-checked={value === 'ssh' || undefined} data-disabled={!paired || undefined}>
        {radio('ssh', sshId, sshHintId)}
        <span className="host-setup__choice-name" id={sshId}>{t`SSH only`}</span>
        <span className="host-setup__choice-text" id={sshHintId}><Trans>Every connection signs in over SSH, and Tailscale may ask you to approve it each time.</Trans></span>
      </label>
    </div>
    {!paired ? <p className="tt-field__description"><Trans>Connect to {hostName} once before choosing how Sotto connects.</Trans></p> : null}
  </fieldset>
}
