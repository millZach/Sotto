import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, MoreHorizontal } from 'lucide-react'

/**
 * A popup under its button, drawn over the room so the scrolling page never clips it. It opens with a press, Enter,
 * Space or the Up and Down arrows; inside, the arrows, Home and End move, and Escape or Tab closes it and gives
 * focus back to the button, as a pointer outside it, a scroll or a resize do.
 */
function usePopup(align: 'start' | 'end') {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const close = useCallback((restore: boolean): void => { setOpen(false); setPlace(null); if (restore) button.current?.focus() }, [])
  useLayoutEffect(() => {
    if (!open) return
    const trigger = button.current?.getBoundingClientRect(), box = popup.current
    if (trigger === undefined || box === null) return
    const width = box.offsetWidth, height = box.offsetHeight
    const left = Math.max(8, Math.min(align === 'end' ? trigger.right - width : trigger.left, window.innerWidth - width - 8))
    let top = trigger.bottom + 6
    if (top + height > window.innerHeight - 8) top = Math.max(8, trigger.top - 6 - height)
    setPlace({ left, top })
  }, [open, align])
  // The first item takes focus once the popup is placed.
  const placed = place !== null
  useEffect(() => {
    if (!open || !placed) return
    const items = [...(popup.current?.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"]:not(:disabled)') ?? [])]
    // With every item disabled the popup itself takes focus, so Escape and Tab still reach it.
    const target = items.find(item => item.getAttribute('aria-selected') === 'true') ?? items[0] ?? popup.current ?? undefined
    target?.focus({ preventScroll: true })
    // Should a frame still refuse focus, the next one takes it.
    if (target === undefined || document.activeElement === target) return
    const frame = requestAnimationFrame(() => { if (popup.current?.contains(target)) target.focus({ preventScroll: true }) })
    return () => cancelAnimationFrame(frame)
  }, [open, placed])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event): void => {
      const target = event.target as Node
      if (!popup.current?.contains(target) && !button.current?.contains(target)) close(false)
    }
    const away = (): void => close(false)
    // Focus that leaves both the popup and its button, by Tab or a click elsewhere, closes it.
    const left = (event: FocusEvent): void => {
      const next = event.relatedTarget as Node | null
      if (next !== null && !popup.current?.contains(next) && !button.current?.contains(next)) close(false)
    }
    popup.current?.addEventListener('focusout', left)
    const scrolled = (event: Event): void => { if (!popup.current?.contains(event.target as Node)) close(false) }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', away); window.addEventListener('blur', away); window.addEventListener('scroll', scrolled, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      popup.current?.removeEventListener('focusout', left)
      window.removeEventListener('resize', away); window.removeEventListener('blur', away); window.removeEventListener('scroll', scrolled, true)
    }
  }, [open, close])
  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) { event.preventDefault(); setOpen(true) }
    else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true) }
  }
  const onPopupKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return }
    const items = [...(popup.current?.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"]:not(:disabled)') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null
    if (next === null || items.length === 0) return
    event.preventDefault()
    items[(next + items.length) % items.length]?.focus()
  }
  // Transparent rather than hidden until placed: Chromium will not focus an element under visibility: hidden.
  const style = place === null ? { left: 0, top: 0, opacity: 0, pointerEvents: 'none' as const } : { left: place.left, top: place.top }
  return { open, setOpen, close, button, popup, style, onButtonKey, onPopupKey }
}

export interface ChoiceOption<T extends string> { readonly value: T; readonly label: string }

/** A filter: the button names the current choice, the list offers the others. */
export function ChoiceMenu<T extends string>({ name, value, options, onChoose, align = 'end' }: {
  readonly name: string
  readonly value: T
  readonly options: readonly ChoiceOption<T>[]
  readonly onChoose: (value: T) => void
  readonly align?: 'start' | 'end'
}): ReactNode {
  const menu = usePopup(align)
  const current = options.find(option => option.value === value)?.label ?? ''
  return <>
    <button ref={menu.button} type="button" className="usage-filter tt-focusable" aria-haspopup="listbox" aria-expanded={menu.open} aria-label={`${name}: ${current}`}
      onClick={() => (menu.open ? menu.close(false) : menu.setOpen(true))} onKeyDown={menu.onButtonKey}>
      <span>{current}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {menu.open ? createPortal(<div ref={menu.popup} className="usage-pop" role="listbox" aria-label={name} tabIndex={-1} style={menu.style} onKeyDown={menu.onPopupKey}>
      {options.map(option => <button key={option.value} type="button" role="option" className="usage-pop__item" aria-selected={option.value === value} tabIndex={-1}
        onClick={() => { menu.close(true); onChoose(option.value) }}>
        <Check className="usage-pop__check" size={15} aria-hidden="true" />{option.label}
      </button>)}
    </div>, document.body) : null}
  </>
}

export interface ActionItem { readonly id: string; readonly label: string; readonly tone?: 'danger'; readonly disabled?: boolean; readonly hint?: string; readonly run: () => void }

/** The page's "…" menu. Its button is the focus a finished dialog returns to. */
export const ActionMenu = forwardRef<HTMLButtonElement | null, { readonly label: string; readonly items: readonly ActionItem[] }>(function ActionMenu({ label, items }, ref) {
  const menu = usePopup('end')
  useImperativeHandle<HTMLButtonElement | null, HTMLButtonElement | null>(ref, () => menu.button.current, [menu.button])
  return <>
    <button ref={menu.button} type="button" className="usage-more tt-focusable" aria-haspopup="menu" aria-expanded={menu.open} aria-label={label} title={label}
      onClick={() => (menu.open ? menu.close(false) : menu.setOpen(true))} onKeyDown={menu.onButtonKey}>
      <MoreHorizontal size={18} aria-hidden="true" />
    </button>
    {menu.open ? createPortal(<div ref={menu.popup} className="usage-pop" role="menu" aria-label={label} tabIndex={-1} style={menu.style} onKeyDown={menu.onPopupKey}>
      {items.map(item => <button key={item.id} type="button" role="menuitem" className="usage-pop__item" data-tone={item.tone} disabled={item.disabled} title={item.hint} tabIndex={-1}
        onClick={() => { menu.close(false); item.run() }}>
        {item.label}{item.hint ? <span className="tt-visually-hidden">. {item.hint}</span> : null}
      </button>)}
    </div>, document.body) : null}
  </>
})
