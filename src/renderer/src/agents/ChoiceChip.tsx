import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { moveListboxFocus } from './listboxKeys'
import './threadChips.css'

export interface ChoiceOption {
  readonly id: string; readonly label: string; readonly description?: string; readonly disabled?: boolean
  /** The description is a message of Sotto's in the interface language, which runs right to left where that language does. */
  readonly translated?: boolean
  /** A line shown only on pointing at the option, where the list itself stays short. */
  readonly tooltip?: string | undefined
}

/**
 * A chip that opens a short list above itself for permissions. The chip reads the
 * current choice, or the setting's own name while the provider has not said. Arrow keys move through the
 * list; Escape, Tab or a pointer outside closes it, and Escape returns focus to the chip. A `pending` choice is
 * one the provider has not confirmed: the chip shows it with a dashed outline and a small dot, and is described by
 * the line that says what is still in force (`describedBy`), so the words are the ones on screen, said once. A `foot`
 * is a line under the list that holds in every choice; it sits outside the listbox, so it is read, never chosen.
 */
export function ChoiceChip({ label, placeholder, value, options, disabled, pending, describedBy, onChange, foot, fixedReason, flip = false, icon }: {
  readonly label: string; readonly placeholder: string; readonly value: string; readonly options: readonly ChoiceOption[]
  readonly disabled: boolean; readonly pending: boolean; readonly describedBy?: string | undefined; readonly onChange: (id: string) => void
  readonly foot?: string | undefined
  /** Why the chip cannot be pressed now, on its tooltip while it is disabled. */
  readonly fixedReason?: string | undefined
  /**
   * Opens below the chip when there is no room above it inside the area that scrolls it, as on a Settings page where the
   * chip can sit near the top. The composer's chips never need it: they sit at the bottom of their pane.
   */
  readonly flip?: boolean
  /**
   * A glyph that stands for the value where the composer is narrow (permissions' shield). The value's words stay in the
   * chip for assistive technology, hidden only from the eye, so the chip still says what it is set to.
   */
  readonly icon?: ReactNode
}): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [below, setBelow] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const listId = useId()
  useLayoutEffect(() => {
    if (!open || !flip) { setBelow(false); return }
    const menu = panel.current ?? list.current, chip = trigger.current
    if (!menu || !chip) return
    let top = 0
    for (let parent = chip.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/u.test(getComputedStyle(parent).overflowY)) { top = parent.getBoundingClientRect().top; break }
    }
    setBelow(chip.getBoundingClientRect().top - menu.offsetHeight - 6 < top + 8)
  }, [open, flip])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!list.current?.contains(target) && !panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    const selected = list.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]:not(:disabled)')
    ;(selected ?? list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
    return () => { document.removeEventListener('pointerdown', dismiss, true) }
  }, [open])
  const current = options.find(option => option.id === value && !option.disabled)
  const shown = current?.label ?? (value ? value.charAt(0).toUpperCase() + value.slice(1) : placeholder)
  // A chip that can show its glyph alone says its value in its tooltip too, so the shield can be read by pointing at it.
  const named = icon ? t({ message: `${label}: ${shown}`, comment: 'A chip\'s tooltip: the setting\'s name, then its value.' }) : label
  const title = disabled && fixedReason ? t({ message: `${named}. ${fixedReason}`, comment: 'A fixed chip\'s tooltip: its name, then why it cannot be pressed now.' }) : named
  const choose = (id: string): void => { onChange(id); setOpen(false); trigger.current?.focus() }
  const listbox = <div ref={list} id={listId} role="listbox" aria-label={label} className={foot ? 'thread-chip-menu__options' : 'thread-chip-menu__list'} data-below={!foot && below ? 'true' : undefined} onKeyDown={event => moveListboxFocus(event, list.current)}>
    {options.map(option => <button type="button" role="option" key={option.id} aria-selected={option.id === value} disabled={option.disabled} title={option.tooltip} onClick={() => choose(option.id)}>
      <span>{option.label}{option.description ? <small className={option.translated ? 'tt-paragraph' : undefined}>{option.description}</small> : null}</span>{option.id === value && <Check size={14} aria-hidden="true" />}</button>)}
  </div>
  return <div className="thread-chip-menu"
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
    <button ref={trigger} type="button" className="thread-chip tt-focusable" role="combobox" aria-label={label} title={title} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-describedby={pending ? describedBy : undefined} data-pending={pending ? 'true' : undefined} data-permission={icon ? value : undefined}
      disabled={disabled} onClick={() => setOpen(value => !value)}>
      {pending ? <i className="thread-chip__pending" aria-hidden="true" /> : null}
      {icon ? <span className="thread-chip__icon" aria-hidden="true">{icon}</span> : null}
      <span className="thread-chip__value">{shown}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {!open ? null : foot ? <div ref={panel} className="thread-chip-menu__list thread-chip-menu__list--foot" data-below={below ? 'true' : undefined}>{listbox}<p className="thread-chip-menu__foot">{foot}</p></div> : listbox}
  </div>
}
