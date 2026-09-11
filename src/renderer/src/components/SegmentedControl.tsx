import React, { type ReactNode } from 'react'

export function SegmentedControl({ label, value, options, onChange, disabled = false }: {
  readonly label: string; readonly value: string; readonly options: ReadonlyArray<{ value: string; label: string }>
  readonly onChange: (value: string) => void; readonly disabled?: boolean
}): ReactNode {
  return <div className="segmented-control" role="radiogroup" aria-label={label}>{options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} disabled={disabled} tabIndex={value === option.value ? 0 : -1} onClick={() => onChange(option.value)} onKeyDown={event => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = (index + delta + options.length) % options.length
    onChange(options[next]!.value)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }}>{option.label}</button>)}</div>
}
