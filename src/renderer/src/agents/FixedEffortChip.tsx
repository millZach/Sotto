import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { t } from '@lingui/core/macro'
import { effortLabel } from './effortNames'
import { OPTION_CHIP_NAMES } from './optionChipNames'

/** How long the pointer rests on the chip before its tip shows, as the model chip's card waits. */
const TIP_REST_MS = 300

/** Why a started thread's effort can't change, where its provider keeps the level the thread began on. */
export function fixedEffortReason(provider: string): string {
  return t({ message: `${provider} keeps the effort a thread started on. To use another level, start a new thread.`,
    comment: 'Why a started thread\'s reasoning effort chip opens nothing. {provider} is a provider\'s name, such as Grok Build.' })
}

/**
 * A started thread's effort where its provider can't change it in place (Grok, #228): a chip with a dashed edge and a
 * lock that opens nothing. Its tip says why when the pointer rests on it or the keyboard reaches it, and a screen reader
 * hears the same as its description (Zach's pick B, November 9, 2026, kept as the tag `prototype/grok-effort-locked`).
 * In the quiet composer it takes the split chip's place and shape; elsewhere a chip's.
 */
export function FixedEffortChip({ level, provider, quiet, trace }: {
  /** The level the thread runs at; empty for the provider's default. */
  readonly level: string
  readonly provider: string
  readonly quiet: boolean
  /** Whether the level is the model's top, where the composer's trace lights, as it does for the chip this replaces. */
  readonly trace: boolean
}): ReactNode {
  const id = useId()
  const [rested, setRested] = useState(false)
  const [focused, setFocused] = useState(false)
  const [away, setAway] = useState(false)
  const rest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(rest.current), [])
  const shown = !away && (rested || focused)
  const word = level ? effortLabel(level) : t`Provider default`
  const label = OPTION_CHIP_NAMES.effort
  return <span className={quiet ? 'split-chip-effort effort-fixed' : 'thread-chip-menu effort-fixed'} data-effort-trace={trace}>
    <button type="button" className={`${quiet ? 'split-chip-effort__trigger' : 'thread-chip'} effort-fixed__chip tt-focusable`} aria-disabled="true"
      aria-label={t({ message: `${label}, ${word}`, comment: 'A reasoning effort chip that cannot be changed: the setting\'s name, then the level it stays on, such as High.' })}
      aria-describedby={id}
      onPointerEnter={() => { clearTimeout(rest.current); rest.current = setTimeout(() => setRested(true), TIP_REST_MS) }}
      onPointerLeave={() => { clearTimeout(rest.current); setRested(false); setAway(false) }}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setFocused(true) }}
      onBlur={() => { setFocused(false); setAway(false) }}
      onClick={() => { setAway(false); setRested(true) }}
      onKeyDown={event => { if (event.key === 'Escape' && shown) { event.preventDefault(); event.stopPropagation(); setAway(true) } }}>
      <Lock size={11} aria-hidden="true" />
      <span className={quiet ? 'split-chip-effort__word' : undefined}>{word}</span>
    </button>
    <span id={id} role="tooltip" className="effort-fixed__tip" data-shown={shown || undefined}>{fixedEffortReason(provider)}</span>
  </span>
}
