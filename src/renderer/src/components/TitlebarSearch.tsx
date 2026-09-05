import React, { useEffect, useRef, type ReactNode } from 'react'
import { Search } from 'lucide-react'

import type { SottoPlatform } from '../../../shared/platform'

export interface TitlebarSearchProps {
  readonly value: string
  readonly platform: SottoPlatform
  readonly onChange: (value: string) => void
  /** Fired when the field takes focus or changes, so the page showing results can open. */
  readonly onActivate: () => void
}

/**
 * The titlebar's search field. It always searches transcript history: taking
 * focus opens History, and Ctrl+K (⌘K on macOS) jumps here from anywhere in
 * the window.
 */
export function TitlebarSearch({ value, platform, onChange, onActivate }: TitlebarSearchProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null)
  const chord = platform === 'darwin' ? '⌘ K' : 'Ctrl K'

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [platform])

  return (
    <div className="app-titlebar__search">
      <Search size={14} aria-hidden="true" />
      <input
        ref={inputRef}
        className="tt-input tt-focusable"
        type="search"
        aria-label="Search history"
        aria-keyshortcuts={platform === 'darwin' ? 'Meta+K' : 'Control+K'}
        placeholder="Search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onFocus={onActivate}
        onChange={(event) => {
          onChange(event.currentTarget.value)
          onActivate()
        }}
      />
      <kbd className="tt-kbd" aria-hidden="true">{chord}</kbd>
    </div>
  )
}
