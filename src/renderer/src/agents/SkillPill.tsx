import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { WandSparkles } from 'lucide-react'
import './skillPill.css'

export interface SkillPillProps {
  /** The skill's own name, shown without its sigil. */
  readonly name: string
  /** The exact token Sotto sends for it, such as `/zach-mode` or `$zach-mode`. */
  readonly token: string
  /** What the skill does, from the thread's catalog; absent when the catalog does not have it. */
  readonly description?: string | undefined
  /** Personal, Project, System or Admin, from the catalog. */
  readonly scope?: string | undefined
}

/** How long the pointer rests on a pill before its card shows. */
const HOVER_DELAY_MS = 350
/** The gap between the pill and its card, and the least room the card keeps from the window edge. */
const GAP = 6
const EDGE = 8

/**
 * A chosen skill inside the composer's text: one piece that Backspace removes whole, led by a wand instead of
 * its sigil. Pointing at it, or selecting it in the editor, shows a card saying what the skill does. The editor
 * owns where it sits; this owns how it looks.
 */
export function SkillPill({ name, token, description, scope }: SkillPillProps): ReactNode {
  const [pill, setPill] = useState<HTMLSpanElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [selected, setSelected] = useState(false)
  // Escape, a scroll or the window losing focus puts the card away until the pointer comes back or the
  // pill is selected again.
  const [dismissed, setDismissed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const open = (hovered || selected) && !dismissed

  const clearTimer = (): void => { window.clearTimeout(timer.current); timer.current = undefined }
  useEffect(() => clearTimer, [])

  const enter = (): void => {
    clearTimer()
    setDismissed(false)
    timer.current = window.setTimeout(() => { timer.current = undefined; setHovered(true) }, HOVER_DELAY_MS)
  }
  const leave = (): void => { clearTimer(); setHovered(false) }

  // A node view sits in a wrapper the editor marks `ProseMirror-selectednode` when it selects the pill; the card
  // shows for that too, so the keyboard reaches what the pointer does. It shows only while the text has focus.
  const wasSelected = useRef(false)
  useEffect(() => {
    const element = pill
    if (!element) return
    const editor = element.closest<HTMLElement>('[contenteditable="true"]')
    const host = element.closest('[data-node-view-wrapper]')?.parentElement ?? element.parentElement
    if (!editor || !host) return
    const read = (): void => {
      const next = element.closest('.ProseMirror-selectednode') !== null && editor.contains(document.activeElement)
      if (next && !wasSelected.current) setDismissed(false)
      wasSelected.current = next
      setSelected(next)
    }
    const observer = new MutationObserver(read)
    observer.observe(host, { attributes: true, attributeFilter: ['class'] })
    if (host.parentElement) observer.observe(host.parentElement, { attributes: true, attributeFilter: ['class'] })
    editor.addEventListener('focusin', read)
    editor.addEventListener('focusout', read)
    read()
    return () => {
      observer.disconnect()
      editor.removeEventListener('focusin', read)
      editor.removeEventListener('focusout', read)
    }
  }, [pill])

  const dismiss = useCallback((): void => { clearTimer(); setHovered(false); setDismissed(true) }, [])

  useEffect(() => {
    if (!open) return
    // Escape answers the card first, and only while it shows: the editor keeps every other Escape.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [open, dismiss])

  const summary = description?.trim() || undefined
  return <span ref={setPill} className="composer-skill" data-skill={name} role="img" aria-label={`Skill ${name}`} aria-description={summary}
    onPointerEnter={enter} onPointerLeave={leave}>
    <WandSparkles className="composer-skill__icon" strokeWidth={2} aria-hidden="true" />
    <span className="composer-skill__name">{name}</span>
    {open && pill ? <SkillCard anchor={pill} name={name} token={token} description={summary} scope={scope} /> : null}
  </span>
}

/**
 * What the skill does, shown above its pill. It lives outside the editable text, in the window's top layer so
 * it also clears the queued message editor's dialog, and takes no pointer or focus.
 */
function SkillCard({ anchor, name, token, description, scope }: SkillPillProps & { readonly anchor: HTMLElement }): ReactNode {
  const card = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    if (typeof element.showPopover === 'function' && !element.matches(':popover-open')) element.showPopover()
    const pillBox = anchor.getBoundingClientRect()
    const room = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
    const roomAbove = pillBox.top - GAP - EDGE
    const roomBelow = room.height - EDGE - pillBox.bottom - GAP
    let { height } = element.getBoundingClientRect()
    // Above when it fits, below when only that fits, and otherwise on the roomier side with the description cut
    // to the lines that fit there. The name and the "sent as" line always show; the pill's accessible
    // description keeps the whole text.
    const placeBelow = height > roomAbove && (height <= roomBelow || roomBelow > roomAbove)
    const available = Math.max(0, placeBelow ? roomBelow : roomAbove)
    element.style.maxHeight = `${Math.floor(available)}px`
    const summary = element.querySelector<HTMLElement>('.skill-card__description')
    if (summary && height > available) {
      const lineHeight = parseFloat(getComputedStyle(summary).lineHeight) || 19
      const lines = Math.floor((available - (height - summary.getBoundingClientRect().height)) / lineHeight)
      if (lines >= 1) summary.style.setProperty('-webkit-line-clamp', String(lines))
      else summary.hidden = true
      height = element.getBoundingClientRect().height
    }
    const { width } = element.getBoundingClientRect()
    const top = placeBelow ? pillBox.bottom + GAP : Math.max(EDGE, pillBox.top - GAP - height)
    const left = Math.min(Math.max(EDGE, pillBox.left), Math.max(EDGE, room.width - EDGE - width))
    element.style.top = `${Math.round(top)}px`
    element.style.left = `${Math.round(left)}px`
    element.dataset.side = placeBelow ? 'below' : 'above'
  }, [anchor])

  const kind = scope ? `${scope} skill` : 'Skill'
  return createPortal(<div ref={card} className="skill-card" popover="manual" contentEditable={false} aria-hidden="true">
    <p className="skill-card__name">{name}</p>
    {description ? <p className="skill-card__description">{description}</p> : null}
    <p className="skill-card__meta">{kind}, sent as <code>{token}</code></p>
  </div>, document.body)
}
