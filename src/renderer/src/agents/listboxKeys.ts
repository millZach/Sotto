import type { KeyboardEvent } from 'react'

/** Arrow, Home and End move focus through a list's enabled buttons; any other key is left to the list. */
export function moveListboxFocus(event: KeyboardEvent<HTMLElement>, list: HTMLElement | null): void {
  const items = [...(list?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  if (items.length === 0) return
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'ArrowDown' ? (index + 1) % items.length
    : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
  if (next >= 0) { event.preventDefault(); items[next]?.focus() }
}
