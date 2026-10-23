import React, { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'

import { findSettings, type SettingEntry } from './settingsPages'

/**
 * Find a setting: a field at the top of Settings' rail. While it holds text, the rail lists the settings that match in
 * place of the pages, each with the page it is on; pressing one opens that page with focus on the setting.
 */
export function SettingsFindField({ query, onQueryChange, onOpenFirst, onEnterResults, inputRef }: {
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly onOpenFirst: () => void
  readonly onEnterResults: () => void
  readonly inputRef: React.RefObject<HTMLInputElement | null>
}): ReactNode {
  return <div className="threads-search settings-find">
    <Search size={15} strokeWidth={1.8} aria-hidden="true" />
    <input ref={inputRef} type="search" className="tt-input tt-focusable" placeholder="Find a setting" aria-label="Find a setting"
      value={query} onChange={event => onQueryChange(event.currentTarget.value)} autoComplete="off" spellCheck={false}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' && query.trim()) { event.preventDefault(); onEnterResults() }
        else if (event.key === 'Enter' && query.trim()) { event.preventDefault(); onOpenFirst() }
        else if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); onQueryChange('') }
      }} />
    {query ? <button type="button" className="threads-search__clear tt-focusable" aria-label="Clear Find a setting" onClick={() => { onQueryChange(''); inputRef.current?.focus() }}><X size={14} aria-hidden="true" /></button> : null}
  </div>
}

export function SettingsFindResults({ query, index, pageOf, onOpen, onLeave, listRef }: {
  readonly query: string
  readonly index: readonly SettingEntry[]
  /** The name of the page an entry opens, as the rail shows it. */
  readonly pageOf: (entry: SettingEntry) => string
  readonly onOpen: (entry: SettingEntry) => void
  /** Escape, or Up from the first result: back to the field. */
  readonly onLeave: (clear: boolean) => void
  readonly listRef: React.RefObject<HTMLUListElement | null>
}): ReactNode {
  const statusId = useId()
  const found = findSettings(index, query)
  const buttons = useRef<HTMLButtonElement[]>([])
  const move = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    let next: number
    if (event.key === 'ArrowDown') next = Math.min(found.length - 1, at + 1)
    else if (event.key === 'ArrowUp') { if (at === 0) { event.preventDefault(); onLeave(false); return } next = at - 1 }
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = found.length - 1
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onLeave(true); return }
    else return
    event.preventDefault()
    buttons.current[next]?.focus()
  }
  return <div className="settings-find__results">
    <p className="tt-visually-hidden" id={statusId} role="status">{found.length === 0 ? '' : `${found.length} ${found.length === 1 ? 'setting' : 'settings'} found`}</p>
    {found.length === 0
      ? <p className="settings-find__empty">No setting matches “{query.trim()}”.</p>
      : <ul ref={listRef} aria-label="Settings found">{found.map((entry, at) => <li key={`${entry.section}:${entry.label}`}>
        <button type="button" className="tt-focusable" ref={element => { if (element) buttons.current[at] = element }}
          onClick={() => onOpen(entry)} onKeyDown={event => move(event, at)}>
          <span>{entry.label}</span><small>{pageOf(entry)}</small>
        </button>
      </li>)}</ul>}
  </div>
}
