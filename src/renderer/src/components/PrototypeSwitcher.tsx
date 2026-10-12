// PROTOTYPE — throwaway. A floating bar that flips between design variants on a dev build. Never ships.
import React, { useEffect, useState, type ReactNode } from 'react'

/** On in `npm run dev`, or in a build made with VITE_SOTTO_PROTOTYPE=1 for screenshots. Off in tests and releases. */
export function prototypesEnabled(): boolean {
  if (import.meta.env.MODE === 'test') return false
  return import.meta.env.DEV || import.meta.env.VITE_SOTTO_PROTOTYPE === '1'
}

export interface PrototypeVariant { readonly key: string; readonly name: string }

/**
 * The current variant key, kept in session storage so a reload stays on it. Not in the URL: main trusts IPC only
 * from the window's exact address, so a `?variant=` on it makes every save fail.
 */
export function usePrototypeVariant(variants: readonly PrototypeVariant[], name: string): [string, (key: string) => void] {
  const storageKey = `sotto-prototype:${name}`
  const read = (): string => {
    const asked = window.sessionStorage.getItem(storageKey)
    return variants.some(variant => variant.key === asked) ? asked! : variants[0]!.key
  }
  const [current, setCurrent] = useState(read)
  const choose = (key: string): void => {
    window.sessionStorage.setItem(storageKey, key)
    setCurrent(key)
  }
  return [current, choose]
}

export function PrototypeSwitcher({ variants, current, onChoose, children }: {
  readonly variants: readonly PrototypeVariant[]
  readonly current: string
  readonly onChoose: (key: string) => void
  readonly children?: ReactNode
}): ReactNode {
  const index = Math.max(0, variants.findIndex(variant => variant.key === current))
  const step = (by: number): void => onChoose(variants[(index + by + variants.length) % variants.length]!.key)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable], [role="tablist"], [role="radiogroup"]')) return
      event.preventDefault()
      step(event.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const variant = variants[index]!
  return <div className="prototype-switcher" role="group" aria-label="Prototype variants">
    <button type="button" aria-label="Previous variant" onClick={() => step(-1)}>‹</button>
    <span><b>{variant.key}</b> · {variant.name}</span>
    <button type="button" aria-label="Next variant" onClick={() => step(1)}>›</button>
    {children}
  </div>
}
