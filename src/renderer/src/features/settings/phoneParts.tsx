import React, { type ReactNode } from 'react'
import { Circle, CircleCheck, CircleX, Smartphone } from 'lucide-react'
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
  const label = step === 'ok' ? 'Done' : step === 'failed' ? 'Failed' : 'Not yet'
  return <span className="phones-step__mark" role="img" aria-label={label}>
    {step === 'ok' ? <CircleCheck size={22} strokeWidth={1.7} aria-hidden="true" /> : step === 'failed' ? <CircleX size={22} strokeWidth={1.7} aria-hidden="true" /> : <Circle size={22} strokeWidth={1.7} aria-hidden="true" />}
  </span>
}

/** A paired phone: when it paired, whether it is connected, what it may do, its Can answer switch and Remove. */
export function PhoneRow({ phone, answersAvailable, onCanAnswer, onRemove, disabled = false }: {
  readonly phone: PairedPhone; readonly answersAvailable: boolean
  readonly onCanAnswer: (allowed: boolean) => void; readonly onRemove: () => void
  /** Shown as it was last read, from a host that cannot be reached now. */
  readonly disabled?: boolean
}): ReactNode {
  return <section className="hosts-row" aria-label={phone.name}>
    <span className="hosts-row__icon" aria-hidden="true"><Smartphone size={18} /></span>
    <div className="hosts-row__info">
      <h4>{phone.name}</h4>
      <p className="hosts-row__meta">Paired {pairedOn(phone.pairedAt)} · <span data-phase={phone.connected ? 'connected' : 'disconnected'}>{phone.connected ? 'Connected' : 'Not connected'}</span></p>
      <p className="phones-grant">{phone.canAnswer ? 'Reads and replies. Can answer questions and permissions.' : 'Reads and replies. Can’t answer questions or permissions.'}</p>
    </div>
    <div className="hosts-row__actions">
      <span className="phones-answer">
        <span aria-hidden="true">Can answer</span>
        <button type="button" role="switch" aria-checked={phone.canAnswer} aria-label={`Can answer: let ${phone.name} answer questions and permissions`} disabled={disabled || !answersAvailable}
          className="tt-toggle tt-focusable hosts-switch__control" onClick={() => onCanAnswer(!phone.canAnswer)}>
          <span className="tt-toggle__track" aria-hidden="true"><span className="tt-toggle__thumb" /></span>
        </button>
      </span>
      <Button variant="danger" aria-label={`Remove ${phone.name}`} disabled={disabled} onClick={onRemove}>Remove</Button>
    </div>
  </section>
}
