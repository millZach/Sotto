import React, { useLayoutEffect, useRef, type ReactNode } from 'react'
import { firstMenuItem, menuKeyDown, PaneMenuRows, type PaneMenuItem } from './PaneMenu'

/** Where a row menu opens: at the pointer's point for a right-click, or beside the row for Shift+F10 and the menu key. */
export type RowMenuPlace = { readonly x: number; readonly y: number } | 'beside'

/** Where a keyboard-invoked context menu event says it was opened: Chromium reports no pointer position for one. */
export const rowMenuPlace = (event: Pick<MouseEvent, 'clientX' | 'clientY'>): RowMenuPlace =>
  event.clientX === 0 && event.clientY === 0 ? 'beside' : { x: event.clientX, y: event.clientY }

/** Shift+F10 or the menu key, the keys that open a row's menu (ADR-0164); Shift+F10 stands down for dictation's own keys. */
export function rowMenuPressed(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>, shiftF10: boolean): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false
  return event.key === 'ContextMenu' || (shiftF10 && event.key === 'F10' && event.shiftKey)
}

/**
 * A sidebar row's menu (ADR-0164, Zach's pick A of #1827): the row's actions in words, with the keys that do the same
 * from the row, in the pane menu's look and with its keys. It opens on a right-click, Shift+F10 or the menu key, takes
 * the focus to its first row, and Escape, Tab, a press outside or the window losing the focus closes it; Escape and Tab
 * hand the focus back to the row. It is drawn inside its row, so the row and its folder still contain the focus they
 * hand out, and shown in the top layer, so the sidebar's scrolling edge never cuts it. It follows its row as the sidebar
 * scrolls and closes when the row goes.
 */
export function RowMenu({ label, groups, anchor, place, onClose }: {
  readonly label: string
  readonly groups: readonly (readonly PaneMenuItem[])[]
  /** The row the menu belongs to, found afresh each frame. */
  readonly anchor: () => HTMLElement | null
  readonly place: RowMenuPlace
  /** Closes the menu; `restore` when the focus goes back to the row. */
  readonly onClose: (restore: boolean) => void
}): ReactNode {
  const list = useRef<HTMLDivElement>(null)
  const latest = useRef({ anchor, onClose })
  latest.current = { anchor, onClose }
  useLayoutEffect(() => {
    const menu = list.current
    if (menu === null) return
    menu.showPopover?.()
    const start = latest.current.anchor()?.getBoundingClientRect()
    if (start === undefined) { latest.current.onClose(false); return }
    // Placed once against the row, then moved with it: the offset from the row's corner is what stays.
    const { width, height } = menu.getBoundingClientRect()
    const point = place === 'beside' ? { x: start.left + 24, y: start.bottom - 2 } : place
    const left = point.x + width + 8 > innerWidth ? Math.max(8, point.x - width) : point.x
    const top = point.y + height + 8 > innerHeight ? Math.max(8, (place === 'beside' ? start.top + 2 : point.y) - height) : point.y
    const offset = { x: left - start.left, y: top - start.top }
    let frame = 0
    let placed = ''
    const follow = (): void => {
      const box = latest.current.anchor()?.getBoundingClientRect()
      if (box === undefined) { latest.current.onClose(false); return }
      frame = requestAnimationFrame(follow)
      const now = `${box.left} ${box.top} ${innerWidth} ${innerHeight}`
      if (now === placed) return
      placed = now
      menu.style.left = `${Math.round(Math.max(8, Math.min(box.left + offset.x, innerWidth - width - 8)))}px`
      menu.style.top = `${Math.round(Math.max(8, Math.min(box.top + offset.y, innerHeight - height - 8)))}px`
    }
    follow()
    firstMenuItem(menu)?.focus()
    const outside = (event: Event): void => { if (!menu.contains(event.target as Node)) latest.current.onClose(false) }
    const away = (): void => latest.current.onClose(false)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    window.addEventListener('blur', away)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside, true)
      window.removeEventListener('blur', away)
      menu.hidePopover?.()
    }
  }, [place])
  const close = (restore: boolean): void => latest.current.onClose(restore)
  return <div ref={list} className="pane-menu__list thread-row-menu" role="menu" aria-label={label}
    popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined}
    onKeyDown={event => menuKeyDown(list.current, event, close)}
    // A menu key pressed inside the menu, or a right-click on it, opens nothing more, here or from main.
    onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}>
    <PaneMenuRows groups={groups.filter(group => group.length > 0)} onChoose={item => { close(true); item.run() }} />
  </div>
}
