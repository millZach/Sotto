import type { KeyboardEvent } from 'react'

/**
 * Arrow, Home and End move focus through a list's enabled buttons; any other key is left to the list. Up from the first
 * button goes to `above` where the list has one, as a menu's search line, and wraps to the last where it has none.
 */
export function moveListboxFocus(event: KeyboardEvent<HTMLElement>, list: HTMLElement | null, above?: HTMLElement | null): void {
  const items = [...(list?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  if (items.length === 0) return
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'ArrowUp' && index === 0 && above) { event.preventDefault(); above.focus(); return }
  const next = event.key === 'ArrowDown' ? (index + 1) % items.length
    : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
  if (next >= 0) { event.preventDefault(); items[next]?.focus() }
}
