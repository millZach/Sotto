import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'

/**
 * One row of a pane's More menu. An item the thread cannot take right now is listed and disabled rather
 * than removed, so the menu keeps its shape while a turn runs.
 */
export interface PaneMenuItem {
  readonly id: string
  readonly label: string
  readonly icon?: ReactNode
  readonly disabled?: boolean
  readonly run: () => void
}

const ITEM = '[role="menuitem"]:not(:disabled)'

/**
 * The pane header's "…" menu: everything that acts on this thread or terminal but does not earn a button of
 * its own. Groups are separated by a hairline, and an empty group draws nothing, so a menu missing an item
 * never shows two rules in a row.
 *
 * It renders inside the header instead of a portal, so the header still contains the focus it hands out and
 * the pane's own focus bookkeeping keeps working. Escape or Tab closes it and returns focus to the button,
 * as a pointer outside it does.
 */
export function PaneMenu({ groups, label = 'More actions' }: {
  readonly groups: readonly (readonly PaneMenuItem[])[]
  readonly label?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>(ITEM)?.focus()
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    const away = (): void => setOpen(false)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('blur', away)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', away) }
  }, [open])
  const shown = groups.filter(group => group.length > 0)
  if (shown.length === 0) return null
  const close = (restore: boolean): void => {
    setOpen(false)
    if (restore) button.current?.focus()
  }
  return <div className="pane-menu">
    <button ref={button} type="button" className="pane-action tt-focusable" aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}
      // A menu whose every row is disabled leaves focus on the button; Escape still puts it away.
      onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) } }}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {open ? <div ref={list} className="pane-menu__list" role="menu" aria-label={label}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return }
        const entries = [...(list.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])]
        const index = entries.indexOf(document.activeElement as HTMLElement)
        const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1
          : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : null
        if (next === null) return
        event.preventDefault()
        entries[(next + entries.length) % entries.length]?.focus()
      }}>
      {shown.map((group, index) => <React.Fragment key={group[0]!.id}>
        {index > 0 ? <hr /> : null}
        {group.map(item => <button key={item.id} type="button" role="menuitem" className="pane-menu__item" tabIndex={-1} disabled={item.disabled}
          onClick={() => { close(true); item.run() }}>{item.icon}{item.label}</button>)}
      </React.Fragment>)}
    </div> : null}
  </div>
}
