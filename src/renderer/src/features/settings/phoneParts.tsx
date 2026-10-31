import React, { type ReactNode } from 'react'
import { Circle, CircleCheck, CircleX, Smartphone } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { PairedPhone } from '../../../../shared/phones'
import { Button } from '../../components/Button'

/** Pieces of phone access that this computer's Phones page and a remote host's Phones dialog share (ADR-0033, ADR-0050). */

export type Step = 'ok' | 'failed' | 'waiting'

/** "Sep 26", with the year when it is not this one. */
export function pairedOn(iso: string, now = new Date()): string {
  const date = new Date(iso)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

export function countdown(expiresAt: string, now: number): { text: string; fraction: number } {
  const left = Math.max(0, Date.parse(expiresAt) - now)
  const seconds = Math.ceil(left / 1000)
  return { text: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, fraction: Math.min(1, left / 300_000) }
}

export function StepMark({ step }: { readonly step: Step }): ReactNode {
  const { t } = useLingui()
  const label = step === 'ok'
    ? t({ message: 'Done', comment: 'A setup step that has finished.' })
    : step === 'failed' ? t({ message: 'Failed', comment: 'A setup step that failed.' }) : t({ message: 'Not yet', comment: 'A setup step still to come.' })
  return <span className="phones-step__mark" role="img" aria-label={label}>
    {step === 'ok' ? <CircleCheck size={22} strokeWidth={1.7} aria-hidden="true" /> : step === 'failed' ? <CircleX size={22} strokeWidth={1.7} aria-hidden="true" /> : <Circle size={22} strokeWidth={1.7} aria-hidden="true" />}
  </span>
}

/**
 * A paired phone: when it paired, whether it is connected, what it may do, and Remove. Pairing let it answer, so Remove is
 * the only control: there is no switch for answers (ADR-0033).
 */
export function PhoneRow({ phone, onRemove, disabled = false }: {
  readonly phone: PairedPhone; readonly onRemove: () => void
  /** Shown as it was last read, from a host that cannot be reached now. */
  readonly disabled?: boolean
}): ReactNode {
  const { t } = useLingui()
  const name = phone.name, paired = pairedOn(phone.pairedAt)
  return <section className="hosts-row" aria-label={phone.name}>
    <span className="hosts-row__icon" aria-hidden="true"><Smartphone size={18} /></span>
    <div className="hosts-row__info">
      <h4>{phone.name}</h4>
      <p className="hosts-row__meta"><Trans>Paired {paired}</Trans> · <span data-phase={phone.connected ? 'connected' : 'disconnected'}>{phone.connected ? t({ message: 'Connected', comment: 'A provider on a host, or a host: connected and ready.' }) : t`Not connected`}</span></p>
      <p className="phones-grant tt-paragraph">{phone.canAnswer ? t`Reads and replies. Can answer questions and permissions.` : t`Reads and replies. Can’t answer questions or permissions.`}</p>
    </div>
    <div className="hosts-row__actions">
      <Button variant="danger" aria-label={t`Remove ${name}`} disabled={disabled} onClick={onRemove}>{t({ message: 'Remove', comment: 'Removes a paired phone.' })}</Button>
    </div>
  </section>
}
