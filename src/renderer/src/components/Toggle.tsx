import React, { useId, type ReactNode } from 'react'

export interface ToggleProps {
  readonly label: string
  readonly checked: boolean
  readonly onCheckedChange: (checked: boolean) => void
  readonly disabled?: boolean
  readonly description?: string
}

export function Toggle({ label, checked, onCheckedChange, disabled = false, description }: ToggleProps): ReactNode {
  const descriptionId = useId()
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-describedby={description === undefined ? undefined : descriptionId}
      className="tt-toggle tt-focusable"
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="tt-toggle__track" aria-hidden="true"><span className="tt-toggle__thumb" /></span>
      <span className="tt-toggle__copy">
        <strong>{label}</strong>
        {description === undefined ? null : (
          <span
            id={descriptionId}
            className="tt-field__description"
          >{description}</span>
        )}
      </span>
    </button>
  )
}
