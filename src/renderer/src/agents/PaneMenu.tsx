import React, { useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'

/**
 * One row of a pane's More menu. An item the thread cannot take right now is listed and disabled rather
 * than removed, so the menu keeps its shape while a turn runs.
 */
export interface PaneMenuItem {
  readonly id: string
  readonly label: string
  /** What the row shows when it is more than its label's text, such as a branch name kept left to right. */
  readonly content?: ReactNode
  readonly icon?: ReactNode
  readonly disabled?: boolean
  /** Why the row is disabled, shown as its tooltip and read with its name. */
  readonly hint?: string
  /** A press that cannot be taken back from here, such as closing a pull request, reads in the error colour. */
  readonly tone?: 'danger'
  /** Set on one of a group of choices, such as a size: the row is a radio item, checked when true. */
  readonly checked?: boolean
  /** Set on a row that shows or hides something, such as Tools: the row is a checkbox item, ticked while it shows. */
  readonly shown?: boolean
  /** Keys that do the same from where the menu is, at the row's end in a title's words and read as its shortcut. */
  readonly shortcut?: { readonly plain: string; readonly keys: string } | undefined
  /** Read after the row's name: a state it carries, such as agents working in Tools. */
  readonly description?: string | undefined
  readonly run: () => void
}

const ITEM = ':is([role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]):not(:disabled)'
const role = (item: PaneMenuItem): string => item.shown !== undefined ? 'menuitemcheckbox' : item.checked !== undefined ? 'menuitemradio' : 'menuitem'

/**
 * A menu's keys, shared by the pane's ··· menu and a sidebar row's menu: Up and Down move round its rows, Home and End go
 * to its ends, and Escape or Tab closes it and hands focus back to what opened it. Enter and Space press the row.
 */
export function menuKeyDown(list: HTMLElement | null, event: React.KeyboardEvent, close: (restore: boolean) => void): void {
  if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return }
  const entries = [...(list?.querySelectorAll<HTMLElement>(ITEM) ?? [])]
  const index = entries.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1
    : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : null
  if (next === null) return
  event.preventDefault()
  event.stopPropagation()
  entries[(next + entries.length) % entries.length]?.focus()
}

/** A menu's first row that takes a press, which opening the menu focuses. */
export const firstMenuItem = (list: HTMLElement | null): HTMLElement | null => list?.querySelector<HTMLElement>(ITEM) ?? null

/** The rows of a menu in their groups, a hairline between groups, each with its keys at its end. */
export function PaneMenuRows({ groups, onChoose }: { readonly groups: readonly (readonly PaneMenuItem[])[]; readonly onChoose: (item: PaneMenuItem) => void }): ReactNode {
  return groups.map((group, index) => <React.Fragment key={group[0]!.id}>
    {index > 0 ? <hr /> : null}
    {group.map(item => <button key={item.id} type="button" role={role(item)} aria-checked={item.shown ?? item.checked} className="pane-menu__item" data-tone={item.tone} tabIndex={-1} disabled={item.disabled} title={item.hint}
      aria-keyshortcuts={item.shortcut?.keys} aria-description={item.description}
      onClick={() => onChoose(item)}>{item.icon}{item.shortcut || item.shown !== undefined
        // A row with keys or a tick keeps its name in its own span, so the tick and the keys line up at the end.
        ? <><span className="pane-menu__label">{item.content ?? item.label}</span><span className="pane-menu__end" aria-hidden="true">
          {item.shown ? <Check size={14} /> : null}{item.shortcut ? <kbd>{item.shortcut.plain}</kbd> : null}</span></>
        : item.content ?? item.label}{item.hint ? <span className="tt-visually-hidden">. {item.hint}</span> : null}</button>)}
  </React.Fragment>)
}

/**
 * The pane header's "…" menu: everything that acts on this thread but does not earn a button of
 * its own. Groups are separated by a hairline, and an empty group draws nothing, so a menu missing an item
 * never shows two rules in a row.
 *
 * It renders inside the header instead of a portal, so the header still contains the focus it hands out and
 * the pane's own focus bookkeeping keeps working. Escape or Tab closes it and returns focus to the button,
 * as a pointer outside it does.
 */
export function PaneMenu({ groups, label: givenLabel, icon, text, className, buttonClassName, mark, description, opens, buttonRef }: {
  readonly groups: readonly (readonly PaneMenuItem[])[]
  readonly label?: string
  /** The button's glyph; the ellipsis unless a control says otherwise. */
  readonly icon?: ReactNode
  /** Words shown beside the glyph, for a menu that opens from a named thing rather than an icon button. */
  readonly text?: ReactNode
  readonly className?: string
  /** The icon button's own class where the menu sits on another surface's line, such as Tools' `files-icon`. */
  readonly buttonClassName?: string
  /** Drawn on the button while the menu is closed: what one of its rows has to say, such as Tools' dot. */
  readonly mark?: ReactNode
  /** Read after the button's name: what the mark says, in words. */
  readonly description?: string | undefined
  /** What the rows open, for a surface that hands focus back to the button it was opened from (`tools`). */
  readonly opens?: string | undefined
  /** The button, for a surface that hands focus back to it after the layout re-mounted it. */
  readonly buttonRef?: React.Ref<HTMLButtonElement> | undefined
}): ReactNode {
  const { t } = useLingui()
  const label = givenLabel ?? t`More actions`
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // Null only while the menu has no rows and draws no button.
  useImperativeHandle(buttonRef, () => button.current as HTMLButtonElement, [])
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    firstMenuItem(list.current)?.focus()
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
  return <div className={className ? `pane-menu ${className}` : 'pane-menu'}>
    <button ref={button} type="button" className={text === undefined ? `${buttonClassName ?? 'pane-action'} tt-focusable` : 'pane-menu__trigger tt-focusable'} aria-label={label} title={label}
      aria-description={description} data-opens={opens}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}
      // A menu whose every row is disabled leaves focus on the button; Escape still puts it away.
      onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) } }}>
      {icon ?? <MoreHorizontal size={16} aria-hidden="true" />}{text}{mark}
    </button>
    {open ? <div ref={list} className="pane-menu__list" role="menu" aria-label={label}
      onKeyDown={event => menuKeyDown(list.current, event, close)}>
      <PaneMenuRows groups={shown} onChoose={item => { close(true); item.run() }} />
    </div> : null}
  </div>
}
