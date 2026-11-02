import React, { useLayoutEffect, useRef, type ReactNode } from 'react'
import { firstMenuItem, menuKeyDown, PaneMenuRows, type PaneMenuItem } from './PaneMenu'

/** Where a row menu opens: at the pointer's point for a right-click, or beside the row for Shift+F10 and the menu key. */
export type RowMenuPlace = { readonly x: number; readonly y: number } | 'beside'

/**
 * Which side of its row the keys open a menu on: under a sidebar row, or at the end of a collapsed rail's tile, which is
 * too narrow to stand under (ADR-0164).
 */
export type RowMenuSide = 'below' | 'end'

/** Where a keyboard-invoked context menu event says it was opened: Chromium reports no pointer position for one. */
export const rowMenuPlace = (event: Pick<MouseEvent, 'clientX' | 'clientY'>): RowMenuPlace =>
  event.clientX === 0 && event.clientY === 0 ? 'beside' : { x: event.clientX, y: event.clientY }

/** Shift+F10 or the menu key, the keys that open a row's menu (ADR-0164); Shift+F10 stands down for dictation's own keys. */
export function rowMenuPressed(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>, shiftF10: boolean): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false
  return event.key === 'ContextMenu' || (shiftF10 && event.key === 'F10' && event.shiftKey)
}

/**
 * Places a popover shown in the top layer against the row it belongs to, and keeps it there as the row moves: placed once, then
 * moved with the row each frame, so the offset from the row's corner is what stays, and kept inside the window. Where
 * it would run off the window it turns back: before the pointer, above the row, or before the tile and up from its foot.
 * `gone` is called once the row is. Returns what stops the following, or null when the row is already gone.
 */
export function followRow(popover: HTMLElement, anchor: () => HTMLElement | null, place: RowMenuPlace, side: RowMenuSide, gone: () => void): (() => void) | null {
  const start = anchor()?.getBoundingClientRect()
  if (start === undefined) return null
  const { width, height } = popover.getBoundingClientRect()
  const keys = place === 'beside'
  const point = !keys ? place : side === 'end' ? { x: start.right + 8, y: start.top } : { x: start.left + 24, y: start.bottom - 2 }
  const left = point.x + width + 8 > innerWidth ? Math.max(8, (keys && side === 'end' ? start.left - 8 : point.x) - width) : point.x
  const top = point.y + height + 8 > innerHeight ? Math.max(8, (!keys ? point.y : side === 'end' ? start.bottom : start.top + 2) - height) : point.y
  const offset = { x: left - start.left, y: top - start.top }
  let frame = 0
  let placed = ''
  const follow = (): void => {
    const box = anchor()?.getBoundingClientRect()
    if (box === undefined) { gone(); return }
    frame = requestAnimationFrame(follow)
    const now = `${box.left} ${box.top} ${innerWidth} ${innerHeight}`
    if (now === placed) return
    placed = now
    popover.style.left = `${Math.round(Math.max(8, Math.min(box.left + offset.x, innerWidth - width - 8)))}px`
    popover.style.top = `${Math.round(Math.max(8, Math.min(box.top + offset.y, innerHeight - height - 8)))}px`
  }
  follow()
  return () => cancelAnimationFrame(frame)
}

/**
 * A sidebar row's menu (ADR-0164, Zach's pick A of #1827): the row's actions in words, with the keys that do the same
 * from the row, in the pane menu's look and with its keys. It opens on a right-click, Shift+F10 or the menu key, takes
 * the focus to its first row, and Escape, Tab, a press outside or the window losing the focus closes it; Escape and Tab
 * hand the focus back to the row. It is drawn inside its row, so the row and its folder still contain the focus they
 * hand out, and shown in the top layer, so the sidebar's scrolling edge never cuts it. It follows its row as the sidebar
 * scrolls and closes when the row goes. A collapsed rail's tile opens the same menu, drawn beside the tile in the rail.
 */
export function RowMenu({ label, groups, anchor, place, side = 'below', onClose }: {
  readonly label: string
  readonly groups: readonly (readonly PaneMenuItem[])[]
  /** The row the menu belongs to, found afresh each frame. */
  readonly anchor: () => HTMLElement | null
  readonly place: RowMenuPlace
  /** Where the keys open it: under the row, or at a rail tile's end. */
  readonly side?: RowMenuSide | undefined
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
    const stop = followRow(menu, () => latest.current.anchor(), place, side, () => latest.current.onClose(false))
    if (stop === null) { latest.current.onClose(false); return }
    firstMenuItem(menu)?.focus()
    const outside = (event: Event): void => { if (!menu.contains(event.target as Node)) latest.current.onClose(false) }
    const away = (): void => latest.current.onClose(false)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside, true)
    window.addEventListener('blur', away)
    return () => {
      stop()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside, true)
      window.removeEventListener('blur', away)
      menu.hidePopover?.()
    }
  }, [place, side])
  const close = (restore: boolean): void => latest.current.onClose(restore)
  return <div ref={list} className="pane-menu__list thread-row-menu" role="menu" aria-label={label}
    popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined}
    onKeyDown={event => menuKeyDown(list.current, event, close)}
    // A menu key pressed inside the menu, or a right-click on it, opens nothing more, here or from main.
    onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}>
    <PaneMenuRows groups={groups.filter(group => group.length > 0)} onChoose={item => { close(true); item.run() }} />
  </div>
}
