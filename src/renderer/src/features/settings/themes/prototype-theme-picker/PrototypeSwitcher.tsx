/* PROTOTYPE, throwaway: the floating bar that flips between theme-picker variants. Development builds only. */

import React, { useEffect, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { PROTOTYPE_VARIANTS, setPrototypeState, usePrototypeState } from './prototypeState'

function step(current: string, by: number): (typeof PROTOTYPE_VARIANTS)[number]['key'] {
  const index = PROTOTYPE_VARIANTS.findIndex(entry => entry.key === current)
  return PROTOTYPE_VARIANTS[(index + by + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length]!.key
}

export function PrototypeSwitcher(): ReactNode {
  const { variant, palettes } = usePrototypeState()
  const index = PROTOTYPE_VARIANTS.findIndex(entry => entry.key === variant)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="radiogroup"], [role="slider"]')) return
      event.preventDefault()
      setPrototypeState({ variant: step(variant, event.key === 'ArrowLeft' ? -1 : 1) })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [variant])

  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype variants">
      <button type="button" aria-label="Previous variant" onClick={() => setPrototypeState({ variant: step(variant, -1) })}><ChevronLeft size={16} /></button>
      <span className="proto-switcher__label">{String.fromCharCode(65 + index)} · {PROTOTYPE_VARIANTS[index]!.name}</span>
      <button type="button" aria-label="Next variant" onClick={() => setPrototypeState({ variant: step(variant, 1) })}><ChevronRight size={16} /></button>
      <span className="proto-switcher__rule" />
      <span className="proto-switcher__palettes" role="group" aria-label="Palettes">
        <button type="button" aria-pressed={palettes === 'today'} onClick={() => setPrototypeState({ palettes: 'today' })}>Today’s palettes</button>
        <button type="button" aria-pressed={palettes === 'new'} onClick={() => setPrototypeState({ palettes: 'new' })}>New palettes</button>
      </span>
    </div>
  )
}
