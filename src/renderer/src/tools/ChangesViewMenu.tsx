import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { firstMenuItem, menuKeyDown } from '../agents/PaneMenu'
import type { ChangesView } from './changesStore'

interface ViewRow {
  readonly id: string
  readonly label: string
  /** A layout is one of two; everything else is on or off. */
  readonly kind: 'menuitemradio' | 'menuitemcheckbox'
  readonly checked: boolean
  readonly disabled?: boolean
  readonly change: Partial<ChangesView>
}

/**
 * How a comparison is drawn, as one named menu rather than a row of small toggles: the layout, wrapping, whitespace, one
 * file at a time and the file tree. A press changes the view behind it and leaves the menu open, so the reader can see
 * what it did and press another. The keys are every menu's (`menuKeyDown`).
 */
export function ChangesViewMenu({ view, hasFiles, onView }: {
  readonly view: ChangesView
  /** Without files there is nothing to go through one at a time or to list. */
  readonly hasFiles: boolean
  readonly onView: (change: Partial<ChangesView>) => void
}): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
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
  const close = (restore: boolean): void => {
    setOpen(false)
    if (restore) button.current?.focus()
  }
  const groups: readonly (readonly ViewRow[])[] = [
    [
      { id: 'stacked', label: t`Stacked diff view`, kind: 'menuitemradio', checked: view.layout === 'stacked', change: { layout: 'stacked' } },
      { id: 'split', label: t`Split diff view`, kind: 'menuitemradio', checked: view.layout === 'split', change: { layout: 'split' } },
    ],
    [
      { id: 'wrap', label: t`Wrap long lines`, kind: 'menuitemcheckbox', checked: view.wrap, change: { wrap: !view.wrap } },
      { id: 'whitespace', label: t`Hide whitespace changes`, kind: 'menuitemcheckbox', checked: view.ignoreWhitespace, change: { ignoreWhitespace: !view.ignoreWhitespace } },
    ],
    [
      { id: 'one-file', label: t`One file at a time`, kind: 'menuitemcheckbox', checked: view.oneFile, disabled: !hasFiles, change: { oneFile: !view.oneFile } },
      { id: 'tree', label: t`File tree`, kind: 'menuitemcheckbox', checked: view.fileTree, disabled: !hasFiles, change: { fileTree: !view.fileTree } },
    ],
  ]
  const label = t`View options`
  return <div className="pane-menu changes-view">
    <button ref={button} type="button" className="changes-bar__word tt-focusable" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)}>
      {t({ message: 'View', comment: 'Opens the choices of how Changes draws a comparison.' })}<ChevronDown size={13} aria-hidden="true" />
    </button>
    {open ? <div ref={list} className="pane-menu__list" role="menu" aria-label={label} onKeyDown={event => menuKeyDown(list.current, event, close)}>
      {groups.map((group, index) => <React.Fragment key={group[0]!.id}>
        {index > 0 ? <hr /> : null}
        {group.map(row => <button key={row.id} type="button" role={row.kind} aria-checked={row.checked} className="pane-menu__item" tabIndex={-1} disabled={row.disabled} onClick={() => onView(row.change)}>
          <span className="pane-menu__label">{row.label}</span>
          <span className="pane-menu__end" aria-hidden="true">{row.checked ? <Check size={14} /> : null}</span>
        </button>)}
      </React.Fragment>)}
    </div> : null}
  </div>
}
